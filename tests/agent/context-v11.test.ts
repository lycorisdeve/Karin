import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentContextEngine } from '../../packages/core/src/agent/context/engine'
import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { defaultConfig } from '../../packages/core/src/utils/config/default'

import type {
  AgentActor,
  AgentConfig,
  AgentModelMessage,
  ContextCheckpointV1,
} from '../../packages/core/src/types/agent'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(item => fs.rm(item, { recursive: true, force: true })))
})

const actor: AgentActor = {
  id: 'context-user', role: 'all', selfId: 'bot', scene: 'friend', contactKey: 'friend:user',
}

const database = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-context-v11-'))
  directories.push(directory)
  const value = new AgentDatabase(directory)
  await value.init()
  return value
}

const checkpoint = (): ContextCheckpointV1 => ({
  version: 1,
  goal: '完成上下文压缩测试',
  constraints: ['不拆 Tool 对'],
  decisions: ['使用结构化摘要'],
  evidence: ['tool-1 返回成功'],
  completedActions: [{ action: '读取资料', receipt: 'tool-1' }],
  pendingTasks: ['回答最新问题'],
  artifacts: [],
  failures: [],
  unresolvedQuestions: [],
  legacySummary: '旧摘要',
})

describe('Agent context compaction v11', () => {
  it('budgets the complete request and persists a structured checkpoint lineage', async () => {
    const db = await database()
    const thread = await db.getOrCreateThread('context-v11', actor)
    const config = structuredClone(defaultConfig.agent) as AgentConfig
    config.context = {
      ...config.context,
      defaultWindowTokens: 5000,
      softLimitRatio: 0.5,
      hardLimitRatio: 0.9,
      protectedRecentMessages: 2,
      summaryTargetTokens: 256,
      reservedOutputTokens: 256,
    }
    const engine = new AgentContextEngine(db, () => config)
    const messages: AgentModelMessage[] = [
      {
        role: 'system',
        content: '永久系统约束',
        protected: true,
      },
      {
        role: 'user',
        content: `旧目标${'甲'.repeat(900)}`,
        contextId: 'u1',
      },
      {
        role: 'assistant',
        content: '',
        contextId: 'a1',
        toolCalls: [{ id: 'call-1', name: 'test.read', arguments: {} }],
      },
      {
        role: 'tool',
        name: 'test.read',
        toolCallId: 'call-1',
        contextId: 't1',
        content: `证据${'乙'.repeat(900)}`,
      },
      {
        role: 'user',
        content: '最新问题',
        contextId: 'u2',
      },
    ]
    const summarize = vi.fn(async () => checkpoint())
    const prepared = await engine.prepareRequest({
      threadId: thread.id,
      messages,
      tools: [{
        name: 'test.read',
        description: `读取${'丙'.repeat(1000)}`,
        inputSchema: { type: 'object' },
      }],
      responseSchema: { name: 'answer', schema: { type: 'object' }, strict: true },
      legacySummary: '',
      summarize,
    })

    expect(prepared.compacted).toBe(true)
    expect(prepared.budget.tools).toBeGreaterThan(0)
    expect(prepared.budget.responseSchema).toBeGreaterThan(0)
    expect(prepared.budget.reservedOutput).toBe(256)
    expect(prepared.messages.some(message =>
      message.role === 'system' && String(message.content).startsWith('KARIN_CONTEXT_CHECKPOINT_V1')
    )).toBe(true)
    expect(prepared.messages.at(-1)?.content).toBe('最新问题')
    const latest = await db.latestContextSummary(thread.id)
    expect(latest).toMatchObject({
      format: 'checkpoint-v1',
      parentId: null,
      coveredThroughMessageId: expect.any(String),
    })
    expect(latest?.checkpoint?.goal).toBe('完成上下文压缩测试')
    expect(latest?.sourceMessageIds).not.toContain('u2')
    await db.close()
  })

  it('falls back deterministically on invalid semantic output and records usage purpose', async () => {
    const db = await database()
    const thread = await db.getOrCreateThread('context-fallback', actor)
    const turnId = await db.createTurn(thread.id, actor.id)
    const config = structuredClone(defaultConfig.agent) as AgentConfig
    config.context = {
      ...config.context,
      defaultWindowTokens: 1800,
      softLimitRatio: 0.5,
      hardLimitRatio: 0.9,
      protectedRecentMessages: 1,
      reservedOutputTokens: 256,
    }
    const engine = new AgentContextEngine(db, () => config)
    const prepared = await engine.prepareRequest({
      threadId: thread.id,
      messages: [
        { role: 'system', content: 'system', protected: true },
        { role: 'user', content: `旧内容${'甲'.repeat(1600)}`, contextId: 'old' },
        { role: 'user', content: '新目标', contextId: 'new' },
      ],
      tools: [],
      legacySummary: 'legacy',
      summarize: async () => ({ invalid: true } as unknown as ContextCheckpointV1),
    })
    expect(prepared.strategy).toBe('deterministic')
    expect(prepared.checkpoint?.legacySummary).toContain('旧内容')
    await db.addUsage(thread.id, turnId, 'provider', 'model', 10, 2, {
      purpose: 'compaction',
    })
    expect((await db.listUsage(1))[0].purpose).toBe('compaction')
    await db.close()
  })

  it('compacts in memory when another worker holds the thread lease', async () => {
    const db = await database()
    const thread = await db.getOrCreateThread('context-lease', actor)
    const config = structuredClone(defaultConfig.agent) as AgentConfig
    config.context = {
      ...config.context,
      defaultWindowTokens: 1800,
      softLimitRatio: 0.5,
      hardLimitRatio: 0.9,
      protectedRecentMessages: 1,
      reservedOutputTokens: 256,
    }
    vi.spyOn(db, 'acquireContextCompactionLease').mockResolvedValue(null)
    const engine = new AgentContextEngine(db, () => config)
    const prepared = await engine.prepareRequest({
      threadId: thread.id,
      messages: [
        { role: 'system', content: 'system', protected: true },
        { role: 'user', content: `旧内容${'甲'.repeat(1600)}`, contextId: 'old' },
        { role: 'user', content: '新目标', contextId: 'new' },
      ],
      tools: [],
      legacySummary: 'legacy',
    })

    expect(prepared).toMatchObject({ compacted: true, strategy: 'deterministic' })
    expect(prepared.budget.total).toBeLessThanOrEqual(prepared.budget.hardLimit)
    expect(await db.latestContextSummary(thread.id)).toBeNull()
    await db.close()
  })

  it('fails with partition details when protected content cannot fit', async () => {
    const db = await database()
    const thread = await db.getOrCreateThread('context-protected', actor)
    const config = structuredClone(defaultConfig.agent) as AgentConfig
    config.context = {
      ...config.context,
      defaultWindowTokens: 1000,
      softLimitRatio: 0.5,
      hardLimitRatio: 0.8,
      reservedOutputTokens: 256,
    }
    const engine = new AgentContextEngine(db, () => config)
    await expect(engine.prepareRequest({
      threadId: thread.id,
      messages: [{ role: 'system', content: '甲'.repeat(4000), protected: true }],
      tools: [{ name: 'large', description: '乙'.repeat(1000), inputSchema: {} }],
      legacySummary: '',
    })).rejects.toThrow(/protected=.*tools=.*reservedOutput=.*hardLimit=/)
    await db.close()
  })
})
