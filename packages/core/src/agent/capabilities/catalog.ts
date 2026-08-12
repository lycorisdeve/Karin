import type {
  AgentCapabilityDescriptor,
  AgentCapabilitySource,
} from '@/types/agent'
import type { AgentDatabase } from '../persistence/database'
import type { AgentToolRegistry } from '../tools/registry'

const termsFor = (query: string) => [...new Set(
  query.toLowerCase()
    .split(/[\s,，。！？、:：;；()[\]{}"'`]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2)
)]

export class AgentCapabilityCatalog {
  constructor (
    private readonly database: AgentDatabase,
    private readonly registry: AgentToolRegistry
  ) {}

  async list (threadId: string, callableTools?: string[]) {
    const callable = callableTools ? new Set(callableTools) : null
    const [tools, skills] = await Promise.all([
      Promise.resolve(this.registry.list()),
      this.database.getThreadSkillIndex(threadId),
    ])
    const descriptors: AgentCapabilityDescriptor[] = [
      ...tools.map(tool => ({
        name: tool.name,
        kind: 'tool' as const,
        description: tool.description,
        source: tool.sourceKind as AgentCapabilitySource,
        toolset: tool.toolset,
        tags: tool.tags,
        risk: tool.risk,
        reversible: tool.reversible,
        registered: true,
        available: tool.available,
        callable: tool.available && (!callable || callable.has(tool.name)),
        requirements: tool.requirements,
        owner: tool.owner,
        sensitivity: tool.sensitivity,
        restartSafe: tool.restartSafe,
        unavailableReason: tool.unavailableReason,
      })),
      ...skills.map(skill => ({
        name: skill.name,
        kind: 'skill' as const,
        description: skill.description,
        source: 'skill-library' as const,
        tags: [],
        version: String(skill.version),
        registered: true,
        available: true,
        requirements: skill.tools,
      })),
    ]
    return descriptors
  }

  async search (
    threadId: string,
    query: string,
    callableTools?: string[],
    limit = 24
  ) {
    const terms = termsFor(query)
    const score = (item: AgentCapabilityDescriptor) => {
      const value = [
        item.name,
        item.description,
        item.tags.join(' '),
        item.toolset || '',
      ].join(' ').toLowerCase()
      return terms.reduce((total, term) => total + (value.includes(term) ? 1 : 0), 0)
    }
    return (await this.list(threadId, callableTools))
      .map((item, index) => ({ item, index, score: score(item) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map(item => item.item)
  }
}
