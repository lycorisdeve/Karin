import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { getAgentServices, getAgentStatus, restartAgent } from '@/agent'
import { AgentPythonRuntime } from '@/agent/scripts/runtime'
import { probeAgentIsolationBackends } from '@/agent/execution/isolation'
import { isManagedAgentMediaPath } from '@/agent/persistence/media'
import {
  agentConfig,
  agentProviderPresets,
  hasAgentApiKey,
  mergeAgentConfigUpdate,
  publicAgentConfig,
  saveAgentConfig,
  saveAgentProviderModels,
  saveAgentProviderVerification,
} from '@/utils/config/file/agent'
import {
  createBadRequestResponse,
  createNotFoundResponse,
  createServerErrorResponse,
  createSuccessResponse,
} from '@/server/utils/response'

import type { RequestHandler } from 'express'
import type {
  AgentActivityView,
  AgentActor,
  AgentConfig,
  AgentPersonaDefinition,
  AgentStreamEvent,
  AgentThreadState,
} from '@/types/agent'

export const agentRouter: Router = Router()

const actorFromRequest = (req: Parameters<RequestHandler>[0]): AgentActor => {
  const id = req.get('x-user-id') || 'web-admin'
  return {
    id,
    role: 'admin',
    selfId: 'web',
    scene: 'web',
    contactKey: `web:${id}`,
    origin: {
      channel: 'web',
      protocol: 'web',
      accountId: 'web',
      accountName: 'Karin WebUI',
      contactKey: `web:${id}`,
      contactId: id,
      contactSubId: '',
      contactName: '',
    },
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

const instructions = () => {
  const value = getAgentServices()?.instructions
  if (!value) throw new Error('AGENT.md 管理服务不可用')
  return value
}

const personaDefinition = (value: unknown): AgentPersonaDefinition => {
  const input = value && typeof value === 'object'
    ? value as Partial<AgentPersonaDefinition>
    : {}
  return {
    identity: String(input.identity || '').trim().slice(0, 2000),
    expertise: Array.isArray(input.expertise)
      ? [...new Set(input.expertise.map(String).map(item => item.trim()).filter(Boolean))]
        .slice(0, 32)
      : [],
    tone: String(input.tone || '').trim().slice(0, 1000),
    responseStyle: String(input.responseStyle || '').trim().slice(0, 2000),
    language: String(input.language || '').trim().slice(0, 200),
  }
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

const activityStatus = (
  state: AgentThreadState | string
): AgentActivityView['status'] => {
  if (state === 'waiting_approval') return 'waiting_approval'
  if (state === 'completed' || state === 'failed' || state === 'interrupted') return state
  return 'running'
}

const completedAt = (state: AgentActivityView['status'], updatedAt: number) =>
  ['completed', 'failed', 'denied', 'expired', 'interrupted'].includes(state)
    ? updatedAt
    : undefined

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
  const scriptRuntime = config.scriptRuntime
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
    Boolean(config.tasks) &&
    Boolean(config.policy) &&
    Boolean(config.learning) &&
    Boolean(config.tools) &&
    Boolean(config.mcp) &&
    Boolean(config.scriptRuntime) &&
    (
      !scriptRuntime?.pythonExecutable ||
      path.isAbsolute(scriptRuntime.pythonExecutable)
    ) &&
    mcpCredentialsValid
  )
}

agentRouter.get(
  '/status',
  safe(async (_req, res) => {
    const learning = getAgentServices()?.learning
    const scriptRuntime = learning?.scriptRuntime || new AgentPythonRuntime(agentConfig)
    createSuccessResponse(res, {
      ...getAgentStatus(),
      apiKeyConfigured: hasAgentApiKey(),
      ftsAvailable: getAgentServices()?.database.isFtsAvailable() || false,
      isolation: probeAgentIsolationBackends(),
      scriptRuntime: await scriptRuntime.status(),
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
  '/instructions',
  safe(async (_req, res) => {
    createSuccessResponse(res, {
      current: await instructions().current(),
      filename: 'AGENT.md',
      maxBytes: 32 * 1024,
    })
  })
)

agentRouter.put(
  '/instructions',
  safe(async (req, res) => {
    try {
      const actor = actorFromRequest(req)
      const version = await instructions().save(
        String(req.body?.content || ''),
        String(req.body?.expectedHash || ''),
        actor.id
      )
      await database().audit(actor.id, 'instructions.update', version.id, {
        version: version.version,
        contentHash: version.contentHash,
      })
      createSuccessResponse(res, version)
    } catch (error) {
      if ((error as Error & { code?: string }).code === 'INSTRUCTION_CONFLICT') {
        res.status(409).json({ code: 409, data: null, message: (error as Error).message })
        return
      }
      throw error
    }
  })
)

agentRouter.get(
  '/instructions/versions',
  safe(async (_req, res) => createSuccessResponse(res, await instructions().versions()))
)

agentRouter.get(
  '/personas',
  safe(async (_req, res) => createSuccessResponse(res, await database().listPersonas()))
)

agentRouter.post(
  '/personas',
  safe(async (req, res) => {
    const actor = actorFromRequest(req)
    const name = String(req.body?.name || '').trim().slice(0, 100)
    if (!name) {
      createBadRequestResponse(res, '人物名称不能为空')
      return
    }
    const persona = await database().createPersona({
      name,
      description: String(req.body?.description || '').trim().slice(0, 500),
      definition: personaDefinition(req.body?.definition),
      createdBy: actor.id,
    })
    await database().audit(actor.id, 'persona.create', persona.id, {
      version: persona.version,
    })
    createSuccessResponse(res, persona)
  })
)

agentRouter.put(
  '/personas/:id',
  safe(async (req, res) => {
    const actor = actorFromRequest(req)
    const name = String(req.body?.name || '').trim().slice(0, 100)
    if (!name) {
      createBadRequestResponse(res, '人物名称不能为空')
      return
    }
    const persona = await database().updatePersona(String(req.params.id), {
      name,
      description: String(req.body?.description || '').trim().slice(0, 500),
      definition: personaDefinition(req.body?.definition),
      createdBy: actor.id,
    })
    await database().audit(actor.id, 'persona.update', persona.id, {
      version: persona.version,
    })
    createSuccessResponse(res, persona)
  })
)

agentRouter.get(
  '/personas/:id/versions',
  safe(async (req, res) => createSuccessResponse(
    res,
    await database().listPersonaVersions(String(req.params.id))
  ))
)

agentRouter.post(
  '/personas/:id/state',
  safe(async (req, res) => {
    const actor = actorFromRequest(req)
    const persona = await database().setPersonaEnabled(
      String(req.params.id),
      Boolean(req.body?.enabled)
    )
    await database().audit(actor.id, 'persona.state', persona.id, {
      enabled: persona.enabled,
    })
    createSuccessResponse(res, persona)
  })
)

agentRouter.post(
  '/personas/:id/default',
  safe(async (req, res) => {
    const actor = actorFromRequest(req)
    const persona = await database().setDefaultPersona(String(req.params.id))
    await database().audit(actor.id, 'persona.default', persona.id, {})
    createSuccessResponse(res, persona)
  })
)

agentRouter.get(
  '/providers/presets',
  safe(async (_req, res) => {
    createSuccessResponse(res, agentProviderPresets())
  })
)

agentRouter.get(
  '/providers/:id/capabilities',
  safe(async (req, res) => {
    const provider = getAgentServices()?.providers
    if (!provider) throw new Error('Provider Registry 不可用')
    createSuccessResponse(res, provider.capabilitiesFor(String(req.params.id)))
  })
)

agentRouter.post(
  '/providers/:id/models',
  safe(async (req, res) => {
    const provider = getAgentServices()?.providers
    if (!provider) throw new Error('Provider Registry 不可用')
    const id = String(req.params.id)
    const models = await provider.listModels(id)
    createSuccessResponse(res, await saveAgentProviderModels(id, models))
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
  '/generated-tools',
  safe(async (_req, res) => {
    const library = getAgentServices()?.generatedTools
    if (!library) throw new Error('Generated Tool Library 不可用')
    createSuccessResponse(res, await library.list())
  })
)

agentRouter.get(
  '/generated-tools/:id/versions',
  safe(async (req, res) => {
    const library = getAgentServices()?.generatedTools
    if (!library) throw new Error('Generated Tool Library 不可用')
    createSuccessResponse(res, await library.versions(String(req.params.id)))
  })
)

agentRouter.get(
  '/generated-tools/:id/validation',
  safe(async (req, res) => {
    const library = getAgentServices()?.generatedTools
    if (!library) throw new Error('Generated Tool Library 不可用')
    createSuccessResponse(
      res,
      await library.validate(String(req.params.id), AbortSignal.timeout(120_000))
    )
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
      channel: String(req.query.channel || ''),
      rootOnly: String(req.query.rootOnly || '') === 'true',
    }))
  })
)

agentRouter.get(
  '/threads/channels',
  safe(async (_req, res) => {
    createSuccessResponse(res, await database().listThreadChannels())
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
  '/threads/:id/tasks',
  safe(async (req, res) => {
    const threadId = String(req.params.id)
    if (!await database().getThread(threadId)) {
      createNotFoundResponse(res, 'Thread 不存在')
      return
    }
    const history = String(req.query.history || '') === 'true'
    const lists = await database().listTaskLists(threadId)
    createSuccessResponse(
      res,
      history
        ? lists
        : await database().getActiveTaskList(threadId) || lists[0] || null
    )
  })
)

agentRouter.get(
  '/media/:id',
  safe(async (req, res) => {
    const attachment = await database().getMessageAttachment(String(req.params.id))
    if (
      !attachment ||
      !isManagedAgentMediaPath(database(), attachment.storagePath)
    ) {
      createNotFoundResponse(res, '附件不存在')
      return
    }
    const stat = await fs.promises.stat(attachment.storagePath).catch(() => null)
    if (!stat?.isFile()) {
      createNotFoundResponse(res, '附件文件不存在')
      return
    }
    res.type(attachment.mime)
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    await new Promise<void>((resolve, reject) => {
      res.sendFile(path.resolve(attachment.storagePath), error => {
        if (error) reject(error)
        else resolve()
      })
    })
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
    if (archived === true) await database().revokeAllThreadToolGrants(threadId)
    await database().audit(actorFromRequest(req).id, 'thread.update', threadId, {
      titleChanged: title !== undefined,
      archived,
    }, threadId)
    createSuccessResponse(res, updated)
  })
)

agentRouter.get(
  '/threads/:id/model',
  safe(async (req, res) => {
    createSuccessResponse(res, await runtime().describeThreadModel(String(req.params.id)))
  })
)

agentRouter.patch(
  '/threads/:id/model',
  safe(async (req, res) => {
    const providerId = req.body?.providerId == null ? null : String(req.body.providerId)
    const model = req.body?.model == null ? null : String(req.body.model)
    createSuccessResponse(
      res,
      await runtime().setThreadModel(
        String(req.params.id),
        actorFromRequest(req),
        providerId,
        model
      )
    )
  })
)

agentRouter.get(
  '/threads/:id/customization',
  safe(async (req, res) => {
    createSuccessResponse(res, await runtime().describeThreadPersona(String(req.params.id)))
  })
)

agentRouter.patch(
  '/threads/:id/persona',
  safe(async (req, res) => {
    const personaId = req.body?.personaId == null ? null : String(req.body.personaId)
    createSuccessResponse(res, await runtime().setThreadPersona(
      String(req.params.id),
      actorFromRequest(req),
      personaId
    ))
  })
)

agentRouter.patch(
  '/threads/:id/instruction-version',
  safe(async (req, res) => {
    const threadId = String(req.params.id)
    const versionId = String(req.body?.versionId || '')
    if (!versionId) {
      createBadRequestResponse(res, 'versionId 不能为空')
      return
    }
    const updated = await database().setThreadInstructionVersion(threadId, versionId)
    await database().audit(
      actorFromRequest(req).id,
      'thread.instructions.set',
      threadId,
      { versionId },
      threadId
    )
    createSuccessResponse(res, { updated, versionId })
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
        isolation: descriptor?.isolation || 'legacy-inline',
        description: descriptor?.description || '',
        durationMs: call.completedAt
          ? Math.max(0, call.completedAt - call.createdAt)
          : undefined,
      }
    })))
  })
)

agentRouter.get(
  '/threads/:id/activity',
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
    const [turns, calls, approvals, treeIds] = await Promise.all([
      database().listTurns(threadId),
      database().listToolCalls(threadId),
      database().listApprovalsByThread(threadId),
      database().getThreadTreeIds(threadId),
    ])
    const activities: AgentActivityView[] = turns.map(turn => {
      const status = activityStatus(turn.state)
      const end = completedAt(status, turn.updatedAt)
      return {
        id: `turn:${turn.id}`,
        threadId,
        turnId: turn.id,
        kind: 'turn',
        status,
        label:
          status === 'running'
            ? '思考中'
            : status === 'waiting_approval'
              ? '等待确认'
              : status === 'completed'
                ? '回复完成'
                : status === 'interrupted'
                  ? '已停止'
                  : '运行失败',
        error: turn.error,
        startedAt: turn.createdAt,
        completedAt: end,
        durationMs: end ? Math.max(0, end - turn.createdAt) : undefined,
      }
    })
    activities.push(...calls.map(call => {
      const descriptor = descriptors.get(call.name)
      const status: AgentActivityView['status'] =
        call.status === 'waiting_approval'
          ? 'waiting_approval'
          : call.status === 'completed'
            ? 'completed'
            : call.status === 'failed'
              ? 'failed'
              : 'running'
      return {
        id: `tool:${call.id}`,
        threadId,
        turnId: call.turnId,
        kind: 'tool' as const,
        status,
        label: descriptor?.description || call.name,
        source: descriptor?.source || 'unknown',
        isolation: descriptor?.isolation || 'legacy-inline',
        risk: call.risk as AgentActivityView['risk'],
        decision: call.decision as AgentActivityView['decision'],
        input: call.input,
        output: call.output,
        error: call.error,
        startedAt: call.createdAt,
        completedAt: call.completedAt,
        durationMs: call.completedAt
          ? Math.max(0, call.completedAt - call.createdAt)
          : undefined,
      }
    }))
    activities.push(...approvals.map(approval => ({
      id: `approval:${approval.id}`,
      threadId,
      turnId: approval.turnId,
      kind: 'approval' as const,
      status: (
        approval.status === 'pending'
          ? 'waiting_approval'
          : approval.status === 'approved'
            ? 'completed'
            : approval.status
      ) as AgentActivityView['status'],
      label: `确认调用 ${approval.toolName}`,
      parentId: `tool:${approval.toolCallId}`,
      input: approval.input,
      startedAt: approval.createdAt,
      completedAt: approval.resolvedAt || undefined,
      durationMs: approval.resolvedAt
        ? Math.max(0, approval.resolvedAt - approval.createdAt)
        : undefined,
    })))
    const childThreads = (
      await Promise.all(
        treeIds.filter(id => id !== threadId).map(id => database().getThread(id))
      )
    ).filter(item => item !== null)
    for (const child of childThreads) {
      const childTurns = await database().listTurns(child.id)
      const firstTurn = childTurns[0]
      const status = activityStatus(child.state)
      const end = completedAt(status, child.updatedAt)
      activities.push({
        id: `subagent:${child.id}`,
        threadId,
        turnId: firstTurn?.id || child.id,
        kind: 'subagent',
        status,
        label: child.title || child.lastMessagePreview || '处理委派任务',
        parentId: child.parentThreadId || undefined,
        startedAt: child.createdAt,
        completedAt: end,
        durationMs: end ? Math.max(0, end - child.createdAt) : undefined,
      })
    }
    activities.sort((left, right) => left.startedAt - right.startedAt)
    createSuccessResponse(res, redactValue(activities))
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
    if (thread.parentThreadId) {
      createBadRequestResponse(res, '子 Agent 会话只读，请返回父会话继续对话')
      return
    }
    if (thread.contactKey && !['web', 'system'].includes(thread.channel)) {
      await database().activateSession(thread.contactKey, thread.id)
      await database().audit(
        actorFromRequest(req).id,
        'session.activate',
        thread.id,
        { channel: thread.channel },
        thread.id
      )
    }
    const webActor = actorFromRequest(req)
    const turnActor = !['web', 'system'].includes(thread.channel)
      ? {
        ...webActor,
        selfId: thread.accountId,
        scene: thread.scene,
        contactKey: thread.contactKey,
        origin: {
          channel: thread.channel,
          protocol: thread.protocol,
          accountId: thread.accountId,
          accountName: thread.accountName,
          contactKey: thread.contactKey,
          contactId: thread.contactId,
          contactSubId: thread.contactSubId,
          contactName: thread.contactName,
        },
      }
      : webActor
    const submission = runtime().startTurn({
      threadKey: thread.threadKey,
      actor: turnActor,
      content,
      idempotencyKey: req.body?.idempotencyKey
        ? String(req.body.idempotencyKey).slice(0, 256)
        : undefined,
      onResult: async result => {
        await runtime().deliverThreadResult(thread, result, webActor.id)
      },
    })
    res.status(202).json({
      code: 202,
      data: {
        accepted: true,
        requestId: submission.requestId,
        runId: submission.requestId,
        threadId: thread.id,
        mode: submission.mode,
        interrupted: submission.interrupted,
      },
      message: '已接受',
    })
  })
)

