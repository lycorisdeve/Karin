import { describe, expect, it } from 'vitest'

import {
  channelName,
  isRenderableChatMessage,
  readThreadSelections,
  restoredThreadRoot,
  threadName,
  writeThreadSelection,
} from '../../packages/web/src/pages/dashboard/agent/thread-selection'

import type { AgentMessage, AgentThread } from '../../packages/web/src/request/agent'

const thread = (id: string, title = '', contactName = '') => ({
  id,
  title,
  contactName,
  scene: 'friend',
  contactId: `contact-${id}`,
  threadKey: `telegram:bot:friend:${id}`,
} as AgentThread)

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe('Agent channel and thread selection', () => {
  it('persists active and archived selections independently', () => {
    const storage = memoryStorage()
    writeThreadSelection('active', {
      channel: 'telegram',
      rootId: 'root-1',
      threadId: 'child-1',
    }, storage)
    writeThreadSelection('archived', {
      channel: 'onebot',
      rootId: 'root-2',
      threadId: 'root-2',
    }, storage)

    expect(readThreadSelections(storage)).toEqual({
      active: {
        channel: 'telegram',
        rootId: 'root-1',
        threadId: 'child-1',
      },
      archived: {
        channel: 'onebot',
        rootId: 'root-2',
        threadId: 'root-2',
      },
    })
  })

  it('falls back from a missing saved thread to the most recent root', () => {
    const threads = [thread('recent'), thread('older')]
    expect(restoredThreadRoot(threads, {
      channel: 'telegram',
      rootId: 'missing',
      threadId: 'missing-child',
    })?.id).toBe('recent')
  })

  it('uses title, then contact name, then scene and id for labels', () => {
    expect(threadName(thread('1', '自定义标题', 'Alice'))).toBe('自定义标题')
    expect(threadName(thread('2', '', 'Alice'))).toBe('Alice')
    expect(threadName(thread('3'))).toBe('friend · contact-3')
    expect(channelName('wecom')).toBe('企业微信')
    expect(channelName('custom-protocol')).toBe('custom-protocol')
  })

  it('does not render empty assistant Tool-call placeholders as chat bubbles', () => {
    const message = (content: string, attachments: AgentMessage['attachments'] = []) => ({
      id: crypto.randomUUID(),
      threadId: 'thread',
      role: 'assistant',
      content,
      createdAt: Date.now(),
      attachments,
    } as AgentMessage)

    expect(isRenderableChatMessage(message(''))).toBe(false)
    expect(isRenderableChatMessage(message('可见回复'))).toBe(true)
    expect(isRenderableChatMessage(message('', [{
      id: 'attachment',
      messageId: 'message',
      type: 'image',
      mime: 'image/png',
      size: 1,
      name: 'image.png',
      url: '/api/v1/agent/media/attachment',
    }]))).toBe(true)

    expect(isRenderableChatMessage({
      ...message('工具调用前的中间说明'),
      final: false,
    })).toBe(false)
    expect(isRenderableChatMessage({
      ...message('唯一最终答案'),
      final: true,
    })).toBe(true)
  })
})
