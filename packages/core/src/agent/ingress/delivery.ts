import { sendMsg } from '@/service/bot'
import { agentDeliveryTargetFromThread } from './origin'
import { agentResultMessage } from './reply'

import type { AgentTurnResult } from '@/types/agent'
import type { AgentThreadRecord } from '../persistence/database'

export const deliverAgentResult = async (
  thread: AgentThreadRecord,
  result: AgentTurnResult
) => {
  const sent = await dispatchAgentResult(thread, result)
  if (!sent) return false
  if (!sent.messageId) throw new Error('适配器未返回消息 ID')
  return true
}

export const dispatchAgentResult = async (
  thread: AgentThreadRecord,
  result: AgentTurnResult
) => {
  if (!result.content) return false
  const target = agentDeliveryTargetFromThread(thread)
  if (!target) return false
  const sent = await sendMsg(
    target.selfId,
    target.contact,
    await agentResultMessage(result)
  )
  return {
    messageId: String(sent?.messageId || sent?.message_id || ''),
  }
}
