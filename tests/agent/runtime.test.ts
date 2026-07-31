import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentPolicy } from '../../packages/core/src/agent/policy/policy'
import { AgentRuntime } from '../../packages/core/src/agent/runtime/runtime'
import { AgentToolRegistry } from '../../packages/core/src/agent/tools/registry'
import { getAgentTriggerContent } from '../../packages/core/src/agent/ingress/message'

import type {
  AgentActor,
  AgentConfig,
  AgentModelProvider,
  AgentToolContext,
} from '../../packages/core/src/types/agent'
import type { Message } from '../../packages/core/src/types/event'
import type { AgentLearning } from '../../packages/core/src/agent/learning/learning'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const config = (): AgentConfig => ({
  version: 7,
  enabled: true,
  providers: [{
    id: 'fake',
    name: 'Fake',
    kind: 'custom',
    enabled: true,
    baseUrl: 'http://localhost/v1',
    apiKey: 'test-only',
    model: 'fake',
    timeout: 30000,
  }],
  routing: { primary: 'fake', fallback: [] },
  trigger: {
    private: true,
    groupMention: true,
    wakeWords: ['karin'],
  },
  limits: {
    maxToolRounds: 8,
    maxToolOutputBytes: 65536,
    maxRecentMessages: 40,
    maxSubagents: 3,
  },
  policy: {
    approvalTtlMs: 300000,
    hardDeny: ['*.delete'],
    rules: [],
    defaults: {
      read: 'allow',
      write: 'ask',
      external: 'ask',
      destructive: 'deny',
    },
  },
  learning: {
    memory: false,
    skills: false,
    reflection: { enabled: true, afterFailure: true, successInterval: 5 },
    curator: {
      enabled: true,
      intervalHours: 168,
      minIdleMinutes: 120,
      staleAfterDays: 30,
      archiveAfterDays: 90,
    },
    promotion: {
      autoMemory: true,
      autoRouting: true,
      autoDeclarativeSkills: true,
      minEvidence: 3,
      minSuccessRate: 0.8,
      maxRegressionRate: 0.05,
      autoRollback: true,
      rollbackWindow: 20,
    },
  },
  recovery: {
    enabled: true,
    maxCycles: 2,
    maxDiagnosticCalls: 8,
    maxDurationMs: 120000,
    researchPolicy: 'evidence-driven',
    repair: { requireApproval: true, workspaceRoots: [] },
  },
  tools: { disabled: [], disabledToolsets: [] },
  mcp: { enabled: false, servers: [] },
  scriptRuntime: {
    pythonExecutable: '',
    defaultTimeoutMs: 30000,
    maxTimeoutMs: 120000,
    defaultMaxOutputBytes: 65536,
    maxOutputBytes: 1048576,
  },
})

const actor: AgentActor = {
  id: 'user-1',
  role: 'admin',
  selfId: 'bot-1',
  scene: 'friend',
  contactKey: 'test:bot-1:friend:user-1',
}

const database = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-agent-test-'))
  directories.push(directory)
  const db = new AgentDatabase(directory)
  await db.init()
  return db
}

const learning = {
  contextFor: vi.fn(async () => ({ memories: [], skills: [] })),
  learn: vi.fn(async () => undefined),
} as unknown as AgentLearning

