import WebSocket from 'ws'
import { BuiltinChannelAdapter } from './adapter'
import { channelStateStore } from './state'
import { redactSecrets } from './security'
import { resolveChannelImage, saveInboundChannelImage } from './media'
import { segment } from '@/utils/message'

import type { Adapters, Contact, Elements } from '@/types'
import type { ChannelDriver, ChannelProbeResult, ChannelStatus } from './types'

type QQBotConfig = Adapters['qqbot'][number]

interface QQGatewayPayload {
  op: number
  s?: number
  t?: string
  d?: any
}

export class QQBotChannelDriver implements ChannelDriver<QQBotConfig> {
  readonly kind = 'qqbot' as const
  readonly capabilities = { text: true, image: true, inboundImage: true }
  private config: QQBotConfig
  private socket: WebSocket | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private bot: BuiltinChannelAdapter | null = null
  private accessToken = ''
  private sequence: number | null = null
  private current: ChannelStatus

  constructor (
    config: QQBotConfig,
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

  private async token (config: QQBotConfig) {
    const response = await this.fetcher('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await response.json() as { access_token?: string, message?: string }
    if (!response.ok || !data.access_token) {
      throw new Error(data.message || `QQBot 认证失败: HTTP ${response.status}`)
    }
    return data.access_token
  }

  private async api<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const response = await this.fetcher(`${this.config.apiBase}${path}`, {
      method,
      headers: {
        authorization: `QQBot ${this.accessToken}`,
        'x-union-appid': this.config.appId,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json() as T & { message?: string }
    if (!response.ok) throw new Error(data.message || `QQBot API 失败: HTTP ${response.status}`)
    return data
  }

  private target (contact: Contact) {
    const [kind, ...rest] = contact.peer.split(':')
    return { kind, id: rest.join(':') }
  }

  private async apiForm<T>(
    path: string,
    image: Buffer,
    filename: string,
    mime: string
  ): Promise<T> {
    const form = new FormData()
    form.set(
      'file_image',
      new Blob([Uint8Array.from(image)], { type: mime }),
      filename
    )
    const response = await this.fetcher(`${this.config.apiBase}${path}`, {
      method: 'POST',
      headers: {
        authorization: `QQBot ${this.accessToken}`,
        'x-union-appid': this.config.appId,
      },
      body: form,
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json() as T & { message?: string }
    if (!response.ok) throw new Error(data.message || `QQBot API 失败: HTTP ${response.status}`)
    return data
  }

  private async send (contact: Contact, elements: Elements[]) {
    const target = this.target(contact)
    const path = target.kind === 'c2c'
      ? `/v2/users/${encodeURIComponent(target.id)}/messages`
      : target.kind === 'group'
        ? `/v2/groups/${encodeURIComponent(target.id)}/messages`
        : `/channels/${encodeURIComponent(target.id)}/messages`
    const results: unknown[] = []
    let sequence = 1
    for (const element of elements) {
      if (element.type === 'image') {
        const image = await resolveChannelImage(element.file, this.fetcher)
        if (target.kind === 'channel') {
          results.push(await this.apiForm(path, image.buffer, image.filename, image.mime))
        } else {
          const uploadPath = target.kind === 'c2c'
            ? `/v2/users/${encodeURIComponent(target.id)}/files`
            : `/v2/groups/${encodeURIComponent(target.id)}/files`
          const uploaded = await this.api<{ file_info: string }>('POST', uploadPath, {
            file_type: 1,
            file_data: image.buffer.toString('base64'),
            srv_send_msg: false,
          })
          results.push(await this.api('POST', path, {
            msg_type: 7,
            media: { file_info: uploaded.file_info },
            msg_seq: sequence++,
          }))
        }
        continue
      }
      const text = BuiltinChannelAdapter.text([element]).trim()
      if (!text) continue
      results.push(await this.api('POST', path, target.kind === 'channel'
        ? { content: text }
        : { content: text, msg_type: 0, msg_seq: sequence++ }))
    }
    const result = results.at(-1) as { id?: string } | undefined
    if (!result) throw new Error('QQBot 消息没有可发送的内容')
    return { messageId: result.id || String(Date.now()), rawData: { messages: results } }
  }

  async start (config: QQBotConfig) {
    this.config = config
    this.current.enabled = config.enable
    if (!config.enable) {
      this.current.state = 'disabled'
      return
    }
    if (!config.appId || !config.clientSecret) throw new Error('QQBot AppID/ClientSecret 未配置')
    this.accessToken = await this.token(config)
    const gateway = config.gatewayUrl || (await this.api<{ url: string }>('GET', '/gateway')).url
    this.bot = new BuiltinChannelAdapter(
      this.kind,
      `qqbot:${config.appId}`,
      config.name,
      gateway,
      (contact, elements) => this.send(contact, elements)
    )
    this.bot.account.subId.channel = config.id
    this.current.state = 'connecting'
    const socket = new WebSocket(gateway)
    this.socket = socket
    socket.on('message', data => this.onPayload(JSON.parse(data.toString()) as QQGatewayPayload))
    socket.on('close', () => {
      if (this.current.state !== 'stopped') this.current.state = 'error'
      this.bot?.unregister()
    })
    socket.on('error', error => {
      this.current.state = 'error'
      this.current.lastError = redactSecrets(error, [config.clientSecret, this.accessToken])
    })
  }

  private onPayload (payload: QQGatewayPayload) {
    if (typeof payload.s === 'number') this.sequence = payload.s
    if (payload.op === 10) {
      const interval = Number(payload.d?.heartbeat_interval || 45000)
      this.socket?.send(JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${this.accessToken}`,
          intents: (1 << 30) | (1 << 25) | (1 << 12) | (1 << 10),
          shard: [0, 1],
        },
      }))
      this.heartbeat = setInterval(() => {
        this.socket?.send(JSON.stringify({ op: 1, d: this.sequence }))
      }, interval)
      this.current.state = 'connected'
      this.current.botId = this.config.appId
      this.bot?.register()
      return
    }
    if (payload.op === 0) {
      this.receive(payload).catch(error => {
        this.current.lastError = redactSecrets(error, [this.config.clientSecret, this.accessToken])
      })
    }
  }

  private async receive (payload: QQGatewayPayload) {
    if (!this.bot || !payload.t || !payload.d?.id) return
    const data = payload.d
    if (await channelStateStore.seen(`qqbot:${this.config.id}`, String(data.id))) return
    const c2c = payload.t === 'C2C_MESSAGE_CREATE'
    const group = payload.t === 'GROUP_AT_MESSAGE_CREATE'
    const channel = payload.t === 'AT_MESSAGE_CREATE' || payload.t === 'DIRECT_MESSAGE_CREATE'
    if (!c2c && !group && !channel) return
    const elements: Elements[] = []
    if (data.content) elements.push(segment.text(String(data.content).trim()))
    for (const attachment of data.attachments || []) {
      if (!String(attachment.content_type || '').startsWith('image/')) continue
      const image = await resolveChannelImage(String(attachment.url), this.fetcher)
      elements.push(segment.image(await saveInboundChannelImage(
        'qqbot',
        this.config.id,
        image.buffer
      )))
    }
    if (!elements.length) return
    const peerId = c2c
      ? `c2c:${data.author?.user_openid || data.author?.id}`
      : group
        ? `group:${data.group_openid}`
        : `channel:${data.channel_id}`
    this.current.lastInbound = Date.now()
    this.bot.receive({
      eventId: `qqbot:${data.id}`,
      messageId: String(data.id),
      time: Number(data.timestamp ? Date.parse(data.timestamp) : Date.now()),
      scene: c2c ? 'friend' : 'group',
      peerId,
      userId: String(data.author?.member_openid || data.author?.user_openid || data.author?.id),
      userName: String(data.author?.username || data.author?.nick || ''),
      contactName: String(data.group_openid || data.channel_id || ''),
      elements,
      mentioned: !c2c,
      raw: payload,
    })
  }

  async stop () {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.socket?.close()
    this.bot?.unregister()
    this.socket = null
    this.bot = null
    this.sequence = null
    this.current.state = 'stopped'
  }

  async probe (config: QQBotConfig): Promise<ChannelProbeResult> {
    const started = Date.now()
    this.config = config
    this.accessToken = await this.token(config)
    const gateway = config.gatewayUrl || (await this.api<{ url: string }>('GET', '/gateway')).url
    return {
      ok: Boolean(gateway),
      botId: config.appId,
      name: config.name,
      latency: Date.now() - started,
      detail: gateway,
    }
  }

  status () {
    return { ...this.current }
  }
}
