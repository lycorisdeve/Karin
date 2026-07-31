import { hooks } from '@/hooks'
import { adapter } from '@/utils/config/file/adapter'
import { replyAgentResult } from './reply'

import type { Message } from '@/types/event'
import type { AgentConfig } from '@/types/agent'
import type { AgentRuntime } from '../runtime/runtime'
import { agentActor } from './context'

export const getAgentTriggerContent = (event: Message, config: AgentConfig) => {
  const content = event.msg.trim() || (
    event.image.length
      ? `[用户发送了 ${event.image.length} 张图片]`
      : ''
  )
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
    const channel = event.bot.adapter.platform
    if ([
      'qqbot',
      'wechat',
      'dingtalk',
      'discord',
      'whatsapp',
      'email',
    ].includes(channel)) {
      const accounts = adapter()[channel as
        'qqbot' | 'wechat' | 'dingtalk' | 'discord' | 'whatsapp' | 'email']
      return accounts.find(
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

export const registerAgentIngress = (runtime: AgentRuntime, getConfig: () => AgentConfig) =>
  hooks.empty.message(
    async (event, next) => {
      const content = getAgentTriggerContent(event, getConfig())
      if (!content) {
        next()
        return
      }

      try {
        const actor = agentActor(event)
        const session = await runtime.currentSession(actor)
        const result = await runtime.runTurn({
          threadKey: session.threadKey,
          actor,
          content,
          event,
        })
        await replyAgentResult(event, result)
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
