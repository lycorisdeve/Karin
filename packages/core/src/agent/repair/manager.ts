import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { karinPathData, karinPathPlugins } from '@/root'

import type {
  AgentActor,
  AgentRepairCandidatePayload,
} from '@/types/agent'
import type { AgentDatabase } from '../persistence/database'

const execFileAsync = promisify(execFile)
const maximumPatchBytes = 256 * 1024
const maximumProcessOutput = 1024 * 1024
const candidateDirectory = path.join(karinPathData, 'agent', 'repair-candidates')
const deniedPath = /(^|\/)(?:\.git|node_modules|dist|coverage|@karinjs|\.env(?:\.|$)|credentials?|secrets?)(?:\/|$)/i

export type AgentRepairVerification =
  | 'agent-tests'
  | 'core-build'
  | 'web-build'
  | 'root-build'

export interface AgentRepairProposal {
  target: 'karin' | 'plugin'
  pluginName?: string
  problem: string
  reproduction: string
  rootCause: string
  confidence: number
  patch: string
  semantics: AgentRepairCandidatePayload['semantics']
  stopCondition: string
  failureStrategy: string
  verification: AgentRepairVerification[]
  rollback: string
}

interface BackupManifest {
  workspaceRoot: string
  files: Array<{
    path: string
    existed: boolean
    backup?: string
  }>
}

const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex')

const safePluginName = (value: string) => {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error('本地源码插件名称非法')
  return value
}

const patchFiles = (patch: string) => {
  if (!patch.trim() || Buffer.byteLength(patch, 'utf8') > maximumPatchBytes) {
    throw new Error(`补丁必须为 1 byte 到 ${maximumPatchBytes} bytes`)
  }
  if (/GIT binary patch|Binary files .* differ/i.test(patch)) {
    throw new Error('受管修复第一版不支持二进制补丁')
  }
  if (
    /^(?:rename|copy) (?:from|to) /m.test(patch) ||
    /^(?:new file mode|old mode) (?:120000|160000)$/m.test(patch) ||
    /^Subproject commit /m.test(patch)
  ) {
    throw new Error('受管修复不允许重命名、复制、符号链接或子模块补丁')
  }
  const declared = [
    ...patch.matchAll(/^diff --git a\/([^\t\r\n]+) b\/([^\t\r\n]+)$/gm),
  ].flatMap(match => [match[1], match[2]])
  const files = [
    ...patch.matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\r\n]+).*$/gm),
  ]
    .map(match => match[1].trim())
    .filter(value => value !== '/dev/null')
    .map(value => value.replace(/\\/g, '/'))
  const unique = [...new Set([...declared, ...files].map(value => value.replace(/\\/g, '/')))]
  if (!unique.length) throw new Error('补丁不包含可识别的文件')
  for (const filename of unique) {
    if (
      path.posix.isAbsolute(filename) ||
      filename.split('/').includes('..') ||
      deniedPath.test(filename)
    ) {
      throw new Error(`补丁路径不在允许范围内: ${filename}`)
    }
  }
  return unique
}

const resolveInside = (root: string, relativePath: string) => {
  const filename = path.resolve(root, relativePath)
  const relative = path.relative(root, filename)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`补丁路径越过工作区: ${relativePath}`)
  }
  return filename
}

const assertNoSymlink = async (root: string, relativePath: string) => {
  const resolvedRoot = path.resolve(root)
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  let current = resolvedRoot
  for (const segment of segments) {
    current = path.join(current, segment)
    const stat = await fs.promises.lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!stat) return
    if (stat.isSymbolicLink()) {
      throw new Error(`修复路径包含符号链接，拒绝访问: ${relativePath}`)
    }
  }
}

const run = async (
  command: string,
  args: string[],
  cwd: string,
  timeout = 120_000
) => {
  const result = await execFileAsync(command, args, {
    cwd,
    timeout,
    maxBuffer: maximumProcessOutput,
    windowsHide: true,
    encoding: 'utf8',
  })
  return `${result.stdout || ''}${result.stderr || ''}`.slice(-maximumProcessOutput)
}

const packageManager = () => process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

