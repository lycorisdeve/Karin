import type { Contact, Message } from '@/types/event'
import type { AgentConversationOrigin } from '@/types/agent'

interface ThreadOriginRecord extends AgentConversationOrigin {
  actorId: string
  scene: string
  parentThreadId: string | null
}

const sceneNames = new Set(['friend', 'group', 'guild', 'direct'])

export const normalizeAgentChannel = (protocol: string, platform = '') => {
  const values = [platform, protocol].map(value => value.trim().toLowerCase()).filter(Boolean)
  if (values.some(value => value.startsWith('onebot'))) return 'onebot'
  for (const channel of [
    'telegram',
    'wecom',
    'feishu',
    'qqbot',
    'wechat',
    'dingtalk',
    'discord',
    'whatsapp',
    'email',
    'web',
  ]) {
    if (values.includes(channel)) return channel
  }
  if (values.some(value => value === 'automation' || value === 'job' || value === 'subagent')) {
    return 'system'
  }
  return values[0] || 'unknown'
}

export const agentOriginFromEvent = (
  event: Message,
  contactKey: string
): AgentConversationOrigin => {
  const protocol = event.bot.adapter.protocol || event.bot.adapter.platform || 'unknown'
  const contactName = event.contact.name ||
    (event.isPrivate ? event.sender.name || event.sender.nick || '' : '')
  return {
    channel: normalizeAgentChannel(protocol, event.bot.adapter.platform),
    protocol,
    accountId: event.selfId,
    accountName: event.bot.selfName || event.bot.account?.name || '',
    contactKey,
    contactId: event.contact.peer || '',
    contactSubId: event.contact.subPeer || (event.isGroupTemp ? event.userId : ''),
    contactName,
  }
}

export const inferAgentOrigin = (
  threadKey: string,
  scene: string,
  actorId: string
): AgentConversationOrigin => {
  if (threadKey.startsWith('web:')) {
    const contactKey = threadKey.split(':session:')[0]
    return {
      channel: 'web',
      protocol: 'web',
      accountId: 'web',
      accountName: 'Karin WebUI',
      contactKey,
      contactId: contactKey.slice(4),
      contactSubId: '',
      contactName: '',
    }
  }
  if (threadKey.startsWith('job:') || threadKey.startsWith('subagent:')) {
    return {
      channel: 'system',
      protocol: threadKey.split(':')[0],
      accountId: '',
      accountName: '',
      contactKey: '',
      contactId: '',
      contactSubId: '',
      contactName: '',
    }
  }

  const parts = threadKey.split(':')
  const sceneIndex = parts.findIndex((part, index) => index >= 2 && sceneNames.has(part))
  if (sceneIndex < 2) {
    const protocol = parts[0] || 'unknown'
    return {
      channel: normalizeAgentChannel(protocol),
      protocol,
      accountId: parts[1] || '',
      accountName: '',
      contactKey: threadKey.split(':session:')[0],
      contactId: '',
      contactSubId: '',
      contactName: '',
    }
  }

  const protocol = parts[0]
  const sourceScene = parts[sceneIndex]
  const contactLength = sourceScene === 'guild'
    ? sceneIndex + 3
    : sourceScene === 'direct'
      ? sceneIndex + 4
      : sceneIndex + 2
  return {
    channel: normalizeAgentChannel(protocol),
    protocol,
    accountId: parts[sceneIndex - 1] || '',
    accountName: '',
    contactKey: parts.slice(0, contactLength).join(':'),
    contactId: parts[sceneIndex + 1] || '',
    contactSubId: sourceScene === 'group' && scene === 'groupTemp'
      ? actorId
      : parts[sceneIndex + 2] || '',
    contactName: '',
  }
}

export const agentDeliveryTargetFromThread = (
  thread: ThreadOriginRecord
): { selfId: string, contact: Contact } | null => {
  if (
    ['web', 'system', 'unknown'].includes(thread.channel) ||
    !thread.accountId ||
    !thread.contactId
  ) {
    return null
  }
  if (!['friend', 'group', 'groupTemp', 'guild', 'direct'].includes(thread.scene)) return null
  if (['guild', 'direct', 'groupTemp'].includes(thread.scene) && !thread.contactSubId) return null
  return {
    selfId: thread.accountId,
    contact: {
      scene: thread.scene,
      peer: thread.contactId,
      subPeer: thread.contactSubId || undefined,
      name: thread.contactName,
      subName: '',
    } as Contact,
  }
}
