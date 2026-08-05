import { eventSourcePolyfill, request } from '@/lib/request'

export interface AgentStatus {
  state: 'disabled' | 'ready' | 'failed'
  reason?: string
  enabled: boolean
  configured: boolean
  apiKeyConfigured: boolean
  ftsAvailable: boolean
  scriptRuntime: {
    available: boolean
    executable: string
    version?: string
    reason?: string
  }
}

export type AgentProviderKind = 'openai' | 'deepseek' | 'kimi' | 'mimo' | 'custom'

export interface AgentProviderProfile {
  id: string
  name: string
  kind: AgentProviderKind
  enabled: boolean
  baseUrl: string
  apiKey: string
  apiKeyConfigured?: boolean
  model: string
  discoveredModels?: string[]
  modelsDiscoveredAt?: number
  visionModels?: string[]
  timeout: number
  contextWindowTokens?: number
  clearApiKey?: boolean
  verification?: {
    testedAt: number
    chat: boolean
    stream: boolean
    tools: boolean
    latency: number
  }
}

export interface AgentConfig {
  version: 9
  enabled: boolean
  providers: AgentProviderProfile[]
  routing: { primary: string; fallback: string[] }
  trigger: { private: boolean; groupMention: boolean; wakeWords: string[] }
  limits: {
    maxToolRounds: number
    maxToolOutputBytes: number
    maxRecentMessages: number
    maxSubagents: number
  }
  context: {
    defaultWindowTokens: number
    softLimitRatio: number
    hardLimitRatio: number
    protectedRecentMessages: number
    summaryTargetTokens: number
  }
  journal: {
    recoveryAttempts: number
    eventRetentionDays: number
  }
  tasks: {
    enabled: boolean
    maxItems: number
    completionGuardRetries: number
  }
  policy: {
    approvalTtlMs: number
    autoApproveTrustedReversible: boolean
    hardDeny: string[]
    rules: Array<{ pattern: string; decision: string }>
    defaults: Record<'read' | 'write' | 'external' | 'destructive', string>
  }
  learning: {
    memory: boolean
    skills: boolean
    reflection: {
      enabled: boolean
      afterFailure: boolean
      successInterval: number
    }
    curator: {
      enabled: boolean
      intervalHours: number
      minIdleMinutes: number
      staleAfterDays: number
      archiveAfterDays: number
    }
    promotion: {
      autoMemory: boolean
      autoRouting: boolean
      autoDeclarativeSkills: boolean
      minEvidence: number
      minSuccessRate: number
      maxRegressionRate: number
      autoRollback: boolean
      rollbackWindow: number
    }
  }
  recovery: {
    enabled: boolean
    maxCycles: number
    maxDiagnosticCalls: number
    maxDurationMs: number
    researchPolicy: 'evidence-driven' | 'always' | 'explicit'
    repair: {
      requireApproval: boolean
      workspaceRoots: string[]
    }
  }
  tools: { disabled: string[]; disabledToolsets: string[] }
  mcp: {
    enabled: boolean
    servers: Array<{
      name: string
      enabled: boolean
      transport: 'stdio' | 'http'
      command?: string
      args?: string[]
      cwd?: string
      url?: string
      headers?: Record<string, string>
      env?: Record<string, string>
    }>
  }
  scriptRuntime: {
    pythonExecutable: string
    defaultTimeoutMs: number
    maxTimeoutMs: number
    defaultMaxOutputBytes: number
    maxOutputBytes: number
  }
}

export interface AgentTaskItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  order: number
  createdAt: number
  updatedAt: number
}

export interface AgentTaskList {
  id: string
  threadId: string
  sourceTurnId: string
  goal: string
  state: 'active' | 'completed' | 'cancelled'
  items: AgentTaskItem[]
  createdAt: number
  updatedAt: number
}

export interface AgentProviderProbe {
  provider: string
  model: string
  models: string[]
  chat: boolean
  stream: boolean
  tools: boolean
  latency: number
}

