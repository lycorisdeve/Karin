import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'

import type {
  AgentConfig,
  AgentSandboxBackend,
  AgentSandboxExecution,
  AgentSandboxRequest,
} from '@/types/agent'

export interface AgentSandboxLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  execution: AgentSandboxExecution
  cleanup?: () => Promise<void>
}

export interface AgentSandboxProcess {
  child: ChildProcess
  launch: AgentSandboxLaunch
}

export interface AgentSandboxStatus extends AgentSandboxExecution {
  platform: NodeJS.Platform
  detectedBackends: AgentSandboxBackend[]
  configuredBackend: AgentConfig['execution']['sandbox']['backend']
  lastDoctor?: {
    checkedAt: number
    passed: boolean
    checks: Record<string, boolean>
    reason?: string
  }
}

interface CompiledPolicy {
  cwd: string
  readRoots: string[]
  writeRoots: string[]
  network: 'deny' | 'inherit'
}

const require = createRequire(import.meta.url)
const trustedWindowsHelperHashes = new Set<string>()
const pathEquals = (left: string, right: string) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
const uniqueRoots = (roots: string[]) => roots.filter(
  (root, index) => roots.findIndex(item => pathEquals(item, root)) === index
)
const rejectNul = (value: string, label: string) => {
  if (value.includes('\0')) throw new Error(`${label} 包含 NUL 字符`)
}

const realpath = async (value: string, label: string) => {
  rejectNul(value, label)
  try {
    return await fs.promises.realpath(path.resolve(value))
  } catch (error) {
    throw new Error(`${label} 不存在或无法解析: ${value}`, { cause: error })
  }
}

const executableOnPath = (command: string) => {
  rejectNul(command, '进程命令')
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : null
  if (!/^[a-zA-Z0-9._-]+$/.test(command)) return null
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension.toLowerCase())
      if (fs.existsSync(candidate)) return candidate
      const upper = path.join(directory, command + extension.toUpperCase())
      if (fs.existsSync(upper)) return upper
    }
  }
  return null
}

const windowsHelper = () => {
  if (process.platform !== 'win32') return null
  const packageName = process.arch === 'arm64'
    ? '@karinjs/sandbox-win32-arm64'
    : '@karinjs/sandbox-win32-x64'
  try {
    const packageJson = require.resolve(`${packageName}/package.json`)
    const executable = path.join(path.dirname(packageJson), 'bin', 'karin-sandbox.exe')
    const checksumFile = `${executable}.sha256`
    if (!fs.existsSync(executable) || !fs.existsSync(checksumFile)) return null
    const expected = fs.readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0]?.toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(expected)) return null
    const actual = createHash('sha256').update(fs.readFileSync(executable)).digest('hex')
    if (actual !== expected) return null
    if (!trustedWindowsHelperHashes.has(actual)) {
      const signature = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]; if ($signature.Status -eq 'Valid') { exit 0 } else { exit 1 }",
          executable,
        ],
        { windowsHide: true, stdio: 'ignore', timeout: 10_000 }
      )
      if (signature.status !== 0) return null
      trustedWindowsHelperHashes.add(actual)
    }
    return executable
  } catch {
    return null
  }
}

const detect = (): AgentSandboxBackend[] => {
  const result: AgentSandboxBackend[] = []
  if (process.platform === 'linux' && executableOnPath('bwrap')) result.push('bwrap')
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
    result.push('seatbelt')
  }
  if (windowsHelper()) result.push('windows')
  return result
}

export class SandboxPolicyCompiler {
  constructor (private readonly getConfig: () => AgentConfig) {}

