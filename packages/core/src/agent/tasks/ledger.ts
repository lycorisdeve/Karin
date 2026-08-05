import type {
  AgentConfig,
  AgentTaskItemStatus,
  AgentTaskList,
} from '@/types/agent'
import type { AgentDatabase } from '../persistence/database'

export interface AgentTodoInput {
  goal?: string
  merge?: boolean
  todos?: Array<{
    id: string
    content?: string
    status?: AgentTaskItemStatus
  }>
}

const complexMarkers = [
  /(?:^|\n)\s*(?:[-*]|\d+[.)、])\s+\S+/gm,
  /先.+(?:再|然后|最后)/s,
  /(?:分别|并行|分工|多个子任务|多个任务|分解|步骤|同时完成|以及)/,
  /\b(?:first|then|finally|multiple tasks|steps|in parallel)\b/i,
]

export class AgentTaskLedger {
  constructor (
    private readonly database: AgentDatabase,
    private readonly getConfig: () => AgentConfig
  ) {}

  shouldPlan (content: string) {
    if (this.getConfig().tasks?.enabled === false) return false
    const markerHits = complexMarkers.map(pattern => {
      pattern.lastIndex = 0
      return pattern.test(content)
    }).filter(Boolean).length
    const enumerated = content.match(/(?:^|\n)\s*(?:[-*]|\d+[.)、])\s+\S+/gm)?.length || 0
    return enumerated >= 2 || markerHits >= 2
  }

  read (threadId: string) {
    return this.database.getActiveTaskList(threadId)
  }

  history (threadId: string, limit = 50) {
    return this.database.listTaskLists(threadId, limit)
  }

  async resume (
    threadId: string,
    turnId: string,
    actorId: string,
    supplements: string[]
  ) {
    const current = await this.read(threadId)
    if (!current || !supplements.length) return current
    return this.write(threadId, turnId, actorId, current.goal, {
      merge: true,
      todos: [
        ...current.items
          .filter(item => item.status === 'in_progress')
          .map(item => ({ id: item.id, status: 'pending' as const })),
        ...supplements.map((content, index) => ({
          id: `supplement-${turnId.slice(0, 8)}-${index + 1}`,
          content,
          status: 'pending' as const,
        })),
      ],
    })
  }

  async write (
    threadId: string,
    turnId: string,
    actorId: string,
    fallbackGoal: string,
    input: AgentTodoInput
  ) {
    if (!Array.isArray(input.todos)) return this.read(threadId)
    const result = await this.database.writeTaskList({
      threadId,
      sourceTurnId: turnId,
      goal: String(input.goal || fallbackGoal).trim(),
      merge: Boolean(input.merge),
      maxItems: this.getConfig().tasks?.maxItems || 64,
      items: input.todos,
    })
    await this.database.audit(
      actorId,
      'task.updated',
      result.id,
      {
        state: result.state,
        merge: Boolean(input.merge),
        items: result.items.map(item => ({
          id: item.id,
          status: item.status,
        })),
      },
      threadId
    )
    return result
  }

  formatForPrompt (list: AgentTaskList | null) {
    if (!list?.items.length) return ''
    const markers: Record<AgentTaskItemStatus, string> = {
      pending: '[ ]',
      in_progress: '[>]',
      completed: '[x]',
      cancelled: '[~]',
    }
    const active = list.items.filter(item =>
      item.status === 'pending' || item.status === 'in_progress'
    )
    if (!active.length) return ''
    return [
      '当前活动任务清单（完成后立即用 karin.agent.todo 更新状态）：',
      ...active.map(item =>
        `- ${markers[item.status]} ${item.id}. ${item.content} (${item.status})`
      ),
    ].join('\n')
  }

  summary (list: AgentTaskList | null) {
    const items = list?.items || []
    return {
      todos: items,
      summary: {
        total: items.length,
        pending: items.filter(item => item.status === 'pending').length,
        inProgress: items.filter(item => item.status === 'in_progress').length,
        completed: items.filter(item => item.status === 'completed').length,
        cancelled: items.filter(item => item.status === 'cancelled').length,
      },
    }
  }
}
