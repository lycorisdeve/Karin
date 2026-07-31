import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js'
import { BuiltinChannelAdapter } from './adapter'
import { channelStateStore } from './state'
import { redactSecrets } from './security'
import { resolveChannelImage, saveInboundChannelImage } from './media'
import { segment } from '@/utils/message'

import type { Adapters, Contact, Elements } from '@/types'
import type { ChannelDriver, ChannelProbeResult, ChannelStatus } from './types'
import type { Message as DiscordMessage, MessageCreateOptions } from 'discord.js'

type DiscordConfig = Adapters['discord'][number]
type SendableChannel = {
  send(options: MessageCreateOptions): Promise<DiscordMessage>
}

const intentMap: Record<string, GatewayIntentBits> = {
  Guilds: GatewayIntentBits.Guilds,
  GuildMessages: GatewayIntentBits.GuildMessages,
  DirectMessages: GatewayIntentBits.DirectMessages,
  MessageContent: GatewayIntentBits.MessageContent,
}

export class DiscordChannelDriver implements ChannelDriver<DiscordConfig> {
  readonly kind = 'discord' as const
  readonly capabilities = { text: true, image: true, inboundImage: true }
  private client: Client | null = null
  private bot: BuiltinChannelAdapter | null = null
  private config: DiscordConfig
  private current: ChannelStatus

  constructor (config: DiscordConfig) {
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

  private createClient (config: DiscordConfig) {
    const intents = config.intents.map(value => intentMap[value]).filter(Boolean)
    return new Client({
      intents: intents.length
        ? intents
        : [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
      partials: [Partials.Channel, Partials.Message],
    })
  }

  async start (config: DiscordConfig) {
    this.config = config
    this.current.enabled = config.enable
    if (!config.enable) {
      this.current.state = 'disabled'
      return
    }
    if (!config.botToken) throw new Error('Discord Bot Token 未配置')
    const client = this.createClient(config)
    this.client = client
    client.once('ready', ready => {
      const user = ready.user
      this.current.state = 'connected'
      this.current.botId = user.id
      this.current.lastError = ''
      this.bot = new BuiltinChannelAdapter(
        this.kind,
        `discord:${user.id}`,
        config.name || user.username,
        'wss://gateway.discord.gg',
        async (contact: Contact, elements: Elements[]) => {
          const channel = await ready.channels.fetch(contact.subPeer || contact.peer)
          if (!channel?.isTextBased()) throw new Error('Discord 目标不是文字频道')
          const results = []
          for (const element of elements) {
            if (element.type === 'image') {
              const image = await resolveChannelImage(element.file)
              results.push(await (channel as unknown as SendableChannel).send({
                files: [new AttachmentBuilder(image.buffer, { name: image.filename })],
              }))
              continue
            }
            const text = BuiltinChannelAdapter.text([element]).trim()
            if (text) {
              results.push(await (channel as unknown as SendableChannel).send({ content: text }))
            }
          }
          const result = results.at(-1)
          if (!result) throw new Error('Discord 消息没有可发送的内容')
          return { messageId: result.id, rawData: { messages: results.map(item => item.id) } }
        }
      )
      this.bot.account.subId.channel = config.id
      this.bot.register()
    })
    client.on('messageCreate', message => {
      this.receive(message).catch(error => {
        this.current.lastError = redactSecrets(error, [config.botToken])
        logger.error(`[channel][discord:${config.id}] ${this.current.lastError}`)
      })
    })
    client.on('error', error => {
      this.current.state = 'error'
      this.current.lastError = redactSecrets(error, [config.botToken])
    })
    this.current.state = 'connecting'
    await client.login(config.botToken)
  }

  private async receive (message: DiscordMessage) {
    if (!this.bot || message.author.bot) return
    if (await channelStateStore.seen(`discord:${this.config.id}`, message.id)) return
    const elements: Elements[] = []
    if (message.content) elements.push(segment.text(message.content))
    for (const attachment of message.attachments.values()) {
      if (!attachment.contentType?.startsWith('image/')) continue
      const image = await resolveChannelImage(attachment.url)
      elements.push(segment.image(await saveInboundChannelImage(
        'discord',
        this.config.id,
        image.buffer
      )))
    }
    if (!elements.length) return
    this.current.lastInbound = Date.now()
    const guild = Boolean(message.guildId)
    this.bot.receive({
      eventId: `discord:${message.id}`,
      messageId: message.id,
      time: message.createdTimestamp,
      scene: guild ? 'group' : 'friend',
      peerId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName || message.author.globalName || message.author.username,
      contactName: message.channel.isDMBased()
        ? message.author.globalName || message.author.username
        : 'name' in message.channel
          ? String(message.channel.name)
          : message.channelId,
      elements,
      mentioned: guild && message.mentions.has(this.client!.user!.id),
      replyMessageId: message.reference?.messageId || undefined,
      raw: message,
    })
  }

  async stop () {
    this.bot?.unregister()
    await this.client?.destroy()
    this.client = null
    this.bot = null
    this.current.state = 'stopped'
  }

  async probe (config: DiscordConfig): Promise<ChannelProbeResult> {
    if (!config.botToken) throw new Error('Discord Bot Token 未配置')
    const started = Date.now()
    const client = this.createClient(config)
    try {
      await client.login(config.botToken)
      await new Promise<void>((resolve, reject) => {
        if (client.isReady()) return resolve()
        const timer = setTimeout(() => reject(new Error('Discord 连接测试超时')), 15000)
        client.once('ready', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      return {
        ok: true,
        botId: client.user?.id || config.applicationId,
        name: client.user?.username || config.name,
        latency: Date.now() - started,
      }
    } finally {
      await client.destroy()
    }
  }

  status () {
    return { ...this.current }
  }
}