export interface AgentThread {
  id: string
  threadKey: string
  parentThreadId: string | null
  actorId: string
  scene: string
  state: string
  summary: string
  title: string
  archivedAt: number | null
  messageCount: number
  lastMessagePreview: string
  modelProviderId: string | null
  modelName: string | null
  channel: string
  protocol: string
  accountId: string
  accountName: string
  contactKey: string
  contactId: string
  contactSubId: string
  contactName: string
  depth?: number
  createdAt: number
  updatedAt: number
}

export interface AgentThreadChannel {
  channel: string
  activeCount: number
  archivedCount: number
  lastUpdatedAt: number
}

export interface AgentMessage {
  id: string
  turnId?: string | null
  role: 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  final?: boolean
  attachments?: Array<{
    id: string
    messageId: string
    type: 'image'
    mime: string
    size: number
    name: string
    url: string
    createdAt: number
  }>
  createdAt: number
}

export interface AgentToolCallView {
  id: string
  threadId: string
  turnId: string
  name: string
  source: string
  toolset: string
  description?: string
  risk: string
  decision: string
  status: string
  input: unknown
  output?: unknown
  error?: string
  createdAt: number
  completedAt?: number
  durationMs?: number
}

export interface AgentApproval {
  id: string
  threadId: string
  turnId: string
  toolCallId: string
  actorId: string
  toolName: string
  input: Record<string, unknown>
  approverContactKey: string | null
  status: string
  expiresAt: number
  createdAt: number
}

export interface AgentActivityView {
  id: string
  threadId: string
  turnId: string
  kind: 'turn' | 'tool' | 'approval' | 'subagent'
  status:
    | 'running'
    | 'waiting_approval'
    | 'completed'
    | 'failed'
    | 'denied'
    | 'expired'
    | 'interrupted'
  label: string
  source?: string
  risk?: string
  decision?: string
  parentId?: string
  input?: unknown
  output?: unknown
  error?: string
  startedAt: number
  completedAt?: number
  durationMs?: number
}

