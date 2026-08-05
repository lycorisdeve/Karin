import { createHash, randomUUID } from 'node:crypto'
import { agentHookEmit } from '@/hooks/agent'
import { deliverAgentResult, dispatchAgentResult } from '../ingress/delivery'
import { replyAgentResult } from '../ingress/reply'
import { agentModelContent } from '../ingress/model-content'
import { persistAgentMessageImages } from '../persistence/media'

import type {
  AgentActor,
  AgentConfig,
  AgentDeliveryReceipt,
  AgentDelegateBatchResult,
  AgentDelegateBatchTask,
  AgentModelMessage,
  AgentModelProvider,
  AgentStreamEvent,
  AgentTaskPlan,
  AgentTaskList,
  AgentToolCall,
  AgentToolContext,
  AgentToolResultEnvelope,
  AgentTurnInput,
  AgentTurnResult,
} from '@/types/agent'
import type { Message } from '@/types/event'
import type { AgentApprovalRecord, AgentDatabase, AgentThreadRecord } from '../persistence/database'
import type { AgentLearning } from '../learning/learning'
import type { AgentPolicy } from '../policy/policy'
import type { AgentToolRegistry } from '../tools/registry'
import { AgentEventBus } from './events'
import { AgentTaskLedger } from '../tasks/ledger'
import { AgentPromptAssembler } from '../prompt/assembler'
import { AgentCompletionGuard } from '../execution/completion-guard'
import { AgentExecutionBudget } from '../execution/budget'
import { AgentEvolutionPipeline } from '../evolution'
import { AgentContextEngine } from '../context/engine'
import { AgentMessageLifecycle } from '../delivery/lifecycle'
import { AgentRunJournal } from './journal'
import {
  AgentTurnRecovery,
  type AgentVerificationResult,
} from './recovery'

interface ExecutionState {
  input: AgentTurnInput
  thread: AgentThreadRecord
  turnId: string
  messages: AgentModelMessage[]
  controller: AbortController
  round: number
  pendingCalls: AgentToolCall[]
  waitingCall?: AgentToolCall
  latestAssistant: string
  plan?: AgentTaskPlan
  tasks: AgentTaskList | null
  needsTaskPlan: boolean
  completionRetries: number
  toolResults: AgentToolResultEnvelope[]
  recoveryCycle: number
  recoveryStartedAt: number
  diagnosticCalls: number
  executionBudget: AgentExecutionBudget
  discoveryQuery: string
  startedAt: number
  currentOperation: string
  superseded: boolean
  loadedSkillTools: Set<string>
  finishPromise?: Promise<AgentTurnResult>
  removeParentAbortListener?: () => void
}

export interface AgentInteractiveTurnSnapshot {
  threadId: string
  turnId: string
  elapsedMs: number
  round: number
  maxRounds: number
  operation: string
}

export interface AgentInteractiveSubmission {
  requestId: string
  mode: 'started' | 'supplemented'
  interrupted?: AgentInteractiveTurnSnapshot
  result: Promise<AgentTurnResult>
  isLatest: () => boolean
  release: () => void
}

interface PendingInteractiveTurn {
  requestId: string
  input: AgentTurnInput
  rootContent: string
  supplements: string[]
  pendingMessages: string[]
  sourceStates: ExecutionState[]
  fromTurnId?: string
  interrupting?: Promise<void>
}

interface SubagentWaiter {
  signal: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  abort: () => void
}

const safeJson = (value: unknown) => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const containsSensitiveInput = (value: unknown, key = ''): boolean => {
  if (/authorization|cookie|token|password|api[-_]?key|secret/i.test(key)) return true
  if (Array.isArray(value)) return value.some(item => containsSensitiveInput(item))
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .some(([itemKey, item]) => containsSensitiveInput(item, itemKey))
  }
  return false
}

const redactSensitiveInput = (value: unknown, key = ''): unknown => {
  if (/authorization|cookie|token|password|api[-_]?key|secret/i.test(key)) {
    return '[REDACTED]'
  }
  if (Array.isArray(value)) return value.map(item => redactSensitiveInput(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([itemKey, item]) => [itemKey, redactSensitiveInput(item, itemKey)])
    )
  }
  return value
}

export class AgentRuntime {
  readonly events: AgentEventBus
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly activeTurns = new Map<string, ExecutionState>()
  private readonly pendingApprovals = new Map<string, ExecutionState>()
  private readonly approvalTimers = new Map<string, NodeJS.Timeout>()
  private readonly deletingThreads = new Set<string>()
  private readonly stoppingThreads = new Set<string>()
  private readonly subagentWaiters: SubagentWaiter[] = []
  private readonly pendingInteractive = new Map<string, PendingInteractiveTurn>()
  private readonly interactiveOwners = new Map<string, string>()
  private activeSubagents = 0
  private readonly recovery: AgentTurnRecovery
  private readonly taskLedger: AgentTaskLedger
  private readonly promptAssembler: AgentPromptAssembler
  private readonly completionGuard: AgentCompletionGuard
  private readonly contextEngine: AgentContextEngine
  private readonly messageLifecycle: AgentMessageLifecycle
  private readonly runJournal: AgentRunJournal
  readonly evolution: AgentEvolutionPipeline

  constructor (
    readonly database: AgentDatabase,
    readonly registry: AgentToolRegistry,
    private readonly policy: AgentPolicy,
    private readonly provider: AgentModelProvider,
    learning: AgentLearning,
    private readonly getConfig: () => AgentConfig
  ) {
    this.events = new AgentEventBus(database)
    this.recovery = new AgentTurnRecovery(provider, getConfig)
    this.taskLedger = new AgentTaskLedger(database, getConfig)
    this.promptAssembler = new AgentPromptAssembler(this.taskLedger)
    this.completionGuard = new AgentCompletionGuard()
    this.contextEngine = new AgentContextEngine(database, getConfig)
    this.messageLifecycle = new AgentMessageLifecycle(database)
    this.runJournal = new AgentRunJournal(database, getConfig)
    this.evolution = new AgentEvolutionPipeline(learning)
  }

  runTurn (input: AgentTurnInput): Promise<AgentTurnResult> {
    return this.enqueue(input.threadKey, () => this.beginTurn(input))
  }

  async recoverPendingTurns () {
    const recoverable = await this.runJournal.claim()
    for (const item of recoverable) {
      for (const call of item.interruptedCalls) {
        const message = item.safe
          ? 'Karin 重启中断；该 Tool 可由恢复 Turn 安全重新调用'
          : 'Karin 重启后无法确认该非幂等 Tool 是否产生副作用'
        await this.database.completeToolCall(call.id, undefined, message)
        await this.database.addMessage(item.thread.id, item.turnId, 'tool', message, {
          name: call.name,
          toolCallId: call.id,
        })
      }
      const oldFinal = await this.database.finalizeTurn({
        threadId: item.thread.id,
        turnId: item.turnId,
        state: item.safe ? 'interrupted' : 'failed',
        content: item.safe
          ? ''
          : `Karin 重启后无法确认以下操作是否已执行：${item.unsafeTools.join('、')}。` +
            '为避免重复副作用，系统没有自动重放，请人工核对后继续。',
        error: item.safe ? '由恢复 Turn 接管' : '存在未知的非幂等副作用',
        publishFinal: !item.safe,
      })
      this.events.broadcast(oldFinal.event)
      if (!item.safe) {
        await this.deliverThreadResult(item.thread, {
          threadId: item.thread.id,
          turnId: item.turnId,
          state: 'failed',
          content: `Karin 重启后无法确认以下操作是否已执行：${item.unsafeTools.join('、')}。` +
            '为避免重复副作用，系统没有自动重放，请人工核对后继续。',
          finalMessageId: oldFinal.finalMessageId || undefined,
        })
        continue
      }
      const rootContent = item.userMessages[0] || '继续处理重启前未完成的任务'
      const actor: AgentActor = {
        id: item.thread.actorId,
        role: 'all',
        selfId: item.thread.accountId,
        scene: item.thread.scene,
        contactKey: item.thread.contactKey,
        origin: {
          channel: item.thread.channel,
          protocol: item.thread.protocol,
          accountId: item.thread.accountId,
          accountName: item.thread.accountName,
          contactKey: item.thread.contactKey,
          contactId: item.thread.contactId,
          contactSubId: item.thread.contactSubId,
          contactName: item.thread.contactName,
        },
      }
      const result = await this.runTurn({
        threadKey: item.thread.threadKey,
        actor,
        content: '继续处理重启前未完成的任务',
        idempotencyKey: `restart-recovery:${item.turnId}`,
        resume: {
          fromTurnId: item.turnId,
          rootContent,
          supplements: item.userMessages.slice(1),
          pendingMessages: [],
          toolResults: item.receipts,
        },
      })
      if (result.content) await this.deliverThreadResult(item.thread, result)
    }
    return recoverable.length
  }

