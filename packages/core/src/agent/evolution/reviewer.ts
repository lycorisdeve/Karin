import type { AgentLearning } from '../learning/learning'

export class AgentEvolutionReviewer {
  constructor (private readonly learning: AgentLearning) {}

  review (outcome: Parameters<AgentLearning['learn']>[0]) {
    return this.learning.learn(outcome)
  }

  feedback (input: Parameters<AgentLearning['feedback']>[0]) {
    return this.learning.feedback(input)
  }
}
