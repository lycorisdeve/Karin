import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { getAgentServices, getAgentStatus, restartAgent } from '@/agent'
import {
  agentProviderPresets,
  hasAgentApiKey,
  mergeAgentConfigUpdate,
  publicAgentConfig,
  saveAgentConfig,
  saveAgentProviderVerification,
} from '@/utils/config/file/agent'
import {
  createBadRequestResponse,
  createNotFoundResponse,
  createServerErrorResponse,
  createSuccessResponse,
} from '@/server/utils/response'

import type { RequestHandler } from 'express'
import type { AgentActor, AgentConfig } from '@/types/agent'

export const agentRouter: Router = Router()

const actorFromRequest = (req: Parameters<RequestHandler>[0]): AgentActor => {
  const id = req.get('x-user-id') || 'web-admin'
  return {
    id,
    role: 'admin',
    selfId: 'web',
    scene: 'web',
    contactKey: `web:${id}`,
  }
}

const database = () => {
  const value = getAgentServices()?.database
  if (!value) throw new Error('Agent 数据库不可用')
  return value
}

const runtime = () => {
  const value = getAgentServices()?.runtime
  if (!value) throw new Error(getAgentStatus().reason || 'Agent 尚未启用')
  return value
}

const sensitiveKey = /authorization|cookie|token|password|api[-_]?key|secret/i
const redactValue = (value: unknown, key = ''): unknown => {
  if (sensitiveKey.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redactValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([itemKey, item]) => [itemKey, redactValue(item, itemKey)])
    )
  }
  if (typeof value === 'string') {
    return value.replace(/\b(?:sk|key|token)-[a-z0-9._-]{8,}\b/gi, '[REDACTED]')
  }
  return value
}

const safe =
  (handler: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await handler(req, res, next)
      } catch (error) {
        createServerErrorResponse(res, (error as Error).message)
      }
    }

const validateConfig = (value: unknown): value is AgentConfig => {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<AgentConfig> & Record<string, unknown>
  const mcp = config.mcp as AgentConfig['mcp'] | undefined
  const envReference = /^(?:[A-Za-z]+\s+)?\$\{[A-Z0-9_]+\}$/
  const mcpCredentialsValid = !mcp || (
    Array.isArray(mcp.servers) && mcp.servers.every(server => {
      const environmentValid = Object.values(server.env || {}).every(item =>
        /^\$\{[A-Z0-9_]+\}$/.test(item)
      )
      const headersValid = Object.entries(server.headers || {}).every(([key, item]) =>
        !/authorization|cookie|token|api[-_]?key|secret/i.test(key) ||
        envReference.test(item)
      )
      return environmentValid && headersValid
    })
  )
  return (
    (config.enabled === undefined || typeof config.enabled === 'boolean') &&
    (config.providers === undefined || Array.isArray(config.providers)) &&
    (config.routing === undefined || typeof config.routing === 'object') &&
    Boolean(config.trigger) &&
    Boolean(config.limits) &&
    Boolean(config.policy) &&
    Boolean(config.learning) &&
    Boolean(config.tools) &&
    Boolean(config.mcp) &&
    mcpCredentialsValid
  )
}

agentRouter.get(
  '/status',
  safe(async (_req, res) => {
    createSuccessResponse(res, {
      ...getAgentStatus(),
      apiKeyConfigured: hasAgentApiKey(),
      ftsAvailable: getAgentServices()?.database.isFtsAvailable() || false,
    })
  })
)

agentRouter.get(
  '/config',
  safe(async (_req, res) => {
    createSuccessResponse(res, {
      config: publicAgentConfig(),
      apiKeyConfigured: hasAgentApiKey(),
    })
  })
)

agentRouter.post(
  '/config',
  safe(async (req, res) => {
    if (!validateConfig(req.body)) {
      createBadRequestResponse(res, 'Agent 配置格式无效或包含禁止字段')
      return
    }
    await saveAgentConfig(mergeAgentConfigUpdate(req.body))
    await restartAgent()
    createSuccessResponse(res, {
      status: getAgentStatus(),
      apiKeyConfigured: hasAgentApiKey(),
    })
  })
)

