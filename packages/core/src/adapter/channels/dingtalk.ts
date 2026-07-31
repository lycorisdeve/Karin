import { DWClient, EventAck, TOPIC_ROBOT } from 'dingtalk-stream'
import { BuiltinChannelAdapter } from './adapter'
import { channelStateStore } from './state'
import { redactSecrets } from './security'
import { resolveChannelImage, saveInboundChannelImage } from './media'
import { segment } from '@/utils/message'
import { contactFriend, contactGroup } from '@/event'

import type { Adapters, Contact, Elements } from '@/types'
import type { ChannelDriver, ChannelProbeResult, ChannelStatus } from './types'
import type { DWClientDownStream } from 'dingtalk-stream'

type DingTalkConfig = Adapters['dingtalk'][number]

interface DingTalkRobotMessage {
  conversationId: string
  conversationType: string
  msgId: string
  msgtype: string
  senderId: string
  senderNick?: string
  senderStaffId?: string
  sessionWebhook: string
  sessionWebhookExpiredTime?: number
  text?: { content?: string }
  content?: { downloadCode?: string }
}

interface DingTalkRoute {
  webhook: string
  expiresAt: number
}

export class DingTalkChannelDriver implements ChannelDriver<DingTalkConfig> {
  readonly kind = 'dingtalk' as const
  readonly capabilities = { text: true, image: true, inboundImage: true }
  private config: DingTalkConfig
  private client: DWClient | null = null
  private bot: BuiltinChannelAdapter | null = null
  private routes = new Map<string, DingTalkRoute>()
  private accessToken = ''
  private accessTokenExpiresAt = 0
  private current: ChannelStatus

