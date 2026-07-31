import { describe, expect, it } from 'vitest'
import {
  mergeAgentConfig,
  migrateAgentConfig,
  redactAgentConfig,
} from '../../packages/core/src/utils/config/file/agent'
import {
  mergeAdapterConfig,
  redactAdapterConfig,
} from '../../packages/core/src/utils/config/file/adapter'

import type { AgentConfig } from '../../packages/core/src/types/agent'
import type { Adapters } from '../../packages/core/src/types/config'

const agentConfig = (): AgentConfig => ({
  version: 3,
  enabled: false,
  providers: [{
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-api-key-original',
    model: 'gpt-test',
    timeout: 30000,
  }],
  routing: { primary: 'openai', fallback: [] },
  trigger: { private: true, groupMention: true, wakeWords: [] },
  limits: {
    maxToolRounds: 8,
    maxToolOutputBytes: 65536,
    maxRecentMessages: 40,
    maxSubagents: 3,
  },
  policy: {
    approvalTtlMs: 300000,
    hardDeny: [],
    rules: [],
    defaults: {
      read: 'allow',
      write: 'ask',
      external: 'ask',
      destructive: 'deny',
    },
  },
  learning: { memory: false, skills: false },
  tools: { disabled: [], disabledToolsets: [] },
  mcp: { enabled: false, servers: [] },
})

const adapters = (): Adapters => ({
  console: { isLocal: true, token: '', host: '' },
  onebot: {
    ws_server: { enable: true, timeout: 120 },
    ws_client: [{ enable: false, url: 'ws://127.0.0.1:7778', token: 'onebot-kept' }],
    http_server: [],
  },
  wecom: [{
    id: 'wecom-1',
    name: 'WeCom',
    enable: true,
    botId: 'bot-1',
    secret: 'test-wecom-secret',
    wsUrl: '',
    reconnectInterval: 5000,
    maxReconnectAttempts: 20,
    trigger: { wakeWords: [] },
  }],
  feishu: [{
    id: 'feishu-1',
    name: 'Feishu',
    enable: true,
    appId: 'app-1',
    appSecret: 'test-feishu-secret',
    domain: 'feishu',
    reconnectInterval: 5000,
    maxReconnectAttempts: 20,
    trigger: { wakeWords: [] },
  }],
  telegram: [{
    id: 'telegram-1',
    name: 'Telegram',
    enable: true,
    botToken: 'test-telegram-token',
    apiBase: 'https://api.telegram.org',
    pollTimeout: 30,
    allowedUpdates: ['message'],
    trigger: { wakeWords: [] },
  }],
})

describe('versioned configuration and write-only secrets', () => {
  it('migrates the legacy single provider without dropping its values', () => {
    const migrated = migrateAgentConfig({
      ...agentConfig(),
      version: undefined,
      providers: undefined,
      routing: undefined,
      provider: {
        baseUrl: 'https://legacy.example/v1',
        model: 'legacy-model',
        apiKey: 'legacy-test-key',
        timeout: 12000,
      },
    } as never)

    expect(migrated.version).toBe(3)
    expect(migrated.providers[0]).toMatchObject({
      baseUrl: 'https://legacy.example/v1',
      model: 'legacy-model',
      apiKey: 'legacy-test-key',
      timeout: 12000,
    })
  })

  it('preserves, replaces and explicitly clears Provider API keys', () => {
    const current = agentConfig()
    const preserved = mergeAgentConfig(current, {
      providers: [{ id: 'openai', apiKey: '', model: 'new-model' }],
    })
    expect(preserved.providers[0].apiKey).toBe('test-api-key-original')
    expect(preserved.providers[0].model).toBe('new-model')

    const replaced = mergeAgentConfig(current, {
      providers: [{ id: 'openai', apiKey: 'test-api-key-new' }],
    })
    expect(replaced.providers[0].apiKey).toBe('test-api-key-new')

    const cleared = mergeAgentConfig(current, {
      providers: [{ id: 'openai', clearApiKey: true }],
    })
    expect(cleared.providers[0].apiKey).toBe('')
  })

  it('never exposes Provider or channel secrets and preserves OneBot data', () => {
    const agentPublic = redactAgentConfig(agentConfig())
    expect(JSON.stringify(agentPublic)).not.toContain('test-api-key-original')
    expect(agentPublic.providers[0].apiKeyConfigured).toBe(true)

    const current = adapters()
    const merged = mergeAdapterConfig(current, {
      ...current,
      wecom: [{ ...current.wecom[0], secret: '' }],
      feishu: [{ ...current.feishu[0], appSecret: '' }],
      telegram: [{ ...current.telegram[0], botToken: '' }],
    })
    expect(merged.wecom[0].secret).toBe('test-wecom-secret')
    expect(merged.feishu[0].appSecret).toBe('test-feishu-secret')
    expect(merged.telegram[0].botToken).toBe('test-telegram-token')
    expect(merged.onebot).toEqual(current.onebot)

    const cleared = mergeAdapterConfig(current, {
      telegram: [{ ...current.telegram[0], botToken: '', clearSecret: true }],
    })
    expect(cleared.telegram[0].botToken).toBe('')
    expect(cleared.telegram[0].clearSecret).toBeUndefined()

    const publicValue = redactAdapterConfig(merged)
    const serialized = JSON.stringify(publicValue)
    expect(serialized).not.toContain('test-wecom-secret')
    expect(serialized).not.toContain('test-feishu-secret')
    expect(serialized).not.toContain('test-telegram-token')
  })
})
