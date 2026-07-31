import { hooks } from '@/hooks'
import { segment } from '@/utils/message'
import { adapter } from '@/utils/config/file/adapter'

import type { Message } from '@/types/event'
import type { AgentConfig, AgentTurnResult } from '@/types/agent'
import type { AgentRuntime } from '../runtime/runtime'
import { agentActor, agentThreadKey } from './context'

export const getAgentTriggerContent = (event: Message, config: AgentConfig) => {
  const content = event.msg.trim()
  if (!content) return null
  if (event.isPrivate) return config.trigger.private ? content : null

  const channelWakeWords = (() => {
    if (!event.bot?.adapter) return []
    if (event.bot.adapter.platform === 'wecom') {
      return adapter().wecom.find(item => `wecom:${item.botId}` === event.selfId)?.trigger.wakeWords
    }
    if (event.bot.adapter.platform === 'feishu') {
      return adapter().feishu.find(item => `feishu:${item.appId}` === event.selfId)?.trigger.wakeWords
    }
    if (event.bot.adapter.platform === 'telegram') {
      return adapter().telegram.find(
        item => item.id === event.bot.account?.subId?.channel
      )?.trigger.wakeWords
    }
    return []
  })() || []
  const wakeWord = [...channelWakeWords, ...config.trigger.wakeWords].find(
    word => word.trim() && content.toLowerCase().startsWith(word.trim().toLowerCase())
  )
  if (wakeWord) return content.slice(wakeWord.length).trim() || content
  if (config.trigger.groupMention && event.atBot) return content
  return null
}

const replyResult = async (event: Message, result: AgentTurnResult) => {
  if (!result.content) return
  if (result.state !== 'waiting_approval' || !result.approvalId) {
    await event.reply(result.content)
    return
  }

  const approve = `/agent approve ${result.approvalId}`
  const deny = `/agent deny ${result.approvalId}`
  try {
    await event.reply([
      segment.text(`${result.content}\n不支持按钮时可发送：\n${approve}\n${deny}`),
      segment.button([
        {
          text: '允许一次',
          data: approve,
          enter: true,
          reply: true,
          style: 1,
          list: [event.userId],
        },
        {
          text: '拒绝',
          data: deny,
          enter: true,
          reply: true,
          style: 3,
          list: [event.userId],
        },
      ]),
    ])
  } catch {
    await event.reply(`${result.content}\n${approve}\n${deny}`)
  }
}

export const registerAgentIngress = (runtime: AgentRuntime, getConfig: () => AgentConfig) =>
  hooks.empty.message(
    async (event, next) => {
      const content = getAgentTriggerContent(event, getConfig())
      if (!content) {
        next()
        return
      }

      try {
        const result = await runtime.runTurn({
          threadKey: agentThreadKey(event),
          actor: agentActor(event),
          content,
          event,
        })
        await replyResult(event, result)
      } catch (error) {
        logger.error(new Error('[agent][ingress] 未匹配消息处理失败', { cause: error }))
        try {
          await event.reply('Karin Agent 当前不可用，请稍后重试。')
        } catch {
          // Adapter reply failures are already logged by the message layer.
        }
      }
    },
    { priority: 9000 }
  )
