import { AdapterBase } from '@/adapter/base'
import { createFriendMessage, createGroupMessage } from '@/event/create'
import { contactFriend, contactGroup, senderFriend, senderGroup } from '@/event'
import { registerBot, unregisterBot } from '@/service'
import { segment } from '@/utils/message'

import type { Contact, Elements, SendMsgResults } from '@/types'
import type { ChannelKind } from './types'

export interface ChannelInboundMessage {
  eventId: string
  messageId: string
  time: number
  scene: 'friend' | 'group'
  peerId: string
  userId: string
  userName?: string
  text: string
  mentioned?: boolean
  replyMessageId?: string
  raw: unknown
  reply?: (elements: Elements[]) => Promise<SendMsgResults>
}

type ChannelSend = (contact: Contact, elements: Elements[]) => Promise<{
  messageId: string
  rawData?: unknown
}>

const elementsToText = (elements: Elements[]) => elements.map(element => {
  if (element.type === 'text') return element.text
  if (element.type === 'at') return `@${element.name || element.targetId}`
  if (element.type === 'image') return `[图片: ${element.file}]`
  if (element.type === 'file') return `[文件: ${element.name || element.file}]`
  if (element.type === 'reply') return `[回复: ${element.messageId}]`
  return `[${element.type}]`
}).join('')

export class BuiltinChannelAdapter extends AdapterBase {
  constructor (
    kind: ChannelKind,
    accountId: string,
    name: string,
    address: string,
    private readonly channelSend: ChannelSend
  ) {
    super()
    this.adapter.name = `@karinjs/${kind}`
    this.adapter.version = process.env.KARIN_VERSION
    this.adapter.platform = kind
    this.adapter.standard = 'other'
    this.adapter.protocol = kind
    this.adapter.communication = kind === 'telegram' ? 'http' : 'webSocketClient'
    this.adapter.address = address
    this.account.selfId = accountId
    this.account.uid = accountId
    this.account.uin = accountId
    this.account.name = name
  }

  register () {
    if (this.adapter.index > -1) return
    this.adapter.index = registerBot(this.adapter.communication, this)
  }

  unregister () {
    if (this.adapter.index < 0) return
    unregisterBot('index', this.adapter.index)
    this.adapter.index = -1
  }

  async sendMsg (contact: Contact, elements: Elements[]): Promise<SendMsgResults> {
    const result = await this.channelSend(contact, elements)
    const time = Date.now()
    return {
      messageId: result.messageId,
      message_id: result.messageId,
      time,
      messageTime: time,
      rawData: result.rawData || {},
    }
  }

  receive (message: ChannelInboundMessage) {
    const elements: Elements[] = []
    if (message.replyMessageId) elements.push(segment.reply(message.replyMessageId))
    if (message.mentioned) elements.push(segment.at(this.selfId, this.selfName))
    if (message.text) elements.push(segment.text(message.text))
    if (!elements.length) elements.push(segment.text('[暂不支持的消息类型]'))
    if (message.scene === 'group') {
      const contact = contactGroup(message.peerId)
      return createGroupMessage({
        bot: this,
        contact,
        elements,
        eventId: message.eventId,
        messageId: message.messageId,
        messageSeq: Number(message.time) || Date.now(),
        rawEvent: message.raw,
        time: message.time,
        srcReply: message.reply || ((reply: Elements[]) => this.sendMsg(contact, reply)),
        sender: senderGroup(message.userId, 'member', message.userName || ''),
      })
    }
    const contact = contactFriend(message.peerId)
    return createFriendMessage({
      bot: this,
      contact,
      elements,
      eventId: message.eventId,
      messageId: message.messageId,
      messageSeq: Number(message.time) || Date.now(),
      rawEvent: message.raw,
      time: message.time,
      srcReply: message.reply || ((reply: Elements[]) => this.sendMsg(contact, reply)),
      sender: senderFriend(message.userId, message.userName || ''),
    })
  }

  static text (elements: Elements[]) {
    return elementsToText(elements)
  }
}
