import { describe, expect, it } from 'vitest'
import { AgentExecutionBudget } from '../../packages/core/src/agent/execution/budget'

import type { AgentToolResultEnvelope } from '../../packages/core/src/types/agent'

const result = (value: number): AgentToolResultEnvelope => ({
  status: 'completed',
  data: { value },
  receipt: {
    toolName: 'test.observe',
    status: 'completed',
    startedAt: value,
    completedAt: value,
    idempotent: true,
  },
  evidence: [`value:${value}`],
})

describe('Agent execution budget', () => {
  it('stops repeated iterations that produce no new evidence', () => {
    const budget = new AgentExecutionBudget(99, 3)
    const snapshot = { tasks: null, toolResults: [result(1)] }

    expect(budget.beginIteration(snapshot).allowed).toBe(true)
    expect(budget.beginIteration(snapshot).allowed).toBe(true)
    expect(budget.beginIteration(snapshot).allowed).toBe(true)
    const stopped = budget.beginIteration(snapshot)

    expect(stopped).toMatchObject({
      allowed: false,
      reason: 'no_progress',
      noProgressIterations: 3,
      maxIterations: 99,
    })
  })

  it('resets stagnation when a task or Tool result adds evidence', () => {
    const budget = new AgentExecutionBudget(99, 2)
    const first = { tasks: null, toolResults: [result(1)] }

    expect(budget.beginIteration(first).allowed).toBe(true)
    expect(budget.beginIteration(first).noProgressIterations).toBe(1)
    const progressed = budget.beginIteration({ tasks: null, toolResults: [result(1), result(2)] })

    expect(progressed).toMatchObject({ allowed: true, noProgressIterations: 0 })
  })

  it('uses 99 as the configurable final circuit breaker', () => {
    const budget = new AgentExecutionBudget(999, 3)
    for (let index = 0; index < 99; index++) {
      expect(budget.beginIteration({
        tasks: null,
        toolResults: [result(index)],
      }).allowed).toBe(true)
    }

    expect(budget.beginIteration({
      tasks: null,
      toolResults: [result(100)],
    })).toMatchObject({
      allowed: false,
      reason: 'iteration_limit',
      iteration: 99,
      maxIterations: 99,
    })
  })
})
