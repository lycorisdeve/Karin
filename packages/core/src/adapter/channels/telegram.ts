import { BuiltinChannelAdapter } from './adapter'
import { channelStateStore } from './state'
import { redactSecrets } from './security'
import { resolveChannelImage, saveInboundChannelImage } from './media'
import { segment } from '@/utils/message'

import type { Adapters, Contact, Elements } from '@/types'
import type { ChannelDriver, ChannelProbeResult, ChannelStatus } from './types'

type TelegramConfig = Adapters['telegram'][number]

interface TelegramUser {
  id: number
  first_name?: string
  username?: string
}

interface TelegramMessage {
  message_id: number
  date: number
  text?: string
  caption?: string
  from?: TelegramUser
  chat: {
    id: number
    type: 'private' | 'group' | 'supergroup' | 'channel'
    title?: string
  }
  entities?: Array<{ type: string, offset: number, length: number, user?: TelegramUser }>
  reply_to_message?: { message_id: number }
  photo?: Array<{ file_id: string }>
  document?: { file_id: string, file_name?: string }
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramResponse<T> {
  ok: boolean
  result: T
  description?: string
}

export class TelegramChannelDriver implements ChannelDriver<TelegramConfig> {
  readonly kind = 'telegram' as const
  private config: TelegramConfig
  private bot: BuiltinChannelAdapter | null = null
  private abort: AbortController | null = null
  private me: TelegramUser | null = null
  private current: ChannelStatus

  constructor (
    config: TelegramConfig,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.config = config
    this.current = {
      kind: this.kind,
      id: config.id,
      name: config.name,
      enabled: config.enable,
      state: config.enable ? 'connecting' : 'disabled',
      botId: '',
      lastInbound: null,
      lastError: '',
      reconnects: 0,
    }
  }

  private async call<T>(
    config: TelegramConfig,
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal
  ) {
    const response = await this.fetcher(
      `${config.apiBase}/bot${config.botToken}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal,
      }
    )
    const data = await response.json() as TelegramResponse<T>
    if (!response.ok || !data.ok) {
      throw new Error(data.description || `Telegram ${method} 失败: HTTP ${response.status}`)
    }
    return data.result
  }

  private async callForm<T>(
    config: TelegramConfig,
    method: string,
    body: FormData,
    signal?: AbortSignal
  ) {
    const response = await this.fetcher(
      `${config.apiBase}/bot${config.botToken}/${method}`,
      { method: 'POST', body, signal }
    )
    const data = await response.json() as TelegramResponse<T>
    if (!response.ok || !data.ok) {
      throw new Error(data.description || `Telegram ${method} 失败: HTTP ${response.status}`)
    }
    return data.result
  }

  async start (config: TelegramConfig) {
    this.config = config
    this.current.enabled = config.enable
    if (!config.enable) {
      this.current.state = 'disabled'
      return
    }
    if (!config.botToken) throw new Error('Telegram botToken 未配置')
    this.current.state = 'connecting'
    const me = await this.call<TelegramUser>(config, 'getMe')
    const webhook = await this.call<{ url?: string }>(config, 'getWebhookInfo')
    this.me = me
    this.current.botId = String(me.id)
    if (webhook.url) {
      this.current.state = 'webhook-conflict'
      this.current.lastError = '已配置 Webhook，必须显式删除后才能启用 long polling'
      return
    }
    this.bot = new BuiltinChannelAdapter(
      this.kind,
      String(me.id),
      config.name || me.username || String(me.id),
      config.apiBase,
      async (contact: Contact, elements: Elements[]) => {
        const results: TelegramMessage[] = []
        for (const element of elements) {
          if (element.type === 'image') {
            const image = await resolveChannelImage(element.file, this.fetcher)
            const form = new FormData()
            form.set('chat_id', contact.peer)
            form.set(
              'photo',
              new Blob([Uint8Array.from(image.buffer)], { type: image.mime }),
              image.filename
            )
            results.push(await this.callForm<TelegramMessage>(config, 'sendPhoto', form))
            continue
          }
          const text = BuiltinChannelAdapter.text([element]).trim()
          if (text) {
            results.push(await this.call<TelegramMessage>(config, 'sendMessage', {
              chat_id: contact.peer,
              text,
            }))
          }
        }
        const result = results.at(-1)
        if (!result) throw new Error('Telegram 消息没有可发送的内容')
        return {
          messageId: String(result.message_id),
          rawData: { messages: results },
        }
      }
    )
    this.bot.account.subId.channel = config.id
    this.bot.register()
    this.current.state = 'connected'
    this.current.lastError = ''
    this.abort = new AbortController()
    this.poll(this.abort.signal)
  }

  private mentioned (message: TelegramMessage) {
    if (message.chat.type === 'private') return false
    const username = this.me?.username?.toLowerCase()
    if (!username) return false
    return (message.entities || []).some(entity => {
      if (entity.type === 'text_mention') return String(entity.user?.id) === String(this.me?.id)
      if (entity.type !== 'mention') return false
      const source = message.text || message.caption || ''
      return source.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username}`
    })
  }

