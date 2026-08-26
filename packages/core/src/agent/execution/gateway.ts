import type {
  AgentConfig,
  AgentToolContext,
  AgentToolResultEnvelope,
} from '@/types/agent'
import type { AgentToolRegistry } from '../tools/registry'
import { agentSandboxStatus } from './sandbox'

export class AgentExecutionGateway {
  constructor (
    private readonly registry: AgentToolRegistry,
    private readonly getConfig: () => AgentConfig
  ) {}

  private denial (name: string, message: string): AgentToolResultEnvelope {
    const now = Date.now()
    return {
      status: 'failed',
      errorCode: 'TOOL_ISOLATION_REQUIRED',
      error: message,
      receipt: {
        toolName: name,
        status: 'failed',
        startedAt: now,
        completedAt: now,
        idempotent: false,
        sandbox: (() => {
          const status = agentSandboxStatus()
          return status
            ? {
              backend: status.backend,
              mode: status.mode,
              network: status.network,
              hardIsolation: status.hardIsolation,
              reason: status.reason,
            }
            : undefined
        })(),
      },
      evidence: [],
    }
  }

  async executeWithReceipt (
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
    maxOutputBytes: number
  ) {
    const isolation = this.registry.isolation(name)
    const config = this.getConfig().execution || {
      isolationMode: 'compat' as const,
      minimumIsolation: 'none' as const,
      hookTimeoutMs: 5000,
    }
    if (isolation === 'legacy-inline' && config.isolationMode === 'strict') {
      return this.denial(name, `严格隔离模式拒绝进程内插件 Tool：${name}`)
    }
    if (config.minimumIsolation === 'process' && isolation === 'legacy-inline') {
      return this.denial(name, `Tool ${name} 未达到最低进程隔离等级`)
    }
    if (
      config.minimumIsolation === 'os' &&
      !['core-inline', 'mcp-remote'].includes(isolation) &&
      !agentSandboxStatus()?.hardIsolation
    ) {
      return this.denial(name, `Tool ${name} 没有可用的操作系统级隔离后端`)
    }
    return this.registry.executeWithReceipt(name, input, context, maxOutputBytes)
  }
}
