import type { AgentConfig, AgentToolResultEnvelope } from '@/types/agent'
import type { AgentDatabase } from '../persistence/database'

export class AgentRunJournal {
  constructor (
    private readonly database: AgentDatabase,
    private readonly getConfig: () => AgentConfig
  ) {}

  async claim () {
    const turns = await this.database.claimRecoverableTurns(
      this.getConfig().journal?.recoveryAttempts ?? 2
    )
    return turns.map(turn => {
      const outstanding = turn.toolCalls.filter(call =>
        ['pending', 'running', 'waiting_approval'].includes(call.status)
      )
      const unsafe = outstanding.filter(call => !(call.idempotent && call.restartSafe))
      const receipts: AgentToolResultEnvelope[] = turn.toolCalls
        .filter(call => call.status === 'completed')
        .map(call => ({
          status: 'completed' as const,
          data: call.output,
          receipt: {
            toolName: call.name,
            status: 'completed' as const,
            startedAt: call.createdAt,
            completedAt: call.completedAt || call.updatedAt,
            idempotent: call.idempotent,
            restartSafe: call.restartSafe,
          },
          evidence: [`tool:${call.name}:completed`],
        }))
      return {
        ...turn,
        safe: unsafe.length === 0,
        unsafeTools: unsafe.map(call => call.name),
        interruptedCalls: outstanding,
        receipts,
      }
    })
  }
}
