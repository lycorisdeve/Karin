import type { AgentStreamEvent } from '@/types/agent'
import type { AgentDatabase } from '../persistence/database'

type Subscriber = (event: AgentStreamEvent) => void
type ReplaySubscriber = (event: AgentStreamEvent, replayed: boolean) => void

const sensitiveKey = /authorization|cookie|token|password|api[-_]?key|secret/i
const transientKey = /^(?:content|input|output|arguments|payload|delta)$/i

const journalData = (value: unknown, key = ''): unknown => {
  if (sensitiveKey.test(key)) return '[REDACTED]'
  if (transientKey.test(key)) return '[OMITTED]'
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => journalData(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([itemKey, item]) => [itemKey, journalData(item, itemKey)])
    )
  }
  return value
}

export class AgentEventBus {
  private readonly subscribers = new Map<string, Set<Subscriber>>()

  constructor (private readonly database: AgentDatabase) {}

  async publish (
    threadId: string,
    type: AgentStreamEvent['type'],
    data: unknown,
    turnId?: string
  ) {
    const persisted = await this.database.appendTurnEvent(
      threadId,
      type,
      journalData(data),
      turnId
    )
    const event = { ...persisted, data }
    this.broadcast(event)
    return event
  }

  broadcast (event: AgentStreamEvent) {
    for (const subscriber of this.subscribers.get(event.threadId) || []) subscriber(event)
    return event
  }

  replay (threadId: string, afterId = 0) {
    return this.database.listTurnEvents(threadId, afterId)
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

  /**
   * Subscribes before loading persisted events so reconnecting clients cannot
   * miss events published between replay and the live subscription.
   */
  async subscribeFrom (
    threadId: string,
    afterId: number,
    subscriber: ReplaySubscriber
  ) {
    let cursor = Number.isFinite(afterId) ? Math.max(0, Math.trunc(afterId)) : 0
    let replaying = true
    const buffered: AgentStreamEvent[] = []
    const unsubscribe = this.subscribe(threadId, event => {
      if (replaying) {
        buffered.push(event)
        return
      }
      if (event.id <= cursor) return
      cursor = event.id
      subscriber(event, false)
    })

    try {
      for (const event of await this.replay(threadId, cursor)) {
        if (event.id <= cursor) continue
        cursor = event.id
        subscriber(event, true)
      }
      for (const event of buffered.sort((left, right) => left.id - right.id)) {
        if (event.id <= cursor) continue
        cursor = event.id
        subscriber(event, false)
      }
      replaying = false
      return unsubscribe
    } catch (error) {
      unsubscribe()
      throw error
    }
  }

  clearThread (threadId: string) {
    this.subscribers.delete(threadId)
  }
}
