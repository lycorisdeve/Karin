import type {
  AgentPostcondition,
  AgentTaskPlan,
  AgentTaskList,
  AgentToolResultEnvelope,
} from '@/types/agent'

export interface AgentCompletionDecision {
  completed: boolean
  message: string
  activeTaskIds: string[]
  unresolvedTools: string[]
}

const satisfies = (
  condition: AgentPostcondition,
  results: AgentToolResultEnvelope[]
) => {
  const completed = results.filter(result => result.status === 'completed')
  if (condition.kind === 'information') return true
  if (condition.kind === 'delivery') {
    return completed.some(result =>
      result.receipt.delivery?.completed &&
      (result.receipt.delivery.imageSegments || 0) >= (condition.minimumCount || 0)
    )
  }
  if (condition.kind === 'media') {
    return completed.filter(result => result.receipt.media).length >= (condition.minimumCount || 1)
  }
  return completed.some(result =>
    !condition.toolNames.length || condition.toolNames.includes(result.receipt.toolName)
  )
}

export class AgentCompletionGuard {
  verify (
    tasks: AgentTaskList | null,
    results: AgentToolResultEnvelope[],
    assistantContent: string,
    contract?: AgentTaskPlan
  ): AgentCompletionDecision {
    const activeTaskIds = (tasks?.items || [])
      .filter(item => item.status === 'pending' || item.status === 'in_progress')
      .map(item => item.id)
    const unresolvedConditions = (contract?.goals || [])
      .flatMap(goal => goal.postconditions)
      .filter(condition => condition.required && !satisfies(condition, results))
    const requiredTools = new Set(unresolvedConditions.flatMap(item => item.toolNames))
    const unresolvedTools = results
      .filter(result => result.status === 'failed' && requiredTools.has(result.receipt.toolName))
      .map(result => result.receipt.toolName)

    if (activeTaskIds.length) {
      return {
        completed: false,
        message: `任务清单仍有未完成项：${activeTaskIds.join(', ')}`,
        activeTaskIds,
        unresolvedTools,
      }
    }
    if (unresolvedTools.length) {
      return {
        completed: false,
        message: `仍有未恢复的 Tool 失败：${[...new Set(unresolvedTools)].join(', ')}`,
        activeTaskIds,
        unresolvedTools,
      }
    }
    const unresolvedActions = unresolvedConditions.filter(item => item.kind !== 'information')
    if (unresolvedActions.length) {
      return {
        completed: false,
        message: `仍缺少必要结果证据：${unresolvedActions.map(item => item.description).join('；')}`,
        activeTaskIds,
        unresolvedTools,
      }
    }
    if (!assistantContent.trim()) {
      return {
        completed: false,
        message: '最终结果为空',
        activeTaskIds,
        unresolvedTools,
      }
    }
    return {
      completed: true,
      message: '任务状态和 Tool 回执检查通过',
      activeTaskIds,
      unresolvedTools,
    }
  }

  recoveryPrompt (decision: AgentCompletionDecision) {
    return [
      `完成守卫未通过：${decision.message}`,
      '请继续处理未完成任务或失败 Tool；不要重复已经成功的副作用。',
      '完成每个任务后立即用 karin.agent.todo 更新状态，然后再给出最终结论。',
    ].join('\n')
  }
}
