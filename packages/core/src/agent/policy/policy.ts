import type {
  AgentConfig,
  AgentPolicyDecision,
  AgentToolContext,
  AgentToolRisk,
} from '@/types/agent'
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

  risk (tool: AgentTool, input: Record<string, unknown> = {}): AgentToolRisk {
    const order: Record<AgentToolRisk, number> = {
      read: 0,
      write: 1,
      external: 2,
      destructive: 3,
    }
    const base = tool.risk || 'read'
    let resolved = base
    try {
      resolved = tool.riskResolver?.(input) || base
    } catch {
      resolved = 'destructive'
    }
    return order[resolved] > order[base] ? resolved : base
  }

  decide (
    tool: AgentTool,
    context: AgentToolContext,
    input: Record<string, unknown> = {}
  ): AgentPolicyDecision {
    const permission = tool.permission || 'all'
    if ((levels[context.actor.role] ?? 0) < (levels[permission] ?? Number.MAX_SAFE_INTEGER)) {
      return 'deny'
    }

    const config = this.getConfig().policy
    if (config.hardDeny.some(pattern => wildcard(pattern, tool.name))) return 'deny'

    const exact = config.rules.find(rule => rule.pattern === tool.name)
    const matched = exact || config.rules.find(rule => wildcard(rule.pattern, tool.name))
    const risk = this.risk(tool, input)
    let decision = matched?.decision || config.defaults[risk]
    if (
      !matched &&
      config.autoApproveTrustedReversible &&
      risk === 'write' &&
      tool.reversible &&
      tool.name.startsWith('karin.')
    ) {
      decision = 'allow'
    }

    if (context.automated) {
      if (risk === 'destructive') return 'deny'
      if (decision === 'ask') {
        decision = context.allowedTools?.includes(tool.name) ? 'allow' : 'deny'
      }
    }

    return decision
  }
}
