import { createHash, randomUUID } from 'node:crypto'
import { WSClient } from '@wecom/aibot-node-sdk'
import { BuiltinChannelAdapter } from './adapter'
import { channelStateStore } from './state'
import { redactSecrets } from './security'
import { resolveChannelImage, saveInboundChannelImage } from './media'
import { segment } from '@/utils/message'

import type { BaseMessage, ReplyMsgItem, WsFrame } from '@wecom/aibot-node-sdk'
import type { Adapters, Contact, Elements } from '@/types'
import type { ChannelDriver, ChannelProbeResult, ChannelStatus } from './types'

type WeComConfig = Adapters['wecom'][number]

export const weComMessageText = (body: BaseMessage) => {
  if (body.msgtype === 'text') return body.text?.content || ''
  if (body.msgtype === 'voice') return body.voice?.content || '[语音]'
  if (body.msgtype === 'image') return `[图片: ${body.image?.url || '无法获取'}]`
  if (body.msgtype === 'file') return `[文件: ${body.file?.url || '无法获取'}]`
  if (body.msgtype === 'video') return `[视频: ${body.video?.url || '无法获取'}]`
  if (body.msgtype === 'mixed') {
    return (body.mixed?.msg_item || []).map((item: {
      msgtype: 'text' | 'image'
      text?: { content: string }
      image?: { url: string }
    }) =>
      item.msgtype === 'text' ? item.text?.content || '' : `[图片: ${item.image?.url || '无法获取'}]`
    ).join('')
  }
  return `[企业微信 ${body.msgtype} 消息]`
}

export class WeComChannelDriver implements ChannelDriver<WeComConfig> {
  readonly kind = 'wecom' as const
  private client: WSClient | null = null
  private bot: BuiltinChannelAdapter | null = null
  private config: WeComConfig
  private current: ChannelStatus