export interface AgentDeliveryOperation {
  id: string
  threadId: string
  turnId: string
  finalMessageId: string
  channel: string
  state:
    | 'pending'
    | 'dispatching'
    | 'sent'
    | 'not_sent'
    | 'unknown_after_send'
    | 'failed'
    | 'cancelled'
  adapterMessageId: string | null
  attempts: number
  errorCode: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface AgentMemory {
  id: string
  scope: string
  scopeKey: string
  content: string
  enabled: boolean
  createdAt: number
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  enabled: boolean
  activeVersionId: string | null
  updatedAt: number
}

export interface AgentScriptToolDefinition {
  id: string
  name: string
  description: string
  runtime: 'python'
  source: string
  sourceHash: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  semantics: {
    objective: string
    inputs: string
    outputs: string
    sideEffects: string[]
    idempotent: boolean
  }
  stop: {
    completionCondition: string
    timeoutMs: number
    maxOutputBytes: number
  }
  failure: {
    strategy: 'fail' | 'retry'
    maxAttempts: number
    retryDelayMs: number
    userMessage: string
  }
}

export interface AgentSkillVersion {
  id: string
  skill_id: string
  version: number
  name: string
  description: string
  content: string
  tools_json: string
  source_turn_id: string
  content_hash: string
  validation_status: string
  script_tools_json: string
  created_at: number
}

export interface AgentThreadModel {
  thread: AgentThread
  inherited: boolean
  providerId: string
  providerName: string
  model: string
  models: Array<{
    providerId: string
    providerName: string
    model: string
  }>
}

export interface AgentJob {
  id: string
  name: string
  scheduleType: 'cron' | 'once'
  cron: string
  runAt: number | null
  timezone: string
  prompt: string
  target: string
  toolAllowlist: string[]
  skillIds: string[]
  enabled: boolean
  lastRunAt: number | null
}

export interface AgentEvolutionCandidate {
  id: string
  target: 'memory' | 'profile' | 'routing' | 'skill' | 'tool' | 'repair'
  kind: 'declarative' | 'executable'
  sourceTurnIds: string[]
  baselineVersion?: string
  candidateVersion: string
  state: 'draft' | 'evaluating' | 'ready' | 'active' | 'rejected' | 'rolled_back'
  summary: string
  payload: Record<string, unknown>
  metrics?: {
    evidence: number
    successRate: number
    regressionRate: number
    toolHitRate: number
    correctionRate: number
  }
  createdAt: number
  updatedAt: number
}

export interface AgentEvolutionLogEntry {
  id: string
  candidateId: string
  action: 'improved' | 'rolled_back' | 'failed'
  target: AgentEvolutionCandidate['target']
  summary: string
  change: string
  candidateVersion: string
  sourceTurnIds: string[]
  actorId: string
  detail: Record<string, unknown>
  createdAt: number
}

const base = '/api/v1/agent'

export const agentRequest = {
  status: () => request.serverGet<AgentStatus>(`${base}/status`),
  config: () =>
    request.serverGet<{
      config: AgentConfig
      apiKeyConfigured: boolean
    }>(`${base}/config`),
  saveConfig: (config: AgentConfig) => request.serverPost(`${base}/config`, config),
  providerPresets: () =>
    request.serverGet<Array<{ kind: AgentProviderKind; name: string; baseUrl: string }>>(
      `${base}/providers/presets`
    ),
  providerModels: (id: string) =>
    request.serverPost<string[], Record<string, never>>(
      `${base}/providers/${encodeURIComponent(id)}/models`,
      {}
    ),
  testProvider: (id: string) =>
    request.serverPost<AgentProviderProbe, Record<string, never>>(
      `${base}/providers/${encodeURIComponent(id)}/test`,
      {}
    ),
  tools: () => request.serverGet<Array<Record<string, unknown>>>(`${base}/tools`),
  generatedTools: () =>
    request.serverGet<Array<Record<string, unknown>>>(`${base}/generated-tools`),
  generatedToolVersions: (id: string) =>
    request.serverGet<Array<Record<string, unknown>>>(
      `${base}/generated-tools/${encodeURIComponent(id)}/versions`
    ),
  generatedToolValidation: (id: string) =>
    request.serverGet<Record<string, unknown>>(
      `${base}/generated-tools/${encodeURIComponent(id)}/validation`
    ),
  threads: (options: {
    state?: 'active' | 'archived' | 'all'
    query?: string
    cursor?: number
    limit?: number
    channel?: string
    rootOnly?: boolean
  } = {}) => {
    const query = new URLSearchParams()
    if (options.state) query.set('state', options.state)
    if (options.query) query.set('query', options.query)
    if (options.cursor) query.set('cursor', String(options.cursor))
    if (options.limit) query.set('limit', String(options.limit))
    if (options.channel) query.set('channel', options.channel)
    if (options.rootOnly) query.set('rootOnly', 'true')
    const suffix = query.size ? `?${query}` : ''
    return request.serverGet<AgentThread[]>(`${base}/threads${suffix}`)
  },
  threadChannels: () =>
    request.serverGet<AgentThreadChannel[]>(`${base}/threads/channels`),
  threadTree: (threadId: string) =>
    request.serverGet<{ root: AgentThread, children: AgentThread[] }>(
      `${base}/threads/${threadId}/tree`
    ),
  createThread: (threadKey: string) =>
    request.serverPost<AgentThread, { threadKey: string }>(`${base}/threads`, { threadKey }),
  messages: (threadId: string, before?: number) =>
    request.serverGet<AgentMessage[]>(
      `${base}/threads/${threadId}/messages${before ? `?before=${before}` : ''}`
    ),
  tasksForThread: (threadId: string, history = false) =>
    request.serverGet<AgentTaskList | AgentTaskList[] | null>(
      `${base}/threads/${threadId}/tasks${history ? '?history=true' : ''}`
    ),
  updateThread: (threadId: string, input: { title?: string; archived?: boolean }) =>
    request.patch(`${base}/threads/${threadId}`, input).then(response => response.data.data as AgentThread),
  threadModel: (threadId: string) =>
    request.serverGet<AgentThreadModel>(`${base}/threads/${threadId}/model`),
  setThreadModel: (
    threadId: string,
    providerId: string | null,
    model: string | null
  ) =>
    request.patch(`${base}/threads/${threadId}/model`, { providerId, model })
      .then(response => response.data.data as AgentThread),
  deleteThread: (threadId: string) =>
    request.delete(`${base}/threads/${threadId}`).then(response => response.data.data as {
      deleted: boolean
    }),
  toolCalls: (threadId: string) =>
    request.serverGet<AgentToolCallView[]>(`${base}/threads/${threadId}/tool-calls`),
  activity: (threadId: string) =>
    request.serverGet<AgentActivityView[]>(`${base}/threads/${threadId}/activity`),
  deliveries: (threadId: string) =>
    request.serverGet<AgentDeliveryOperation[]>(`${base}/threads/${threadId}/deliveries`),
  toolArtifact: (id: string) =>
    request.serverGet<Record<string, unknown>>(`${base}/tool-artifacts/${id}`),
  startTurn: (threadId: string, content: string, idempotencyKey = crypto.randomUUID()) =>
    request.serverPost<
      {
        accepted: boolean
        requestId: string
        runId: string
        threadId: string
        mode: 'started' | 'supplemented'
        interrupted?: {
          threadId: string
          turnId: string
          elapsedMs: number
          round: number
          maxRounds: number
          operation: string
        }
      },
      { content: string; idempotencyKey: string }
    >(`${base}/threads/${threadId}/turns`, { content, idempotencyKey }),
  chat: (threadKey: string, content: string) =>
    request.serverPost<
      { threadId: string; turnId: string; state: string; content: string },
      { threadKey: string; content: string }
    >(`${base}/chat`, { threadKey, content }, { timeout: 120000 }),
  interrupt: (threadId: string) => request.serverPost(`${base}/threads/${threadId}/interrupt`),
  stop: (threadId: string) =>
    request.serverPost<{
      interrupted: boolean
      turns: number
      subagents: number
      approvals: number
    }, Record<string, never>>(`${base}/threads/${threadId}/stop`, {}),
  events: (threadId: string, after = 0) =>
    eventSourcePolyfill(`${base}/threads/${threadId}/events?after=${after}`),
  approvals: () => request.serverGet<AgentApproval[]>(`${base}/approvals`),
  resolveApproval: (
    id: string,
    decision: 'approved' | 'denied',
    scope: 'once' | 'thread' | 'delegate' = 'once'
  ) =>
    request.serverPost(
      `${base}/approvals/${id}/resolve`,
      { decision, scope },
      { timeout: 120000 }
    ),
  threadGrants: (threadId: string) =>
    request.serverGet<Array<Record<string, unknown>>>(`${base}/threads/${threadId}/grants`),
  revokeThreadGrant: (threadId: string, grantId: string) =>
    request.delete(`${base}/threads/${threadId}/grants/${grantId}`),
  feedback: (
    threadId: string,
    input: { turnId?: string; rating?: -1 | 0 | 1; correction?: string }
  ) => request.serverPost(`${base}/threads/${threadId}/feedback`, input),
  memories: () => request.serverGet<AgentMemory[]>(`${base}/memories`),
  createMemory: (input: { scope: string; scopeKey: string; content: string }) =>
    request.serverPost(`${base}/memories`, input),
  setMemoryState: (id: string, enabled: boolean) =>
    request.serverPost(`${base}/memories/${id}/state`, { enabled }),
  deleteMemory: (id: string) => request.serverPost(`${base}/memories/${id}/delete`),
  skills: () => request.serverGet<AgentSkill[]>(`${base}/skills`),
  createSkill: (input: {
    name: string
    description: string
    instructions: string
    tools: string[]
    scriptTools: AgentScriptToolDefinition[]
  }) => request.serverPost(`${base}/skills`, input),
  updateSkill: (id: string, input: {
    name: string
    description: string
    instructions: string
    tools: string[]
    scriptTools: AgentScriptToolDefinition[]
  }) => request.serverPost(`${base}/skills/${id}/versions`, input),
  deleteSkill: (id: string, confirmName: string) =>
    request.delete(`${base}/skills/${id}`, { data: { confirmName } })
      .then(response => response.data.data as {
        deleted: boolean
        name: string
        versions: number
        snapshots: number
        jobsUpdated: number
        candidatesUpdated: number
      }),
  skillVersions: (id: string) =>
    request.serverGet<AgentSkillVersion[]>(`${base}/skills/${id}/versions`),
  skillUsage: (id: string) =>
    request.serverGet<Record<string, unknown> | null>(`${base}/skills/${id}/usage`),
  setSkillState: (id: string, enabled: boolean) =>
    request.serverPost(`${base}/skills/${id}/state`, { enabled }),
  rollbackSkill: (id: string, versionId: string) =>
    request.serverPost(`${base}/skills/${id}/rollback`, { versionId }),
  jobs: () => request.serverGet<AgentJob[]>(`${base}/jobs`),
  jobRuns: (jobId?: string) =>
    request.serverGet<Array<Record<string, unknown>>>(
      `${base}/jobs/runs${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ''}`
    ),
  saveJob: (job: Partial<AgentJob>) => request.serverPost(`${base}/jobs`, job),
  setJobState: (id: string, enabled: boolean) =>
    request.serverPost(`${base}/jobs/${id}/state`, { enabled }),
  runJob: (id: string) => request.serverPost(`${base}/jobs/${id}/run`),
  deleteJob: (id: string) => request.serverPost(`${base}/jobs/${id}/delete`),
  mcp: () => request.serverGet<Array<Record<string, unknown>>>(`${base}/mcp`),
  reloadMcp: () =>
    request.serverPost<Array<Record<string, unknown>>, Record<string, never>>(
      `${base}/mcp/reload`,
      {}
    ),
  audit: () => request.serverGet<Array<Record<string, unknown>>>(`${base}/audit`),
  usage: () => request.serverGet<Array<Record<string, unknown>>>(`${base}/usage`),
  evolutionLogs: (limit = 200) =>
    request.serverGet<AgentEvolutionLogEntry[]>(`${base}/evolution/logs?limit=${limit}`),
  deleteEvolutionLog: (id: string) =>
    request.serverPost<{ deleted: boolean }, { confirm: true }>(
      `${base}/evolution/logs/${encodeURIComponent(id)}/delete`,
      { confirm: true }
    ),
  clearEvolutionLogs: () =>
    request.serverPost<{ deleted: number }, { confirm: true }>(
      `${base}/evolution/logs/clear`,
      { confirm: true }
    ),
  evolutionOverview: () =>
    request.serverGet<{
      candidates: Record<string, number>
      outcomes: Record<string, number>
      feedback: { total: number; corrected: number }
      retrieval: { total: number; selected: number }
    }>(`${base}/evolution/overview`),
  evolutionCandidates: (state?: AgentEvolutionCandidate['state']) =>
    request.serverGet<AgentEvolutionCandidate[]>(
      `${base}/evolution/candidates${state ? `?state=${state}` : ''}`
    ),
  evolutionAction: (
    id: string,
    action: 'evaluate' | 'promote' | 'reject' | 'rollback',
    reason?: string
  ) => request.serverPost<AgentEvolutionCandidate, { reason?: string }>(
    `${base}/evolution/candidates/${id}/${action}`,
    reason ? { reason } : {}
  ),
  evolutionArtifact: (id: string) =>
    request.serverGet<{
      candidate: AgentEvolutionCandidate
      patch: string
    }>(`${base}/evolution/candidates/${id}/artifact`),
  applyRepair: (id: string, restartCore = true) =>
    request.serverPost<AgentEvolutionCandidate, { restartCore: boolean }>(
      `${base}/evolution/candidates/${id}/apply`,
      { restartCore }
    ),
  rollbackRepair: (id: string, restartCore = true) =>
    request.serverPost<AgentEvolutionCandidate, { restartCore: boolean }>(
      `${base}/evolution/candidates/${id}/repair-rollback`,
      { restartCore }
    ),
  search: (query: string) =>
    request.serverGet<Array<Record<string, unknown>>>(
      `${base}/search?q=${encodeURIComponent(query)}`
    ),
}