  async compile (cwdInput: string, request: AgentSandboxRequest = {}): Promise<CompiledPolicy> {
    const cwd = await realpath(cwdInput, 'cwd')
    const config = this.getConfig().execution.sandbox
    const allowedRead = uniqueRoots(await Promise.all(
      (config.readRoots.length ? config.readRoots : [cwd]).map(root => realpath(root, '全局读根目录'))
    ))
    const allowedWrite = uniqueRoots(await Promise.all(
      (config.writeRoots.length ? config.writeRoots : [cwd])
        .map(root => realpath(root, '全局写根目录'))
    ))
    if (!allowedRead.some(root => inside(root, cwd)) || !allowedWrite.some(root => inside(root, cwd))) {
      throw new Error(`Sandbox cwd 越界: ${cwd}`)
    }
    const requested = async (items: string[] | undefined, allowed: string[], label: string) => {
      if (!items?.length) return allowed
      const resolved = uniqueRoots(await Promise.all(items.map(root => realpath(root, label))))
      for (const root of resolved) {
        if (!allowed.some(parent => inside(parent, root))) {
          throw new Error(`${label} 超出管理员允许范围: ${root}`)
        }
      }
      return resolved
    }
    const readRoots = await requested(request.readRoots, allowedRead, 'Tool 读根目录')
    const writeRoots = await requested(request.writeRoots, allowedWrite, 'Tool 写根目录')
    for (const root of writeRoots) {
      if (!readRoots.some(read => inside(read, root)) && !allowedRead.some(read => inside(read, root))) {
        throw new Error(`Tool 写根目录不在可读范围: ${root}`)
      }
    }
    return {
      cwd,
      readRoots: uniqueRoots([...readRoots, ...writeRoots]),
      writeRoots,
      network: request.network === 'inherit' ? 'inherit' : config.networkDefault,
    }
  }
}

const seatbeltQuote = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

export class AgentSandboxRunner {
  private readonly compiler: SandboxPolicyCompiler
  private lastDoctor: AgentSandboxStatus['lastDoctor']
  private doctorRunning = false

  constructor (private readonly getConfig: () => AgentConfig) {
    this.compiler = new SandboxPolicyCompiler(getConfig)
  }

  status (): AgentSandboxStatus {
    const config = this.getConfig().execution.sandbox
    const detectedBackends = detect()
    const selected = config.backend === 'auto'
      ? detectedBackends[0] || 'none'
      : detectedBackends.includes(config.backend) ? config.backend : 'none'
    const off = config.mode === 'off'
    return {
      platform: process.platform,
      configuredBackend: config.backend,
      detectedBackends,
      backend: off ? 'none' : selected,
      mode: off
        ? 'off'
        : selected === 'none' || this.lastDoctor?.passed !== true
          ? 'fallback'
          : 'hard',
      network: config.networkDefault,
      hardIsolation: !off && selected !== 'none' && this.lastDoctor?.passed === true,
      reason: off
        ? 'Sandbox 已由管理员关闭'
        : selected === 'none'
          ? `${os.platform()} 未检测到配置的硬隔离后端，使用进程级兼容模式`
          : this.lastDoctor?.passed !== true
            ? this.lastDoctor?.reason || '硬隔离后端尚未通过 doctor 自检'
            : undefined,
      lastDoctor: this.lastDoctor,
    }
  }

  async prepare (input: {
    command: string
    args?: string[]
    cwd?: string
    env?: NodeJS.ProcessEnv
    sandbox?: AgentSandboxRequest
  }): Promise<AgentSandboxLaunch> {
    const command = executableOnPath(input.command)
    if (!command) throw new Error(`Sandbox 无法解析进程命令: ${input.command}`)
    const args = (input.args || []).map(String)
    args.forEach(arg => rejectNul(arg, '进程参数'))
    const policy = await this.compiler.compile(input.cwd || process.cwd(), input.sandbox)
    const status = this.status()
    const environment = (input.env || {}) as NodeJS.ProcessEnv
    if (
      status.mode === 'off' ||
      status.backend === 'none' ||
      (!status.hardIsolation && !this.doctorRunning)
    ) {
      if (this.getConfig().execution.minimumIsolation === 'os') {
        throw new Error(
          `操作系统级隔离要求失败: ${status.reason || '没有可用的硬隔离后端'}`
        )
      }
      if (status.backend === 'windows' && status.mode !== 'off') {
        return this.windows(command, args, policy, environment, false)
      }
      return {
        command,
        args,
        cwd: policy.cwd,
        env: environment,
        execution: {
          backend: 'none',
          mode: status.mode,
          network: 'inherit',
          hardIsolation: false,
          reason: [
            status.reason,
            policy.network === 'deny' ? '兼容模式未执行网络隔离' : '',
          ].filter(Boolean).join('；'),
        },
      }
    }
    if (status.backend === 'bwrap') return this.bwrap(command, args, policy, environment)
    if (status.backend === 'seatbelt') {
      return this.seatbelt(command, args, policy, environment)
    }
    return this.windows(command, args, policy, environment, true)
  }

