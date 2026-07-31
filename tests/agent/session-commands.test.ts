import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentCommands } from '../../packages/core/src/agent/ingress/commands'

import type { AgentRuntime } from '../../packages/core/src/agent/runtime/runtime'

const fixtures = vi.hoisted(() => ({
  commands: [] as Array<Record<string, unknown>>,
  count: { command: 0 },
}))

vi.mock('@/plugin/system/cache', () => ({
  cache: {
    command: fixtures.commands,
    count: fixtures.count,
  },
}))

vi.mock('@/core/karin/command', () => ({
  command: (
    reg: RegExp,
    fnc: (event: Record<string, unknown>) => Promise<boolean>,
    options: { name: string }
  ) => ({
    reg,
    fnc,
    file: { name: options.name },
  }),
}))

const event = (msg: string) => ({
  msg,
  isPrivate: true,
  isMaster: false,
  isAdmin: false,
  isGroup: false,
  isGuild: false,
  isGroupTemp: false,
  isDirect: false,
  userId: 'user-1',
  selfId: 'bot-1',
  sender: {},
  contact: { scene: 'friend' },
  bot: { adapter: { protocol: 'test' } },
  reply: vi.fn(async () => undefined),
})

const createRuntime = () =>
  ({
    newSession: vi.fn(async () => ({ id: 'new-thread' })),
    currentSession: vi.fn(async () => ({ id: 'current-thread' })),
    interruptTree: vi.fn(async () => ({
      interrupted: false,
      turns: 0,
      subagents: 0,
      approvals: 0,
    })),
    listPendingSessionApprovals: vi.fn(async () => []),
    resolveApproval: vi.fn(),
    listSelectableModels: vi.fn(() => [
      { providerId: 'primary', providerName: 'Primary', model: 'model-a' },
      { providerId: 'secondary', providerName: 'Secondary', model: 'model-b' },
    ]),
    describeThreadModel: vi.fn(async () => ({
      inherited: true,
      providerId: 'primary',
      providerName: 'Primary',
      model: 'model-a',
      models: [
        { providerId: 'primary', providerName: 'Primary', model: 'model-a' },
        { providerId: 'secondary', providerName: 'Secondary', model: 'model-b' },
      ],
    })),
    setSessionModel: vi.fn(async () => ({ id: 'current-thread' })),
  }) as unknown as AgentRuntime

beforeEach(() => {
  fixtures.commands.splice(0)
  fixtures.count.command = 0
})

describe('Agent session commands', () => {
  it('reserves exact short commands before plugin commands without calling the model', async () => {
    fixtures.commands.push({ file: { name: 'plugin command' } })
    const runtime = createRuntime()
    registerAgentCommands(runtime)
    const builtin = fixtures.commands[0] as {
      reg: RegExp
      fnc: (value: ReturnType<typeof event>) => Promise<boolean>
    }
    const input = event('/new')

    expect(builtin.reg.test('/new')).toBe(true)
    expect(builtin.reg.test('/new later')).toBe(false)
    expect(await builtin.fnc(input)).toBe(true)
    expect(runtime.newSession).toHaveBeenCalledOnce()
    expect(input.reply).toHaveBeenCalledWith('已创建新会话：new-thread')
  })

  it('resolves the newest pending approval and reports the remaining count', async () => {
    const runtime = createRuntime()
    vi.mocked(runtime.listPendingSessionApprovals).mockResolvedValue([
      { id: 'approval-1', toolName: 'test.one' },
      { id: 'approval-2', toolName: 'test.two' },
    ] as never)
    vi.mocked(runtime.resolveApproval).mockResolvedValue({
      threadId: 'thread',
      turnId: 'turn',
      state: 'completed',
      content: '',
    })
    registerAgentCommands(runtime)
    const builtin = fixtures.commands[0] as {
      fnc: (value: ReturnType<typeof event>) => Promise<boolean>
    }
    const input = event('/同意')

    expect(await builtin.fnc(input)).toBe(true)
    expect(runtime.resolveApproval).toHaveBeenCalledWith(
      'approval-1',
      'approved',
      expect.objectContaining({ id: 'user-1' }),
      'once'
    )
    expect(input.reply).toHaveBeenCalledWith('当前会话还有 1 个待审批操作。')
    expect(JSON.stringify(input.reply.mock.calls)).not.toContain('approval-')
  })

  it.each([
    ['/同意', 'approved', 'once'],
    ['/始终同意', 'approved', 'thread'],
    ['/拒绝', 'denied', 'once'],
  ] as const)('maps %s to the current pending approval', async (command, decision, scope) => {
    const runtime = createRuntime()
    vi.mocked(runtime.listPendingSessionApprovals).mockResolvedValue([
      { id: 'approval-1', toolName: 'test.one' },
    ] as never)
    vi.mocked(runtime.resolveApproval).mockResolvedValue({
      threadId: 'thread',
      turnId: 'turn',
      state: 'completed',
      content: '',
    })
    registerAgentCommands(runtime)
    const builtin = fixtures.commands[0] as {
      reg: RegExp
      fnc: (value: ReturnType<typeof event>) => Promise<boolean>
    }

    expect(builtin.reg.test(command)).toBe(true)
    expect(await builtin.fnc(event(command))).toBe(true)
    expect(runtime.resolveApproval).toHaveBeenCalledWith(
      'approval-1',
      decision,
      expect.objectContaining({ id: 'user-1' }),
      scope
    )
  })

  it('supports a persistent Tool grant for the current session', async () => {
    const runtime = createRuntime()
    vi.mocked(runtime.resolveApproval).mockResolvedValue({
      threadId: 'thread',
      turnId: 'turn',
      state: 'completed',
      content: '',
    })
    registerAgentCommands(runtime)
    const builtin = fixtures.commands[0] as {
      reg: RegExp
      fnc: (value: ReturnType<typeof event>) => Promise<boolean>
    }
    const approvalId = '11111111-1111-1111-1111-111111111111'
    const input = event(`/approve ${approvalId} thread`)

    expect(builtin.reg.test(input.msg)).toBe(true)
    expect(await builtin.fnc(input)).toBe(true)
    expect(runtime.resolveApproval).toHaveBeenCalledWith(
      approvalId,
      'approved',
      expect.objectContaining({ id: 'user-1' }),
      'thread'
    )
  })

  it('lists and switches models for the current session', async () => {
    const runtime = createRuntime()
    registerAgentCommands(runtime)
    const builtin = fixtures.commands[0] as {
      reg: RegExp
      fnc: (value: ReturnType<typeof event>) => Promise<boolean>
    }
    const listInput = event('/model')

    expect(builtin.reg.test('/model')).toBe(true)
    expect(builtin.reg.test('/model 2')).toBe(true)
    expect(await builtin.fnc(listInput)).toBe(true)
    expect(listInput.reply).toHaveBeenCalledWith(expect.stringContaining('Primary · model-a'))

    expect(await builtin.fnc(event('/model 2'))).toBe(true)
    expect(runtime.setSessionModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'secondary',
      'model-b'
    )

    expect(await builtin.fnc(event('/model reset'))).toBe(true)
    expect(runtime.setSessionModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      null,
      null
    )
  })
})
