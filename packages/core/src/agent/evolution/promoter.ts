import type { AgentLearning } from '../learning/learning'

export class AgentEvolutionPromoter {
  constructor (private readonly learning: AgentLearning) {}

  promote (...args: Parameters<AgentLearning['promoteCandidate']>) {
    return this.learning.promoteCandidate(...args)
  }

  rollback (...args: Parameters<AgentLearning['rollbackCandidate']>) {
    return this.learning.rollbackCandidate(...args)
  }
}