  async spawn (
    input: Parameters<AgentSandboxRunner['prepare']>[0],
    options: Omit<SpawnOptions, 'cwd' | 'env' | 'shell' | 'windowsHide'> = {}
  ): Promise<AgentSandboxProcess> {
    const launch = await this.prepare(input)
    try {
      const child = nodeSpawn(launch.command, launch.args, {
        ...options,
        cwd: launch.cwd,
        env: launch.env,
        shell: false,
        windowsHide: true,
      })
      return { child, launch }
    } catch (error) {
      await launch.cleanup?.()
      throw error
    }
  }

  async terminate (child: ChildProcess) {
    if (!child.pid) return child.kill('SIGKILL')
    if (process.platform === 'win32') {
      return new Promise<boolean>(resolve => {
        const killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('error', () => resolve(child.kill('SIGKILL')))
        killer.once('close', code => resolve(code === 0 || child.kill('SIGKILL')))
      })
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
      return true
    } catch {
      return child.kill('SIGKILL')
    }
  }

  private bwrap (
    command: string,
    args: string[],
    policy: CompiledPolicy,
    env: NodeJS.ProcessEnv
  ): AgentSandboxLaunch {
    const bwrap = executableOnPath('bwrap')!
    const launchArgs = [
      '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-uts', '--unshare-ipc',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ]
    if (policy.network === 'deny') launchArgs.push('--unshare-net')
    const systemRoots = ['/usr', '/bin', '/lib', '/lib64', '/etc', '/opt', '/nix/store']
      .filter(root => fs.existsSync(root))
    for (const root of uniqueRoots([...systemRoots, ...policy.readRoots])) {
      launchArgs.push('--ro-bind', root, root)
    }
    for (const root of policy.writeRoots) launchArgs.push('--bind', root, root)
    launchArgs.push('--chdir', policy.cwd, '--', command, ...args)
    return {
      command: bwrap,
      args: launchArgs,
      cwd: policy.cwd,
      env,
      execution: {
        backend: 'bwrap', mode: 'hard', network: policy.network, hardIsolation: true,
      },
    }
  }

