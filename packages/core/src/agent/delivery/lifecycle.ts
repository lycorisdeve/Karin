import type {
  AgentDeliveryReceipt,
  AgentDeliveryState,
} from '@/types/agent'
import type {
  AgentDatabase,
  AgentDeliveryOperationRecord,
} from '../persistence/database'

export interface AgentDispatchResult {
  messageId?: string
}

export class AgentDispatchError extends Error {
  constructor (
    message: string,
    readonly state: Extract<AgentDeliveryState, 'not_sent' | 'unknown_after_send'>,
    readonly code = 'DELIVERY_FAILED'
  ) {
    super(message)
  }
}

export class AgentMessageLifecycle {
  constructor (private readonly database: AgentDatabase) {}

  async deliver (input: {
    threadId: string
    turnId: string
    finalMessageId: string
    channel: string
    accountId: string
    contactKey: string
    payload: string
    dispatch: () => Promise<AgentDispatchResult>
  }): Promise<AgentDeliveryReceipt> {
    const operation = await this.database.createDeliveryOperation({
      ...input,
      idempotencyKey: [
        'agent-final',
        input.finalMessageId,
        input.channel,
        input.accountId,
        input.contactKey,
      ].join(':'),
    })
    if (operation.state === 'sent' || operation.state === 'unknown_after_send') {
      return this.receipt(operation)
    }
    await this.database.updateDeliveryOperation({
      id: operation.id,
      state: 'dispatching',
      incrementAttempts: true,
    })
    try {
      const result = await input.dispatch()
      if (!result.messageId) {
        throw new AgentDispatchError(
          '渠道调用已发起，但适配器未返回消息 ID',
          'unknown_after_send',
          'DELIVERY_RECEIPT_UNKNOWN'
        )
      }
      const sent = await this.database.updateDeliveryOperation({
        id: operation.id,
        state: 'sent',
        adapterMessageId: result.messageId,
      })
      return this.receipt(sent!)
    } catch (error) {
      const known = error instanceof AgentDispatchError
      const state = known ? error.state : 'unknown_after_send'
      const failed = await this.database.updateDeliveryOperation({
        id: operation.id,
        state,
        errorCode: known ? error.code : 'DELIVERY_EXCEPTION',
        error: (error as Error).message,
      })
      return this.receipt(failed!)
    }
  }

  private receipt (operation: AgentDeliveryOperationRecord): AgentDeliveryReceipt {
    return {
      operationId: operation.id,
      state: operation.state,
      channel: operation.channel,
      adapterMessageId: operation.adapterMessageId || undefined,
      retrySafe: operation.state === 'not_sent',
      errorCode: operation.errorCode || undefined,
      error: operation.error || undefined,
    }
  }
}