  constructor (
    config: DingTalkConfig,
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

  private async webhook (
    route: DingTalkRoute,
    body: Record<string, unknown>
  ) {
    if (route.expiresAt && route.expiresAt <= Date.now()) {
      throw new Error('钉钉会话 Webhook 已过期，请用户先在原会话发送一条消息')
    }
    const response = await this.fetcher(route.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json() as { errcode?: number, errmsg?: string }
    if (!response.ok || Number(data.errcode || 0) !== 0) {
      throw new Error(data.errmsg || `钉钉发送失败: HTTP ${response.status}`)
    }
    return data
  }

  private async token () {
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 60000) {
      return this.accessToken
    }
    const url = new URL('https://oapi.dingtalk.com/gettoken')
    url.searchParams.set('appkey', this.config.clientId)
    url.searchParams.set('appsecret', this.config.clientSecret)
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(15000),
    })
    const data = await response.json() as {
      errcode?: number
      errmsg?: string
      access_token?: string
      expires_in?: number
    }
    if (!response.ok || data.errcode || !data.access_token) {
      throw new Error(data.errmsg || `钉钉认证失败: HTTP ${response.status}`)
    }
    this.accessToken = data.access_token
    this.accessTokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000
    return this.accessToken
  }

  private async uploadImage (source: string) {
    const image = await resolveChannelImage(source, this.fetcher)
    const form = new FormData()
    form.set(
      'media',
      new Blob([Uint8Array.from(image.buffer)], { type: image.mime }),
      image.filename
    )
    const token = await this.token()
    const url = new URL('https://oapi.dingtalk.com/media/upload')
    url.searchParams.set('access_token', token)
    url.searchParams.set('type', 'image')
    const response = await this.fetcher(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json() as {
      errcode?: number
      errmsg?: string
      media_id?: string
    }
    if (!response.ok || data.errcode || !data.media_id) {
      throw new Error(data.errmsg || `钉钉图片上传失败: HTTP ${response.status}`)
    }
    return data.media_id
  }

  private async downloadInboundImage (downloadCode: string) {
    const response = await this.fetcher(
      'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': await this.token(),
        },
        body: JSON.stringify({
          downloadCode,
          robotCode: this.config.robotCode,
        }),
        signal: AbortSignal.timeout(30000),
      }
    )
    const data = await response.json() as { downloadUrl?: string, message?: string }
    if (!response.ok || !data.downloadUrl) {
      throw new Error(data.message || `钉钉图片下载地址获取失败: HTTP ${response.status}`)
    }
    const image = await resolveChannelImage(data.downloadUrl, this.fetcher)
    return saveInboundChannelImage('dingtalk', this.config.id, image.buffer)
  }

  private async send (contact: Contact, elements: Elements[]) {
    const route = this.routes.get(contact.peer)
    if (!route) throw new Error('钉钉会话路由不存在，请用户先在原会话发送一条消息')
    const results: unknown[] = []
    for (const element of elements) {
      if (element.type === 'image') {
        const mediaId = await this.uploadImage(element.file)
        results.push(await this.webhook(route, {
          msgtype: 'markdown',
          markdown: {
            title: '图片',
            text: `![图片](${mediaId})`,
          },
        }))
        continue
      }
      const text = BuiltinChannelAdapter.text([element]).trim()
      if (text) {
        results.push(await this.webhook(route, {
          msgtype: 'text',
          text: { content: text },
        }))
      }
    }
    if (!results.length) throw new Error('钉钉消息没有可发送的内容')
    return {
      messageId: `dingtalk:${Date.now()}`,
      rawData: { messages: results },
    }
  }

  async start (config: DingTalkConfig) {
    this.config = config
    this.current.enabled = config.enable
    if (!config.enable) {
      this.current.state = 'disabled'
      return
    }
    if (!config.clientId || !config.clientSecret) {
      throw new Error('钉钉 ClientID/ClientSecret 未配置')
    }
    this.bot = new BuiltinChannelAdapter(
      this.kind,
      `dingtalk:${config.robotCode || config.clientId}`,
      config.name,
      'wss://api.dingtalk.com',
      (contact, elements) => this.send(contact, elements)
    )
    this.bot.account.subId.channel = config.id
    const client = new DWClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      keepAlive: true,
    })
    this.client = client
    client.registerAllEventListener(message => {
      if (message.headers.topic !== TOPIC_ROBOT) return { status: EventAck.SUCCESS }
      this.receive(message).catch(error => {
        this.current.lastError = redactSecrets(
          error,
          [config.clientSecret]
        )
        logger.error(`[channel][dingtalk:${config.id}] ${this.current.lastError}`)
      })
      return { status: EventAck.SUCCESS }
    })
    this.current.state = 'connecting'
    await client.connect()
    this.current.state = 'connected'
    this.current.botId = config.robotCode || config.clientId
    this.bot.register()
  }

  private async receive (downstream: DWClientDownStream) {
    if (!this.bot) return
    const message = JSON.parse(downstream.data) as DingTalkRobotMessage
    if (!message.msgId) return
    if (await channelStateStore.seen(`dingtalk:${this.config.id}`, message.msgId)) return
    const route = {
      webhook: message.sessionWebhook,
      expiresAt: Number(message.sessionWebhookExpiredTime || 0),
    }
    this.routes.set(message.conversationId, route)
    const elements: Elements[] = []
    if (message.msgtype === 'text' && message.text?.content) {
      elements.push(segment.text(message.text.content.trim()))
    } else if (
      ['picture', 'image'].includes(message.msgtype) &&
      message.content?.downloadCode
    ) {
      elements.push(segment.image(await this.downloadInboundImage(
        message.content.downloadCode
      )))
    } else {
      elements.push(segment.text(`[钉钉 ${message.msgtype} 消息]`))
    }
    this.current.lastInbound = Date.now()
    this.bot.receive({
      eventId: `dingtalk:${message.msgId}`,
      messageId: message.msgId,
      time: Date.now(),
      scene: message.conversationType === '1' ? 'friend' : 'group',
      peerId: message.conversationId,
      userId: message.senderStaffId || message.senderId,
      userName: message.senderNick,
      elements,
      mentioned: message.conversationType !== '1',
      raw: message,
      reply: elements => this.bot!.sendMsg(
        message.conversationType === '1'
          ? contactFriend(message.conversationId, message.senderNick || '')
          : contactGroup(message.conversationId, message.conversationId),
        elements
      ),
    })
  }

  async stop () {
    this.client?.disconnect()
    this.bot?.unregister()
    this.client = null
    this.bot = null
    this.routes.clear()
    this.accessToken = ''
    this.accessTokenExpiresAt = 0
    this.current.state = 'stopped'
  }

  async probe (config: DingTalkConfig): Promise<ChannelProbeResult> {
    if (!config.clientId || !config.clientSecret) {
      throw new Error('钉钉 ClientID/ClientSecret 未配置')
    }
    const started = Date.now()
    const client = new DWClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      keepAlive: false,
    })
    try {
      await client.getAccessToken()
      return {
        ok: true,
        botId: config.robotCode || config.clientId,
        name: config.name,
        latency: Date.now() - started,
      }
    } finally {
      client.disconnect()
    }
  }

  status () {
    return { ...this.current }
  }
}