  submitInteractiveTurn (input: AgentTurnInput): AgentInteractiveSubmission {
    const requestId = randomUUID()
    const existing = this.pendingInteractive.get(input.threadKey)
    const active = [...this.activeTurns.values()].find(state =>
      state.input.threadKey === input.threadKey &&
      !state.input.automated &&
      !state.input.parentThreadId
    )
    const sourceStates = [
      ...(existing?.sourceStates || []),
      ...(active && !existing?.sourceStates.includes(active) ? [active] : []),
    ]
    const rootContent =
      active?.input.resume?.rootContent ||
      existing?.rootContent ||
      active?.input.content ||
      input.content
    const supplements = active || existing
      ? [
        ...(active?.input.resume?.supplements || existing?.supplements || []),
        input.content,
      ]
      : []
    const pendingMessages = [
      ...(existing?.pendingMessages || []),
      ...(active || existing ? [input.content] : []),
    ]
    const interrupted = active
      ? this.interactiveSnapshot(active)
      : undefined
    const pending: PendingInteractiveTurn = {
      requestId,
      input,
      rootContent,
      supplements,
      pendingMessages,
      sourceStates,
      fromTurnId: active?.turnId || existing?.fromTurnId,
      interrupting: existing?.interrupting,
    }
    this.pendingInteractive.set(input.threadKey, pending)
    this.interactiveOwners.set(input.threadKey, requestId)

    if (active) {
      active.superseded = true
      pending.interrupting = Promise.all([
        this.events.publish(
          active.thread.id,
          'turn.interrupting',
          interrupted,
          active.turnId
        ),
        this.interruptTree(active.thread.id),
      ]).then(() => undefined).catch(error => {
        logger.error(new Error('[agent][turn] 交互回合抢占失败', { cause: error }))
      })
    }

    const result = this.enqueue(input.threadKey, async () => {
      const latest = this.pendingInteractive.get(input.threadKey)
      if (!latest || latest.requestId !== requestId) {
        const source = active || existing?.sourceStates.at(-1)
        return {
          threadId: source?.thread.id || '',
          turnId: source?.turnId || '',
          state: 'interrupted' as const,
          content: '',
        }
      }
      await latest.interrupting
      const pendingMessages = [...latest.pendingMessages]
      latest.pendingMessages = []
      const inherited = this.uniqueToolResults([
        ...(latest.input.resume?.toolResults || []),
        ...latest.sourceStates.flatMap(state => state.toolResults),
      ])
      return this.beginTurn({
        ...latest.input,
        interactiveRequestId: requestId,
        resume: latest.fromTurnId
          ? {
            fromTurnId: latest.fromTurnId,
            rootContent: latest.rootContent,
            supplements: latest.supplements,
            pendingMessages: pendingMessages.length
              ? pendingMessages
              : [latest.input.content],
            toolResults: inherited,
          }
          : undefined,
      })
    })
    return {
      requestId,
      mode: active || existing ? 'supplemented' : 'started',
      interrupted,
      result,
      isLatest: () => this.interactiveOwners.get(input.threadKey) === requestId,
      release: () => {
        if (this.interactiveOwners.get(input.threadKey) === requestId) {
          this.interactiveOwners.delete(input.threadKey)
        }
        if (this.pendingInteractive.get(input.threadKey)?.requestId === requestId) {
          this.pendingInteractive.delete(input.threadKey)
        }
      },
    }
  }

  private interactiveSnapshot (state: ExecutionState): AgentInteractiveTurnSnapshot {
    return {
      threadId: state.thread.id,
      turnId: state.turnId,
      elapsedMs: Math.max(0, Date.now() - state.startedAt),
      round: Math.max(1, state.round + 1),
      maxRounds: this.getConfig().limits.maxToolRounds,
      operation: state.currentOperation || '模型思考',
    }
  }

