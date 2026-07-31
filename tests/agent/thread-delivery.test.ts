import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deliverAgentResult } from '../../packages/core/src/agent/ingress/delivery'

import type { AgentThreadRecord } from '../../packages/core/src/agent/persistence/database'

const sendMsg = vi.hoisted(() => vi.fn())

vi.mock('@/service/bot', () => ({ sendMsg }))

const thread = (
  channel: string,
  scene: AgentThreadRecord['scene'] = 'friend'
): AgentThreadRecord => ({
  id: `thread-${channel}`,
  threadKey: `${channel}:bot-1:${scene}:peer-1`,
  parentThreadId: null,
  actorId: 'user-1',
  scene,
  state: 'idle',
  summary: '',
  title: '',
  archivedAt: null,
  messageCount: 0,
  lastMessagePreview: '',
  modelProviderId: null,
  modelName: null,
  channel,
  protocol: channel === 'onebot' ? 'onebot11' : channel,
  accountId: 'bot-1',
  accountName: 'Bot',
  contactKey: `${channel}:bot-1:${scene}:peer-1`,
  contactId: 'peer-1',
  contactSubId: '',
  contactName: 'Contact',
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

beforeEach(() => {
  sendMsg.mockReset()
  sendMsg.mockResolvedValue({ messageId: 'message-1' })
})

describe('Agent external thread delivery', () => {
  it.each(['onebot', 'telegram', 'wecom', 'feishu'])(
    'delivers native Agent elements to the exact %s account and contact',
    async channel => {
      await expect(deliverAgentResult(thread(channel), {
        threadId: `thread-${channel}`,
        turnId: 'turn-1',
        state: 'completed',
        content: '**结果**',
      })).resolves.toBe(true)

      expect(sendMsg).toHaveBeenCalledWith(
        'bot-1',
        expect.objectContaining({ scene: 'friend', peer: 'peer-1' }),
        expect.arrayContaining([expect.objectContaining({ type: 'text', text: '结果' })])
      )
    }
  )

  it('sends the three Chinese approval commands without exposing an approval id', async () => {
    await deliverAgentResult(thread('onebot'), {
      threadId: 'thread-onebot',
      turnId: 'turn-1',
      state: 'waiting_approval',
      content: '工具 karin.test.write 需要审批。',
      approvalId: '11111111-1111-1111-1111-111111111111',
    })

    const wire = JSON.stringify(sendMsg.mock.calls[0])
    expect(wire).toContain('/同意（本次同意）')
    expect(wire).toContain('/始终同意（本会话内始终同意该 Tool）')
    expect(wire).toContain('/拒绝')
    expect(wire).not.toContain('11111111-1111-1111-1111-111111111111')
  })

  it('does not deliver Web threads and treats an empty adapter result as a failure', async () => {
    await expect(deliverAgentResult(thread('web'), {
      threadId: 'thread-web',
      turnId: 'turn-1',
      state: 'completed',
      content: 'Web only',
    })).resolves.toBe(false)
    expect(sendMsg).not.toHaveBeenCalled()

    sendMsg.mockResolvedValueOnce({})
    await expect(deliverAgentResult(thread('telegram'), {
      threadId: 'thread-telegram',
      turnId: 'turn-1',
      state: 'completed',
      content: 'Failed delivery',
    })).rejects.toThrow('未返回消息 ID')
  })
})
