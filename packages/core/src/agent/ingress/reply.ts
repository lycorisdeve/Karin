import { segment } from '@/utils/message'
import { agentSendMessage } from './message-elements'

import type { Message } from '@/types/event'
import type { AgentTurnResult } from '@/types/agent'

export const agentResultMessage = async (result: AgentTurnResult) => {
  if (result.state !== 'waiting_approval' || !result.approvalId) {
    return agentSendMessage(result.content)
  }
  return [
    segment.text(
      [
        result.content,
        '/同意（本次同意）',
        '/始终同意（本会话内始终同意该 Tool）',
        '/拒绝',
      ].join('\n')
    ),
  ]
}

export const replyAgentResult = async (event: Message, result: AgentTurnResult) => {
  if (!result.content) return
  return event.reply(await agentResultMessage(result))
}
