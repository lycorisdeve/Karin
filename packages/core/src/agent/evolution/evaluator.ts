import type { AgentLearning } from '../learning/learning'

export class AgentEvolutionEvaluator {
  constructor (private readonly learning: AgentLearning) {}

  evaluate (...args: Parameters<AgentLearning['evaluateCandidate']>) {
    return this.learning.evaluateCandidate(...args)
  }
}