  private async seatbelt (
    command: string,
    args: string[],
    policy: CompiledPolicy,
    env: NodeJS.ProcessEnv
  ): Promise<AgentSandboxLaunch> {
    const commandPath = fs.realpathSync(command)
    const commandRoot = path.dirname(path.dirname(commandPath))
    const profile = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow process-info* (target same-sandbox))',
      '(allow signal (target same-sandbox))',
      '(allow mach-priv-task-port (target same-sandbox))',
      '(allow user-preference-read)',
      '(allow mach-lookup',
      '  (global-name "com.apple.logd")',
      '  (global-name "com.apple.system.logger")',
      '  (global-name "com.apple.system.notification_center")',
      '  (global-name "com.apple.system.opendirectoryd.libinfo")',
      '  (global-name "com.apple.system.opendirectoryd.membership")',
      '  (global-name "com.apple.bsd.dirhelper")',
      '  (global-name "com.apple.securityd.xpc")',
      ')',
      '(allow ipc-posix-shm)',
      '(allow ipc-posix-sem)',
      '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
      '(allow iokit-open',
      '  (iokit-registry-entry-class "IOSurfaceRootUserClient")',
      '  (iokit-registry-entry-class "RootDomainUserClient")',
      '  (iokit-user-client-class "IOSurfaceSendRight")',
      ')',
      '(allow iokit-get-properties)',
      '(allow sysctl-read)',
      '(allow file-read-metadata)',
      '(allow file-read* (literal "/"))',
      '(allow file-ioctl',
      '  (literal "/dev/null")',
      '  (literal "/dev/zero")',
      '  (literal "/dev/random")',
      '  (literal "/dev/urandom")',
      ')',
      '(allow file-read-data file-write-data (literal "/dev/null"))',
      '(allow file-read-data file-write-data (literal "/dev/zero"))',
      '(allow file-read-data (literal "/dev/random"))',
      '(allow file-read-data (literal "/dev/urandom"))',
      ...[
        '/System', '/usr', '/bin', '/sbin', '/Library', '/opt', '/private/etc',
        '/private/var/db/timezone', commandRoot,
        ...policy.readRoots,
      ]
        .filter(root => fs.existsSync(root))
        .map(root => `(allow file-read* (subpath "${seatbeltQuote(root)}"))`),
      ...policy.writeRoots.map(root =>
        `(allow file-write* (subpath "${seatbeltQuote(root)}"))`
      ),
      '(allow file-write* (subpath "/private/tmp"))',
      ...(policy.network === 'inherit' ? ['(allow network*)'] : []),
    ].join('\n')
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'karin-seatbelt-'))
    const profilePath = path.join(directory, 'profile.sb')
    await fs.promises.writeFile(profilePath, profile, { encoding: 'utf8', mode: 0o600 })
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-f', profilePath, command, ...args],
      cwd: policy.cwd,
      env,
      execution: {
        backend: 'seatbelt', mode: 'hard', network: policy.network, hardIsolation: true,
      },
      cleanup: () => fs.promises.rm(directory, { recursive: true, force: true }),
    }
  }

  private windows (
    command: string,
    args: string[],
    policy: CompiledPolicy,
    env: NodeJS.ProcessEnv,
    verified: boolean
  ): AgentSandboxLaunch {
    const helper = windowsHelper()
    if (!helper) throw new Error('Windows Sandbox Helper 未安装')
    const encoded = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64url')
    return {
      command: helper,
      args: ['run', '--policy', encoded, '--', command, ...args],
      cwd: policy.cwd,
      env,
      execution: {
        backend: 'windows',
        mode: verified ? 'hard' : 'fallback',
        network: verified ? policy.network : 'inherit',
        hardIsolation: verified,
        reason: verified
          ? undefined
          : 'Windows Helper 仅提供进程树兼容隔离；网络与文件策略未通过 doctor',
      },
    }
  }

  async doctor () {
    const status = this.status()
    if (status.backend === 'none' || status.mode === 'off') {
      this.lastDoctor = {
        checkedAt: Date.now(), passed: false, checks: {}, reason: status.reason,
      }
      return this.status()
    }
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'karin-sandbox-doctor-'))
    const outside = path.join(path.dirname(directory), `karin-sandbox-outside-${process.pid}`)
    const networkMarker = path.join(directory, 'network-denied')
    const treeMarker = path.join(directory, 'process-tree-escaped')
    try {
      this.doctorRunning = true
      const launch = await this.prepare({
        command: process.execPath,
        args: ['-e', [
          'const fs=require(\'node:fs\')',
          `fs.writeFileSync(${JSON.stringify(path.join(directory, 'inside'))},'ok')`,
          `try{fs.writeFileSync(${JSON.stringify(outside)},'bad')}catch{}`,
          'fetch(\'http://1.1.1.1\',{signal:AbortSignal.timeout(1200)})' +
            '.then(()=>process.exit(8)).catch(()=>fs.writeFileSync(' +
            `${JSON.stringify(networkMarker)},'ok'))`,
        ].join(';')],
        cwd: directory,
      })
      let doctorStderr = ''
      let doctorSignal: NodeJS.Signals | null = null
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = nodeSpawn(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        child.stderr?.on('data', chunk => {
          doctorStderr = `${doctorStderr}${String(chunk)}`.slice(-4096)
        })
        child.once('error', reject)
        child.once('close', (code, signal) => {
          doctorSignal = signal
          resolve(code)
        })
      }).finally(() => launch.cleanup?.())
      const treeLaunch = await this.prepare({
        command: process.execPath,
        args: ['-e', [
          "const{spawn}=require('node:child_process')",
          `spawn(process.execPath,['-e',${JSON.stringify(
            `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(treeMarker)},'bad'),800)`
          )}],{stdio:'ignore'})`,
          "process.stdout.write('ready')",
          'setInterval(()=>{},1000)',
        ].join(';')],
        cwd: directory,
      })
      const tree = nodeSpawn(treeLaunch.command, treeLaunch.args, {
        cwd: treeLaunch.cwd,
        env: treeLaunch.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 300)
        tree.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
        tree.stdout?.once('data', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (tree.pid) {
        if (process.platform === 'win32') {
          await new Promise<void>(resolve => {
            nodeSpawn('taskkill', ['/pid', String(tree.pid), '/T', '/F'], {
              shell: false, windowsHide: true, stdio: 'ignore',
            }).once('close', () => resolve())
          })
        } else {
          try {
            process.kill(-tree.pid, 'SIGKILL')
          } catch {
            tree.kill('SIGKILL')
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
      await treeLaunch.cleanup?.()
      const checks = {
        allowedWrite: fs.existsSync(path.join(directory, 'inside')),
        outsideWriteDenied: !fs.existsSync(outside),
        networkDenied: fs.existsSync(networkMarker),
        processTreeTerminated: !fs.existsSync(treeMarker),
        processExit: exit === 0,
      }
      const passed = Object.values(checks).every(Boolean)
      this.lastDoctor = {
        checkedAt: Date.now(),
        passed,
        checks,
        reason: passed
          ? undefined
          : [
              `自检失败项: ${Object.entries(checks)
                .filter(([, value]) => !value)
                .map(([name]) => name)
                .join(', ')}`,
              exit === 0 ? '' : `进程退出码: ${String(exit)}`,
              doctorSignal ? `终止信号: ${doctorSignal}` : '',
              doctorStderr.trim() ? `stderr: ${doctorStderr.trim()}` : '',
          ].filter(Boolean).join('；'),
      }
    } catch (error) {
      this.lastDoctor = {
        checkedAt: Date.now(), passed: false, checks: {}, reason: (error as Error).message,
      }
    } finally {
      this.doctorRunning = false
      await fs.promises.rm(directory, { recursive: true, force: true })
      await fs.promises.rm(outside, { force: true })
    }
    return this.status()
  }
}

let runner: AgentSandboxRunner | null = null

export const configureAgentSandbox = (getConfig: () => AgentConfig) => {
  runner = new AgentSandboxRunner(getConfig)
  return runner
}

export const agentSandbox = () => {
  if (!runner) runner = new AgentSandboxRunner(standaloneConfig)
  return runner
}

export const agentSandboxStatus = () => runner?.status() || null

const standaloneConfig = (): AgentConfig => ({
  execution: {
    isolationMode: 'compat',
    minimumIsolation: 'none',
    hookTimeoutMs: 5000,
    maxModelCalls: 1,
    maxTurnDurationMs: 30_000,
    sandbox: {
      mode: 'auto',
      backend: 'auto',
      readRoots: [],
      writeRoots: [],
      networkDefault: 'deny',
    },
  },
  context: {
    defaultWindowTokens: 65536,
    softLimitRatio: 0.5,
    hardLimitRatio: 0.85,
    protectedRecentMessages: 12,
    summaryTargetTokens: 4096,
    semanticCompaction: true,
    reservedOutputTokens: 4096,
  },
} as unknown as AgentConfig)

export const doctorAgentSandbox = async () => {
  const standalone = new AgentSandboxRunner(standaloneConfig)
  return standalone.doctor()
}

export const setupAgentSandbox = async () => {
  if (process.platform !== 'win32') {
    return { changed: false, reason: 'Linux/macOS 使用系统沙箱后端，无需 setup' }
  }
  const helper = windowsHelper()
  if (!helper) {
    throw new Error('当前架构的 @karinjs/sandbox-win32-* Helper 未安装')
  }
  return {
    changed: false,
    helper,
    hardIsolationReady: false,
    reason: 'Helper 已通过哈希与 Authenticode 校验；当前仅提供 Restricted Token/Job Object 兼容隔离，不能建立 ACL 与出站阻断',
  }
}
