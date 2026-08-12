import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { agentHookEmit } from '@/hooks/agent'
import { assertPublicUrl } from '../browser/manager'
import {
  AgentPythonRuntime,
  scriptToolName,
} from '../scripts/runtime'

import type { AgentDatabase } from '../persistence/database'
import type {
  AgentActor,
  AgentConfig,
  AgentEvolutionMetrics,
  AgentModelProvider,
  AgentScriptToolDefinition,
} from '@/types/agent'
import type { AgentToolRegistry } from '../tools/registry'

interface LearningCandidate {
  memories?: Array<{
    content: string
    scope?: 'user' | 'group' | 'global'
    kind?: 'preference' | 'fact' | 'relationship' | 'procedure' | 'constraint'
    key?: string
    confidence?: number
    importance?: number
    ttlDays?: number
  }>
  skill?: {
    name: string
    description: string
    instructions: string
    tools?: string[]
    scriptTools?: Array<Partial<AgentScriptToolDefinition>>
    files?: Record<string, string | null>
  } | null
}

interface LearningOutcome {
  threadId: string
  turnId: string
  actor: AgentActor
  user: string
  assistant: string
  status: 'completed' | 'failed' | 'interrupted'
  error?: string
  signal: AbortSignal
}

const forbidden = [
  /ignore (all|previous) instructions/i,
  /绕过.{0,8}(权限|审批|安全)/,
  /(?:api[_ -]?key|token|password|cookie|private key)\s*[:=]/i,
  /```(?:js|ts|javascript|typescript|sh|bash|powershell|python)/i,
  /\b(?:npm|pnpm|yarn|pip)\s+install\b/i,
  /\b(?:exec|spawn|eval|Function|child_process|process\.binding)\s*\(/,
]

const skillFilePath = /^(?:references|templates|scripts)\/[a-zA-Z0-9._/-]+$/
const maxSkillFiles = 64
const maxSkillFileBytes = 64 * 1024
const maxSkillFilesBytes = 512 * 1024

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

const parseSkillDocument = (content: string) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) throw new Error('Skill 缺少 YAML front matter')
  const get = (name: string) => {
    const value = match[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() || ''
    try {
      return JSON.parse(value)
    } catch {
      return value.replace(/^['"]|['"]$/g, '')
    }
  }
  const toolsValue = get('tools')
  return {
    name: String(get('name')),
    description: String(get('description')),
    instructions: match[2].trim(),
    tools: Array.isArray(toolsValue) ? toolsValue.map(String) : [],
  }
}

export class AgentLearning {
  private lastCuratorRun = 0
  readonly scriptRuntime: AgentPythonRuntime

  constructor (
    private readonly database: AgentDatabase,
    private readonly provider: AgentModelProvider,
    private readonly registry: AgentToolRegistry,
    private readonly getConfig: () => AgentConfig,
    private readonly skillsDirectory: string
  ) {
    this.scriptRuntime = new AgentPythonRuntime(getConfig)
  }

  memoryScopes (actor: AgentActor) {
    const scopes: Array<{ scope: string; key: string }> = [{ scope: 'global', key: 'global' }]
    if (['group', 'groupTemp', 'guild'].includes(actor.scene)) {
      scopes.push({ scope: 'group', key: actor.contactKey })
    } else {
      scopes.push({ scope: 'user', key: actor.id })
    }
    return scopes
  }

  async contextFor (
    threadId: string,
    turnId: string,
    actor: AgentActor,
    query: string
  ) {
    const retrieval = this.getConfig().memory?.retrieval || {
      maxCandidates: 50,
      maxItems: 8,
      maxPromptTokens: 1200,
      minScore: 0.25,
      recencyHalfLifeDays: 30,
    }
    const [memories, skills] = await Promise.all([
      this.database.retrieveMemories(this.memoryScopes(actor), query, {
        ...retrieval,
        threadId,
        turnId,
      }),
      this.database.getThreadSkillIndex(threadId),
    ])
    await agentHookEmit('memoryRetrieved', {
      threadId,
      turnId,
      candidateCount: memories.length,
      itemIds: memories.map(item => item.memory.id),
    })

    return {
      memories: memories.map(({ memory }) => ({
        id: memory.id,
        kind: memory.kind,
        scope: memory.scope,
        content: memory.content,
        confidence: memory.confidence,
        sourceType: memory.sourceType,
      })),
      skills: skills.slice(0, 200),
    }
  }

  async learn (outcome: LearningOutcome) {
    const config = this.getConfig()
    const [toolCalls, loadedSkillIds] = await Promise.all([
      this.database.listToolCalls(outcome.threadId, outcome.turnId),
      this.database.listTurnSkillLoads(outcome.threadId, outcome.turnId),
    ])
    await this.database.recordExperience({
      threadId: outcome.threadId,
      turnId: outcome.turnId,
      actorId: outcome.actor.id,
      task: outcome.user,
      outcome: outcome.status,
      toolNames: [...new Set(toolCalls.map(item => item.name))],
      skillIds: loadedSkillIds,
      error: outcome.error,
    })
    await this.database.completeRetrievals(
      outcome.threadId,
      outcome.turnId,
      outcome.status
    )
    await Promise.all(
      loadedSkillIds.map(skillId =>
        this.database.touchSkillUsage(
          skillId,
          outcome.status === 'completed' ? 'completed' : 'failed'
        )
      )
    )
    await this.maybeCurate()
    await this.maybeAutoRollback(outcome.actor)

    if (!config.learning.reflection.enabled) return
    if (outcome.status === 'interrupted') return
    if (outcome.status === 'failed' && !config.learning.reflection.afterFailure) return
    const recoveredFromFailure =
      outcome.status === 'completed' &&
      toolCalls.some(item => item.status === 'failed') &&
      toolCalls.some(item => item.status === 'completed')
    const triggerReasons = [
      toolCalls.length >= 5 ? 'five-or-more-tool-calls' : '',
      recoveredFromFailure ? 'recovered-from-failure' : '',
      outcome.status === 'failed' ? 'failed-outcome' : '',
    ].filter(Boolean)
    if (outcome.status === 'completed' && !triggerReasons.length) {
      const experiences = await this.database.listExperiences(1000, 'completed')
      if (experiences.length % config.learning.reflection.successInterval !== 0) return
      triggerReasons.push('reusable-workflow-sampling')
    }
    if (!config.learning.memory && !config.learning.skills) return
    await this.database.audit(
      outcome.actor.id,
      'evolution.reviewed',
      outcome.turnId,
      {
        stage: 'reviewer.started',
        reasons: triggerReasons,
        toolCalls: toolCalls.length,
      },
      outcome.threadId
    )

    const response = await this.provider.complete({
      model: '',
      signal: outcome.signal,
      tools: [],
      messages: [
        {
          role: 'system',
          content: [
            '你是 Karin Agent 的后台反思器，工作在独立 Thread 中。',
            '只输出 JSON：{"memories":[{"content":"...","scope":"user|group|global","kind":"preference|fact|relationship|procedure|constraint","key":"稳定主题键","confidence":0.0,"importance":0.0,"ttlDays":null}],"skill":null}。',
            '失败是改进信号，但不得把失败猜测写成事实。',
            '仅保留未来确实有用、由用户明确表达的稳定偏好、纠正或可复用工作流。',
            '不要保存密钥、令牌、密码、Cookie、隐私数据或临时任务内容。',
            'Skill 只能包含声明式说明和提供的 Tool 名，不得生成代码、Shell 或依赖安装。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            actorRole: outcome.actor.role,
            scene: outcome.actor.scene,
            availableTools: this.registry.list().map(item => ({
              name: item.name,
              description: item.description,
              tags: item.tags,
            })),
            result: {
              status: outcome.status,
              error: outcome.error,
              tools: toolCalls.map(item => ({
                name: item.name,
                status: item.status,
                error: item.error,
              })),
            },
            conversation: { user: outcome.user, assistant: outcome.assistant },
          }),
        },
      ],
    })

    const candidate = parseCandidate(response.content)
    if (!candidate) {
      await this.database.audit(
        outcome.actor.id,
        'evolution.reviewed',
        outcome.turnId,
        {
          stage: 'reviewer.completed',
          reasons: triggerReasons,
          proposedMemories: 0,
          proposedSkill: false,
        },
        outcome.threadId
      )
      return { reviewed: true, reasons: triggerReasons, proposed: false }
    }
    for (const memory of candidate.memories?.slice(0, 5) || []) {
      await this.proposeMemory(memory, outcome)
    }
    if (candidate.skill && config.learning.skills) {
      await this.proposeSkill(candidate.skill, outcome)
    }
    await this.database.audit(
      outcome.actor.id,
      'evolution.reviewed',
      outcome.turnId,
      {
        stage: 'reviewer.completed',
        reasons: triggerReasons,
        proposedMemories: candidate.memories?.length || 0,
        proposedSkill: Boolean(candidate.skill),
      },
      outcome.threadId
    )
    return { reviewed: true, reasons: triggerReasons, proposed: true }
  }

  async feedback (input: {
    threadId: string
    turnId?: string
    actor: AgentActor
    rating?: number
    correction?: string
  }) {
    const correction = input.correction?.trim().slice(0, 4000)
    if (correction && forbidden.some(pattern => pattern.test(correction))) {
      throw new Error('纠正内容包含凭据、代码执行或权限绕过指令')
    }
    const id = await this.database.addFeedback({
      threadId: input.threadId,
      turnId: input.turnId,
      actorId: input.actor.id,
      rating: input.rating,
      correction,
    })
    if (correction && input.turnId) {
      const scopes = this.memoryScopes(input.actor)
      const own = scopes.at(-1)!
      const candidate = await this.database.createEvolutionCandidate({
        target: 'memory',
        kind: 'declarative',
        sourceTurnIds: [input.turnId],
        candidateVersion: createHash('sha256').update(correction).digest('hex').slice(0, 12),
        summary: `用户纠正：${correction.slice(0, 120)}`,
        payload: {
          content: correction,
          scope: own.scope,
          scopeKey: own.key,
          priority: 'user-correction',
        },
      })
      if (candidate) {
        await this.evaluateCandidate(candidate.id, input.actor)
      }
    }
    await this.database.audit(
      input.actor.id,
      'learning.feedback',
      id,
      { rating: input.rating, corrected: Boolean(correction) },
      input.threadId
    )
    if (correction) {
      await this.database.audit(
        input.actor.id,
        'evolution.reviewed',
        input.turnId || id,
        {
          stage: 'reviewer.completed',
          reasons: ['user-correction'],
          candidateTarget: 'memory',
        },
        input.threadId
      )
    }
    return { id }
  }

  async installFromUrl (
    value: string,
    threadId: string,
    turnId: string,
    actor: AgentActor
  ) {
    if (!['master', 'admin'].includes(actor.role)) {
      throw new Error('只有管理员可以从 URL 安装 Skill')
    }
    const source = await assertPublicUrl(value)
    const files = await this.downloadSkillFiles(source)
    if (!files.has('SKILL.md')) throw new Error('URL 内容中未找到 SKILL.md')
    if (files.size > 64) throw new Error('Skill 文件数量超过 64 个')
    const total = [...files.values()].reduce((size, content) => size + content.length, 0)
    if (total > 2 * 1024 * 1024) throw new Error('Skill 总大小超过 2 MiB')

    const executable = [...files.keys()].some(filename =>
      /\.(?:[cm]?[jt]s|sh|bash|ps1|py)$/i.test(filename)
    )
    const document = files.get('SKILL.md')!.toString('utf8')
    const skill = this.validateSkill(parseSkillDocument(document))
    const digest = createHash('sha256')
    for (const [filename, content] of [...files].sort(([left], [right]) =>
      left.localeCompare(right))) {
      digest.update(filename).update('\0').update(content)
    }
    const sourceHash = digest.digest('hex')

    if (executable) {
      const candidate = await this.database.createEvolutionCandidate({
        target: 'skill',
        kind: 'executable',
        sourceTurnIds: [turnId],
        candidateVersion: sourceHash.slice(0, 12),
        summary: `${skill.name}：URL 可执行 Skill，等待隔离评测`,
        payload: {
          ...skill,
          sourceUrl: source.toString(),
          sourceHash,
          files: [...files.keys()],
        },
      })
      await this.database.audit(
        actor.id,
        'skill.url.stage',
        candidate?.id || sourceHash,
        { sourceUrl: source.toString(), sourceHash, executable: true },
        threadId
      )
      return {
        installed: false,
        executable: true,
        candidateId: candidate?.id,
        sourceHash,
        message: '可执行 Skill 已进入候选队列，隔离评测和人工晋升完成前不会运行',
      }
    }

    const supportFiles = Object.fromEntries(
      [...files.entries()]
        .filter(([filename]) => skillFilePath.test(filename))
        .map(([filename, content]) => [filename, content.toString('utf8')])
    )
    const result = await this.createSkill(
      { ...skill, files: supportFiles },
      threadId,
      turnId,
      actor
    )
    const packageDirectory = path.resolve(
      this.skillsDirectory,
      result.skillId,
      result.versionId,
      'package'
    )
    const expectedRoot = `${path.resolve(this.skillsDirectory)}${path.sep}`
    if (!`${packageDirectory}${path.sep}`.startsWith(expectedRoot)) {
      throw new Error('Skill 包目录越界')
    }
    const staging = path.join(
      this.skillsDirectory,
      '.staging',
      `${result.skillId}-${result.versionId}`
    )
    await fs.promises.mkdir(staging, { recursive: true })
    try {
      for (const [filename, content] of files) {
        const target = path.resolve(staging, filename)
        if (!`${target}${path.sep}`.startsWith(`${path.resolve(staging)}${path.sep}`)) {
          throw new Error(`Skill 文件路径越界: ${filename}`)
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        await fs.promises.writeFile(target, content, { flag: 'wx' })
      }
      await fs.promises.mkdir(path.dirname(packageDirectory), { recursive: true })
      await fs.promises.rename(staging, packageDirectory)
    } catch (error) {
      await fs.promises.rm(staging, { recursive: true, force: true })
      throw error
    }
    await this.database.audit(
      actor.id,
      'skill.url.install',
      result.versionId,
      { sourceUrl: source.toString(), sourceHash, executable: false },
      threadId
    )
    return {
      installed: true,
      executable: false,
      ...result,
      sourceHash,
    }
  }

  private async safeFetch (value: string, limit = 2 * 1024 * 1024) {
    let url = await assertPublicUrl(value)
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'Karin-Agent/2.0' },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error('URL 重定向缺少 Location')
        url = await assertPublicUrl(new URL(location, url).toString())
        continue
      }
      if (!response.ok) throw new Error(`下载 Skill 失败: HTTP ${response.status}`)
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > limit) throw new Error('Skill 下载内容超过大小限制')
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > limit) throw new Error('Skill 下载内容超过大小限制')
      return { buffer, url, contentType: response.headers.get('content-type') || '' }
    }
    throw new Error('Skill URL 重定向次数超过 5 次')
  }

  private async downloadSkillFiles (source: URL) {
    const files = new Map<string, Buffer>()
    if (source.hostname === 'raw.githubusercontent.com' || source.pathname.endsWith('/SKILL.md')) {
      const result = await this.safeFetch(source.toString())
      files.set('SKILL.md', result.buffer)
      return files
    }
    if (source.hostname !== 'github.com') {
      throw new Error('普通 URL 必须直接指向 SKILL.md；仓库安装仅支持 GitHub')
    }
    const parts = source.pathname.split('/').filter(Boolean)
    if (parts.length < 2) throw new Error('GitHub URL 缺少 owner/repository')
    const [owner, repository] = parts
    let ref = ''
    let directory = ''
    if (parts[2] === 'tree' || parts[2] === 'blob') {
      ref = parts[3] || ''
      directory = parts.slice(4).join('/')
    }
    if (!ref) {
      const metadata = await this.safeFetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
      )
      const parsed = JSON.parse(metadata.buffer.toString('utf8')) as { default_branch?: string }
      ref = parsed.default_branch || 'main'
    }
    if (parts[2] === 'blob') {
      const raw = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repository)}/${encodeURIComponent(ref)}/${directory}`
      const result = await this.safeFetch(raw)
      files.set(path.posix.basename(directory), result.buffer)
      return files
    }

    const visit = async (current: string) => {
      if (files.size >= 64) throw new Error('Skill 文件数量超过 64 个')
      const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repository)}/contents/${current
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?ref=${encodeURIComponent(ref)}`
      const result = await this.safeFetch(endpoint)
      const entries = JSON.parse(result.buffer.toString('utf8')) as Array<{
        type: 'file' | 'dir'
        path: string
        download_url?: string
        size?: number
      }>
      for (const entry of entries) {
        if (entry.type === 'dir') {
          await visit(entry.path)
          continue
        }
        if (!entry.download_url) continue
        if ((entry.size || 0) > 512 * 1024) throw new Error(`Skill 文件过大: ${entry.path}`)
        const downloaded = await this.safeFetch(entry.download_url, 512 * 1024)
        const relative = directory
          ? path.posix.relative(directory, entry.path)
          : entry.path
        if (!relative || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
          throw new Error(`Skill 文件路径越界: ${entry.path}`)
        }
        files.set(relative, downloaded.buffer)
      }
    }
    await visit(directory)
    return files
  }

  private async proposeMemory (
    memory: NonNullable<LearningCandidate['memories']>[number],
    outcome: LearningOutcome
  ) {
    if (!this.getConfig().learning.memory) return
    const content = String(memory.content || '').trim().slice(0, 2000)
    if (!content || forbidden.some(pattern => pattern.test(content))) return
    let scope: 'user' | 'group' | 'global'
    let scopeKey: string
    if (['group', 'groupTemp', 'guild'].includes(outcome.actor.scene)) {
      scope = 'group'
      scopeKey = outcome.actor.contactKey
    } else {
      scope = 'user'
      scopeKey = outcome.actor.id
    }
    if (memory.scope === 'global' && ['master', 'admin'].includes(outcome.actor.role)) {
      scope = 'global'
      scopeKey = 'global'
    }
    const existing = await this.database.listMemories([{ scope, key: scopeKey }])
    if (existing.some(item => item.content === content)) return
    const candidate = await this.database.createEvolutionCandidate({
      target: 'memory',
      kind: 'declarative',
      sourceTurnIds: [outcome.turnId],
      candidateVersion: createHash('sha256').update(content).digest('hex').slice(0, 12),
      summary: content.slice(0, 160),
      payload: {
        content,
        scope,
        scopeKey,
        kind: memory.kind || 'fact',
        memoryKey: String(memory.key || '').trim().slice(0, 200) || null,
        confidence: Math.max(0, Math.min(Number(memory.confidence) || 0.7, 1)),
        importance: Math.max(0, Math.min(Number(memory.importance) || 0.5, 1)),
        expiresAt: memory.ttlDays
          ? Date.now() + Math.max(1, Number(memory.ttlDays)) * 86_400_000
          : null,
      },
    })
    if (candidate) await this.evaluateCandidate(candidate.id, outcome.actor)
  }

  private async proposeSkill (
    skill: NonNullable<LearningCandidate['skill']>,
    outcome: LearningOutcome
  ) {
    const normalized = this.validateSkill(skill)
    const similar = (await this.database.listEvolutionCandidates(undefined, 500))
      .filter(item => item.target === 'skill' && item.payload.name === normalized.name)
    const sourceTurnIds = [
      ...new Set([
        ...similar.flatMap(item => item.sourceTurnIds),
        outcome.turnId,
      ]),
    ]
    const existing = (await this.database.listSkills())
      .find(item => item.name === normalized.name)
    const candidate = await this.database.createEvolutionCandidate({
      target: 'skill',
      kind: 'declarative',
      sourceTurnIds,
      baselineVersion: existing?.activeVersionId || undefined,
      candidateVersion: createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex')
        .slice(0, 12),
      summary: `${normalized.name}：${normalized.description}`,
      payload: normalized,
    })
    if (candidate) await this.evaluateCandidate(candidate.id, outcome.actor)
  }

  async evaluateCandidate (id: string, actor: AgentActor) {
    const candidate = await this.database.getEvolutionCandidate(id)
    if (!candidate) throw new Error('进化候选不存在')
    if (candidate.kind === 'executable') throw new Error('可执行 Skill 必须使用隔离评测器和人工审批')
    await this.database.updateEvolutionCandidate(id, 'evaluating')

    let valid = true
    let report = '静态规则、作用域和真实脱敏轨迹检查通过'
    try {
      if (candidate.target === 'skill') {
        this.validateSkill(candidate.payload as unknown as NonNullable<LearningCandidate['skill']>)
      } else if (candidate.target === 'memory') {
        const content = String(candidate.payload.content || '')
        if (!content || forbidden.some(pattern => pattern.test(content))) {
          throw new Error('记忆内容不安全或为空')
        }
      }
    } catch (error) {
      valid = false
      report = (error as Error).message
    }

    const sourceTurns = new Set(candidate.sourceTurnIds)
    const experiences = (await this.database.listExperiences(1000))
      .filter(item => sourceTurns.has(item.turnId))
    const toolCalls = (await Promise.all(
      experiences.map(item => this.database.listToolCalls(item.threadId, item.turnId))
    )).flat()
    const completed = experiences.filter(item => item.outcome === 'completed').length
    const failed = experiences.filter(item => item.outcome === 'failed').length
    const successfulTools = toolCalls.filter(item => item.status === 'completed').length
    const correction = candidate.payload.priority === 'user-correction'
    const evidence = Math.max(candidate.sourceTurnIds.length, experiences.length)
    const metrics: AgentEvolutionMetrics = {
      evidence,
      successRate: valid
        ? (correction ? 1 : completed / Math.max(1, completed + failed))
        : 0,
      regressionRate: valid
        ? (correction ? 0 : failed / Math.max(1, completed + failed))
        : 1,
      toolHitRate: toolCalls.length ? successfulTools / toolCalls.length : 0,
      correctionRate: candidate.payload.priority === 'user-correction' ? 1 : 0,
    }
    report += `；证据 ${evidence} 条，成功轨迹 ${completed} 条，失败轨迹 ${failed} 条，Tool 成功 ${successfulTools}/${toolCalls.length}`
    const promotion = this.getConfig().learning.promotion
    const passed = valid &&
      metrics.successRate >= promotion.minSuccessRate &&
      metrics.regressionRate <= promotion.maxRegressionRate
    await this.database.addEvolutionEvaluation(id, passed, metrics, report)
    await this.database.updateEvolutionCandidate(id, passed ? 'ready' : 'rejected', metrics)
    await this.database.addEvolutionEvent(
      id,
      passed ? 'evaluation.passed' : 'evaluation.failed',
      actor.id,
      { report, metrics }
    )
    if (!passed) return this.database.getEvolutionCandidate(id)

    const autoPromote =
      (candidate.target === 'memory' && promotion.autoMemory) ||
      (candidate.target === 'routing' && promotion.autoRouting) ||
      (
        candidate.target === 'skill' &&
        promotion.autoDeclarativeSkills &&
        metrics.evidence >= promotion.minEvidence &&
        ['master', 'admin'].includes(actor.role)
      )
    if (autoPromote) return this.promoteCandidate(id, actor)
    return this.database.getEvolutionCandidate(id)
  }

  async promoteCandidate (id: string, actor: AgentActor) {
    const candidate = await this.database.getEvolutionCandidate(id)
    if (!candidate) throw new Error('进化候选不存在')
    if (candidate.state !== 'ready') throw new Error(`候选状态 ${candidate.state} 不能晋升`)
    if (candidate.kind === 'executable') throw new Error('可执行 Skill 不能自动晋升')

    let resource: Record<string, unknown> = {}
    if (candidate.target === 'memory') {
      const scope = String(candidate.payload.scope) as 'user' | 'group' | 'global'
      if (scope === 'global' && !['master', 'admin'].includes(actor.role)) {
        throw new Error('只有管理员可以晋升全局记忆')
      }
      const memoryId = await this.database.addMemory(
        scope,
        String(candidate.payload.scopeKey),
        String(candidate.payload.content),
        candidate.sourceTurnIds.at(-1) || `evolution:${id}`,
        {
          kind: (candidate.payload.kind || 'fact') as 'preference' | 'fact' |
            'relationship' | 'procedure' | 'constraint',
          memoryKey: candidate.payload.memoryKey
            ? String(candidate.payload.memoryKey)
            : null,
          confidence: Number(candidate.payload.confidence) ||
            (candidate.payload.priority === 'user-correction' ? 1 : 0.7),
          importance: Number(candidate.payload.importance) ||
            (candidate.payload.priority === 'user-correction' ? 0.9 : 0.5),
          sourceType: candidate.payload.priority === 'user-correction'
            ? 'correction'
            : 'reflection',
          expiresAt: candidate.payload.expiresAt
            ? Number(candidate.payload.expiresAt)
            : null,
        }
      )
      resource = { memoryId }
      await agentHookEmit('memoryWrite', {
        id: memoryId,
        threadId: '',
        turnId: candidate.sourceTurnIds.at(-1) || '',
        scope,
        key: String(candidate.payload.scopeKey),
      })
      await agentHookEmit('memoryPromoted', {
        id: memoryId,
        candidateId: id,
        sourceTurnIds: candidate.sourceTurnIds,
      })
    } else if (candidate.target === 'skill') {
      if (!['master', 'admin'].includes(actor.role)) {
        throw new Error('只有管理员可以晋升全局 Skill')
      }
      const skill = this.validateSkill(
        candidate.payload as unknown as NonNullable<LearningCandidate['skill']>
      )
      const result = await this.createSkill(
        skill,
        'evolution',
        candidate.sourceTurnIds.at(-1) || `evolution:${id}`,
        actor
      )
      const usage = await this.database.getSkillUsage(result.skillId)
      resource = {
        ...result,
        promotionUsage: {
          useCount: Number(usage?.use_count || 0),
          successCount: Number(usage?.success_count || 0),
          failureCount: Number(usage?.failure_count || 0),
        },
      }
    }
    await this.database.updateEvolutionPayload(id, { ...candidate.payload, ...resource })
    await this.database.updateEvolutionCandidate(id, 'active')
    await this.database.addEvolutionEvent(id, 'promoted', actor.id, resource)
    await this.database.audit(actor.id, 'evolution.promote', id, resource)
    return this.database.getEvolutionCandidate(id)
  }

  async rejectCandidate (id: string, actor: AgentActor, reason = '') {
    const candidate = await this.database.getEvolutionCandidate(id)
    if (!candidate) throw new Error('进化候选不存在')
    await this.database.updateEvolutionCandidate(id, 'rejected')
    await this.database.addEvolutionEvent(id, 'rejected', actor.id, { reason: reason.slice(0, 1000) })
    return this.database.getEvolutionCandidate(id)
  }

  async rollbackCandidate (id: string, actor: AgentActor) {
    const candidate = await this.database.getEvolutionCandidate(id)
    if (!candidate) throw new Error('进化候选不存在')
    if (candidate.state !== 'active') throw new Error('只有已生效候选可以回滚')
    if (candidate.target === 'memory' && candidate.payload.memoryId) {
      await this.database.setMemoryEnabled(String(candidate.payload.memoryId), false)
    } else if (
      candidate.target === 'skill' &&
      candidate.payload.skillId &&
      candidate.baselineVersion
    ) {
      await this.database.rollbackSkill(
        String(candidate.payload.skillId),
        candidate.baselineVersion
      )
    } else if (candidate.target === 'skill' && candidate.payload.skillId) {
      await this.database.setSkillEnabled(String(candidate.payload.skillId), false)
    }
    await this.database.updateEvolutionCandidate(id, 'rolled_back')
    await this.database.addEvolutionEvent(id, 'rolled_back', actor.id, {})
    await this.database.audit(actor.id, 'evolution.rollback', id, {})
    return this.database.getEvolutionCandidate(id)
  }

  private async maybeCurate () {
    const config = this.getConfig().learning.curator
    if (!config.enabled) return
    const interval = config.intervalHours * 60 * 60 * 1000
    if (Date.now() - this.lastCuratorRun < interval) return
    this.lastCuratorRun = Date.now()
    const day = 24 * 60 * 60 * 1000
    await this.database.curateSkillUsage(
      Date.now() - config.staleAfterDays * day,
      Date.now() - config.archiveAfterDays * day
    )
    await this.database.curateMemories(
      Date.now() - config.staleAfterDays * day,
      Date.now() - config.archiveAfterDays * day
    )
  }

  private async maybeAutoRollback (actor: AgentActor) {
    const config = this.getConfig().learning.promotion
    if (!config.autoRollback) return
    const active = (await this.database.listEvolutionCandidates('active', 500))
      .filter(candidate => candidate.target === 'skill' && candidate.payload.skillId)
    for (const candidate of active) {
      const usage = await this.database.getSkillUsage(String(candidate.payload.skillId))
      if (!usage) continue
      let baseline: Record<string, unknown> = {}
      if (
        candidate.payload.promotionUsage &&
        typeof candidate.payload.promotionUsage === 'object'
      ) {
        baseline = candidate.payload.promotionUsage as Record<string, unknown>
      }
      const uses = Number(usage.use_count || 0) - Number(baseline.useCount || 0)
      if (uses < config.rollbackWindow) continue
      const successes = Number(usage.success_count || 0) - Number(baseline.successCount || 0)
      const failures = Number(usage.failure_count || 0) - Number(baseline.failureCount || 0)
      const total = Math.max(1, successes + failures)
      const successRate = successes / total
      const regressionRate = failures / total
      if (
        successRate >= config.minSuccessRate &&
        regressionRate <= config.maxRegressionRate
      ) continue
      await this.database.addEvolutionEvent(candidate.id, 'rollback.triggered', actor.id, {
        window: uses,
        successRate,
        regressionRate,
      })
      await this.rollbackCandidate(candidate.id, actor)
    }
  }

  private validateSkill (skill: NonNullable<LearningCandidate['skill']>) {
    const name = String(skill.name || '').trim().toLowerCase()
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
    const files: Record<string, string | null> = {}
    let totalBytes = 0
    for (const [rawPath, rawContent] of Object.entries(skill.files || {})) {
      const filePath = rawPath.replace(/\\/g, '/').replace(/^\.\/+/, '')
      if (
        !skillFilePath.test(filePath) ||
        filePath.split('/').includes('..') ||
        filePath.includes('//')
      ) {
        throw new Error(`Skill 支持文件路径非法: ${rawPath}`)
      }
      if (rawContent === null) {
        files[filePath] = null
        continue
      }
      const content = String(rawContent)
      const size = Buffer.byteLength(content)
      if (size > maxSkillFileBytes) {
        throw new Error(`Skill 支持文件超过 ${maxSkillFileBytes} 字节: ${filePath}`)
      }
      if (forbidden.some(pattern => pattern.test(content))) {
        throw new Error(`Skill 支持文件包含凭据、权限绕过或危险执行指令: ${filePath}`)
      }
      totalBytes += size
      files[filePath] = content
    }
    if (Object.keys(files).length > maxSkillFiles || totalBytes > maxSkillFilesBytes) {
      throw new Error('Skill 支持文件数量或总大小超过限制')
    }
    const scriptTools = skill.scriptTools || []
    return { name, description, instructions, tools, scriptTools, files }
  }

  async createSkill (
    skill: NonNullable<LearningCandidate['skill']>,
    threadId: string,
    turnId: string,
    actor: AgentActor
  ) {
    return this.writeSkillVersion(undefined, skill, threadId, turnId, actor)
  }

  async updateSkill (
    skillId: string,
    skill: NonNullable<LearningCandidate['skill']>,
    threadId: string,
    turnId: string,
    actor: AgentActor
  ) {
    return this.writeSkillVersion(skillId, skill, threadId, turnId, actor)
  }

  private async writeSkillVersion (
    skillId: string | undefined,
    skill: NonNullable<LearningCandidate['skill']>,
    threadId: string,
    turnId: string,
    actor: AgentActor
  ) {
    const normalized = this.validateSkill(skill)
    const scriptTools: AgentScriptToolDefinition[] = []
    const scriptIds = new Set<string>()
    for (const script of normalized.scriptTools) {
      const validated = await this.scriptRuntime.validate(
        script as AgentScriptToolDefinition
      )
      if (scriptIds.has(validated.id)) {
        throw new Error(`Script Tool ID 重复: ${validated.id}`)
      }
      scriptIds.add(validated.id)
      scriptTools.push(validated)
    }
    const targetSkillId = skillId || randomUUID()
    const scriptToolNames = scriptTools.map(script =>
      scriptToolName(targetSkillId, script.id)
    )
    const allTools = [...new Set([...normalized.tools, ...scriptToolNames])]
    const content = [
      '---',
      `name: ${normalized.name}`,
      `description: ${JSON.stringify(normalized.description)}`,
      `tools: ${JSON.stringify(allTools)}`,
      `script_tools: ${JSON.stringify(scriptTools.map(script => ({
        id: script.id,
        sourceHash: script.sourceHash,
      })))}`,
      `source_turn_id: ${turnId}`,
      '---',
      '',
      normalized.instructions,
      '',
    ].join('\n')
    const current = skillId
      ? await this.database.getSkill(skillId)
      : (await this.database.listSkills()).find(item => item.name === normalized.name)
    const supportFiles = new Map<string, string>()
    if (current?.activeVersionId) {
      const active = (await this.database.getSkillVersions(current.id))
        .find(row => String(row.id) === current.activeVersionId)
      let manifest: Record<string, { size: number; hash: string }> = {}
      try {
        manifest = JSON.parse(String(active?.files_manifest_json || '{}'))
      } catch {}
      for (const filePath of Object.keys(manifest)) {
        const filename = path.resolve(
          this.skillsDirectory,
          current.id,
          current.activeVersionId,
          filePath
        )
        const expected = `${path.resolve(
          this.skillsDirectory,
          current.id,
          current.activeVersionId
        )}${path.sep}`
        if (`${filename}${path.sep}`.startsWith(expected)) {
          const value = await fs.promises.readFile(filename, 'utf8').catch(() => null)
          if (value !== null) supportFiles.set(filePath, value)
        }
      }
    }
    for (const [filePath, value] of Object.entries(normalized.files)) {
      if (value === null) supportFiles.delete(filePath)
      else supportFiles.set(filePath, value)
    }
    const filesManifest = Object.fromEntries(
      [...supportFiles.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([filePath, value]) => [
          filePath,
          {
            size: Buffer.byteLength(value),
            hash: createHash('sha256').update(value).digest('hex'),
          },
        ])
    )
    const contentHash = createHash('sha256')
      .update(content)
      .update('\0')
      .update(JSON.stringify(scriptTools))
      .update('\0')
      .update(JSON.stringify(filesManifest))
      .digest('hex')
    const result = await this.database.addSkillVersion({
      skillId,
      newSkillId: skillId ? undefined : targetSkillId,
      name: normalized.name,
      description: normalized.description,
      content,
      tools: allTools,
      sourceTurnId: turnId,
      contentHash,
      scriptTools,
      filesManifest,
    })
    for (const script of scriptTools) {
      const name = scriptToolName(result.skillId, script.id)
      const generated = await this.database.getGeneratedTool(name)
      const duplicate = generated
        ? (await this.database.getGeneratedToolVersions(generated.id))
          .find(version => version.definition.sourceHash === script.sourceHash)
        : undefined
      if (duplicate) {
        await this.database.rollbackGeneratedTool(generated!.id, duplicate.id)
      } else {
        await this.database.addGeneratedToolVersion({
          toolId: generated?.id,
          name,
          description: script.description,
          definition: script,
          validationStatus: 'valid',
          validationReport: '由旧 karin.skill.create 兼容 Adapter 复制并通过受限 Python 校验',
          sourceTurnId: turnId,
          activate: true,
          legacyAlias: name,
        })
      }
    }

    const skillDirectory = path.resolve(this.skillsDirectory, result.skillId)
    const expectedRoot = `${path.resolve(this.skillsDirectory)}${path.sep}`
    if (!`${skillDirectory}${path.sep}`.startsWith(expectedRoot)) {
      throw new Error('技能目录越界')
    }
    await fs.promises.mkdir(skillDirectory, { recursive: true })
    const filename = path.join(skillDirectory, `${result.versionId}.md`)
    await fs.promises.writeFile(filename, content, { encoding: 'utf8', flag: 'wx' })
    const versionDirectory = path.join(skillDirectory, result.versionId)
    await fs.promises.mkdir(versionDirectory, { recursive: true })
    await fs.promises.writeFile(
      path.join(versionDirectory, 'SKILL.md'),
      content,
      { encoding: 'utf8', flag: 'wx' }
    )
    for (const [filePath, value] of supportFiles) {
      const supportFilename = path.resolve(versionDirectory, filePath)
      if (!`${supportFilename}${path.sep}`.startsWith(`${versionDirectory}${path.sep}`)) {
        throw new Error(`Skill 支持文件路径越界: ${filePath}`)
      }
      await fs.promises.mkdir(path.dirname(supportFilename), { recursive: true })
      await fs.promises.writeFile(
        supportFilename,
        value,
        { encoding: 'utf8', flag: 'wx' }
      )
    }
    if (scriptTools.length) {
      for (const script of scriptTools) {
        await fs.promises.writeFile(
          path.join(versionDirectory, `${script.id}.py`),
          script.source,
          { encoding: 'utf8', flag: 'wx' }
        )
      }
    }
    await this.database.audit(
      actor.id,
      'skill.version.create',
      result.versionId,
      {
        skillId: result.skillId,
        contentHash,
        scriptTools: scriptTools.map(script => ({
          id: script.id,
          sourceHash: script.sourceHash,
        })),
        filesManifest,
        autoApproved: true,
        reason: 'trusted-versioned-declarative-skill',
      },
      threadId
    )
    await this.refreshScriptTools()
    return {
      ...result,
      baselineVersion: current?.activeVersionId || undefined,
    }
  }

  async manageSkill (
    input: {
      action: 'create' | 'patch' | 'edit' | 'write_file' | 'remove_file' | 'delete'
      id?: string
      name?: string
      description?: string
      instructions?: string
      tools?: string[]
      filePath?: string
      content?: string
      search?: string
      replace?: string
    },
    threadId: string,
    turnId: string,
    actor: AgentActor
  ) {
    if (input.action === 'create') {
      return this.createSkill({
        name: String(input.name || ''),
        description: String(input.description || ''),
        instructions: String(input.instructions || ''),
        tools: input.tools || [],
        files: {},
      }, threadId, turnId, actor)
    }
    const reference = String(input.id || input.name || '')
    const current = await this.database.getSkill(reference) ||
      (await this.database.listSkills()).find(item => item.name === reference)
    if (!current) throw new Error('Skill 不存在')
    if (input.action === 'delete') return this.deleteSkill(current.id, actor)
    const active = (await this.database.getSkillVersions(current.id))
      .find(row => String(row.id) === current.activeVersionId)
    if (!active) throw new Error('Skill 没有活动版本')
    const document = parseSkillDocument(String(active.content))
    const next = {
      ...document,
      name: input.name === undefined ? document.name : String(input.name),
      description: input.description === undefined
        ? document.description
        : String(input.description),
      instructions: input.instructions === undefined
        ? document.instructions
        : String(input.instructions),
      tools: input.tools === undefined ? document.tools : input.tools.map(String),
      files: {} as Record<string, string | null>,
    }
    if (input.action === 'patch') {
      const search = String(input.search || '')
      if (!search || !document.instructions.includes(search)) {
        throw new Error('patch 的 search 不能为空且必须在当前 SKILL.md 正文中唯一命中')
      }
      if (document.instructions.split(search).length !== 2) {
        throw new Error('patch 的 search 命中多处，请提供更精确上下文')
      }
      next.instructions = document.instructions.replace(search, String(input.replace || ''))
    }
    if (input.action === 'write_file') {
      if (!input.filePath || input.content === undefined) {
        throw new Error('write_file 需要 filePath 和 content')
      }
      next.files[String(input.filePath)] = String(input.content)
    }
    if (input.action === 'remove_file') {
      if (!input.filePath) throw new Error('remove_file 需要 filePath')
      next.files[String(input.filePath)] = null
    }
    return this.updateSkill(current.id, next, threadId, turnId, actor)
  }

  async readSkillFile (
    skillId: string,
    versionId: string,
    filePath: string,
    manifest: Record<string, { size: number; hash: string }>
  ) {
    const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '')
    if (!skillFilePath.test(normalized) || !manifest[normalized]) {
      throw new Error('Skill 支持文件不存在或路径不在版本 manifest 中')
    }
    const versionRoot = path.resolve(this.skillsDirectory, skillId, versionId)
    const filename = path.resolve(versionRoot, normalized)
    if (!`${filename}${path.sep}`.startsWith(`${versionRoot}${path.sep}`)) {
      throw new Error('Skill 支持文件路径越界')
    }
    const [realRoot, realFile] = await Promise.all([
      fs.promises.realpath(versionRoot),
      fs.promises.realpath(filename),
    ])
    if (!`${realFile}${path.sep}`.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error('Skill 支持文件通过符号链接越界')
    }
    const content = await fs.promises.readFile(realFile, 'utf8')
    const hash = createHash('sha256').update(content).digest('hex')
    if (
      Buffer.byteLength(content) !== manifest[normalized].size ||
      hash !== manifest[normalized].hash
    ) {
      throw new Error('Skill 支持文件与不可变版本 manifest 不一致')
    }
    return content
  }

  async deleteSkill (skillId: string, actor: AgentActor) {
    const skill = await this.database.getSkill(skillId)
    if (!skill) throw new Error('Skill 不存在')
    const root = path.resolve(this.skillsDirectory)
    const source = path.resolve(root, skillId)
    const expectedRoot = `${root}${path.sep}`
    if (!`${source}${path.sep}`.startsWith(expectedRoot)) {
      throw new Error('Skill 目录越界')
    }
    const trashRoot = path.resolve(root, '.trash')
    const staged = path.resolve(trashRoot, `${skillId}-${randomUUID()}`)
    if (!`${staged}${path.sep}`.startsWith(`${trashRoot}${path.sep}`)) {
      throw new Error('Skill 回收目录越界')
    }
    let moved = false
    if (fs.existsSync(source)) {
      await fs.promises.mkdir(trashRoot, { recursive: true })
      await fs.promises.rename(source, staged)
      moved = true
    }
    try {
      const result = await this.database.deleteSkillCascade(skillId, actor.id)
      if (moved) await fs.promises.rm(staged, { recursive: true, force: true })
      await this.refreshScriptTools()
      return result
    } catch (error) {
      if (moved && fs.existsSync(staged) && !fs.existsSync(source)) {
        await fs.promises.rename(staged, source)
      }
      throw error
    }
  }

  async refreshScriptTools () {
    this.registry.unregisterPrefix('skill.')
    const runtimeStatus = await this.scriptRuntime.status()
    if (!runtimeStatus.available) {
      logger.warn(`[agent][script] ${runtimeStatus.reason || 'Python Runtime 不可用'}`)
      return
    }
    for (const version of await this.database.getActiveScriptSkillVersions()) {
      for (const script of version.scriptTools) {
        let normalized: AgentScriptToolDefinition
        try {
          normalized = await this.scriptRuntime.validate(script)
          if (script.sourceHash !== normalized.sourceHash) {
            throw new Error('源码哈希与版本记录不一致')
          }
        } catch (error) {
          logger.error(new Error(
            `[agent][script] ${version.skillId}/${script.id} 校验失败`,
            { cause: error }
          ))
          continue
        }
        const name = scriptToolName(version.skillId, normalized.id)
        this.registry.register({
          name,
          description: normalized.description,
          toolset: `skill.${version.skillId}`,
          tags: [
            'Skill',
            normalized.name,
            normalized.semantics.objective,
          ],
          inputSchema: normalized.inputSchema,
          outputSchema: normalized.outputSchema,
          risk: 'read',
          permission: 'all',
          timeout: normalized.stop.timeoutMs,
          idempotent: normalized.semantics.idempotent,
          execute: async (input, context) => {
            const currentHash = createHash('sha256')
              .update(normalized.source)
              .digest('hex')
            if (currentHash !== normalized.sourceHash) {
              throw new Error(`Script Tool ${normalized.id} 源码哈希校验失败`)
            }
            const target = `${name}@${normalized.sourceHash}`
            await this.database.audit(
              context.actor.id,
              'script.execute.started',
              target,
              {
                skillId: version.skillId,
                versionId: version.versionId,
                scriptToolId: normalized.id,
              },
              context.threadId
            )
            try {
              const output = await this.scriptRuntime.execute(
                normalized,
                input,
                context.signal
              )
              await this.database.audit(
                context.actor.id,
                'script.execute.completed',
                target,
                {
                  skillId: version.skillId,
                  versionId: version.versionId,
                  scriptToolId: normalized.id,
                },
                context.threadId
              )
              return output
            } catch (error) {
              await this.database.audit(
                context.actor.id,
                'script.execute.failed',
                target,
                {
                  skillId: version.skillId,
                  versionId: version.versionId,
                  scriptToolId: normalized.id,
                  error: (error as Error).message,
                },
                context.threadId
              )
              throw error
            }
          },
        }, true, 'generated-sandbox')
      }
    }
  }

  async setSkillEnabled (skillId: string, enabled: boolean, actor: AgentActor) {
    const updated = await this.database.setSkillEnabled(skillId, enabled)
    await this.database.audit(actor.id, 'skill.state', skillId, { enabled, updated })
    await this.refreshScriptTools()
    return updated
  }

  async rollbackSkill (skillId: string, versionId: string, actor: AgentActor) {
    const updated = await this.database.rollbackSkill(skillId, versionId)
    await this.database.audit(actor.id, 'skill.rollback', skillId, {
      versionId,
      updated,
    })
    await this.refreshScriptTools()
    return updated
  }
}