describe('Agent runtime', () => {
  it('executes structured tools and returns the final answer', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'test.echo',
      description: 'echo',
      inputSchema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { type: 'string' } },
      },
      risk: 'read',
      execute: input => ({ value: input.value }),
    })
    let call = 0
    const provider: AgentModelProvider = {
      name: 'fake',
      async complete () {
        call++
        if (call === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'test.echo',
                arguments: { value: 'hello' },
              },
            ],
          }
        }
        return { content: 'done', toolCalls: [] }
      },
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(config),
      provider,
      learning,
      config
    )

    const result = await runtime.runTurn({
      threadKey: actor.contactKey,
      actor,
      content: 'echo hello',
    })

    expect(result.state).toBe('completed')
    expect(result.content).toBe('done')
    expect(call).toBe(2)
    const messages = await db.listMessages(result.threadId)
    expect(messages.some(message => message.role === 'tool')).toBe(true)
    registry.unregister('test.echo')
    await db.close()
  })

  it('blocks a false image capability denial until media and delivery receipts verify', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'karin.browser.download',
      description: 'download image',
      tags: ['图片'],
      inputSchema: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: { url: { type: 'string' } },
      },
      risk: 'read',
      idempotent: true,
      execute: () => ({
        path: 'controlled/cat.png',
        contentType: 'image/png',
        bytes: 1024,
      }),
    }, true)
    registry.register({
      name: 'karin.bot.send_message',
      description: 'send image',
      tags: ['发送图片'],
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'external',
      execute: () => ({
        delivered: true,
        channel: 'onebot',
        textSegments: 0,
        imageSegments: 1,
      }),
    }, true)
    let call = 0
    const provider: AgentModelProvider = {
      name: 'fake',
      async complete () {
        call++
        if (call === 1) {
          return {
            content: '我没有发送图片到聊天框的工具。',
            toolCalls: [],
          }
        }
        if (call === 2) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'download-cat',
                name: 'karin.browser.download',
                arguments: { url: 'https://example.test/cat.png' },
              },
              {
                id: 'send-cat',
                name: 'karin.bot.send_message',
                arguments: {},
              },
            ],
          }
        }
        return { content: '猫图已发送。', toolCalls: [] }
      },
    }
    const permissive = () => {
      const value = config()
      value.policy.defaults.external = 'allow'
      return value
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(permissive),
      provider,
      learning,
      permissive
    )
    const events: string[] = []
    const result = await runtime.runTurn({
      threadKey: 'verified-image',
      actor,
      content: '发一张猫的照片给我',
      onEvent: event => {
        events.push(event.type)
      },
    })

    expect(result).toMatchObject({
      state: 'completed',
      content: '猫图已发送。',
    })
    expect(call).toBe(3)
    expect(events).toContain('recovery.started')
    expect(events).toContain('recovery.completed')
    expect(events.filter(type => type === 'verification.completed')).toHaveLength(2)
    registry.unregister('karin.browser.download')
    registry.unregister('karin.bot.send_message')
    await db.close()
  })

  it('drops an orphaned Tool message when the recent-history window cuts off its assistant call', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    const limitedConfig = () => ({
      ...config(),
      limits: { ...config().limits, maxRecentMessages: 3 },
    })
    const thread = await db.getOrCreateThread('trimmed-tool-history', actor)
    const oldTurn = await db.createTurn(thread.id, actor.id)
    await db.addMessage(thread.id, oldTurn, 'assistant', '', {
      toolCalls: [{ id: 'trimmed-call', name: 'test.echo', arguments: {} }],
    })
    await db.addMessage(thread.id, oldTurn, 'tool', '{"ok":true}', {
      name: 'test.echo',
      toolCallId: 'trimmed-call',
    })
    await db.addMessage(thread.id, oldTurn, 'assistant', '旧回合完成')

    const provider: AgentModelProvider = {
      name: 'fake',
      async complete (request) {
        expect(request.messages.find(message => message.role !== 'system')?.role).not.toBe('tool')
        return { content: '新回合完成', toolCalls: [] }
      },
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(limitedConfig),
      provider,
      learning,
      limitedConfig
    )

    const result = await runtime.runTurn({
      threadKey: thread.threadKey,
      actor,
      content: '继续',
    })

    expect(result).toMatchObject({ state: 'completed', content: '新回合完成' })
    await db.close()
  })

  it('persists a thread-scoped approval without weakening the policy baseline', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    const execute = vi.fn(async () => ({ changed: true }))
    registry.register({
      name: 'test.write',
      description: 'write',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'write',
      execute,
    })
    let call = 0
    const provider: AgentModelProvider = {
      name: 'fake',
      async complete () {
        call++
        return call % 2 === 1
          ? {
            content: '',
            toolCalls: [{ id: `call-write-${call}`, name: 'test.write', arguments: {} }],
          }
          : { content: 'approved result', toolCalls: [] }
      },
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(config),
      provider,
      learning,
      config
    )

    const waiting = await runtime.runTurn({
      threadKey: 'approval-thread',
      actor,
      content: 'change it',
    })
    expect(waiting.state).toBe('waiting_approval')
    expect(execute).not.toHaveBeenCalled()

    const completed = await runtime.resolveApproval(
      waiting.approvalId!,
      'approved',
      actor,
      'thread'
    )
    expect(completed.state).toBe('completed')
    expect(execute).toHaveBeenCalledOnce()

    const reused = await runtime.runTurn({
      threadKey: 'approval-thread',
      actor: { ...actor, id: 'another-user' },
      content: 'change it again',
    })
    expect(reused.state).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await db.listThreadToolGrants(reused.threadId)).toEqual([
      expect.objectContaining({ toolName: 'test.write', mode: 'tool' }),
    ])
    registry.unregister('test.write')
    await db.close()
  })

  it('lets the bound channel session owner approve a Web-started turn but rejects other members', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'test.channel-write',
      description: 'write',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'write',
      execute: async () => ({ changed: true }),
    })
    let call = 0
    const provider: AgentModelProvider = {
      name: 'fake',
      async complete () {
        call++
        return call === 1
          ? {
            content: '',
            toolCalls: [{
              id: 'call-channel-write',
              name: 'test.channel-write',
              arguments: {},
            }],
          }
          : { content: 'channel approved', toolCalls: [] }
      },
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(config),
      provider,
      learning,
      config
    )
    const channelOwner: AgentActor = {
      id: 'group-owner-session',
      role: 'all',
      selfId: 'tg-bot',
      scene: 'group',
      contactKey: 'telegram:tg-bot:group:10001',
      origin: {
        channel: 'telegram',
        protocol: 'telegram',
        accountId: 'tg-bot',
        accountName: 'TG Bot',
        contactKey: 'telegram:tg-bot:group:10001',
        contactId: '10001',
        contactSubId: '',
        contactName: 'Team',
      },
    }
    await runtime.currentSession(channelOwner)
    const waiting = await runtime.runTurn({
      threadKey: channelOwner.contactKey,
      actor: {
        ...channelOwner,
        id: 'web-admin',
        role: 'admin',
      },
      content: 'change from Web',
    })
    const otherMember = { ...channelOwner, id: 'other-member' }

    expect(waiting.state).toBe('waiting_approval')
    expect(await runtime.listPendingSessionApprovals(channelOwner)).toHaveLength(1)
    expect(await runtime.listPendingSessionApprovals(otherMember)).toHaveLength(0)
    expect(await runtime.listPendingSessionApprovals({
      ...otherMember,
      role: 'group.admin',
    })).toHaveLength(1)
    await expect(runtime.resolveApproval(
      waiting.approvalId!,
      'approved',
      otherMember
    )).rejects.toThrow('会话发起人或管理员')

    const completed = await runtime.resolveApproval(
      waiting.approvalId!,
      'approved',
      channelOwner,
      'thread'
    )
    expect(completed.content).toBe('channel approved')
    expect(await db.listThreadToolGrants(waiting.threadId)).toEqual([
      expect.objectContaining({ actorId: channelOwner.id, toolName: 'test.channel-write' }),
    ])
    registry.unregister('test.channel-write')
    await db.close()
  })

  it('recursively stops a waiting approval and marks the turn interrupted', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    const execute = vi.fn(async () => ({ changed: true }))
    registry.register({
      name: 'test.waiting-write',
      description: 'write',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'write',
      execute,
    })
    const provider: AgentModelProvider = {
      name: 'fake',
      async complete () {
        return {
          content: '',
          toolCalls: [{
            id: 'call-stop',
            name: 'test.waiting-write',
            arguments: {},
          }],
        }
      },
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(config),
      provider,
      learning,
      config
    )
    const waiting = await runtime.runTurn({
      threadKey: 'stop-thread',
      actor,
      content: 'change it',
    })

    const stopped = await runtime.interruptTree(waiting.threadId)
    expect(stopped).toMatchObject({
      interrupted: true,
      turns: 1,
      approvals: 1,
    })
    expect(execute).not.toHaveBeenCalled()
    expect((await db.listTurns(waiting.threadId))[0].state).toBe('interrupted')
    expect((await db.listApprovalsByThread(waiting.threadId))[0].status).toBe('expired')
    registry.unregister('test.waiting-write')
    await db.close()
  })

  it('runs named read-only subagents in parallel and lets the parent synthesize partial results', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    const write = vi.fn(async () => ({ changed: true }))
    registry.register({
      name: 'test.parallel-write',
      description: 'write',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'write',
      execute: write,
    })

    let activeChildren = 0
    let peakChildren = 0
    let batchOutput: Array<Record<string, unknown>> = []
    const provider: AgentModelProvider = {
      name: 'fake',
      async complete (request) {
        const user = request.messages.findLast(message => message.role === 'user')?.content || ''
        const last = request.messages.at(-1)
        if (user === '复杂任务' && last?.role !== 'tool') {
          return {
            content: '',
            toolCalls: [{
              id: 'delegate-many',
              name: 'karin.agent.delegate_many',
              arguments: {
                tasks: [
                  { id: 'first', label: '第一项', prompt: '子任务一' },
                  { id: 'failed', label: '失败项', prompt: '子任务失败' },
                  { id: 'write', label: '越权项', prompt: '子任务越权' },
                ],
              },
            }],
          }
        }
        if (user === '复杂任务' && last?.role === 'tool') {
          batchOutput = JSON.parse(last.content).output
          return { content: '主 Agent 已汇总。', toolCalls: [] }
        }
        if (last?.role === 'tool') {
          return { content: `${user}已完成`, toolCalls: [] }
        }

        activeChildren++
        peakChildren = Math.max(peakChildren, activeChildren)
        await new Promise(resolve => setTimeout(resolve, 30))
        activeChildren--
        if (user === '子任务失败') throw new Error('模拟子任务失败')
        if (user === '子任务越权') {
          return {
            content: '',
            toolCalls: [{
              id: 'forbidden-write',
              name: 'test.parallel-write',
              arguments: {},
            }],
          }
        }
        return { content: `${user}结果`, toolCalls: [] }
      },
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(config),
      provider,
      learning,
      config
    )
    registry.register({
      name: 'karin.agent.delegate_many',
      description: 'parallel delegation',
      inputSchema: {
        type: 'object',
        required: ['tasks'],
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              required: ['id', 'label', 'prompt'],
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                prompt: { type: 'string' },
              },
            },
          },
        },
      },
      risk: 'read',
      execute: (input, context) => runtime.delegateMany(
        context,
        input.tasks as Array<{ id: string; label: string; prompt: string }>
      ),
    }, true)
    const parent = await db.getOrCreateThread('parallel-root', actor)
    await db.setThreadModel(parent.id, 'fake', 'fake-special')

    const result = await runtime.runTurn({
      threadKey: 'parallel-root',
      actor,
      content: '复杂任务',
    })

    expect(result.content).toBe('主 Agent 已汇总。')
    expect(peakChildren).toBe(3)
    expect(batchOutput.map(item => item.id)).toEqual(['first', 'failed', 'write'])
    expect(batchOutput).toEqual([
      expect.objectContaining({ id: 'first', state: 'completed', content: '子任务一结果' }),
      expect.objectContaining({ id: 'failed', state: 'failed' }),
      expect.objectContaining({ id: 'write', state: 'completed', content: '子任务越权已完成' }),
    ])
    expect(write).not.toHaveBeenCalled()
    const childIds = (await db.getThreadTreeIds(parent.id)).filter(id => id !== parent.id)
    expect(childIds).toHaveLength(3)
    await Promise.all(childIds.map(async id => {
      expect(await db.getThread(id)).toEqual(expect.objectContaining({
        parentThreadId: parent.id,
        modelProviderId: 'fake',
        modelName: 'fake-special',
      }))
      expect(await db.listApprovalsByThread(id)).toHaveLength(0)
    }))
    registry.unregister('karin.agent.delegate_many')
    registry.unregister('test.parallel-write')
    await db.close()
  })

  it('queues batches at the global subagent limit and cancels queued work with its parent', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    const limitedConfig = () => ({
      ...config(),
      limits: { ...config().limits, maxSubagents: 2 },
    })
    let active = 0
    let peak = 0
    let started = 0
    let notifyStarted = () => undefined
    let releaseRunning = () => undefined
    const bothStarted = new Promise<void>(resolve => {
      notifyStarted = resolve
    })
    const holdRunning = new Promise<void>(resolve => {
      releaseRunning = resolve
    })
    const provider: AgentModelProvider = {
      name: 'fake',
      async complete () {
        active++
        peak = Math.max(peak, active)
        started++
        if (started === 2) notifyStarted()
        await holdRunning
        active--
        return { content: '完成', toolCalls: [] }
      },
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(limitedConfig),
      provider,
      learning,
      limitedConfig
    )
    const firstParent = await db.getOrCreateThread('limit-parent-1', actor)
    const secondParent = await db.getOrCreateThread('limit-parent-2', actor)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const context = (
      threadId: string,
      turnId: string,
      controller: AbortController
    ): AgentToolContext => ({
      threadId,
      turnId,
      actor,
      signal: controller.signal,
      automated: false,
    })

    const first = runtime.delegateMany(
      context(firstParent.id, 'limit-turn-1', firstController),
      [
        { id: 'hold-1', label: '占用一', prompt: '占用一' },
        { id: 'hold-2', label: '占用二', prompt: '占用二' },
      ]
    )
    await bothStarted
    const second = runtime.delegateMany(
      context(secondParent.id, 'limit-turn-2', secondController),
      [
        { id: 'queued-1', label: '排队一', prompt: '排队一' },
        { id: 'queued-2', label: '排队二', prompt: '排队二' },
      ]
    )
    secondController.abort(new Error('取消第二批'))
    const cancelled = await second
    releaseRunning()
    const completed = await first

    expect(peak).toBe(2)
    expect(completed.every(item => item.state === 'completed')).toBe(true)
    expect(cancelled).toEqual([
      expect.objectContaining({ id: 'queued-1', state: 'failed', error: '取消第二批' }),
      expect.objectContaining({ id: 'queued-2', state: 'failed', error: '取消第二批' }),
    ])
    expect(await db.getThreadTreeIds(secondParent.id)).toEqual([secondParent.id])
    await db.close()
  })
})

describe('Agent ingress trigger', () => {
  it('always accepts private unmatched messages when enabled', () => {
    const event = {
      msg: 'hello',
      isPrivate: true,
    } as Message
    expect(getAgentTriggerContent(event, config())).toBe('hello')
  })

  it('requires mention or wake word in groups', () => {
    const event = {
      msg: 'hello',
      isPrivate: false,
      atBot: false,
    } as Message
    expect(getAgentTriggerContent(event, config())).toBeNull()
    expect(getAgentTriggerContent({ ...event, atBot: true } as Message, config())).toBe('hello')
    expect(getAgentTriggerContent({ ...event, msg: 'karin status' } as Message, config())).toBe(
      'status'
    )
  })
})
