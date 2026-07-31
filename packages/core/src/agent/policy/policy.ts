import type { AgentConfig, AgentPolicyDecision, AgentToolContext } from '@/types/agent'
import type { AgentTool } from '@/types/plugin'
import type { Permission } from '@/types/event'

const levels: Record<Permission, number> = {
  all: 0,
  'group.admin': 40,
  'guild.admin': 40,
  'group.owner': 60,
  'guild.owner': 60,
  admin: 80,
  master: 100,
}

const wildcard = (pattern: string, value: string) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

export class AgentPolicy {
  constructor (private readonly getConfig: () => AgentConfig) {}

  decide (tool: AgentTool, context: AgentToolContext): AgentPolicyDecision {
    const permission = tool.permission || 'all'
    if ((levels[context.actor.role] ?? 0) < (levels[permission] ?? Number.MAX_SAFE_INTEGER)) {
      return 'deny'
    }

    const config = this.getConfig().policy
    if (config.hardDeny.some(pattern => wildcard(pattern, tool.name))) return 'deny'

    const exact = config.rules.find(rule => rule.pattern === tool.name)
    const matched = exact || config.rules.find(rule => wildcard(rule.pattern, tool.name))
    let decision = matched?.decision || config.defaults[tool.risk || 'read']

    if (context.automated) {
      if (tool.risk === 'destructive') return 'deny'
      if (decision === 'ask') {
        decision = context.allowedTools?.includes(tool.name) ? 'allow' : 'deny'
      }
    }

    return decision
  }
}
