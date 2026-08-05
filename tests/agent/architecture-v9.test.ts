import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentContextEngine } from '../../packages/core/src/agent/context/engine'
import { AgentMessageLifecycle } from '../../packages/core/src/agent/delivery/lifecycle'
import { AgentCompletionGuard } from '../../packages/core/src/agent/execution/completion-guard'
import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentRunJournal } from '../../packages/core/src/agent/runtime/journal'
import { AgentToolRegistry } from '../../packages/core/src/agent/tools/registry'
import { defaultConfig } from '../../packages/core/src/utils/config/default'

import type {
  AgentActor,
  AgentConfig,
  AgentTaskPlan,
} from '../../packages/core/src/types/agent'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const actor: AgentActor = {
  id: 'user-1',
  role: 'all',
  selfId: 'bot-1',
  scene: 'friend',
  contactKey: 'onebot:bot-1:friend:user-1',
}

const config = () => structuredClone(defaultConfig.agent) as AgentConfig

const database = async (directory?: string) => {
  const target = directory || await fs.mkdtemp(path.join(os.tmpdir(), 'karin-agent-v9-'))
  if (!directory) directories.push(target)
  const value = new AgentDatabase(target)
  await value.init()
  return { value, directory: target }
}

describe('Agent v9 execution kernel', () => {
  it('compacts by token budget with summary lineage and intact tool pairs', async () => {
    const { value } = await database()
    const thread = await value.getOrCreateThread('context-lineage', actor)
    const turnId = await value.createTurn(thread.id, actor.id)
    const messages = [
      { id: 'u1', role: 'user' as const, content: `旧目标${'甲'.repeat(200)}`, toolCalls: [] },
      {
        id: 'a1',
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'call-1', name: 'test.read', arguments: {} }],
      },
      {
        id: 't1',
        role: 'tool' as const,
        content: `结果${'乙'.repeat(200)}`,
        name: 'test.read',
        toolCallId: 'call-1',
        toolCalls: [],
      },
      { id: 'u2', role: 'user' as const, content: '最新问题', toolCalls: [] },
    ]
    const localConfig = () => ({
      ...config(),
      context: {
        defaultWindowTokens: 300,
        softLimitRatio: 0.5,
        hardLimitRatio: 0.85,
        protectedRecentMessages: 1,
        summaryTargetTokens: 128,
      },
    })
    const engine = new AgentContextEngine(value, localConfig)
    const first = await engine.prepare({
      threadId: thread.id,
      messages,
      legacySummary: '最早摘要',
    })
    expect(first.compressed).toBe(true)
    expect(first.summary).toContain('最早摘要')
    expect(first.history.at(-1)?.content).toBe('最新问题')

    const second = await engine.prepare({
      threadId: thread.id,
      messages: [
        ...messages,
        { id: 'u3', role: 'user' as const, content: `补充${'丙'.repeat(200)}`, toolCalls: [] },
        { id: 'u4', role: 'user' as const, content: '再次追问', toolCalls: [] },
      ],
      legacySummary: first.summary,
    })
    const latest = await value.latestContextSummary(thread.id)
    expect(latest?.parentId).toBeTruthy()
    expect(second.summary).toContain('最早摘要')
    await value.updateTurn(turnId, thread.id, 'completed')
    await value.close()
  })

  it('ignores optional failures but requires real delivery evidence', () => {
    const guard = new AgentCompletionGuard()
    const information: AgentTaskPlan = {
      version: 1,
      summary: '信息任务',
      goals: [{
        id: 'info',
        description: '回答问题',
        capabilities: [],
        postconditions: [{
          id: 'answer',
          kind: 'information',
          description: '回答非空',
          toolNames: [],
          required: true,
        }],
      }],
      research: 'none',
      allowedSideEffects: [],
      stopCondition: '回答完成',
      createdBy: 'fallback',
    }
    const failed = [{
      status: 'failed' as const,
      error: '可选检索失败',
      receipt: {
        toolName: 'optional.search',
        status: 'failed' as const,
        startedAt: 1,
        completedAt: 2,
        idempotent: true,
      },
      evidence: [],
    }]
    expect(guard.verify(null, failed, '仍然可以回答', information).completed).toBe(true)

    const delivery = structuredClone(information)
    delivery.goals[0].postconditions = [{
      id: 'sent',
      kind: 'delivery',
      description: '发送图片',
      toolNames: ['karin.bot.send_message'],
      required: true,
      minimumCount: 1,
    }]
    expect(guard.verify(null, [], '已发送', delivery).completed).toBe(false)
  })

  it('persists atomic final events and deduplicates turn request keys', async () => {
    const { value } = await database()
    const thread = await value.getOrCreateThread('atomic-final', actor)
    const first = await value.createTurn(thread.id, actor.id, false, undefined, 'request-1')
    const duplicate = await value.createTurn(thread.id, actor.id, false, undefined, 'request-1')
    expect(duplicate).toBe(first)
    const final = await value.finalizeTurn({
      threadId: thread.id,
      turnId: first,
      state: 'completed',
      content: '唯一终态',
      publishFinal: true,
    })
    expect((await value.listMessages(thread.id)).filter(item => item.final)).toHaveLength(1)
    expect(await value.listTurnEvents(thread.id)).toContainEqual(
      expect.objectContaining({ id: final.event.id, type: 'turn.completed' })
    )
    await value.close()
  })

  it('stores oversized tool results as redacted valid JSON artifacts', async () => {
    const { value } = await database()
    const thread = await value.getOrCreateThread('tool-artifact', actor)
    const turnId = await value.createTurn(thread.id, actor.id)
    const registry = new AgentToolRegistry(value)
    registry.register({
      name: 'test.large-output',
      description: 'large output',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      idempotent: true,
      execute: () => ({ token: 'secret-value', text: 'x'.repeat(4000) }),
    })
    const result = await registry.executeWithReceipt(
      'test.large-output',
      {},
      {
        threadId: thread.id,
        turnId,
        actor,
        signal: new AbortController().signal,
        automated: false,
      },
      256
    )
    expect(result.data).toMatchObject({ truncated: true })
    const artifact = await value.getToolArtifact(result.receipt.artifactId!)
    expect(JSON.parse(artifact!.content)).toMatchObject({ token: '[REDACTED]' })
    registry.unregister('test.large-output')
    await value.close()
  })

  it('does not replay a delivery whose send outcome is unknown', async () => {
    const { value } = await database()
    const thread = await value.getOrCreateThread('unknown-delivery', actor)
    const turnId = await value.createTurn(thread.id, actor.id)
    const final = await value.finalizeTurn({
      threadId: thread.id,
      turnId,
      state: 'completed',
      content: '结果',
      publishFinal: true,
    })
    const lifecycle = new AgentMessageLifecycle(value)
    const dispatch = vi.fn(async () => ({}))
    const input = {
      threadId: thread.id,
      turnId,
      finalMessageId: final.finalMessageId!,
      channel: 'onebot',
      accountId: 'bot-1',
      contactKey: actor.contactKey,
      payload: '结果',
      dispatch,
    }
    expect((await lifecycle.deliver(input)).state).toBe('unknown_after_send')
    expect((await lifecycle.deliver(input)).state).toBe('unknown_after_send')
    expect(dispatch).toHaveBeenCalledTimes(1)
    await value.close()
  })

  it('fails closed when restart recovery finds an unknown non-idempotent call', async () => {
    const created = await database()
    const thread = await created.value.getOrCreateThread('restart-unsafe', actor)
    const turnId = await created.value.createTurn(thread.id, actor.id)
    await created.value.createToolCall(
      thread.id,
      turnId,
      { id: 'call-unsafe', name: 'test.send', arguments: {} },
      'external',
      'allow',
      'pending',
      { idempotent: false, restartSafe: false }
    )
    await created.value.close()

    const reopened = await database(created.directory)
    const journal = new AgentRunJournal(reopened.value, config)
    const claimed = await journal.claim()
    expect(claimed[0]).toMatchObject({ safe: false, unsafeTools: ['test.send'] })
    await reopened.value.close()
  })

  it('exposes only applied evolution changes in the read-only log', async () => {
    const { value } = await database()
    const candidate = await value.createEvolutionCandidate({
      target: 'skill',
      kind: 'declarative',
      sourceTurnIds: ['turn-1'],
      candidateVersion: 'v1',
      summary: '新增日志诊断 Skill',
      payload: { name: 'log-diagnostics' },
    })
    await value.addEvolutionEvent(candidate!.id, 'evaluation.passed', actor.id, {})
    await value.addEvolutionEvent(candidate!.id, 'promoted', actor.id, {
      skillId: 'skill-1',
    })

    expect(await value.listEvolutionLog()).toEqual([
      expect.objectContaining({
        candidateId: candidate!.id,
        action: 'improved',
        summary: '新增日志诊断 Skill',
        change: 'skill：log-diagnostics',
      }),
    ])
    const [entry] = await value.listEvolutionLog()
    expect(await value.deleteEvolutionLog(entry.id)).toBe(true)
    expect(await value.listEvolutionLog()).toEqual([])
    expect(await value.listEvolutionCandidates()).toEqual([
      expect.objectContaining({ id: candidate!.id }),
    ])

    await value.addEvolutionEvent(candidate!.id, 'promoted', actor.id, {
      skillId: 'skill-1',
    })
    expect(await value.clearEvolutionLog()).toBe(1)
    expect(await value.listEvolutionLog()).toEqual([])
    await value.close()
  })
})
