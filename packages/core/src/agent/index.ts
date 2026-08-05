import root from '@/root'
import { cache } from '@/plugin/system/cache'
import { hooks } from '@/hooks'
import {
  agentConfig,
  agentProviderFingerprint,
  getAgentProvider,
  getAgentProviderOrder,
  hasAgentApiKey,
  saveAgentProviderVerification,
} from '@/utils/config/file/agent'
import { AgentProviderRegistry } from './model/provider-registry'
import { AgentDatabase } from './persistence/database'
import { AgentToolRegistry } from './tools/registry'
import { AgentPolicy } from './policy/policy'
import { AgentLearning } from './learning/learning'
import { AgentRuntime } from './runtime/runtime'
import { registerBuiltinTools } from './builtins/tools'
import { registerAgentIngress } from './ingress/message'
import { registerAgentCommands } from './ingress/commands'
import { AgentMcpClientManager } from './mcp/client'
import { AgentScheduler } from './automation/scheduler'
import { AgentRepairManager } from './repair/manager'
import { AgentTaskLedger } from './tasks/ledger'
import { AgentCapabilityCatalog } from './capabilities/catalog'
import { AgentGeneratedToolLibrary } from './generated-tools/library'
import type { AgentEvolutionPipeline } from './evolution'
import { restartDirect } from '@/utils/system/restart'

export interface AgentServices {
  database: AgentDatabase
  registry: AgentToolRegistry
  providers: AgentProviderRegistry | null
  runtime: AgentRuntime | null
  learning: AgentLearning | null
  mcp: AgentMcpClientManager | null
  scheduler: AgentScheduler | null
  repair: AgentRepairManager | null
  generatedTools: AgentGeneratedToolLibrary | null
  capabilities: AgentCapabilityCatalog | null
  evolution: AgentEvolutionPipeline | null
}

let services: AgentServices | null = null
let ingressHookId: number | null = null
let status: {
  state: 'disabled' | 'ready' | 'failed'
  reason?: string
} = { state: 'disabled' }

export const getAgentServices = () => services
export const getAgentRuntime = () => services?.runtime || null
export const getAgentStatus = () => ({
  ...status,
  enabled: Boolean(agentConfig()?.enabled),
  configured: Boolean(
    getAgentProviderOrder().some(profile => profile.model && profile.apiKey)
  ),
})

const removeBuiltinCommands = () => {
  const before = cache.command.length
  cache.command = cache.command.filter(item => item.file.name !== 'Karin Agent 审批')
  cache.count.command = Math.max(0, cache.count.command - (before - cache.command.length))
}

export const closeAgent = async () => {
  if (ingressHookId !== null) {
    hooks.empty.remove(ingressHookId)
    ingressHookId = null
  }
  removeBuiltinCommands()
  services?.scheduler?.stop()
  await services?.mcp?.close()
  services?.generatedTools?.close()
  services?.registry.unregisterPrefix('karin.')
  services?.registry.unregisterPrefix('mcp.')
  await services?.database.close()
  services = null
  status = { state: 'disabled' }
}

export const initAgent = async () => {
  if (services) await closeAgent()

  const database = new AgentDatabase(root.karinPathAgentDb)
  const registry = new AgentToolRegistry(database)
  services = {
    database,
    registry,
    providers: null,
    runtime: null,
    learning: null,
    mcp: null,
    scheduler: null,
    repair: null,
    generatedTools: null,
    capabilities: null,
    evolution: null,
  }

  try {
    await database.init()
    for (const tool of [...cache.tool]) {
      try {
        registry.validateDefinition(tool)
      } catch (error) {
        cache.tool = cache.tool.filter(item => item !== tool)
        cache.count.tool = Math.max(0, cache.count.tool - 1)
        logger.error(error)
      }
    }

    const config = agentConfig()
    await database.pruneTurnEvents(config.journal?.eventRetentionDays ?? 7)
    const provider = new AgentProviderRegistry(agentConfig)
    services.providers = provider
    if (!config.enabled) {
      status = { state: 'disabled', reason: 'Agent 配置未启用' }
      return services
    }
    if (!getAgentProviderOrder().some(profile => profile.model)) {
      status = { state: 'disabled', reason: 'Agent 模型未配置' }
      return services
    }
    if (!hasAgentApiKey()) {
      status = {
        state: 'disabled',
        reason: 'Agent Provider API Key 未配置',
      }
      return services
    }

    const primary = getAgentProvider(config.routing.primary)
    if (!primary) throw new Error('Agent 主 Provider 不存在')
    const verification = primary.verification
    const verified = verification &&
      verification.fingerprint === agentProviderFingerprint(primary) &&
      verification.chat &&
      verification.stream &&
      verification.tools
    if (!verified) {
      const result = await provider.probe(primary.id)
      if (!result.chat || !result.stream || !result.tools) {
        throw new Error('Agent 主 Provider 未通过对话、SSE 和 Tool Calling 验证')
      }
      await saveAgentProviderVerification(primary.id, result)
    }

    const policy = new AgentPolicy(agentConfig)
    const learning = new AgentLearning(
      database,
      provider,
      registry,
      agentConfig,
      root.karinPathAgentSkills
    )
    services.learning = learning
    const runtime = new AgentRuntime(database, registry, policy, provider, learning, agentConfig)
    services.runtime = runtime
    services.evolution = runtime.evolution

    const scheduler = new AgentScheduler(database, runtime)
    services.scheduler = scheduler
    const repair = new AgentRepairManager(
      database,
      () => restartDirect({ reloadDeps: false, isPm2: false })
    )
    services.repair = repair
    const taskLedger = new AgentTaskLedger(database, agentConfig)
    const capabilities = new AgentCapabilityCatalog(database, registry)
    const generatedTools = new AgentGeneratedToolLibrary(
      database,
      registry,
      learning.scriptRuntime
    )
    services.capabilities = capabilities
    services.generatedTools = generatedTools
    registerBuiltinTools(
      registry,
      database,
      runtime,
      scheduler,
      learning,
      taskLedger,
      capabilities,
      generatedTools,
      repair
    )

    const mcp = new AgentMcpClientManager(registry, agentConfig)
    services.mcp = mcp
    await mcp.init()
    await generatedTools.refresh()

    await scheduler.init()

    registerAgentCommands(runtime)
    ingressHookId = registerAgentIngress(runtime, agentConfig)
    status = { state: 'ready' }
    runtime.recoverPendingTurns().then(count => {
      if (count) logger.info(`[agent] 已接管 ${count} 个重启前未完成 Turn`)
    }).catch(error => {
      logger.error(new Error('[agent] 重启恢复失败', { cause: error }))
    })
    logger.info('[agent] Karin Agent 已启用')
    return services
  } catch (error) {
    status = { state: 'failed', reason: (error as Error).message }
    logger.error(new Error('[agent] 初始化失败，固定命令继续可用', { cause: error }))
    if (ingressHookId !== null) {
      hooks.empty.remove(ingressHookId)
      ingressHookId = null
    }
    removeBuiltinCommands()
    return services
  }
}

export const restartAgent = async () => initAgent()

export * from './runtime/runtime'
export * from './tools/registry'
export * from './persistence/database'
