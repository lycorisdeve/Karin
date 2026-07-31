import type { AgentStreamEvent } from '@/types/agent'

type Subscriber = (event: AgentStreamEvent) => void

export class AgentEventBus {
  private sequence = 0
  private readonly events = new Map<string, AgentStreamEvent[]>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()

  publish (threadId: string, type: AgentStreamEvent['type'], data: unknown, turnId?: string) {
    const event: AgentStreamEvent = {
      id: ++this.sequence,
      threadId,
      turnId,
      type,
      data,
      createdAt: Date.now(),
    }
    const list = this.events.get(threadId) || []
    list.push(event)
    if (list.length > 1000) list.splice(0, list.length - 1000)
    this.events.set(threadId, list)
    for (const subscriber of this.subscribers.get(threadId) || []) subscriber(event)
    return event
  }

  replay (threadId: string, afterId = 0) {
    return (this.events.get(threadId) || []).filter(event => event.id > afterId)
  }

  subscribe (threadId: string, subscriber: Subscriber) {
    const list = this.subscribers.get(threadId) || new Set<Subscriber>()
    list.add(subscriber)
    this.subscribers.set(threadId, list)
    return () => {
      list.delete(subscriber)
      if (!list.size) this.subscribers.delete(threadId)
    }
  }

  clearThread (threadId: string) {
    this.events.delete(threadId)
    this.subscribers.delete(threadId)
  }
}