agentRouter.get(
  '/providers/presets',
  safe(async (_req, res) => {
    createSuccessResponse(res, agentProviderPresets())
  })
)

agentRouter.post(
  '/providers/:id/models',
  safe(async (req, res) => {
    const provider = getAgentServices()?.providers
    if (!provider) throw new Error('Provider Registry 不可用')
    createSuccessResponse(res, await provider.listModels(String(req.params.id)))
  })
)

agentRouter.post(
  '/providers/:id/test',
  safe(async (req, res) => {
    const provider = getAgentServices()?.providers
    if (!provider) throw new Error('Provider Registry 不可用')
    const id = String(req.params.id)
    const result = await provider.probe(id)
    await saveAgentProviderVerification(id, result)
    createSuccessResponse(res, result)
  })
)

agentRouter.get(
  '/tools',
  safe(async (_req, res) => {
    createSuccessResponse(res, getAgentServices()?.registry.list() || [])
  })
)

agentRouter.get(
  '/threads',
  safe(async (req, res) => {
    const limit = Number(req.query.limit || 100)
    const state = ['active', 'archived', 'all'].includes(String(req.query.state))
      ? String(req.query.state) as 'active' | 'archived' | 'all'
      : 'active'
    createSuccessResponse(res, await database().listThreads({
      limit,
      state,
      query: String(req.query.query || ''),
      cursor: req.query.cursor ? Number(req.query.cursor) : undefined,
    }))
  })
)

agentRouter.post(
  '/threads',
  safe(async (req, res) => {
    const actor = actorFromRequest(req)
    const threadKey = String(req.body?.threadKey || `web:${actor.id}:${randomUUID()}`)
    const thread = await database().getOrCreateThread(threadKey, actor)
    createSuccessResponse(res, thread)
  })
)

agentRouter.get(
  '/threads/:id/messages',
  safe(async (req, res) => {
    const threadId = String(req.params.id)
    const thread = await database().getThread(threadId)
    if (!thread) {
      createNotFoundResponse(res, 'Thread 不存在')
      return
    }
    createSuccessResponse(
      res,
      await database().listMessages(
        threadId,
        Number(req.query.limit || 200),
        req.query.before ? Number(req.query.before) : undefined
      )
    )
  })
)

agentRouter.patch(
  '/threads/:id',
  safe(async (req, res) => {
    const threadId = String(req.params.id)
    const thread = await database().getThread(threadId)
    if (!thread) {
      createNotFoundResponse(res, 'Thread 不存在')
      return
    }
    const title = req.body?.title
    const archived = req.body?.archived
    if (title !== undefined && typeof title !== 'string') {
      createBadRequestResponse(res, 'title 必须为字符串')
      return
    }
    if (archived !== undefined && typeof archived !== 'boolean') {
      createBadRequestResponse(res, 'archived 必须为布尔值')
      return
    }
    if (archived === true && ['running', 'waiting_approval'].includes(thread.state)) {
      res.status(409).json({
        code: 409,
        data: null,
        message: '运行中的 Thread 不能归档，请先中断当前回合',
      })
      return
    }
    const updated = await database().updateThread(threadId, { title, archived })
    await database().audit(actorFromRequest(req).id, 'thread.update', threadId, {
      titleChanged: title !== undefined,
      archived,
    }, threadId)
    createSuccessResponse(res, updated)
  })
)

agentRouter.delete(
  '/threads/:id',
  safe(async (req, res) => {
    const threadId = String(req.params.id)
    const thread = await database().getThread(threadId)
    if (!thread) {
      createNotFoundResponse(res, 'Thread 不存在')
      return
    }
    createSuccessResponse(res, {
      deleted: await runtime().deleteThread(threadId, actorFromRequest(req).id),
    })
  })
)

