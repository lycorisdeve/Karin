import { createFile, createPkg } from '@/plugin/tools'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

import type { AgentProcessToolOptions, AgentToolOptions } from '@/types/agent'
import type { AgentTool } from '@/types/plugin'
import { agentSandbox } from '@/agent/execution/sandbox'

const TOOL_NAME = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/

export const createAgentTool = <
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown
>(
    options: AgentToolOptions<TInput, TOutput>,
    allowReserved = false
  ): AgentTool => {
  if (!TOOL_NAME.test(options.name)) {
    throw new Error(`[agent][tool] 非法工具名称: ${options.name}`)
  }

  if (!allowReserved && options.name.startsWith('karin.')) {
    throw new Error('[agent][tool] karin.* 是内置工具保留命名空间')
  }

  if (!options.description?.trim()) {
    throw new Error(`[agent][tool] ${options.name} 缺少描述`)
  }

  if (!options.inputSchema || typeof options.inputSchema !== 'object') {
    throw new Error(`[agent][tool] ${options.name} 缺少 inputSchema`)
  }

  return {
    ...options,
    permission: options.permission || 'all',
    risk: options.risk || 'read',
    riskResolver: options.riskResolver as AgentTool['riskResolver'],
    timeout: options.timeout || 30_000,
    idempotent: options.idempotent ?? false,
    execute: options.execute as AgentTool['execute'],
    file: createFile('tool', options.name),
    pkg: createPkg(),
  }
}

/**
 * 注册供 Karin Agent 调用的结构化工具。
 *
 * 固定命令与 Tool 是两条独立调用路径；Tool 不会伪造消息或递归触发命令。
 */
export const tool = <
    TInput extends Record<string, unknown> = Record<string, unknown>,
    TOutput = unknown
>(
    options: AgentToolOptions<TInput, TOutput>
  ) => createAgentTool(options)

/**
 * 注册使用 JSON stdin/stdout 协议的进程型 Tool。实际进程只能由 Core SandboxRunner
 * 启动；Tool 声明只能缩小管理员配置允许的文件和网络权限。
 */
export const processTool = <TInput extends Record<string, unknown> = Record<string, unknown>>(
  options: AgentProcessToolOptions<TInput>
) => {
  const command = String(options.process.command || '').trim()
  if (!command || (!path.isAbsolute(command) && !/^[a-zA-Z0-9._-]+$/.test(command))) {
    throw new Error(`[agent][tool] ${options.name} 的进程命令无效`)
  }
  const args = (options.process.args || []).map(String)
  if (args.some(item => item.includes('\0'))) {
    throw new Error(`[agent][tool] ${options.name} 的进程参数包含非法字符`)
  }
  const cwd = options.process.cwd
    ? path.resolve(options.process.cwd)
    : process.cwd()
  if (options.process.sandbox?.network === 'inherit' && options.risk !== 'external') {
    throw new Error(`[agent][tool] ${options.name} 继承网络必须声明 external 风险`)
  }
  return createAgentTool<TInput>({
    ...options,
    isolation: 'process-isolated',
    execute: async (input, context) => {
      const environment = Object.fromEntries(
        (options.process.envAllowlist || [])
          .filter(key => /^[A-Z_][A-Z0-9_]*$/i.test(key) && process.env[key] !== undefined)
          .map(key => [key, process.env[key]!])
      )
      const spawnEnvironment = {
        ...environment,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
      } as unknown as NodeJS.ProcessEnv
      const runner = agentSandbox()
      const current = runner.status()
      const attemptedSandbox = {
        backend: current.backend,
        mode: current.mode,
        network: options.process.sandbox?.network === 'inherit' ? 'inherit' as const : 'deny' as const,
        hardIsolation: current.hardIsolation,
        reason: current.reason,
      }
      if (context.sandboxTrace) context.sandboxTrace.execution = attemptedSandbox
      const sandboxProcess = await runner.spawn({
        command,
        args,
        cwd,
        env: spawnEnvironment,
        sandbox: options.process.sandbox,
      }, {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const { launch } = sandboxProcess
      if (context.sandboxTrace) context.sandboxTrace.execution = launch.execution
      context.sandbox = launch.execution
      if (context.signal.aborted) {
        await runner.terminate(sandboxProcess.child)
        await launch.cleanup?.()
        throw context.signal.reason || new Error(`进程 Tool ${options.name} 已中断`)
      }
      return new Promise((resolve, reject) => {
        const child = sandboxProcess.child as ChildProcessWithoutNullStreams
        const chunks: Buffer[] = []
        const errors: Buffer[] = []
        let bytes = 0
        const terminateTree = () => {
          runner.terminate(child).catch(() => undefined)
        }
        const abort = () => {
          terminateTree()
          launch.cleanup?.().catch(() => undefined)
          reject(context.signal.reason || new Error(`进程 Tool ${options.name} 已中断`))
        }
        context.signal.addEventListener('abort', abort, { once: true })
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > 5 * 1024 * 1024) {
            terminateTree()
            reject(new Error(`进程 Tool ${options.name} 输出超过 5 MiB`))
            return
          }
          chunks.push(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          if (Buffer.concat(errors).byteLength < 8192) errors.push(chunk)
        })
        child.once('error', error => {
          launch.cleanup?.().catch(() => undefined)
          reject(error)
        })
        child.once('close', (code: number | null) => {
          context.signal.removeEventListener('abort', abort)
          launch.cleanup?.().catch(() => undefined)
          if (context.signal.aborted) {
            reject(context.signal.reason || new Error(`进程 Tool ${options.name} 已中断`))
            return
          }
          if (code !== 0) {
            reject(new Error(
              `进程 Tool ${options.name} 退出码 ${code}: ${Buffer.concat(errors).toString('utf8').slice(0, 2048)}`
            ))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
          } catch (error) {
            reject(new Error(`进程 Tool ${options.name} 未返回有效 JSON`, { cause: error }))
          }
        })
        child.stdin.end(JSON.stringify(input))
      })
    },
  })
}
