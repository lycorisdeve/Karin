import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { agentHookEmit } from '@/hooks/agent'

import type { AgentDatabase } from '../persistence/database'
import type { AgentActor, AgentConfig, AgentModelProvider } from '@/types/agent'
import type { AgentToolRegistry } from '../tools/registry'

interface LearningCandidate {
  memories?: Array<{
    content: string
    scope?: 'user' | 'group' | 'global'
  }>
  skill?: {
    name: string
    description: string
    instructions: string
    tools?: string[]
  } | null
}

const forbidden = [
  /ignore (all|previous) instructions/i,
  /绕过.{0,8}(权限|审批|安全)/,
  /(?:api[_ -]?key|token|password|cookie|private key)\s*[:=]/i,
  /```(?:js|ts|javascript|typescript|sh|bash|powershell|python)/i,
  /\b(?:npm|pnpm|yarn|pip)\s+install\b/i,
  /\b(?:exec|spawn|eval|Function)\s*\(/,
]

const parseCandidate = (content: string): LearningCandidate | null => {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const value = JSON.parse(normalized)
    return value && typeof value === 'object' ? (value as LearningCandidate) : null
  } catch {
    return null
  }
}

export class AgentLearning {
  constructor (
    private readonly database: AgentDatabase,
    private readonly provider: AgentModelProvider,
    private readonly registry: AgentToolRegistry,
    private readonly getConfig: () => AgentConfig,
    private readonly skillsDirectory: string
  ) {}

  memoryScopes (actor: AgentActor) {
    const scopes: Array<{ scope: string; key: string }> = [{ scope: 'global', key: 'global' }]
    if (['group', 'groupTemp', 'guild'].includes(actor.scene)) {
      scopes.push({ scope: 'group', key: actor.contactKey })
    } else {
      scopes.push({ scope: 'user', key: actor.id })
    }
    return scopes
  }

  async contextFor (threadId: string, actor: AgentActor) {
    const [memories, skills] = await Promise.all([
      this.database.listMemories(this.memoryScopes(actor)),
      this.database.getThreadSkillContents(threadId),
    ])
    return {
      memories: memories.map(item => item.content),
      skills,
    }
  }

  async learn (
    threadId: string,
    turnId: string,
    actor: AgentActor,
    user: string,
    assistant: string,
    signal: AbortSignal
  ) {
    const config = this.getConfig()
    if (!config.learning.memory && !config.learning.skills) return

    const response = await this.provider.complete({
      model: '',
      signal,
      tools: [],
      messages: [
        {
          role: 'system',
          content: [
            '你是 Karin Agent 的后台学习器。',
            '只输出 JSON：{"memories":[{"content":"...","scope":"user|group|global"}],"skill":null}。',
            '仅保留未来确实有用、由用户明确表达的稳定偏好或事实。',
            '不要保存密钥、令牌、密码、Cookie、隐私数据或临时任务内容。',
            '只有当对话形成可复用工作流时才生成 skill；skill 只能包含声明式说明和提供的工具名。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            actorRole: actor.role,
            scene: actor.scene,
            availableTools: this.registry.list().map(item => item.name),
            conversation: { user, assistant },
          }),
        },
      ],
    })

    const candidate = parseCandidate(response.content)
    if (!candidate) return

    if (config.learning.memory) {
      for (const memory of candidate.memories?.slice(0, 5) || []) {
        const content = String(memory.content || '')
          .trim()
          .slice(0, 2000)
        if (!content || forbidden.some(pattern => pattern.test(content))) continue
        let scope: 'user' | 'group' | 'global'
        let key: string
        if (['group', 'groupTemp', 'guild'].includes(actor.scene)) {
          scope = 'group'
          key = actor.contactKey
        } else {
          scope = 'user'
          key = actor.id
        }
        if (memory.scope === 'global' && ['master', 'admin'].includes(actor.role)) {
          scope = 'global'
          key = 'global'
        }
        const id = await this.database.addMemory(scope, key, content, turnId)
        await this.database.audit(actor.id, 'memory.create', id, { scope, key }, threadId)
        await agentHookEmit('memoryWrite', { id, threadId, turnId, scope, key })
      }
    }

    if (config.learning.skills && candidate.skill && ['master', 'admin'].includes(actor.role)) {
      await this.createSkill(candidate.skill, threadId, turnId, actor)
    }
  }

  async createSkill (
    skill: NonNullable<LearningCandidate['skill']>,
    threadId: string,
    turnId: string,
    actor: AgentActor
  ) {
    const name = String(skill.name || '')
      .trim()
      .toLowerCase()
    const description = String(skill.description || '').trim()
    const instructions = String(skill.instructions || '').trim()
    const tools = [...new Set((skill.tools || []).map(String))]
    const knownTools = new Set(this.registry.list().map(item => item.name))

    if (!/^[a-z][a-z0-9-]{2,63}$/.test(name)) {
      throw new Error('Skill 名称必须以小写字母开头，只包含小写字母、数字或连字符')
    }
    if (!description || description.length > 500) {
      throw new Error('Skill 描述不能为空且不能超过 500 字符')
    }
    if (!instructions || instructions.length > 8192) {
      throw new Error('Skill 指令不能为空且不能超过 8192 字符')
    }
    if (forbidden.some(pattern => pattern.test(instructions))) {
      throw new Error('Skill 指令包含禁止的代码、凭据或权限绕过内容')
    }
    if (tools.some(tool => !knownTools.has(tool))) {
      throw new Error('Skill 引用了未注册的 Tool')
    }

    const content = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      `tools: ${JSON.stringify(tools)}`,
      `source_turn_id: ${turnId}`,
      '---',
      '',
      instructions,
      '',
    ].join('\n')
    const contentHash = createHash('sha256').update(content).digest('hex')
    const result = await this.database.addSkillVersion({
      name,
      description,
      content,
      tools,
      sourceTurnId: turnId,
      contentHash,
    })

    const skillDirectory = path.resolve(this.skillsDirectory, result.skillId)
    const expectedRoot = `${path.resolve(this.skillsDirectory)}${path.sep}`
    if (!`${skillDirectory}${path.sep}`.startsWith(expectedRoot)) {
      throw new Error('技能目录越界')
    }
    await fs.promises.mkdir(skillDirectory, { recursive: true })
    const filename = path.join(skillDirectory, `${result.versionId}.md`)
    await fs.promises.writeFile(filename, content, { encoding: 'utf8', flag: 'wx' })
    await this.database.audit(
      actor.id,
      'skill.version.create',
      result.versionId,
      { skillId: result.skillId, contentHash },
      threadId
    )
    return result
  }
}
