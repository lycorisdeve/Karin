import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  command: [] as Array<Record<string, unknown>>,
  emptyMessage: vi.fn(),
  permission: vi.fn(() => true),
  errorEmit: vi.fn(),
}))

vi.mock('@/plugin/system/cache', () => ({
  cache: {
    command: fixtures.command,
  },
}))

vi.mock('@/utils/config', () => ({
  config: () => ({}),
  getFriendCfg: () => ({ alias: [], enable: [], disable: [] }),
  getGroupCfg: () => ({ alias: [], enable: [], disable: [] }),
  getGuildCfg: () => ({ alias: [], enable: [], disable: [] }),
}))

vi.mock('@/event/handler/other/cd', () => ({
  privateCD: () => true,
  groupsCD: () => true,
}))

vi.mock('@/event/handler/other/context', () => ({
  context: () => false,
}))

vi.mock('@/event/handler/other/permission', () => ({
  Permission: {
    private: fixtures.permission,
    groups: fixtures.permission,
  },
}))

vi.mock('@/hooks/messaeg', () => ({
  hooksMessageEmit: {
    friend: async () => true,
    direct: async () => true,
    group: async () => true,
    groupTemp: async () => true,
    guild: async () => true,
    message: async () => true,
  },
}))

vi.mock('@/hooks/eventCall', () => ({
  eventCallEmit: {
    friend: async () => true,
    direct: async () => true,
    group: async () => true,
    groupTemp: async () => true,
    guild: async () => true,
    message: async () => true,
  },
}))

vi.mock('@/hooks/empty', () => ({
  emptyEmit: {
    message: fixtures.emptyMessage,
  },
}))

vi.mock('@/core/internal', () => ({
  listeners: {
    emit: fixtures.errorEmit,
  },
}))

vi.mock('@/event/handler/other/handler', () => ({
  log: vi.fn(),
  initAlias: vi.fn(),
  initEmit: vi.fn(),
  initMsg: vi.fn(),
  initRole: vi.fn(),
  disableViaAdapter: () => true,
  privateFilterEvent: () => true,
  groupFilterEvent: () => true,
  groupPrint: () => false,
  guildPrint: () => false,
  disableViaPluginWhitelist: () => true,
  disableViaPluginBlacklist: () => true,
}))

let friendHandler: typeof import(
  '../../packages/core/src/event/handler/message/private'
)['friendHandler']
let directHandler: typeof import(
  '../../packages/core/src/event/handler/message/private'
)['directHandler']
let groupHandler: typeof import(
  '../../packages/core/src/event/handler/message/groups'
)['groupHandler']
let groupTempHandler: typeof import(
  '../../packages/core/src/event/handler/message/groups'
)['groupTempHandler']
let guildHandler: typeof import(
  '../../packages/core/src/event/handler/message/groups'
)['guildHandler']

const event = () => ({
  userId: 'user-1',
  selfId: 'bot-1',
  messageId: 'message-1',
  eventId: 'event-1',
  msg: 'fixed',
  rawMessage: 'fixed',
  sender: { nick: 'user' },
  bot: { adapter: { protocol: 'other' } },
  isFriend: true,
  isDirect: false,
  logFnc: '',
  logText: '',
})

const groupEvent = (scene: 'group' | 'groupTemp' | 'guild') => ({
  ...event(),
  contact: {
    scene,
    peer: scene === 'guild' ? 'guild-1' : 'group-1',
    subPeer: scene === 'guild' ? 'channel-1' : undefined,
  },
  groupId: 'group-1',
  guildId: 'guild-1',
  channelId: 'channel-1',
  isFriend: false,
  isGroup: scene === 'group',
  isGuild: scene === 'guild',
  isGroupTemp: scene === 'groupTemp',
  isDirect: false,
})

const plugin = (fnc: () => unknown, permission = 'all') => ({
  event: 'message',
  permission,
  reg: /^fixed$/,
  adapter: [],
  dsbAdapter: [],
  pkg: { name: 'fixed-command-test' },
  file: { name: 'fixed', basename: 'fixed', method: 'fixed' },
  log: vi.fn(),
  type: 'fnc',
  fnc,
})

beforeAll(async () => {
  Object.assign(globalThis, {
    logger: {
      debug: vi.fn(),
      bot: vi.fn(),
      fnc: () => '',
      green: (value: unknown) => String(value),
    },
  })
  const privateHandlers = await import(
    '../../packages/core/src/event/handler/message/private'
  )
  friendHandler = privateHandlers.friendHandler
  directHandler = privateHandlers.directHandler
  const groups = await import('../../packages/core/src/event/handler/message/groups')
  groupHandler = groups.groupHandler
  groupTempHandler = groups.groupTempHandler
  guildHandler = groups.guildHandler
})

beforeEach(() => {
  fixtures.command.splice(0)
  fixtures.emptyMessage.mockReset()
  fixtures.permission.mockReset()
  fixtures.permission.mockReturnValue(true)
  fixtures.errorEmit.mockReset()
})

describe('fixed command compatibility before Agent ingress', () => {
  it('executes a matched fixed command exactly once and never invokes Agent empty hooks', async () => {
    const execute = vi.fn()
    fixtures.command.push(plugin(execute))

    await friendHandler(event() as never)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    expect(fixtures.emptyMessage).not.toHaveBeenCalled()
  })

  it('does not fall back to Agent when fixed command permission is denied', async () => {
    const execute = vi.fn()
    fixtures.permission.mockReturnValue(false)
    fixtures.command.push(plugin(execute, 'admin'))

    await friendHandler(event() as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(execute).not.toHaveBeenCalled()
    expect(fixtures.emptyMessage).not.toHaveBeenCalled()
  })

  it('does not fall back to Agent when a fixed command throws', async () => {
    fixtures.command.push(plugin(() => {
      throw new Error('fixed command failed')
    }))

    await friendHandler(event() as never)
    await vi.waitFor(() => expect(fixtures.errorEmit).toHaveBeenCalled())
    expect(fixtures.emptyMessage).not.toHaveBeenCalled()
  })

  it('invokes the Agent empty hook only when no fixed command matches', async () => {
    fixtures.command.push({
      ...plugin(vi.fn()),
      reg: /^another-command$/,
    })

    await friendHandler(event() as never)
    await vi.waitFor(() => expect(fixtures.emptyMessage).toHaveBeenCalledOnce())
  })

  it('resets global regex state before every fixed command match', async () => {
    const execute = vi.fn()
    fixtures.command.push({
      ...plugin(execute),
      reg: /^fixed$/g,
    })

    await friendHandler(event() as never)
    await friendHandler(event() as never)

    expect(execute).toHaveBeenCalledTimes(2)
    expect(fixtures.emptyMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['direct', () => directHandler({
      ...event(),
      isFriend: false,
      isDirect: true,
    } as never)],
    ['group', () => groupHandler(groupEvent('group') as never)],
    ['groupTemp', () => groupTempHandler(groupEvent('groupTemp') as never)],
    ['guild', () => guildHandler(groupEvent('guild') as never)],
  ] as const)('runs fixed commands before Agent in %s conversations', async (_scene, run) => {
    const execute = vi.fn()
    fixtures.command.push(plugin(execute))

    await run()

    expect(execute).toHaveBeenCalledOnce()
    expect(fixtures.emptyMessage).not.toHaveBeenCalled()
  })
})
