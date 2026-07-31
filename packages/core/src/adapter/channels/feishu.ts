import { Client, Domain, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk'
import { BuiltinChannelAdapter } from './adapter'
import { channelStateStore } from './state'
import { redactSecrets } from './security'
import {
  readableToBuffer,
  resolveChannelImage,
  saveInboundChannelImage,
} from './media'
import { segment } from '@/utils/message'

import type { Adapters, Contact, Elements } from '@/types'
import type { ChannelDriver, ChannelProbeResult, ChannelStatus } from './types'

type FeishuConfig = Adapters['feishu'][number]

interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string
      user_id?: string
    }
  }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    create_time?: string
    content?: string
    mentions?: Array<{ id?: { open_id?: string }, name?: string }>
    parent_id?: string
    message_type?: string
  }
}

interface FeishuBotInfo {
  code?: number
  msg?: string
  bot?: {
    open_id?: string
    app_name?: string
  }
}

interface FeishuDependencies {
  createApi: (options: ConstructorParameters<typeof Client>[0]) => Client
  createSocket: (options: ConstructorParameters<typeof WSClient>[0]) => WSClient
  createDispatcher: () => EventDispatcher
}

const defaultDependencies: FeishuDependencies = {
  createApi: options => new Client(options),
  createSocket: options => new WSClient(options),
  createDispatcher: () => new EventDispatcher({}),
}

export const feishuContentText = (content = '') => {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    return parsed.text || content
  } catch {
    return content
  }
}

export class FeishuChannelDriver implements ChannelDriver<FeishuConfig> {
  readonly kind = 'feishu' as const
  private socket: WSClient | null = null
  private api: Client | null = null
  private bot: BuiltinChannelAdapter | null = null
  private botOpenId = ''
  private config: FeishuConfig
  private current: ChannelStatus

  constructor (
    config: FeishuConfig,
    private readonly dependencies: FeishuDependencies = defaultDependencies
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

  private domain (config: FeishuConfig) {
    return config.domain === 'lark' ? Domain.Lark : Domain.Feishu
  }

  async start (config: FeishuConfig) {
    this.config = config
    this.current.enabled = config.enable
    if (!config.enable) {
      this.current.state = 'disabled'
      return
    }
    if (!config.appId || !config.appSecret) throw new Error('飞书 appId/appSecret 未配置')
    const domain = this.domain(config)
    const api = this.dependencies.createApi({
      appId: config.appId,
      appSecret: config.appSecret,
      domain,
    })
    this.api = api
    const identity = await api.request<FeishuBotInfo>({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    })
    if (identity.code) throw new Error(identity.msg || `飞书 Bot 身份查询失败: ${identity.code}`)
    this.botOpenId = identity.bot?.open_id || config.appId
    this.bot = new BuiltinChannelAdapter(
      this.kind,
      this.botOpenId,
      config.name || identity.bot?.app_name || config.appId,
      config.domain,
      async (contact: Contact, elements: Elements[]) => {
        const results: unknown[] = []
        for (const element of elements) {
          if (element.type === 'image') {
            const image = await resolveChannelImage(element.file)
            const uploaded = await api.im.image.create({
              data: { image_type: 'message', image: image.buffer },
            })
            if (!uploaded?.image_key) throw new Error('飞书图片上传未返回 image_key')
            results.push(await api.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: contact.peer,
                content: JSON.stringify({ image_key: uploaded.image_key }),
                msg_type: 'image',
              },
            }))
            continue
          }
          const text = BuiltinChannelAdapter.text([element]).trim()
          if (text) {
            results.push(await api.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: contact.peer,
                content: JSON.stringify({ text }),
                msg_type: 'text',
              },
            }))
          }
        }
        const result = results.at(-1) as {
          data?: { message_id?: string }
        } | undefined
        if (!result) throw new Error('飞书消息没有可发送的内容')
        return {
          messageId: result.data?.message_id || '',
          rawData: { messages: results },
        }
      }
    )
    this.bot.account.subId.channel = config.id
    const dispatcher = this.dependencies.createDispatcher().register({
      'im.message.receive_v1': async data => {
        this.receive(data).catch(error => {
          logger.error(
            `[channel][feishu:${config.id}] 消息处理失败: ${
              redactSecrets(error, [config.appSecret])
            }`
          )
        })
        return {}
      },
    })
    const socket = this.dependencies.createSocket({
      appId: config.appId,
      appSecret: config.appSecret,
      domain,
      autoReconnect: true,
      onReady: () => {
        this.current.state = 'connected'
        this.current.botId = this.botOpenId
        this.current.lastError = ''
        this.bot?.register()
      },
      onReconnecting: () => {
        this.current.state = 'connecting'
        this.current.reconnects += 1
      },
      onReconnected: () => {
        this.current.state = 'connected'
      },
      onError: error => {
        this.current.state = 'error'
        this.current.lastError = redactSecrets(error, [config.appSecret])
      },
    })
    this.socket = socket
    this.current.state = 'connecting'
    socket.start({ eventDispatcher: dispatcher }).catch(error => {
      this.current.state = 'error'
      this.current.lastError = redactSecrets(error, [config.appSecret])
      logger.error(`[channel][feishu:${config.id}] ${this.current.lastError}`)
    })
  }

  private async messageElements (message: NonNullable<FeishuMessageEvent['message']>) {
    if (message.message_type !== 'image') {
      return [segment.text(feishuContentText(message.content))]
    }
    const content = JSON.parse(message.content || '{}') as { image_key?: string }
    if (!content.image_key || !message.message_id || !this.api) {
      return [segment.text('[飞书图片无法获取]')]
    }
    const resource = await this.api.im.messageResource.get({
      params: { type: 'image' },
      path: {
        message_id: message.message_id,
        file_key: content.image_key,
      },
    })
    const buffer = await readableToBuffer(resource.getReadableStream())
    return [segment.image(await saveInboundChannelImage('feishu', this.config.id, buffer))]
  }

  private async receive (event: FeishuMessageEvent) {
    const message = event.message
    const messageId = message?.message_id
    if (!this.bot || !messageId) return
    if (await channelStateStore.seen(`feishu:${this.config.id}`, messageId)) return
    const userId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || 'unknown'
    const group = message.chat_type === 'group'
    this.current.lastInbound = Date.now()
    this.bot.receive({
      eventId: `feishu:${messageId}`,
      messageId,
      time: Number(message.create_time || Date.now()),
      scene: group ? 'group' : 'friend',
      peerId: message.chat_id || userId,
      userId,
      elements: await this.messageElements(message),
      mentioned: group && Boolean(
        message.mentions?.some(mention => mention.id?.open_id === this.botOpenId)
      ),
      replyMessageId: message.parent_id || undefined,
      raw: event,
    })
  }

  async stop () {
    this.socket?.close({ force: true })
    this.bot?.unregister()
    this.socket = null
    this.api = null
    this.bot = null
    this.current.state = 'stopped'
  }

  async probe (config: FeishuConfig): Promise<ChannelProbeResult> {
    if (!config.appId || !config.appSecret) throw new Error('飞书 appId/appSecret 未配置')
    const started = Date.now()
    const api = this.dependencies.createApi({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: this.domain(config),
    })
    const result = await api.request<FeishuBotInfo>({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    })
    if (result.code) throw new Error(result.msg || `飞书认证失败: ${result.code}`)
    return {
      ok: true,
      botId: result.bot?.open_id || config.appId,
      name: result.bot?.app_name || config.name,
      latency: Date.now() - started,
    }
  }

  status () {
    return { ...this.current }
  }
}
