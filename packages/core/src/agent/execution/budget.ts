import { createHash } from 'node:crypto'

import type { AgentTaskList, AgentToolResultEnvelope } from '@/types/agent'

export type AgentExecutionBudgetStopReason = 'iteration_limit' | 'no_progress'

export interface AgentExecutionBudgetSnapshot {
  tasks: AgentTaskList | null
  toolResults: AgentToolResultEnvelope[]
}

export interface AgentExecutionBudgetDecision {
  allowed: boolean
  iteration: number
  maxIterations: number
  remaining: number
  noProgressIterations: number
  reason?: AgentExecutionBudgetStopReason
  warning?: string
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

const hash = (value: unknown) => createHash('sha256')
  .update(JSON.stringify(canonical(value)))
  .digest('hex')

const resultFingerprint = (result: AgentToolResultEnvelope) => hash({
  toolName: result.receipt.toolName,
  status: result.status,
  inputHash: result.inputHash,
  errorCode: result.errorCode,
  error: result.error,
  evidence: [...result.evidence].sort(),
  data: result.data,
})

const snapshotFingerprint = (snapshot: AgentExecutionBudgetSnapshot) => hash({
  tasks: snapshot.tasks?.items.map(item => ({ id: item.id, status: item.status })) || [],
  results: [...new Set(snapshot.toolResults.map(resultFingerprint))].sort(),
})

/**
 * Controls model/tool iteration from observable progress rather than Tool names.
 * The configured iteration limit is the final circuit breaker; repeated rounds
 * without new task state, receipts, errors or result data stop much earlier.
 */
export class AgentExecutionBudget {
  private iterations = 0
  private noProgressIterations = 0
  private previousSnapshot?: string
  private readonly warnings = new Set<number>()

  readonly maxIterations: number
  readonly maxNoProgressIterations: number

  constructor (maxIterations: number, maxNoProgressIterations = 3) {
    this.maxIterations = Math.max(1, Math.min(Math.trunc(maxIterations) || 99, 99))
    this.maxNoProgressIterations = Math.max(
      1,
      Math.min(Math.trunc(maxNoProgressIterations) || 3, 10)
    )
  }

  beginIteration (snapshot: AgentExecutionBudgetSnapshot): AgentExecutionBudgetDecision {
    const currentSnapshot = snapshotFingerprint(snapshot)
    if (this.previousSnapshot !== undefined) {
      if (currentSnapshot === this.previousSnapshot) this.noProgressIterations++
      else this.noProgressIterations = 0
    }
    this.previousSnapshot = currentSnapshot

    if (this.noProgressIterations >= this.maxNoProgressIterations) {
      return this.decision(false, 'no_progress')
    }
    if (this.iterations >= this.maxIterations) {
      return this.decision(false, 'iteration_limit')
    }

    this.iterations++
    const percentage = this.iterations / this.maxIterations
    const crossed = [0.5, 0.75, 0.9]
      .filter(value => percentage >= value && !this.warnings.has(value))
    crossed.forEach(value => this.warnings.add(value))
    const threshold = crossed.at(-1)
    return this.decision(
      true,
      undefined,
      threshold
        ? `执行预算已使用 ${Math.round(threshold * 100)}%，请优先完成未满足条件，避免重复调用。`
        : undefined
    )
  }

  failureMessage (decision: AgentExecutionBudgetDecision) {
    if (decision.reason === 'no_progress') {
      return `执行已停止：连续 ${decision.noProgressIterations} 轮未获得新的任务状态、Tool 回执或结果证据。`
    }
    return `执行已达到配置的最大 ${decision.maxIterations} 轮迭代，已停止以避免无限循环。`
  }

  private decision (
    allowed: boolean,
    reason?: AgentExecutionBudgetStopReason,
    warning?: string
  ): AgentExecutionBudgetDecision {
    return {
      allowed,
      iteration: this.iterations,
      maxIterations: this.maxIterations,
      remaining: Math.max(0, this.maxIterations - this.iterations),
      noProgressIterations: this.noProgressIterations,
      reason,
      warning,
    }
  }
}