  private uniqueToolResults (results: AgentToolResultEnvelope[]) {
    const seen = new Set<string>()
    return results.filter(result => {
      const key = [
        result.receipt.toolName,
        result.receipt.startedAt,
        result.receipt.completedAt,
        result.status,
      ].join(':')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  tasksForThread (threadId: string, history = false) {
    return history
      ? this.taskLedger.history(threadId)
      : this.taskLedger.read(threadId)
  }

  startTurn (input: AgentTurnInput) {
    const submission = this.submitInteractiveTurn(input)
    submission.result
      .then(result => submission.isLatest() ? input.onResult?.(result) : undefined)
      .catch(error => {
        logger.error(new Error(
          `[agent][turn] 异步回合 ${submission.requestId} 执行失败`,
          { cause: error }
        ))
      })
      .finally(() => submission.release())
    return submission
  }

  async deliverThreadResult (
    thread: AgentThreadRecord,
    result: AgentTurnResult,
    actorId = 'system'
  ) {
    try {
      if (!result.finalMessageId) {
        const delivered = await deliverAgentResult(thread, result)
        if (!delivered) return false
        await this.recordDelivery(thread, result, actorId)
        return true
      }
      const receipt = await this.messageLifecycle.deliver({
        threadId: thread.id,
        turnId: result.turnId,
        finalMessageId: result.finalMessageId,
        channel: thread.channel,
        accountId: thread.accountId,
        contactKey: thread.contactKey,
        payload: result.content,
        dispatch: async () => {
          const sent = await dispatchAgentResult(thread, result)
          return sent || {}
        },
      })
      await this.recordDelivery(thread, result, actorId, undefined, receipt)
      return receipt.state === 'sent'
    } catch (error) {
      await this.recordDelivery(thread, result, actorId, error as Error)
      return false
    }
  }

  async deliverEventResult (
    event: Message,
    result: AgentTurnResult,
    actorId: string
  ) {
    const thread = await this.database.getThread(result.threadId)
    if (!thread || !result.content) return false
    try {
      if (!result.finalMessageId) {
        await replyAgentResult(event, result)
        await this.recordDelivery(thread, result, actorId)
        return true
      }
      const receipt = await this.messageLifecycle.deliver({
        threadId: thread.id,
        turnId: result.turnId,
        finalMessageId: result.finalMessageId,
        channel: thread.channel,
        accountId: thread.accountId,
        contactKey: thread.contactKey,
        payload: result.content,
        dispatch: async () => {
          const sent = await replyAgentResult(event, result)
          return {
            messageId: String(sent?.messageId || sent?.message_id || ''),
          }
        },
      })
      await this.recordDelivery(thread, result, actorId, undefined, receipt)
      return receipt.state === 'sent'
    } catch (error) {
      await this.recordDelivery(thread, result, actorId, error as Error)
      throw error
    }
  }

  private async recordDelivery (
    thread: AgentThreadRecord,
    result: AgentTurnResult,
    actorId: string,
    error?: Error,
    receipt?: AgentDeliveryReceipt
  ) {
    const completed = !error && (!receipt || receipt.state === 'sent')
    const action = completed ? 'thread.delivery.completed' : 'thread.delivery.failed'
    const detail = {
      channel: thread.channel,
      accountId: thread.accountId,
      state: receipt?.state,
      operationId: receipt?.operationId,
      ...(error ? { error: error.message } : {}),
    }
    await this.database.audit(actorId, action, thread.id, detail, thread.id)
    await this.events.publish(
      thread.id,
      completed ? 'delivery.completed' : 'delivery.failed',
      error
        ? { channel: thread.channel, error: error.message }
        : { channel: thread.channel, ...receipt },
      result.turnId
    )
  }

  async currentSession (actor: AgentActor) {
    return this.database.getOrCreateSession(actor)
  }

  async newSession (actor: AgentActor) {
    const current = await this.database.getOrCreateSession(actor)
    await this.interruptTree(current.id)
    const created = await this.database.createSession(actor)
    await this.database.audit(actor.id, 'session.new', created.id, {
      previousThreadId: current.id,
    }, created.id)
    return created
  }

  listSelectableModels () {
    return this.getConfig().providers
      .filter(profile => profile.enabled && profile.apiKey)
      .flatMap(profile => {
        const models = [...new Set([
          profile.model,
          ...(profile.discoveredModels || []),
        ].filter(Boolean))]
        return models.map(model => ({
          providerId: profile.id,
          providerName: profile.name,
          model,
        }))
      })
  }

  async describeThreadModel (threadId: string) {
    const thread = await this.database.getThread(threadId)
    if (!thread) throw new Error('会话不存在')
    const config = this.getConfig()
    const providerId = thread.modelProviderId || config.routing.primary
    const profile = config.providers.find(item => item.id === providerId)
    return {
      thread,
      inherited: !thread.modelProviderId,
      providerId,
      providerName: profile?.name || providerId || '未配置 Provider',
      model: thread.modelName || profile?.model || '',
      models: this.listSelectableModels(),
    }
  }

  async setThreadModel (
    threadId: string,
    actor: AgentActor,
    providerId: string | null,
    model: string | null
  ) {
    const thread = await this.database.getThread(threadId)
    if (!thread) throw new Error('会话不存在')
    if (
      actor.id !== thread.actorId &&
      !['master', 'admin'].includes(actor.role)
    ) {
      throw new Error('只有会话发起者或管理员可以切换模型')
    }
    if (providerId || model) {
      if (!providerId || !model) throw new Error('Provider 和模型必须同时提供')
      const profile = this.getConfig().providers.find(item => item.id === providerId)
      if (!profile?.enabled || !profile.apiKey) throw new Error(`Provider 不可用: ${providerId}`)
      const available = new Set([profile.model, ...(profile.discoveredModels || [])].filter(Boolean))
      if (!available.has(model)) throw new Error(`模型不在可用列表中: ${providerId} ${model}`)
    }
    const updated = await this.database.setThreadModel(threadId, providerId, model)
    await this.database.audit(
      actor.id,
      providerId ? 'thread.model.set' : 'thread.model.reset',
      threadId,
      { providerId, model },
      threadId
    )
    return updated
  }

  async setSessionModel (
    actor: AgentActor,
    providerId: string | null,
    model: string | null
  ) {
    const thread = await this.currentSession(actor)
    return this.setThreadModel(thread.id, actor, providerId, model)
  }

  async listPendingSessionApprovals (actor: AgentActor) {
    const root = await this.database.getOrCreateSession(actor)
    const ids = await this.database.getThreadTreeIds(root.id)
    const approvals = (
      await Promise.all(ids.map(id => this.database.listApprovalsByThread(id)))
    ).flat().filter(item => item.status === 'pending')
    const visible = ['master', 'admin'].includes(actor.role)
      ? approvals
      : (await Promise.all(approvals.map(async item => {
        try {
          await this.validateApproval(item, actor)
          return item
        } catch {
          return null
        }
      }))).filter((item): item is AgentApprovalRecord => Boolean(item))
    return visible.sort((left, right) => right.createdAt - left.createdAt)
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) || Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const tracked = current.finally(() => {
      if (this.queues.get(key) === tracked) this.queues.delete(key)
    })
    this.queues.set(key, tracked)
    return tracked as Promise<T>
  }

  private async beginTurn (input: AgentTurnInput) {
    if (this.deletingThreads.has(input.threadKey)) throw new Error('Thread 正在删除')
    const thread = await this.database.getOrCreateThread(
      input.threadKey,
      input.actor,
      input.parentThreadId
    )
    if (this.stoppingThreads.has(thread.id)) throw new Error('Thread 正在停止')
    if (thread.archivedAt) throw new Error('已归档的 Thread 不能继续对话，请先恢复')
    if (input.idempotencyKey) {
      const existing = await this.database.getTurnResultByRequestKey(
        thread.id,
        input.idempotencyKey
      )
      if (existing) return existing
    }
    const turnId = await this.database.createTurn(
      thread.id,
      input.actor.id,
      input.automated,
      input.resume?.fromTurnId,
      input.idempotencyKey
    )
    const attachments = input.event?.image.length
      ? await persistAgentMessageImages(this.database, thread.id, input.event.image)
      : []
    const pendingMessages = input.resume?.pendingMessages?.length
      ? input.resume.pendingMessages
      : [input.content]
    for (const [index, content] of pendingMessages.entries()) {
      await this.database.addMessage(thread.id, turnId, 'user', content, {
        attachments: index === pendingMessages.length - 1 ? attachments : [],
        sourceKey: input.idempotencyKey
          ? `${input.idempotencyKey}:${index}`
          : undefined,
      })
    }
    if (input.resume) {
      await this.taskLedger.resume(
        thread.id,
        turnId,
        input.actor.id,
        pendingMessages
      )
    }

    const historyWindow = await this.database.listMessages(
      thread.id,
      500
    )
    const selectedProvider = this.getConfig().providers.find(
      profile => profile.id === thread.modelProviderId
    ) || this.getConfig().providers.find(
      profile => profile.id === this.getConfig().routing.primary
    )
    const selectedModel = thread.modelName || selectedProvider?.model || ''
    const calibrationKey = `${selectedProvider?.id || 'provider'}:${selectedModel}`
    const preparedContext = await this.contextEngine.prepare({
      threadId: thread.id,
      messages: historyWindow,
      legacySummary: thread.summary,
      contextWindowTokens: selectedProvider?.contextWindowTokens,
      calibrationKey,
    })
    let history = preparedContext.history
    const firstRecentNonTool = history.findIndex(message => message.role !== 'tool')
    history = firstRecentNonTool < 0 ? [] : history.slice(firstRecentNonTool)
    const summary = preparedContext.summary
    const firstNonTool = history.findIndex(message => message.role !== 'tool')
    const modelHistory = firstNonTool < 0 ? [] : history.slice(firstNonTool)
    const learned = await this.evolution.retrieval.contextFor(
      thread.id,
      turnId,
      input.actor,
      input.content
    )
    const tasks = await this.taskLedger.read(thread.id)
    const system = this.promptAssembler.build({
      memories: learned.memories,
      skills: learned.skills,
      tasks,
      summary,
      origin: input.actor.origin,
    })
    const messages: AgentModelMessage[] = [
      { role: 'system', content: system },
      ...modelHistory.map(message => ({
        role: message.role,
        content: message.content,
        name: message.name,
        toolCallId: message.toolCallId,
        toolCalls: message.toolCalls.length ? message.toolCalls : undefined,
      })),
    ]
    if (input.resume) {
      messages.splice(1, 0, {
        role: 'system',
        content: [
          '本轮从用户补充消息中恢复；必须合并原任务与补充内容。',
          `原始目标：${input.resume.rootContent}`,
          '用户补充：',
          ...input.resume.supplements.map(item => `- ${item}`),
          input.resume.toolResults.length
            ? `已完成 Tool 回执：${input.resume.toolResults
              .filter(result => result.status === 'completed')
              .map(result => result.receipt.toolName)
              .join(', ') || '无'}`
            : '已完成 Tool 回执：无',
          '不得重复已经成功的不可逆或外部副作用。',
        ].join('\n'),
      })
    }
    if (input.event?.image.length) {
      const visionEnabled = !selectedProvider?.visionModels?.length ||
        selectedProvider.visionModels.includes(selectedModel)
      const lastUser = [...messages].reverse().find(message => message.role === 'user')
      if (lastUser) {
        lastUser.content = await agentModelContent(
          input.content,
          input.event.image,
          visionEnabled
        )
      }
    }
    const controller = new AbortController()
    let removeParentAbortListener: (() => void) | undefined
    if (input.signal) {
      const abortFromParent = () => controller.abort(input.signal?.reason)
      if (input.signal.aborted) abortFromParent()
      else {
        input.signal.addEventListener('abort', abortFromParent, { once: true })
        removeParentAbortListener = () =>
          input.signal?.removeEventListener('abort', abortFromParent)
      }
    }
    const state: ExecutionState = {
      input,
      thread,
      turnId,
      messages,
      controller,
      round: 0,
      pendingCalls: [],
      latestAssistant: '',
      tasks,
      needsTaskPlan: !input.automated &&
        (input.depth || 0) === 0 &&
        !input.strictToolAllowlist &&
        !tasks &&
        this.taskLedger.shouldPlan(input.content),
      completionRetries: 0,
      toolResults: [...(input.resume?.toolResults || [])],
      recoveryCycle: 0,
      recoveryStartedAt: Date.now(),
      diagnosticCalls: 0,
      executionBudget: new AgentExecutionBudget(this.getConfig().limits.maxToolRounds),
      discoveryQuery: input.content,
      startedAt: Date.now(),
      currentOperation: '模型思考',
      superseded: false,
      loadedSkillTools: new Set(),
      removeParentAbortListener,
    }
    this.activeTurns.set(turnId, state)
    if (
      input.interactiveRequestId &&
      this.interactiveOwners.get(input.threadKey) !== input.interactiveRequestId
    ) {
      state.superseded = true
      state.controller.abort(new Error('用户补充了更新内容'))
      return this.finish(
        state,
        'interrupted',
        '',
        '被更新的用户补充抢占'
      )
    }
    await agentHookEmit('beforeContext', { thread, turnId, messages })
    await this.emit(state, 'turn.started', { actor: input.actor })
    if (input.resume) {
      await this.emit(state, 'turn.resumed', {
        fromTurnId: input.resume.fromTurnId,
        supplements: input.resume.supplements,
        inheritedReceipts: input.resume.toolResults.length,
      })
    }
    const config = this.getConfig()
    const disabled = new Set(config.tools.disabled)
    const disabledToolsets = new Set(config.tools.disabledToolsets)
    const planningTools = this.registry.list(input.allowedTools).filter(tool =>
      !disabled.has(tool.name) &&
      !disabledToolsets.has(tool.toolset) &&
      (!input.readOnlyTools || tool.risk === 'read')
    )
    const planResult = await this.recovery.createPlan(
      {
        ...input,
        automated: true,
        content: input.resume
          ? [input.resume.rootContent, ...input.resume.supplements].join('\n')
          : input.content,
      },
      planningTools,
      thread.modelProviderId || undefined,
      thread.modelName || '',
      controller.signal
    )
    state.plan = planResult.plan
    state.messages.splice(1, 0, {
      role: 'system',
      content: [
        '本轮确定性完成条件（这是可见的验证契约，不是隐藏任务计划）：',
        ...state.plan.goals.flatMap(goal => [
          `- 目标：${goal.description}`,
          ...goal.postconditions
            .filter(item => item.required)
            .map(item =>
              `  - ${item.kind}: ${item.description}${
                item.toolNames.length ? `；Tool=${item.toolNames.join(',')}` : ''
              }`
            ),
        ]),
      ].join('\n'),
    })
    await this.emit(state, 'plan.created', {
      kind: 'visible-verification-contract',
      plan: state.plan,
      attempts: planResult.attempts,
      errors: planResult.errors,
    })
    return this.continueState(state)
  }

  private availableTools (state: ExecutionState) {
    let allowed = state.input.allowedTools
    if ((state.input.depth || 0) > 0) {
      const names = allowed || this.registry.list().map(tool => tool.name)
      allowed = names.filter(
        name => name !== 'karin.agent.delegate' && name !== 'karin.agent.delegate_many'
      )
    }
    const config = this.getConfig()
    const disabled = new Set(config.tools.disabled)
    const disabledToolsets = new Set(config.tools.disabledToolsets)
    if (state.input.strictToolAllowlist && !allowed?.length) return []
    if (state.needsTaskPlan && !state.tasks) {
      const todo = this.registry.list(allowed).find(tool =>
        tool.name === 'karin.agent.todo' &&
        tool.available &&
        !disabled.has(tool.name) &&
        !disabledToolsets.has(tool.toolset)
      )
      return todo ? [todo] : []
    }
    const requiredTools = state.plan?.goals.flatMap(goal => [
      ...goal.capabilities.filter(capability => capability.includes('.')),
      ...goal.postconditions.flatMap(postcondition => postcondition.toolNames),
    ]) || []
    requiredTools.push(
      'karin.agent.todo',
      'karin.skill.list',
      'karin.skill.view',
      'karin.tool.search'
    )
    requiredTools.push(...state.loadedSkillTools)
    return this.registry.discover(
      state.discoveryQuery,
      allowed,
      24,
      requiredTools
    ).filter(tool =>
      !disabled.has(tool.name) &&
      !disabledToolsets.has(tool.toolset) &&
      !(
        tool.name === 'karin.bot.send_message' &&
        !state.input.automated &&
        (
          state.input.actor.origin?.channel === 'web' ||
          state.input.actor.scene === 'web'
        )
      ) &&
      (!state.input.readOnlyTools || tool.risk === 'read') &&
      tool.available
    )
  }

  private async continueState (state: ExecutionState): Promise<AgentTurnResult> {
    const config = this.getConfig()
    try {
      while (true) {
        if (!state.pendingCalls.length) {
          const budget = state.executionBudget.beginIteration({
            tasks: state.tasks,
            toolResults: state.toolResults,
          })
          state.round = Math.max(0, budget.iteration - 1)
          if (!budget.allowed) {
            const content = state.executionBudget.failureMessage(budget)
            await this.emit(state, 'execution.budget', {
              status: 'stopped',
              ...budget,
            })
            return this.finish(state, 'failed', content, content)
          }
          if (budget.warning) {
            state.messages.push({ role: 'system', content: budget.warning })
            await this.emit(state, 'execution.budget', {
              status: 'warning',
              ...budget,
            })
          }
          state.currentOperation = '模型思考'
          await agentHookEmit('beforeModel', {
            threadId: state.thread.id,
            turnId: state.turnId,
            round: state.round,
          })
          const requiresVerifiedAction = state.plan?.goals.some(goal =>
            goal.postconditions.some(postcondition =>
              postcondition.required &&
              ['delivery', 'media', 'tool'].includes(postcondition.kind)
            )
          )
          const response = await this.provider.complete(
            {
              providerId: state.thread.modelProviderId || undefined,
              model: state.thread.modelName || '',
              messages: state.messages,
              tools:
              budget.remaining > 0
                ? this.availableTools(state).map(tool => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                }))
                : [],
              toolChoice: state.needsTaskPlan && !state.tasks ? 'required' : undefined,
              signal: state.controller.signal,
            },
            async delta => {
              if (!requiresVerifiedAction) {
                await state.input.onDelta?.(delta)
                await this.emit(state, 'text.delta', { delta })
              }
            }
          )
          await agentHookEmit('afterModel', {
            threadId: state.thread.id,
            turnId: state.turnId,
            round: state.round,
            response,
          })
          await this.database.addUsage(
            state.thread.id,
            state.turnId,
            response.provider || this.provider.name,
            response.model || '',
            response.usage?.inputTokens,
            response.usage?.outputTokens,
            {
              retries: response.retries,
              fallbackFrom: response.fallbackFrom,
              retryReasons: response.retryReasons,
              latencyMs: response.latencyMs,
            }
          )
          this.contextEngine.observeUsage(
            `${response.provider || 'provider'}:${response.model || state.thread.modelName || ''}`,
            this.contextEngine.estimateTokens(
              state.messages,
              `${response.provider || 'provider'}:${response.model || state.thread.modelName || ''}`
            ),
            response.usage?.inputTokens
          )

          const preVerification = !response.toolCalls.length
            ? this.recovery.verify(
              state.plan!,
              state.toolResults,
              response.content
            )
            : null
          state.latestAssistant = response.content
          state.messages.push({
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
          })
          const assistantMedia = preVerification?.completed &&
            !state.input.automated &&
            (
              state.input.actor.origin?.channel === 'web' ||
              state.input.actor.scene === 'web'
            )
            ? [...new Set(state.toolResults.flatMap(result =>
              result.status === 'completed' && result.receipt.media?.path
                ? [result.receipt.media.path]
                : []
            ))]
            : []
          const assistantAttachments = assistantMedia.length
            ? await persistAgentMessageImages(
              this.database,
              state.thread.id,
              assistantMedia
            )
            : []
          await this.database.addMessage(
            state.thread.id,
            state.turnId,
            'assistant',
            response.content,
            {
              toolCalls: response.toolCalls,
              attachments: assistantAttachments,
            }
          )

          if (!response.toolCalls.length) {
            const verification = preVerification!
            await this.emit(state, 'verification.completed', verification)
            if (verification.completed) {
              const completion = this.completionGuard.verify(
                state.tasks,
                state.toolResults,
                response.content,
                state.plan
              )
              if (!completion.completed) {
                await this.emit(state, 'verification.completed', {
                  ...completion,
                  completed: false,
                  source: 'completion_guard',
                })
                if (
                  state.completionRetries <
                  (config.tasks?.completionGuardRetries ?? 2)
                ) {
                  state.completionRetries++
                  state.messages.push({
                    role: 'system',
                    content: this.completionGuard.recoveryPrompt(completion),
                  })
                  continue
                }
                return this.finish(
                  state,
                  'failed',
                  `任务未通过完成守卫：${completion.message}`,
                  completion.message
                )
              }
              if (state.recoveryCycle > 0) {
                await this.emit(state, 'recovery.completed', this.recovery.event(
                  'finish',
                  state.recoveryCycle,
                  '恢复后的完成条件已通过验证',
                  { completed: true }
                ))
              }
              const content = this.recovery.finalContent(
                state.plan!,
                state.toolResults,
                response.content
              )
              if (requiresVerifiedAction && content) {
                await state.input.onDelta?.(content)
                await this.emit(state, 'text.delta', { delta: content, verified: true })
              }
              return this.finish(state, 'completed', content)
            }
            const recovery = config.recovery
            const withinTime = Date.now() - state.recoveryStartedAt < recovery.maxDurationMs
            if (
              !recovery.enabled ||
              state.recoveryCycle >= recovery.maxCycles ||
              !withinTime
            ) {
              await this.createRecoveryCandidate(state, verification)
              const reason = verification.message
              return this.finish(
                state,
                'failed',
                this.recovery.failureContent(verification, state.toolResults),
                reason
              )
            }
            state.recoveryCycle++
            state.discoveryQuery = this.recovery.recoveryQuery(
              state.input,
              verification,
              state.toolResults
            )
            const recoveryEvent = this.recovery.event(
              'recover',
              state.recoveryCycle,
              verification.message,
              {
                classification: verification.classification,
                missingPostconditions: verification.missing.map(item => item.id),
                query: state.discoveryQuery,
              }
            )
            await this.emit(state, 'recovery.started', recoveryEvent)
            state.messages.push({
              role: 'system',
              content: state.discoveryQuery,
            })
            continue
          }
          if (budget.remaining <= 0) {
            return this.finish(
              state,
              'failed',
              `执行已达到配置的最大 ${budget.maxIterations} 轮迭代，已停止以避免无限循环。`,
              '执行迭代预算耗尽'
            )
          }
          state.pendingCalls = [...response.toolCalls]
        }

        while (state.pendingCalls.length) {
          const parallel: AgentToolCall[] = []
          while (
            state.pendingCalls.length &&
            this.canRunInParallel(state, state.pendingCalls[0])
          ) {
            parallel.push(state.pendingCalls.shift()!)
          }
          if (parallel.length > 1) {
            const results = await Promise.all(
              parallel.map(call => this.processToolCall(state, call))
            )
            const terminal = results.find(Boolean)
            if (terminal) return terminal
            continue
          }
          if (parallel.length === 1) {
            const result = await this.processToolCall(state, parallel[0])
            if (result) return result
            continue
          }
          const call = state.pendingCalls.shift()!
          const result = await this.processToolCall(state, call)
          if (result) return result
        }
      }
    } catch (error) {
      const interrupted = state.controller.signal.aborted
      const message = (error as Error).message
      const timedOut = /模型请求超时|aborted due to timeout|TimeoutError/i.test(message)
      const recovery = this.getConfig().recovery
      if (
        !interrupted &&
        !timedOut &&
        recovery.enabled &&
        state.recoveryCycle < recovery.maxCycles &&
        Date.now() - state.recoveryStartedAt < recovery.maxDurationMs
      ) {
        state.recoveryCycle++
        state.discoveryQuery = [
          state.input.content,
          `Provider 或运行时错误：${message}`,
          '请使用可用的只读诊断 Tool 检查本地状态；需要外部资料时搜索并打开官方来源。',
        ].join('\n')
        const event = this.recovery.event(
          'recover',
          state.recoveryCycle,
          message,
          {
            classification: 'provider_failed',
            query: state.discoveryQuery,
          }
        )
        await this.emit(state, 'recovery.started', event)
        state.messages.push({ role: 'system', content: state.discoveryQuery })
        return this.continueState(state)
      }
      if (!interrupted && !timedOut && state.plan) {
        await this.createRecoveryCandidate(state, {
          completed: false,
          missing: state.plan.goals.flatMap(goal =>
            goal.postconditions.filter(item => item.required)
          ),
          classification: 'provider_failed',
          message,
        })
      }
      return this.finish(
        state,
        interrupted ? 'interrupted' : 'failed',
        interrupted
          ? '当前 Agent 回合已中断。'
          : timedOut
            ? '模型响应超时，Provider 重试与回退均未成功。请稍后重试，或调高该 Provider 的超时时间。'
            : `Agent 执行失败：${message}`,
        message
      )
    }
  }

