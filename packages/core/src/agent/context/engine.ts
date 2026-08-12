import type { AgentConfig, AgentToolCall } from '@/types/agent'
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

const secretPattern = /authorization|cookie|token|password|api[-_]?key|secret/i

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

const fitSummary = (value: string, targetTokens: number) => {
  const maxBytes = targetTokens * 3
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const characters = Math.max(500, Math.floor(maxBytes / 2))
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

  async prepare (input: {
    threadId: string
    messages: AgentHistoryMessage[]
    legacySummary: string
    contextWindowTokens?: number
    calibrationKey?: string
  }): Promise<ContextPreparation> {
    const config = this.getConfig()
    const context = config.context || {
      defaultWindowTokens: 65536,
      softLimitRatio: 0.5,
      hardLimitRatio: 0.85,
      protectedRecentMessages: 12,
      summaryTargetTokens: 4096,
    }
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
    const compacted = groups.flat().filter(message => !summarizedIds.has(message.id))
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
      sourceMessageIds: [
        ...(latest?.sourceMessageIds || []),
        ...compacted.map(message => message.id),
      ],
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
