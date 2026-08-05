import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentCompletionGuard } from '../../packages/core/src/agent/execution/completion-guard'
import { AgentPolicy } from '../../packages/core/src/agent/policy/policy'
import { AgentPromptAssembler } from '../../packages/core/src/agent/prompt/assembler'
import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentTaskLedger } from '../../packages/core/src/agent/tasks/ledger'
import { AgentToolRegistry } from '../../packages/core/src/agent/tools/registry'
import { defaultConfig } from '../../packages/core/src/utils/config/default'

import type {
  AgentActor,
  AgentConfig,
  AgentTaskList,
  AgentToolContext,
} from '../../packages/core/src/types/agent'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const actor: AgentActor = {
  id: 'admin-1',
  role: 'admin',
  selfId: 'bot-1',
  scene: 'friend',
  contactKey: 'test:bot-1:friend:admin-1',
}

const context: AgentToolContext = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  actor,
  signal: new AbortController().signal,
  automated: false,
}

const createDatabase = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-agent-v8-'))
  directories.push(directory)
  const database = new AgentDatabase(directory)
  await database.init()
  return database
}

const config = () => structuredClone(defaultConfig.agent) as AgentConfig

describe('Agent v8 architecture', () => {
  it('persists replace/merge task lists and enforces one in_progress item', async () => {
    const database = await createDatabase()
    const thread = await database.getOrCreateThread('task-ledger', actor)
    const turnId = await database.createTurn(thread.id, actor.id, false)
    const ledger = new AgentTaskLedger(database, config)

    const created = await ledger.write(thread.id, turnId, actor.id, '重构 Agent', {
      merge: false,
      todos: [
        { id: 'inspect', content: '检查现状', status: 'in_progress' },
        { id: 'build', content: '实现架构', status: 'pending' },
      ],
    })
    expect(created.state).toBe('active')
    expect((await ledger.read(thread.id))?.items).toHaveLength(2)

    const merged = await ledger.write(thread.id, turnId, actor.id, '', {
      merge: true,
      todos: [
        { id: 'inspect', status: 'completed' },
        { id: 'build', status: 'in_progress' },
      ],
    })
    expect(merged.items.map(item => [item.id, item.status])).toEqual([
      ['inspect', 'completed'],
      ['build', 'in_progress'],
    ])

    await expect(ledger.write(thread.id, turnId, actor.id, '', {
      merge: true,
      todos: [
        { id: 'inspect', status: 'in_progress' },
        { id: 'build', status: 'in_progress' },
      ],
    })).rejects.toThrow(/一个进行中|in_progress/)

    const resumed = await ledger.resume(
      thread.id,
      turnId,
      actor.id,
      ['补充检查渠道投递']
    )
    expect(resumed?.items.map(item => [item.content, item.status])).toEqual([
      ['检查现状', 'completed'],
      ['实现架构', 'pending'],
      ['补充检查渠道投递', 'pending'],
    ])
    await database.close()
  })

  it('marks exactly one persisted assistant message as the turn final result', async () => {
    const database = await createDatabase()
    const thread = await database.getOrCreateThread('final-message', actor)
    const interrupted = await database.createTurn(thread.id, actor.id, false)
    await database.updateTurn(interrupted, thread.id, 'interrupted', 'supplemented')
    const resumed = await database.createTurn(thread.id, actor.id, false, interrupted)
    await database.addMessage(thread.id, resumed, 'assistant', '中间说明')
    const finalMessageId = await database.ensureFinalMessage(
      thread.id,
      resumed,
      '唯一最终答案'
    )
    await database.updateTurn(resumed, thread.id, 'completed', undefined, finalMessageId)

    const messages = await database.listMessages(thread.id)
    expect(messages.filter(message => message.final)).toEqual([
      expect.objectContaining({
        id: finalMessageId,
        content: '唯一最终答案',
      }),
    ])
    expect((await database.listTurns(thread.id)).at(-1)).toMatchObject({
      finalMessageId,
      resumedFromTurnId: interrupted,
    })
    await database.close()
  })

  it('requires plans only for multi-step requests', () => {
    const ledger = new AgentTaskLedger({} as AgentDatabase, config)
    expect(ledger.shouldPlan('解释一下什么是 Tool receipt')).toBe(false)
    expect(ledger.shouldPlan('1. 检查项目\n2. 实现任务清单\n3. 补充测试')).toBe(true)
  })

  it('keeps Skill contents out of the stable prompt until explicitly loaded', () => {
    const ledger = new AgentTaskLedger({} as AgentDatabase, config)
    const prompt = new AgentPromptAssembler(ledger).build({
      memories: [],
      tasks: null,
      summary: '',
      skills: [{
        id: 'skill-1',
        name: 'release-check',
        description: '检查发布条件',
        versionId: 'version-1',
        version: 3,
        tools: ['test.read'],
      }],
    })
    expect(prompt).toContain('release-check@3')
    expect(prompt).toContain('karin.skill.view')
    expect(prompt).not.toContain('这里是不能预注入的 Skill 正文')
  })

  it('auto-approves only trusted reversible Karin writes', () => {
    const registry = new AgentToolRegistry()
    const trusted = registry.register({
      name: 'karin.agent.test_state',
      description: 'test trusted state',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'write',
      reversible: true,
      execute: () => ({}),
    }, true)
    const plugin = registry.register({
      name: 'plugin.test_state',
      description: 'test plugin state',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'write',
      reversible: true,
      execute: () => ({}),
    })
    const policy = new AgentPolicy(config)
    expect(policy.decide(trusted, context)).toBe('allow')
    expect(policy.decide(plugin, context)).toBe('ask')
    registry.unregister('karin.agent.test_state')
    registry.unregister('plugin.test_state')
  })

  it('blocks final completion when tasks or required receipts are unresolved', () => {
    const guard = new AgentCompletionGuard()
    const active = {
      id: 'list-1',
      threadId: 'thread-1',
      sourceTurnId: 'turn-1',
      goal: '完成变更',
      state: 'active',
      items: [{
        id: 'build',
        content: '实现变更',
        status: 'in_progress',
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies AgentTaskList
    expect(guard.verify(active, [], '已经完成').completed).toBe(false)

    const completed = {
      ...active,
      state: 'completed',
      items: [{ ...active.items[0], status: 'completed' as const }],
    } satisfies AgentTaskList
    expect(guard.verify(completed, [], '已经完成').message).toMatch(/回执/)
    expect(guard.verify(completed, [{
      status: 'completed',
      data: { changed: true },
      receipt: {
        id: 'receipt-1',
        toolName: 'test.write',
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    } as never], '已经完成').completed).toBe(true)
  })
})