  constructor (
    config: WeComConfig,
    private readonly clientFactory: (options: ConstructorParameters<typeof WSClient>[0]) =>
    WSClient = options => new WSClient(options)
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

  private createClient (config: WeComConfig) {
    return this.clientFactory({
      botId: config.botId,
      secret: config.secret,
      wsUrl: config.wsUrl || undefined,
      reconnectInterval: config.reconnectInterval,
      maxReconnectAttempts: config.maxReconnectAttempts,
      logger: {
        debug: message => logger.debug(
          `[channel][wecom:${config.id}] ${redactSecrets(message, [config.secret])}`
        ),
        info: message => logger.info(
          `[channel][wecom:${config.id}] ${redactSecrets(message, [config.secret])}`
        ),
        warn: message => logger.warn(
          `[channel][wecom:${config.id}] ${redactSecrets(message, [config.secret])}`
        ),
        error: message => logger.error(
          `[channel][wecom:${config.id}] ${redactSecrets(message, [config.secret])}`
        ),
      },
    })
  }

  async start (config: WeComConfig) {
    this.config = config
    this.current.enabled = config.enable
    if (!config.enable) {
      this.current.state = 'disabled'
      return
    }
    if (!config.botId || !config.secret) throw new Error('企业微信 botId/secret 未配置')
    this.current.state = 'connecting'
    const client = this.createClient(config)
    this.client = client
    this.bot = new BuiltinChannelAdapter(
      this.kind,
      `wecom:${config.botId}`,
      config.name,
      config.wsUrl || 'wss://openws.work.weixin.qq.com',
      async (contact: Contact, elements: Elements[]) => {
        const frames: WsFrame[] = []
        for (const element of elements) {
          if (element.type === 'image') {
            const image = await resolveChannelImage(element.file)
            const uploaded = await client.uploadMedia(image.buffer, {
              type: 'image',
              filename: image.filename,
            })
            frames.push(await client.sendMediaMessage(contact.peer, 'image', uploaded.media_id))
            continue
          }
          const text = BuiltinChannelAdapter.text([element]).trim()
          if (text) {
            frames.push(await client.sendMessage(contact.peer, {
              msgtype: 'markdown',
              markdown: { content: text },
            }))
          }
        }
        const frame = frames.at(-1)
        if (!frame) throw new Error('企业微信消息没有可发送的内容')
        return {
          messageId: frame.headers?.req_id || randomUUID(),
          rawData: { frames },
        }
      }
    )
    this.bot.account.subId.channel = config.id
    client.on('authenticated', () => {
      this.current.state = 'connected'
      this.current.botId = config.botId
      this.current.lastError = ''
      this.bot?.register()
    })
    client.on('reconnecting', attempt => {
      this.current.state = 'connecting'
      this.current.reconnects = attempt
    })
    client.on('disconnected', reason => {
      this.current.state = 'stopped'
      this.current.lastError = String(reason || '')
      this.bot?.unregister()
    })
    client.on('error', error => {
      this.current.state = 'error'
      this.current.lastError = redactSecrets(error, [config.secret])
      logger.error(`[channel][wecom:${config.id}] ${this.current.lastError}`)
    })
    client.on('message', frame => {
      this.receive(frame).catch(error => {
        logger.error(
          `[channel][wecom:${config.id}] 消息处理失败: ${
            redactSecrets(error, [config.secret])
          }`
        )
      })
    })
    client.connect()
  }

  private async messageElements (body: BaseMessage): Promise<Elements[]> {
    if (!this.client) return [segment.text(weComMessageText(body))]
    const elements: Elements[] = []
    const addImage = async (image?: { url?: string, aeskey?: string }) => {
      if (!image?.url) {
        elements.push(segment.text('[企业微信图片无法获取]'))
        return
      }
      const downloaded = await this.client!.downloadFile(image.url, image.aeskey)
      elements.push(segment.image(await saveInboundChannelImage(
        'wecom',
        this.config.id,
        downloaded.buffer
      )))
    }
    if (body.msgtype === 'text') elements.push(segment.text(body.text?.content || ''))
    else if (body.msgtype === 'voice') elements.push(segment.text(body.voice?.content || '[语音]'))
    else if (body.msgtype === 'image') await addImage(body.image)
    else if (body.msgtype === 'mixed') {
      for (const item of body.mixed?.msg_item || []) {
        if (item.msgtype === 'text' && item.text?.content) {
          elements.push(segment.text(item.text.content))
        } else if (item.msgtype === 'image') {
          await addImage(item.image)
        }
      }
    } else {
      elements.push(segment.text(weComMessageText(body)))
    }
    return elements.filter(item => item.type !== 'text' || item.text)
  }

  private async receive (frame: WsFrame<BaseMessage>) {
    if (!this.bot) return
    const body = frame.body
    if (!body?.msgid || await channelStateStore.seen(`wecom:${this.config.id}`, body.msgid)) return
    this.current.lastInbound = Date.now()
    const streamId = randomUUID()
    this.bot.receive({
      eventId: `wecom:${body.msgid}`,
      messageId: body.msgid,
      time: Number(body.create_time || Math.floor(Date.now() / 1000)) * 1000,
      scene: body.chattype === 'group' ? 'group' : 'friend',
      peerId: body.chattype === 'group' ? body.chatid || body.from.userid : body.from.userid,
      userId: body.from.userid,
      elements: await this.messageElements(body),
      mentioned: body.chattype === 'group',
      raw: frame,
      reply: async elements => {
        const text = BuiltinChannelAdapter.text(
          elements.filter(element => element.type !== 'image')
        )
        const images: ReplyMsgItem[] = []
        for (const element of elements) {
          if (element.type !== 'image') continue
          const image = await resolveChannelImage(element.file)
          images.push({
            msgtype: 'image',
            image: {
              base64: image.buffer.toString('base64'),
              md5: createHash('md5').update(image.buffer).digest('hex'),
            },
          })
        }
        const result = await this.client!.replyStream(
          frame,
          streamId,
          text,
          true,
          images
        )
        const time = Date.now()
        return {
          messageId: result.headers?.req_id || streamId,
          message_id: result.headers?.req_id || streamId,
          time,
          messageTime: time,
          rawData: result,
        }
      },
    })
  }

  async stop () {
    this.client?.disconnect()
    this.bot?.unregister()
    this.client = null
    this.bot = null
    this.current.state = 'stopped'
  }

  async probe (config: WeComConfig): Promise<ChannelProbeResult> {
    if (!config.botId || !config.secret) throw new Error('企业微信 botId/secret 未配置')
    const started = Date.now()
    return await new Promise((resolve, reject) => {
      const client = this.createClient({ ...config, maxReconnectAttempts: 0 })
      const timer = setTimeout(() => {
        client.disconnect()
        reject(new Error('企业微信连接测试超时'))
      }, 15000)
      client.once('authenticated', () => {
        clearTimeout(timer)
        client.disconnect()
        resolve({
          ok: true,
          botId: config.botId,
          name: config.name,
          latency: Date.now() - started,
        })
      })
      client.once('error', error => {
        clearTimeout(timer)
        client.disconnect()
        reject(error)
      })
      client.connect()
    })
  }

  status () {
    return { ...this.current }
  }
}
