import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { watch } from '../../fs/watch'
import { requireFileSync } from '../../fs/require'
import { FILE_CHANGE } from '@/utils/fs'
import { listeners } from '@/core/internal/listeners'

import type { AgentConfig, AgentProviderKind, AgentProviderProfile } from '@/types/agent'

type LegacyLearningConfig = {
  memory?: boolean
  skills?: boolean
}

interface LegacyAgentConfig extends Omit<
  AgentConfig,
  'version' | 'providers' | 'routing' | 'learning' | 'recovery' | 'tasks' | 'context' | 'journal'
> {
  learning?: LegacyLearningConfig
  provider?: {
    type?: string
    baseUrl?: string
    model?: string
    apiKeyEnv?: string
    apiKey?: string
    timeout?: number
  }
}

export interface AgentConfigUpdate extends Omit<Partial<AgentConfig>, 'providers'> {
  providers?: Array<Partial<AgentProviderProfile> & {
    id: string
    clearApiKey?: boolean
  }>
}

const providerDefaults: Record<AgentProviderKind, Pick<AgentProviderProfile, 'name' | 'baseUrl'>> = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  kimi: { name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1' },
  mimo: { name: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1' },
  custom: { name: 'Custom', baseUrl: 'http://127.0.0.1:8000/v1' },
}

const legacyDefaultHardDeny = ['*.uninstall', '*.delete', '*.remove', '*.destroy']

const normalizePolicy = (
  value: Partial<AgentConfig['policy']> | undefined,
  sourceVersion: number
): AgentConfig['policy'] => {
  const hardDeny = [...new Set(value?.hardDeny || [])]
  const usesLegacyDefault = sourceVersion < 5 &&
    hardDeny.length === legacyDefaultHardDeny.length &&
    legacyDefaultHardDeny.every((pattern, index) => hardDeny[index] === pattern)

  return {
    approvalTtlMs: Math.max(1000, Number(value?.approvalTtlMs) || 300000),
    hardDeny: usesLegacyDefault ? [] : hardDeny,
    rules: value?.rules || [],
    defaults: {
      read: value?.defaults?.read || 'allow',
      write: value?.defaults?.write || 'ask',
      external: value?.defaults?.external || 'ask',
      destructive: sourceVersion < 5 ? 'ask' : value?.defaults?.destructive || 'ask',
    },
    autoApproveTrustedReversible: value?.autoApproveTrustedReversible !== false,
  }
}

const normalizeTasks = (
  value?: Partial<AgentConfig['tasks']>
): AgentConfig['tasks'] => ({
  enabled: value?.enabled !== false,
  maxItems: Math.max(1, Math.min(Number(value?.maxItems) || 64, 256)),
  completionGuardRetries: Math.max(
    0,
    Math.min(Number(value?.completionGuardRetries) || 2, 5)
  ),
})

const normalizeContext = (
  value?: Partial<AgentConfig['context']>
): AgentConfig['context'] => {
  const softLimitRatio = Math.max(0.1, Math.min(Number(value?.softLimitRatio) || 0.5, 0.8))
  const hardLimitRatio = Math.max(
    softLimitRatio + 0.05,
    Math.min(Number(value?.hardLimitRatio) || 0.85, 0.95)
  )
  return {
    defaultWindowTokens: Math.max(
      8192,
      Math.min(Number(value?.defaultWindowTokens) || 65536, 2_000_000)
    ),
    softLimitRatio,
    hardLimitRatio,
    protectedRecentMessages: Math.max(
      2,
      Math.min(Number(value?.protectedRecentMessages) || 12, 100)
    ),
    summaryTargetTokens: Math.max(
      512,
      Math.min(Number(value?.summaryTargetTokens) || 4096, 32768)
    ),
  }
}

const normalizeJournal = (
  value?: Partial<AgentConfig['journal']>
): AgentConfig['journal'] => ({
  recoveryAttempts: Math.max(0, Math.min(Number(value?.recoveryAttempts) || 2, 10)),
  eventRetentionDays: Math.max(1, Math.min(Number(value?.eventRetentionDays) || 7, 365)),
})

const normalizeLimits = (
  value?: Partial<AgentConfig['limits']>
): AgentConfig['limits'] => ({
  maxToolRounds: Math.max(1, Math.min(Number(value?.maxToolRounds) || 99, 99)),
  maxToolOutputBytes: Math.max(
    1024,
    Math.min(Number(value?.maxToolOutputBytes) || 65536, 5 * 1024 * 1024)
  ),
  maxRecentMessages: Math.max(
    4,
    Math.min(Number(value?.maxRecentMessages) || 40, 1000)
  ),
  maxSubagents: Math.max(1, Math.min(Number(value?.maxSubagents) || 3, 32)),
})

const normalizeScriptRuntime = (
  value?: Partial<AgentConfig['scriptRuntime']>
): AgentConfig['scriptRuntime'] => {
  const maxTimeoutMs = Math.max(
    1000,
    Math.min(Number(value?.maxTimeoutMs) || 120000, 120000)
  )
  const maxOutputBytes = Math.max(
    1024,
    Math.min(Number(value?.maxOutputBytes) || 1048576, 1048576)
  )
  return {
    pythonExecutable: String(value?.pythonExecutable || '').trim(),
    defaultTimeoutMs: Math.max(
      1000,
      Math.min(Number(value?.defaultTimeoutMs) || 30000, maxTimeoutMs)
    ),
    maxTimeoutMs,
    defaultMaxOutputBytes: Math.max(
      1024,
      Math.min(Number(value?.defaultMaxOutputBytes) || 65536, maxOutputBytes)
    ),
    maxOutputBytes,
  }
}

const normalizeLearning = (
  value?: Partial<AgentConfig['learning']> | LegacyLearningConfig
): AgentConfig['learning'] => {
  const expanded = value as Partial<AgentConfig['learning']> | undefined
  const reflection = expanded?.reflection
  const curator = expanded?.curator
  const promotion = expanded?.promotion
  return {
    memory: value?.memory !== false,
    skills: value?.skills !== false,
    reflection: {
      enabled: reflection?.enabled !== false,
      afterFailure: reflection?.afterFailure !== false,
      successInterval: Math.max(1, Math.min(Number(reflection?.successInterval) || 5, 100)),
    },
    curator: {
      enabled: curator?.enabled !== false,
      intervalHours: Math.max(1, Math.min(Number(curator?.intervalHours) || 168, 8760)),
      minIdleMinutes: Math.max(1, Math.min(Number(curator?.minIdleMinutes) || 120, 10080)),
      staleAfterDays: Math.max(1, Math.min(Number(curator?.staleAfterDays) || 30, 3650)),
      archiveAfterDays: Math.max(1, Math.min(Number(curator?.archiveAfterDays) || 90, 3650)),
    },
    promotion: {
      autoMemory: promotion?.autoMemory !== false,
      autoRouting: promotion?.autoRouting !== false,
      autoDeclarativeSkills: promotion?.autoDeclarativeSkills !== false,
      minEvidence: Math.max(1, Math.min(Number(promotion?.minEvidence) || 3, 100)),
      minSuccessRate: Math.max(0, Math.min(Number(promotion?.minSuccessRate) || 0.8, 1)),
      maxRegressionRate: Math.max(0, Math.min(Number(promotion?.maxRegressionRate) || 0.05, 1)),
      autoRollback: promotion?.autoRollback !== false,
      rollbackWindow: Math.max(1, Math.min(Number(promotion?.rollbackWindow) || 20, 1000)),
    },
  }
}

const normalizeRecovery = (
  value?: Partial<AgentConfig['recovery']>
): AgentConfig['recovery'] => {
  const policy = value?.researchPolicy
  return {
    enabled: value?.enabled !== false,
    maxCycles: Math.max(0, Math.min(Number(value?.maxCycles) || 2, 5)),
    maxDiagnosticCalls: Math.max(
      1,
      Math.min(Number(value?.maxDiagnosticCalls) || 99, 99)
    ),
    maxDurationMs: Math.max(
      10_000,
      Math.min(Number(value?.maxDurationMs) || 120_000, 600_000)
    ),
    researchPolicy: policy === 'always' || policy === 'explicit'
      ? policy
      : 'evidence-driven',
    repair: {
      requireApproval: value?.repair?.requireApproval !== false,
      workspaceRoots: [
        ...new Set(
          (value?.repair?.workspaceRoots || [])
            .map(root => String(root).trim())
            .filter(root => path.isAbsolute(root))
        ),
      ].slice(0, 32),
    },
  }
}

export const agentProviderFingerprint = (profile: AgentProviderProfile) =>
  createHash('sha256')
    .update([
      profile.id,
      profile.kind,
      profile.baseUrl,
      profile.model,
      profile.apiKey,
      profile.timeout,
    ].join('\0'))
    .digest('hex')

export const agentProviderPresets = () =>
  Object.entries(providerDefaults).map(([kind, value]) => ({
    kind: kind as AgentProviderKind,
    ...value,
  }))

let cache: AgentConfig
let configFile = ''

const normalizeProfile = (
  value: Partial<AgentProviderProfile>,
  index: number
): AgentProviderProfile => {
  const kind = value.kind && value.kind in providerDefaults ? value.kind : 'custom'
  const defaults = providerDefaults[kind]
  const id = String(value.id || `${kind}-${index + 1}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 64)
  const profile: AgentProviderProfile = {
    id: id || `${kind}-${index + 1}`,
    name: String(value.name || defaults.name).trim().slice(0, 100),
    kind,
    enabled: value.enabled !== false,
    baseUrl: String(value.baseUrl || defaults.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: String(value.apiKey || ''),
    model: String(value.model || '').trim(),
    discoveredModels: [
      ...new Set(
        (value.discoveredModels || [])
          .map(model => String(model).trim())
          .filter(Boolean)
      ),
    ].sort((left, right) => left.localeCompare(right)).slice(0, 1000),
    visionModels: [
      ...new Set(
        (value.visionModels || [])
          .map(model => String(model).trim())
          .filter(Boolean)
      ),
    ].sort((left, right) => left.localeCompare(right)).slice(0, 1000),
    modelsDiscoveredAt: value.modelsDiscoveredAt
      ? Math.max(0, Number(value.modelsDiscoveredAt))
      : undefined,
    timeout: Math.max(1000, Math.min(Number(value.timeout) || 30000, 300000)),
    contextWindowTokens: value.contextWindowTokens
      ? Math.max(8192, Math.min(Number(value.contextWindowTokens), 2_000_000))
      : undefined,
  }
  if (
    value.verification &&
    value.verification.fingerprint === agentProviderFingerprint(profile)
  ) {
    profile.verification = value.verification
  }
  return profile
}

export const migrateAgentConfig = (
  data: AgentConfig | LegacyAgentConfig
): AgentConfig => {
  const value = structuredClone(data)
  if (Array.isArray((value as AgentConfig).providers)) {
    const current = value as AgentConfig
    const sourceVersion = Number(current.version) || 0
    const profiles = current.providers.map(normalizeProfile)
    const unique = profiles.filter(
      (profile, index) => profiles.findIndex(item => item.id === profile.id) === index
    )
    const routing = (value as AgentConfig).routing
    const primary = unique.some(item => item.id === routing?.primary)
      ? routing.primary
      : unique[0]?.id || ''
    return {
      ...(value as AgentConfig),
      version: 9,
      providers: unique,
      routing: {
        primary,
        fallback: (routing?.fallback || []).filter(
          (id, index, list) => id !== primary && unique.some(item => item.id === id) &&
            list.indexOf(id) === index
        ),
      },
      tools: {
        disabled: [...new Set((value as AgentConfig).tools?.disabled || [])],
        disabledToolsets: [
          ...new Set((value as AgentConfig).tools?.disabledToolsets || []),
        ],
      },
      limits: normalizeLimits(current.limits),
      tasks: normalizeTasks(current.tasks),
      context: normalizeContext(current.context),
      journal: normalizeJournal(current.journal),
      policy: normalizePolicy(current.policy, sourceVersion),
      scriptRuntime: normalizeScriptRuntime(current.scriptRuntime),
      learning: normalizeLearning((value as AgentConfig).learning),
      recovery: normalizeRecovery((value as AgentConfig).recovery),
    }
  }

  const legacy = value as LegacyAgentConfig
  const envName = legacy.provider?.apiKeyEnv || 'KARIN_AGENT_API_KEY'
  const profile = normalizeProfile(
    {
      id: 'default',
      name: 'Default',
      kind: 'custom',
      baseUrl: legacy.provider?.baseUrl,
      model: legacy.provider?.model,
      apiKey: legacy.provider?.apiKey || process.env[envName] || '',
      timeout: legacy.provider?.timeout,
    },
    0
  )
  const { provider: _provider, ...rest } = legacy
  return {
    ...(rest as Omit<AgentConfig, 'version' | 'providers' | 'routing' | 'learning'>),
    version: 9,
    providers: [profile],
    routing: { primary: profile.id, fallback: [] },
    limits: normalizeLimits(legacy.limits),
    tasks: normalizeTasks(),
    context: normalizeContext(),
    journal: normalizeJournal(),
    policy: normalizePolicy(legacy.policy, 0),
    scriptRuntime: normalizeScriptRuntime(legacy.scriptRuntime),
    learning: normalizeLearning(legacy.learning),
    recovery: normalizeRecovery(),
    tools: { disabled: [], disabledToolsets: [] },
  }
}

const initAgent = (dir: string) => {
  const name = 'agent.json'
  configFile = path.join(dir, name)
  const stored = requireFileSync<AgentConfig | LegacyAgentConfig>(configFile, { type: 'json' })
  cache = migrateAgentConfig(stored)
  if (Number((stored as Partial<AgentConfig>).version) !== 9 || !('journal' in stored)) {
    const temporary = `${configFile}.migration.tmp`
    fs.writeFileSync(temporary, JSON.stringify(cache, null, 2), 'utf8')
    fs.renameSync(temporary, configFile)
  }

  watch<AgentConfig>(
    configFile,
    (old, data) => {
      cache = migrateAgentConfig(data)
      const options = { file: name, old, data: cache }
      listeners.emit(FILE_CHANGE, options)
      listeners.emit(`${FILE_CHANGE}:${name}`, options)
    },
    { type: 'json' }
  )
}

export const agentConfig = () => cache

export const getAgentProvider = (id = agentConfig()?.routing.primary) =>
  agentConfig()?.providers.find(profile => profile.id === id) || null

export const getAgentProviderOrder = () => {
  const config = agentConfig()
  const ids = [config.routing.primary, ...config.routing.fallback]
  return ids
    .map(id => config.providers.find(profile => profile.id === id))
    .filter((profile): profile is AgentProviderProfile => Boolean(profile?.enabled))
}

export const redactAgentConfig = (config: AgentConfig) => ({
  ...structuredClone(config),
  providers: config.providers.map(profile => ({
    ...profile,
    apiKey: '',
    apiKeyConfigured: Boolean(profile.apiKey),
    verification: profile.verification
      ? {
        testedAt: profile.verification.testedAt,
        chat: profile.verification.chat,
        stream: profile.verification.stream,
        tools: profile.verification.tools,
        latency: profile.verification.latency,
      }
      : undefined,
  })),
})

export const publicAgentConfig = () => redactAgentConfig(agentConfig())

export const mergeAgentConfig = (
  current: AgentConfig,
  update: AgentConfigUpdate
): AgentConfig => {
  const incomingProfiles: AgentConfigUpdate['providers'] = update.providers ||
    current.providers.map(profile => ({ ...profile }))
  const providers = incomingProfiles.map((profile, index) => {
    const existing = current.providers.find(item => item.id === profile.id)
    const apiKey = profile.clearApiKey
      ? ''
      : typeof profile.apiKey === 'string' && profile.apiKey
        ? profile.apiKey
        : existing?.apiKey || ''
    return normalizeProfile({ ...existing, ...profile, apiKey }, index)
  })
  return migrateAgentConfig({
    ...current,
    ...update,
    version: 9,
    providers,
    routing: update.routing || current.routing,
  } as AgentConfig)
}

export const mergeAgentConfigUpdate = (update: AgentConfigUpdate): AgentConfig =>
  mergeAgentConfig(agentConfig(), update)

export const saveAgentConfig = async (data: AgentConfig) => {
  if (!configFile) throw new Error('Agent 配置尚未初始化')
  const next = migrateAgentConfig(data)
  const temporary = `${configFile}.tmp`
  await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2), 'utf-8')
  await fs.promises.rename(temporary, configFile)
  cache = next
}

export const saveAgentProviderVerification = async (
  id: string,
  result: {
    chat: boolean
    stream: boolean
    tools: boolean
    latency: number
  }
) => {
  const profile = getAgentProvider(id)
  if (!profile) throw new Error(`Provider 不存在: ${id}`)
  const next = structuredClone(agentConfig())
  const target = next.providers.find(item => item.id === id)
  if (!target) throw new Error(`Provider 不存在: ${id}`)
  target.verification = {
    testedAt: Date.now(),
    chat: result.chat,
    stream: result.stream,
    tools: result.tools,
    latency: result.latency,
    fingerprint: agentProviderFingerprint(profile),
  }
  await saveAgentConfig(next)
}

export const saveAgentProviderModels = async (id: string, models: string[]) => {
  const next = structuredClone(agentConfig())
  const target = next.providers.find(item => item.id === id)
  if (!target) throw new Error(`Provider 不存在: ${id}`)
  target.discoveredModels = [
    ...new Set(models.map(model => String(model).trim()).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right)).slice(0, 1000)
  target.modelsDiscoveredAt = Date.now()
  await saveAgentConfig(next)
  return target.discoveredModels
}

export const hasAgentApiKey = () => getAgentProviderOrder().some(profile => Boolean(profile.apiKey))

export default initAgent
