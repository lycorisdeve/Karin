import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentScheduler } from '../../packages/core/src/agent/automation/scheduler'
import { registerBuiltinTools } from '../../packages/core/src/agent/builtins/tools'
import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentToolRegistry } from '../../packages/core/src/agent/tools/registry'
import { sendMsg } from '../../packages/core/src/service/bot'

import type { AgentLearning } from '../../packages/core/src/agent/learning/learning'
import type { AgentRuntime } from '../../packages/core/src/agent/runtime/runtime'
import type { AgentToolContext } from '../../packages/core/src/types/agent'

vi.mock('@/service/bot', () => ({
  getAllBotList: () => [],
  sendMsg: vi.fn(),
}))
vi.mock('@/service/task', () => ({
  taskSystem: { list: () => [], run: vi.fn() },
}))
vi.mock('@/utils/system/restart', () => ({ restartDirect: vi.fn() }))
vi.mock('@/server/plugins/install', () => ({
  startPluginInstall: vi.fn(),
  startPluginUninstall: vi.fn(),
}))
vi.mock('../../packages/core/src/agent/builtins/plugin', () => ({
  updateNpmPlugin: vi.fn(),
}))

const directories: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const createDatabase = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-agent-management-'))
  directories.push(directory)
  const database = new AgentDatabase(directory)
  await database.init()
  return database
}

