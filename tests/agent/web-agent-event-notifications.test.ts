import { describe, expect, it } from 'vitest'
import { shouldNotifyDelivery } from '../../packages/web/src/pages/dashboard/agent/event-notifications'

describe('Web Agent delivery notifications', () => {
  it('does not notify for delivery events replayed while restoring a conversation', () => {
    expect(shouldNotifyDelivery({ replayed: true })).toBe(false)
  })

  it('notifies for a delivery event received live', () => {
    expect(shouldNotifyDelivery({ replayed: false })).toBe(true)
    expect(shouldNotifyDelivery({})).toBe(true)
  })
})