  private async processToolCall (
    state: ExecutionState,
    call: AgentToolCall
  ): Promise<AgentTurnResult | null> {
    let compiled
    state.currentOperation = call.name
    try {
      compiled = this.registry.get(call.name)
    } catch (error) {
      await this.addToolResult(state, call, undefined, (error as Error).message)
      return null
    }
    if (!compiled) {
      await this.addToolResult(state, call, undefined, `未知工具: ${call.name}`)
      return null
    }
    const risk = this.policy.risk(compiled.tool, call.arguments)

    const explicitlyAllowed = state.input.strictToolAllowlist
      ? Boolean(state.input.allowedTools?.includes(call.name))
      : !state.input.allowedTools?.length || state.input.allowedTools.includes(call.name)
    const readOnlyAllowed =
      !state.input.readOnlyTools || risk === 'read'
    if (!explicitlyAllowed || !readOnlyAllowed) {
      await this.database.createToolCall(
        state.thread.id,
        state.turnId,
        call,
        risk,
        'deny',
        'denied',
        {
          idempotent: compiled.tool.idempotent,
          restartSafe: compiled.tool.restartSafe || (compiled.tool.idempotent && risk === 'read'),
        }
      )
      await this.addToolResult(
        state,
        call,
        undefined,
        state.input.readOnlyTools
          ? '并行子 Agent 只能调用只读 Tool'
          : '该 Tool 不在当前回合允许列表中'
      )
      await this.database.audit(
        state.input.actor.id,
        'tool.policy.denied',
        call.name,
        {
          risk,
          reason: state.input.readOnlyTools
            ? 'subagent-read-only'
            : 'turn-tool-allowlist',
        },
        state.thread.id
      )
      return null
    }

    const inputHash = createHash('sha256')
      .update(safeJson(call.arguments))
      .digest('hex')
    const inherited = !compiled.tool.idempotent
      ? state.toolResults.find(result =>
        result.status === 'completed' &&
        result.receipt.toolName === call.name &&
        result.inputHash === inputHash
      )
      : undefined
    if (inherited) {
      await this.database.createToolCall(
        state.thread.id,
        state.turnId,
        call,
        risk,
        'allow',
        'pending',
        {
          idempotent: compiled.tool.idempotent,
          restartSafe: compiled.tool.restartSafe || (compiled.tool.idempotent && risk === 'read'),
        }
      )
      const reused: AgentToolResultEnvelope = {
        ...inherited,
        data: {
          reused: true,
          sourceTurnId: state.input.resume?.fromTurnId,
          output: inherited.data,
        },
      }
      state.toolResults.push(reused)
      await this.emit(state, 'tool.started', { call, reused: true })
      await this.addToolResult(state, call, reused.data)
      await this.emit(state, 'tool.completed', { call, result: reused, reused: true })
      await this.database.audit(
        state.input.actor.id,
        'tool.receipt.reused',
        call.name,
        { inputHash, sourceTurnId: state.input.resume?.fromTurnId },
        state.thread.id
      )
      return null
    }

    const context = this.toolContext(state)
    let decision = this.policy.decide(compiled.tool, context, call.arguments)
    if (
      decision === 'ask' &&
      await this.database.hasThreadToolGrant(
        state.thread.id,
        call.name,
        risk
      ) &&
      !containsSensitiveInput(call.arguments)
    ) {
      decision = 'allow'
    }
    await this.database.createToolCall(
      state.thread.id,
      state.turnId,
      call,
      risk,
      decision,
      decision === 'ask' ? 'waiting_approval' : 'pending',
      {
        idempotent: compiled.tool.idempotent,
        restartSafe: compiled.tool.restartSafe || (compiled.tool.idempotent && risk === 'read'),
      }
    )

    if (decision === 'deny') {
      await this.addToolResult(state, call, undefined, '权限策略拒绝了该工具调用')
      await this.database.audit(
        state.input.actor.id,
        'tool.policy.denied',
        call.name,
        { risk, reason: 'policy' },
        state.thread.id
      )
      return null
    }

    if (decision === 'ask') {
      if (state.input.readOnlyTools) {
        await this.addToolResult(state, call, undefined, '并行只读子 Agent 不能等待交互式审批')
        return null
      }
      if (state.input.automated) {
        await this.addToolResult(state, call, undefined, '无人值守任务不能等待交互式审批')
        return null
      }
      const approvalId = await this.database.createApproval(
        state.thread.id,
        state.turnId,
        state.input.actor.id,
        state.thread.contactKey || state.input.actor.contactKey || null,
        call,
        this.getConfig().policy.approvalTtlMs
      )
      state.waitingCall = call
      this.pendingApprovals.set(approvalId, state)
      const timer = setTimeout(() => {
        this.expireApproval(approvalId).catch(error => {
          logger.error(new Error('[agent][approval] 过期处理失败', { cause: error }))
        })
      }, this.getConfig().policy.approvalTtlMs)
      timer.unref()
      this.approvalTimers.set(approvalId, timer)
      await this.database.updateTurn(state.turnId, state.thread.id, 'waiting_approval')
      await this.database.audit(
        state.input.actor.id,
        'approval.request',
        approvalId,
        { tool: call.name, input: redactSensitiveInput(call.arguments) },
        state.thread.id
      )
      await agentHookEmit('approval', {
        status: 'pending',
        approvalId,
        threadId: state.thread.id,
        turnId: state.turnId,
        call,
      })
      await this.emit(state, 'approval.requested', {
        approvalId,
        tool: call.name,
        input: call.arguments,
        expiresIn: this.getConfig().policy.approvalTtlMs,
      })
      return {
        threadId: state.thread.id,
        turnId: state.turnId,
        state: 'waiting_approval',
        content: `工具 ${call.name} 需要审批。`,
        approvalId,
      }
    }

    if (decision === 'allow' && risk !== 'read') {
      await this.database.audit(
        state.input.actor.id,
        'tool.policy.auto-approved',
        call.name,
        {
          risk,
          reversible: Boolean(compiled.tool.reversible),
          source: call.name.startsWith('karin.') ? 'core' : 'policy-or-thread-grant',
          reason:
            compiled.tool.reversible && call.name.startsWith('karin.')
              ? 'trusted-reversible-local-write'
              : 'policy-rule-or-thread-grant',
        },
        state.thread.id
      )
    }

    if (call.name.startsWith('karin.diagnostics.')) {
      state.diagnosticCalls++
      if (state.diagnosticCalls > this.getConfig().recovery.maxDiagnosticCalls) {
        await this.addToolResult(
          state,
          call,
          undefined,
          `诊断 Tool 已达到上限 ${this.getConfig().recovery.maxDiagnosticCalls}`
        )
        return null
      }
    }
    await this.executeTool(state, call)
    return null
  }

