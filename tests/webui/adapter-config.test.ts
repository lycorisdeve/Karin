import { describe, expect, it } from 'vitest'
import {
  toAdapterConfig,
  toAdapterFormValues,
  validateAdapterConfig,
} from '../../packages/web/src/components/config/system/adapter-model'

import type { Adapters } from '../../packages/core/src/types/config/adapter'

const createConfig = (): Adapters => ({
  console: {
    isLocal: true,
    token: 'console-token',
    host: 'https://127.0.0.1:7777',
  },
  onebot: {
    ws_server: {
      enable: true,
      timeout: 120,
    },
    ws_client: [{
      enable: true,
      url: 'ws://127.0.0.1:6099',
      token: 'onebot-token',
    }],
    http_server: [{
      enable: true,
      self_id: '10000',
      url: 'http://127.0.0.1:6099',
      token: '',
      api_token: 'api-token',
      post_token: 'post-token',
    }],
  },
  wecom: [],
  feishu: [],
  telegram: [],
})

describe('adapter WebUI model', () => {
  it('round-trips Console host and leaves OneBot unchanged', () => {
    const source = createConfig()
    const result = toAdapterConfig(toAdapterFormValues(source))

    expect(result.console).toEqual(source.console)
    expect(result.onebot).toEqual(source.onebot)
  })

  it('keeps write-only credential semantics out of adapter.json', () => {
    const form = toAdapterFormValues(createConfig())
    form.telegram.push({
      id: 'telegram-main',
      name: 'Telegram',
      enable: true,
      botToken: '',
      botTokenConfigured: true,
      apiBase: 'https://api.telegram.org',
      pollTimeout: 30,
      allowedUpdates: ['message'],
      trigger: { wakeWords: [] },
    })

    const result = toAdapterConfig(form)

    expect(result.telegram[0]).not.toHaveProperty('botTokenConfigured')
    expect(result.telegram[0].botToken).toBe('')
  })

  it('rejects duplicate stable IDs before save', () => {
    const form = toAdapterFormValues(createConfig())
    form.wecom = [
      {
        id: 'same',
        name: 'A',
        enable: false,
        botId: '',
        secret: '',
        wsUrl: '',
        reconnectInterval: 5000,
        maxReconnectAttempts: 20,
        trigger: { wakeWords: [] },
      },
      {
        id: 'same',
        name: 'B',
        enable: false,
        botId: '',
        secret: '',
        wsUrl: '',
        reconnectInterval: 5000,
        maxReconnectAttempts: 20,
        trigger: { wakeWords: [] },
      },
    ]

    expect(validateAdapterConfig(form)).toContain('重复')
  })

  it('accepts an enabled account when its secret is already configured', () => {
    const form = toAdapterFormValues(createConfig())
    form.feishu.push({
      id: 'feishu-main',
      name: '飞书',
      enable: true,
      appId: 'app-id',
      appSecret: '',
      appSecretConfigured: true,
      domain: 'feishu',
      reconnectInterval: 5000,
      maxReconnectAttempts: 20,
      trigger: { wakeWords: [] },
    })

    expect(validateAdapterConfig(form)).toBe('')
  })
})
