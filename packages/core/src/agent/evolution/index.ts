import type { AgentLearning } from '../learning/learning'
import { AgentEvolutionEvaluator } from './evaluator'
import { AgentEvolutionPromoter } from './promoter'
import { AgentEvolutionRetrieval } from './retrieval'
import { AgentEvolutionReviewer } from './reviewer'

export class AgentEvolutionPipeline {
  readonly retrieval: AgentEvolutionRetrieval
  readonly reviewer: AgentEvolutionReviewer
  readonly evaluator: AgentEvolutionEvaluator
  readonly promoter: AgentEvolutionPromoter

  constructor (learning: AgentLearning) {
    this.retrieval = new AgentEvolutionRetrieval(learning)
    this.reviewer = new AgentEvolutionReviewer(learning)
    this.evaluator = new AgentEvolutionEvaluator(learning)
    this.promoter = new AgentEvolutionPromoter(learning)
  }
}
