import type { Permission } from '../event'
import type { Message } from '../event/event'

export type AgentToolRisk = 'read' | 'write' | 'external' | 'destructive'
export type AgentPolicyDecision = 'allow' | 'ask' | 'deny'
export type AgentTaskItemStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type AgentTaskListState = 'active' | 'completed' | 'cancelled'
export type AgentThreadState =
  | 'idle'
  | 'stopping'
  | 'running'
  | 'recovery_pending'
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

export interface AgentModelTextPart {
  type: 'text'
  text: string
}

export interface AgentModelImagePart {
  type: 'image'
  imageUrl: string
}

export interface AgentMessageAttachment {
  id: string
  messageId: string
  type: 'image'
  mime: string
  size: number
  name: string
  url: string
  createdAt: number
}

export interface AgentMessageAttachmentInput {
  type: 'image'
  storagePath: string
  mime: string
  size: number
  name: string
}

export type AgentModelContent = string | Array<AgentModelTextPart | AgentModelImagePart>

export interface AgentModelMessage {
  role: AgentMessageRole
  content: AgentModelContent
  name?: string
  toolCallId?: string
  toolCalls?: AgentToolCall[]
  /** Core 内部稳定上下文标识；Provider 序列化时忽略。 */
  contextId?: string
  /** 禁止上下文压缩移除的恢复、审批或任务状态。 */
  protected?: boolean
}