  private messageText (message: TelegramMessage) {
    if (message.text) return message.text
    if (message.caption) return message.caption
    if (message.photo?.length) return `[图片: ${message.photo.at(-1)?.file_id}]`
    if (message.document) return `[文件: ${message.document.file_name || message.document.file_id}]`
    return '[暂不支持的 Telegram 消息类型]'
  }

  private async messageElements (message: TelegramMessage): Promise<Elements[]> {
    const elements: Elements[] = []
    const text = message.text || message.caption || ''
    if (text) elements.push(segment.text(text))
    const photo = message.photo?.at(-1)
    if (photo?.file_id) {
      const file = await this.call<{ file_path?: string }>(
        this.config,
        'getFile',
        { file_id: photo.file_id }
      )
      if (!file.file_path) throw new Error('Telegram 图片缺少 file_path')
      const response = await this.fetcher(
        `${this.config.apiBase}/file/bot${this.config.botToken}/${file.file_path}`,
        { signal: AbortSignal.timeout(30_000) }
      )
      if (!response.ok) throw new Error(`Telegram 图片下载失败: HTTP ${response.status}`)
      const filename = await saveInboundChannelImage(
        'telegram',
        this.config.id,
        Buffer.from(await response.arrayBuffer())
      )
      elements.push(segment.image(filename))
    }
    if (!elements.length) elements.push(segment.text(this.messageText(message)))
    return elements
  }

  private async receive (update: TelegramUpdate) {
    const message = update.message
    if (!message || !this.bot) return
    const eventId = String(update.update_id)
    if (await channelStateStore.seen(`telegram:${this.config.id}`, eventId)) return
    const group = message.chat.type !== 'private'
    const user = message.from
    this.current.lastInbound = Date.now()
    this.bot.receive({
      eventId: `telegram:${eventId}`,
      messageId: String(message.message_id),
      time: message.date * 1000,
      scene: group ? 'group' : 'friend',
      peerId: String(message.chat.id),
      userId: String(user?.id || message.chat.id),
      userName: user?.username || user?.first_name || '',
      contactName: message.chat.title || user?.username || user?.first_name || '',
      elements: await this.messageElements(message),
      mentioned: this.mentioned(message),
      replyMessageId: message.reply_to_message
        ? String(message.reply_to_message.message_id)
        : undefined,
      raw: update,
    })
  }

  private async poll (signal: AbortSignal) {
    let offset = await channelStateStore.offset(`telegram:${this.config.id}`)
    while (!signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>(
          this.config,
          'getUpdates',
          {
            offset,
            timeout: this.config.pollTimeout,
            allowed_updates: this.config.allowedUpdates,
          },
          signal
        )
        for (const update of updates) {
          await this.receive(update)
          offset = Math.max(offset, update.update_id + 1)
          await channelStateStore.setOffset(`telegram:${this.config.id}`, offset)
        }
      } catch (error) {
        if (signal.aborted) return
        this.current.state = 'error'
        this.current.reconnects += 1
        this.current.lastError = redactSecrets(error, [this.config.botToken])
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * this.current.reconnects, 10000)))
        if (!signal.aborted) this.current.state = 'connecting'
      }
    }
  }

  async deleteWebhook (dropPendingUpdates = false) {
    const result = await this.call<boolean>(this.config, 'deleteWebhook', {
      drop_pending_updates: dropPendingUpdates,
    })
    if (result) this.current.lastError = ''
    return result
  }

  async stop () {
    this.abort?.abort()
    this.bot?.unregister()
    this.abort = null
    this.bot = null
    this.current.state = 'stopped'
  }

  async probe (config: TelegramConfig): Promise<ChannelProbeResult> {
    if (!config.botToken) throw new Error('Telegram botToken 未配置')
    const started = Date.now()
    const me = await this.call<TelegramUser>(config, 'getMe')
    const webhook = await this.call<{ url?: string }>(config, 'getWebhookInfo')
    return {
      ok: !webhook.url,
      botId: String(me.id),
      name: me.username || me.first_name || config.name,
      latency: Date.now() - started,
      detail: webhook.url ? '已配置 Webhook，long polling 不可用' : undefined,
    }
  }

  status () {
    return { ...this.current }
  }
}
