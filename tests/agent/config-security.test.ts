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
  version: 7,
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
  learning: {
    memory: false,
    skills: false,
    reflection: { enabled: true, afterFailure: true, successInterval: 5 },
    curator: {
      enabled: true,
      intervalHours: 168,
      minIdleMinutes: 120,
      staleAfterDays: 30,
      archiveAfterDays: 90,
    },
    promotion: {
      autoMemory: true,
      autoRouting: true,
      autoDeclarativeSkills: true,
      minEvidence: 3,
      minSuccessRate: 0.8,
      maxRegressionRate: 0.05,
      autoRollback: true,
      rollbackWindow: 20,
    },
  },
  recovery: {
    enabled: true,
    maxCycles: 2,
    maxDiagnosticCalls: 8,
    maxDurationMs: 120000,
    researchPolicy: 'evidence-driven',
    repair: { requireApproval: true, workspaceRoots: [] },
  },
  tools: { disabled: [], disabledToolsets: [] },
  mcp: { enabled: false, servers: [] },
  scriptRuntime: {
    pythonExecutable: '',
    defaultTimeoutMs: 30000,
    maxTimeoutMs: 120000,
    defaultMaxOutputBytes: 65536,
    maxOutputBytes: 1048576,
  },
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
  qqbot: [{
    id: 'qqbot-1',
    name: 'QQBot',
    enable: true,
    appId: 'qq-app',
    clientSecret: 'test-qq-secret',
    apiBase: 'https://api.sgroup.qq.com',
    gatewayUrl: '',
    trigger: { wakeWords: [] },
  }],
  wechat: [],
  dingtalk: [],
  discord: [],
  whatsapp: [{
    id: 'whatsapp-1',
    name: 'WhatsApp',
    enable: true,
    phoneNumberId: 'phone-1',
    accessToken: 'test-whatsapp-access',
    appSecret: 'test-whatsapp-secret',
    verifyToken: 'test-whatsapp-verify',
    graphVersion: 'v23.0',
    trigger: { wakeWords: [] },
  }],
  email: [{
    id: 'email-1',
    name: 'Email',
    enable: true,
    address: 'bot@example.test',
    imapHost: 'imap.example.test',
    imapPort: 993,
    imapSecure: true,
    imapUser: 'bot@example.test',
    imapPassword: 'test-imap-password',
    mailbox: 'INBOX',
    smtpHost: 'smtp.example.test',
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: 'bot@example.test',
    smtpPassword: 'test-smtp-password',
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

    expect(migrated.version).toBe(7)
    expect(migrated.scriptRuntime).toMatchObject({
      pythonExecutable: '',
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000,
      defaultMaxOutputBytes: 65536,
      maxOutputBytes: 1048576,
    })
    expect(migrated.providers[0]).toMatchObject({
      baseUrl: 'https://legacy.example/v1',
      model: 'legacy-model',
      apiKey: 'legacy-test-key',
      timeout: 12000,
    })
  })

  it('migrates only the v4 default deny list to the v5 approval defaults', () => {
    const legacy = {
      ...agentConfig(),
      version: 4,
      policy: {
        ...agentConfig().policy,
        hardDeny: ['*.uninstall', '*.delete', '*.remove', '*.destroy'],
        defaults: {
          ...agentConfig().policy.defaults,
          destructive: 'deny',
        },
      },
    }
    const migrated = migrateAgentConfig(legacy as never)
    expect(migrated.version).toBe(7)
    expect(migrated.policy.hardDeny).toEqual([])
    expect(migrated.policy.defaults.destructive).toBe('ask')

    const custom = migrateAgentConfig({
      ...legacy,
      policy: {
        ...legacy.policy,
        hardDeny: ['custom.delete'],
        rules: [{ pattern: 'custom.destroy', decision: 'deny' }],
      },
    } as never)
    expect(custom.policy.hardDeny).toEqual(['custom.delete'])
    expect(custom.policy.rules).toEqual([{ pattern: 'custom.destroy', decision: 'deny' }])
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

  it('normalizes and exposes the persisted Provider model discovery cache', () => {
    const migrated = migrateAgentConfig({
      ...agentConfig(),
      providers: [{
        ...agentConfig().providers[0],
        discoveredModels: ['model-z', 'model-a', 'model-z', ''],
        modelsDiscoveredAt: 123456,
      }],
    })

    expect(migrated.providers[0].discoveredModels).toEqual(['model-a', 'model-z'])
    expect(migrated.providers[0].modelsDiscoveredAt).toBe(123456)
    expect(redactAgentConfig(migrated).providers[0]).toMatchObject({
      discoveredModels: ['model-a', 'model-z'],
      modelsDiscoveredAt: 123456,
    })
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
      qqbot: [{ ...current.qqbot[0], clientSecret: '' }],
      whatsapp: [{
        ...current.whatsapp[0],
        accessToken: '',
        appSecret: '',
        verifyToken: '',
      }],
      email: [{
        ...current.email[0],
        imapPassword: '',
        smtpPassword: '',
      }],
    })
    expect(merged.wecom[0].secret).toBe('test-wecom-secret')
    expect(merged.feishu[0].appSecret).toBe('test-feishu-secret')
    expect(merged.telegram[0].botToken).toBe('test-telegram-token')
    expect(merged.qqbot[0].clientSecret).toBe('test-qq-secret')
    expect(merged.whatsapp[0]).toMatchObject({
      accessToken: 'test-whatsapp-access',
      appSecret: 'test-whatsapp-secret',
      verifyToken: 'test-whatsapp-verify',
    })
    expect(merged.email[0]).toMatchObject({
      imapPassword: 'test-imap-password',
      smtpPassword: 'test-smtp-password',
    })
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
    expect(serialized).not.toContain('test-qq-secret')
    expect(serialized).not.toContain('test-whatsapp')
    expect(serialized).not.toContain('test-imap-password')
    expect(serialized).not.toContain('test-smtp-password')
  })
})
