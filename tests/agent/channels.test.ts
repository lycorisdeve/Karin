import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FeishuChannelDriver,
  feishuContentText,
} from '../../packages/core/src/adapter/channels/feishu'
import { TelegramChannelDriver } from '../../packages/core/src/adapter/channels/telegram'
import {
  WeComChannelDriver,
  weComMessageText,
} from '../../packages/core/src/adapter/channels/wecom'

import type { Adapters } from '../../packages/core/src/types/config'

vi.mock('@/service', () => ({
  registerBot: () => 1,
  unregisterBot: () => true,
}))

beforeAll(() => {
  Object.assign(globalThis, {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const telegramConfig = (): Adapters['telegram'][number] => ({
  id: 'telegram-test',
  name: 'Fake Telegram',
  enable: true,
  botToken: 'fake-bot-token',
  apiBase: 'https://telegram.fake',
  pollTimeout: 1,
  allowedUpdates: ['message'],
  trigger: { wakeWords: ['karin'] },
})

const weComConfig = (): Adapters['wecom'][number] => ({
  id: 'wecom-test',
  name: 'Fake WeCom',
  enable: true,
  botId: 'wecom-bot',
  secret: 'fake-wecom-secret',
  wsUrl: 'wss://wecom.fake',
  reconnectInterval: 1000,
  maxReconnectAttempts: 1,
  trigger: { wakeWords: [] },
})

const feishuConfig = (): Adapters['feishu'][number] => ({
  id: 'feishu-test',
  name: 'Fake Feishu',
  enable: true,
  appId: 'fake-app-id',
  appSecret: 'fake-app-secret',
  domain: 'feishu',
  reconnectInterval: 1000,
  maxReconnectAttempts: 1,
  trigger: { wakeWords: [] },
})

const telegramResponse = (result: unknown) =>
  new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'content-type': 'application/json' },
  })

describe('built-in channel protocol adapters', () => {
  it('starts and stops a WeCom account through a Fake official SDK client', async () => {
    class FakeWeComClient extends EventEmitter {
      connect () {
        this.emit('authenticated')
        return this
      }

      disconnect () {
        this.emit('disconnected', 'manual')
      }

      async sendMessage () {
        return { headers: { req_id: 'send-1' } }
      }

      async replyStream () {
        return { headers: { req_id: 'reply-1' } }
      }
    }
    const client = new FakeWeComClient()
    const driver = new WeComChannelDriver(weComConfig(), () => client as never)

    await driver.start(weComConfig())
    expect(driver.status()).toMatchObject({
      state: 'connected',
      botId: 'wecom-bot',
    })
    await driver.stop()
    expect(driver.status().state).toBe('stopped')
  })

  it('starts and stops Feishu with Fake SDK identity, dispatcher and WS clients', async () => {
    const socketOptions: Array<Record<string, unknown>> = []
    const fakeApi = {
      request: async () => ({
        code: 0,
        bot: { open_id: 'feishu-bot-open-id', app_name: 'Fake Feishu' },
      }),
      im: {
        message: {
          create: async () => ({ data: { message_id: 'message-1' } }),
        },
      },
    }
    const dispatcher = {
      register () {
        return this
      },
    }
    const fakeSocket = {
      async start () {
        const ready = socketOptions[0].onReady as (() => void) | undefined
        ready?.()
      },
      close: vi.fn(),
    }
    const driver = new FeishuChannelDriver(feishuConfig(), {
      createApi: () => fakeApi,
      createDispatcher: () => dispatcher,
      createSocket: options => {
        socketOptions.push(options)
        return fakeSocket
      },
    } as never)

    await driver.start(feishuConfig())
    await vi.waitFor(() => expect(driver.status().state).toBe('connected'))
    expect(driver.status().botId).toBe('feishu-bot-open-id')
    await driver.stop()
    expect(fakeSocket.close).toHaveBeenCalledWith({ force: true })
  })

  it('refuses Telegram long polling when a Webhook exists and deletes it only explicitly', async () => {
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const method = String(input).split('/').at(-1) || ''
      methods.push(method)
      if (method === 'getMe') {
        return telegramResponse({ id: 42, username: 'karin_fake_bot' })
      }
      if (method === 'getWebhookInfo') {
        return telegramResponse({ url: 'https://example.test/webhook' })
      }
      if (method === 'deleteWebhook') return telegramResponse(true)
      throw new Error(`unexpected Telegram method: ${method}`)
    }))
    const driver = new TelegramChannelDriver(telegramConfig())

    await driver.start(telegramConfig())
    expect(driver.status()).toMatchObject({
      state: 'webhook-conflict',
      botId: '42',
    })
    expect(methods).not.toContain('getUpdates')
    await expect(driver.deleteWebhook()).resolves.toBe(true)
    expect(methods).toEqual(['getMe', 'getWebhookInfo', 'deleteWebhook'])
    await driver.stop()
  })

  it('probes Telegram identity and polling availability with a Fake Bot API', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const method = String(input).split('/').at(-1)
      if (method === 'getMe') {
        return telegramResponse({ id: 7, username: 'fake_bot' })
      }
      return telegramResponse({ url: '' })
    }))
    const result = await new TelegramChannelDriver(telegramConfig()).probe(telegramConfig())
    expect(result).toMatchObject({ ok: true, botId: '7', name: 'fake_bot' })
  })

  it('normalizes WeCom and Feishu text without inventing unsupported media capabilities', () => {
    expect(weComMessageText({
      msgid: 'm1',
      aibotid: 'bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'mixed',
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: 'hello' } },
          { msgtype: 'image', image: { url: 'https://image.test/a' } },
        ],
      },
    } as never)).toBe('hello[图片: https://image.test/a]')
    expect(feishuContentText('{"text":"hello feishu"}')).toBe('hello feishu')
    expect(feishuContentText('not-json')).toBe('not-json')
  })
})
