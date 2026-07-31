import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentScheduler } from '../../packages/core/src/agent/automation/scheduler'
import { registerBuiltinTools } from '../../packages/core/src/agent/builtins/tools'
import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentToolRegistry } from '../../packages/core/src/agent/tools/registry'

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
    ]))

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

  it('persists one-time schedule metadata and job run history', async () => {
    const database = await createDatabase()
    const runtime = {
      runTurn: vi.fn(async () => ({ state: 'completed' })),
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
      target: 'web',
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
    expect(await database.listJobRuns(record.id)).toMatchObject([
      { status: 'completed' },
    ])
    expect((await database.listJobs())[0].enabled).toBe(false)

    scheduler.stop()
    await database.close()
  })
})