agentRouter.get(
  '/threads/:id/tool-calls',
  safe(async (req, res) => {
    const threadId = String(req.params.id)
    const thread = await database().getThread(threadId)
    if (!thread) {
      createNotFoundResponse(res, 'Thread 不存在')
      return
    }
    const descriptors = new Map(
      (getAgentServices()?.registry.list() || []).map(item => [item.name, item])
    )
    const calls = await database().listToolCalls(
      threadId,
      req.query.turnId ? String(req.query.turnId) : undefined
    )
    createSuccessResponse(res, redactValue(calls.map(call => {
      const descriptor = descriptors.get(call.name)
      return {
        ...call,
        source: descriptor?.source || 'unknown',
        toolset: descriptor?.toolset || 'unknown',
        durationMs: call.completedAt
          ? Math.max(0, call.completedAt - call.createdAt)
          : undefined,
      }
    })))
  })
)

agentRouter.post(
  '/threads/:id/turns',
  safe(async (req, res) => {
    const content = String(req.body?.content || '').trim()
    if (!content) {
      createBadRequestResponse(res, '消息不能为空')
      return
    }
    const thread = await database().getThread(String(req.params.id))
    if (!thread) {
      createNotFoundResponse(res, 'Thread 不存在')
      return
    }
    if (thread.archivedAt) {
      createBadRequestResponse(res, '已归档的 Thread 不能继续对话，请先恢复')
      return
    }
    const requestId = runtime().startTurn({
      threadKey: thread.threadKey,
      actor: actorFromRequest(req),
      content,
    })
    res.status(202).json({
      code: 202,
      data: { accepted: true, requestId, threadId: thread.id },
      message: '已接受',
    })
  })
)

agentRouter.get(
  '/threads/:id/tree',
  safe(async (req, res) => {
    const all = await database().listThreads(500)
    const root = all.find(thread => thread.id === String(req.params.id))
    if (!root) {
      createNotFoundResponse(res, 'Thread 不存在')
      return
    }
    createSuccessResponse(res, {
      root,
      children: all.filter(thread => thread.parentThreadId === root.id),
    })
  })
)

agentRouter.get(
  '/search',
  safe(async (req, res) => {
    const query = String(req.query.q || '').trim()
    if (!query) {
      createBadRequestResponse(res, '缺少搜索关键词')
      return
    }
    createSuccessResponse(
      res,
      await database().searchMessages(query, Number(req.query.limit || 100))
    )
  })
)

agentRouter.post(
  '/chat',
  safe(async (req, res) => {
    const content = String(req.body?.content || '').trim()
    if (!content) {
      createBadRequestResponse(res, '消息不能为空')
      return
    }
    const actor = actorFromRequest(req)
    const threadKey = String(req.body?.threadKey || `web:${actor.id}:${randomUUID()}`)
    const result = await runtime().runTurn({
      threadKey,
      actor,
      content,
    })
    createSuccessResponse(res, result)
  })
)

agentRouter.post(
  '/threads/:id/interrupt',
  safe(async (req, res) => {
    createSuccessResponse(res, {
      interrupted: await runtime().interrupt(String(req.params.id)),
    })
  })
)

