import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'

import type { AgentActor } from '../../packages/core/src/types/agent'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const actor: AgentActor = {
  id: 'admin-1',
  role: 'admin',
  selfId: 'web',
  scene: 'web',
  contactKey: 'web:admin-1',
}

const createDatabase = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-agent-thread-'))
  directories.push(directory)
  const database = new AgentDatabase(directory)
  await database.init()
  return database
}

describe('Agent thread management', () => {
  it('titles, archives, searches and permanently deletes a thread tree', async () => {
    const database = await createDatabase()
    const root = await database.getOrCreateThread('web:root', actor)
    const child = await database.getOrCreateThread('web:child', actor, root.id)
    const rootTurn = await database.createTurn(root.id, actor.id)
    const childTurn = await database.createTurn(child.id, actor.id)
    await database.addMessage(root.id, rootTurn, 'user', '创建一个每日天气任务')
    await database.addMessage(child.id, childTurn, 'assistant', '子任务结果')
    await database.createToolCall(
      root.id,
      rootTurn,
      { id: 'call-1', name: 'karin.system.status', arguments: {} },
      'read',
      'allow',
      'pending'
    )
    await database.completeToolCall('call-1', { ok: true })
    await database.addMemory('user', actor.id, '保留的独立记忆', rootTurn)
    await database.addSkillVersion({
      name: 'weather-daily',
      description: 'weather',
      content: 'weather instructions',
      tools: ['karin.system.status'],
      sourceTurnId: rootTurn,
      contentHash: 'hash',
    })

    const titled = await database.getThread(root.id)
    expect(titled?.title).toBe('创建一个每日天气任务')
    expect(titled?.messageCount).toBe(1)
    expect(titled?.lastMessagePreview).toContain('天气任务')
    expect((await database.listToolCalls(root.id))[0]).toMatchObject({
      name: 'karin.system.status',
      status: 'completed',
      output: { ok: true },
    })

    await database.updateThread(root.id, { title: '天气对话', archived: true })
    expect(await database.listThreads({ state: 'active' })).toHaveLength(1)
    expect((await database.listThreads({ state: 'archived', query: '天气' }))[0].title)
      .toBe('天气对话')

    expect(await database.deleteThreadTree(root.id, actor.id)).toBe(true)
    expect(await database.getThread(root.id)).toBeNull()
    expect(await database.getThread(child.id)).toBeNull()
    expect(await database.listMemories()).toHaveLength(1)
    expect(await database.listSkills()).toHaveLength(1)
    expect((await database.listAudit()).some(row => row.action === 'thread.delete')).toBe(true)
    await database.close()
  })
})