export interface AgentModelTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface AgentModelRequest {
  providerId?: string
  model: string
  messages: AgentModelMessage[]
  tools: AgentModelTool[]
  toolChoice?: 'auto' | 'required'
  responseSchema?: {
    name: string
    schema: Record<string, unknown>
    strict?: boolean
  }
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

export interface ContextCheckpointV1 {
  version: 1
  goal: string
  constraints: string[]
  decisions: string[]
  evidence: string[]
  completedActions: Array<{ action: string; receipt: string }>
  pendingTasks: string[]
  artifacts: string[]
  failures: string[]
  unresolvedQuestions: string[]
  legacySummary: string
}

export interface AgentModelProvider {
  readonly name: string
  readonly capabilities?: AgentProviderCapabilities
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
  origin?: AgentConversationOrigin
}

export interface AgentConversationOrigin {
  channel: string
  protocol: string
  accountId: string
  accountName: string
  contactKey: string
  contactId: string
  contactSubId: string
  contactName: string
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
  /** 当前模型调用实际暴露的 Tool 名称。 */
  callableTools?: string[]
  /** 由本地执行器回填实际沙箱结果，供 Receipt 审计。 */
  sandbox?: AgentSandboxExecution
  /** Core 内部共享追踪对象，跨 Tool context 克隆传递实际执行结果。 */
  sandboxTrace?: { execution?: AgentSandboxExecution }
}

export type AgentSandboxNetwork = 'deny' | 'inherit'
export type AgentSandboxBackend = 'none' | 'bwrap' | 'seatbelt' | 'windows'

export interface AgentSandboxRequest {
  readRoots?: string[]
  writeRoots?: string[]
  network?: AgentSandboxNetwork
}

export interface AgentSandboxExecution {
  backend: AgentSandboxBackend
  mode: 'hard' | 'fallback' | 'off'
  network: AgentSandboxNetwork
  hardIsolation: boolean
  reason?: string
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
  /** 可根据已校验输入把风险向上提升；不能把基础风险降级。 */
  riskResolver?: (input: TInput) => AgentToolRisk
  timeout?: number
  idempotent?: boolean
  /**
   * 表示写入可通过版本或事务完整恢复。该声明只用于展示；是否自动审批还取决于
   * Tool 来源，插件和 MCP Tool 不能仅凭此字段获得信任。
   */
  reversible?: boolean
  /** Tool 当前是否可用；异常按不可用处理。 */
  availability?: () => boolean
  /** 用于管理界面解释 Tool 不可用原因的运行要求。 */
  requirements?: string[]
  /** 能力归属，仅用于策略解释和审计，不能自行提升信任。 */
  owner?: string
  /** Tool 输入输出可能包含的数据敏感级别。 */
  sensitivity?: 'public' | 'private' | 'credential'
  /** Core 重启后是否允许在幂等前提下自动重放。 */
  restartSafe?: boolean
  /** 仅由 Core 注册器或 karin.processTool 设置；普通插件声明不会提升隔离等级。 */
  isolation?: AgentToolIsolation
  execute: (input: TInput, context: AgentToolContext) => TOutput | Promise<TOutput>
}

export interface AgentProcessToolOptions<
  TInput extends Record<string, unknown> = Record<string, unknown>
> extends Omit<AgentToolOptions<TInput, unknown>, 'execute' | 'isolation'> {
  process: {
    command: string
    args?: string[]
    cwd?: string
    envAllowlist?: string[]
    sandbox?: AgentSandboxRequest
  }
}

export interface AgentTaskItem {
  id: string
  content: string
  status: AgentTaskItemStatus
  order: number
  createdAt: number
  updatedAt: number
}

export interface AgentTaskList {
  id: string
  threadId: string
  sourceTurnId: string
  goal: string
  state: AgentTaskListState
  items: AgentTaskItem[]
  createdAt: number
  updatedAt: number
}

export type AgentCapabilityKind = 'tool' | 'skill'
export type AgentCapabilitySource =
  | 'core'
  | 'generated-sandbox'
  | 'plugin'
  | 'mcp'
  | 'skill-library'

export interface AgentCapabilityDescriptor {
  name: string
  kind: AgentCapabilityKind
  description: string
  source: AgentCapabilitySource
  toolset?: string
  tags: string[]
  version?: string
  risk?: AgentToolRisk
  reversible?: boolean
  /** 能力是否存在于全局注册表。 */
  registered: boolean
  available: boolean
  /** Tool 是否实际暴露给当前模型调用；Skill 不设置此字段。 */
  callable?: boolean
  requirements: string[]
  owner?: string
  sensitivity?: 'public' | 'private' | 'credential'
  restartSafe?: boolean
  unavailableReason?: string
  isolation?: AgentToolIsolation
}

export type AgentToolIsolation =
  | 'core-inline'
  | 'legacy-inline'
  | 'process-isolated'
  | 'generated-sandbox'
  | 'mcp-remote'
  | 'mcp-stdio'

export interface AgentPolicyRule {
  pattern: string
  decision: AgentPolicyDecision
}

export type AgentProviderKind = 'openai' | 'deepseek' | 'kimi' | 'mimo' | 'custom'
export type AgentProviderProtocol = 'chat-completions' | 'responses'

export interface AgentProviderCapabilities {
  protocol: AgentProviderProtocol
  stream: boolean
  tools: boolean
  structuredOutput: boolean
  vision: boolean
}

export interface AgentProviderProfile {
  id: string
  name: string
  kind: AgentProviderKind
  protocol: AgentProviderProtocol
  enabled: boolean
  baseUrl: string
  apiKey: string
  discoveredModels?: string[]
  modelsDiscoveredAt?: number
  /** 留空表示按 OpenAI 兼容协议尝试；非空时只向列出的模型发送视觉输入 */
  visionModels?: string[]
  model: string
  timeout: number
  /** 模型上下文窗口；未知时使用 Agent context.defaultWindowTokens。 */
  contextWindowTokens?: number
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
  sandbox?: AgentSandboxRequest
}

export type AgentEvolutionTarget =
  | 'memory'
  | 'profile'
  | 'routing'
  | 'skill'
  | 'tool'
  | 'repair'
export type AgentEvolutionState =
  | 'draft'
  | 'evaluating'
  | 'ready'
  | 'active'
  | 'rejected'
  | 'rolled_back'

export interface AgentEvolutionMetrics {
  evidence: number
  successRate: number
  regressionRate: number
  toolHitRate: number
  correctionRate: number
}

export interface AgentEvolutionCandidate {
  id: string
  target: AgentEvolutionTarget
  kind: 'declarative' | 'executable'
  sourceTurnIds: string[]
  baselineVersion?: string
  candidateVersion: string
  state: AgentEvolutionState
  summary: string
  payload: Record<string, unknown>
  metrics?: AgentEvolutionMetrics
  createdAt: number
  updatedAt: number
}

export interface AgentEvolutionLogEntry {
  id: string
  candidateId: string
  action: 'improved' | 'rolled_back' | 'failed'
  target: AgentEvolutionTarget
  summary: string
  change: string
  candidateVersion: string
  sourceTurnIds: string[]
  actorId: string
  detail: Record<string, unknown>
  createdAt: number
}

export type AgentTurnPhase =
  | 'observe'
  | 'plan'
  | 'act'
  | 'verify'
  | 'recover'
  | 'finish'
  | 'waiting_approval'

export interface AgentPostcondition {
  id: string
  kind: 'delivery' | 'media' | 'tool' | 'information'
  description: string
  toolNames: string[]
  required: boolean
  minimumCount?: number
}

export interface AgentTaskGoal {
  id: string
  description: string
  capabilities: string[]
  postconditions: AgentPostcondition[]
}

export interface AgentTaskPlan {
  version: 1
  summary: string
  goals: AgentTaskGoal[]
  research: 'local-first' | 'web-required' | 'none'
  allowedSideEffects: AgentToolRisk[]
  stopCondition: string
  createdBy: 'model' | 'fallback'
}

export type AgentFailureClassification =
  | 'missing_tool'
  | 'tool_failed'
  | 'postcondition_failed'
  | 'delivery_failed'
  | 'provider_failed'
  | 'approval_required'
  | 'interrupted'

export interface AgentToolReceipt {
  toolName: string
  status: 'completed' | 'failed'
  startedAt: number
  completedAt: number
  idempotent: boolean
  restartSafe?: boolean
  artifactId?: string
  /** 声明的 isolation 之外，本次执行实际采用的动态沙箱结果。 */
  sandbox?: AgentSandboxExecution
  delivery?: {
    completed: boolean
    channel?: string
    accountId?: string
    contactKey?: string
    textSegments: number
    imageSegments: number
  }
  media?: {
    path?: string
    url?: string
    mime?: string
    size?: number
  }
}

export interface AgentToolResultEnvelope<T = unknown> {
  status: 'completed' | 'failed'
  errorCode?: string
  data?: T
  error?: string
  inputHash?: string
  receipt: AgentToolReceipt
  evidence: string[]
}

export interface AgentRecoveryEvent {
  phase: AgentTurnPhase
  cycle: number
  classification?: AgentFailureClassification
  message: string
  completed?: boolean
  missingPostconditions?: string[]
  query?: string
  createdAt: number
}

export interface AgentRepairCandidatePayload {
  fingerprint: string
  problem: string
  reproduction: string
  evidence: string[]
  rootCause: string
  confidence: number
  workspaceRoot?: string
  affectedFiles: string[]
  patchHash?: string
  patchFile?: string
  semantics: {
    objective: string
    inputs: string
    outputs: string
    sideEffects: string[]
    idempotent: boolean
  }
  stopCondition: string
  failureStrategy: string
  verification: Array<{
    command: string
    status: 'pending' | 'passed' | 'failed'
    output?: string
  }>
  rollback: string
}

export interface AgentLearningConfig {
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

export interface AgentRecoveryConfig {
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

export interface AgentScriptSemantics {
  objective: string
  inputs: string
  outputs: string
  sideEffects: string[]
  idempotent: boolean
}

export interface AgentScriptStopPolicy {
  completionCondition: string
  timeoutMs: number
  maxOutputBytes: number
}

export interface AgentScriptFailurePolicy {
  strategy: 'fail' | 'retry'
  maxAttempts: number
  retryDelayMs: number
  userMessage: string
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
  semantics: AgentScriptSemantics
  stop: AgentScriptStopPolicy
  failure: AgentScriptFailurePolicy
}

export interface AgentGeneratedToolRecord {
  id: string
  name: string
  description: string
  enabled: boolean
  activeVersionId: string | null
  legacyAlias?: string
  createdAt: number
  updatedAt: number
}

export interface AgentGeneratedToolVersion {
  id: string
  toolId: string
  version: number
  definition: AgentScriptToolDefinition
  validationStatus: 'pending' | 'valid' | 'invalid'
  validationReport: string
  sourceTurnId: string
  createdAt: number
}

export interface AgentInstructionVersion {
  id: string
  version: number
  content: string
  contentHash: string
  source: 'default' | 'web' | 'file'
  createdBy: string
  createdAt: number
}

export interface AgentPersonaDefinition {
  identity: string
  expertise: string[]
  tone: string
  responseStyle: string
  language: string
}

export interface AgentPersonaRecord {
  id: string
  name: string
  description: string
  enabled: boolean
  isDefault: boolean
  activeVersionId: string
  definition: AgentPersonaDefinition
  version: number
  threadReferences: number
  jobReferences: number
  createdAt: number
  updatedAt: number
}

export interface AgentPersonaVersion {
  id: string
  personaId: string
  version: number
  definition: AgentPersonaDefinition
  createdBy: string
  createdAt: number
}

export interface AgentConfig {
  version: 11
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
  context: {
    defaultWindowTokens: number
    softLimitRatio: number
    hardLimitRatio: number
    protectedRecentMessages: number
    summaryTargetTokens: number
    semanticCompaction: boolean
    reservedOutputTokens: number
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
    hardDeny: string[]
    rules: AgentPolicyRule[]
    defaults: Record<AgentToolRisk, AgentPolicyDecision>
    autoApproveTrustedReversible: boolean
  }
  learning: AgentLearningConfig
  memory: {
    retrieval: {
      maxCandidates: number
      maxItems: number
      maxPromptTokens: number
      minScore: number
      recencyHalfLifeDays: number
    }
  }
  execution: {
    isolationMode: 'compat' | 'strict'
    minimumIsolation: 'none' | 'process' | 'os'
    hookTimeoutMs: number
    maxModelCalls: number
    maxTurnDurationMs: number
    sandbox: {
      mode: 'auto' | 'off'
      backend: 'auto' | Exclude<AgentSandboxBackend, 'none'>
      readRoots: string[]
      writeRoots: string[]
      networkDefault: 'deny'
    }
  }
  recovery: AgentRecoveryConfig
  tools: {
    disabled: string[]
    disabledToolsets: string[]
  }
  mcp: {
    enabled: boolean
    servers: AgentMcpServerConfig[]
  }
  scriptRuntime: {
    pythonExecutable: string
    defaultTimeoutMs: number
    maxTimeoutMs: number
    defaultMaxOutputBytes: number
    maxOutputBytes: number
  }
}

export interface AgentTurnInput {
  threadKey: string
  actor: AgentActor
  content: string
  event?: Message
  parentThreadId?: string
  instructionVersionId?: string
  personaVersionId?: string
  depth?: number
  automated?: boolean
  allowedTools?: string[]
  strictToolAllowlist?: boolean
  readOnlyTools?: boolean
  signal?: AbortSignal
  onDelta?: (delta: string) => void | Promise<void>
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>
  onResult?: (result: AgentTurnResult) => void | Promise<void>
  interactiveRequestId?: string
  /** 渠道消息 ID 或 Web 生成的幂等键。 */
  idempotencyKey?: string
  resume?: {
    fromTurnId: string
    rootContent: string
    supplements: string[]
    pendingMessages: string[]
    toolResults: AgentToolResultEnvelope[]
  }
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
  isolation?: AgentToolIsolation
  risk?: AgentToolRisk
  decision?: AgentPolicyDecision
  parentId?: string
  input?: unknown
  output?: unknown
  error?: string
  startedAt: number
  completedAt?: number
  durationMs?: number
}

export type AgentErrorCode =
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'USAGE_LIMIT_EXCEEDED'
  | 'HTTP_CONNECTION_FAILED'
  | 'RESPONSE_STREAM_CONNECTION_FAILED'
  | 'RESPONSE_STREAM_DISCONNECTED'
  | 'RESPONSE_TOO_MANY_FAILED_ATTEMPTS'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'MODEL_TIMEOUT'
  | 'RUNTIME_LIMIT_EXCEEDED'
  | 'INTERRUPTED'
  | 'OTHER'

export interface AgentErrorInfo {
  code: AgentErrorCode
  source: 'provider' | 'runtime'
  retryable: boolean
  httpStatusCode?: number
}

export interface AgentTurnResult {
  threadId: string
  turnId: string
  state: AgentThreadState
  content: string
  finalMessageId?: string
  approvalId?: string
  errorInfo?: AgentErrorInfo
}

export type AgentDeliveryState =
  | 'pending'
  | 'dispatching'
  | 'sent'
  | 'not_sent'
  | 'unknown_after_send'
  | 'failed'
  | 'cancelled'

export interface AgentDeliveryReceipt {
  operationId: string
  state: AgentDeliveryState
  channel: string
  adapterMessageId?: string
  retrySafe: boolean
  errorCode?: string
  error?: string
}

export interface AgentToolArtifact {
  id: string
  hash: string
  bytes: number
  preview: string
  createdAt: number
}

export interface AgentDelegateBatchTask {
  id: string
  label: string
  prompt: string
}

export interface AgentDelegateBatchResult {
  id: string
  label: string
  childThreadId?: string
  state: AgentThreadState
  content: string
  error?: string
}

export interface AgentStreamEvent {
  id: number
  threadId: string
  turnId?: string
  type:
    | 'turn.started'
    | 'turn.interrupting'
    | 'turn.resumed'
    | 'plan.created'
    | 'task.updated'
    | 'skill.loaded'
    | 'capability.missing'
    | 'verification.completed'
    | 'execution.budget'
    | 'context.compacted'
    | 'recovery.started'
    | 'recovery.completed'
    | 'repair.candidate'
    | 'text.delta'
    | 'tool.started'
    | 'tool.completed'
    | 'approval.requested'
    | 'approval.resolved'
    | 'subagent.started'
    | 'subagent.completed'
    | 'turn.completed'
    | 'turn.failed'
    | 'delivery.completed'
    | 'delivery.failed'
    | 'delivery.updated'
    | 'evolution.reviewed'
  data: unknown
  createdAt: number
}