agentRouter.get(
  '/threads/:id/events',
  safe(async (req, res) => {
    const agent = runtime()
    const afterId = Number(req.get('last-event-id') || req.query.after || 0)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const send = (event: ReturnType<typeof agent.events.publish>) => {
      const safeEvent = redactValue(event)
      res.write(`id: ${event.id}\n`)
      res.write(`event: ${event.type}\n`)
      res.write(`data: ${JSON.stringify(safeEvent)}\n\n`)
    }
    const threadId = String(req.params.id)
    for (const event of agent.events.replay(threadId, afterId)) send(event)
    const unsubscribe = agent.events.subscribe(threadId, send)
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000)
    req.once('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
)

agentRouter.get(
  '/approvals',
  safe(async (req, res) => {
    const status = req.query.status
      ? (String(req.query.status) as 'pending' | 'approved' | 'denied' | 'expired')
      : undefined
    createSuccessResponse(res, await database().listApprovals(status))
  })
)

agentRouter.post(
  '/approvals/:id/resolve',
  safe(async (req, res) => {
    const decision = req.body?.decision
    if (decision !== 'approved' && decision !== 'denied') {
      createBadRequestResponse(res, 'decision 必须为 approved 或 denied')
      return
    }
    createSuccessResponse(
      res,
      await runtime().resolveApproval(String(req.params.id), decision, actorFromRequest(req))
    )
  })
)

agentRouter.get(
  '/memories',
  safe(async (_req, res) => {
    createSuccessResponse(res, await database().listMemories())
  })
)

agentRouter.post(
  '/memories',
  safe(async (req, res) => {
    const actor = actorFromRequest(req)
    const content = String(req.body?.content || '').trim()
    const scope = String(req.body?.scope || 'user') as 'user' | 'group' | 'global'
    const scopeKey = String(
      req.body?.scopeKey || (scope === 'global' ? 'global' : actor.id)
    ).trim()
    if (!['user', 'group', 'global'].includes(scope) || !scopeKey || !content) {
      createBadRequestResponse(res, '记忆的 scope、scopeKey 和 content 无效')
      return
    }
    if (content.length > 2000) {
      createBadRequestResponse(res, '记忆内容不能超过 2000 字符')
      return
    }
    const id = await database().addMemory(scope, scopeKey, content, `web:${Date.now()}`)
    await database().audit(actor.id, 'memory.create', id, { scope, scopeKey })
    createSuccessResponse(res, { id })
  })
)

agentRouter.post(
  '/memories/:id/state',
  safe(async (req, res) => {
    const enabled = Boolean(req.body?.enabled)
    const memoryId = String(req.params.id)
    const updated = await database().setMemoryEnabled(memoryId, enabled)
    await database().audit(actorFromRequest(req).id, 'memory.state', memoryId, { enabled })
    createSuccessResponse(res, { updated })
  })
)

agentRouter.post(
  '/memories/:id/delete',
  safe(async (req, res) => {
    const memoryId = String(req.params.id)
    const deleted = await database().deleteMemory(memoryId)
    await database().audit(actorFromRequest(req).id, 'memory.delete', memoryId, { deleted })
    createSuccessResponse(res, { deleted })
  })
)

agentRouter.get(
  '/skills',
  safe(async (_req, res) => {
    createSuccessResponse(res, await database().listSkills())
  })
)

agentRouter.post(
  '/skills',
  safe(async (req, res) => {
    const learning = getAgentServices()?.learning
    if (!learning) throw new Error('Agent Skills 管理不可用')
    const actor = actorFromRequest(req)
    const result = await learning.createSkill(
      {
        name: String(req.body?.name || ''),
        description: String(req.body?.description || ''),
        instructions: String(req.body?.instructions || ''),
        tools: Array.isArray(req.body?.tools) ? req.body.tools.map(String) : [],
      },
      'web',
      `web:${Date.now()}`,
      actor
    )
    createSuccessResponse(res, result)
  })
)

agentRouter.get(
  '/skills/:id/versions',
  safe(async (req, res) => {
    createSuccessResponse(res, await database().getSkillVersions(String(req.params.id)))
  })
)

agentRouter.post(
  '/skills/:id/state',
  safe(async (req, res) => {
    const enabled = Boolean(req.body?.enabled)
    const skillId = String(req.params.id)
    const updated = await database().setSkillEnabled(skillId, enabled)
    await database().audit(actorFromRequest(req).id, 'skill.state', skillId, { enabled })
    createSuccessResponse(res, { updated })
  })
)

agentRouter.post(
  '/skills/:id/rollback',
  safe(async (req, res) => {
    const versionId = String(req.body?.versionId || '')
    const skillId = String(req.params.id)
    const updated = await database().rollbackSkill(skillId, versionId)
    await database().audit(actorFromRequest(req).id, 'skill.rollback', skillId, {
      versionId,
      updated,
    })
    createSuccessResponse(res, { updated })
  })
)

agentRouter.get(
  '/audit',
  safe(async (req, res) => {
    createSuccessResponse(res, await database().listAudit(Number(req.query.limit || 200)))
  })
)

agentRouter.get(
  '/usage',
  safe(async (req, res) => {
    createSuccessResponse(res, await database().listUsage(Number(req.query.limit || 200)))
  })
)

agentRouter.get(
  '/jobs',
  safe(async (_req, res) => {
    createSuccessResponse(res, await database().listJobs())
  })
)

agentRouter.post(
  '/jobs',
  safe(async (req, res) => {
    const scheduler = getAgentServices()?.scheduler
    if (!scheduler) throw new Error('Agent 自动任务不可用')
    const body = req.body || {}
    const scheduleType = body.scheduleType === 'once' ? 'once' : 'cron'
    const runAt = body.runAt ? new Date(body.runAt).getTime() : null
    if (
      !body.name ||
      !body.prompt ||
      !body.target ||
      (scheduleType === 'cron' && !body.cron) ||
      (scheduleType === 'once' && (!runAt || runAt <= Date.now()))
    ) {
      createBadRequestResponse(res, '自动任务缺少必要字段')
      return
    }
    const record = await scheduler.save({
      id: body.id ? String(body.id) : undefined,
      name: String(body.name),
      scheduleType,
      cron: String(body.cron || ''),
      runAt,
      timezone: String(body.timezone || 'Asia/Shanghai'),
      prompt: String(body.prompt),
      target: String(body.target),
      toolAllowlist: Array.isArray(body.toolAllowlist) ? body.toolAllowlist.map(String) : [],
      skillIds: Array.isArray(body.skillIds) ? body.skillIds.map(String) : [],
      enabled: body.enabled !== false,
      createdBy: actorFromRequest(req).id,
    })
    await database().audit(actorFromRequest(req).id, 'job.save', record.id, {
      name: record.name,
      enabled: record.enabled,
    })
    createSuccessResponse(res, record)
  })
)

agentRouter.get(
  '/jobs/runs',
  safe(async (req, res) => {
    const jobId = req.query.jobId ? String(req.query.jobId) : undefined
    createSuccessResponse(res, await database().listJobRuns(jobId, Number(req.query.limit || 200)))
  })
)

agentRouter.post(
  '/jobs/:id/delete',
  safe(async (req, res) => {
    const scheduler = getAgentServices()?.scheduler
    if (!scheduler) throw new Error('Agent 自动任务不可用')
    const jobId = String(req.params.id)
    const deleted = await scheduler.delete(jobId)
    await database().audit(actorFromRequest(req).id, 'job.delete', jobId, { deleted })
    createSuccessResponse(res, { deleted })
  })
)

agentRouter.post(
  '/jobs/:id/state',
  safe(async (req, res) => {
    const scheduler = getAgentServices()?.scheduler
    if (!scheduler) throw new Error('Agent 自动任务不可用')
    const jobId = String(req.params.id)
    const enabled = Boolean(req.body?.enabled)
    const record = await scheduler.setEnabled(jobId, enabled)
    await database().audit(actorFromRequest(req).id, 'job.state', jobId, { enabled })
    createSuccessResponse(res, record)
  })
)

agentRouter.post(
  '/jobs/:id/run',
  safe(async (req, res) => {
    const scheduler = getAgentServices()?.scheduler
    if (!scheduler) throw new Error('Agent 自动任务不可用')
    const jobId = String(req.params.id)
    const result = await scheduler.runNow(jobId)
    await database().audit(actorFromRequest(req).id, 'job.run.manual', jobId, {})
    createSuccessResponse(res, result)
  })
)

agentRouter.get(
  '/mcp',
  safe(async (_req, res) => {
    createSuccessResponse(res, getAgentServices()?.mcp?.status() || [])
  })
)

agentRouter.post(
  '/mcp/reload',
  safe(async (_req, res) => {
    const mcp = getAgentServices()?.mcp
    if (!mcp) throw new Error('MCP Client 不可用')
    await mcp.reload()
    createSuccessResponse(res, mcp.status())
  })
)