describe('Agent management tools', () => {
  it('registers the structured cron, skill and memory toolsets', async () => {
    const database = await createDatabase()
    const registry = new AgentToolRegistry()
    registry.unregisterPrefix('karin.')
    const runtime = {
      runTurn: vi.fn(async () => ({ state: 'completed' })),
    } as unknown as AgentRuntime
    const scheduler = new AgentScheduler(database, runtime)
    const learning = {
      createSkill: vi.fn(async () => ({ skillId: 'skill', versionId: 'version' })),
    } as unknown as AgentLearning

    registerBuiltinTools(registry, database, runtime, scheduler, learning)
    const names = registry.list().map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'karin.cron.create',
      'karin.cron.run',
      'karin.skill.create',
      'karin.memory.remember',
      'karin.agent.delegate_many',
    ]))
    expect(
      registry.discover('一分钟后提醒我喝水').map(tool => tool.name)
    ).toEqual(expect.arrayContaining([
      'karin.cron.create',
      'karin.bot.send_message',
    ]))
    expect(
      registry.discover('把三个独立子任务并行分工处理').map(tool => tool.name)
    ).toContain('karin.agent.delegate_many')
    expect(
      registry.discover('发一张猫的照片给我').map(tool => tool.name)
    ).toEqual(expect.arrayContaining([
      'karin.bot.send_message',
      'karin.browser.search',
      'karin.browser.open',
      'karin.browser.download',
    ]))
    const tools = new Map(registry.list().map(tool => [tool.name, tool]))
    for (const name of [
      'karin.browser.open',
      'karin.browser.snapshot',
      'karin.browser.extract',
      'karin.browser.screenshot',
      'karin.browser.download',
      'karin.browser.close',
      'karin.skill.list',
      'karin.skill.view',
    ]) {
      expect(tools.get(name)?.risk, name).toBe('read')
    }
    expect(tools.get('karin.browser.click')?.risk).toBe('external')
    expect(tools.get('karin.browser.type')?.risk).toBe('external')
    expect(tools.get('karin.bot.send_message')?.risk).toBe('external')
    expect(tools.get('karin.cron.create')?.risk).toBe('write')
    expect(tools.get('karin.skill.create')?.risk).toBe('write')
    expect(tools.get('karin.cron.delete')?.risk).toBe('destructive')

    const context = {
      threadId: 'thread',
      turnId: 'turn',
      actor: {
        id: 'admin',
        role: 'admin',
        selfId: 'web',
        scene: 'web',
        contactKey: 'web:admin',
      },
      signal: AbortSignal.timeout(5000),
      automated: false,
    } satisfies AgentToolContext
    await registry.execute(
      'karin.cron.create',
      {
        name: 'daily status',
        cron: '0 9 * * *',
        prompt: '查看状态',
        timezone: 'Asia/Shanghai',
      },
      context,
      65536
    )
    expect(await database.listJobs()).toMatchObject([
      {
        scheduleType: 'cron',
        timezone: 'Asia/Shanghai',
        enabled: true,
      },
    ])

    scheduler.stop()
    registry.unregisterPrefix('karin.')
    await database.close()
  })

  it('sends a message to the current OneBot conversation without opaque target fields', async () => {
    const database = await createDatabase()
    const registry = new AgentToolRegistry()
    registry.unregisterPrefix('karin.')
    const runtime = {
      runTurn: vi.fn(async () => ({ state: 'completed' })),
    } as unknown as AgentRuntime
    const scheduler = new AgentScheduler(database, runtime)
    const learning = {
      createSkill: vi.fn(async () => ({ skillId: 'skill', versionId: 'version' })),
    } as unknown as AgentLearning
    registerBuiltinTools(registry, database, runtime, scheduler, learning)
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const imageSource = `base64://${png.toString('base64')}`

    const actor = {
      id: '20000',
      role: 'all' as const,
      selfId: '10000',
      scene: 'friend',
      contactKey: 'onebot11:10000:friend:20000',
    }
    await registry.execute(
      'karin.bot.send_message',
      { message: '主动通知' },
      {
        threadId: 'thread',
        turnId: 'turn',
        actor,
        event: {
          selfId: '10000',
          contact: { scene: 'friend', peer: '20000', name: '' },
        } as unknown as AgentToolContext['event'],
        signal: AbortSignal.timeout(5000),
        automated: false,
      },
      65536
    )

    expect(sendMsg).toHaveBeenCalledWith(
      '10000',
      expect.objectContaining({ scene: 'friend', peer: '20000' }),
      [{ type: 'text', text: '主动通知' }]
    )
    const receipt = await registry.executeWithReceipt(
      'karin.bot.send_message',
      {
        elements: [
          { type: 'text', text: '猫咪照片' },
          { type: 'image', source: imageSource, alt: '猫咪' },
        ],
      },
      {
        threadId: 'thread',
        turnId: 'turn',
        actor,
        event: {
          selfId: '10000',
          contact: { scene: 'friend', peer: '20000', name: '' },
        } as unknown as AgentToolContext['event'],
        signal: AbortSignal.timeout(5000),
        automated: false,
      },
      65536
    )
    expect(sendMsg).toHaveBeenLastCalledWith(
      '10000',
      expect.objectContaining({ scene: 'friend', peer: '20000' }),
      [
        { type: 'text', text: '猫咪照片' },
        { type: 'image', file: imageSource },
      ]
    )
    expect(receipt).toMatchObject({
      status: 'completed',
      receipt: {
        toolName: 'karin.bot.send_message',
        status: 'completed',
        delivery: {
          completed: true,
          textSegments: 1,
          imageSegments: 1,
        },
      },
    })
    await expect(registry.execute(
      'karin.bot.send_message',
      {
        selfId: 'console',
        scene: 'friend',
        peer: 'console',
        message: '越权消息',
      },
      {
        threadId: 'thread',
        turnId: 'turn',
        actor: { ...actor, role: 'master' },
        event: {
          selfId: '10000',
          contact: { scene: 'friend', peer: '20000', name: '' },
        } as unknown as AgentToolContext['event'],
        signal: AbortSignal.timeout(5000),
        automated: false,
      },
      65536
    )).rejects.toThrow('渠道回合只能向当前会话发送')

    scheduler.stop()
    registry.unregisterPrefix('karin.')
    await database.close()
  })

  it('creates a one-time reminder from a relative delay', async () => {
    const database = await createDatabase()
    const registry = new AgentToolRegistry()
    registry.unregisterPrefix('karin.')
    const runtime = {
      runTurn: vi.fn(async () => ({ state: 'completed' })),
    } as unknown as AgentRuntime
    const scheduler = new AgentScheduler(database, runtime)
    const learning = {
      createSkill: vi.fn(async () => ({ skillId: 'skill', versionId: 'version' })),
    } as unknown as AgentLearning
    registerBuiltinTools(registry, database, runtime, scheduler, learning)

    await registry.execute(
      'karin.cron.create',
      {
        name: '喝水提醒',
        scheduleType: 'once',
        delaySeconds: 60,
        prompt: '提醒我喝水',
      },
      {
        threadId: 'thread',
        turnId: 'turn',
        actor: {
          id: 'user',
          role: 'all',
          selfId: '10000',
          scene: 'friend',
          contactKey: 'onebot11:10000:friend:20000',
        },
        signal: AbortSignal.timeout(5000),
        automated: false,
      },
      65536
    )

    expect((await database.listJobs())[0]).toMatchObject({
      scheduleType: 'once',
      prompt: '提醒我喝水',
      target: 'onebot11:10000:friend:20000',
      enabled: true,
    })

    scheduler.stop()
    registry.unregisterPrefix('karin.')
    await database.close()
  })

  it('persists one-time schedule metadata and job run history', async () => {
    const database = await createDatabase()
    const runtime = {
      runTurn: vi.fn(async () => ({
        state: 'completed',
        content: '该喝水了',
      })),
    } as unknown as AgentRuntime
    const scheduler = new AgentScheduler(database, runtime)
    const runAt = Date.now() + 60_000
    const record = await scheduler.save({
      name: 'one time',
      scheduleType: 'once',
      cron: '',
      runAt,
      timezone: 'Asia/Shanghai',
      prompt: '提醒',
      target: 'onebot11:10000:friend:20000',
      toolAllowlist: [],
      skillIds: ['skill-1'],
      enabled: true,
      createdBy: 'admin',
    })

    expect((await database.listJobs())[0]).toMatchObject({
      id: record.id,
      scheduleType: 'once',
      runAt,
      skillIds: ['skill-1'],
    })
    await scheduler.runNow(record.id)
    expect(sendMsg).toHaveBeenCalledWith(
      '10000',
      expect.objectContaining({ scene: 'friend', peer: '20000' }),
      [{ type: 'text', text: '该喝水了' }]
    )
    expect(await database.listJobRuns(record.id)).toMatchObject([
      { status: 'completed' },
    ])
    expect((await database.listJobs())[0].enabled).toBe(false)

    scheduler.stop()
    await database.close()
  })
})
