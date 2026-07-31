import { BuiltinChannelAdapter } from './adapter'
import { channelStateStore } from './state'
import { redactSecrets } from './security'
import { resolveChannelImage, saveInboundChannelImage } from './media'
import { segment } from '@/utils/message'

import type { Adapters, Contact, Elements } from '@/types'
import type { ChannelDriver, ChannelProbeResult, ChannelStatus } from './types'

type WeChatConfig = Adapters['wechat'][number]

interface WeChatPadMessage {
  MsgId?: string | number
  NewMsgId?: string | number
  MsgType?: number
  Content?: string
  FromUserName?: string
  ToUserName?: string
  PushContent?: string
  ImageBase64?: string
  ImgBuf?: string
}

export class WeChatChannelDriver implements ChannelDriver<WeChatConfig> {
  readonly kind = 'wechat' as const
  readonly capabilities = { text: true, image: true, inboundImage: true }
  private config: WeChatConfig
  private bot: BuiltinChannelAdapter | null = null
  private abort: AbortController | null = null
  private current: ChannelStatus
  private wxid = ''

  constructor (
    config: WeChatConfig,
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
    config: WeChatConfig,
    path: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<T> {
    const response = await this.fetcher(`${config.serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
        'x-token': config.token,
      },
      body: JSON.stringify(body),
      signal,
    })
    const data = await response.json() as {
      Code?: number
      code?: number
      Success?: boolean
      Data?: T
      data?: T
      Text?: string
      message?: string
    }
    const code = Number(data.Code ?? data.code ?? 0)
    if (!response.ok || code >= 400 || data.Success === false) {
      throw new Error(data.Text || data.message || `WeChatPadPro 请求失败: HTTP ${response.status}`)
    }
    return (data.Data ?? data.data ?? data) as T
  }

  async start (config: WeChatConfig) {
    this.config = config
    this.current.enabled = config.enable
    if (!config.enable) {
      this.current.state = 'disabled'
      return
    }
    if (!config.serverUrl || !config.token) throw new Error('WeChatPadPro 地址或 Token 未配置')
    const identity = await this.call<{ wxid?: string, Wxid?: string }>(
      config,
      '/login/GetLoginStatus'
    )
    this.wxid = identity.wxid || identity.Wxid || config.id
    this.bot = new BuiltinChannelAdapter(
      this.kind,
      `wechat:${this.wxid}`,
      config.name,
      config.serverUrl,
      async (contact: Contact, elements: Elements[]) => {
        const results: unknown[] = []
        for (const element of elements) {
          if (element.type === 'image') {
            const image = await resolveChannelImage(element.file, this.fetcher)
            results.push(await this.call(config, '/message/SendImageNewMessage', {
              ToUserName: contact.peer,
              Base64: image.buffer.toString('base64'),
            }))
            continue
          }
          const text = BuiltinChannelAdapter.text([element]).trim()
          if (text) {
            results.push(await this.call(config, '/message/SendTextMessage', {
              ToUserName: contact.peer,
              Content: text,
            }))
          }
        }
        if (!results.length) throw new Error('微信消息没有可发送的内容')
        return {
          messageId: String((results.at(-1) as { MsgId?: unknown })?.MsgId || Date.now()),
          rawData: { messages: results },
        }
      }
    )
    this.bot.account.subId.channel = config.id
    this.bot.register()
    this.current.state = 'connected'
    this.current.botId = this.wxid
    this.abort = new AbortController()
    this.poll(this.abort.signal)
  }

  private async receive (message: WeChatPadMessage) {
    if (!this.bot) return
    const messageId = String(message.NewMsgId || message.MsgId || '')
    if (!messageId || await channelStateStore.seen(`wechat:${this.config.id}`, messageId)) return
    const from = String(message.FromUserName || '')
    if (!from || from === this.wxid) return
    const group = from.endsWith('@chatroom')
    const elements: Elements[] = []
    if (message.MsgType === 1 && message.Content) elements.push(segment.text(message.Content))
    if (message.MsgType === 3) {
      const encoded = message.ImageBase64 || message.ImgBuf || ''
      if (encoded) {
        elements.push(segment.image(await saveInboundChannelImage(
          'wechat',
          this.config.id,
          Buffer.from(encoded, 'base64')
        )))
      } else {
        elements.push(segment.text('[微信图片暂时无法下载]'))
      }
    }
    if (!elements.length) return
    this.current.lastInbound = Date.now()
    this.bot.receive({
      eventId: `wechat:${messageId}`,
      messageId,
      time: Date.now(),
      scene: group ? 'group' : 'friend',
      peerId: from,
      userId: group
        ? String(message.PushContent || '').split(':')[0] || from
        : from,
      elements,
      mentioned: group && Boolean(message.Content?.includes(`@${this.wxid}`)),
      raw: message,
    })
  }

  private async poll (signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const result = await this.call<WeChatPadMessage[] | { AddMsgs?: WeChatPadMessage[] }>(
          this.config,
          '/message/HttpSyncMsg',
          { Wxid: this.wxid },
          signal
        )
        const messages = Array.isArray(result) ? result : result.AddMsgs || []
        for (const message of messages) await this.receive(message)
        this.current.state = 'connected'
      } catch (error) {
        if (signal.aborted) return
        this.current.state = 'error'
        this.current.reconnects += 1
        this.current.lastError = redactSecrets(error, [this.config.token])
      }
      await new Promise(resolve => setTimeout(resolve, this.config.pollInterval))
    }
  }

  async stop () {
    this.abort?.abort()
    this.bot?.unregister()
    this.abort = null
    this.bot = null
    this.current.state = 'stopped'
  }

  async probe (config: WeChatConfig): Promise<ChannelProbeResult> {
    const started = Date.now()
    const result = await this.call<{ wxid?: string, Wxid?: string }>(
      config,
      '/login/GetLoginStatus'
    )
    const wxid = result.wxid || result.Wxid || ''
    return {
      ok: Boolean(wxid),
      botId: wxid,
      name: config.name,
      latency: Date.now() - started,
      detail: 'WeChatPadPro 为第三方逆向协议，存在封号与兼容性风险',
    }
  }

  status () {
    return { ...this.current }
  }
}
