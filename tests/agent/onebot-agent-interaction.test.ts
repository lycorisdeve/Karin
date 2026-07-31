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
  },
  reply: vi.fn(async () => undefined),
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
  it('only sends the final answer and hides execution progress', async () => {
    const runtime = {
      currentSession: vi.fn(async () => ({ threadKey: 'onebot-thread' })),
      runTurn: vi.fn(async (_input: AgentTurnInput) => {
        return {
          threadId: 'thread',
          turnId: 'turn',
          state: 'completed' as const,
          content: '任务已经创建。',
        }
      }),
    } as unknown as AgentRuntime
    registerAgentIngress(runtime, () => config as never)
    const event = oneBotEvent()

    await fixtures.handler?.(event, vi.fn())

    expect(event.reply).toHaveBeenCalledTimes(1)
    expect(event.reply).toHaveBeenCalledWith([
      { type: 'text', text: '任务已经创建。' },
    ])
  })

  it('renders the same three approval commands for button and text adapters', async () => {
    const runtime = {
      currentSession: vi.fn(async () => ({ threadKey: 'onebot-thread' })),
      runTurn: vi.fn(async () => ({
        threadId: 'thread',
        turnId: 'turn',
        state: 'waiting_approval' as const,
        content: '需要确认外部调用。',
        approvalId: '11111111-1111-1111-1111-111111111111',
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
})
