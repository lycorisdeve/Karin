import type { Message } from '@/types/event'
import type { AgentActor } from '@/types/agent'

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

export const agentActor = (event: Message): AgentActor => ({
  id: event.userId,
  role: agentRole(event),
  selfId: event.selfId,
  scene: event.contact.scene,
  contactKey: agentContactKey(event),
})

export const agentThreadKey = (event: Message) => agentContactKey(event)
