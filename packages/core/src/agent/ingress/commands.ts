import { command } from '@/core/karin/command'
import { cache } from '@/plugin/system/cache'
import { agentActor } from './context'

import type { AgentRuntime } from '../runtime/runtime'
import type { Message } from '@/types/event'

const commandPattern =
  /^(?:\/agent\s+(?:approve|deny)\s+[0-9a-f-]{36}(?:\s+(?:thread|delegate))?|\/(?:approve|deny)\s+[0-9a-f-]{36}(?:\s+(?:thread|delegate))?|\/model(?:\s+.+)?|\/(?:new|stop|help|同意|始终同意|拒绝)|同意|允许|拒绝)$/i

const canManageSession = (event: Message) => {
  if (event.isPrivate) return true
  return ['master', 'admin', 'group.owner', 'group.admin', 'guild.owner', 'guild.admin'].includes(
    agentActor(event).role
  )
}

export const registerAgentCommands = (runtime: AgentRuntime) => {
  if (cache.command.some(item => item.file.name === 'Karin Agent 审批')) return

  cache.command.unshift(
    command(
      commandPattern,
      async event => {
        const content = event.msg.trim()
        if (!commandPattern.test(content)) return false
        const actor = agentActor(event)
        try {
          if (/^\/help$/i.test(content)) {
            await event.reply(
              [
                'Karin Agent 会话命令：',
                '/new 新建会话',
                '/stop 停止当前会话及子 Agent',
                '/model 查看或切换当前会话模型',
                '/model reset 恢复全局主模型',
                '/同意 本次同意',
                '/始终同意 本会话内始终同意该 Tool',
                '/拒绝 拒绝本次调用',
                '/help 查看帮助',
              ].join('\n')
            )
            return true
          }
          if (/^\/model(?:\s|$)/i.test(content)) {
            if (!canManageSession(event)) {
              await event.reply('群聊或频道中只有主人、管理员、群主或群管理员可以切换模型。')
              return true
            }
            const thread = await runtime.currentSession(actor)
            const argument = content.replace(/^\/model\b/i, '').trim()
            if (!argument) {
              const current = await runtime.describeThreadModel(thread.id)
              await event.reply(
                [
                  `当前模型：${current.providerName} · ${current.model || '未配置'}`,
                  current.inherited ? '来源：全局主模型' : '来源：当前会话',
                  '',
                  '可用模型：',
                  ...current.models.map(
                    (item, index) =>
                      `${index + 1}. ${item.providerName} · ${item.model} (${item.providerId})`
                  ),
                  '',
                  '使用 /model <序号> 或 /model <providerId> <model> 切换',
                  '使用 /model reset 恢复全局主模型',
                ].join('\n')
              )
              return true
            }
            if (/^reset$/i.test(argument)) {
              await runtime.setSessionModel(actor, null, null)
              await event.reply('当前会话已恢复使用全局主模型。')
              return true
            }
            const models = runtime.listSelectableModels()
            const number = Number(argument)
            const selected = Number.isInteger(number) && number > 0
              ? models[number - 1]
              : (() => {
                const match = argument.match(/^(\S+)\s+(.+)$/)
                if (!match) return undefined
                return models.find(
                  item => item.providerId === match[1] && item.model === match[2].trim()
                )
              })()
            if (!selected) {
              await event.reply('模型选择无效，请先使用 /model 查看可用模型。')
              return true
            }
            await runtime.setSessionModel(actor, selected.providerId, selected.model)
            await event.reply(
              `当前会话将在下一回合使用 ${selected.providerName} · ${selected.model}。`
            )
            return true
          }
          if (/^\/(?:new|stop)$/i.test(content)) {
            if (!canManageSession(event)) {
              await event.reply('群聊或频道中只有主人、管理员、群主或群管理员可以管理会话。')
              return true
            }
            if (/^\/new$/i.test(content)) {
              const thread = await runtime.newSession(actor)
              await event.reply(`已创建新会话：${thread.id}`)
            } else {
              const thread = await runtime.currentSession(actor)
              const result = await runtime.interruptTree(thread.id)
              await event.reply(
                result.interrupted
                  ? `已停止当前会话：${result.turns} 个回合、${result.subagents} 个子 Agent、${result.approvals} 个审批。`
                  : '当前会话没有正在运行的操作。'
              )
            }
            return true
          }

          const explicit = content.match(
            /^\/(?:agent\s+)?(approve|deny)\s+([0-9a-f-]{36})(?:\s+(thread|delegate))?$/i
          )
          let approvalId = explicit?.[2]
          let remaining = 0
          const decision: 'approved' | 'denied' =
            explicit?.[1].toLowerCase() === 'deny' || /^\/?拒绝$/i.test(content)
              ? 'denied'
              : 'approved'
          if (!approvalId) {
            const pending = await runtime.listPendingSessionApprovals(actor)
            if (!pending.length) {
              await event.reply('当前会话没有等待处理的审批。')
              return true
            }
            approvalId = pending[0].id
            remaining = pending.length - 1
          }
          const scope =
            decision === 'approved'
              ? /^\/始终同意$/i.test(content)
                ? 'thread'
                : explicit?.[3]
                  ? (explicit[3].toLowerCase() as 'thread' | 'delegate')
                  : 'once'
              : 'once'
          const result = await runtime.resolveApproval(approvalId, decision, actor, scope)
          if (result.content) {
            await runtime.deliverEventResult(event, result, actor.id)
          } else {
            await event.reply(`审批已${decision === 'approved' ? '允许' : '拒绝'}`)
          }
          if (remaining > 0) {
            await event.reply(`当前会话还有 ${remaining} 个待审批操作。`)
          }
        } catch (error) {
          await event.reply(`Agent 操作失败：${(error as Error).message}`)
        }
        return true
      },
      {
        name: 'Karin Agent 审批',
        description: '管理 Agent 会话、模型和当前待审批 Tool',
        usage: [
          '/new',
          '/stop',
          '/model',
          '/model <序号>',
          '/model <providerId> <model>',
          '/model reset',
          '/同意',
          '/始终同意',
          '/拒绝',
          '/help',
        ],
        permission: 'all',
        priority: 100,
        log: true,
      }
    )
  )
  cache.count.command++
}
