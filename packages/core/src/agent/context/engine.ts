import type {
  AgentConfig,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelTool,
  AgentToolCall,
  ContextCheckpointV1,
} from '@/types/agent'
import type { AgentDatabase } from '../persistence/database'
import { agentHookEmit } from '@/hooks/agent'

export interface AgentHistoryMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls: AgentToolCall[]
}

interface ContextPreparation {
  history: AgentHistoryMessage[]
  summary: string
  estimatedTokens: number
  compressed: boolean
}

export interface AgentRequestBudget {
  windowTokens: number
  softLimit: number
  hardLimit: number
  messages: number
  tools: number
  responseSchema: number
  reservedOutput: number
  total: number
}

export interface AgentRequestPreparation {
  messages: AgentModelMessage[]
  budget: AgentRequestBudget
  compacted: boolean
  strategy?: 'semantic' | 'deterministic'
  checkpoint?: ContextCheckpointV1
}

export const contextCheckpointSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version', 'goal', 'constraints', 'decisions', 'evidence', 'completedActions',
    'pendingTasks', 'artifacts', 'failures', 'unresolvedQuestions', 'legacySummary',
  ],
  properties: {
    version: { type: 'integer', const: 1 },
    goal: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    completedActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'receipt'],
        properties: { action: { type: 'string' }, receipt: { type: 'string' } },
      },
    },
    pendingTasks: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'string' } },
    failures: { type: 'array', items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } },
    legacySummary: { type: 'string' },
  },
}

const secretPattern = /authorization|cookie|token|password|api[-_]?key|secret/i

const defaultContextConfig: AgentConfig['context'] = {
  defaultWindowTokens: 65536,
  softLimitRatio: 0.5,
  hardLimitRatio: 0.85,
  protectedRecentMessages: 12,
  summaryTargetTokens: 4096,
  semanticCompaction: true,
  reservedOutputTokens: 4096,
}

const textFor = (message: AgentHistoryMessage) => {
  const label = message.role === 'user'
    ? '用户'
    : message.role === 'assistant'
      ? 'Agent'
      : `Tool ${message.name || ''}`.trim()
  return `${label}: ${message.content.replace(/\s+/g, ' ').trim().slice(0, 1000)}`
}

const groupsFor = (messages: AgentHistoryMessage[]) => {
  const groups: AgentHistoryMessage[][] = []
  for (const message of messages) {
    if (
      message.role === 'tool' &&
      groups.at(-1)?.some(item => item.role === 'assistant' && item.toolCalls.length)
    ) {
      groups.at(-1)!.push(message)
      continue
    }
    groups.push([message])
  }
  return groups
}

const modelGroupsFor = (messages: AgentModelMessage[]) => {
  const groups: AgentModelMessage[][] = []
  for (const message of messages) {
    if (
      message.role === 'tool' &&
      groups.at(-1)?.some(item => item.role === 'assistant' && item.toolCalls?.length)
    ) {
      groups.at(-1)!.push(message)
      continue
    }
    groups.push([message])
  }
  return groups
}

const contentText = (content: AgentModelMessage['content']) => typeof content === 'string'
  ? content
  : content.map(item => item.type === 'text' ? item.text : `[图片 ${item.imageUrl}]`).join('\n')

const checkpointValid = (value: unknown): value is ContextCheckpointV1 => {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ContextCheckpointV1>
  const strings = (input: unknown) => Array.isArray(input) &&
    input.every(value => typeof value === 'string')
  return item.version === 1 && typeof item.goal === 'string' &&
    typeof item.legacySummary === 'string' && strings(item.constraints) &&
    strings(item.decisions) && strings(item.evidence) && strings(item.pendingTasks) &&
    strings(item.artifacts) && strings(item.failures) && strings(item.unresolvedQuestions) &&
    Array.isArray(item.completedActions) && item.completedActions.every(action =>
    action && typeof action === 'object' && typeof action.action === 'string' &&
    typeof action.receipt === 'string'
  )
}

