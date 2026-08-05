import { hooks } from '@/hooks'
import { adapter } from '@/utils/config/file/adapter'
import { AgentIngressFeedback } from './feedback'

import type { Message } from '@/types/event'
import type { AgentConfig } from '@/types/agent'
import type { AgentRuntime } from '../runtime/runtime'
import { agentActor } from './context'
import { replyAgentResult } from './reply'

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

const elapsed = (value: number) => {
  const seconds = Math.max(0, Math.floor(value / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export const registerAgentIngress = (runtime: AgentRuntime, getConfig: () => AgentConfig) => {
  const feedback = new Map<string, { id: string, value: AgentIngressFeedback }>()
  return hooks.empty.message(
    async (event, next) => {
      const content = getAgentTriggerContent(event, getConfig())
      if (!content) {
        next()
        return
      }

      try {
        const actor = agentActor(event)
        const session = await runtime.currentSession(actor)
        const submission = runtime.submitInteractiveTurn({
          threadKey: session.threadKey,
          actor,
          content,
          event,
          idempotencyKey: event.messageId
            ? `${actor.origin?.channel || 'channel'}:${event.selfId}:${event.messageId}`
            : undefined,
        })
        const currentFeedback = new AgentIngressFeedback(event)
        const previousFeedback = feedback.get(session.threadKey)
        if (previousFeedback) previousFeedback.value.stop().catch(() => undefined)
        feedback.set(session.threadKey, {
          id: submission.requestId,
          value: currentFeedback,
        })
        currentFeedback.start()
        if (submission.interrupted) {
          await event.reply(
            `⚡ 正在中断并合并当前任务（已运行 ${
              elapsed(submission.interrupted.elapsedMs)
            }，第 ${submission.interrupted.round}/${
              submission.interrupted.maxRounds
            } 轮，正在执行：${submission.interrupted.operation}）。` +
            '我会结合你刚发的内容继续处理。'
          )
        }
        try {
          const result = await submission.result
          if (submission.isLatest()) {
            if (typeof runtime.deliverEventResult === 'function') {
              await runtime.deliverEventResult(event, result, actor.id)
            } else {
              await replyAgentResult(event, result)
            }
          }
        } finally {
          const activeFeedback = feedback.get(session.threadKey)
          if (activeFeedback?.id === submission.requestId) {
            feedback.delete(session.threadKey)
            await activeFeedback.value.stop()
          }
          submission.release()
        }
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
}
