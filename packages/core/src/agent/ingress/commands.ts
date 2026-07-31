import { command } from '@/core/karin/command'
import { cache } from '@/plugin/system/cache'
import { pkgSort } from '@/plugin/admin/load'
import { agentActor } from './context'

import type { AgentRuntime } from '../runtime/runtime'

export const registerAgentCommands = (runtime: AgentRuntime) => {
  if (cache.command.some(item => item.file.name === 'Karin Agent 审批')) return

  cache.command.push(
    command(
      /^\/agent\s+(approve|deny)\s+([0-9a-f-]{36})$/i,
      async event => {
        const match = event.msg.match(/^\/agent\s+(approve|deny)\s+([0-9a-f-]{36})$/i)
        if (!match) return false
        try {
          const result = await runtime.resolveApproval(
            match[2],
            match[1].toLowerCase() === 'approve' ? 'approved' : 'denied',
            agentActor(event)
          )
          await event.reply(result.content || `审批已${match[1] === 'approve' ? '允许' : '拒绝'}`)
        } catch (error) {
          await event.reply(`审批处理失败：${(error as Error).message}`)
        }
        return true
      },
      {
        name: 'Karin Agent 审批',
        permission: 'all',
        priority: 100,
        log: true,
      }
    )
  )
  cache.count.command++
  pkgSort()
}
