import type { AgentActor } from '@/types/agent'
import type { AgentLearning } from '../learning/learning'

/**
 * Retrieval 是运行时唯一的记忆/Skill 索引检索入口。
 * AgentLearning 暂时保留底层实现以兼容旧 HTTP 与插件调用。
 */
export class AgentEvolutionRetrieval {
  constructor (private readonly learning: AgentLearning) {}

  contextFor (
    threadId: string,
    turnId: string,
    actor: AgentActor,
    query: string
  ) {
    return this.learning.contextFor(threadId, turnId, actor, query)
  }
}