  private canRunInParallel (state: ExecutionState, call: AgentToolCall) {
    if (call.name.startsWith('karin.diagnostics.')) return false
    let compiled
    try {
      compiled = this.registry.get(call.name)
    } catch {
      return false
    }
    if (!compiled?.tool.idempotent) return false
    try {
      if (compiled.tool.availability && !compiled.tool.availability()) return false
    } catch {
      return false
    }
    if (this.policy.risk(compiled.tool, call.arguments) !== 'read') return false
    return this.policy.decide(
      compiled.tool,
      this.toolContext(state),
      call.arguments
    ) === 'allow'
  }

  private toolContext (state: ExecutionState): AgentToolContext {
    return {
      threadId: state.thread.id,
      turnId: state.turnId,
      actor: state.input.actor,
      signal: state.controller.signal,
      event: state.input.event,
      automated: Boolean(state.input.automated),
      parentThreadId: state.input.parentThreadId,
      depth: state.input.depth || 0,
      allowedTools: state.input.allowedTools,
    }
  }

  private async executeTool (state: ExecutionState, call: AgentToolCall) {
    await this.emit(state, 'tool.started', { call })
    await agentHookEmit('beforeTool', {
      threadId: state.thread.id,
      turnId: state.turnId,
      call,
    })
    const result = await this.registry.executeWithReceipt(
      call.name,
      call.arguments,
      this.toolContext(state),
      this.getConfig().limits.maxToolOutputBytes
    )
    result.inputHash = createHash('sha256')
      .update(safeJson(call.arguments))
      .digest('hex')
    state.toolResults.push(result)
    if (call.name === 'karin.agent.todo' && result.status === 'completed') {
      state.tasks = (result.data as AgentTaskList | null) ||
        await this.taskLedger.read(state.thread.id)
      state.needsTaskPlan = state.needsTaskPlan && !state.tasks
      await this.emit(state, 'task.updated', this.taskLedger.summary(state.tasks))
    }
    if (call.name === 'karin.skill.view' && result.status === 'completed') {
      const loaded = result.data as Record<string, unknown>
      const declaredTools = Array.isArray(loaded.tools) ? loaded.tools.map(String) : []
      const available = new Map(this.registry.list().map(tool => [tool.name, tool.available]))
      for (const toolName of declaredTools) {
        if (available.get(toolName)) state.loadedSkillTools.add(toolName)
        else {
          await this.emit(state, 'capability.missing', {
            skillId: loaded.id,
            toolName,
            reason: available.has(toolName) ? 'Tool 当前不可用' : 'Tool 未注册',
          })
        }
      }
      await this.emit(state, 'skill.loaded', {
        skillId: loaded.id,
        name: loaded.name,
        versionId: loaded.versionId,
        filePath: loaded.filePath,
        tools: declaredTools,
      })
    }
    if (
      call.name === 'karin.tool.search' &&
      result.status === 'completed' &&
      Array.isArray(result.data) &&
      result.data.length === 0
    ) {
      await this.emit(state, 'capability.missing', {
        query: call.arguments.query,
        decisionOrder: [
          'search-skill',
          'search-tool-or-mcp',
          'compose-skill',
          'create-pure-compute-tool',
          'propose-high-risk-capability',
        ],
      })
    }
    try {
      if (result.status === 'completed') {
        await this.addToolResult(state, call, result.data)
      } else {
        await this.addToolResult(
          state,
          call,
          undefined,
          `${result.errorCode || 'TOOL_FAILED'}: ${result.error || 'Tool 执行失败'}`
        )
      }
      await this.emit(state, 'tool.completed', { call, result })
      await agentHookEmit('afterTool', {
        threadId: state.thread.id,
        turnId: state.turnId,
        call,
        output: result,
      })
    } catch (error) {
      const message = (error as Error).message
      logger.error(new Error('[agent][tool] Tool 结果持久化失败', { cause: error }))
      await this.emit(state, 'tool.completed', { call, result, persistenceError: message })
    }
  }

