import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentIngress } from '../../packages/core/src/agent/ingress/message'

import type { AgentRuntime } from '../../packages/core/src/agent/runtime/runtime'
import type { AgentTurnInput } from '../../packages/core/src/types/agent'

const fixtures = vi.hoisted(() => ({
  handler: undefined as
    | ((event: ReturnType<typeof oneBotEvent>, next: () => void) => Promise<void>)
    | undefined,
}))

vi.mock('@/hooks', () => ({
  hooks: {
    empty: {
      message: vi.fn((handler: typeof fixtures.handler) => {
        fixtures.handler = handler
      }),
    },
  },
}))

vi.mock('@/utils/config/file/adapter', () => ({
  adapter: () => ({
    wecom: [],
    feishu: [],
    telegram: [],
  }),
}))

const oneBotEvent = () => ({
  msg: '帮我处理',
  isPrivate: true,
  isMaster: false,
  isAdmin: false,
  isGroup: false,
  isGroupTemp: false,
  isGuild: false,
  isDirect: false,
  atBot: false,
  userId: '20000',
  selfId: '10000',
  sender: {},
  contact: {
    scene: 'friend' as const,
    peer: '20000',
    name: '用户',
  },
  bot: {
    adapter: {
      protocol: 'onebot11',
      standard: 'onebot11',
      platform: 'qq',
    },
    sendApi: vi.fn(async () => ({})),
    recallMsg: vi.fn(async () => undefined),
  },
  reply: vi.fn(async () => ({
    messageId: 'message-1',
    message_id: 'message-1',
    time: 0,
    messageTime: 0,
    rawData: {},
  })),
})

const config = {
  trigger: {
    private: true,
    groupMention: true,
    wakeWords: [],
  },
}

beforeEach(() => {
  fixtures.handler = undefined
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OneBot Agent interaction', () => {
  it('sends a recalled thinking prompt and hides tool execution progress', async () => {
    const result = {
      threadId: 'thread',
      turnId: 'turn',
      state: 'completed' as const,
      content: '任务已经创建。',
    }
    const runtime = {
      currentSession: vi.fn(async () => ({ threadKey: 'onebot-thread' })),
      submitInteractiveTurn: vi.fn((_input: AgentTurnInput) => ({
        requestId: 'request-1',
        mode: 'started',
        result: Promise.resolve(result),
        isLatest: () => true,
        release: vi.fn(),
      })),
    } as unknown as AgentRuntime
    registerAgentIngress(runtime, () => config as never)
    const event = oneBotEvent()

    await fixtures.handler?.(event, vi.fn())

    expect(event.reply).toHaveBeenCalledTimes(2)
    expect(event.reply).toHaveBeenNthCalledWith(1, 'Karin Agent 正在思考中，请稍后！')
    expect(event.reply).toHaveBeenCalledWith([
      { type: 'text', text: '任务已经创建。' },
    ])
    expect(event.bot.recallMsg).toHaveBeenCalledWith(event.contact, 'message-1')
  })

  it('renders the same three approval commands for button and text adapters', async () => {
    const result = {
      threadId: 'thread',
      turnId: 'turn',
      state: 'waiting_approval' as const,
      content: '需要确认外部调用。',
      approvalId: '11111111-1111-1111-1111-111111111111',
    }
    const runtime = {
      currentSession: vi.fn(async () => ({ threadKey: 'onebot-thread' })),
      submitInteractiveTurn: vi.fn(() => ({
        requestId: 'request-1',
        mode: 'started',
        result: Promise.resolve(result),
        isLatest: () => true,
        release: vi.fn(),
      })),
    } as unknown as AgentRuntime
    registerAgentIngress(runtime, () => config as never)
    const event = oneBotEvent()

    await fixtures.handler?.(event, vi.fn())

    const approvalReply = vi.mocked(event.reply).mock.calls.at(-1)?.[0]
    expect(JSON.stringify(approvalReply)).toContain('/同意')
    expect(JSON.stringify(approvalReply)).toContain('/始终同意')
    expect(JSON.stringify(approvalReply)).toContain('/拒绝')
    expect(JSON.stringify(approvalReply)).not.toContain('/agent approve')
    expect(JSON.stringify(approvalReply)).not.toContain('11111111-1111-1111-1111-111111111111')
    expect(JSON.stringify(approvalReply)).not.toContain('"type":"button"')
    expect(JSON.stringify(approvalReply)).not.toContain('"type":"markdown"')
    expect(approvalReply).toEqual([{
      type: 'text',
      text: [
        '需要确认外部调用。',
        '/同意（本次同意）',
        '/始终同意（本会话内始终同意该 Tool）',
        '/拒绝',
      ].join('\n'),
    }])
  })

  it('uses native OneBot input status for the lifetime of a turn', async () => {
    let finish!: (value: {
      threadId: string
      turnId: string
      state: 'completed'
      content: string
    }) => void
    const result = new Promise<{
      threadId: string
      turnId: string
      state: 'completed'
      content: string
    }>(resolve => {
      finish = resolve
    })
    const runtime = {
      currentSession: vi.fn(async () => ({ threadKey: 'onebot-thread' })),
      submitInteractiveTurn: vi.fn(() => ({
        requestId: 'request-1',
        mode: 'started',
        result,
        isLatest: () => true,
        release: vi.fn(),
      })),
    } as unknown as AgentRuntime
    registerAgentIngress(runtime, () => config as never)
    const event = oneBotEvent()

    const handling = fixtures.handler?.(event, vi.fn())
    await vi.waitFor(() => {
      expect(event.bot.sendApi).toHaveBeenCalledWith(
        'set_input_status',
        { user_id: 20000, typing: true }
      )
    })
    expect(event.reply).toHaveBeenCalledWith('Karin Agent 正在思考中，请稍后！')
    finish({
      threadId: 'thread',
      turnId: 'turn',
      state: 'completed',
      content: '完成',
    })
    await handling

    expect(event.bot.sendApi).toHaveBeenLastCalledWith(
      'set_input_status',
      { user_id: 20000, typing: false },
      500
    )
  })

  it('falls back to a recalled thinking message when native status is unavailable', async () => {
    let finish!: (value: {
      threadId: string
      turnId: string
      state: 'completed'
      content: string
    }) => void
    const result = new Promise<{
      threadId: string
      turnId: string
      state: 'completed'
      content: string
    }>(resolve => {
      finish = resolve
    })
    const runtime = {
      currentSession: vi.fn(async () => ({ threadKey: 'onebot-thread' })),
      submitInteractiveTurn: vi.fn(() => ({
        requestId: 'request-1',
        mode: 'started',
        result,
        isLatest: () => true,
        release: vi.fn(),
      })),
    } as unknown as AgentRuntime
    registerAgentIngress(runtime, () => config as never)
    const event = oneBotEvent()
    event.bot.sendApi.mockRejectedValue(new Error('unsupported'))

    const handling = fixtures.handler?.(event, vi.fn())
    await vi.waitFor(() => {
      expect(event.reply).toHaveBeenCalledWith('Karin Agent 正在思考中，请稍后！')
    })
    finish({
      threadId: 'thread',
      turnId: 'turn',
      state: 'completed',
      content: '完成',
    })
    await handling

    expect(event.bot.recallMsg).toHaveBeenCalledWith(
      event.contact,
      'message-1'
    )
  })
})
