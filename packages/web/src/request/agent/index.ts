import { eventSourcePolyfill, request } from '@/lib/request'

export interface AgentStatus {
  state: 'disabled' | 'ready' | 'failed'
  reason?: string
  enabled: boolean
  configured: boolean
  apiKeyConfigured: boolean
  ftsAvailable: boolean
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
  timeout: number
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
  version: 3
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
  policy: {
    approvalTtlMs: number
    hardDeny: string[]
    rules: Array<{ pattern: string; decision: string }>
    defaults: Record<'read' | 'write' | 'external' | 'destructive', string>
  }
  learning: { memory: boolean; skills: boolean }
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
  createdAt: number
  updatedAt: number
}

export interface AgentMessage {
  id: string
  turnId?: string | null
  role: 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  createdAt: number
}

export interface AgentToolCallView {
  id: string
  threadId: string
  turnId: string
  name: string
  source: string
  toolset: string
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
  actorId: string
  toolName: string
  input: Record<string, unknown>
  status: string
  expiresAt: number
  createdAt: number
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
  threads: (options: {
    state?: 'active' | 'archived' | 'all'
    query?: string
    cursor?: number
    limit?: number
  } = {}) => {
    const query = new URLSearchParams()
    if (options.state) query.set('state', options.state)
    if (options.query) query.set('query', options.query)
    if (options.cursor) query.set('cursor', String(options.cursor))
    if (options.limit) query.set('limit', String(options.limit))
    const suffix = query.size ? `?${query}` : ''
    return request.serverGet<AgentThread[]>(`${base}/threads${suffix}`)
  },
  createThread: (threadKey: string) =>
    request.serverPost<AgentThread, { threadKey: string }>(`${base}/threads`, { threadKey }),
  messages: (threadId: string, before?: number) =>
    request.serverGet<AgentMessage[]>(
      `${base}/threads/${threadId}/messages${before ? `?before=${before}` : ''}`
    ),
  updateThread: (threadId: string, input: { title?: string; archived?: boolean }) =>
    request.patch(`${base}/threads/${threadId}`, input).then(response => response.data.data as AgentThread),
  deleteThread: (threadId: string) =>
    request.delete(`${base}/threads/${threadId}`).then(response => response.data.data as {
      deleted: boolean
    }),
  toolCalls: (threadId: string) =>
    request.serverGet<AgentToolCallView[]>(`${base}/threads/${threadId}/tool-calls`),
  startTurn: (threadId: string, content: string) =>
    request.serverPost<
      { accepted: boolean; requestId: string; threadId: string },
      { content: string }
    >(`${base}/threads/${threadId}/turns`, { content }),
  chat: (threadKey: string, content: string) =>
    request.serverPost<
      { threadId: string; turnId: string; state: string; content: string },
      { threadKey: string; content: string }
    >(`${base}/chat`, { threadKey, content }, { timeout: 120000 }),
  interrupt: (threadId: string) => request.serverPost(`${base}/threads/${threadId}/interrupt`),
  events: (threadId: string, after = 0) =>
    eventSourcePolyfill(`${base}/threads/${threadId}/events?after=${after}`),
  approvals: () => request.serverGet<AgentApproval[]>(`${base}/approvals`),
  resolveApproval: (id: string, decision: 'approved' | 'denied') =>
    request.serverPost(`${base}/approvals/${id}/resolve`, { decision }, { timeout: 120000 }),
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
  }) => request.serverPost(`${base}/skills`, input),
  skillVersions: (id: string) =>
    request.serverGet<Array<Record<string, unknown>>>(`${base}/skills/${id}/versions`),
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
  search: (query: string) =>
    request.serverGet<Array<Record<string, unknown>>>(
      `${base}/search?q=${encodeURIComponent(query)}`
    ),
}