const checkpointText = (checkpoint: ContextCheckpointV1) => [
  `目标：${checkpoint.goal}`,
  checkpoint.constraints.length ? `约束：${checkpoint.constraints.join('；')}` : '',
  checkpoint.decisions.length ? `决策：${checkpoint.decisions.join('；')}` : '',
  checkpoint.evidence.length ? `证据：${checkpoint.evidence.join('；')}` : '',
  checkpoint.completedActions.length
    ? `已完成：${checkpoint.completedActions.map(item =>
      item.receipt ? `${item.action}（${item.receipt}）` : item.action
    ).join('；')}`
    : '',
  checkpoint.pendingTasks.length ? `待办：${checkpoint.pendingTasks.join('；')}` : '',
  checkpoint.artifacts.length ? `产物：${checkpoint.artifacts.join('；')}` : '',
  checkpoint.failures.length ? `失败：${checkpoint.failures.join('；')}` : '',
  checkpoint.unresolvedQuestions.length
    ? `未决问题：${checkpoint.unresolvedQuestions.join('；')}`
    : '',
  checkpoint.legacySummary ? `历史摘要：${checkpoint.legacySummary}` : '',
].filter(Boolean).join('\n')

const deterministicCheckpoint = (
  messages: AgentModelMessage[],
  legacySummary: string,
  targetTokens: number
): ContextCheckpointV1 => {
  const lines = messages.map(message => {
    const label = message.role === 'user'
      ? '用户'
      : message.role === 'assistant'
        ? 'Agent'
        : `Tool ${message.name || ''}`.trim()
    return `${label}: ${contentText(message.content).replace(/\s+/g, ' ').trim().slice(0, 1200)}`
  }).filter(line => !secretPattern.test(line))
  const latestGoal = [...messages].reverse().find(message => message.role === 'user')
  const artifacts = lines.flatMap(line => line.match(/artifact(?:Id)?[=:：\s]+[a-z0-9._-]+/gi) || [])
  const failures = lines.filter(line => /失败|error|failed|timeout|超时/i.test(line)).slice(-20)
  return {
    version: 1,
    goal: latestGoal ? contentText(latestGoal.content).slice(0, 2000) : '',
    constraints: [],
    decisions: [],
    evidence: lines.filter(line => /^Tool /.test(line)).slice(-30),
    completedActions: lines.filter(line => /^Tool /.test(line)).slice(-30)
      .map(action => ({ action, receipt: '' })),
    pendingTasks: [],
    artifacts: [...new Set(artifacts)].slice(-30),
    failures,
    unresolvedQuestions: [],
    legacySummary: fitSummary([legacySummary, ...lines].filter(Boolean).join('\n'), targetTokens),
  }
}

const fitSummary = (value: string, targetTokens: number) => {
  const maxBytes = targetTokens * 3
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const characters = Math.max(16, Math.floor((maxBytes - 96) / 6))
  return [
    value.slice(0, characters),
    '…[中间历史已进一步压缩]…',
    value.slice(-characters),
  ].join('\n')
}

export class AgentContextEngine {
  private readonly calibration = new Map<string, number>()

  constructor (
    private readonly database: AgentDatabase,
    private readonly getConfig: () => AgentConfig
  ) {}