  private async addToolResult (
    state: ExecutionState,
    call: AgentToolCall,
    output?: unknown,
    error?: string
  ) {
    const content = error ? JSON.stringify({ ok: false, error }) : safeJson({ ok: true, output })
    state.messages.push({
      role: 'tool',
      name: call.name,
      toolCallId: call.id,
      content,
    })
    await this.database.addMessage(state.thread.id, state.turnId, 'tool', content, {
      name: call.name,
      toolCallId: call.id,
    })
    await this.database.completeToolCall(call.id, output, error)
  }

  private async createRecoveryCandidate (
    state: ExecutionState,
    verification: AgentVerificationResult
  ) {
    if (!this.getConfig().recovery.enabled || state.input.parentThreadId) return null
    const failedTools = state.toolResults
      .filter(result => result.status === 'failed')
      .map(result => ({
        name: result.receipt.toolName,
        code: result.errorCode,
        error: result.error?.slice(0, 500),
      }))
    const expectedRestriction = failedTools.length > 0 && failedTools.every(item =>
      ['TOOL_UNSAFE_URL', 'TOOL_DENIED', 'TOOL_NOT_FOUND'].includes(item.code || '') ||
      /Playwright Chromium 启动失败|module is not allowed|浏览器环境暂不可用/i.test(
        item.error || ''
      )
    )
    const lacksDefectEvidence = failedTools.length === 0
    if (expectedRestriction || lacksDefectEvidence) {
      const reason = expectedRestriction
        ? '安全策略或运行要求限制，不生成源码修复候选'
        : '缺少源码缺陷或 Tool 执行失败证据，不生成源码修复候选'
      await this.emit(state, 'capability.missing', {
        classification: verification.classification,
        missing: verification.missing.map(item => item.description),
        requirements: failedTools.map(item => ({
          tool: item.name,
          code: item.code,
        })),
        reason,
      })
      await this.database.audit(
        state.input.actor.id,
        'evolution.recovery.skipped',
        state.turnId,
        {
          reason: expectedRestriction
            ? 'expected-capability-restriction'
            : 'missing-defect-evidence',
          tools: failedTools.map(item => ({ name: item.name, code: item.code })),
        },
        state.thread.id
      )
      return null
    }
    const fingerprintInput = {
      classification: verification.classification,
      missing: verification.missing.map(item => ({
        kind: item.kind,
        tools: item.toolNames.slice().sort(),
      })),
      failedTools: failedTools.map(item => ({ name: item.name, code: item.code })),
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(fingerprintInput))
      .digest('hex')
    const existing = (await this.database.listEvolutionCandidates(undefined, 500))
      .find(candidate =>
        ['tool', 'repair'].includes(candidate.target) &&
        candidate.payload.fingerprint === fingerprint &&
        !['rejected', 'rolled_back'].includes(candidate.state)
      )
    if (existing) {
      const occurrences = Math.max(1, Number(existing.payload.occurrences) || 1) + 1
      await this.database.updateEvolutionPayload(existing.id, {
        ...existing.payload,
        occurrences,
        lastSeenAt: Date.now(),
        evidence: [
          ...new Set([
            ...(Array.isArray(existing.payload.evidence)
              ? existing.payload.evidence.map(String)
              : []),
            ...failedTools.map(item => `${item.name}: ${item.code || item.error || 'failed'}`),
          ]),
        ].slice(-100),
      })
      await this.database.addEvolutionEvent(
        existing.id,
        'recovery.repeated',
        state.input.actor.id,
        { threadId: state.thread.id, turnId: state.turnId, occurrences }
      )
      await this.emit(state, 'repair.candidate', {
        id: existing.id,
        target: existing.target,
        repeated: true,
      })
      return existing.id
    }

    let target: 'tool' | 'repair' = 'repair'
    if (verification.missing.some(item =>
      item.required &&
      item.kind !== 'information' &&
      item.toolNames.length === 0
    )) {
      target = 'tool'
    }
    const evidence = failedTools.map(item =>
      `${item.name}: ${item.code || item.error || 'failed'}`
    )
    const payload = {
      fingerprint,
      occurrences: 1,
      lastSeenAt: Date.now(),
      problem: verification.message,
      reproduction: state.input.content.slice(0, 2000),
      evidence,
      rootCause: target === 'tool'
        ? '当前 Tool 注册表无法满足必需完成条件'
        : '现有 Tool 或渠道执行未能满足必需完成条件',
      confidence: failedTools.length ? 0.8 : 0.55,
      affectedFiles: [],
      semantics: {
        objective: verification.missing.map(item => item.description).join('；'),
        inputs: '原始用户目标、回合上下文与失败回执',
        outputs: '通过全部必需完成条件的可验证结果',
        sideEffects: target === 'tool' ? ['待候选评测确定'] : [],
        idempotent: false,
      },
      stopCondition: state.plan?.stopCondition || '所有必需完成条件通过验证',
      failureStrategy: '隔离评测失败时停止；不得修改真实源码或重复已成功副作用',
      verification: [],
      rollback: '候选尚未应用；批准后必须保存触及文件快照并在健康检查失败时恢复',
    }
    const candidate = await this.database.createEvolutionCandidate({
      target,
      kind: 'executable',
      sourceTurnIds: [state.turnId],
      candidateVersion: fingerprint.slice(0, 12),
      summary: `${target === 'tool' ? '能力缺口' : '自修复候选'}：${verification.message}`,
      payload,
    })
    if (!candidate) return null
    await this.database.addEvolutionEvent(
      candidate.id,
      'recovery.created',
      state.input.actor.id,
      { threadId: state.thread.id, turnId: state.turnId }
    )
    await this.database.audit(
      state.input.actor.id,
      'evolution.recovery.create',
      candidate.id,
      { target, fingerprint },
      state.thread.id
    )
    await this.emit(state, 'repair.candidate', {
      id: candidate.id,
      target,
      repeated: false,
    })
    return candidate.id
  }