agentRouter.get(
  '/threads/:id/deliveries',
  safe(async (req, res) => {
    const thread = await database().getThread(String(req.params.id))
    if (!thread) {
      createNotFoundResponse(res, 'Thread 不存在')
      return
    }
    createSuccessResponse(
      res,
      await database().listDeliveryOperations(
        thread.id,
        Number(req.query.limit || 100)
      )
    )
  })
)

agentRouter.get(
  '/threads/:id/turns/:turnId',
  safe(async (req, res) => {
    const turn = (await database().listTurns(String(req.params.id)))
      .find(item => item.id === String(req.params.turnId))
    if (!turn) {
      createNotFoundResponse(res, 'Turn 不存在')
      return
    }
    createSuccessResponse(res, turn)
  })
)

agentRouter.get(
  '/tool-artifacts/:id',
  safe(async (req, res) => {
    const artifact = await database().getToolArtifact(String(req.params.id))
    if (!artifact) {
      createNotFoundResponse(res, 'Tool Artifact 不存在')
      return
    }
    createSuccessResponse(res, {
      ...artifact,
      content: JSON.parse(artifact.content),
    })
  })
)

agentRouter.get(
  '/threads/:id/tree',
  safe(async (req, res) => {
    const tree = await database().getThreadTree(String(req.params.id))
    if (!tree.length) {
      createNotFoundResponse(res, 'Thread 不存在')
      return
    }
    createSuccessResponse(res, {
      root: tree[0],
      children: tree.slice(1),
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

agentRouter.post(
  '/threads/:id/stop',
  safe(async (req, res) => {
    createSuccessResponse(res, await runtime().interruptTree(String(req.params.id)))
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

    const send = (event: AgentStreamEvent, replayed = false) => {
      const safeEvent = redactValue(event) as AgentStreamEvent
      res.write(`id: ${event.id}\n`)
      res.write(`event: ${event.type}\n`)
      res.write(`data: ${JSON.stringify({ ...safeEvent, replayed })}\n\n`)
    }
    const threadId = String(req.params.id)
    for (const event of await agent.events.replay(threadId, afterId)) send(event, true)
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
    const scope = req.body?.scope || 'once'
    if (decision !== 'approved' && decision !== 'denied') {
      createBadRequestResponse(res, 'decision 必须为 approved 或 denied')
      return
    }
    if (!['once', 'thread', 'delegate'].includes(scope)) {
      createBadRequestResponse(res, 'scope 必须为 once、thread 或 delegate')
      return
    }
    const webActor = actorFromRequest(req)
    const result = await runtime().resolveApproval(
      String(req.params.id),
      decision,
      webActor,
      scope
    )
    const thread = await database().getThread(result.threadId)
    if (thread) await runtime().deliverThreadResult(thread, result, webActor.id)
    createSuccessResponse(res, result)
  })
)

agentRouter.get(
  '/threads/:id/grants',
  safe(async (req, res) => {
    createSuccessResponse(
      res,
      await database().listThreadToolGrants(String(req.params.id))
    )
  })
)

agentRouter.delete(
  '/threads/:id/grants/:grantId',
  safe(async (req, res) => {
    const threadId = String(req.params.id)
    const grantId = String(req.params.grantId)
    const revoked = await database().revokeThreadToolGrant(threadId, grantId)
    await database().audit(
      actorFromRequest(req).id,
      'approval.grant.revoke',
      grantId,
      { revoked },
      threadId
    )
    createSuccessResponse(res, { revoked })
  })
)

agentRouter.post(
  '/threads/:id/feedback',
  safe(async (req, res) => {
    const learning = getAgentServices()?.learning
    if (!learning) throw new Error('Agent Learning Module 不可用')
    const rating = req.body?.rating
    if (rating !== undefined && (!Number.isInteger(rating) || rating < -1 || rating > 1)) {
      createBadRequestResponse(res, 'rating 必须为 -1、0 或 1')
      return
    }
    const correction = req.body?.correction
    if (correction !== undefined && typeof correction !== 'string') {
      createBadRequestResponse(res, 'correction 必须为字符串')
      return
    }
    createSuccessResponse(
      res,
      await learning.feedback({
        threadId: String(req.params.id),
        turnId: req.body?.turnId ? String(req.body.turnId) : undefined,
        actor: actorFromRequest(req),
        rating,
        correction,
      })
    )
  })
)

agentRouter.get(
  '/memories',
  safe(async (req, res) => {
    const query = String(req.query.query || '').trim().toLowerCase()
    const scope = String(req.query.scope || '')
    const kind = String(req.query.kind || '')
    const status = String(req.query.status || '')
    const memories = (await database().listMemories()).filter(item =>
      (!query || item.content.toLowerCase().includes(query) ||
        item.memoryKey?.toLowerCase().includes(query)) &&
      (!scope || item.scope === scope) &&
      (!kind || item.kind === kind) &&
      (!status || item.status === status)
    )
    createSuccessResponse(res, memories)
  })
)

agentRouter.get(
  '/memories/retrieval-preview',
  safe(async (req, res) => {
    const query = String(req.query.query || '').trim()
    if (!query) {
      createBadRequestResponse(res, 'query 不能为空')
      return
    }
    const all = await database().listMemories()
    const scopes = [...new Map(all.map(item => [
      `${item.scope}:${item.scopeKey}`,
      { scope: item.scope, key: item.scopeKey },
    ])).values()]
    createSuccessResponse(
      res,
      await database().retrieveMemories(scopes, query, agentConfig().memory.retrieval)
    )
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
    const kind = String(req.body?.kind || 'fact') as
      'preference' | 'fact' | 'relationship' | 'procedure' | 'constraint'
    if (!['preference', 'fact', 'relationship', 'procedure', 'constraint'].includes(kind)) {
      createBadRequestResponse(res, '记忆 kind 无效')
      return
    }
    const id = await database().addMemory(scope, scopeKey, content, `web:${Date.now()}`, {
      kind,
      memoryKey: String(req.body?.memoryKey || '').trim() || null,
      confidence: Number(req.body?.confidence ?? 1),
      importance: Number(req.body?.importance ?? 0.8),
      pinned: Boolean(req.body?.pinned),
      sourceType: 'web',
      expiresAt: req.body?.expiresAt ? Number(req.body.expiresAt) : null,
    })
    await database().audit(actor.id, 'memory.create', id, { scope, scopeKey })
    createSuccessResponse(res, { id })
  })
)

agentRouter.patch(
  '/memories/:id',
  safe(async (req, res) => {
    const memory = await database().updateMemory(String(req.params.id), {
      content: req.body?.content === undefined ? undefined : String(req.body.content),
      kind: req.body?.kind,
      memoryKey: req.body?.memoryKey === undefined ? undefined : String(req.body.memoryKey),
      confidence: req.body?.confidence === undefined ? undefined : Number(req.body.confidence),
      importance: req.body?.importance === undefined ? undefined : Number(req.body.importance),
      pinned: req.body?.pinned === undefined ? undefined : Boolean(req.body.pinned),
      expiresAt: req.body?.expiresAt === undefined
        ? undefined
        : req.body.expiresAt == null ? null : Number(req.body.expiresAt),
      status: req.body?.status,
    })
    await database().audit(actorFromRequest(req).id, 'memory.update', String(req.params.id), {
      fields: Object.keys(req.body || {}),
    })
    createSuccessResponse(res, memory)
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
        scriptTools: Array.isArray(req.body?.scriptTools) ? req.body.scriptTools : [],
      },
      'web',
      `web:${Date.now()}`,
      actor
    )
    createSuccessResponse(res, result)
  })
)

agentRouter.post(
  '/skills/:id/versions',
  safe(async (req, res) => {
    const learning = getAgentServices()?.learning
    if (!learning) throw new Error('Agent Skills 管理不可用')
    const actor = actorFromRequest(req)
    const skillId = String(req.params.id)
    const result = await learning.updateSkill(
      skillId,
      {
        name: String(req.body?.name || ''),
        description: String(req.body?.description || ''),
        instructions: String(req.body?.instructions || ''),
        tools: Array.isArray(req.body?.tools) ? req.body.tools.map(String) : [],
        scriptTools: Array.isArray(req.body?.scriptTools) ? req.body.scriptTools : [],
      },
      'web',
      `web:${Date.now()}`,
      actor
    )
    createSuccessResponse(res, result)
  })
)

agentRouter.delete(
  '/skills/:id',
  safe(async (req, res) => {
    const learning = getAgentServices()?.learning
    if (!learning) throw new Error('Agent Skills 管理不可用')
    const skillId = String(req.params.id)
    const skill = await database().getSkill(skillId)
    if (!skill) throw new Error('Skill 不存在')
    if (String(req.body?.confirmName || '') !== skill.name) {
      throw new Error('请输入完整 Skill 名称确认永久删除')
    }
    createSuccessResponse(res, await learning.deleteSkill(skillId, actorFromRequest(req)))
  })
)

agentRouter.get(
  '/skills/:id/versions',
  safe(async (req, res) => {
    createSuccessResponse(res, await database().getSkillVersions(String(req.params.id)))
  })
)

agentRouter.get(
  '/skills/:id/usage',
  safe(async (req, res) => {
    createSuccessResponse(res, await database().getSkillUsage(String(req.params.id)))
  })
)

agentRouter.post(
  '/skills/:id/state',
  safe(async (req, res) => {
    const learning = getAgentServices()?.learning
    if (!learning) throw new Error('Agent Skills 管理不可用')
    const enabled = Boolean(req.body?.enabled)
    const skillId = String(req.params.id)
    const updated = await learning.setSkillEnabled(skillId, enabled, actorFromRequest(req))
    createSuccessResponse(res, { updated })
  })
)

agentRouter.post(
  '/skills/:id/rollback',
  safe(async (req, res) => {
    const learning = getAgentServices()?.learning
    if (!learning) throw new Error('Agent Skills 管理不可用')
    const versionId = String(req.body?.versionId || '')
    const skillId = String(req.params.id)
    const updated = await learning.rollbackSkill(
      skillId,
      versionId,
      actorFromRequest(req)
    )
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
  '/evolution/logs',
  safe(async (req, res) => {
    createSuccessResponse(res, await database().listEvolutionLog(Number(req.query.limit || 200)))
  })
)

agentRouter.post(
  '/evolution/logs/:id/delete',
  safe(async (req, res) => {
    if (req.body?.confirm !== true) {
      createBadRequestResponse(res, '删除自我进化日志需要明确确认')
      return
    }
    const actor = actorFromRequest(req)
    const logId = String(req.params.id)
    const deleted = await database().deleteEvolutionLog(logId)
    await database().audit(actor.id, 'evolution.log.delete', logId, { deleted })
    createSuccessResponse(res, { deleted })
  })
)

agentRouter.post(
  '/evolution/logs/clear',
  safe(async (req, res) => {
    if (req.body?.confirm !== true) {
      createBadRequestResponse(res, '清空自我进化日志需要明确确认')
      return
    }
    const actor = actorFromRequest(req)
    const deleted = await database().clearEvolutionLog()
    await database().audit(actor.id, 'evolution.log.clear', 'all', { deleted })
    createSuccessResponse(res, { deleted })
  })
)

agentRouter.get(
  '/evolution/overview',
  safe(async (_req, res) => {
    createSuccessResponse(res, await database().evolutionOverview())
  })
)

agentRouter.get(
  '/evolution/candidates',
  safe(async (req, res) => {
    const states = ['draft', 'evaluating', 'ready', 'active', 'rejected', 'rolled_back']
    const state = req.query.state && states.includes(String(req.query.state))
      ? String(req.query.state) as
        'draft' | 'evaluating' | 'ready' | 'active' | 'rejected' | 'rolled_back'
      : undefined
    createSuccessResponse(
      res,
      await database().listEvolutionCandidates(state, Number(req.query.limit || 200))
    )
  })
)

agentRouter.get(
  '/evolution/candidates/:id/artifact',
  safe(async (req, res) => {
    const repair = getAgentServices()?.repair
    if (!repair) throw new Error('Agent Repair Module 不可用')
    const actor = actorFromRequest(req)
    if (!['master', 'admin'].includes(actor.role)) {
      createBadRequestResponse(res, '只有管理员可以审查修复补丁')
      return
    }
    createSuccessResponse(res, await repair.artifact(String(req.params.id)))
  })
)

agentRouter.post(
  '/evolution/candidates/:id/apply',
  safe(async (req, res) => {
    const repair = getAgentServices()?.repair
    if (!repair) throw new Error('Agent Repair Module 不可用')
    const actor = actorFromRequest(req)
    if (actor.role !== 'master') {
      createBadRequestResponse(res, '只有主人可以应用源码修复')
      return
    }
    createSuccessResponse(
      res,
      await repair.apply(String(req.params.id), actor, req.body?.restartCore !== false)
    )
  })
)

agentRouter.post(
  '/evolution/candidates/:id/repair-rollback',
  safe(async (req, res) => {
    const repair = getAgentServices()?.repair
    if (!repair) throw new Error('Agent Repair Module 不可用')
    const actor = actorFromRequest(req)
    if (actor.role !== 'master') {
      createBadRequestResponse(res, '只有主人可以回滚源码修复')
      return
    }
    createSuccessResponse(
      res,
      await repair.rollback(String(req.params.id), actor, req.body?.restartCore !== false)
    )
  })
)

agentRouter.post(
  '/evolution/candidates/:id/:action',
  safe(async (req, res) => {
    const learning = getAgentServices()?.learning
    if (!learning) throw new Error('Agent Learning Module 不可用')
    const id = String(req.params.id)
    const action = String(req.params.action)
    const actor = actorFromRequest(req)
    if (action === 'evaluate') {
      createSuccessResponse(res, await learning.evaluateCandidate(id, actor))
      return
    }
    if (action === 'promote') {
      createSuccessResponse(res, await learning.promoteCandidate(id, actor))
      return
    }
    if (action === 'reject') {
      createSuccessResponse(
        res,
        await learning.rejectCandidate(id, actor, String(req.body?.reason || ''))
      )
      return
    }
    if (action === 'rollback') {
      createSuccessResponse(res, await learning.rollbackCandidate(id, actor))
      return
    }
    createBadRequestResponse(res, '未知的进化候选操作')
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
      personaId: body.personaId ? String(body.personaId) : null,
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