  estimateTokens (value: unknown, calibrationKey = '') {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    const base = Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / 3))
    return Math.ceil(base * (this.calibration.get(calibrationKey) || 1))
  }

  observeUsage (calibrationKey: string, estimated: number, actual?: number) {
    if (!actual || !estimated || actual <= 0) return
    const ratio = Math.max(0.5, Math.min(actual / estimated, 3))
    const previous = this.calibration.get(calibrationKey) || 1
    this.calibration.set(calibrationKey, previous * 0.7 + ratio * 0.3)
  }

  requestBudget (input: {
    messages: AgentModelMessage[]
    tools: AgentModelTool[]
    responseSchema?: AgentModelRequest['responseSchema']
    contextWindowTokens?: number
    calibrationKey?: string
  }): AgentRequestBudget {
    const context = this.getConfig().context || defaultContextConfig
    const windowTokens = input.contextWindowTokens || context.defaultWindowTokens
    const messages = this.estimateTokens(input.messages, input.calibrationKey)
    const tools = this.estimateTokens(input.tools, input.calibrationKey)
    const responseSchema = input.responseSchema
      ? this.estimateTokens(input.responseSchema, input.calibrationKey)
      : 0
    const reservedOutput = context.reservedOutputTokens
    return {
      windowTokens,
      softLimit: Math.floor(windowTokens * context.softLimitRatio),
      hardLimit: Math.floor(windowTokens * context.hardLimitRatio),
      messages,
      tools,
      responseSchema,
      reservedOutput,
      total: messages + tools + responseSchema + reservedOutput,
    }
  }

  async prepareRequest (input: {
    threadId: string
    messages: AgentModelMessage[]
    tools: AgentModelTool[]
    responseSchema?: AgentModelRequest['responseSchema']
    legacySummary: string
    contextWindowTokens?: number
    calibrationKey?: string
    forceDeterministic?: boolean
    summarize?: (
      messages: AgentModelMessage[],
      schema: Record<string, unknown>
    ) => Promise<ContextCheckpointV1>
  }): Promise<AgentRequestPreparation> {
    const context = this.getConfig().context || defaultContextConfig
    const priorCheckpointPrefix = 'KARIN_CONTEXT_CHECKPOINT_V1\n'
    const sourceMessages = input.messages.filter(message => !(
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.startsWith(priorCheckpointPrefix)
    ))
    let budget = this.requestBudget({ ...input, messages: sourceMessages })
    if (!input.forceDeterministic && budget.total <= budget.softLimit) {
      return { messages: sourceMessages, budget, compacted: false }
    }

    const groups = modelGroupsFor(sourceMessages)
    let latestUserIndex = -1
    for (let index = groups.length - 1; index >= 0; index--) {
      if (groups[index].some(item => item.role === 'user')) {
        latestUserIndex = index
        break
      }
    }
    let recentCount = 0
    const removable: AgentModelMessage[][] = []
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index]
      const protectedGroup = index === latestUserIndex || group.some(message =>
        message.role === 'system' || message.protected ||
        /artifact(?:Id)?[=:：\s]/i.test(contentText(message.content))
      ) || recentCount < context.protectedRecentMessages
      if (protectedGroup) recentCount += group.length
      else removable.unshift(group)
    }
    const protectedMessages = groups.filter(group => !removable.includes(group)).flat()
    const protectedBudget = this.requestBudget({ ...input, messages: protectedMessages })
    if (protectedBudget.total > protectedBudget.hardLimit) {
      throw new Error(
        `CONTEXT_UNCOMPRESSIBLE: protected=${protectedBudget.messages}, ` +
        `tools=${protectedBudget.tools}, responseSchema=${protectedBudget.responseSchema}, ` +
        `reservedOutput=${protectedBudget.reservedOutput}, hardLimit=${protectedBudget.hardLimit}`
      )
    }
    if (!removable.length) {
      if (budget.total > budget.hardLimit) {
        throw new Error(
          `CONTEXT_UNCOMPRESSIBLE: messages=${budget.messages}, tools=${budget.tools}, ` +
          `responseSchema=${budget.responseSchema}, reservedOutput=${budget.reservedOutput}, ` +
          `hardLimit=${budget.hardLimit}`
        )
      }
      return { messages: sourceMessages, budget, compacted: false }
    }

    const selected: AgentModelMessage[][] = []
    let remaining = [...groups]
    while (removable.length) {
      const group = removable.shift()!
      selected.push(group)
      remaining = remaining.filter(item => item !== group)
      const estimated = this.requestBudget({ ...input, messages: remaining.flat() })
      if (estimated.total <= estimated.softLimit) break
    }
    const cold = selected.flat()
    const latest = await this.database.latestContextSummary(input.threadId)
    const summaryTargetTokens = Math.max(
      128,
      Math.min(
        context.summaryTargetTokens,
        protectedBudget.hardLimit - protectedBudget.total - 128
      )
    )
    const lease = await this.database.acquireContextCompactionLease(input.threadId)
    if (!lease) {
      const checkpoint = deterministicCheckpoint(
        cold,
        latest?.content || input.legacySummary,
        summaryTargetTokens
      )
      const checkpointMessage: AgentModelMessage = {
        role: 'system',
        content: `${priorCheckpointPrefix}${fitSummary(
          checkpointText(checkpoint),
          summaryTargetTokens
        )}`,
        contextId: `checkpoint:lease-fallback:${input.threadId}`,
        protected: true,
      }
      const firstNonSystem = remaining.findIndex(group =>
        group.some(message => message.role !== 'system')
      )
      const insertAt = firstNonSystem < 0 ? remaining.length : firstNonSystem
      remaining.splice(insertAt, 0, [checkpointMessage])
      const messages = remaining.flat()
      budget = this.requestBudget({ ...input, messages })
      if (budget.total > budget.hardLimit) {
        throw new Error(
          `CONTEXT_UNCOMPRESSIBLE: messages=${budget.messages}, tools=${budget.tools}, ` +
          `responseSchema=${budget.responseSchema}, reservedOutput=${budget.reservedOutput}, ` +
          `hardLimit=${budget.hardLimit}`
        )
      }
      return {
        messages,
        budget,
        compacted: true,
        strategy: 'deterministic',
        checkpoint,
      }
    }
    try {
      await agentHookEmit('beforeCompaction', {
        threadId: input.threadId,
        messageIds: cold.flatMap(message => message.contextId ? [message.contextId] : []),
        estimatedTokens: budget.total,
      })
      let checkpoint: ContextCheckpointV1
      let strategy: AgentRequestPreparation['strategy'] = 'deterministic'
      const summaryInputBudget = this.requestBudget({
        messages: cold,
        tools: [],
        responseSchema: {
          name: 'context_checkpoint_v1',
          schema: contextCheckpointSchema,
          strict: true,
        },
        contextWindowTokens: input.contextWindowTokens,
        calibrationKey: input.calibrationKey,
      })
      if (
        !input.forceDeterministic &&
        context.semanticCompaction &&
        input.summarize &&
        summaryInputBudget.total <= summaryInputBudget.softLimit
      ) {
        try {
          checkpoint = await input.summarize(cold, contextCheckpointSchema)
          if (!checkpointValid(checkpoint)) throw new Error('ContextCheckpointV1 校验失败')
          checkpoint.legacySummary ||= latest?.content || input.legacySummary
          strategy = 'semantic'
        } catch {
          checkpoint = deterministicCheckpoint(
            cold,
            latest?.content || input.legacySummary,
            summaryTargetTokens
          )
        }
      } else {
        checkpoint = deterministicCheckpoint(
          cold,
          latest?.content || input.legacySummary,
          summaryTargetTokens
        )
      }
      const content = fitSummary(checkpointText(checkpoint), summaryTargetTokens)
      const sourceMessageIds = cold.flatMap(message => message.contextId ? [message.contextId] : [])
      const pendingCheckpointMessage: AgentModelMessage = {
        role: 'system',
        content: `${priorCheckpointPrefix}${content}`,
        contextId: `checkpoint:pending:${input.threadId}`,
        protected: true,
      }
      const firstNonSystem = remaining.findIndex(group =>
        group.some(message => message.role !== 'system')
      )
      const insertAt = firstNonSystem < 0 ? remaining.length : firstNonSystem
      remaining.splice(insertAt, 0, [pendingCheckpointMessage])
      budget = this.requestBudget({ ...input, messages: remaining.flat() })
      if (budget.total > budget.hardLimit) {
        throw new Error(
          `CONTEXT_UNCOMPRESSIBLE: messages=${budget.messages}, tools=${budget.tools}, ` +
          `responseSchema=${budget.responseSchema}, reservedOutput=${budget.reservedOutput}, ` +
          `hardLimit=${budget.hardLimit}`
        )
      }
      const stored = await this.database.createContextSummary({
        threadId: input.threadId,
        parentId: latest?.id,
        content,
        estimatedTokens: this.estimateTokens(content, input.calibrationKey),
        sourceMessageIds,
        format: 'checkpoint-v1',
        checkpoint,
        coveredThroughMessageId: sourceMessageIds.at(-1) || null,
        sourceCount: sourceMessageIds.length,
      })
      const checkpointMessage: AgentModelMessage = {
        role: 'system',
        content: `${priorCheckpointPrefix}${stored.content}`,
        contextId: `checkpoint:${stored.id}`,
        protected: true,
      }
      remaining[insertAt] = [checkpointMessage]
      const messages = remaining.flat()
      budget = this.requestBudget({ ...input, messages })
      await agentHookEmit('afterCompaction', {
        threadId: input.threadId,
        summaryId: stored.id,
        sourceMessageIds: stored.sourceMessageIds,
        estimatedTokens: stored.estimatedTokens,
      })
      return { messages, budget, compacted: true, strategy, checkpoint }
    } finally {
      await this.database.releaseContextCompactionLease(input.threadId, lease)
    }
  }

  async prepare (input: {
    threadId: string
    messages: AgentHistoryMessage[]
    legacySummary: string
    contextWindowTokens?: number
    calibrationKey?: string
  }): Promise<ContextPreparation> {
    const config = this.getConfig()
    const context = config.context || defaultContextConfig
    const windowTokens = input.contextWindowTokens || context.defaultWindowTokens
    const softLimit = Math.floor(windowTokens * context.softLimitRatio)
    const hardLimit = Math.floor(windowTokens * context.hardLimitRatio)
    const estimatedTokens = this.estimateTokens(input.messages, input.calibrationKey)
    const countExceeded = input.messages.length > config.limits.maxRecentMessages
    const latest = await this.database.latestContextSummary(input.threadId)
    if (estimatedTokens <= softLimit && !countExceeded) {
      return {
        history: input.messages,
        summary: latest?.content || input.legacySummary,
        estimatedTokens,
        compressed: false,
      }
    }

    const groups = groupsFor(input.messages)
    const protectedGroups: AgentHistoryMessage[][] = []
    let protectedMessages = 0
    while (groups.length && protectedMessages < context.protectedRecentMessages) {
      const group = groups.pop()!
      protectedGroups.unshift(group)
      protectedMessages += group.length
    }
    let history = protectedGroups.flat()
    while (
      groups.length &&
      this.estimateTokens([...groups.at(-1)!, ...history], input.calibrationKey) < hardLimit
    ) {
      history = [...groups.pop()!, ...history]
    }

    const summarizedIds = new Set(latest?.sourceMessageIds || [])
    const boundaryIndex = latest?.coveredThroughMessageId
      ? input.messages.findIndex(message => message.id === latest.coveredThroughMessageId)
      : -1
    const compacted = groups.flat().filter(message => {
      const index = input.messages.findIndex(item => item.id === message.id)
      return index > boundaryIndex && !summarizedIds.has(message.id)
    })
    if (!compacted.length) {
      return {
        history: history.slice(-config.limits.maxRecentMessages),
        summary: latest?.content || input.legacySummary,
        estimatedTokens: this.estimateTokens(history, input.calibrationKey),
        compressed: countExceeded,
      }
    }
    const lines = compacted.map(textFor).filter(line => !secretPattern.test(line))
    const summary = fitSummary(
      [latest?.content || input.legacySummary, ...lines].filter(Boolean).join('\n'),
      context.summaryTargetTokens
    )
    await agentHookEmit('beforeCompaction', {
      threadId: input.threadId,
      messageIds: compacted.map(message => message.id),
      estimatedTokens,
    })
    const stored = await this.database.createContextSummary({
      threadId: input.threadId,
      parentId: latest?.id,
      content: summary,
      estimatedTokens: this.estimateTokens(summary, input.calibrationKey),
      sourceMessageIds: compacted.map(message => message.id),
      coveredThroughMessageId: compacted.at(-1)?.id || null,
      sourceCount: compacted.length,
    })
    await agentHookEmit('afterCompaction', {
      threadId: input.threadId,
      summaryId: stored.id,
      sourceMessageIds: stored.sourceMessageIds,
      estimatedTokens: stored.estimatedTokens,
    })
    return {
      history,
      summary: stored.content,
      estimatedTokens: this.estimateTokens(history, input.calibrationKey),
      compressed: true,
    }
  }
}