  async resolveApproval (
    approvalId: string,
    decision: 'approved' | 'denied',
    actor: AgentActor,
    scope: 'once' | 'thread' | 'delegate' = 'once'
  ) {
    const approval = await this.database.getApproval(approvalId)
    await this.validateApproval(approval, actor)
    const state = this.pendingApprovals.get(approvalId)
    if (!state) throw new Error('审批对应的运行中回合不存在或 Karin 已重启')
    const compiled = this.registry.get(approval!.toolName)
    const risk = compiled
      ? this.policy.risk(compiled.tool, approval!.input)
      : 'read'
    if (
      decision === 'approved' &&
      scope === 'delegate' &&
      (risk === 'external' || risk === 'destructive' || containsSensitiveInput(approval!.input))
    ) {
      throw new Error('替我审批只适用于不含敏感输入的 read/write Tool')
    }

    if (approval!.expiresAt <= Date.now()) {
      await this.database.resolveApproval(approvalId, 'expired')
      this.pendingApprovals.delete(approvalId)
      throw new Error('审批已过期')
    }

    const resolved = await this.database.resolveApproval(approvalId, decision)
    if (!resolved) throw new Error('审批已被其他请求处理')
    this.pendingApprovals.delete(approvalId)
    clearTimeout(this.approvalTimers.get(approvalId))
    this.approvalTimers.delete(approvalId)
    if (decision === 'approved' && scope !== 'once') {
      await this.database.grantThreadTool({
        threadId: approval!.threadId,
        actorId: actor.id,
        toolName: scope === 'delegate' ? '*' : approval!.toolName,
        risk,
        mode: scope === 'delegate' ? 'delegate' : 'tool',
      })
    }
    await this.database.audit(
      actor.id,
      `approval.${decision}`,
      approvalId,
      { tool: approval!.toolName, scope },
      approval!.threadId
    )
    await agentHookEmit('approval', {
      status: decision,
      approvalId,
      actor,
    })
    await this.emit(state, 'approval.resolved', { approvalId, decision })

    return this.enqueue(state.input.threadKey, async () => {
      const call = state.waitingCall!
      state.waitingCall = undefined
      if (decision === 'approved') {
        const compiled = this.registry.get(call.name)
        if (
          !compiled ||
          this.policy.decide(
            compiled.tool,
            this.toolContext(state),
            call.arguments
          ) === 'deny'
        ) {
          await this.addToolResult(state, call, undefined, '工具已不存在或当前策略拒绝执行')
        } else {
          await this.executeTool(state, call)
        }
      } else {
        await this.addToolResult(state, call, undefined, '用户拒绝了该工具调用')
      }
      return this.continueState(state)
    })
  }

  private async expireApproval (approvalId: string) {
    const state = this.pendingApprovals.get(approvalId)
    if (!state) return
    const resolved = await this.database.resolveApproval(approvalId, 'expired')
    if (!resolved) return

    this.pendingApprovals.delete(approvalId)
    clearTimeout(this.approvalTimers.get(approvalId))
    this.approvalTimers.delete(approvalId)
    const call = state.waitingCall
    state.waitingCall = undefined
    if (!call) return

    await this.database.audit(
      'system',
      'approval.expired',
      approvalId,
      { tool: call.name },
      state.thread.id
    )
    await this.emit(state, 'approval.resolved', {
      approvalId,
      decision: 'expired',
    })
    const result = await this.enqueue(state.input.threadKey, async () => {
      await this.addToolResult(state, call, undefined, '工具审批已过期')
      return this.continueState(state)
    })
    if (state.input.event && result.content) {
      await this.deliverEventResult(state.input.event, result, state.input.actor.id)
    } else if (state.input.onResult) await state.input.onResult(result)
  }

  private async validateApproval (
    approval: AgentApprovalRecord | null,
    actor: AgentActor
  ): Promise<void> {
    if (!approval) throw new Error('审批不存在')
    if (approval.status !== 'pending') throw new Error(`审批状态为 ${approval.status}`)
    if (actor.id === approval.actorId || ['master', 'admin'].includes(actor.role)) return
    if (!approval.approverContactKey || approval.approverContactKey !== actor.contactKey) {
      throw new Error('审批不属于当前渠道会话')
    }
    const thread = await this.database.getThread(approval.threadId)
    if (!thread) throw new Error('审批对应的会话不存在')
    const manager = [
      'group.owner',
      'group.admin',
      'guild.owner',
      'guild.admin',
    ].includes(actor.role)
    if (actor.id !== thread.actorId && !manager) {
      throw new Error('只有会话发起人或管理员可以处理审批')
    }
  }

  async interrupt (threadId: string) {
    const result = await this.interruptTree(threadId)
    return result.interrupted
  }

  async interruptTree (threadId: string) {
    const ids = await this.database.getThreadTreeIds(threadId)
    if (!ids.length) {
      return { interrupted: false, turns: 0, subagents: 0, approvals: 0 }
    }
    const idSet = new Set(ids)
    ids.forEach(id => this.stoppingThreads.add(id))
    const states = [...this.activeTurns.values()].filter(state => idSet.has(state.thread.id))
    let approvals = 0
    try {
      for (const id of ids) {
        const thread = await this.database.getThread(id)
        if (thread && ['running', 'waiting_approval'].includes(thread.state)) {
          await this.database.updateThreadState(id, 'stopping')
        }
      }
      for (const state of states) {
        state.controller.abort(new Error('用户中断'))
        for (const [approvalId, pending] of this.pendingApprovals) {
          if (pending !== state) continue
          this.pendingApprovals.delete(approvalId)
          clearTimeout(this.approvalTimers.get(approvalId))
          this.approvalTimers.delete(approvalId)
          if (await this.database.resolveApproval(approvalId, 'expired')) approvals++
          await this.emit(state, 'approval.resolved', {
            approvalId,
            decision: 'expired',
          })
        }
        await this.finish(
          state,
          'interrupted',
          '当前 Agent 回合已中断。',
          '用户中断'
        )
      }
      return {
        interrupted: states.length > 0 || approvals > 0,
        turns: states.length,
        subagents: states.filter(state => state.thread.id !== threadId).length,
        approvals,
      }
    } finally {
      ids.forEach(id => this.stoppingThreads.delete(id))
    }
  }

