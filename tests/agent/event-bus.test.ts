import { describe, expect, it } from 'vitest'

import { AgentEventBus } from '../../packages/core/src/agent/runtime/events'

import type { AgentStreamEvent } from '../../packages/core/src/types/agent'

const event = (id: number): AgentStreamEvent => ({
  id,
  threadId: 'thread-1',
  turnId: 'turn-1',
  type: 'text.delta',
  data: { delta: String(id) },
  createdAt: id,
})

describe('AgentEventBus', () => {
  it('buffers live events while replay is loading and delivers each event once in order', async () => {
    let resolveReplay!: (events: AgentStreamEvent[]) => void
    const replay = new Promise<AgentStreamEvent[]>(resolve => {
      resolveReplay = resolve
    })
    const bus = new AgentEventBus({
      listTurnEvents: () => replay,
    } as never)
    const received: Array<{ id: number; replayed: boolean }> = []

    const subscribing = bus.subscribeFrom('thread-1', 0, (item, replayed) => {
      received.push({ id: item.id, replayed })
    })
    bus.broadcast(event(2))
    bus.broadcast(event(3))
    resolveReplay([event(1), event(2)])

    const unsubscribe = await subscribing
    expect(received).toEqual([
      { id: 1, replayed: true },
      { id: 2, replayed: true },
      { id: 3, replayed: false },
    ])

    bus.broadcast(event(4))
    expect(received.at(-1)).toEqual({ id: 4, replayed: false })
    unsubscribe()
    bus.broadcast(event(5))
    expect(received).toHaveLength(4)
  })

  it('cleans up the provisional subscription when replay fails', async () => {
    const bus = new AgentEventBus({
      listTurnEvents: () => Promise.reject(new Error('replay failed')),
    } as never)
    const received: number[] = []

    await expect(bus.subscribeFrom('thread-1', 0, item => {
      received.push(item.id)
    })).rejects.toThrow('replay failed')

    bus.broadcast(event(1))
    expect(received).toEqual([])
  })
})
