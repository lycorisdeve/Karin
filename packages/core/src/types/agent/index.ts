import type { Permission } from '../event'
import type { Message } from '../event/event'

export type AgentToolRisk = 'read' | 'write' | 'external' | 'destructive'
export type AgentPolicyDecision = 'allow' | 'ask' | 'deny'
export type AgentThreadState =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'interrupted'

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface AgentModelMessage {
  role: AgentMessageRole
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: AgentToolCall[]
}

export interface AgentModelTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface AgentModelRequest {
  model: string
  messages: AgentModelMessage[]
  tools: AgentModelTool[]
  toolChoice?: 'auto' | 'required'
  signal?: AbortSignal
}

export interface AgentModelResponse {
  content: string
  toolCalls: AgentToolCall[]
  provider?: string
  model?: string
  retries?: number
  fallbackFrom?: string[]
  retryReasons?: string[]
  latencyMs?: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export interface AgentModelProvider {
  readonly name: string
  complete(
    request: AgentModelRequest,
    onDelta?: (delta: string) => void | Promise<void>,
  ): Promise<AgentModelResponse>
}

export interface AgentActor {
  id: string
  role: Permission
  selfId: string
  scene: string
  contactKey: string
}

export interface AgentToolContext {
  threadId: string
  turnId: string
  actor: AgentActor
  signal: AbortSignal
  event?: Message
  automated: boolean
  parentThreadId?: string
  depth?: number
  allowedTools?: string[]
}

export interface AgentToolOptions<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown
> {
  name: string
  description: string
  /** 可在 WebUI 和模型上下文中统一启停的工具组。 */
  toolset?: string
  /** 用于能力检索的简短标签。 */
  tags?: string[]
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  permission?: Permission
  risk?: AgentToolRisk
  timeout?: number
  idempotent?: boolean
  execute: (input: TInput, context: AgentToolContext) => TOutput | Promise<TOutput>
}

export interface AgentPolicyRule {
  pattern: string
  decision: AgentPolicyDecision
}

export type AgentProviderKind = 'openai' | 'deepseek' | 'kimi' | 'mimo' | 'custom'

export interface AgentProviderProfile {
  id: string
  name: string
  kind: AgentProviderKind
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  verification?: {
    testedAt: number
    chat: boolean
    stream: boolean
    tools: boolean
    latency: number
    fingerprint: string
  }
}

export interface AgentMcpServerConfig {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
}

export interface AgentConfig {
  version: 3
  enabled: boolean
  providers: AgentProviderProfile[]
  routing: {
    primary: string
    fallback: string[]
  }
  trigger: {
    private: boolean
    groupMention: boolean
    wakeWords: string[]
  }
  limits: {
    maxToolRounds: number
    maxToolOutputBytes: number
    maxRecentMessages: number
    maxSubagents: number
  }
  policy: {
    approvalTtlMs: number
    hardDeny: string[]
    rules: AgentPolicyRule[]
    defaults: Record<AgentToolRisk, AgentPolicyDecision>
  }
  learning: {
    memory: boolean
    skills: boolean
  }
  tools: {
    disabled: string[]
    disabledToolsets: string[]
  }
  mcp: {
    enabled: boolean
    servers: AgentMcpServerConfig[]
  }
}

export interface AgentTurnInput {
  threadKey: string
  actor: AgentActor
  content: string
  event?: Message
  parentThreadId?: string
  depth?: number
  automated?: boolean
  allowedTools?: string[]
  onDelta?: (delta: string) => void | Promise<void>
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>
}

export interface AgentTurnResult {
  threadId: string
  turnId: string
  state: AgentThreadState
  content: string
  approvalId?: string
}

export interface AgentStreamEvent {
  id: number
  threadId: string
  turnId?: string
  type:
    | 'turn.started'
    | 'text.delta'
    | 'tool.started'
    | 'tool.completed'
    | 'approval.requested'
    | 'approval.resolved'
    | 'subagent.started'
    | 'subagent.completed'
    | 'turn.completed'
    | 'turn.failed'
  data: unknown
  createdAt: number
}