  async deleteThread (threadId: string, actorId: string) {
    const ids = await this.database.getThreadTreeIds(threadId)
    if (!ids.length) return false
    const threads = (await Promise.all(ids.map(id => this.database.getThread(id))))
      .filter((thread): thread is AgentThreadRecord => Boolean(thread))
    for (const thread of threads) this.deletingThreads.add(thread.threadKey)

    try {
      await this.interruptTree(threadId)
      const pending = threads
        .map(thread => this.queues.get(thread.threadKey))
        .filter((queue): queue is Promise<unknown> => Boolean(queue))
      await Promise.allSettled(pending)
      const deleted = await this.database.deleteThreadTree(threadId, actorId)
      if (deleted) {
        for (const id of ids) this.events.clearThread(id)
      }
      return deleted
    } finally {
      for (const thread of threads) this.deletingThreads.delete(thread.threadKey)
    }
  }

  private subagentAbortError (signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new Error('父 Thread 正在停止')
  }

  private releaseSubagentSlot () {
    this.activeSubagents = Math.max(0, this.activeSubagents - 1)
    const limit = Math.max(1, this.getConfig().limits.maxSubagents)
    while (this.activeSubagents < limit && this.subagentWaiters.length) {
      const waiter = this.subagentWaiters.shift()!
      if (waiter.signal.aborted) {
        waiter.reject(this.subagentAbortError(waiter.signal))
        continue
      }
      waiter.signal.removeEventListener('abort', waiter.abort)
      this.activeSubagents++
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.releaseSubagentSlot()
      })
    }
  }

  private acquireSubagentSlot (signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(this.subagentAbortError(signal))
    const limit = Math.max(1, this.getConfig().limits.maxSubagents)
    if (this.activeSubagents < limit) {
      this.activeSubagents++
      let released = false
      return Promise.resolve(() => {
        if (released) return
        released = true
        this.releaseSubagentSlot()
      })
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.subagentWaiters.indexOf(waiter)
          if (index >= 0) this.subagentWaiters.splice(index, 1)
          reject(this.subagentAbortError(signal))
        },
      } satisfies SubagentWaiter
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.subagentWaiters.push(waiter)
    })
  }

  private async runDelegatedTask (
    context: AgentToolContext,
    input: {
      prompt: string
      label: string
      allowedTools: string[]
      readOnlyTools: boolean
    }
  ) {
    const release = await this.acquireSubagentSlot(context.signal)
    if (this.stoppingThreads.has(context.threadId) || context.signal.aborted) {
      release()
      throw this.subagentAbortError(context.signal)
    }
    const childKey = `subagent:${context.threadId}:${randomUUID()}`
    const operationId = randomUUID()
    const startedAt = Date.now()
    const label = input.label.replace(/\s+/g, ' ').trim().slice(0, 80) || '处理委派任务'

    await this.events.publish(
      context.threadId,
      'subagent.started',
      { operationId, childKey, label, startedAt },
      context.turnId
    )
    try {
      const result = await this.runTurn({
        threadKey: childKey,
        actor: context.actor,
        content: input.prompt,
        parentThreadId: context.threadId,
        depth: 1,
        allowedTools: input.allowedTools,
        strictToolAllowlist: input.readOnlyTools,
        readOnlyTools: input.readOnlyTools,
        signal: context.signal,
      })
      await this.events.publish(
        context.threadId,
        'subagent.completed',
        {
          operationId,
          childThreadId: result.threadId,
          state: result.state,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        },
        context.turnId
      )
      return result
    } catch (error) {
      await this.events.publish(
        context.threadId,
        'subagent.completed',
        {
          operationId,
          childKey,
          state: 'failed',
          error: (error as Error).message,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        },
        context.turnId
      )
      throw error
    } finally {
      release()
    }
  }

  async delegate (context: AgentToolContext, input: { prompt: string; allowedTools?: string[] }) {
    if ((context.depth || 0) >= 1) throw new Error('子 Agent 不得继续创建子 Agent')
    if (this.stoppingThreads.has(context.threadId) || context.signal.aborted) {
      throw new Error('父 Thread 正在停止')
    }
    const parent = await this.database.getThread(context.threadId)
    if (!parent) throw new Error('父 Thread 不存在')

    const parentTools = new Set(context.allowedTools || this.registry.list().map(tool => tool.name))
    const requested = new Set(input.allowedTools?.length ? input.allowedTools : [...parentTools])
    const allowedTools = this.registry.list([...parentTools])
      .filter(tool =>
        requested.has(tool.name) &&
        tool.risk === 'read' &&
        tool.name !== 'karin.agent.delegate' &&
        tool.name !== 'karin.agent.delegate_many'
      )
      .map(tool => tool.name)
    return this.runDelegatedTask(context, {
      prompt: input.prompt,
      label: input.prompt,
      allowedTools,
      readOnlyTools: true,
    })
  }

  async delegateMany (
    context: AgentToolContext,
    tasks: AgentDelegateBatchTask[]
  ): Promise<AgentDelegateBatchResult[]> {
    if ((context.depth || 0) >= 1) throw new Error('子 Agent 不得继续创建子 Agent')
    if (this.stoppingThreads.has(context.threadId) || context.signal.aborted) {
      throw new Error('父 Thread 正在停止')
    }
    const limit = Math.max(1, this.getConfig().limits.maxSubagents)
    if (tasks.length < 2) throw new Error('并行委派至少需要两个子任务')
    if (tasks.length > limit) throw new Error(`并行子任务不能超过 ${limit} 个`)
    const ids = tasks.map(task => task.id.trim())
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
      throw new Error('并行子任务 ID 必须非空且唯一')
    }
    const parent = await this.database.getThread(context.threadId)
    if (!parent) throw new Error('父 Thread 不存在')

    const parentTools = new Set(context.allowedTools || this.registry.list().map(tool => tool.name))
    const allowedTools = this.registry
      .list([...parentTools])
      .filter(tool =>
        tool.risk === 'read' &&
        tool.name !== 'karin.agent.delegate' &&
        tool.name !== 'karin.agent.delegate_many'
      )
      .map(tool => tool.name)

    return Promise.all(tasks.map(async task => {
      try {
        const result = await this.runDelegatedTask(context, {
          prompt: task.prompt,
          label: task.label,
          allowedTools,
          readOnlyTools: true,
        })
        return {
          id: task.id,
          label: task.label,
          childThreadId: result.threadId,
          state: result.state,
          content: result.content,
          ...(
            result.state === 'failed' || result.state === 'interrupted'
              ? { error: result.content }
              : {}
          ),
        }
      } catch (error) {
        return {
          id: task.id,
          label: task.label,
          state: 'failed',
          content: '',
          error: (error as Error).message,
        }
      }
    }))
  }

  private async finish (
    state: ExecutionState,
    status: 'completed' | 'failed' | 'interrupted',
    content: string,
    error?: string
  ): Promise<AgentTurnResult> {
    if (state.finishPromise) return state.finishPromise
    state.finishPromise = this.persistFinish(state, status, content, error)
    return state.finishPromise
  }

  private async persistFinish (
    state: ExecutionState,
    status: 'completed' | 'failed' | 'interrupted',
    content: string,
    error?: string
  ): Promise<AgentTurnResult> {
    const finalized = await this.database.finalizeTurn({
      threadId: state.thread.id,
      turnId: state.turnId,
      state: status,
      content,
      error,
      publishFinal: Boolean(content && !(status === 'interrupted' && state.superseded)),
    })
    this.activeTurns.delete(state.turnId)
    state.removeParentAbortListener?.()
    const terminalEvent = {
      ...finalized.event,
      data: { status, content, error },
    }
    this.events.broadcast(terminalEvent)
    await state.input.onEvent?.(terminalEvent)
    await agentHookEmit('turnComplete', {
      threadId: state.thread.id,
      turnId: state.turnId,
      status,
      content,
      error,
    })

    if (!state.input.parentThreadId) {
      this.evolution.reviewer
        .review({
          threadId: state.thread.id,
          turnId: state.turnId,
          actor: state.input.actor,
          user: state.input.content,
          assistant: content,
          status,
          error,
          signal: AbortSignal.timeout(
            this.getConfig().providers.find(
              profile => profile.id === this.getConfig().routing.primary
            )?.timeout || 30000
          ),
        })
        .then(review => {
          if (!review?.reviewed) return
          return this.emit(state, 'evolution.reviewed', review)
        })
        .catch(error => {
          logger.error(new Error('[agent][learning] 自动学习失败', { cause: error }))
        })
    }

    return {
      threadId: state.thread.id,
      turnId: state.turnId,
      state: status,
      content,
      finalMessageId: finalized.finalMessageId || undefined,
    }
  }

  private async emit (state: ExecutionState, type: AgentStreamEvent['type'], data: unknown) {
    const event = await this.events.publish(state.thread.id, type, data, state.turnId)
    await state.input.onEvent?.(event)
  }
}
