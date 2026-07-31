import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { watch } from '../../fs/watch'
import { requireFileSync } from '../../fs/require'
import { FILE_CHANGE } from '@/utils/fs'
import { listeners } from '@/core/internal/listeners'

import type { AgentConfig, AgentProviderKind, AgentProviderProfile } from '@/types/agent'

interface LegacyAgentConfig extends Omit<AgentConfig, 'version' | 'providers' | 'routing'> {
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
    timeout: Math.max(1000, Math.min(Number(value.timeout) || 30000, 300000)),
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
    const profiles = (value as AgentConfig).providers.map(normalizeProfile)
    const unique = profiles.filter(
      (profile, index) => profiles.findIndex(item => item.id === profile.id) === index
    )
    const routing = (value as AgentConfig).routing
    const primary = unique.some(item => item.id === routing?.primary)
      ? routing.primary
      : unique[0]?.id || ''
    return {
      ...(value as AgentConfig),
      version: 3,
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
    ...(rest as Omit<AgentConfig, 'version' | 'providers' | 'routing'>),
    version: 3,
    providers: [profile],
    routing: { primary: profile.id, fallback: [] },
    tools: { disabled: [], disabledToolsets: [] },
  }
}

const initAgent = (dir: string) => {
  const name = 'agent.json'
  configFile = path.join(dir, name)
  cache = migrateAgentConfig(
    requireFileSync<AgentConfig | LegacyAgentConfig>(configFile, { type: 'json' })
  )

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
    version: 3,
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

export const hasAgentApiKey = () => getAgentProviderOrder().some(profile => Boolean(profile.apiKey))

export default initAgent
