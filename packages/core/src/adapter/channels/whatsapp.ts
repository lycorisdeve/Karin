import { BuiltinChannelAdapter } from './adapter'
import { channelStateStore } from './state'
import { redactSecrets } from './security'
import { resolveChannelImage, saveInboundChannelImage } from './media'
import { segment } from '@/utils/message'

import type { Adapters, Contact, Elements } from '@/types'
import type { ChannelDriver, ChannelProbeResult, ChannelStatus } from './types'

type WhatsAppConfig = Adapters['whatsapp'][number]

interface WhatsAppMessage {
  id: string
  from: string
  timestamp?: string
  type: string
  text?: { body?: string }
  image?: { id?: string, caption?: string, mime_type?: string }
}

export class WhatsAppChannelDriver implements ChannelDriver<WhatsAppConfig> {
  readonly kind = 'whatsapp' as const
  readonly capabilities = { text: true, image: true, inboundImage: true }
  private config: WhatsAppConfig
  private bot: BuiltinChannelAdapter | null = null
  private current: ChannelStatus

  constructor (
    config: WhatsAppConfig,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.config = config
    this.current = {
      kind: this.kind,
      id: config.id,
      name: config.name,
      enabled: config.enable,
      state: config.enable ? 'connecting' : 'disabled',
      botId: config.phoneNumberId,
      lastInbound: null,
      lastError: '',
      reconnects: 0,
    }
  }

  private graphUrl (path: string) {
    return `https://graph.facebook.com/${this.config.graphVersion}/${path}`
  }

  private async graph<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const response = await this.fetcher(this.graphUrl(path), {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        ...init.headers,
      },
      signal: init.signal || AbortSignal.timeout(30000),
    })
    const data = await response.json() as T & {
      error?: { message?: string }
    }
    if (!response.ok) {
      throw new Error(data.error?.message || `WhatsApp API 失败: HTTP ${response.status}`)
    }
    return data
  }

  private async uploadImage (source: string) {
    const image = await resolveChannelImage(source, this.fetcher)
    const form = new FormData()
    form.set('messaging_product', 'whatsapp')
    form.set(
      'file',
      new Blob([Uint8Array.from(image.buffer)], { type: image.mime }),
      image.filename
    )
    const result = await this.graph<{ id: string }>(
      `${this.config.phoneNumberId}/media`,
      { method: 'POST', body: form }
    )
    return result.id
  }

  private async send (contact: Contact, elements: Elements[]) {
    const messages: unknown[] = []
    for (const element of elements) {
      let payload: Record<string, unknown> | null = null
      if (element.type === 'image') {
        payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: contact.peer,
          type: 'image',
          image: { id: await this.uploadImage(element.file) },
        }
      } else {
        const text = BuiltinChannelAdapter.text([element]).trim()
        if (text) {
          payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: contact.peer,
            type: 'text',
            text: { body: text, preview_url: false },
          }
        }
      }
      if (!payload) continue
      messages.push(await this.graph<{ messages?: Array<{ id: string }> }>(
        `${this.config.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }
      ))
    }
    const result = messages.at(-1) as { messages?: Array<{ id: string }> } | undefined
    const messageId = result?.messages?.[0]?.id
    if (!messageId) throw new Error('WhatsApp 消息没有可发送的内容')
    return { messageId, rawData: { messages } }
  }

  async start (config: WhatsAppConfig) {
    this.config = config
    this.current.enabled = config.enable
    if (!config.enable) {
      this.current.state = 'disabled'
      return
    }
    if (!config.phoneNumberId || !config.accessToken || !config.appSecret) {
      throw new Error('WhatsApp Phone Number ID、Access Token 或 App Secret 未配置')
    }
    this.bot = new BuiltinChannelAdapter(
      this.kind,
      `whatsapp:${config.phoneNumberId}`,
      config.name,
      'https://graph.facebook.com',
      (contact, elements) => this.send(contact, elements)
    )
    this.bot.account.subId.channel = config.id
    this.bot.register()
    this.current.state = 'connected'
    this.current.botId = config.phoneNumberId
  }

  async receiveWebhook (payload: any) {
    if (!this.bot) return
    const changes = payload?.entry?.flatMap((entry: any) => entry.changes || []) || []
    for (const change of changes) {
      const value = change.value
      const contacts = new Map<string, string>(
        (value?.contacts || []).map((contact: any) => [
          String(contact.wa_id),
          String(contact.profile?.name || ''),
        ])
      )
      for (const message of (value?.messages || []) as WhatsAppMessage[]) {
        if (!message.id || await channelStateStore.seen(
          `whatsapp:${this.config.id}`,
          message.id
        )) continue
        const elements: Elements[] = []
        if (message.type === 'text' && message.text?.body) {
          elements.push(segment.text(message.text.body))
        }
        if (message.type === 'image' && message.image?.id) {
          if (message.image.caption) elements.push(segment.text(message.image.caption))
          const meta = await this.graph<{ url: string }>(message.image.id)
          const response = await this.fetcher(meta.url, {
            headers: { authorization: `Bearer ${this.config.accessToken}` },
            signal: AbortSignal.timeout(30000),
          })
          if (!response.ok) throw new Error(`WhatsApp 图片下载失败: HTTP ${response.status}`)
          const buffer = Buffer.from(await response.arrayBuffer())
          elements.push(segment.image(await saveInboundChannelImage(
            'whatsapp',
            this.config.id,
            buffer
          )))
        }
        if (!elements.length) continue
        this.current.lastInbound = Date.now()
        this.bot.receive({
          eventId: `whatsapp:${message.id}`,
          messageId: message.id,
          time: Number(message.timestamp || 0) * 1000 || Date.now(),
          scene: 'friend',
          peerId: message.from,
          userId: message.from,
          userName: contacts.get(message.from),
          elements,
          raw: message,
        })
      }
    }
  }

  async stop () {
    this.bot?.unregister()
    this.bot = null
    this.current.state = 'stopped'
  }

  async probe (config: WhatsAppConfig): Promise<ChannelProbeResult> {
    this.config = config
    const started = Date.now()
    const result = await this.graph<{ id: string, display_phone_number?: string }>(
      `${config.phoneNumberId}?fields=id,display_phone_number`
    )
    return {
      ok: result.id === config.phoneNumberId,
      botId: result.id,
      name: result.display_phone_number || config.name,
      latency: Date.now() - started,
      detail: 'WhatsApp Cloud API 第一版仅支持官方私聊场景',
    }
  }

  status () {
    return { ...this.current }
  }

  reportWebhookError (error: unknown) {
    this.current.lastError = redactSecrets(
      error,
      [this.config.accessToken, this.config.appSecret, this.config.verifyToken]
    )
  }
}
