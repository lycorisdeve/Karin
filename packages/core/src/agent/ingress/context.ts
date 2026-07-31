import type { Contact, Message } from '@/types/event'
import type { AgentActor } from '@/types/agent'
import { agentOriginFromEvent } from './origin'

export const agentRole = (event: Message): AgentActor['role'] => {
  if (event.isMaster) return 'master'
  if (event.isAdmin) return 'admin'
  const role = 'role' in event.sender ? event.sender.role : undefined
  if (event.isGroup && role === 'owner') return 'group.owner'
  if (event.isGroup && role === 'admin') return 'group.admin'
  if (event.isGuild && role === 'owner') return 'guild.owner'
  if (event.isGuild && role === 'admin') return 'guild.admin'
  return 'all'
}

export const agentContactKey = (event: Message) => {
  const protocol = event.bot.adapter.protocol
  if (event.isGroup || event.isGroupTemp) {
    return `${protocol}:${event.selfId}:group:${event.groupId}`
  }
  if (event.isGuild) {
    return `${protocol}:${event.selfId}:guild:${event.guildId}:${event.channelId}`
  }
  if (event.isDirect) {
    return `${protocol}:${event.selfId}:direct:${event.guildId}:${event.channelId}:${event.userId}`
  }
  return `${protocol}:${event.selfId}:friend:${event.userId}`
}

export const agentActor = (event: Message): AgentActor => {
  const contactKey = agentContactKey(event)
  return {
    id: event.userId,
    role: agentRole(event),
    selfId: event.selfId,
    scene: event.contact.scene,
    contactKey,
    origin: agentOriginFromEvent(event, contactKey),
  }
}

export const agentThreadKey = (event: Message) => agentContactKey(event)

export interface AgentDeliveryTarget {
  selfId: string
  contact: Contact
}

/**
 * 将持久化的 contact key 还原为可发送消息的目标。
 * 当前事件优先，自动任务则使用 contact key 中保存的机器人和会话信息。
 */
export const agentDeliveryTarget = (
  actor: AgentActor,
  event?: Message
): AgentDeliveryTarget | null => {
  if (event) {
    return {
      selfId: event.selfId,
      contact: event.contact,
    }
  }

  const parts = actor.contactKey.split(':')
  const sceneIndex = parts.findIndex((part, index) =>
    index >= 2 && ['friend', 'group', 'guild', 'direct'].includes(part)
  )
  if (sceneIndex < 2) return null
  const selfId = parts[sceneIndex - 1]
  const scene = parts[sceneIndex]
  const peer = parts[sceneIndex + 1]
  if (!selfId || !peer) return null

  if (scene === 'friend') {
    return { selfId, contact: { scene, peer, name: '' } }
  }
  if (scene === 'group') {
    if (actor.scene === 'groupTemp') {
      return {
        selfId,
        contact: {
          scene: 'groupTemp',
          peer,
          subPeer: actor.id,
          name: '',
        },
      }
    }
    return { selfId, contact: { scene, peer, name: '' } }
  }

  const subPeer = parts[sceneIndex + 2]
  if (!subPeer) return null
  if (scene === 'guild') {
    return {
      selfId,
      contact: { scene, peer, subPeer, name: '', subName: '' },
    }
  }
  return {
    selfId,
    contact: { scene: 'direct', peer, subPeer, name: '', subName: '' },
  }
}