export class AgentRepairManager {
  constructor (
    private readonly database: AgentDatabase,
    private readonly restart: () => Promise<void>,
    private readonly karinWorkspace = process.cwd(),
    private readonly pluginWorkspace = karinPathPlugins,
    private readonly directory = candidateDirectory
  ) {}

  private assertAllowedWorkspace (workspaceRoot: string) {
    const root = path.resolve(workspaceRoot)
    const karinRoot = path.resolve(this.karinWorkspace)
    if (root === karinRoot) return root
    const pluginsRoot = path.resolve(this.pluginWorkspace)
    const relative = path.relative(pluginsRoot, root)
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).length !== 1 ||
      relative.toLowerCase() === 'node_modules'
    ) {
      throw new Error('修复目标不在 Karin 或已识别的本地源码插件工作区')
    }
    return root
  }

  private workspace (proposal: Pick<AgentRepairProposal, 'target' | 'pluginName'>) {
    if (proposal.target === 'karin') {
      return this.assertAllowedWorkspace(path.resolve(this.karinWorkspace))
    }
    const pluginName = safePluginName(String(proposal.pluginName || ''))
    return this.assertAllowedWorkspace(path.resolve(this.pluginWorkspace, pluginName))
  }

  async propose (
    proposal: AgentRepairProposal,
    actor: AgentActor,
    threadId: string,
    turnId: string
  ) {
    const workspaceRoot = this.workspace(proposal)
    const stat = await fs.promises.stat(workspaceRoot).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('修复目标工作区不存在')
    if (workspaceRoot.includes(`${path.sep}node_modules${path.sep}`)) {
      throw new Error('禁止修改 node_modules 或已发布安装包')
    }
    const files = patchFiles(proposal.patch)
    const baselineFiles: Record<string, string | null> = {}
    for (const relativePath of files) {
      const filename = resolveInside(workspaceRoot, relativePath)
      await assertNoSymlink(workspaceRoot, relativePath)
      const buffer = await fs.promises.readFile(filename).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      baselineFiles[relativePath] = buffer ? hash(buffer) : null
    }

    await fs.promises.mkdir(this.directory, { recursive: true })
    const patchHash = hash(proposal.patch)
    const fingerprint = hash(JSON.stringify({
      problem: proposal.problem,
      rootCause: proposal.rootCause,
      files,
      patchHash,
    }))
    const duplicate = (await this.database.listEvolutionCandidates(undefined, 500))
      .find(candidate =>
        ['tool', 'repair'].includes(candidate.target) &&
        candidate.payload.fingerprint === fingerprint &&
        !['rejected', 'rolled_back'].includes(candidate.state)
      )
    if (duplicate) return duplicate

    const candidate = await this.database.createEvolutionCandidate({
      target: 'repair',
      kind: 'executable',
      sourceTurnIds: [turnId],
      candidateVersion: patchHash.slice(0, 12),
      summary: `受管修复：${proposal.problem}`,
      payload: {
        fingerprint,
        problem: proposal.problem,
        reproduction: proposal.reproduction,
        evidence: [],
        rootCause: proposal.rootCause,
        confidence: Math.max(0, Math.min(Number(proposal.confidence) || 0, 1)),
        workspaceRoot,
        affectedFiles: files,
        patchHash,
        patchFile: '',
        baselineFiles,
        semantics: proposal.semantics,
        stopCondition: proposal.stopCondition,
        failureStrategy: proposal.failureStrategy,
        verification: [...new Set(proposal.verification)].map(command => ({
          command,
          status: 'pending',
        })),
        rollback: proposal.rollback,
      },
    })
    if (!candidate) throw new Error('创建修复候选失败')
    const patchName = `${candidate.id}.patch`
    const patchFile = path.join(this.directory, patchName)
    await fs.promises.writeFile(patchFile, proposal.patch, { encoding: 'utf8', flag: 'wx' })
    const payload: Record<string, unknown> = {
      ...candidate.payload,
      patchFile: patchName,
    }
    await this.database.updateEvolutionPayload(candidate.id, payload)

    try {
      const output = await run('git', ['apply', '--check', patchFile], workspaceRoot, 30_000)
      const verification = (payload.verification as Array<Record<string, unknown>>).map(item => ({
        ...item,
        status: 'pending',
      }))
      await this.database.updateEvolutionPayload(candidate.id, {
        ...payload,
        verification,
        patchCheck: output || 'git apply --check passed',
      })
      await this.database.updateEvolutionCandidate(candidate.id, 'ready')
      await this.database.addEvolutionEvent(
        candidate.id,
        'repair.patch.validated',
        actor.id,
        { files, patchHash }
      )
    } catch (error) {
      await this.database.updateEvolutionPayload(candidate.id, {
        ...payload,
        patchCheck: (error as Error).message.slice(0, 10_000),
      })
      await this.database.addEvolutionEvent(
        candidate.id,
        'repair.patch.invalid',
        actor.id,
        { error: (error as Error).message }
      )
    }
    await this.database.audit(
      actor.id,
      'repair.propose',
      candidate.id,
      { patchHash, files },
      threadId
    )
    return this.database.getEvolutionCandidate(candidate.id)
  }

  async artifact (candidateId: string) {
    const candidate = await this.database.getEvolutionCandidate(candidateId)
    if (!candidate || !['tool', 'repair'].includes(candidate.target)) {
      throw new Error('修复候选不存在')
    }
    const patchName = String(candidate.payload.patchFile || '')
    if (!/^[a-f0-9-]+\.patch$/i.test(patchName)) throw new Error('候选尚无补丁')
    const patch = await fs.promises.readFile(path.join(this.directory, patchName), 'utf8')
    if (hash(patch) !== candidate.payload.patchHash) throw new Error('候选补丁哈希不匹配')
    return { candidate, patch }
  }

  private async backup (
    candidateId: string,
    workspaceRoot: string,
    files: string[]
  ) {
    const directory = path.join(this.directory, `${candidateId}-backup`)
    await fs.promises.rm(directory, { recursive: true, force: true })
    await fs.promises.mkdir(directory, { recursive: true })
    const manifest: BackupManifest = { workspaceRoot, files: [] }
    for (const [index, relativePath] of files.entries()) {
      const filename = resolveInside(workspaceRoot, relativePath)
      await assertNoSymlink(workspaceRoot, relativePath)
      const buffer = await fs.promises.readFile(filename).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!buffer) {
        manifest.files.push({ path: relativePath, existed: false })
        continue
      }
      const backup = `${index}.bin`
      await fs.promises.writeFile(path.join(directory, backup), buffer, { flag: 'wx' })
      manifest.files.push({ path: relativePath, existed: true, backup })
    }
    await fs.promises.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    )
    return directory
  }

  private async restore (candidateId: string) {
    const directory = path.join(this.directory, `${candidateId}-backup`)
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(directory, 'manifest.json'), 'utf8')
    ) as BackupManifest
    const workspaceRoot = this.assertAllowedWorkspace(manifest.workspaceRoot)
    for (const item of manifest.files) {
      const filename = resolveInside(workspaceRoot, item.path)
      await assertNoSymlink(workspaceRoot, item.path)
      if (!item.existed) {
        await fs.promises.rm(filename, { force: true })
        continue
      }
      await fs.promises.mkdir(path.dirname(filename), { recursive: true })
      await fs.promises.copyFile(path.join(directory, String(item.backup)), filename)
    }
  }

  private async verify (
    workspaceRoot: string,
    presets: AgentRepairVerification[]
  ) {
    const reports: Array<{
      command: AgentRepairVerification
      status: 'passed' | 'failed'
      output: string
    }> = []
    for (const preset of presets) {
      const args = preset === 'agent-tests'
        ? ['exec', 'vitest', 'run', 'tests/agent']
        : preset === 'core-build'
          ? ['--filter', 'node-karin', 'run', 'build:main']
          : preset === 'web-build'
            ? ['--filter', 'karin-webui', 'run', 'build']
            : ['build']
      try {
        reports.push({
          command: preset,
          status: 'passed',
          output: await run(packageManager(), args, workspaceRoot, 300_000),
        })
      } catch (error) {
        reports.push({
          command: preset,
          status: 'failed',
          output: (error as Error).message.slice(-maximumProcessOutput),
        })
        break
      }
    }
    return reports
  }

  async apply (candidateId: string, actor: AgentActor, restartCore: boolean) {
    const { candidate, patch } = await this.artifact(candidateId)
    if (candidate.state !== 'ready') throw new Error(`候选状态不是 ready: ${candidate.state}`)
    const workspaceRoot = this.assertAllowedWorkspace(
      path.resolve(String(candidate.payload.workspaceRoot || ''))
    )
    const files = patchFiles(patch)
    const baseline = candidate.payload.baselineFiles as Record<string, string | null> | undefined
    for (const relativePath of files) {
      await assertNoSymlink(workspaceRoot, relativePath)
      const current = await fs.promises.readFile(
        resolveInside(workspaceRoot, relativePath)
      ).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      const currentHash = current ? hash(current) : null
      if (baseline?.[relativePath] !== currentHash) {
        throw new Error(`文件在候选创建后已变化，拒绝覆盖: ${relativePath}`)
      }
    }

    const patchFile = path.join(this.directory, String(candidate.payload.patchFile))
    await run('git', ['apply', '--check', patchFile], workspaceRoot, 30_000)
    await this.backup(candidateId, workspaceRoot, files)
    try {
      await run('git', ['apply', patchFile], workspaceRoot, 30_000)
      const presets = (Array.isArray(candidate.payload.verification)
        ? candidate.payload.verification
        : [])
        .map(item => String((item as Record<string, unknown>).command))
        .filter((item): item is AgentRepairVerification =>
          ['agent-tests', 'core-build', 'web-build', 'root-build'].includes(item)
        )
      const reports = await this.verify(workspaceRoot, presets)
      if (reports.some(report => report.status === 'failed')) {
        throw new Error(`修复验证失败：${reports.find(item => item.status === 'failed')?.command}`)
      }
      await this.database.updateEvolutionPayload(candidateId, {
        ...candidate.payload,
        verification: reports,
        appliedAt: Date.now(),
        appliedBy: actor.id,
      })
      await this.database.updateEvolutionCandidate(candidateId, 'active')
      await this.database.addEvolutionEvent(
        candidateId,
        'repair.applied',
        actor.id,
        { files, restartCore }
      )
      await this.database.audit(actor.id, 'repair.apply', candidateId, {
        files,
        restartCore,
      })
      if (restartCore) {
        const timer = setTimeout(() => {
          this.restart().catch(error => logger.error(
            new Error('[agent][repair] 修复已应用，但 Core 重启失败', { cause: error })
          ))
        }, 500)
        timer.unref()
      }
      return this.database.getEvolutionCandidate(candidateId)
    } catch (error) {
      await this.restore(candidateId)
      await this.database.updateEvolutionCandidate(candidateId, 'rolled_back')
      await this.database.addEvolutionEvent(
        candidateId,
        'repair.apply.failed',
        actor.id,
        { error: (error as Error).message }
      )
      await this.database.audit(actor.id, 'repair.apply.failed', candidateId, {
        error: (error as Error).message,
      })
      throw error
    }
  }

  async rollback (candidateId: string, actor: AgentActor, restartCore: boolean) {
    const candidate = await this.database.getEvolutionCandidate(candidateId)
    if (!candidate || candidate.state !== 'active') throw new Error('只有 active 修复候选可以回滚')
    await this.restore(candidateId)
    await this.database.updateEvolutionCandidate(candidateId, 'rolled_back')
    await this.database.addEvolutionEvent(candidateId, 'repair.rolled_back', actor.id, {
      restartCore,
    })
    await this.database.audit(actor.id, 'repair.rollback', candidateId, { restartCore })
    if (restartCore) {
      const timer = setTimeout(() => {
        this.restart().catch(error => logger.error(
          new Error('[agent][repair] 已恢复源码，但 Core 重启失败', { cause: error })
        ))
      }, 500)
      timer.unref()
    }
    return this.database.getEvolutionCandidate(candidateId)
  }
}
