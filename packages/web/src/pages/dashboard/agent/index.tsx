import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import toast from 'react-hot-toast'
import Markdown from '@/components/Markdown'
import { request } from '@/lib/request'
import { shouldNotifyDelivery } from './event-notifications'
import {
  Bot,
  Brain,
  Check,
  Archive,
  ArchiveRestore,
  BookOpen,
  ChevronRight,
  CircleStop,
  Clock3,
  Copy,
  Database,
  Network,
  Menu,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  Pencil,
  RotateCcw,
  Trash2,
  ThumbsDown,
  ThumbsUp,
  MessageSquareWarning,
  X,
} from 'lucide-react'
import {
  agentRequest,
  type AgentApproval,
  type AgentActivityView,
  type AgentConfig,
  type AgentDeliveryOperation,
  type AgentJob,
  type AgentInstructionVersion,
  type AgentMemory,
  type AgentPersona,
  type AgentMessage,
  type AgentSkill,
  type AgentScriptToolDefinition,
  type AgentSkillVersion,
  type AgentStatus,
  type AgentThread,
  type AgentThreadChannel,
  type AgentToolCallView,
  type AgentProviderKind,
  type AgentEvolutionLogEntry,
  type AgentTaskList,
} from '@/request/agent'
import {
  channelName,
  isRenderableChatMessage,
  readThreadSelections,
  restoredThreadRoot,
  threadName,
  writeThreadSelection,
} from './thread-selection'
import AgentCustomization from './customization'

type Page =
  | 'chat'
  | 'tasks'
  | 'skills'
  | 'memories'
  | 'evolution'
  | 'tools'
  | 'mcp'
  | 'approvals'
  | 'runs'
  | 'customization'
  | 'config'

const pages: Page[] = [
  'chat',
  'tasks',
  'skills',
  'memories',
  'evolution',
  'tools',
  'mcp',
  'approvals',
  'runs',
  'customization',
  'config',
]

const date = (value: number | null | undefined) => (value ? new Date(value).toLocaleString() : '—')
const elapsed = (startedAt: number, completedAt: number | undefined, now: number) => {
  const value = Math.max(0, (completedAt || now) - startedAt)
  if (value < 1000) return `${value}ms`
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`
}

const remaining = (expiresAt: number, now: number) => {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const recordLines = (value: Record<string, string> | undefined) =>
  Object.entries(value || {})
    .map(([key, item]) => `${key}=${item}`)
    .join('\n')
const linesRecord = (value: string) =>
  Object.fromEntries(
    value
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const index = line.indexOf('=')
        return index < 1 ? [line, ''] : [line.slice(0, index).trim(), line.slice(index + 1).trim()]
      })
  )
const mcpHeaderExample = ['Authorization=Bearer $', '{MCP_TOKEN}'].join('')
const mcpEnvExample = ['API_KEY=$', '{MCP_API_KEY}'].join('')
const environmentReference = ['$', '{ENV_NAME}'].join('')
const artifactIdFrom = (output: unknown) => {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ''
  const artifactId = (output as Record<string, unknown>).artifactId
  return typeof artifactId === 'string' ? artifactId : ''
}
const memoryScopeLabels: Record<string, string> = {
  all: '全部',
  user: '用户',
  group: '群组',
  global: '全局',
}

const MessageAttachment = ({
  attachment,
}: {
  attachment: NonNullable<AgentMessage['attachments']>[number]
}) => {
  const [source, setSource] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    request.get<Blob>(attachment.url, {
      responseType: 'blob',
      signal: controller.signal,
    }).then(response => {
      objectUrl = URL.createObjectURL(response.data)
      setSource(objectUrl)
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true)
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.url])

  if (failed) {
    return (
      <span className='block text-xs opacity-70'>
        图片“{attachment.name}”加载失败
      </span>
    )
  }
  if (!source) {
    return <span className='block text-xs opacity-70'>正在加载图片…</span>
  }
  return (
    <img
      src={source}
      alt={attachment.name || '会话图片'}
      className='max-h-80 max-w-full rounded-xl object-contain'
    />
  )
}
const skillInstructions = (content: string) =>
  content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
const skillTools = (value: string) => {
  try {
    const tools = JSON.parse(value)
    return Array.isArray(tools) ? tools.map(String) : []
  } catch {
    return []
  }
}
interface ScriptToolDraft {
  id: string
  name: string
  description: string
  source: string
  inputSchema: string
  outputSchema: string
  objective: string
  inputs: string
  outputs: string
  idempotent: boolean
  completionCondition: string
  timeoutMs: number
  maxOutputBytes: number
  strategy: 'fail' | 'retry'
  maxAttempts: number
  retryDelayMs: number
  userMessage: string
}

const emptyScriptTool = (): ScriptToolDraft => ({
  id: '',
  name: '',
  description: '',
  source: 'def run(payload):\n    return payload\n',
  inputSchema: '{\n  "type": "object",\n  "additionalProperties": false\n}',
  outputSchema: '',
  objective: '',
  inputs: '',
  outputs: '',
  idempotent: true,
  completionCondition: 'run(payload) 返回可序列化结果后结束',
  timeoutMs: 30000,
  maxOutputBytes: 65536,
  strategy: 'fail',
  maxAttempts: 1,
  retryDelayMs: 0,
  userMessage: '脚本执行失败',
})

const scriptToolDrafts = (value: string): ScriptToolDraft[] => {
  try {
    const items = JSON.parse(value) as AgentScriptToolDefinition[]
    if (!Array.isArray(items)) return []
    return items.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      source: item.source,
      inputSchema: JSON.stringify(item.inputSchema, null, 2),
      outputSchema: item.outputSchema ? JSON.stringify(item.outputSchema, null, 2) : '',
      objective: item.semantics.objective,
      inputs: item.semantics.inputs,
      outputs: item.semantics.outputs,
      idempotent: item.semantics.idempotent,
      completionCondition: item.stop.completionCondition,
      timeoutMs: item.stop.timeoutMs,
      maxOutputBytes: item.stop.maxOutputBytes,
      strategy: item.failure.strategy,
      maxAttempts: item.failure.maxAttempts,
      retryDelayMs: item.failure.retryDelayMs,
      userMessage: item.failure.userMessage,
    }))
  } catch {
    return []
  }
}

const compileScriptTools = (items: ScriptToolDraft[]): AgentScriptToolDefinition[] =>
  items.map(item => ({
    id: item.id.trim(),
    name: item.name.trim(),
    description: item.description.trim(),
    runtime: 'python',
    source: item.source,
    sourceHash: '',
    inputSchema: JSON.parse(item.inputSchema) as Record<string, unknown>,
    outputSchema: item.outputSchema.trim()
      ? JSON.parse(item.outputSchema) as Record<string, unknown>
      : undefined,
    semantics: {
      objective: item.objective.trim(),
      inputs: item.inputs.trim(),
      outputs: item.outputs.trim(),
      sideEffects: [],
      idempotent: item.idempotent,
    },
    stop: {
      completionCondition: item.completionCondition.trim(),
      timeoutMs: item.timeoutMs,
      maxOutputBytes: item.maxOutputBytes,
    },
    failure: {
      strategy: item.strategy,
      maxAttempts: item.strategy === 'retry' ? item.maxAttempts : 1,
      retryDelayMs: item.retryDelayMs,
      userMessage: item.userMessage.trim(),
    },
  }))

const scriptToolsComplete = (items: ScriptToolDraft[]) => items.every(item =>
  item.id.trim() &&
  item.name.trim() &&
  item.description.trim() &&
  item.source.trim() &&
  item.inputSchema.trim() &&
  item.objective.trim() &&
  item.inputs.trim() &&
  item.outputs.trim() &&
  item.completionCondition.trim() &&
  item.userMessage.trim()
)

const emptySkillDraft = () => ({
  name: '',
  description: '',
  instructions: '',
  tools: '',
  scriptTools: [] as ScriptToolDraft[],
})

const Panel = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <section
    className={`rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(9,20,25,0.04)] ${className}`}
  >
    {children}
  </section>
)

const Action = ({
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  children: React.ReactNode
  onClick: () => void | Promise<void>
  danger?: boolean
  disabled?: boolean
}) => (
  <button
    type='button'
    disabled={disabled}
    onClick={() => onClick()}
    className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
      danger
        ? 'bg-danger-50 text-danger hover:bg-danger-100'
        : 'bg-primary-50 text-primary-700 hover:bg-primary-100 dark:bg-primary-500/10 dark:text-primary-300'
    }`}
  >
    {children}
  </button>
)

const ToolCallCard = ({
  call,
  approval,
  now,
  onResolve,
}: {
  call: AgentToolCallView
  approval?: AgentApproval
  now: number
  onResolve: (
    approval: AgentApproval,
    decision: 'approved' | 'denied',
    scope?: 'once' | 'thread' | 'delegate',
  ) => void | Promise<void>
}) => (
  <details
    open={approval?.status === 'pending' ? true : undefined}
    className='w-full rounded-2xl border border-warning-200 bg-warning-50/70 p-3 text-left'
  >
    <summary className='cursor-pointer list-none'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          {call.status === 'running' || call.status === 'pending'
            ? (
              <LoaderCircle className='animate-spin text-warning' size={15} />
            )
            : (
              <Settings className='text-warning' size={15} />
            )}
          <span className='font-mono text-xs font-semibold'>{call.name}</span>
          <span className='rounded-full bg-warning-100 px-2 py-0.5 text-[11px]'>{call.status}</span>
          <span className='rounded-full bg-default-100 px-2 py-0.5 text-[11px]'>
            {call.risk} · {call.decision}
          </span>
        </div>
        <span className='text-[11px] text-default-400'>
          {call.source} ·{' '}
          {call.completedAt
            ? elapsed(call.createdAt, call.completedAt, now)
            : elapsed(call.createdAt, undefined, now)}
        </span>
      </div>
      {call.description && <p className='mt-1 text-xs text-default-500'>{call.description}</p>}
    </summary>
    {approval?.status === 'pending' && (
      <div className='mt-3 rounded-xl border border-warning-300 bg-content1 p-3'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div>
            <div className='text-sm font-semibold'>等待你的确认</div>
            <div className='text-xs text-default-500'>
              此操作将在 {remaining(approval.expiresAt, now)} 后过期
            </div>
          </div>
          <div className='flex gap-2'>
            <Action onClick={() => onResolve(approval, 'approved')}>
              <Check size={15} />
              本次同意
            </Action>
            <Action onClick={() => onResolve(approval, 'approved', 'thread')}>始终同意</Action>
            <Action onClick={() => onResolve(approval, 'approved', 'delegate')}>替我审批</Action>
            <Action danger onClick={() => onResolve(approval, 'denied')}>
              <X size={15} />
              拒绝
            </Action>
          </div>
        </div>
      </div>
    )}
    <div className='mt-3 grid gap-3 lg:grid-cols-2'>
      <div>
        <div className='mb-1 flex items-center justify-between text-xs font-semibold'>
          参数
          <button
            type='button'
            onClick={() => navigator.clipboard.writeText(JSON.stringify(call.input, null, 2))}
            className='text-primary'
          >
            复制
          </button>
        </div>
        <pre className='max-h-64 overflow-auto rounded-xl bg-content1 p-3 text-xs'>
          {JSON.stringify(call.input, null, 2)}
        </pre>
      </div>
      <div>
        <div className='mb-1 flex items-center justify-between text-xs font-semibold'>
          结果
          <div className='flex gap-2'>
            {artifactIdFrom(call.output) && (
              <button
                type='button'
                onClick={async () => {
                  const artifact = await agentRequest.toolArtifact(artifactIdFrom(call.output))
                  await navigator.clipboard.writeText(JSON.stringify(artifact.content, null, 2))
                  toast.success('完整 Artifact 已复制')
                }}
                className='text-primary'
              >
                完整 Artifact
              </button>
            )}
            <button
              type='button'
              onClick={() => navigator.clipboard.writeText(JSON.stringify(call.output, null, 2))}
              className='text-primary'
            >
              复制
            </button>
          </div>
        </div>
        <pre className='max-h-64 overflow-auto rounded-xl bg-content1 p-3 text-xs'>
          {call.error || JSON.stringify(call.output ?? null, null, 2)}
        </pre>
      </div>
    </div>
  </details>
)

const ActivityCard = ({ activity, now }: { activity: AgentActivityView; now: number }) => {
  const active = activity.status === 'running' || activity.status === 'waiting_approval'
  const label =
    activity.kind === 'turn'
      ? activity.label
      : activity.kind === 'subagent'
        ? `子 Agent · ${activity.label}`
        : activity.label
  return (
    <div className='signal-rail flex items-center gap-2 rounded-xl py-1.5 text-xs text-default-500'>
      {active
        ? (
          <LoaderCircle className='shrink-0 animate-spin text-primary' size={15} />
        )
        : (
          <Clock3 className='shrink-0' size={15} />
        )}
      <span className='min-w-0 truncate'>{label}</span>
      <span className='shrink-0 text-default-400'>
        {elapsed(activity.startedAt, activity.completedAt, now)}
      </span>
      {activity.error && <span className='truncate text-danger'>{activity.error}</span>}
    </div>
  )
}

const deliveryStateLabel: Record<AgentDeliveryOperation['state'], string> = {
  pending: '等待投递',
  dispatching: '投递中',
  sent: '平台已接受',
  not_sent: '未进入发送路径',
  unknown_after_send: '发送结果未知',
  failed: '投递失败',
  cancelled: '已取消',
}

const DeliveryCard = ({ delivery }: { delivery: AgentDeliveryOperation }) => (
  <div className='signal-rail flex items-center gap-2 rounded-xl py-1.5 text-xs text-default-500'>
    {delivery.state === 'dispatching' || delivery.state === 'pending'
      ? <LoaderCircle className='shrink-0 animate-spin text-primary' size={15} />
      : delivery.state === 'sent'
        ? <Check className='shrink-0 text-success' size={15} />
        : <MessageSquareWarning className='shrink-0 text-warning' size={15} />}
    <span className='min-w-0 truncate'>
      {delivery.channel} · {deliveryStateLabel[delivery.state]}
    </span>
    <span className='shrink-0 text-default-400'>尝试 {delivery.attempts} 次</span>
    {delivery.error && <span className='truncate text-danger'>{delivery.error}</span>}
  </div>
)

export default function AgentDashboard () {
  const location = useLocation()
  const routePage = location.pathname.split('/').filter(Boolean)[1] as Page | undefined
  const tab: Page = pages.includes(routePage as Page) ? routePage! : 'chat'
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [threads, setThreads] = useState<AgentThread[]>([])
  const [threadChannels, setThreadChannels] = useState<AgentThreadChannel[]>([])
  const [threadState, setThreadState] = useState<'active' | 'archived'>('active')
  const [selectedChannel, setSelectedChannel] = useState(
    () => readThreadSelections().active?.channel || 'web'
  )
  const [current, setCurrent] = useState<AgentThread | null>(null)
  const [threadTree, setThreadTree] = useState<AgentThread[]>([])
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [toolCalls, setToolCalls] = useState<AgentToolCallView[]>([])
  const [activities, setActivities] = useState<AgentActivityView[]>([])
  const [deliveries, setDeliveries] = useState<AgentDeliveryOperation[]>([])
  const [taskList, setTaskList] = useState<AgentTaskList | null>(null)
  const [notices, setNotices] = useState<
    Array<{
      id: string
      content: string
      createdAt: number
    }>
  >([])
  const [streaming, setStreaming] = useState('')
  const [streamStartedAt, setStreamStartedAt] = useState(0)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState('')
  const [recoveryStatus, setRecoveryStatus] = useState('')
  const [threadDrawerOpen, setThreadDrawerOpen] = useState(false)
  const [hasNewActivity, setHasNewActivity] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [approvals, setApprovals] = useState<AgentApproval[]>([])
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [personas, setPersonas] = useState<AgentPersona[]>([])
  const [currentCustomization, setCurrentCustomization] = useState<Awaited<ReturnType<typeof agentRequest.threadCustomization>> | null>(null)
  const [latestInstruction, setLatestInstruction] = useState<AgentInstructionVersion | null>(null)
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [jobs, setJobs] = useState<AgentJob[]>([])
  const [jobRuns, setJobRuns] = useState<Array<Record<string, unknown>>>([])
  const [mcp, setMcp] = useState<Array<Record<string, unknown>>>([])
  const [tools, setTools] = useState<Array<Record<string, unknown>>>([])
  const [generatedTools, setGeneratedTools] = useState<Array<Record<string, unknown>>>([])
  const [audit, setAudit] = useState<Array<Record<string, unknown>>>([])
  const [usage, setUsage] = useState<Array<Record<string, unknown>>>([])
  const [evolutionLogs, setEvolutionLogs] = useState<AgentEvolutionLogEntry[]>([])
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
  const [agentConfigJson, setAgentConfigJson] = useState('')
  const [agentConfigJsonDirty, setAgentConfigJsonDirty] = useState(false)
  const [agentConfigJsonError, setAgentConfigJsonError] = useState('')
  const [providerPresets, setProviderPresets] = useState<
    Array<{ kind: AgentProviderKind; name: string; baseUrl: string }>
  >([])
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({})
  const [providerBusy, setProviderBusy] = useState('')
  const [searchText, setSearchText] = useState('')
  const [searchResults, setSearchResults] = useState<Array<Record<string, unknown>>>([])
  const [jobDraft, setJobDraft] = useState({
    name: '',
    scheduleType: 'cron' as 'cron' | 'once',
    cron: '0 9 * * *',
    runAt: '',
    timezone: 'Asia/Shanghai',
    prompt: '',
    target: 'web',
    toolAllowlist: '',
    skillIds: '',
    personaId: '',
  })
  const [memoryDraft, setMemoryDraft] = useState({
    scope: 'user',
    scopeKey: 'web-admin',
    content: '',
    kind: 'fact' as AgentMemory['kind'],
    memoryKey: '',
    importance: 0.8,
    pinned: false,
  })
  const [skillDraft, setSkillDraft] = useState(emptySkillDraft)
  const [selectedJobId, setSelectedJobId] = useState('')
  const [editingJobId, setEditingJobId] = useState('')
  const [taskEditorOpen, setTaskEditorOpen] = useState(false)
  const [taskQuery, setTaskQuery] = useState('')
  const [selectedMemoryId, setSelectedMemoryId] = useState('')
  const [memoryEditorOpen, setMemoryEditorOpen] = useState(false)
  const [memoryQuery, setMemoryQuery] = useState('')
  const [memoryScope, setMemoryScope] = useState('all')
  const [selectedSkillId, setSelectedSkillId] = useState('')
  const [skillEditorOpen, setSkillEditorOpen] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [skillVersions, setSkillVersions] = useState<AgentSkillVersion[]>([])
  const [skillUsage, setSkillUsage] = useState<Record<string, unknown> | null>(null)
  const [editingSkillId, setEditingSkillId] = useState('')
  const [selectedMcpName, setSelectedMcpName] = useState('')
  const [mcpQuery, setMcpQuery] = useState('')
  const threadKey = useMemo(() => `web:${crypto.randomUUID()}`, [])
  const lastEventId = useRef<Record<string, number>>({})
  const messageViewportRef = useRef<HTMLDivElement>(null)
  const followOutputRef = useRef(true)
  const loadingOlderRef = useRef(false)
  const toolCallById = useMemo(() => new Map(toolCalls.map(call => [call.id, call])), [toolCalls])
  const approvalByToolCall = useMemo(
    () =>
      new Map(
        approvals
          .filter(item => item.threadId === current?.id)
          .map(item => [item.toolCallId, item])
      ),
    [approvals, current?.id]
  )

  const refresh = useCallback(async () => {
    const [
      nextStatus,
      nextThreadChannels,
      nextThreads,
      nextApprovals,
      nextMemories,
      nextPersonas,
      nextSkills,
      nextJobs,
      nextJobRuns,
      nextMcp,
      nextTools,
      nextAudit,
      nextUsage,
      nextEvolutionLogs,
      nextConfig,
    ] = await Promise.all([
      agentRequest.status(),
      agentRequest.threadChannels(),
      agentRequest.threads({
        state: threadState,
        channel: selectedChannel,
        rootOnly: true,
      }),
      agentRequest.approvals(),
      agentRequest.memories(),
      agentRequest.personas(),
      agentRequest.skills(),
      agentRequest.jobs(),
      agentRequest.jobRuns(),
      agentRequest.mcp(),
      agentRequest.tools(),
      agentRequest.audit(),
      agentRequest.usage(),
      agentRequest.evolutionLogs(),
      agentRequest.config(),
    ])
    setStatus(nextStatus)
    setThreadChannels(nextThreadChannels)
    setThreads(nextThreads)
    setApprovals(nextApprovals)
    setMemories(nextMemories)
    setPersonas(nextPersonas)
    setSkills(nextSkills)
    setJobs(nextJobs)
    setJobRuns(nextJobRuns)
    setMcp(nextMcp)
    setTools(nextTools)
    setAudit(nextAudit)
    setUsage(nextUsage)
    setEvolutionLogs(nextEvolutionLogs)
    setAgentConfig(nextConfig.config)
    setProviderModels(
      Object.fromEntries(
        nextConfig.config.providers.map(provider => [
          provider.id,
          provider.discoveredModels || [],
        ])
      )
    )
    setProviderPresets(await agentRequest.providerPresets())
  }, [selectedChannel, threadState])

  useEffect(() => {
    if (!current) {
      setCurrentCustomization(null)
      return
    }
    Promise.all([
      agentRequest.threadCustomization(current.id),
      agentRequest.instructions(),
    ]).then(([customization, instruction]) => {
      setCurrentCustomization(customization)
      setLatestInstruction(instruction.current)
    }).catch(() => setCurrentCustomization(null))
  }, [current?.id])

  useEffect(() => {
    refresh().catch(error => toast.error(error.message))
  }, [refresh])

  useEffect(() => {
    if (tab !== 'tools') return
    agentRequest.generatedTools()
      .then(setGeneratedTools)
      .catch(error => toast.error((error as Error).message))
  }, [tab])

  useEffect(() => {
    if (!agentConfig || agentConfigJsonDirty) return
    setAgentConfigJson(JSON.stringify(agentConfig, null, 2))
  }, [agentConfig, agentConfigJsonDirty])

  useEffect(() => {
    if (!threadChannels.length) return
    if (threadChannels.some(item => item.channel === selectedChannel)) return
    const saved = readThreadSelections()[threadState]?.channel
    const fallback = threadChannels.find(item => item.channel === saved)?.channel ||
      threadChannels.find(item =>
        threadState === 'active' ? item.activeCount > 0 : item.archivedCount > 0
      )?.channel ||
      'web'
    setSelectedChannel(fallback)
  }, [selectedChannel, threadChannels, threadState])

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      if (!threads.length) {
        setCurrent(null)
        setThreadTree([])
        return
      }
      const saved = readThreadSelections()[threadState]
      const root = restoredThreadRoot(threads, saved)
      if (!root) return
      const tree = await agentRequest.threadTree(root.id)
      if (cancelled) return
      const nextTree = [tree.root, ...tree.children]
      setThreadTree(nextTree)
      setCurrent(nextTree.find(item => item.id === saved?.threadId) || tree.root)
    }
    restore().catch(error => {
      if (!cancelled) setChatError((error as Error).message)
    })
    return () => {
      cancelled = true
    }
  }, [selectedChannel, threadState, threads])

  useEffect(() => {
    if (!current) return
    const rootId = current.parentThreadId ? threadTree[0]?.id : current.id
    writeThreadSelection(threadState, {
      channel: selectedChannel,
      threadId: current.id,
      rootId: rootId || current.id,
    })
  }, [current, selectedChannel, threadState, threadTree])

  useEffect(() => {
    if (!jobs.some(item => item.id === selectedJobId)) setSelectedJobId(jobs[0]?.id || '')
  }, [jobs, selectedJobId])

  useEffect(() => {
    if (!memories.some(item => item.id === selectedMemoryId)) {
      setSelectedMemoryId(memories[0]?.id || '')
    }
  }, [memories, selectedMemoryId])

  useEffect(() => {
    if (!skills.some(item => item.id === selectedSkillId)) {
      setSelectedSkillId(skills[0]?.id || '')
    }
  }, [skills, selectedSkillId])

  useEffect(() => {
    if (!selectedSkillId) {
      setSkillVersions([])
      setSkillUsage(null)
      return
    }
    Promise.all([
      agentRequest.skillVersions(selectedSkillId),
      agentRequest.skillUsage(selectedSkillId),
    ])
      .then(([versions, usageRecord]) => {
        setSkillVersions(versions)
        setSkillUsage(usageRecord)
      })
      .catch(error => toast.error((error as Error).message))
  }, [selectedSkillId])

  useEffect(() => {
    const servers = agentConfig?.mcp.servers || []
    if (!servers.some(item => item.name === selectedMcpName)) {
      setSelectedMcpName(servers[0]?.name || '')
    }
  }, [agentConfig?.mcp.servers, selectedMcpName])

  useEffect(() => {
    if (!current) {
      setMessages([])
      setToolCalls([])
      setActivities([])
      setDeliveries([])
      setTaskList(null)
      return
    }
    followOutputRef.current = true
    setHasNewActivity(false)
    Promise.all([
      agentRequest.messages(current.id),
      agentRequest.toolCalls(current.id),
      agentRequest.activity(current.id),
      agentRequest.deliveries(current.id),
      agentRequest.approvals(),
      agentRequest.tasksForThread(current.id),
    ])
      .then(([
        nextMessages,
        nextToolCalls,
        nextActivities,
        nextDeliveries,
        nextApprovals,
        nextTasks,
      ]) => {
        setMessages(nextMessages)
        setToolCalls(nextToolCalls)
        setActivities(nextActivities)
        setDeliveries(nextDeliveries)
        setApprovals(nextApprovals)
        setTaskList(Array.isArray(nextTasks) ? nextTasks[0] || null : nextTasks)
      })
      .catch(error => setChatError(error.message))
    const source = agentRequest.events(current.id, lastEventId.current[current.id] || 0)
    const listen = (
      type: string,
      callback: (payload: {
        id: number
        turnId?: string
        data: Record<string, unknown>
        createdAt: number
        replayed?: boolean
      }) => void
    ) => {
      ;(source as any).addEventListener(type, (event: { data: string; lastEventId?: string }) => {
        const payload = JSON.parse(event.data)
        const eventId = Number(event.lastEventId || payload.id || 0)
        if (eventId) lastEventId.current[current.id] = eventId
        callback(payload)
      })
    }
    const refreshActivity = () => {
      agentRequest.activity(current.id).then(setActivities)
      agentRequest.toolCalls(current.id).then(setToolCalls)
      agentRequest.deliveries(current.id).then(setDeliveries)
      agentRequest.approvals().then(setApprovals)
    }
    const refreshConversation = () => {
      agentRequest.messages(current.id).then(setMessages)
      refreshActivity()
      agentRequest.threads({
        state: threadState,
        channel: selectedChannel,
        rootOnly: true,
      }).then(setThreads)
    }
    let streamingBuffer = ''
    let streamingFrame = 0
    const clearStreamingBuffer = () => {
      streamingBuffer = ''
      if (streamingFrame) window.cancelAnimationFrame(streamingFrame)
      streamingFrame = 0
    }
    const appendStreaming = (delta: string) => {
      streamingBuffer += delta
      if (streamingFrame) return
      streamingFrame = window.requestAnimationFrame(() => {
        const buffered = streamingBuffer
        streamingBuffer = ''
        streamingFrame = 0
        if (buffered) setStreaming(value => value + buffered)
      })
    }
    listen('turn.started', () => {
      clearStreamingBuffer()
      setChatError('')
      setRecoveryStatus('')
      setSending(true)
      setStreaming('')
      setStreamStartedAt(0)
      refreshActivity()
    })
    listen('turn.interrupting', payload => {
      const elapsedMs = Number(payload.data.elapsedMs || 0)
      const round = Number(payload.data.round || 0)
      const maxRounds = Number(payload.data.maxRounds || 0)
      const operation = String(payload.data.operation || '模型思考')
      addNotice(
        `⚡ 正在中断并合并当前任务（已运行 ${
          elapsedMs < 60000
            ? `${Math.floor(elapsedMs / 1000)} 秒`
            : `${Math.floor(elapsedMs / 60000)} 分 ${
              Math.floor((elapsedMs % 60000) / 1000)
            } 秒`
        }，第 ${round}/${maxRounds} 轮，正在执行：${operation}）。`
      )
    })
    listen('turn.resumed', () => {
      setRecoveryStatus('已合并用户补充，正在继续执行')
      refreshActivity()
    })
    listen('text.delta', payload => {
      setStreamStartedAt(value => value || payload.createdAt || Date.now())
      appendStreaming(String(payload.data.delta || ''))
    })
    listen('turn.completed', () => {
      clearStreamingBuffer()
      setSending(false)
      setRecoveryStatus('')
      setStreaming('')
      setStreamStartedAt(0)
      refreshConversation()
    })
    listen('turn.failed', payload => {
      clearStreamingBuffer()
      setSending(false)
      setRecoveryStatus('')
      setStreaming('')
      setStreamStartedAt(0)
      setChatError(String(payload.data.error || payload.data.content || 'Agent 回合失败'))
      refreshConversation()
    })
    listen('approval.requested', () => {
      setSending(false)
      refreshActivity()
    })
    listen('approval.resolved', () => {
      setSending(true)
      refreshActivity()
    })
    listen('tool.started', refreshActivity)
    listen('tool.completed', refreshActivity)
    listen('task.updated', () => {
      agentRequest.tasksForThread(current.id).then(value => {
        setTaskList(Array.isArray(value) ? value[0] || null : value)
      })
    })
    listen('subagent.started', refreshActivity)
    listen('subagent.completed', refreshActivity)
    listen('plan.created', payload => {
      const plan = payload.data.plan as Record<string, unknown> | undefined
      const goals = Array.isArray(plan?.goals) ? plan.goals.length : 0
      setRecoveryStatus(goals ? `已生成可验证计划 · ${goals} 个目标` : '已生成可验证计划')
    })
    listen('verification.completed', payload => {
      const missing = Array.isArray(payload.data.missing) ? payload.data.missing : []
      setRecoveryStatus(
        missing.length
          ? `正在核验 · 仍缺少 ${missing.length} 项完成依据`
          : '完成条件已通过验证'
      )
    })
    listen('recovery.started', payload => {
      setRecoveryStatus(`正在诊断并恢复 · 第 ${Number(payload.data.cycle || 1)} 轮`)
      refreshActivity()
    })
    listen('recovery.completed', payload => {
      setRecoveryStatus(
        payload.data.completed ? '恢复完成，正在生成最终结果' : '恢复周期完成，正在重新规划'
      )
      refreshActivity()
    })
    listen('delivery.completed', payload => {
      agentRequest.deliveries(current.id).then(setDeliveries)
      if (current.channel !== 'web' && shouldNotifyDelivery(payload)) {
        toast.success(`回复已发送到 ${channelName(current.channel)}`)
      }
    })
    listen('delivery.failed', payload => {
      agentRequest.deliveries(current.id).then(setDeliveries)
      if (!shouldNotifyDelivery(payload)) return
      setChatError(
        `回复已保存在会话中，但发送到 ${channelName(current.channel)} 失败：${
          String(payload.data.error || '适配器未返回成功结果')
        }`
      )
    })
    return () => {
      clearStreamingBuffer()
      source.close()
    }
  }, [current, selectedChannel, threadState])

  useEffect(() => {
    const hasRunning =
      sending ||
      activities.some(item => item.status === 'running' || item.status === 'waiting_approval')
    if (!hasRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activities, sending])

  useEffect(() => {
    const viewport = messageViewportRef.current
    if (!viewport) return
    if (followOutputRef.current) {
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight
        setHasNewActivity(false)
      })
    } else {
      setHasNewActivity(true)
    }
  }, [messages, activities, streaming, notices])

  const openThreadRoot = async (root: AgentThread, preferredId = root.id) => {
    const tree = await agentRequest.threadTree(root.id)
    const nextTree = [tree.root, ...tree.children]
    setThreadTree(nextTree)
    setCurrent(nextTree.find(item => item.id === preferredId) || tree.root)
    setThreadDrawerOpen(false)
  }

  const selectThread = async (threadId: string) => {
    const root = threads.find(item => item.id === threadId)
    if (root) {
      await openThreadRoot(root)
      return
    }
    const child = threadTree.find(item => item.id === threadId)
    if (child) setCurrent(child)
  }

  const selectChannel = (channel: string) => {
    setSelectedChannel(channel)
    setThreads([])
    setCurrent(null)
    setThreadTree([])
    writeThreadSelection(threadState, { channel })
  }

  const ensureThread = async () => {
    if (current?.parentThreadId && threadTree[0]) return threadTree[0]
    if (current) return current
    const created = await agentRequest.createThread(threadKey)
    setSelectedChannel('web')
    setCurrent(created)
    setThreadTree([created])
    setThreads([created])
    return created
  }

  const addNotice = (content: string) => {
    setNotices(value => [...value, { id: crypto.randomUUID(), content, createdAt: Date.now() }])
  }

  const resolveApproval = async (
    approval: AgentApproval,
    decision: 'approved' | 'denied',
    scope: 'once' | 'thread' | 'delegate' = 'once'
  ) => {
    try {
      setSending(decision === 'approved')
      await agentRequest.resolveApproval(approval.id, decision, scope)
      const nextApprovals = await agentRequest.approvals()
      setApprovals(nextApprovals)
      if (current) {
        const [nextMessages, nextToolCalls, nextActivities] = await Promise.all([
          agentRequest.messages(current.id),
          agentRequest.toolCalls(current.id),
          agentRequest.activity(current.id),
        ])
        setMessages(nextMessages)
        setToolCalls(nextToolCalls)
        setActivities(nextActivities)
      }
    } catch (error) {
      setSending(false)
      toast.error((error as Error).message)
    }
  }

  const stopCurrent = async () => {
    const target = current?.parentThreadId ? threadTree[0] : current
    if (!target) {
      addNotice('当前没有可停止的会话。')
      return
    }
    try {
      const result = await agentRequest.stop(target.id)
      setSending(false)
      setStreaming('')
      setStreamStartedAt(0)
      addNotice(
        result.interrupted
          ? `已停止：${result.turns} 个回合、${result.subagents} 个子 Agent、${result.approvals} 个审批。`
          : '当前会话没有正在运行的操作。'
      )
      setActivities(await agentRequest.activity(current?.id || target.id))
    } catch (error) {
      setChatError((error as Error).message)
    }
  }

  const newConversation = async () => {
    const target = current?.parentThreadId ? threadTree[0] : current
    if (target) await agentRequest.stop(target.id)
    const created = await agentRequest.createThread(`web:web-admin:${crypto.randomUUID()}`)
    setThreadState('active')
    setSelectedChannel('web')
    setCurrent(created)
    setThreadTree([created])
    setThreads(value =>
      selectedChannel === 'web'
        ? [created, ...value.filter(item => item.id !== created.id)]
        : [created]
    )
    setMessages([])
    setToolCalls([])
    setActivities([])
    setStreaming('')
    setSending(false)
    setChatError('')
    setThreadDrawerOpen(false)
    setNotices([
      {
        id: crypto.randomUUID(),
        content: '已创建新会话。你可以直接描述想完成的事情。',
        createdAt: Date.now(),
      },
    ])
  }

  const handleSessionCommand = async (content: string) => {
    if (
      !/^(?:\/(?:model|persona)(?:\s+.+)?|\/(?:new|stop|help|同意|始终同意|拒绝)|\/(?:approve|deny)\s+[0-9a-f-]{36}|同意|允许|拒绝)$/i.test(
        content
      )
    ) {
      return false
    }
    if (/^\/new$/i.test(content)) {
      await newConversation()
      return true
    }
    if (/^\/stop$/i.test(content)) {
      await stopCurrent()
      return true
    }
    if (/^\/help$/i.test(content)) {
      addNotice(
        [
          'Karin Agent 会话命令',
          '/new 新建会话',
          '/stop 停止当前会话及子 Agent',
          '/model 查看或切换当前会话模型',
          '/model reset 恢复全局主模型',
          '/persona 查看或切换当前会话人物',
          '/persona reset 恢复默认人物',
          '/同意 本次同意',
          '/始终同意 本会话内始终同意该 Tool',
          '/拒绝 拒绝本次调用',
          '/help 查看帮助',
        ].join('\n')
      )
      return true
    }
    if (/^\/model(?:\s|$)/i.test(content)) {
      const thread = await ensureThread()
      const argument = content.replace(/^\/model\b/i, '').trim()
      const description = await agentRequest.threadModel(thread.id)
      if (!argument) {
        addNotice(
          [
            `当前模型：${description.providerName} · ${description.model || '未配置'}`,
            description.inherited ? '来源：全局主模型' : '来源：当前会话',
            '',
            '可用模型：',
            ...description.models.map(
              (item, index) =>
                `${index + 1}. ${item.providerName} · ${item.model} (${item.providerId})`
            ),
            '',
            '使用 /model <序号> 或 /model <providerId> <model> 切换',
            '使用 /model reset 恢复全局主模型',
          ].join('\n')
        )
        return true
      }
      if (/^reset$/i.test(argument)) {
        const updated = await agentRequest.setThreadModel(thread.id, null, null)
        setCurrent(updated)
        setThreads(value => value.map(item => (item.id === updated.id ? updated : item)))
        addNotice('当前会话已恢复使用全局主模型。')
        return true
      }
      const number = Number(argument)
      const selected = Number.isInteger(number) && number > 0
        ? description.models[number - 1]
        : (() => {
          const match = argument.match(/^(\S+)\s+(.+)$/)
          if (!match) return undefined
          return description.models.find(
            item => item.providerId === match[1] && item.model === match[2].trim()
          )
        })()
      if (!selected) {
        addNotice('模型选择无效，请先使用 /model 查看可用模型。')
        return true
      }
      const updated = await agentRequest.setThreadModel(
        thread.id,
        selected.providerId,
        selected.model
      )
      setCurrent(updated)
      setThreads(value => value.map(item => (item.id === updated.id ? updated : item)))
      addNotice(`当前会话将在下一回合使用 ${selected.providerName} · ${selected.model}。`)
      return true
    }
    if (/^\/persona(?:\s|$)/i.test(content)) {
      const thread = await ensureThread()
      const argument = content.replace(/^\/persona\b/i, '').trim()
      const customization = await agentRequest.threadCustomization(thread.id)
      const enabled = customization.personas.filter(item => item.enabled)
      if (!argument) {
        addNotice([
          `当前人物：${customization.persona?.name || '默认人物'}`,
          '',
          '可用人物：',
          ...enabled.map((item, index) => `${index + 1}. ${item.name} (${item.id})`),
          '',
          '使用 /persona <序号或ID> 切换，/persona reset 恢复默认人物。',
        ].join('\n'))
        return true
      }
      const selected = /^reset$/i.test(argument)
        ? null
        : Number.isInteger(Number(argument)) && Number(argument) > 0
          ? enabled[Number(argument) - 1]
          : enabled.find(item => item.id === argument)
      if (selected === undefined) {
        addNotice('人物选择无效，请先使用 /persona 查看可用人物。')
        return true
      }
      await agentRequest.setThreadPersona(thread.id, selected?.id || null)
      const next = await agentRequest.threadCustomization(thread.id)
      setCurrentCustomization(next)
      setCurrent(next.thread)
      setThreads(value => value.map(item => item.id === next.thread.id ? next.thread : item))
      addNotice(`当前会话将在下一回合使用人物：${next.persona?.name || '默认人物'}。`)
      return true
    }

    let candidates = approvals.filter(
      item => item.threadId === current?.id && item.status === 'pending'
    )
    const explicit = content.match(/^\/(approve|deny)\s+([0-9a-f-]{36})$/i)
    if (explicit) candidates = candidates.filter(item => item.id === explicit[2])
    if (!candidates.length) {
      addNotice('当前会话没有匹配的待审批操作。')
      return true
    }
    if (candidates.length > 1) {
      addNotice(
        [
          '当前会话有多个待审批操作，请指定审批 ID：',
          ...candidates.map(item => `${item.toolName} · ${item.id}`),
        ].join('\n')
      )
      return true
    }
    const decision =
      explicit?.[1].toLowerCase() === 'deny' || /^\/?拒绝$/i.test(content) ? 'denied' : 'approved'
    await resolveApproval(
      candidates[0],
      decision,
      decision === 'approved' && /^\/始终同意$/i.test(content) ? 'thread' : 'once'
    )
    return true
  }

  const send = async (override?: string) => {
    const content = (override ?? prompt).trim()
    if (!content) return
    if (current?.parentThreadId) {
      addNotice('子 Agent 会话只读，请返回父会话继续对话。')
      return
    }
    if (await handleSessionCommand(content)) {
      setPrompt('')
      return
    }
    setSending(true)
    setChatError('')
    setPrompt('')
    try {
      const thread = await ensureThread()
      setMessages(value => [
        ...value,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content,
          createdAt: Date.now(),
        },
      ])
      const accepted = await agentRequest.startTurn(thread.id, content)
      if (accepted.mode === 'supplemented') {
        setRecoveryStatus('正在中断旧回合并合并补充内容')
      }
    } catch (error) {
      setChatError((error as Error).message)
      setSending(false)
      setStreaming('')
    }
  }

  const handleMessageScroll = async () => {
    const viewport = messageViewportRef.current
    if (!viewport) return
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    followOutputRef.current = distanceFromBottom < 96
    if (followOutputRef.current) setHasNewActivity(false)
    if (viewport.scrollTop > 48 || loadingOlderRef.current || !current || !messages.length) return
    loadingOlderRef.current = true
    const previousHeight = viewport.scrollHeight
    try {
      const older = await agentRequest.messages(current.id, messages[0].createdAt)
      if (older.length) {
        const existing = new Set(messages.map(item => item.id))
        setMessages(value => [...older.filter(item => !existing.has(item.id)), ...value])
        requestAnimationFrame(() => {
          viewport.scrollTop += viewport.scrollHeight - previousHeight
        })
      }
    } finally {
      loadingOlderRef.current = false
    }
  }

  const saveConfig = async () => {
    if (!agentConfig) return
    try {
      let next = agentConfig
      if (agentConfigJsonDirty) {
        const parsed = JSON.parse(agentConfigJson) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('agent.json 顶层必须是 JSON 对象')
        }
        next = parsed as AgentConfig
        setAgentConfig(next)
      }
      await agentRequest.saveConfig(next)
      setAgentConfigJsonDirty(false)
      setAgentConfigJsonError('')
      toast.success('Agent 配置已保存并重新加载')
      await refresh()
    } catch (error) {
      const message = error instanceof SyntaxError
        ? `JSON 语法错误：${error.message}`
        : (error as Error).message
      setAgentConfigJsonError(message)
      toast.error(message)
    }
  }

  const updateProvider = (id: string, patch: Partial<AgentConfig['providers'][number]>) => {
    setAgentConfig(value =>
      value
        ? {
          ...value,
          providers: value.providers.map(provider =>
            provider.id === id ? { ...provider, ...patch } : provider
          ),
        }
        : value
    )
  }

  const addProvider = () => {
    setAgentConfig(value => {
      if (!value) return value
      const id = `provider-${crypto.randomUUID().slice(0, 8)}`
      return {
        ...value,
        providers: [
          ...value.providers,
          {
            id,
            name: 'Custom',
            kind: 'custom',
            protocol: 'chat-completions',
            enabled: true,
            baseUrl: 'http://127.0.0.1:8000/v1',
            apiKey: '',
            model: '',
            timeout: 30000,
          },
        ],
      }
    })
  }

  const discoverModels = async (id: string) => {
    if (!agentConfig) return
    setProviderBusy(`models:${id}`)
    try {
      await agentRequest.saveConfig(agentConfig)
      const models = await agentRequest.providerModels(id)
      setProviderModels(value => ({ ...value, [id]: models }))
      setAgentConfig(value =>
        value
          ? {
            ...value,
            providers: value.providers.map(provider =>
              provider.id === id
                ? {
                  ...provider,
                  discoveredModels: models,
                  modelsDiscoveredAt: Date.now(),
                }
                : provider
            ),
          }
          : value
      )
      toast.success(`发现 ${models.length} 个模型`)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setProviderBusy('')
    }
  }

  const testProvider = async (id: string) => {
    if (!agentConfig) return
    setProviderBusy(`test:${id}`)
    try {
      await agentRequest.saveConfig(agentConfig)
      const result = await agentRequest.testProvider(id)
      toast.success(`认证/对话/SSE/Tool 均通过，${result.latency}ms，模型 ${result.model}`)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setProviderBusy('')
    }
  }

  const search = async () => {
    try {
      setThreads(
        await agentRequest.threads({
          state: threadState,
          channel: selectedChannel,
          rootOnly: true,
          query: searchText.trim() || undefined,
        })
      )
      setSearchResults([])
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const renameCurrent = async () => {
    if (!current) return
    const title = window.prompt('输入新的对话标题', current.title || current.threadKey)
    if (title === null || !title.trim()) return
    const updated = await agentRequest.updateThread(current.id, { title })
    setCurrent(updated)
    setThreads(value => value.map(item => (item.id === updated.id ? updated : item)))
  }

  const archiveCurrent = async (archived: boolean) => {
    if (!current) return
    try {
      const updated = await agentRequest.updateThread(current.id, { archived })
      setCurrent(null)
      setThreadTree([])
      setThreads(value => value.filter(item => item.id !== updated.id))
      toast.success(archived ? '对话已归档' : '对话已恢复')
    } catch (error) {
      setChatError((error as Error).message)
    }
  }

  const deleteCurrent = async () => {
    if (!current) return
    const title = current.title || current.threadKey
    if (!window.confirm(`永久删除“${title}”？此操作不可恢复。`)) return
    if (!window.confirm('将同时删除消息、Tool 调用、审批和子 Agent 对话。确认继续？')) return
    try {
      await agentRequest.deleteThread(current.id)
      delete lastEventId.current[current.id]
      const next = threads.filter(item => item.id !== current.id)
      setThreads(next)
      setThreadTree([])
      setCurrent(next[0] || null)
      toast.success('对话已永久删除')
    } catch (error) {
      setChatError((error as Error).message)
    }
  }

  const toggleTool = async (name: string) => {
    if (!agentConfig) return
    const disabled = agentConfig.tools.disabled.includes(name)
      ? agentConfig.tools.disabled.filter(item => item !== name)
      : [...agentConfig.tools.disabled, name]
    const next = {
      ...agentConfig,
      tools: { ...agentConfig.tools, disabled },
    }
    setAgentConfig(next)
    await agentRequest.saveConfig(next)
    await refresh()
  }

  const toggleToolset = async (name: string) => {
    if (!agentConfig) return
    const disabledToolsets = agentConfig.tools.disabledToolsets.includes(name)
      ? agentConfig.tools.disabledToolsets.filter(item => item !== name)
      : [...agentConfig.tools.disabledToolsets, name]
    const next = {
      ...agentConfig,
      tools: { ...agentConfig.tools, disabledToolsets },
    }
    setAgentConfig(next)
    await agentRequest.saveConfig(next)
    await refresh()
  }

  const saveJob = async () => {
    try {
      await agentRequest.saveJob({
        id: editingJobId || undefined,
        ...jobDraft,
        runAt: jobDraft.runAt ? new Date(jobDraft.runAt).getTime() : null,
        enabled: true,
        toolAllowlist: jobDraft.toolAllowlist
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
        skillIds: jobDraft.skillIds
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
      })
      const nextJobs = await agentRequest.jobs()
      setJobs(nextJobs)
      const saved = nextJobs.find(item =>
        editingJobId ? item.id === editingJobId : item.name === jobDraft.name
      )
      if (saved) setSelectedJobId(saved.id)
      setEditingJobId('')
      setTaskEditorOpen(false)
      setJobDraft({
        name: '',
        scheduleType: 'cron',
        cron: '0 9 * * *',
        runAt: '',
        timezone: 'Asia/Shanghai',
        prompt: '',
        target: 'web',
        toolAllowlist: '',
        skillIds: '',
        personaId: '',
      })
      toast.success(editingJobId ? '自动任务已更新' : '自动任务已创建')
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const openNewJob = () => {
    setEditingJobId('')
    setJobDraft({
      name: '',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      runAt: '',
      timezone: 'Asia/Shanghai',
      prompt: '',
      target: 'web',
      toolAllowlist: '',
      skillIds: '',
      personaId: '',
    })
    setTaskEditorOpen(true)
  }

  const openJobEditor = (job: AgentJob) => {
    setEditingJobId(job.id)
    setJobDraft({
      name: job.name,
      scheduleType: job.scheduleType,
      cron: job.cron,
      runAt: job.runAt
        ? new Date(job.runAt - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
        : '',
      timezone: job.timezone,
      prompt: job.prompt,
      target: job.target,
      toolAllowlist: job.toolAllowlist.join(', '),
      skillIds: job.skillIds.join(', '),
      personaId: job.personaId || '',
    })
    setTaskEditorOpen(true)
  }

  const createMemory = async () => {
    try {
      await agentRequest.createMemory(memoryDraft)
      setMemories(await agentRequest.memories())
      setMemoryDraft(value => ({ ...value, content: '' }))
      toast.success('记忆已创建')
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const saveSkill = async () => {
    try {
      const { scriptTools, ...draft } = skillDraft
      const input = {
        ...draft,
        tools: skillDraft.tools
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
        scriptTools: compileScriptTools(scriptTools),
      }
      const result = editingSkillId
        ? await agentRequest.updateSkill(editingSkillId, input)
        : await agentRequest.createSkill(input)
      const nextSkills = await agentRequest.skills()
      setSkills(nextSkills)
      const skillId = String((result as { skillId?: string })?.skillId || editingSkillId)
      if (skillId) setSelectedSkillId(skillId)
      setSkillDraft(emptySkillDraft())
      setEditingSkillId('')
      setSkillEditorOpen(false)
      toast.success(editingSkillId ? 'Skill 新版本已保存' : 'Skill 已创建')
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const openNewSkill = () => {
    setEditingSkillId('')
    setSkillDraft(emptySkillDraft())
    setSkillEditorOpen(true)
  }

  const updateScriptTool = (index: number, patch: Partial<ScriptToolDraft>) => {
    setSkillDraft(value => ({
      ...value,
      scriptTools: value.scriptTools.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item
      ),
    }))
  }

  const openSkillEditor = (skill: AgentSkill) => {
    const version = skillVersions.find(item => item.id === skill.activeVersionId)
    if (!version) {
      toast.error('当前 Skill 版本尚未加载')
      return
    }
    setEditingSkillId(skill.id)
    setSkillDraft({
      name: version.name || skill.name,
      description: version.description || skill.description,
      instructions: skillInstructions(version.content),
      tools: skillTools(version.tools_json)
        .filter(name => !name.startsWith('skill.skill_'))
        .join(', '),
      scriptTools: scriptToolDrafts(version.script_tools_json || '[]'),
    })
    setSkillEditorOpen(true)
  }

  const deleteSkill = async (skill: AgentSkill) => {
    const confirmName = window.prompt(
      `此操作会永久删除 Skill、全部版本和运行引用。\n请输入完整名称确认：${skill.name}`
    )
    if (confirmName === null) return
    try {
      const result = await agentRequest.deleteSkill(skill.id, confirmName)
      const next = await agentRequest.skills()
      setSkills(next)
      setSelectedSkillId(next[0]?.id || '')
      setSkillEditorOpen(false)
      setEditingSkillId('')
      toast.success(
        `已永久删除 ${result.name}：${result.versions} 个版本，更新 ${result.jobsUpdated} 个任务`
      )
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const saveMcp = async () => {
    if (!agentConfig) return
    try {
      await agentRequest.saveConfig(agentConfig)
      setMcp(await agentRequest.reloadMcp())
      toast.success('MCP 配置已保存并重新连接')
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const updateMcpServer = (
    index: number,
    patch: Partial<AgentConfig['mcp']['servers'][number]>
  ) => {
    if (!agentConfig) return
    const previousName = agentConfig.mcp.servers[index]?.name
    const nextName = patch.name
    setAgentConfig({
      ...agentConfig,
      mcp: {
        ...agentConfig.mcp,
        servers: agentConfig.mcp.servers.map((server, serverIndex) =>
          serverIndex === index ? { ...server, ...patch } : server
        ),
      },
    })
    if (nextName && previousName === selectedMcpName) setSelectedMcpName(nextName)
  }

  const addMcpServer = () => {
    if (!agentConfig) return
    const name = `server-${agentConfig.mcp.servers.length + 1}`
    setAgentConfig({
      ...agentConfig,
      mcp: {
        ...agentConfig.mcp,
        servers: [...agentConfig.mcp.servers, { name, enabled: true, transport: 'http', url: '' }],
      },
    })
    setSelectedMcpName(name)
  }

  const submitFeedback = async (message: AgentMessage, rating: -1 | 1, correction?: string) => {
    if (!current) return
    try {
      await agentRequest.feedback(current.id, {
        turnId: message.turnId || undefined,
        rating,
        correction,
      })
      toast.success(correction ? '纠正已进入进化评测队列' : '反馈已记录')
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const timeline = [
    ...messages
      .filter(isRenderableChatMessage)
      .map(message => ({ kind: 'message' as const, createdAt: message.createdAt, message })),
    ...activities
      .filter(
        activity =>
          activity.kind !== 'approval' ||
          !activity.parentId ||
          !toolCallById.has(activity.parentId.replace(/^tool:/, ''))
      )
      .map(activity => ({
        kind: 'activity' as const,
        createdAt: activity.startedAt,
        activity,
      })),
    ...deliveries.map(delivery => ({
      kind: 'delivery' as const,
      createdAt: delivery.createdAt,
      delivery,
    })),
    ...notices.map(notice => ({
      kind: 'notice' as const,
      createdAt: notice.createdAt,
      notice,
    })),
  ].sort((left, right) => left.createdAt - right.createdAt)
  const waitingActivity =
    activities.find(item => item.kind === 'approval' && item.status === 'waiting_approval') ||
    activities.find(item => item.kind === 'tool' && item.status === 'waiting_approval') ||
    activities.find(item => item.status === 'waiting_approval')
  const runningTool = activities.find(item => item.kind === 'tool' && item.status === 'running')
  const runningSubagent = activities.find(
    item => item.kind === 'subagent' && item.status === 'running'
  )
  let activeLabel = '思考中'
  if (streaming) activeLabel = '正在生成回复'
  if (runningSubagent) activeLabel = `子 Agent 正在运行 · ${runningSubagent.label}`
  if (runningTool) {
    activeLabel = `正在调用 ${runningTool.source ? `${runningTool.source} / ` : ''}${
      runningTool.label
    }`
  }
  if (recoveryStatus) activeLabel = recoveryStatus
  if (waitingActivity) activeLabel = `等待确认 · ${waitingActivity.label}`
  const filteredJobs = jobs.filter(item =>
    `${item.name} ${item.prompt} ${item.target}`.toLowerCase().includes(taskQuery.toLowerCase())
  )
  const selectedJob = jobs.find(item => item.id === selectedJobId) || filteredJobs[0]
  const selectedJobRuns = selectedJob
    ? jobRuns.filter(item => String(item.job_id) === selectedJob.id)
    : []
  const filteredMemories = memories.filter(item => {
    const matchesScope = memoryScope === 'all' || item.scope === memoryScope
    const matchesQuery = `${item.content} ${item.scope} ${item.scopeKey}`
      .toLowerCase()
      .includes(memoryQuery.toLowerCase())
    return matchesScope && matchesQuery
  })
  const selectedMemory = memories.find(item => item.id === selectedMemoryId) || filteredMemories[0]
  const filteredSkills = skills.filter(item =>
    `${item.name} ${item.description}`.toLowerCase().includes(skillQuery.toLowerCase())
  )
  const selectedSkill = skills.find(item => item.id === selectedSkillId) || filteredSkills[0]
  const mcpServers = agentConfig?.mcp.servers || []
  const filteredMcpServers = mcpServers.filter(item =>
    `${item.name} ${item.transport} ${item.command || ''} ${item.url || ''}`
      .toLowerCase()
      .includes(mcpQuery.toLowerCase())
  )
  const selectedMcpIndex = mcpServers.findIndex(item => item.name === selectedMcpName)
  const selectedMcp = selectedMcpIndex >= 0 ? mcpServers[selectedMcpIndex] : filteredMcpServers[0]
  const selectedMcpStatus = mcp.find(item => String(item.name) === selectedMcp?.name)

  return (
    <div
      className={
        tab === 'chat'
          ? 'agent-chat-workspace flex h-full min-h-0 w-full flex-col'
          : 'mx-auto flex w-full max-w-[1600px] flex-col gap-5'
      }
    >
      {tab !== 'chat' && (
        <header className='flex items-center justify-between gap-4 rounded-2xl border border-default-200 bg-content1 px-5 py-4'>
          <div>
            <h1 className='text-xl font-semibold tracking-tight'>Karin Agent</h1>
            <p className='text-sm text-default-500'>
              固定命令优先，未匹配消息通过受策略约束的 Tool Runtime 处理。
            </p>
          </div>
          <div className='flex items-center gap-3'>
            <span
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                status?.state === 'ready'
                  ? 'bg-success-100 text-success-700'
                  : status?.state === 'failed'
                    ? 'bg-danger-100 text-danger-700'
                    : 'bg-warning-100 text-warning-700'
              }`}
            >
              {status?.state || 'loading'} · {status?.reason || `${tools.length} tools`}
            </span>
            <Action onClick={refresh}>
              <RefreshCw size={16} />
              刷新
            </Action>
          </div>
        </header>
      )}

      {tab === 'chat' && (
        <div className='relative grid h-full min-h-0 w-full gap-3 md:grid-cols-[300px_minmax(0,1fr)]'>
          {threadDrawerOpen && (
            <button
              type='button'
              aria-label='关闭对话列表'
              className='fixed inset-0 z-40 bg-black/30 md:hidden'
              onClick={() => setThreadDrawerOpen(false)}
            />
          )}
          <Panel
            className={`min-h-0 flex-col overflow-hidden ${
              threadDrawerOpen
                ? 'fixed inset-y-3 left-3 z-50 flex w-[min(320px,calc(100vw-24px))]'
                : 'hidden'
            } md:relative md:inset-auto md:z-auto md:flex md:w-auto`}
          >
            <div className='border-b border-default-200 p-4'>
              <div className='mb-3 flex items-center justify-between'>
                <h2 className='font-semibold'>对话</h2>
                <Action onClick={newConversation}>新建网页会话</Action>
              </div>
              <div className='mb-3 grid grid-cols-2 gap-2 rounded-xl bg-default-100 p-1'>
                {(['active', 'archived'] as const).map(state => (
                  <button
                    key={state}
                    type='button'
                    onClick={() => {
                      setThreadState(state)
                      setSelectedChannel(
                        readThreadSelections()[state]?.channel || selectedChannel
                      )
                      setThreads([])
                      setCurrent(null)
                      setThreadTree([])
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                      threadState === state
                        ? 'bg-content1 text-primary shadow-sm'
                        : 'text-default-500'
                    }`}
                  >
                    {state === 'active' ? '活动对话' : '已归档'}
                  </button>
                ))}
              </div>
              <div className='flex gap-2'>
                <input
                  value={searchText}
                  onChange={event => setSearchText(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') search()
                  }}
                  placeholder='搜索对话'
                  className='min-w-0 flex-1 rounded-xl border border-default-200 bg-default-50 px-3 py-2 text-sm outline-none focus:border-primary'
                />
                <Action onClick={search}>
                  <Search size={16} />
                </Action>
              </div>
            </div>
            <div className='min-h-0 flex-1 space-y-2 overflow-y-scroll p-3 [scrollbar-color:#a1a1aa_transparent] [scrollbar-width:thin]'>
              {searchResults.length > 0 && (
                <div className='mb-4 rounded-xl bg-warning-50 p-3 text-xs'>
                  <div className='mb-2 font-semibold'>搜索结果</div>
                  {searchResults.map((item, index) => (
                    <div key={index} className='border-t border-warning-100 py-2'>
                      {String(item.excerpt || item.content || '')}
                    </div>
                  ))}
                </div>
              )}
              {threads.map(thread => (
                <div key={thread.id} className='space-y-1'>
                  <button
                    type='button'
                    onClick={() => openThreadRoot(thread).catch(error => {
                      setChatError((error as Error).message)
                    })}
                    className={`w-full rounded-xl border p-3 text-left transition ${
                      current?.id === thread.id
                        ? 'border-primary bg-primary-50'
                        : 'border-transparent hover:bg-default-100'
                    }`}
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <span className='truncate text-sm font-medium'>{threadName(thread)}</span>
                      <span className='text-[11px] text-default-400'>{thread.state}</span>
                    </div>
                    <div className='mt-1 truncate text-xs text-default-400'>
                      {thread.accountName || thread.accountId || channelName(thread.channel)}
                      {' · '}
                      {thread.scene} · {date(thread.updatedAt)}
                    </div>
                    {thread.lastMessagePreview && (
                      <div className='mt-1 truncate text-xs text-default-500'>
                        {thread.lastMessagePreview}
                      </div>
                    )}
                  </button>
                  {threadTree[0]?.id === thread.id && threadTree.slice(1).map(child => (
                    <button
                      key={child.id}
                      type='button'
                      onClick={() => {
                        setCurrent(child)
                        setThreadDrawerOpen(false)
                      }}
                      className={`ml-4 w-[calc(100%_-_1rem)] rounded-xl border px-3 py-2 text-left transition ${
                        current?.id === child.id
                          ? 'border-primary bg-primary-50'
                          : 'border-transparent hover:bg-default-100'
                      }`}
                    >
                      <div className='flex items-center justify-between gap-2'>
                        <span className='truncate text-xs font-medium'>
                          {'↳ '.repeat(Math.max(1, child.depth || 1))}
                          {child.title || child.lastMessagePreview || '子 Agent'}
                        </span>
                        <span className='text-[10px] text-default-400'>{child.state}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </Panel>

          <Panel className='flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl'>
            <div className='flex shrink-0 items-center justify-between gap-3 border-b border-default-200 px-3 py-2.5 md:px-4'>
              <div className='flex min-w-0 flex-1 items-center gap-2'>
                <button
                  type='button'
                  aria-label='打开对话列表'
                  onClick={() => setThreadDrawerOpen(true)}
                  className='rounded-lg p-2 text-default-500 hover:bg-default-100 md:hidden'
                >
                  <Menu size={18} />
                </button>
                <div className='grid min-w-0 flex-1 gap-1 sm:grid-cols-[minmax(110px,0.6fr)_minmax(150px,1fr)]'>
                  <select
                    aria-label='选择渠道'
                    value={selectedChannel}
                    onChange={event => selectChannel(event.target.value)}
                    className='min-w-0 rounded-lg border border-default-200 bg-default-50 px-2 py-1.5 text-xs font-medium outline-none focus:border-primary'
                  >
                    {threadChannels.map(item => (
                      <option key={item.channel} value={item.channel}>
                        {channelName(item.channel)}
                        {' · '}
                        {threadState === 'active' ? item.activeCount : item.archivedCount}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label='选择会话'
                    value={current?.id || ''}
                    onChange={event => {
                      selectThread(event.target.value).catch(error => {
                        setChatError((error as Error).message)
                      })
                    }}
                    className='min-w-0 rounded-lg border border-default-200 bg-default-50 px-2 py-1.5 text-xs font-medium outline-none focus:border-primary'
                  >
                    {!threads.length && <option value=''>暂无会话</option>}
                    {threads.map(thread => (
                      <option key={thread.id} value={thread.id}>
                        {threadName(thread)}
                      </option>
                    ))}
                    {threadTree.slice(1).map(child => (
                      <option key={child.id} value={child.id}>
                        {'　'.repeat(Math.max(1, child.depth || 1))}↳{' '}
                        {child.title || child.lastMessagePreview || '子 Agent'}
                      </option>
                    ))}
                  </select>
                  <p className='truncate text-[11px] text-default-400 sm:col-span-2'>
                    {current?.accountName || current?.accountId || channelName(selectedChannel)}
                    {' · '}
                    {current?.modelProviderId ||
                      agentConfig?.routing.primary ||
                      '未配置 Provider'}
                    {' · '}
                    {current?.modelName ||
                      agentConfig?.providers.find(
                        provider =>
                          provider.id ===
                          (current?.modelProviderId || agentConfig.routing.primary)
                      )?.model ||
                      '未选择模型'}
                  </p>
                  <div className='flex items-center gap-2 sm:col-span-2'>
                    <select
                      value={currentCustomization?.persona?.id || ''}
                      disabled={!current || Boolean(current.parentThreadId)}
                      onChange={async event => {
                        if (!current) return
                        await agentRequest.setThreadPersona(current.id, event.target.value || null)
                        setCurrentCustomization(await agentRequest.threadCustomization(current.id))
                        toast.success('人物预设已切换')
                      }}
                      aria-label='当前会话人物预设'
                      className='max-w-44 rounded-lg border border-default-200 bg-default-50 px-2 py-1 text-[11px]'
                    >
                      {personas.filter(item => item.enabled).map(item => (
                        <option key={item.id} value={item.id}>{item.name}</option>
                      ))}
                    </select>
                    <span className='truncate text-[11px] text-default-400'>
                      AGENT.md v{currentCustomization?.instruction.version || '—'}
                    </span>
                    {current && !current.parentThreadId && latestInstruction &&
                      currentCustomization?.instruction.id !== latestInstruction.id && (
                        <button
                          type='button'
                          onClick={async () => {
                            await agentRequest.setThreadInstruction(current.id, latestInstruction.id)
                            setCurrentCustomization(await agentRequest.threadCustomization(current.id))
                            toast.success(`当前会话已升级到 AGENT.md v${latestInstruction.version}`)
                          }}
                          className='rounded-full bg-primary-50 px-2 py-1 text-[10px] text-primary'
                        >
                          升级到 v{latestInstruction.version}
                        </button>
                    )}
                  </div>
                </div>
              </div>
              <div className='flex shrink-0 items-center gap-1'>
                <span
                  className={`hidden rounded-full px-2 py-1 text-[11px] sm:inline ${
                    status?.state === 'ready'
                      ? 'bg-success-100 text-success-700'
                      : 'bg-warning-100 text-warning-700'
                  }`}
                >
                  {status?.state === 'ready' ? '已连接' : status?.reason || '未就绪'}
                </span>
                {current?.parentThreadId && threadTree[0] && (
                  <button
                    type='button'
                    title='返回父会话'
                    onClick={() => setCurrent(threadTree[0])}
                    className='flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-primary hover:bg-primary-50'
                  >
                    <ChevronRight className='rotate-180' size={15} />
                    父会话
                  </button>
                )}
                {current && !current.parentThreadId && (
                  <>
                    <button
                      type='button'
                      title='重命名'
                      onClick={renameCurrent}
                      className='rounded-lg p-2 text-default-500 hover:bg-default-100'
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type='button'
                      title={current.archivedAt ? '恢复' : '归档'}
                      onClick={() => archiveCurrent(!current.archivedAt)}
                      className='rounded-lg p-2 text-default-500 hover:bg-default-100'
                    >
                      {current.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                    </button>
                    <button
                      type='button'
                      title='停止'
                      onClick={stopCurrent}
                      className='rounded-lg p-2 text-danger hover:bg-danger-50'
                    >
                      <CircleStop size={16} />
                    </button>
                    <button
                      type='button'
                      title='永久删除'
                      onClick={deleteCurrent}
                      className='rounded-lg p-2 text-danger hover:bg-danger-50'
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            </div>
            {chatError && (
              <div className='shrink-0 border-b border-danger-200 bg-danger-50 px-4 py-2 text-sm text-danger'>
                {chatError}
              </div>
            )}
            {Boolean(taskList?.items.length) && taskList && (
              <details
                open={taskList.state === 'active'}
                className='shrink-0 border-b border-default-200 bg-content1 px-4 py-2'
              >
                <summary className='cursor-pointer text-xs font-semibold text-default-700'>
                  当前任务 · {taskList.items.filter(
                  item => item.status === 'completed' || item.status === 'cancelled'
                ).length}
                  /{taskList.items.length}
                  <span className='ml-2 font-normal text-default-400'>
                    {taskList.goal}
                  </span>
                </summary>
                <div className='mt-2 grid gap-1 sm:grid-cols-2'>
                  {taskList.items.map(item => (
                    <div
                      key={item.id}
                      className={`rounded-lg px-2.5 py-1.5 text-xs ${
                        item.status === 'in_progress'
                          ? 'bg-primary-50 text-primary'
                          : item.status === 'completed'
                            ? 'bg-success-50 text-success-700'
                            : item.status === 'cancelled'
                              ? 'bg-default-100 text-default-400 line-through'
                              : 'bg-default-50 text-default-600'
                      }`}
                    >
                      <span className='mr-1.5 font-mono'>{item.id}</span>
                      {item.content}
                    </div>
                  ))}
                </div>
              </details>
            )}
            <div
              ref={messageViewportRef}
              onScroll={handleMessageScroll}
              className='relative min-h-0 flex-1 space-y-3 overflow-y-scroll bg-default-50/40 p-3 [scrollbar-color:#a1a1aa_transparent] [scrollbar-width:thin] md:p-5'
            >
              {!timeline.length && !streaming && (
                <div className='grid h-full place-items-center'>
                  <div className='max-w-md text-center'>
                    <Bot className='mx-auto mb-3 text-primary' size={30} />
                    <h3 className='font-semibold'>从一个明确的目标开始</h3>
                    <p className='mt-1 text-sm text-default-500'>
                      直接描述任务，或输入 /help 查看会话命令。
                    </p>
                  </div>
                </div>
              )}
              {timeline.map(item => {
                if (item.kind === 'notice') {
                  return (
                    <div
                      key={item.notice.id}
                      className='mx-auto max-w-[92%] whitespace-pre-wrap rounded-xl border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-700'
                    >
                      {item.notice.content}
                    </div>
                  )
                }
                if (item.kind === 'activity') {
                  const activity = item.activity
                  if (activity.kind === 'tool') {
                    const call = toolCallById.get(activity.id.replace(/^tool:/, ''))
                    if (call) {
                      return (
                        <ToolCallCard
                          key={activity.id}
                          call={call}
                          approval={approvalByToolCall.get(call.id)}
                          now={now}
                          onResolve={resolveApproval}
                        />
                      )
                    }
                  }
                  return <ActivityCard key={activity.id} activity={activity} now={now} />
                }
                if (item.kind === 'delivery') {
                  return <DeliveryCard key={item.delivery.id} delivery={item.delivery} />
                }
                const message = item.message
                return (
                  <div
                    key={message.id}
                    className={`group relative max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                      message.role === 'user'
                        ? 'ml-auto bg-primary text-primary-foreground'
                        : message.role === 'tool'
                          ? 'border border-warning-200 bg-warning-50 font-mono text-xs'
                          : 'border border-default-200 bg-content1'
                    }`}
                  >
                    {message.name && (
                      <div className='mb-1 text-[11px] font-semibold'>{message.name}</div>
                    )}
                    {Boolean(message.attachments?.length) && (
                      <div className='mb-2 grid gap-2'>
                        {message.attachments?.map(attachment => (
                          <MessageAttachment
                            key={attachment.id}
                            attachment={attachment}
                          />
                        ))}
                      </div>
                    )}
                    {message.role === 'assistant'
                      ? <Markdown content={message.content} />
                      : <div className='whitespace-pre-wrap break-words'>{message.content}</div>}
                    <div
                      className={`absolute -bottom-3 ${
                        message.role === 'user' ? 'right-2' : 'left-2'
                      } flex items-center overflow-hidden rounded-full border border-default-200 bg-content1 text-default-500 opacity-0 shadow-sm transition group-hover:opacity-100`}
                    >
                      <button
                        type='button'
                        title='复制'
                        onClick={() => navigator.clipboard.writeText(message.content)}
                        className='p-1.5 hover:bg-default-100 hover:text-primary'
                      >
                        <Copy size={13} />
                      </button>
                      {message.role === 'assistant' && (
                        <>
                          <button
                            type='button'
                            title='这次解决了问题'
                            onClick={() => submitFeedback(message, 1)}
                            className='p-1.5 hover:bg-success-50 hover:text-success'
                          >
                            <ThumbsUp size={13} />
                          </button>
                          <button
                            type='button'
                            title='这次没有解决问题'
                            onClick={() => submitFeedback(message, -1)}
                            className='p-1.5 hover:bg-danger-50 hover:text-danger'
                          >
                            <ThumbsDown size={13} />
                          </button>
                          <button
                            type='button'
                            title='告诉 Agent 正确做法'
                            onClick={() => {
                              const correction = window.prompt(
                                '正确做法是什么？这条纠正会进入评测队列，不会直接改写运行时。'
                              )
                              if (correction?.trim()) submitFeedback(message, -1, correction)
                            }}
                            className='p-1.5 hover:bg-warning-50 hover:text-warning'
                          >
                            <MessageSquareWarning size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
              {streaming && (
                <div className='max-w-[86%] rounded-2xl border border-primary-200 bg-content1 px-4 py-3 text-sm leading-6'>
                  <div className='mb-1 flex items-center gap-2 text-[11px] text-primary'>
                    <LoaderCircle className='animate-spin' size={13} />
                    正在生成回复 · {elapsed(streamStartedAt || Date.now(), undefined, now)}
                  </div>
                  <Markdown content={streaming} />
                </div>
              )}
              {chatError && messages.some(message => message.role === 'user') && (
                <div className='flex gap-2'>
                  <Action
                    onClick={() => {
                      const last = [...messages].reverse().find(message => message.role === 'user')
                      if (last) send(last.content)
                    }}
                  >
                    <RotateCcw size={15} />
                    重试上一条
                  </Action>
                </div>
              )}
              {hasNewActivity && (
                <button
                  type='button'
                  onClick={() => {
                    const viewport = messageViewportRef.current
                    if (viewport) viewport.scrollTop = viewport.scrollHeight
                    followOutputRef.current = true
                    setHasNewActivity(false)
                  }}
                  className='sticky bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-lg'
                >
                  有新消息
                </button>
              )}
            </div>
            <div className='sticky bottom-0 z-20 shrink-0 border-t border-default-200 bg-content1/95 p-3 backdrop-blur md:p-4'>
              {current?.parentThreadId && (
                <div className='mb-2 flex items-center justify-between rounded-xl bg-default-100 px-3 py-2 text-xs text-default-600'>
                  <span>子 Agent 会话只读，请返回父会话继续输入。</span>
                  {threadTree[0] && (
                    <button
                      type='button'
                      onClick={() => setCurrent(threadTree[0])}
                      className='font-medium text-primary'
                    >
                      返回父会话
                    </button>
                  )}
                </div>
              )}
              {activities.some(
                item => item.status === 'running' || item.status === 'waiting_approval'
              ) && (
                <div className='mb-2 flex items-center gap-2 text-xs text-default-500'>
                  <LoaderCircle className='animate-spin text-primary' size={14} />
                  {activeLabel}
                </div>
              )}
              <div className='flex items-end gap-2'>
                <textarea
                  value={prompt}
                  onChange={event => setPrompt(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      send()
                    }
                  }}
                  rows={2}
                  disabled={Boolean(current?.archivedAt || current?.parentThreadId)}
                  placeholder={
                    current?.parentThreadId
                      ? '子 Agent 会话只读'
                      : '输入消息；/model 切换模型，/persona 切换人物'
                  }
                  className='max-h-32 min-h-[56px] flex-1 resize-none rounded-2xl border border-default-200 bg-default-50 px-4 py-3 text-sm outline-none focus:border-primary'
                />
                <button
                  type='button'
                  disabled={
                    (!sending && (!prompt.trim() || status?.state !== 'ready')) ||
                    Boolean(current?.archivedAt || current?.parentThreadId)
                  }
                  onClick={() => {
                    if (sending && current) {
                      stopCurrent()
                    } else {
                      send()
                    }
                  }}
                  className='grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground disabled:opacity-40'
                >
                  {sending ? <CircleStop size={19} /> : <Send size={19} />}
                </button>
              </div>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'approvals' && (
        <Panel>
          <div className='border-b border-default-200 p-5'>
            <h2 className='text-lg font-semibold'>工具审批队列</h2>
            <p className='text-sm text-default-500'>
              原始发起者、绑定渠道的会话发起人或管理员可处理，默认 5 分钟过期。
            </p>
          </div>
          <div className='divide-y divide-default-200'>
            {approvals.map(item => (
              <div key={item.id} className='grid gap-4 p-5 lg:grid-cols-[1fr_auto] lg:items-center'>
                <div>
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='font-semibold'>{item.toolName}</span>
                    <span className='rounded-full bg-default-100 px-2 py-1 text-xs'>
                      {item.status}
                    </span>
                  </div>
                  <pre className='mt-3 max-h-40 overflow-auto rounded-xl bg-default-50 p-3 text-xs'>
                    {JSON.stringify(item.input, null, 2)}
                  </pre>
                  <p className='mt-2 text-xs text-default-400'>
                    发起者 {item.actorId} · 过期 {date(item.expiresAt)}
                  </p>
                </div>
                {item.status === 'pending' && (
                  <div className='flex gap-2'>
                    <Action onClick={() => resolveApproval(item, 'approved')}>
                      <Check size={16} />
                      本次同意
                    </Action>
                    <Action onClick={() => resolveApproval(item, 'approved', 'thread')}>
                      始终同意
                    </Action>
                    <Action onClick={() => resolveApproval(item, 'denied')} danger>
                      <X size={16} />
                      拒绝
                    </Action>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {tab === 'memories' && (
        <Panel className='overflow-hidden'>
          <div className='flex flex-wrap items-center justify-between gap-4 border-b border-default-200 px-5 py-4'>
            <div>
              <div className='flex items-center gap-2'>
                <Database className='text-primary' size={19} />
                <h2 className='text-lg font-semibold'>长期记忆</h2>
                <span className='rounded-full bg-default-100 px-2 py-0.5 font-mono text-xs'>
                  {memories.filter(item => item.enabled).length}/{memories.length}
                </span>
              </div>
              <p className='mt-1 text-sm text-default-500'>
                按作用域保存稳定事实；凭据和临时上下文不应进入长期记忆。
              </p>
            </div>
            <Action onClick={() => setMemoryEditorOpen(true)}>
              <Plus size={16} />
              新建记忆
            </Action>
          </div>
          <div className='grid min-h-[640px] xl:grid-cols-[360px_minmax(0,1fr)]'>
            <aside className='border-b border-default-200 bg-default-50/40 xl:border-b-0 xl:border-r'>
              <div className='space-y-3 border-b border-default-200 p-4'>
                <label className='flex items-center gap-2 rounded-xl border border-default-200 bg-content1 px-3 py-2'>
                  <Search className='text-default-400' size={16} />
                  <input
                    value={memoryQuery}
                    onChange={event => setMemoryQuery(event.target.value)}
                    placeholder='搜索内容或作用域'
                    className='min-w-0 flex-1 bg-transparent text-sm outline-none'
                  />
                </label>
                <div className='flex gap-2'>
                  {['all', 'user', 'group', 'global'].map(scope => (
                    <button
                      key={scope}
                      type='button'
                      onClick={() => setMemoryScope(scope)}
                      className={`rounded-full px-2.5 py-1 text-xs transition ${
                        memoryScope === scope
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-content1 text-default-500 hover:text-foreground'
                      }`}
                    >
                      {memoryScopeLabels[scope]}
                    </button>
                  ))}
                </div>
              </div>
              <div className='karin-scrollbar max-h-[540px] space-y-1 overflow-y-auto p-2'>
                {filteredMemories.map(item => (
                  <button
                    key={item.id}
                    type='button'
                    onClick={() => {
                      setSelectedMemoryId(item.id)
                      setMemoryEditorOpen(false)
                    }}
                    className={`relative w-full overflow-hidden rounded-xl px-4 py-3 text-left transition ${
                      selectedMemory?.id === item.id && !memoryEditorOpen
                        ? 'bg-content1 shadow-sm'
                        : 'hover:bg-content1/70'
                    }`}
                  >
                    {selectedMemory?.id === item.id && !memoryEditorOpen && (
                      <span className='absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary' />
                    )}
                    <div className='flex items-center justify-between gap-2'>
                      <span className='font-mono text-[11px] uppercase tracking-wide text-primary'>
                        {item.scope}:{item.scopeKey}
                      </span>
                      <span
                        className={`h-2 w-2 rounded-full ${
                          item.enabled ? 'bg-success' : 'bg-default-300'
                        }`}
                      />
                    </div>
                    <p className='mt-2 line-clamp-2 text-sm leading-5'>{item.content}</p>
                    <p className='mt-2 text-[11px] text-default-400'>{date(item.createdAt)}</p>
                  </button>
                ))}
                {!filteredMemories.length && (
                  <div className='p-8 text-center text-sm text-default-400'>没有匹配的记忆。</div>
                )}
              </div>
            </aside>
            <div className='min-w-0'>
              {memoryEditorOpen
                ? (
                  <div className='mx-auto max-w-3xl p-5 md:p-8'>
                    <div className='mb-6 flex items-start justify-between gap-3'>
                      <div>
                        <div className='text-xs font-medium uppercase tracking-[0.18em] text-primary'>
                          New memory
                        </div>
                        <h3 className='mt-2 text-xl font-semibold'>记录一条长期事实</h3>
                      </div>
                      <button
                        type='button'
                        onClick={() => setMemoryEditorOpen(false)}
                        className='rounded-lg p-2 text-default-400 hover:bg-default-100'
                        aria-label='关闭记忆编辑器'
                      >
                        <X size={18} />
                      </button>
                    </div>
                    <div className='grid gap-4 md:grid-cols-2'>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        作用域
                        <select
                          value={memoryDraft.scope}
                          onChange={event =>
                            setMemoryDraft(value => ({ ...value, scope: event.target.value }))}
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                        >
                          <option value='user'>用户</option>
                          <option value='group'>群组</option>
                          <option value='global'>全局</option>
                        </select>
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        作用域标识
                        <input
                          value={memoryDraft.scopeKey}
                          onChange={event =>
                            setMemoryDraft(value => ({ ...value, scopeKey: event.target.value }))}
                          placeholder='例如 web-admin'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium md:col-span-2'>
                        记忆内容
                        <textarea
                          value={memoryDraft.content}
                          onChange={event =>
                            setMemoryDraft(value => ({ ...value, content: event.target.value }))}
                          placeholder='只写入未来对话仍然有帮助的稳定信息'
                          className='min-h-56 resize-y rounded-xl border border-default-200 bg-default-50 px-3 py-3 leading-6'
                        />
                        <span className='text-right font-mono text-xs text-default-400'>
                          {memoryDraft.content.length}/2000
                        </span>
                      </label>
                    </div>
                    <div className='mt-6 flex justify-end gap-2'>
                      <Action onClick={() => setMemoryEditorOpen(false)}>取消</Action>
                      <Action
                        disabled={
                        !memoryDraft.content.trim() ||
                        !memoryDraft.scopeKey.trim() ||
                        memoryDraft.content.length > 2000
                      }
                        onClick={async () => {
                          await createMemory()
                          setMemoryEditorOpen(false)
                        }}
                      >
                        保存记忆
                      </Action>
                    </div>
                  </div>
                )
                : selectedMemory
                  ? (
                    <div className='flex h-full min-h-[520px] flex-col'>
                      <div className='border-b border-default-200 p-5 md:p-7'>
                        <div className='flex flex-wrap items-start justify-between gap-4'>
                          <div>
                            <div className='flex flex-wrap items-center gap-2'>
                              <span className='rounded-full bg-primary-50 px-2.5 py-1 font-mono text-xs text-primary'>
                                {selectedMemory.scope}:{selectedMemory.scopeKey}
                              </span>
                              <span
                                className={`rounded-full px-2.5 py-1 text-xs ${
                              selectedMemory.enabled
                                ? 'bg-success-50 text-success-700'
                                : 'bg-default-100 text-default-500'
                            }`}
                              >
                                {selectedMemory.enabled ? '已启用' : '已禁用'}
                              </span>
                              <span className='rounded-full bg-default-100 px-2.5 py-1 text-xs'>
                                {selectedMemory.kind} · {selectedMemory.status}
                              </span>
                            </div>
                            <p className='mt-3 text-xs text-default-400'>
                              创建于 {date(selectedMemory.createdAt)} · 召回 {selectedMemory.useCount} 次 ·
                              可信度 {selectedMemory.confidence.toFixed(2)} ·
                              重要度 {selectedMemory.importance.toFixed(2)}
                            </p>
                          </div>
                          <div className='flex gap-2'>
                            <Action
                              onClick={async () => {
                                await agentRequest.setMemoryState(
                                  selectedMemory.id,
                                  !selectedMemory.enabled
                                )
                                setMemories(await agentRequest.memories())
                              }}
                            >
                              {selectedMemory.enabled ? '禁用' : '启用'}
                            </Action>
                            <Action
                              danger
                              onClick={async () => {
                                if (!window.confirm('永久删除此条长期记忆？此操作不可恢复。')) return
                                await agentRequest.deleteMemory(selectedMemory.id)
                                setMemories(await agentRequest.memories())
                              }}
                            >
                              <Trash2 size={15} />
                              删除
                            </Action>
                          </div>
                        </div>
                      </div>
                      <article className='karin-scrollbar flex-1 overflow-y-auto p-5 md:p-8'>
                        <div className='max-w-3xl whitespace-pre-wrap text-[15px] leading-7'>
                          {selectedMemory.content}
                        </div>
                      </article>
                    </div>
                  )
                  : (
                    <div className='grid min-h-[520px] place-items-center p-8 text-center text-sm text-default-400'>
                      选择一条记忆查看详情，或新建第一条记忆。
                    </div>
                  )}
            </div>
          </div>
        </Panel>
      )}

      {tab === 'skills' && (
        <Panel className='overflow-hidden'>
          <div className='flex flex-wrap items-center justify-between gap-4 border-b border-default-200 px-5 py-4'>
            <div>
              <div className='flex items-center gap-2'>
                <Brain className='text-primary' size={19} />
                <h2 className='text-lg font-semibold'>技能库</h2>
                <span className='rounded-full bg-default-100 px-2 py-0.5 font-mono text-xs'>
                  {skills.filter(item => item.enabled).length}/{skills.length}
                </span>
              </div>
              <p className='mt-1 text-sm text-default-500'>
                声明式技能按版本保存；新版本只进入新会话的技能快照。
              </p>
            </div>
            <Action onClick={openNewSkill}>
              <Plus size={16} />
              新建 Skill
            </Action>
          </div>
          <div className='grid min-h-[640px] xl:grid-cols-[360px_minmax(0,1fr)]'>
            <aside className='border-b border-default-200 bg-default-50/40 xl:border-b-0 xl:border-r'>
              <div className='border-b border-default-200 p-4'>
                <label className='flex items-center gap-2 rounded-xl border border-default-200 bg-content1 px-3 py-2'>
                  <Search className='text-default-400' size={16} />
                  <input
                    value={skillQuery}
                    onChange={event => setSkillQuery(event.target.value)}
                    placeholder='搜索技能名称或描述'
                    className='min-w-0 flex-1 bg-transparent text-sm outline-none'
                  />
                </label>
              </div>
              <div className='karin-scrollbar max-h-[560px] space-y-1 overflow-y-auto p-2'>
                {filteredSkills.map(item => (
                  <button
                    key={item.id}
                    type='button'
                    onClick={() => {
                      setSelectedSkillId(item.id)
                      setSkillEditorOpen(false)
                    }}
                    className={`relative w-full overflow-hidden rounded-xl px-4 py-3 text-left transition ${
                      selectedSkill?.id === item.id && !skillEditorOpen
                        ? 'bg-content1 shadow-sm'
                        : 'hover:bg-content1/70'
                    }`}
                  >
                    {selectedSkill?.id === item.id && !skillEditorOpen && (
                      <span className='absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary' />
                    )}
                    <div className='flex items-center justify-between gap-2'>
                      <span className='truncate font-semibold'>{item.name}</span>
                      <span
                        className={`h-2 w-2 rounded-full ${
                          item.enabled ? 'bg-success' : 'bg-default-300'
                        }`}
                      />
                    </div>
                    <p className='mt-1 line-clamp-2 text-xs leading-5 text-default-500'>
                      {item.description}
                    </p>
                    <div className='mt-2 flex items-center justify-between font-mono text-[10px] text-default-400'>
                      <span>{item.activeVersionId || 'no active version'}</span>
                      <ChevronRight size={13} />
                    </div>
                  </button>
                ))}
                {!filteredSkills.length && (
                  <div className='p-8 text-center text-sm text-default-400'>没有匹配的技能。</div>
                )}
              </div>
            </aside>
            <div className='min-w-0'>
              {skillEditorOpen
                ? (
                  <div className='mx-auto max-w-3xl p-5 md:p-8'>
                    <div className='mb-6 flex items-start justify-between gap-3'>
                      <div>
                        <div className='text-xs font-medium uppercase tracking-[0.18em] text-primary'>
                          Declarative workflow
                        </div>
                        <h3 className='mt-2 text-xl font-semibold'>
                          {editingSkillId ? '编辑 Skill 并创建新版本' : '创建 Skill'}
                        </h3>
                        <p className='mt-1 text-sm text-default-500'>
                          不允许脚本、依赖安装、密钥或权限绕过指令。
                        </p>
                      </div>
                      <button
                        type='button'
                        onClick={() => setSkillEditorOpen(false)}
                        className='rounded-lg p-2 text-default-400 hover:bg-default-100'
                        aria-label='关闭 Skill 编辑器'
                      >
                        <X size={18} />
                      </button>
                    </div>
                    <div className='grid gap-4 md:grid-cols-2'>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        Skill 名称
                        <input
                          value={skillDraft.name}
                          onChange={event =>
                            setSkillDraft(value => ({ ...value, name: event.target.value }))}
                          placeholder='skill-name'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        简短描述
                        <input
                          value={skillDraft.description}
                          onChange={event =>
                            setSkillDraft(value => ({ ...value, description: event.target.value }))}
                          placeholder='何时以及为什么使用'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium md:col-span-2'>
                        操作说明
                        <textarea
                          value={skillDraft.instructions}
                          onChange={event =>
                            setSkillDraft(value => ({ ...value, instructions: event.target.value }))}
                          placeholder='按步骤描述可复用工作流'
                          className='min-h-64 resize-y rounded-xl border border-default-200 bg-default-50 px-3 py-3 font-mono text-sm leading-6'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium md:col-span-2'>
                        可用 Tools
                        <input
                          value={skillDraft.tools}
                          onChange={event =>
                            setSkillDraft(value => ({ ...value, tools: event.target.value }))}
                          placeholder='karin.tool.one, karin.tool.two'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono text-sm'
                        />
                      </label>
                      <section className='grid gap-3 md:col-span-2'>
                        <div className='flex flex-wrap items-center justify-between gap-3'>
                          <div>
                            <h4 className='font-semibold'>Python Script Tools</h4>
                            <p className='mt-1 text-xs leading-5 text-default-500'>
                              仅允许受控标准库和纯计算；业务语义、停止条件与失败策略均为必填。
                            </p>
                          </div>
                          <Action
                            onClick={() =>
                              setSkillDraft(value => ({
                                ...value,
                                scriptTools: [...value.scriptTools, emptyScriptTool()],
                              }))}
                          >
                            <Plus size={14} />
                            添加脚本
                          </Action>
                        </div>
                        {skillDraft.scriptTools.map((script, index) => (
                          <div
                            key={`${script.id}-${index}`}
                            className='grid gap-3 rounded-2xl border border-default-200 bg-default-50/60 p-4 md:grid-cols-2'
                          >
                            <div className='flex items-center justify-between md:col-span-2'>
                              <span className='font-mono text-xs text-primary'>
                                script {index + 1}
                              </span>
                              <Action
                                danger
                                onClick={() =>
                                  setSkillDraft(value => ({
                                    ...value,
                                    scriptTools: value.scriptTools.filter(
                                      (_item, itemIndex) => itemIndex !== index
                                    ),
                                  }))}
                              >
                                <Trash2 size={14} />
                                移除
                              </Action>
                            </div>
                            <label className='grid gap-1 text-xs text-default-500'>
                              稳定 ID
                              <input
                                value={script.id}
                                onChange={event =>
                                  updateScriptTool(index, { id: event.target.value })}
                                placeholder='normalize_data'
                                className='rounded-xl border border-default-200 bg-background p-2 font-mono text-sm'
                              />
                            </label>
                            <label className='grid gap-1 text-xs text-default-500'>
                              名称
                              <input
                                value={script.name}
                                onChange={event =>
                                  updateScriptTool(index, { name: event.target.value })}
                                placeholder='规范化数据'
                                className='rounded-xl border border-default-200 bg-background p-2 text-sm'
                              />
                            </label>
                            <label className='grid gap-1 text-xs text-default-500 md:col-span-2'>
                              描述
                              <input
                                value={script.description}
                                onChange={event =>
                                  updateScriptTool(index, { description: event.target.value })}
                                placeholder='说明模型何时调用这个 Tool'
                                className='rounded-xl border border-default-200 bg-background p-2 text-sm'
                              />
                            </label>
                            <label className='grid gap-1 text-xs text-default-500 md:col-span-2'>
                              Python 源码
                              <textarea
                                value={script.source}
                                onChange={event =>
                                  updateScriptTool(index, { source: event.target.value })}
                                className='min-h-52 resize-y rounded-xl border border-default-200 bg-background p-3 font-mono text-xs leading-5'
                              />
                            </label>
                            <label className='grid gap-1 text-xs text-default-500'>
                              Input JSON Schema
                              <textarea
                                value={script.inputSchema}
                                onChange={event =>
                                  updateScriptTool(index, { inputSchema: event.target.value })}
                                className='min-h-36 resize-y rounded-xl border border-default-200 bg-background p-2 font-mono text-xs'
                              />
                            </label>
                            <label className='grid gap-1 text-xs text-default-500'>
                              Output JSON Schema（可选）
                              <textarea
                                value={script.outputSchema}
                                onChange={event =>
                                  updateScriptTool(index, { outputSchema: event.target.value })}
                                className='min-h-36 resize-y rounded-xl border border-default-200 bg-background p-2 font-mono text-xs'
                              />
                            </label>
                            {[
                              ['业务目标', 'objective', script.objective],
                              ['输入语义', 'inputs', script.inputs],
                              ['输出语义', 'outputs', script.outputs],
                              ['完成条件', 'completionCondition', script.completionCondition],
                              ['失败提示', 'userMessage', script.userMessage],
                            ].map(([label, key, value]) => (
                              <label
                                key={key}
                                className='grid gap-1 text-xs text-default-500'
                              >
                                {label}
                                <textarea
                                  value={String(value)}
                                  onChange={event =>
                                    updateScriptTool(index, {
                                      [key]: event.target.value,
                                    } as Partial<ScriptToolDraft>)}
                                  className='min-h-20 resize-y rounded-xl border border-default-200 bg-background p-2 text-sm'
                                />
                              </label>
                            ))}
                            <div className='grid gap-3 md:col-span-2 md:grid-cols-4'>
                              <label className='grid gap-1 text-xs text-default-500'>
                                超时（ms）
                                <input
                                  type='number'
                                  min={1000}
                                  max={120000}
                                  value={script.timeoutMs}
                                  onChange={event =>
                                    updateScriptTool(index, {
                                      timeoutMs: Number(event.target.value),
                                    })}
                                  className='rounded-xl border border-default-200 bg-background p-2 text-sm'
                                />
                              </label>
                              <label className='grid gap-1 text-xs text-default-500'>
                                最大输出（bytes）
                                <input
                                  type='number'
                                  min={1024}
                                  max={1048576}
                                  value={script.maxOutputBytes}
                                  onChange={event =>
                                    updateScriptTool(index, {
                                      maxOutputBytes: Number(event.target.value),
                                    })}
                                  className='rounded-xl border border-default-200 bg-background p-2 text-sm'
                                />
                              </label>
                              <label className='grid gap-1 text-xs text-default-500'>
                                失败策略
                                <select
                                  value={script.strategy}
                                  onChange={event =>
                                    updateScriptTool(index, {
                                      strategy: event.target.value as 'fail' | 'retry',
                                    })}
                                  className='rounded-xl border border-default-200 bg-background p-2 text-sm'
                                >
                                  <option value='fail'>立即失败</option>
                                  <option value='retry'>有限重试</option>
                                </select>
                              </label>
                              <label className='grid gap-1 text-xs text-default-500'>
                                最大尝试
                                <input
                                  type='number'
                                  min={1}
                                  max={3}
                                  disabled={script.strategy === 'fail'}
                                  value={script.strategy === 'fail' ? 1 : script.maxAttempts}
                                  onChange={event =>
                                    updateScriptTool(index, {
                                      maxAttempts: Number(event.target.value),
                                    })}
                                  className='rounded-xl border border-default-200 bg-background p-2 text-sm'
                                />
                              </label>
                            </div>
                            <div className='flex flex-wrap items-center gap-4 md:col-span-2'>
                              <label className='flex items-center gap-2 text-sm'>
                                <input
                                  type='checkbox'
                                  checked={script.idempotent}
                                  onChange={event =>
                                    updateScriptTool(index, {
                                      idempotent: event.target.checked,
                                    })}
                                />
                                幂等脚本
                              </label>
                              <label className='flex items-center gap-2 text-xs text-default-500'>
                                重试间隔（ms）
                                <input
                                  type='number'
                                  min={0}
                                  max={10000}
                                  disabled={script.strategy === 'fail'}
                                  value={script.retryDelayMs}
                                  onChange={event =>
                                    updateScriptTool(index, {
                                      retryDelayMs: Number(event.target.value),
                                    })}
                                  className='w-28 rounded-xl border border-default-200 bg-background p-2 text-sm'
                                />
                              </label>
                              <span className='text-xs text-default-400'>
                                副作用固定为空；第一版不允许网络、持久化文件或子进程。
                              </span>
                            </div>
                          </div>
                        ))}
                      </section>
                    </div>
                    <div className='mt-6 flex justify-end gap-2'>
                      <Action onClick={() => setSkillEditorOpen(false)}>取消</Action>
                      <Action
                        disabled={
                        !skillDraft.name.trim() ||
                        !skillDraft.description.trim() ||
                        !skillDraft.instructions.trim() ||
                        !scriptToolsComplete(skillDraft.scriptTools)
                      }
                        onClick={saveSkill}
                      >
                        保存新版本
                      </Action>
                    </div>
                  </div>
                )
                : selectedSkill
                  ? (
                    <div className='flex h-full min-h-[520px] flex-col'>
                      <div className='border-b border-default-200 p-5 md:p-7'>
                        <div className='flex flex-wrap items-start justify-between gap-4'>
                          <div className='min-w-0'>
                            <div className='flex flex-wrap items-center gap-2'>
                              <span className='rounded-full bg-primary-50 px-2.5 py-1 font-mono text-xs text-primary'>
                                {selectedSkill.activeVersionId || '未激活'}
                              </span>
                              <span
                                className={`rounded-full px-2.5 py-1 text-xs ${
                              selectedSkill.enabled
                                ? 'bg-success-50 text-success-700'
                                : 'bg-default-100 text-default-500'
                            }`}
                              >
                                {selectedSkill.enabled ? '已启用' : '已禁用'}
                              </span>
                            </div>
                            <h3 className='mt-3 text-2xl font-semibold tracking-tight'>
                              {selectedSkill.name}
                            </h3>
                            <p className='mt-2 max-w-2xl text-sm leading-6 text-default-500'>
                              {selectedSkill.description}
                            </p>
                          </div>
                          <div className='flex flex-wrap gap-2'>
                            <Action onClick={() => openSkillEditor(selectedSkill)}>
                              <Pencil size={15} />
                              编辑
                            </Action>
                            <Action
                              onClick={async () => {
                                await agentRequest.setSkillState(
                                  selectedSkill.id,
                                  !selectedSkill.enabled
                                )
                                setSkills(await agentRequest.skills())
                              }}
                            >
                              {selectedSkill.enabled ? '禁用技能' : '启用技能'}
                            </Action>
                            <Action danger onClick={() => deleteSkill(selectedSkill)}>
                              <Trash2 size={15} />
                              永久删除
                            </Action>
                          </div>
                        </div>
                      </div>
                      <div className='karin-scrollbar grid flex-1 gap-5 overflow-y-auto p-5 md:p-7 lg:grid-cols-[minmax(0,1fr)_280px]'>
                        <section>
                          <div className='mb-3 flex items-center gap-2'>
                            <BookOpen size={16} />
                            <h4 className='font-semibold'>版本记录</h4>
                          </div>
                          <div className='space-y-2'>
                            {skillVersions.map(version => {
                              const versionId = String(version.id || '')
                              const active = versionId === selectedSkill.activeVersionId
                              return (
                                <div
                                  key={versionId}
                                  className={`rounded-xl border p-4 ${
                                active
                                  ? 'border-primary-200 bg-primary-50/50'
                                  : 'border-default-200'
                              }`}
                                >
                                  <div className='flex flex-wrap items-center justify-between gap-3'>
                                    <div>
                                      <div className='flex items-center gap-2'>
                                        <span className='font-mono text-sm font-semibold'>
                                          v{String(version.version || '?')}
                                        </span>
                                        {active && (
                                          <span className='rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground'>
                                            当前
                                          </span>
                                        )}
                                      </div>
                                      <p className='mt-1 font-mono text-[10px] text-default-400'>
                                        {versionId}
                                      </p>
                                    </div>
                                    {!active && (
                                      <Action
                                        onClick={async () => {
                                          if (!window.confirm(`回滚到 v${String(version.version)}？`)) { return }
                                          await agentRequest.rollbackSkill(selectedSkill.id, versionId)
                                          setSkills(await agentRequest.skills())
                                          setSkillVersions(
                                            await agentRequest.skillVersions(selectedSkill.id)
                                          )
                                        }}
                                      >
                                        回滚到此版本
                                      </Action>
                                    )}
                                  </div>
                                  <p className='mt-3 text-xs text-default-400'>
                                    {date(Number(version.created_at))}
                                  </p>
                                </div>
                              )
                            })}
                            {!skillVersions.length && (
                              <div className='rounded-xl border border-dashed border-default-200 p-6 text-center text-sm text-default-400'>
                                暂无版本记录。
                              </div>
                            )}
                          </div>
                        </section>
                        <aside className='space-y-3'>
                          <h4 className='font-semibold'>使用情况</h4>
                          {[
                            ['调用', Number(skillUsage?.use_count || 0)],
                            ['成功', Number(skillUsage?.success_count || 0)],
                            ['失败', Number(skillUsage?.failure_count || 0)],
                            ['纠正', Number(skillUsage?.correction_count || 0)],
                          ].map(([label, value]) => (
                            <div key={String(label)} className='rounded-xl bg-default-50 p-3'>
                              <div className='text-xs text-default-400'>{label}</div>
                              <div className='mt-1 font-mono text-xl font-semibold'>{value}</div>
                            </div>
                          ))}
                          <p className='text-xs text-default-400'>
                            最近使用 {date(Number(skillUsage?.last_used_at || 0))}
                          </p>
                        </aside>
                      </div>
                    </div>
                  )
                  : (
                    <div className='grid min-h-[520px] place-items-center p-8 text-center text-sm text-default-400'>
                      选择一个技能查看版本与使用情况，或创建第一个 Skill。
                    </div>
                  )}
            </div>
          </div>
        </Panel>
      )}

      {tab === 'tasks' && (
        <Panel className='overflow-hidden'>
          <div className='grid border-b border-default-200 sm:grid-cols-[minmax(0,1fr)_repeat(3,auto)]'>
            <div className='p-5'>
              <div className='flex items-center gap-2'>
                <Clock3 className='text-primary' size={19} />
                <h2 className='text-lg font-semibold'>定时任务</h2>
              </div>
              <p className='mt-1 text-sm text-default-500'>
                周期任务和一次性提醒由 Core 持久化，并投递到指定会话。
              </p>
            </div>
            {[
              ['运行中', jobs.filter(item => item.enabled).length],
              ['已暂停', jobs.filter(item => !item.enabled).length],
              ['运行记录', jobRuns.length],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className='hidden min-w-28 border-l border-default-200 px-5 py-4 sm:block'
              >
                <div className='text-xs text-default-400'>{label}</div>
                <div className='mt-1 font-mono text-2xl font-semibold'>{value}</div>
              </div>
            ))}
          </div>
          <div className='grid min-h-[680px] xl:grid-cols-[380px_minmax(0,1fr)]'>
            <aside className='border-b border-default-200 bg-default-50/40 xl:border-b-0 xl:border-r'>
              <div className='space-y-3 border-b border-default-200 p-4'>
                <Action onClick={openNewJob}>
                  <Plus size={16} />
                  新建任务
                </Action>
                <label className='flex items-center gap-2 rounded-xl border border-default-200 bg-content1 px-3 py-2'>
                  <Search className='text-default-400' size={16} />
                  <input
                    value={taskQuery}
                    onChange={event => setTaskQuery(event.target.value)}
                    placeholder='搜索名称、Prompt 或目标'
                    className='min-w-0 flex-1 bg-transparent text-sm outline-none'
                  />
                </label>
              </div>
              <div className='karin-scrollbar max-h-[570px] space-y-1 overflow-y-auto p-2'>
                {filteredJobs.map(item => (
                  <button
                    key={item.id}
                    type='button'
                    onClick={() => {
                      setSelectedJobId(item.id)
                      setTaskEditorOpen(false)
                    }}
                    className={`relative w-full overflow-hidden rounded-xl px-4 py-3 text-left transition ${
                      selectedJob?.id === item.id && !taskEditorOpen
                        ? 'bg-content1 shadow-sm'
                        : 'hover:bg-content1/70'
                    }`}
                  >
                    {selectedJob?.id === item.id && !taskEditorOpen && (
                      <span className='absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary' />
                    )}
                    <div className='flex items-center justify-between gap-3'>
                      <span className='truncate font-semibold'>{item.name}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] ${
                          item.enabled
                            ? 'bg-success-50 text-success-700'
                            : 'bg-default-100 text-default-500'
                        }`}
                      >
                        {item.enabled ? '运行中' : '已暂停'}
                      </span>
                    </div>
                    <div className='mt-2 font-mono text-xs text-default-500'>
                      {item.scheduleType === 'once' ? date(item.runAt) : item.cron}
                    </div>
                    <div className='mt-2 flex items-center justify-between text-[11px] text-default-400'>
                      <span className='truncate'>{item.target}</span>
                      <span>上次 {date(item.lastRunAt)}</span>
                    </div>
                  </button>
                ))}
                {!filteredJobs.length && (
                  <div className='p-8 text-center text-sm text-default-400'>没有匹配的任务。</div>
                )}
              </div>
            </aside>
            <div className='min-w-0'>
              {taskEditorOpen
                ? (
                  <div className='mx-auto max-w-3xl p-5 md:p-8'>
                    <div className='mb-6 flex items-start justify-between gap-3'>
                      <div>
                        <div className='text-xs font-medium uppercase tracking-[0.18em] text-primary'>
                          {editingJobId ? 'Edit schedule' : 'New schedule'}
                        </div>
                        <h3 className='mt-2 text-xl font-semibold'>
                          {editingJobId ? '编辑自动任务' : '创建自动任务'}
                        </h3>
                      </div>
                      <button
                        type='button'
                        onClick={() => setTaskEditorOpen(false)}
                        className='rounded-lg p-2 text-default-400 hover:bg-default-100'
                        aria-label='关闭任务编辑器'
                      >
                        <X size={18} />
                      </button>
                    </div>
                    <div className='grid gap-4 md:grid-cols-2'>
                      <label className='grid gap-1.5 text-sm font-medium md:col-span-2'>
                        任务名称
                        <input
                          value={jobDraft.name}
                          onChange={event =>
                            setJobDraft(value => ({ ...value, name: event.target.value }))}
                          placeholder='例如 每日工作摘要'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        计划类型
                        <select
                          value={jobDraft.scheduleType}
                          onChange={event =>
                            setJobDraft(value => ({
                              ...value,
                              scheduleType: event.target.value as 'cron' | 'once',
                            }))}
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                        >
                          <option value='cron'>Cron 周期</option>
                          <option value='once'>一次性时间</option>
                        </select>
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        {jobDraft.scheduleType === 'cron' ? 'Cron 表达式' : '运行时间'}
                        {jobDraft.scheduleType === 'cron'
                          ? (
                            <input
                              value={jobDraft.cron}
                              onChange={event =>
                                setJobDraft(value => ({ ...value, cron: event.target.value }))}
                              placeholder='0 9 * * *'
                              className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono'
                            />
                          )
                          : (
                            <input
                              type='datetime-local'
                              value={jobDraft.runAt}
                              onChange={event =>
                                setJobDraft(value => ({ ...value, runAt: event.target.value }))}
                              className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono'
                            />
                          )}
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        时区
                        <input
                          value={jobDraft.timezone}
                          onChange={event =>
                            setJobDraft(value => ({ ...value, timezone: event.target.value }))}
                          placeholder='Asia/Shanghai'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        投递目标
                        <input
                          value={jobDraft.target}
                          onChange={event =>
                            setJobDraft(value => ({ ...value, target: event.target.value }))}
                          placeholder='web 或渠道会话目标'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        类型
                        <select
                          value={memoryDraft.kind}
                          onChange={event => setMemoryDraft(value => ({
                            ...value,
                            kind: event.target.value as AgentMemory['kind'],
                          }))}
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                        >
                          <option value='fact'>事实</option>
                          <option value='preference'>偏好</option>
                          <option value='relationship'>关系</option>
                          <option value='procedure'>流程</option>
                          <option value='constraint'>约束</option>
                        </select>
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        稳定主题键（可选）
                        <input
                          value={memoryDraft.memoryKey}
                          onChange={event => setMemoryDraft(value => ({
                            ...value,
                            memoryKey: event.target.value,
                          }))}
                          placeholder='例如 user.locale'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        重要度 {memoryDraft.importance.toFixed(1)}
                        <input
                          type='range'
                          min={0}
                          max={1}
                          step={0.1}
                          value={memoryDraft.importance}
                          onChange={event => setMemoryDraft(value => ({
                            ...value,
                            importance: Number(event.target.value),
                          }))}
                        />
                      </label>
                      <label className='flex items-center gap-2 text-sm font-medium'>
                        <input
                          type='checkbox'
                          checked={memoryDraft.pinned}
                          onChange={event => setMemoryDraft(value => ({
                            ...value,
                            pinned: event.target.checked,
                          }))}
                        />
                        始终置顶召回
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        人物预设
                        <select
                          value={jobDraft.personaId}
                          onChange={event =>
                            setJobDraft(value => ({ ...value, personaId: event.target.value }))}
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                        >
                          <option value=''>运行时使用默认人物</option>
                          {personas.filter(item => item.enabled).map(item => (
                            <option key={item.id} value={item.id}>{item.name}</option>
                          ))}
                        </select>
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium md:col-span-2'>
                        运行 Prompt
                        <textarea
                          value={jobDraft.prompt}
                          onChange={event =>
                            setJobDraft(value => ({ ...value, prompt: event.target.value }))}
                          placeholder='描述每次运行时 Agent 要完成的任务'
                          className='min-h-40 resize-y rounded-xl border border-default-200 bg-default-50 px-3 py-3 leading-6'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        预授权 Tools
                        <input
                          value={jobDraft.toolAllowlist}
                          onChange={event =>
                            setJobDraft(value => ({ ...value, toolAllowlist: event.target.value }))}
                          placeholder='逗号分隔'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono text-sm'
                        />
                      </label>
                      <label className='grid gap-1.5 text-sm font-medium'>
                        附加 Skill ID
                        <input
                          value={jobDraft.skillIds}
                          onChange={event =>
                            setJobDraft(value => ({ ...value, skillIds: event.target.value }))}
                          placeholder='逗号分隔'
                          className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono text-sm'
                        />
                      </label>
                    </div>
                    <div className='mt-6 flex justify-end gap-2'>
                      <Action onClick={() => setTaskEditorOpen(false)}>取消</Action>
                      <Action
                        disabled={
                        !jobDraft.name.trim() ||
                        !jobDraft.prompt.trim() ||
                        !jobDraft.target.trim() ||
                        (jobDraft.scheduleType === 'cron' ? !jobDraft.cron.trim() : !jobDraft.runAt)
                      }
                        onClick={saveJob}
                      >
                        {editingJobId ? '保存修改' : '创建任务'}
                      </Action>
                    </div>
                  </div>
                )
                : selectedJob
                  ? (
                    <div className='flex h-full min-h-[560px] flex-col'>
                      <div className='border-b border-default-200 p-5 md:p-7'>
                        <div className='flex flex-wrap items-start justify-between gap-4'>
                          <div className='min-w-0'>
                            <div className='flex flex-wrap items-center gap-2'>
                              <span
                                className={`rounded-full px-2.5 py-1 text-xs ${
                              selectedJob.enabled
                                ? 'bg-success-50 text-success-700'
                                : 'bg-default-100 text-default-500'
                            }`}
                              >
                                {selectedJob.enabled ? '运行中' : '已暂停'}
                              </span>
                              <span className='rounded-full bg-primary-50 px-2.5 py-1 font-mono text-xs text-primary'>
                                {selectedJob.scheduleType === 'once' ? 'ONCE' : 'CRON'}
                              </span>
                            </div>
                            <h3 className='mt-3 text-2xl font-semibold tracking-tight'>
                              {selectedJob.name}
                            </h3>
                            <p className='mt-2 font-mono text-sm text-default-500'>
                              {selectedJob.scheduleType === 'once'
                                ? date(selectedJob.runAt)
                                : selectedJob.cron}
                              {' · '}
                              {selectedJob.timezone}
                            </p>
                          </div>
                          <div className='flex flex-wrap gap-2'>
                            <Action onClick={() => openJobEditor(selectedJob)}>
                              <Pencil size={15} />
                              编辑
                            </Action>
                            <Action
                              onClick={async () => {
                                await agentRequest.setJobState(selectedJob.id, !selectedJob.enabled)
                                setJobs(await agentRequest.jobs())
                              }}
                            >
                              {selectedJob.enabled
                                ? (
                                  <>
                                    <Pause size={15} />
                                    暂停
                                  </>
                                )
                                : (
                                  <>
                                    <Play size={15} />
                                    恢复
                                  </>
                                )}
                            </Action>
                            <Action
                              onClick={async () => {
                                await agentRequest.runJob(selectedJob.id)
                                setJobs(await agentRequest.jobs())
                                setJobRuns(await agentRequest.jobRuns())
                                toast.success('任务已运行')
                              }}
                            >
                              <Play size={15} />
                              立即运行
                            </Action>
                            <Action
                              danger
                              onClick={async () => {
                                if (!window.confirm('永久删除此自动任务？')) return
                                await agentRequest.deleteJob(selectedJob.id)
                                setJobs(await agentRequest.jobs())
                              }}
                            >
                              <Trash2 size={15} />
                            </Action>
                          </div>
                        </div>
                      </div>
                      <div className='karin-scrollbar flex-1 overflow-y-auto p-5 md:p-7'>
                        <div className='grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]'>
                          <div className='space-y-5'>
                            <section>
                              <h4 className='mb-2 text-sm font-semibold'>运行指令</h4>
                              <div className='whitespace-pre-wrap rounded-xl bg-default-50 p-4 text-sm leading-6'>
                                {selectedJob.prompt}
                              </div>
                            </section>
                            <section>
                              <h4 className='mb-2 text-sm font-semibold'>最近运行</h4>
                              <div className='space-y-2'>
                                {selectedJobRuns.slice(0, 20).map(run => (
                                  <div
                                    key={String(run.id)}
                                    className='rounded-xl border border-default-200 p-3'
                                  >
                                    <div className='flex flex-wrap items-center justify-between gap-2'>
                                      <span className='font-mono text-xs font-semibold'>
                                        {String(run.status)}
                                      </span>
                                      <span className='text-xs text-default-400'>
                                        {date(Number(run.started_at))}
                                      </span>
                                    </div>
                                    {Boolean(run.error) && (
                                      <p className='mt-2 text-xs text-danger'>{String(run.error)}</p>
                                    )}
                                  </div>
                                ))}
                                {!selectedJobRuns.length && (
                                  <div className='rounded-xl border border-dashed border-default-200 p-6 text-center text-sm text-default-400'>
                                    此任务还没有运行记录。
                                  </div>
                                )}
                              </div>
                            </section>
                          </div>
                          <aside className='space-y-3'>
                            {[
                              ['投递目标', selectedJob.target],
                              ['上次运行', date(selectedJob.lastRunAt)],
                              ['预授权 Tools', selectedJob.toolAllowlist.join(', ') || '无'],
                              ['附加 Skills', selectedJob.skillIds.join(', ') || '无'],
                            ].map(([label, value]) => (
                              <div key={label} className='rounded-xl bg-default-50 p-3'>
                                <div className='text-xs text-default-400'>{label}</div>
                                <div className='mt-1 break-words font-mono text-xs leading-5'>
                                  {value}
                                </div>
                              </div>
                            ))}
                          </aside>
                        </div>
                      </div>
                    </div>
                  )
                  : (
                    <div className='grid min-h-[560px] place-items-center p-8 text-center text-sm text-default-400'>
                      选择一个任务查看详情，或创建第一个自动任务。
                    </div>
                  )}
            </div>
          </div>
        </Panel>
      )}

      {tab === 'mcp' && (
        <Panel className='overflow-hidden'>
          <div className='grid border-b border-default-200 sm:grid-cols-[minmax(0,1fr)_repeat(3,auto)]'>
            <div className='flex flex-wrap items-center justify-between gap-4 p-5'>
              <div>
                <div className='flex items-center gap-2'>
                  <Network className='text-primary' size={19} />
                  <h2 className='text-lg font-semibold'>MCP 服务</h2>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      agentConfig?.mcp.enabled
                        ? 'bg-success-50 text-success-700'
                        : 'bg-default-100 text-default-500'
                    }`}
                  >
                    {agentConfig?.mcp.enabled ? 'Client 已启用' : 'Client 已关闭'}
                  </span>
                </div>
                <p className='mt-1 text-sm text-default-500'>
                  管理 stdio 与 Streamable HTTP 服务；所有远程 Tool 至少按 external 风险审批。
                </p>
              </div>
              <label className='flex items-center gap-2 rounded-xl border border-default-200 px-3 py-2 text-sm'>
                <input
                  type='checkbox'
                  checked={Boolean(agentConfig?.mcp.enabled)}
                  onChange={event => {
                    if (!agentConfig) return
                    setAgentConfig({
                      ...agentConfig,
                      mcp: { ...agentConfig.mcp, enabled: event.target.checked },
                    })
                  }}
                />
                启用 MCP Client
              </label>
            </div>
            {[
              ['服务', mcpServers.length],
              ['在线', mcp.filter(item => item.connected).length],
              [
                'Tools',
                mcp.reduce(
                  (total, item) => total + (Array.isArray(item.tools) ? item.tools.length : 0),
                  0
                ),
              ],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className='hidden min-w-24 border-l border-default-200 px-5 py-4 sm:block'
              >
                <div className='text-xs text-default-400'>{label}</div>
                <div className='mt-1 font-mono text-2xl font-semibold'>{value}</div>
              </div>
            ))}
          </div>
          <div className='grid min-h-[680px] xl:grid-cols-[380px_minmax(0,1fr)]'>
            <aside className='border-b border-default-200 bg-default-50/40 xl:border-b-0 xl:border-r'>
              <div className='space-y-3 border-b border-default-200 p-4'>
                <div className='flex flex-wrap gap-2'>
                  <Action onClick={addMcpServer}>
                    <Plus size={16} />
                    新增服务
                  </Action>
                  <Action onClick={saveMcp}>
                    <RefreshCw size={15} />
                    保存并重连
                  </Action>
                </div>
                <label className='flex items-center gap-2 rounded-xl border border-default-200 bg-content1 px-3 py-2'>
                  <Search className='text-default-400' size={16} />
                  <input
                    value={mcpQuery}
                    onChange={event => setMcpQuery(event.target.value)}
                    placeholder='搜索服务、传输或地址'
                    className='min-w-0 flex-1 bg-transparent text-sm outline-none'
                  />
                </label>
              </div>
              <div className='karin-scrollbar max-h-[570px] space-y-1 overflow-y-auto p-2'>
                {filteredMcpServers.map(server => {
                  const serverStatus = mcp.find(item => String(item.name) === server.name)
                  const connected = Boolean(serverStatus?.connected)
                  return (
                    <button
                      key={server.name}
                      type='button'
                      onClick={() => setSelectedMcpName(server.name)}
                      className={`relative w-full overflow-hidden rounded-xl px-4 py-3 text-left transition ${
                        selectedMcp?.name === server.name
                          ? 'bg-content1 shadow-sm'
                          : 'hover:bg-content1/70'
                      }`}
                    >
                      {selectedMcp?.name === server.name && (
                        <span className='absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary' />
                      )}
                      <div className='flex items-center justify-between gap-3'>
                        <span className='truncate font-semibold'>{server.name}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] ${
                            connected
                              ? 'bg-success-50 text-success-700'
                              : server.enabled
                                ? 'bg-danger-50 text-danger'
                                : 'bg-default-100 text-default-500'
                          }`}
                        >
                          {connected ? '在线' : server.enabled ? '离线' : '已禁用'}
                        </span>
                      </div>
                      <div className='mt-2 flex items-center gap-2'>
                        <span className='rounded bg-default-100 px-1.5 py-0.5 font-mono text-[10px] uppercase'>
                          {server.transport}
                        </span>
                        <span className='truncate font-mono text-[11px] text-default-400'>
                          {server.transport === 'http'
                            ? server.url || '尚未配置 URL'
                            : server.command || '尚未配置 Command'}
                        </span>
                      </div>
                      <div className='mt-2 text-[11px] text-default-400'>
                        {Array.isArray(serverStatus?.tools) ? serverStatus.tools.length : 0} 个
                        Tools
                      </div>
                    </button>
                  )
                })}
                {!filteredMcpServers.length && (
                  <div className='p-8 text-center text-sm text-default-400'>
                    还没有 MCP 服务。新增一个服务开始连接。
                  </div>
                )}
              </div>
            </aside>
            <div className='min-w-0'>
              {selectedMcp && selectedMcpIndex >= 0
                ? (
                  <div className='flex h-full min-h-[560px] flex-col'>
                    <div className='border-b border-default-200 p-5 md:p-7'>
                      <div className='flex flex-wrap items-start justify-between gap-4'>
                        <div>
                          <div className='flex flex-wrap items-center gap-2'>
                            <span
                              className={`rounded-full px-2.5 py-1 text-xs ${
                              selectedMcpStatus?.connected
                                ? 'bg-success-50 text-success-700'
                                : 'bg-danger-50 text-danger'
                            }`}
                            >
                              {selectedMcpStatus?.connected ? '已连接' : '未连接'}
                            </span>
                            <span className='rounded-full bg-primary-50 px-2.5 py-1 font-mono text-xs uppercase text-primary'>
                              {selectedMcp.transport}
                            </span>
                          </div>
                          <h3 className='mt-3 text-2xl font-semibold tracking-tight'>
                            {selectedMcp.name}
                          </h3>
                          <p className='mt-2 text-sm text-default-500'>
                            {Array.isArray(selectedMcpStatus?.tools)
                              ? `${selectedMcpStatus.tools.length} 个远程 Tool 已注册`
                              : '等待 Tool 发现'}
                          </p>
                        </div>
                        <div className='flex flex-wrap gap-2'>
                          <Action onClick={saveMcp}>保存并重连</Action>
                          <Action
                            danger
                            onClick={() => {
                              if (!window.confirm(`删除 MCP 服务“${selectedMcp.name}”？`)) return
                              setAgentConfig({
                                ...agentConfig!,
                                mcp: {
                                  ...agentConfig!.mcp,
                                  servers: agentConfig!.mcp.servers.filter(
                                    (_, index) => index !== selectedMcpIndex
                                  ),
                                },
                              })
                            }}
                          >
                            <Trash2 size={15} />
                            删除
                          </Action>
                        </div>
                      </div>
                      {Boolean(selectedMcpStatus?.error) && (
                        <div className='mt-4 rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm text-danger'>
                          {String(selectedMcpStatus?.error)}
                        </div>
                      )}
                    </div>
                    <div className='karin-scrollbar grid flex-1 gap-6 overflow-y-auto p-5 md:p-7 lg:grid-cols-[minmax(0,1fr)_320px]'>
                      <section className='space-y-4'>
                        <div className='grid gap-4 md:grid-cols-2'>
                          <label className='grid gap-1.5 text-sm font-medium'>
                            服务名称
                            <input
                              value={selectedMcp.name}
                              onChange={event =>
                                updateMcpServer(selectedMcpIndex, { name: event.target.value })}
                              className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono text-sm'
                            />
                          </label>
                          <label className='grid gap-1.5 text-sm font-medium'>
                            传输方式
                            <select
                              value={selectedMcp.transport}
                              onChange={event =>
                                updateMcpServer(selectedMcpIndex, {
                                  transport: event.target.value as 'stdio' | 'http',
                                })}
                              className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5'
                            >
                              <option value='http'>Streamable HTTP</option>
                              <option value='stdio'>stdio</option>
                            </select>
                          </label>
                        </div>
                        <label className='flex items-center justify-between rounded-xl border border-default-200 p-3'>
                          <span>
                            <span className='block text-sm font-medium'>启用此服务</span>
                            <span className='text-xs text-default-400'>
                              保存后重新建立连接并发现 Tools
                            </span>
                          </span>
                          <input
                            type='checkbox'
                            checked={selectedMcp.enabled}
                            onChange={event =>
                              updateMcpServer(selectedMcpIndex, { enabled: event.target.checked })}
                          />
                        </label>
                        {selectedMcp.transport === 'http'
                          ? (
                            <>
                              <label className='grid gap-1.5 text-sm font-medium'>
                                Streamable HTTP URL
                                <input
                                  value={selectedMcp.url || ''}
                                  onChange={event =>
                                    updateMcpServer(selectedMcpIndex, { url: event.target.value })}
                                  placeholder='https://example.com/mcp'
                                  className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono text-sm'
                                />
                              </label>
                              <label className='grid gap-1.5 text-sm font-medium'>
                                HTTP Headers
                                <textarea
                                  value={recordLines(selectedMcp.headers)}
                                  onChange={event =>
                                    updateMcpServer(selectedMcpIndex, {
                                      headers: linesRecord(event.target.value),
                                    })}
                                  placeholder={mcpHeaderExample}
                                  className='min-h-32 resize-y rounded-xl border border-default-200 bg-default-50 px-3 py-3 font-mono text-sm'
                                />
                                <span className='text-xs font-normal text-default-400'>
                                  每行 KEY=VALUE；敏感值必须通过 {environmentReference} 引用环境变量。
                                </span>
                              </label>
                            </>
                          )
                          : (
                            <>
                              <label className='grid gap-1.5 text-sm font-medium'>
                                Command
                                <input
                                  value={selectedMcp.command || ''}
                                  onChange={event =>
                                    updateMcpServer(selectedMcpIndex, {
                                      command: event.target.value,
                                    })}
                                  placeholder='npx'
                                  className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono text-sm'
                                />
                              </label>
                              <div className='grid gap-4 md:grid-cols-2'>
                                <label className='grid gap-1.5 text-sm font-medium'>
                                  Arguments
                                  <input
                                    value={(selectedMcp.args || []).join(', ')}
                                    onChange={event =>
                                      updateMcpServer(selectedMcpIndex, {
                                        args: event.target.value
                                          .split(',')
                                          .map(value => value.trim())
                                          .filter(Boolean),
                                      })}
                                    placeholder='-y, @scope/server'
                                    className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono text-sm'
                                  />
                                </label>
                                <label className='grid gap-1.5 text-sm font-medium'>
                                  Working directory
                                  <input
                                    value={selectedMcp.cwd || ''}
                                    onChange={event =>
                                      updateMcpServer(selectedMcpIndex, { cwd: event.target.value })}
                                    placeholder='可选'
                                    className='rounded-xl border border-default-200 bg-default-50 px-3 py-2.5 font-mono text-sm'
                                  />
                                </label>
                              </div>
                              <label className='grid gap-1.5 text-sm font-medium'>
                                环境变量
                                <textarea
                                  value={recordLines(selectedMcp.env)}
                                  onChange={event =>
                                    updateMcpServer(selectedMcpIndex, {
                                      env: linesRecord(event.target.value),
                                    })}
                                  placeholder={mcpEnvExample}
                                  className='min-h-32 resize-y rounded-xl border border-default-200 bg-default-50 px-3 py-3 font-mono text-sm'
                                />
                                <span className='text-xs font-normal text-default-400'>
                                  每行 KEY={environmentReference}；不得在配置中写入真实凭据。
                                </span>
                              </label>
                            </>
                          )}
                      </section>
                      <aside>
                        <div className='mb-3 flex items-center gap-2'>
                          <Server size={16} />
                          <h4 className='font-semibold'>已发现 Tools</h4>
                        </div>
                        <div className='space-y-2'>
                          {(Array.isArray(selectedMcpStatus?.tools)
                            ? selectedMcpStatus.tools
                            : []
                          ).map(tool => (
                            <div
                              key={String(tool)}
                              className='rounded-xl border border-default-200 bg-default-50 p-3 font-mono text-xs'
                            >
                              {String(tool)}
                            </div>
                          ))}
                          {!Array.isArray(selectedMcpStatus?.tools) ||
                        !selectedMcpStatus.tools.length
                            ? (
                              <div className='rounded-xl border border-dashed border-default-200 p-6 text-center text-sm text-default-400'>
                                连接成功后会在这里显示远程 Tools。
                              </div>
                            )
                            : null}
                        </div>
                      </aside>
                    </div>
                  </div>
                )
                : (
                  <div className='grid min-h-[560px] place-items-center p-8 text-center text-sm text-default-400'>
                    选择一个 MCP 服务查看连接与 Tool 状态，或新增第一个服务。
                  </div>
                )}
            </div>
          </div>
        </Panel>
      )}

      {tab === 'evolution' && (
        <Panel className='overflow-hidden'>
          <div className='flex flex-wrap items-start justify-between gap-3 border-b border-default-200 p-5'>
            <div>
              <h2 className='text-lg font-semibold'>自我进化日志</h2>
              <p className='mt-1 text-sm text-default-500'>
                只记录已经生效、回滚或应用失败的改进，不提供候选操作和源码管理功能。
              </p>
            </div>
            <div className='flex flex-wrap gap-2'>
              <Action
                onClick={async () => setEvolutionLogs(await agentRequest.evolutionLogs())}
              >
                <RefreshCw size={15} />
                刷新日志
              </Action>
              <Action
                danger
                disabled={!evolutionLogs.length}
                onClick={async () => {
                  if (!window.confirm('清空全部自我进化日志？此操作不可恢复。')) return
                  const result = await agentRequest.clearEvolutionLogs()
                  setEvolutionLogs([])
                  toast.success(`已清空 ${result.deleted} 条自我进化日志`)
                }}
              >
                <Trash2 size={15} />
                清空日志
              </Action>
            </div>
          </div>
          <div className='karin-scrollbar max-h-[720px] overflow-y-auto'>
            {evolutionLogs.map((entry, index) => (
              <div
                key={entry.id}
                className={`grid gap-2 px-5 py-4 md:grid-cols-[180px_110px_minmax(0,1fr)_auto] ${
                  index ? 'border-t border-default-100' : ''
                }`}
              >
                <time className='font-mono text-xs text-default-400'>
                  {date(entry.createdAt)}
                </time>
                <div>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${
                      entry.action === 'improved'
                        ? 'bg-success-50 text-success-700'
                        : entry.action === 'rolled_back'
                          ? 'bg-warning-50 text-warning-700'
                          : 'bg-danger-50 text-danger'
                    }`}
                  >
                    {entry.action === 'improved'
                      ? '已改进'
                      : entry.action === 'rolled_back'
                        ? '已回滚'
                        : '应用失败'}
                  </span>
                </div>
                <div className='min-w-0'>
                  <div className='font-medium'>{entry.summary}</div>
                  <div className='mt-1 text-sm text-default-600'>{entry.change}</div>
                  <div className='mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-default-400'>
                    <span>{entry.target}</span>
                    <span>版本 {entry.candidateVersion}</span>
                    <span>来源 Turn {entry.sourceTurnIds.length} 个</span>
                  </div>
                  {typeof entry.detail.error === 'string' && entry.detail.error && (
                    <div className='mt-2 rounded-lg bg-danger-50 px-3 py-2 text-xs text-danger'>
                      {entry.detail.error}
                    </div>
                  )}
                </div>
                <div className='md:self-start'>
                  <Action
                    danger
                    onClick={async () => {
                      if (!window.confirm('删除此条自我进化日志？此操作不可恢复。')) return
                      const result = await agentRequest.deleteEvolutionLog(entry.id)
                      if (!result.deleted) {
                        toast.error('日志不存在或已被删除')
                        return
                      }
                      setEvolutionLogs(current => current.filter(item => item.id !== entry.id))
                      toast.success('自我进化日志已删除')
                    }}
                  >
                    <Trash2 size={14} />
                    删除
                  </Action>
                </div>
              </div>
            ))}
            {!evolutionLogs.length && (
              <div className='p-12 text-center text-sm text-default-400'>
                暂无已生效的自我进化记录。
              </div>
            )}
          </div>
        </Panel>
      )}
      {tab === 'customization' && <AgentCustomization />}

      {tab === 'tools' && (
        <Panel>
          <div className='border-b border-default-200 p-5'>
            <h2 className='text-lg font-semibold'>Tools 与 Toolsets</h2>
            <p className='text-sm text-default-500'>
              Agent 只调用插件显式注册的结构化 Tool；固定正则命令不会被递归执行。
            </p>
            <div className='mt-3 flex flex-wrap gap-2'>
              {[...new Set(tools.map(item => String(item.toolset || 'plugin')))].map(toolset => {
                const disabled = agentConfig?.tools.disabledToolsets.includes(toolset)
                return (
                  <button
                    key={toolset}
                    type='button'
                    onClick={() => toggleToolset(toolset)}
                    className={`rounded-full px-3 py-1.5 text-xs ${
                      disabled ? 'bg-danger-50 text-danger' : 'bg-success-50 text-success-700'
                    }`}
                  >
                    {toolset} · {disabled ? '已禁用' : '已启用'}
                  </button>
                )
              })}
            </div>
          </div>
          {generatedTools.length > 0 && (
            <div className='border-b border-default-200 bg-primary-50/40 p-5'>
              <h3 className='text-sm font-semibold'>Generated Tool Library</h3>
              <p className='mt-1 text-xs text-default-500'>
                仅包含通过静态校验与隔离沙箱验证的纯计算 Tool；版本不可变并可回滚。
              </p>
              <div className='mt-3 grid gap-2 lg:grid-cols-2'>
                {generatedTools.map((item, index) => (
                  <div
                    key={String(item.id || index)}
                    className='rounded-xl border border-primary-100 bg-content1 p-3'
                  >
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='font-mono text-xs font-semibold'>
                        {String(item.name || '')}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${
                        item.enabled
                          ? 'bg-success-50 text-success-700'
                          : 'bg-default-100 text-default-500'
                      }`}
                      >
                        {item.enabled ? '已启用' : '已禁用'}
                      </span>
                    </div>
                    <p className='mt-1 text-xs text-default-500'>
                      {String(item.description || '')}
                    </p>
                    <p className='mt-2 font-mono text-[11px] text-default-400'>
                      active {String(item.activeVersionId || 'none')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className='grid gap-3 p-5 lg:grid-cols-2'>
            {tools.map((item, index) => (
              <details
                key={String(item.name || index)}
                className='rounded-2xl border border-default-200 p-4'
              >
                <summary className='cursor-pointer'>
                  <div className='inline-flex flex-wrap items-center gap-2'>
                    <span className='font-semibold'>{String(item.name || '')}</span>
                    <span className='rounded-full bg-primary-50 px-2 py-1 text-xs text-primary'>
                      {String(item.toolset || 'plugin')}
                    </span>
                    <span className='rounded-full bg-default-100 px-2 py-1 text-xs'>
                      {String(item.risk || 'read')}
                    </span>
                    <span className={`rounded-full px-2 py-1 text-xs ${
                      item.isolation === 'legacy-inline'
                        ? 'bg-warning-50 text-warning-700'
                        : 'bg-success-50 text-success-700'
                    }`}
                    >
                      {String(item.isolation || 'legacy-inline')}
                    </span>
                  </div>
                </summary>
                <p className='mt-3 text-sm text-default-500'>{String(item.description || '')}</p>
                <p className='mt-2 text-xs text-default-400'>
                  来源 {String(item.source || 'unknown')} · 权限 {String(item.permission || 'all')}
                </p>
                {item.isolation === 'legacy-inline' && (
                  <p className='mt-2 rounded-lg bg-warning-50 px-3 py-2 text-xs text-warning-700'>
                    此插件 Tool 在 Core 进程内执行；开启严格隔离模式后会被拒绝。
                  </p>
                )}
                <div className='mt-3'>
                  <Action onClick={() => toggleTool(String(item.name || ''))}>
                    {agentConfig?.tools.disabled.includes(String(item.name || ''))
                      ? '启用 Tool'
                      : '禁用 Tool'}
                  </Action>
                </div>
                <pre className='mt-3 max-h-72 overflow-auto rounded-xl bg-default-50 p-3 text-xs'>
                  {JSON.stringify(item.inputSchema || {}, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </Panel>
      )}

      {tab === 'runs' && (
        <div className='grid gap-5 xl:grid-cols-2'>
          <Panel>
            <div className='border-b border-default-200 p-5'>
              <h2 className='text-lg font-semibold'>Provider 用量</h2>
            </div>
            <div className='max-h-[760px] divide-y divide-default-200 overflow-auto'>
              {usage.map((item, index) => (
                <div key={index} className='p-4 text-sm'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='font-semibold'>
                      {String(item.provider || '')} · {String(item.model || '')}
                    </span>
                    <span className='text-xs text-default-400'>
                      {Number(item.latency_ms || 0)}ms
                    </span>
                  </div>
                  <p className='mt-1 text-xs text-default-500'>
                    tokens {Number(item.input_tokens || 0)} / {Number(item.output_tokens || 0)}
                    {' · '}重试 {Number(item.retry_count || 0)}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
          <Panel>
            <div className='border-b border-default-200 p-5'>
              <h2 className='text-lg font-semibold'>审计记录</h2>
            </div>
            <div className='max-h-[760px] divide-y divide-default-200 overflow-auto'>
              {audit.map((item, index) => (
                <div key={index} className='p-4 text-sm'>
                  <div className='font-semibold'>{String(item.action || '')}</div>
                  <div className='mt-1 break-all text-default-500'>{String(item.target || '')}</div>
                  <div className='mt-2 text-xs text-default-400'>
                    {date(Number(item.created_at))}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {tab === 'config' && (
        <div className='grid gap-5 xl:grid-cols-[1fr_420px]'>
          <Panel>
            <div className='flex items-center justify-between border-b border-default-200 p-5'>
              <div>
                <h2 className='text-lg font-semibold'>Agent 配置</h2>
                <p className='text-sm text-default-500'>
                  API Key 保存到运行时 config/agent.json；接口、日志和审计不回显。
                </p>
              </div>
              <div className='flex gap-2'>
                <Action onClick={addProvider}>新增 Provider</Action>
                <Action onClick={saveConfig}>保存并重载</Action>
              </div>
            </div>
            {agentConfig && (
              <div className='space-y-6 p-5'>
                <label className='flex items-center justify-between rounded-xl bg-default-50 p-4'>
                  <span>
                    <span className='block font-semibold'>启用 Karin Agent</span>
                    <span className='text-xs text-default-500'>固定命令始终优先。</span>
                  </span>
                  <input
                    type='checkbox'
                    checked={agentConfig.enabled}
                    onChange={event =>
                      setAgentConfig({ ...agentConfig, enabled: event.target.checked })}
                  />
                </label>

                <div className='space-y-3'>
                  <div>
                    <h3 className='font-semibold'>模型 Provider</h3>
                    <p className='text-xs text-default-500'>
                      支持模型发现，也可直接填写任意兼容模型名称。
                    </p>
                  </div>
                  {agentConfig.providers.map(provider => (
                    <div key={provider.id} className='rounded-2xl border border-default-200 p-4'>
                      <div className='mb-3 flex items-center justify-between gap-3'>
                        <input
                          value={provider.name}
                          onChange={event =>
                            updateProvider(provider.id, { name: event.target.value })}
                          className='min-w-0 flex-1 bg-transparent font-semibold outline-none'
                          aria-label='Provider 名称'
                        />
                        <label className='flex items-center gap-2 text-sm'>
                          <input
                            type='checkbox'
                            checked={provider.enabled}
                            onChange={event =>
                              updateProvider(provider.id, { enabled: event.target.checked })}
                          />
                          启用
                        </label>
                        <Action
                          danger
                          onClick={() =>
                            setAgentConfig(value => {
                              if (!value) return value
                              const providers = value.providers.filter(
                                item => item.id !== provider.id
                              )
                              const primary =
                                value.routing.primary === provider.id
                                  ? providers[0]?.id || ''
                                  : value.routing.primary
                              return {
                                ...value,
                                providers,
                                routing: {
                                  primary,
                                  fallback: value.routing.fallback.filter(id => id !== provider.id),
                                },
                              }
                            })}
                        >
                          删除
                        </Action>
                      </div>
                      <div className='grid gap-3 md:grid-cols-2'>
                        <label className='text-xs text-default-500'>
                          服务商
                          <select
                            value={provider.kind}
                            onChange={event => {
                              const kind = event.target.value as AgentProviderKind
                              const preset = providerPresets.find(item => item.kind === kind)
                              updateProvider(provider.id, {
                                kind,
                                name:
                                  kind === 'custom' ? provider.name : preset?.name || provider.name,
                                baseUrl: preset?.baseUrl || provider.baseUrl,
                              })
                            }}
                            className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                          >
                            {providerPresets.map(preset => (
                              <option key={preset.kind} value={preset.kind}>
                                {preset.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className='text-xs text-default-500'>
                          稳定 ID
                          <input
                            value={provider.id}
                            readOnly
                            className='mt-1 w-full rounded-xl border border-default-200 bg-default-100 p-2 text-sm'
                          />
                        </label>
                        <label className='text-xs text-default-500 md:col-span-2'>
                          Base URL
                          <input
                            value={provider.baseUrl}
                            onChange={event =>
                              updateProvider(provider.id, { baseUrl: event.target.value })}
                            className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                          />
                        </label>
                        <label className='text-xs text-default-500'>
                          API Key
                          <input
                            type='password'
                            value={provider.apiKey}
                            onChange={event =>
                              updateProvider(provider.id, {
                                apiKey: event.target.value,
                                clearApiKey: false,
                              })}
                            placeholder={
                              provider.apiKeyConfigured ? '已配置（留空保留）' : '未配置'
                            }
                            className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                            autoComplete='new-password'
                          />
                        </label>
                        <label className='text-xs text-default-500'>
                          模型
                          {(providerModels[provider.id] || []).length
                            ? (
                              <select
                                value={provider.model}
                                onChange={event =>
                                  updateProvider(provider.id, { model: event.target.value })}
                                className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                              >
                                {!provider.model && <option value=''>请选择模型</option>}
                                {provider.model &&
                                  !providerModels[provider.id]?.includes(provider.model) && (
                                    <option value={provider.model}>
                                      {provider.model}（当前配置，发现结果未返回）
                                    </option>
                                )}
                                {providerModels[provider.id].map(model => (
                                  <option key={model} value={model}>{model}</option>
                                ))}
                              </select>
                            )
                            : (
                              <input
                                value={provider.model}
                                onChange={event =>
                                  updateProvider(provider.id, { model: event.target.value })}
                                placeholder='自由填写模型名称'
                                className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                              />
                            )}
                        </label>
                        <label className='text-xs text-default-500'>
                          超时（ms）
                          <input
                            type='number'
                            min={1000}
                            max={300000}
                            value={provider.timeout}
                            onChange={event =>
                              updateProvider(provider.id, { timeout: Number(event.target.value) })}
                            className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                          />
                        </label>
                        <label className='text-xs text-default-500'>
                          Provider 协议
                          <select
                            value={provider.protocol || 'chat-completions'}
                            onChange={event => updateProvider(provider.id, {
                              protocol: event.target.value as 'chat-completions' | 'responses',
                            })}
                            className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                          >
                            <option value='chat-completions'>Chat Completions</option>
                            <option value='responses'>Responses</option>
                          </select>
                        </label>
                        <label className='flex items-center gap-2 self-end pb-2 text-xs text-danger'>
                          <input
                            type='checkbox'
                            checked={Boolean(provider.clearApiKey)}
                            onChange={event =>
                              updateProvider(provider.id, {
                                clearApiKey: event.target.checked,
                                apiKey: '',
                              })}
                          />
                          保存时清除 API Key
                        </label>
                        <label className='flex items-center gap-2 self-end pb-2 text-xs text-default-500'>
                          <input
                            type='checkbox'
                            disabled={!provider.model}
                            checked={Boolean(
                              provider.model &&
                              provider.visionModels?.includes(provider.model)
                            )}
                            onChange={event => {
                              const current = new Set(provider.visionModels || [])
                              if (event.target.checked) current.add(provider.model)
                              else current.delete(provider.model)
                              updateProvider(provider.id, {
                                visionModels: [...current].filter(Boolean).sort(),
                              })
                            }}
                          />
                          当前模型支持图片理解
                        </label>
                      </div>
                      <div className='mt-3 flex flex-wrap gap-2'>
                        <Action
                          disabled={providerBusy !== ''}
                          onClick={() => discoverModels(provider.id)}
                        >
                          {providerBusy === `models:${provider.id}` ? '发现中…' : '发现模型'}
                        </Action>
                        <Action
                          disabled={providerBusy !== ''}
                          onClick={() => testProvider(provider.id)}
                        >
                          {providerBusy === `test:${provider.id}` ? '测试中…' : '完整连接测试'}
                        </Action>
                      </div>
                    </div>
                  ))}
                </div>

                <div className='grid gap-4 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <label className='text-xs text-default-500'>
                    主 Provider
                    <select
                      value={agentConfig.routing.primary}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          routing: { ...agentConfig.routing, primary: event.target.value },
                        })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    >
                      {agentConfig.providers.map(provider => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className='text-xs text-default-500'>
                    Fallback 顺序（逗号分隔 ID）
                    <input
                      value={agentConfig.routing.fallback.join(', ')}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          routing: {
                            ...agentConfig.routing,
                            fallback: event.target.value
                              .split(',')
                              .map(value => value.trim())
                              .filter(Boolean),
                          },
                        })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                </div>

                <div className='grid gap-4 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <h3 className='md:col-span-2 font-semibold'>记忆召回与执行边界</h3>
                  <label className='text-xs text-default-500'>最多注入记忆
                    <input
                      type='number' min={1} max={50}
                      value={agentConfig.memory.retrieval.maxItems}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        memory: {
                          ...agentConfig.memory,
                          retrieval: { ...agentConfig.memory.retrieval, maxItems: Number(event.target.value) },
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <label className='text-xs text-default-500'>Prompt Token 预算
                    <input
                      type='number' min={128} max={16000}
                      value={agentConfig.memory.retrieval.maxPromptTokens}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        memory: {
                          ...agentConfig.memory,
                          retrieval: { ...agentConfig.memory.retrieval, maxPromptTokens: Number(event.target.value) },
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <label className='flex items-center gap-2 text-sm'>
                    <input
                      type='checkbox'
                      checked={agentConfig.context.semanticCompaction}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        context: {
                          ...agentConfig.context,
                          semanticCompaction: event.target.checked,
                        },
                      })}
                    />
                    模型结构化上下文压缩
                  </label>
                  <label className='text-xs text-default-500'>输出预留 Token
                    <input
                      type='number' min={256} max={131072}
                      value={agentConfig.context.reservedOutputTokens}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        context: {
                          ...agentConfig.context,
                          reservedOutputTokens: Number(event.target.value),
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <label className='text-xs text-default-500'>沙箱模式
                    <select
                      value={agentConfig.execution.sandbox.mode}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        execution: {
                          ...agentConfig.execution,
                          sandbox: {
                            ...agentConfig.execution.sandbox,
                            mode: event.target.value as 'auto' | 'off',
                          },
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    >
                      <option value='auto'>自动检测并启用</option>
                      <option value='off'>关闭</option>
                    </select>
                  </label>
                  <label className='text-xs text-default-500'>沙箱后端
                    <select
                      value={agentConfig.execution.sandbox.backend}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        execution: {
                          ...agentConfig.execution,
                          sandbox: {
                            ...agentConfig.execution.sandbox,
                            backend: event.target.value as 'auto' | 'bwrap' | 'seatbelt' | 'windows',
                          },
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    >
                      <option value='auto'>自动</option>
                      <option value='bwrap'>Linux bwrap</option>
                      <option value='seatbelt'>macOS Seatbelt</option>
                      <option value='windows'>Windows Helper</option>
                    </select>
                  </label>
                  <label className='text-xs text-default-500'>允许读取根目录（每行一个绝对路径）
                    <textarea
                      rows={3}
                      value={agentConfig.execution.sandbox.readRoots.join('\n')}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        execution: {
                          ...agentConfig.execution,
                          sandbox: {
                            ...agentConfig.execution.sandbox,
                            readRoots: event.target.value
                              .split(/\r?\n/)
                              .map(value => value.trim())
                              .filter(Boolean),
                          },
                        },
                      })}
                      placeholder='留空表示仅项目 cwd'
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <label className='text-xs text-default-500'>允许写入根目录（每行一个绝对路径）
                    <textarea
                      rows={3}
                      value={agentConfig.execution.sandbox.writeRoots.join('\n')}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        execution: {
                          ...agentConfig.execution,
                          sandbox: {
                            ...agentConfig.execution.sandbox,
                            writeRoots: event.target.value
                              .split(/\r?\n/)
                              .map(value => value.trim())
                              .filter(Boolean),
                          },
                        },
                      })}
                      placeholder='留空表示仅项目 cwd'
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <label className='text-xs text-default-500'>执行兼容模式
                    <select
                      value={agentConfig.execution.isolationMode}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        execution: {
                          ...agentConfig.execution,
                          isolationMode: event.target.value as 'compat' | 'strict',
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    >
                      <option value='compat'>兼容（允许 legacy inline）</option>
                      <option value='strict'>严格（拒绝 legacy inline）</option>
                    </select>
                  </label>
                  <label className='text-xs text-default-500'>最低隔离等级
                    <select
                      value={agentConfig.execution.minimumIsolation}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        execution: {
                          ...agentConfig.execution,
                          minimumIsolation: event.target.value as 'none' | 'process' | 'os',
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    >
                      <option value='none'>不强制</option>
                      <option value='process'>进程隔离</option>
                      <option value='os'>操作系统硬隔离</option>
                    </select>
                  </label>
                  <label className='text-xs text-default-500'>单 Turn 时限（ms）
                    <input
                      type='number' min={1000} max={3600000}
                      value={agentConfig.execution.maxTurnDurationMs}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        execution: {
                          ...agentConfig.execution,
                          maxTurnDurationMs: Number(event.target.value),
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <label className='text-xs text-default-500'>单 Turn 模型调用上限
                    <input
                      type='number' min={1} max={200}
                      value={agentConfig.execution.maxModelCalls}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        execution: {
                          ...agentConfig.execution,
                          maxModelCalls: Number(event.target.value),
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <p className='md:col-span-2 text-xs text-default-500'>
                    实际沙箱：{status?.isolation
                    ? `${status.isolation.backend} / ${status.isolation.mode} / network=${status.isolation.network}`
                    : '尚未检测'}。只有越界写、断网和进程树自检全部通过才标记为硬隔离；
                    选择操作系统硬隔离时，无可用后端将失败关闭。
                    {status?.isolation?.reason ? ` 当前主机：${status.isolation.reason}` : ''}
                    {status?.isolation?.lastDoctor
                      ? ` 最近自检：${status.isolation.lastDoctor.passed ? '通过' : '失败'}，${new Date(status.isolation.lastDoctor.checkedAt).toLocaleString()}。`
                      : ''}
                  </p>
                </div>

                <div className='grid gap-4 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <h3 className='md:col-span-2 font-semibold'>触发与学习</h3>
                  {(
                    [
                      ['private', '未匹配私聊自动触发'],
                      ['groupMention', '群聊 @机器人触发'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className='flex items-center gap-2 text-sm'>
                      <input
                        type='checkbox'
                        checked={agentConfig.trigger[key]}
                        onChange={event =>
                          setAgentConfig({
                            ...agentConfig,
                            trigger: { ...agentConfig.trigger, [key]: event.target.checked },
                          })}
                      />
                      {label}
                    </label>
                  ))}
                  <label className='text-xs text-default-500 md:col-span-2'>
                    群聊唤醒词（逗号分隔）
                    <input
                      value={agentConfig.trigger.wakeWords.join(', ')}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          trigger: {
                            ...agentConfig.trigger,
                            wakeWords: event.target.value
                              .split(',')
                              .map(value => value.trim())
                              .filter(Boolean),
                          },
                        })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  {(
                    [
                      ['memory', '自动记忆'],
                      ['skills', '自动技能学习'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className='flex items-center gap-2 text-sm'>
                      <input
                        type='checkbox'
                        checked={agentConfig.learning[key]}
                        onChange={event =>
                          setAgentConfig({
                            ...agentConfig,
                            learning: { ...agentConfig.learning, [key]: event.target.checked },
                          })}
                      />
                      {label}
                    </label>
                  ))}
                  <label className='flex items-center gap-2 text-sm'>
                    <input
                      type='checkbox'
                      checked={agentConfig.learning.reflection.enabled}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          learning: {
                            ...agentConfig.learning,
                            reflection: {
                              ...agentConfig.learning.reflection,
                              enabled: event.target.checked,
                            },
                          },
                        })}
                    />
                    后台反思
                  </label>
                  <label className='flex items-center gap-2 text-sm'>
                    <input
                      type='checkbox'
                      checked={agentConfig.learning.curator.enabled}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          learning: {
                            ...agentConfig.learning,
                            curator: {
                              ...agentConfig.learning.curator,
                              enabled: event.target.checked,
                            },
                          },
                        })}
                    />
                    Skill Curator
                  </label>
                  <label className='text-xs text-default-500'>
                    成功反思间隔（回合）
                    <input
                      type='number'
                      min={1}
                      max={100}
                      value={agentConfig.learning.reflection.successInterval}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          learning: {
                            ...agentConfig.learning,
                            reflection: {
                              ...agentConfig.learning.reflection,
                              successInterval: Number(event.target.value),
                            },
                          },
                        })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <label className='text-xs text-default-500'>
                    Skill 最少证据数
                    <input
                      type='number'
                      min={1}
                      max={100}
                      value={agentConfig.learning.promotion.minEvidence}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          learning: {
                            ...agentConfig.learning,
                            promotion: {
                              ...agentConfig.learning.promotion,
                              minEvidence: Number(event.target.value),
                            },
                          },
                        })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <label className='text-xs text-default-500'>
                    Curator 周期（小时）
                    <input
                      type='number'
                      min={1}
                      value={agentConfig.learning.curator.intervalHours}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          learning: {
                            ...agentConfig.learning,
                            curator: {
                              ...agentConfig.learning.curator,
                              intervalHours: Number(event.target.value),
                            },
                          },
                        })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <div className='grid grid-cols-1 gap-2 rounded-xl bg-default-50 p-3 text-xs md:col-span-2 md:grid-cols-2'>
                    {(
                      [
                        ['autoMemory', '记忆验证后自动生效'],
                        ['autoRouting', '路由策略验证后自动生效'],
                        ['autoDeclarativeSkills', '声明式 Skill 达标后自动生效'],
                        ['autoRollback', '指标回退时自动回滚'],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className='flex items-center gap-2'>
                        <input
                          type='checkbox'
                          checked={agentConfig.learning.promotion[key]}
                          onChange={event =>
                            setAgentConfig({
                              ...agentConfig,
                              learning: {
                                ...agentConfig.learning,
                                promotion: {
                                  ...agentConfig.learning.promotion,
                                  [key]: event.target.checked,
                                },
                              },
                            })}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className='grid gap-4 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <div className='flex items-start justify-between gap-4 md:col-span-2'>
                    <div>
                      <h3 className='font-semibold'>任务恢复闭环</h3>
                      <p className='mt-1 text-xs text-default-500'>
                        行动类任务只有通过 Tool 回执验证才会完成；失败时先诊断、再重新召回能力。
                      </p>
                    </div>
                    <label className='flex items-center gap-2 text-sm'>
                      <input
                        type='checkbox'
                        checked={agentConfig.recovery.enabled}
                        onChange={event =>
                          setAgentConfig({
                            ...agentConfig,
                            recovery: {
                              ...agentConfig.recovery,
                              enabled: event.target.checked,
                            },
                          })}
                      />
                      启用
                    </label>
                  </div>
                  {(
                    [
                      ['maxCycles', '最多恢复周期', 0, 5],
                      ['maxDiagnosticCalls', '诊断 Tool 最终熔断上限', 1, 99],
                      ['maxDurationMs', '恢复总时限（毫秒）', 10000, 600000],
                    ] as const
                  ).map(([key, label, min, max]) => (
                    <label key={key} className='text-xs text-default-500'>
                      {label}
                      <input
                        type='number'
                        min={min}
                        max={max}
                        value={agentConfig.recovery[key]}
                        onChange={event =>
                          setAgentConfig({
                            ...agentConfig,
                            recovery: {
                              ...agentConfig.recovery,
                              [key]: Number(event.target.value),
                            },
                          })}
                        className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                      />
                    </label>
                  ))}
                  <label className='text-xs text-default-500'>
                    网络检索策略
                    <select
                      value={agentConfig.recovery.researchPolicy}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          recovery: {
                            ...agentConfig.recovery,
                            researchPolicy: event.target.value as
                              AgentConfig['recovery']['researchPolicy'],
                          },
                        })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    >
                      <option value='evidence-driven'>证据驱动：本地优先，必要时搜索</option>
                      <option value='always'>积极搜索</option>
                      <option value='explicit'>仅明确要求</option>
                    </select>
                  </label>
                  <label className='flex items-center gap-2 rounded-xl bg-default-50 p-3 text-sm'>
                    <input
                      type='checkbox'
                      checked={agentConfig.recovery.repair.requireApproval}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          recovery: {
                            ...agentConfig.recovery,
                            repair: {
                              ...agentConfig.recovery.repair,
                              requireApproval: event.target.checked,
                            },
                          },
                        })}
                    />
                    应用源码修复前必须由管理员审批
                  </label>
                </div>

                <div className='grid gap-3 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <h3 className='md:col-span-2 font-semibold'>运行限制</h3>
                  {(Object.keys(agentConfig.limits) as Array<keyof AgentConfig['limits']>).map(
                    key => (
                      <label key={key} className='text-xs text-default-500'>
                        {key}
                        <input
                          type='number'
                          min={1}
                          max={key === 'maxToolRounds' ? 99 : undefined}
                          value={agentConfig.limits[key]}
                          onChange={event =>
                            setAgentConfig({
                              ...agentConfig,
                              limits: { ...agentConfig.limits, [key]: Number(event.target.value) },
                            })}
                          className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                        />
                      </label>
                    )
                  )}
                </div>

                <div className='grid gap-3 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <div className='flex items-start justify-between gap-3 md:col-span-2'>
                    <div>
                      <h3 className='font-semibold'>Python Script Runtime</h3>
                      <p className='mt-1 text-xs text-default-500'>
                        仅运行管理员审查后的纯计算 Script Tools，不支持依赖安装和系统命令。
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs ${
                        status?.scriptRuntime.available
                          ? 'bg-success-50 text-success-700'
                          : 'bg-danger-50 text-danger-700'
                      }`}
                    >
                      {status?.scriptRuntime.available ? '可用' : '不可用'}
                    </span>
                  </div>
                  <label className='text-xs text-default-500 md:col-span-2'>
                    Python 解释器绝对路径（留空自动发现）
                    <input
                      value={agentConfig.scriptRuntime.pythonExecutable}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          scriptRuntime: {
                            ...agentConfig.scriptRuntime,
                            pythonExecutable: event.target.value,
                          },
                        })}
                      placeholder='C:/Python312/python.exe'
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 font-mono text-sm'
                    />
                  </label>
                  {([
                    ['defaultTimeoutMs', '默认超时（ms）'],
                    ['maxTimeoutMs', '最大超时（ms）'],
                    ['defaultMaxOutputBytes', '默认输出上限（bytes）'],
                    ['maxOutputBytes', '最大输出上限（bytes）'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className='text-xs text-default-500'>
                      {label}
                      <input
                        type='number'
                        value={agentConfig.scriptRuntime[key]}
                        onChange={event =>
                          setAgentConfig({
                            ...agentConfig,
                            scriptRuntime: {
                              ...agentConfig.scriptRuntime,
                              [key]: Number(event.target.value),
                            },
                          })}
                        className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                      />
                    </label>
                  ))}
                  <div className='rounded-xl bg-default-50 p-3 text-xs text-default-500 md:col-span-2'>
                    {status?.scriptRuntime.available
                      ? `${status.scriptRuntime.version || 'Python'} · ${
                        status.scriptRuntime.executable || '自动发现'
                      }`
                      : status?.scriptRuntime.reason || '尚未检测 Python Runtime'}
                  </div>
                </div>

                <div className='grid gap-3 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <h3 className='md:col-span-2 font-semibold'>默认风险策略</h3>
                  {(
                    Object.keys(agentConfig.policy.defaults) as Array<
                      keyof AgentConfig['policy']['defaults']
                    >
                  ).map(risk => (
                    <label key={risk} className='text-xs text-default-500'>
                      {risk}
                      <select
                        value={agentConfig.policy.defaults[risk]}
                        onChange={event =>
                          setAgentConfig({
                            ...agentConfig,
                            policy: {
                              ...agentConfig.policy,
                              defaults: {
                                ...agentConfig.policy.defaults,
                                [risk]: event.target.value,
                              },
                            },
                          })}
                        className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                      >
                        <option value='allow'>允许</option>
                        <option value='ask'>每次询问</option>
                        <option value='deny'>拒绝</option>
                      </select>
                    </label>
                  ))}
                  <label className='text-xs text-default-500 md:col-span-2'>
                    硬拒绝 Tool（每行一个）
                    <textarea
                      value={agentConfig.policy.hardDeny.join('\n')}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          policy: {
                            ...agentConfig.policy,
                            hardDeny: event.target.value
                              .split('\n')
                              .map(value => value.trim())
                              .filter(Boolean),
                          },
                        })}
                      className='mt-1 min-h-24 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <label className='text-xs text-default-500 md:col-span-2'>
                    审批有效期（ms）
                    <input
                      type='number'
                      min={1000}
                      value={agentConfig.policy.approvalTtlMs}
                      onChange={event =>
                        setAgentConfig({
                          ...agentConfig,
                          policy: {
                            ...agentConfig.policy,
                            approvalTtlMs: Number(event.target.value),
                          },
                        })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  <div className='space-y-2 md:col-span-2'>
                    <div className='flex items-center justify-between'>
                      <span className='text-xs text-default-500'>Tool 精确/通配规则（按顺序）</span>
                      <Action
                        onClick={() =>
                          setAgentConfig({
                            ...agentConfig,
                            policy: {
                              ...agentConfig.policy,
                              rules: [
                                ...agentConfig.policy.rules,
                                { pattern: '', decision: 'ask' },
                              ],
                            },
                          })}
                      >
                        新增规则
                      </Action>
                    </div>
                    {agentConfig.policy.rules.map((rule, index) => (
                      <div key={index} className='grid gap-2 md:grid-cols-[1fr_150px_auto]'>
                        <input
                          value={rule.pattern}
                          placeholder='plugin.*'
                          onChange={event =>
                            setAgentConfig({
                              ...agentConfig,
                              policy: {
                                ...agentConfig.policy,
                                rules: agentConfig.policy.rules.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, pattern: event.target.value }
                                    : item
                                ),
                              },
                            })}
                          className='rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                        />
                        <select
                          value={rule.decision}
                          onChange={event =>
                            setAgentConfig({
                              ...agentConfig,
                              policy: {
                                ...agentConfig.policy,
                                rules: agentConfig.policy.rules.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, decision: event.target.value }
                                    : item
                                ),
                              },
                            })}
                          className='rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                        >
                          <option value='allow'>允许</option>
                          <option value='ask'>询问</option>
                          <option value='deny'>拒绝</option>
                        </select>
                        <Action
                          danger
                          onClick={() =>
                            setAgentConfig({
                              ...agentConfig,
                              policy: {
                                ...agentConfig.policy,
                                rules: agentConfig.policy.rules.filter(
                                  (_, itemIndex) => itemIndex !== index
                                ),
                              },
                            })}
                        >
                          删除
                        </Action>
                      </div>
                    ))}
                  </div>
                </div>

                <div className='flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-default-200 p-4'>
                  <div>
                    <div className='flex items-center gap-2 font-semibold'>
                      <Network size={16} />
                      MCP 服务已移至独立工作区
                    </div>
                    <p className='mt-1 text-xs text-default-500'>
                      在同一页面查看连接状态、编辑 stdio/HTTP 配置并检查远程 Tools。
                    </p>
                  </div>
                  <Link
                    to='/agent/mcp'
                    className='inline-flex items-center gap-2 rounded-xl bg-primary-50 px-3 py-2 text-sm font-medium text-primary-700 transition hover:bg-primary-100 dark:bg-primary-500/10 dark:text-primary-300'
                  >
                    打开 MCP 服务
                    <ChevronRight size={15} />
                  </Link>
                </div>

                <details className='rounded-2xl border border-default-200 p-4'>
                  <summary className='cursor-pointer font-semibold'>直接编辑 agent.json</summary>
                  <div className='mt-3 flex flex-wrap items-center justify-between gap-3'>
                    <p className='text-xs text-default-500'>
                      保存的 API Key 不会回显；保留空值即可继续使用现有密钥。
                    </p>
                    <div className='flex gap-2'>
                      <Action
                        onClick={() => {
                          try {
                            const parsed = JSON.parse(agentConfigJson) as unknown
                            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                              throw new Error('agent.json 顶层必须是 JSON 对象')
                            }
                            const next = parsed as AgentConfig
                            setAgentConfig(next)
                            setAgentConfigJson(JSON.stringify(next, null, 2))
                            setAgentConfigJsonDirty(false)
                            setAgentConfigJsonError('')
                            toast.success('JSON 已应用到上方表单')
                          } catch (error) {
                            const message = error instanceof SyntaxError
                              ? `JSON 语法错误：${error.message}`
                              : (error as Error).message
                            setAgentConfigJsonError(message)
                            toast.error(message)
                          }
                        }}
                      >
                        格式化并应用
                      </Action>
                    </div>
                  </div>
                  <textarea
                    value={agentConfigJson}
                    onChange={event => {
                      setAgentConfigJson(event.target.value)
                      setAgentConfigJsonDirty(true)
                      setAgentConfigJsonError('')
                    }}
                    spellCheck={false}
                    aria-label='agent.json 编辑器'
                    className='mt-3 min-h-[420px] w-full resize-y rounded-xl border border-default-200 bg-default-50 p-4 font-mono text-xs leading-5 outline-none focus:border-primary'
                  />
                  {agentConfigJsonError && (
                    <p className='mt-2 text-xs text-danger'>{agentConfigJsonError}</p>
                  )}
                  {agentConfigJsonDirty && !agentConfigJsonError && (
                    <p className='mt-2 text-xs text-warning'>
                      JSON 有未保存修改；点击页面顶部“保存并重载”后写入 agent.json。
                    </p>
                  )}
                </details>
              </div>
            )}
          </Panel>
          <Panel>
            <div className='border-b border-default-200 p-5'>
              <h2 className='text-lg font-semibold'>Provider 用量与审计</h2>
            </div>
            <div className='max-h-[760px] divide-y divide-default-200 overflow-auto'>
              {usage.map((item, index) => (
                <div key={`usage:${index}`} className='bg-primary-50/40 p-4 text-sm'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='font-semibold'>
                      {String(item.provider || '')} · {String(item.model || '')}
                    </span>
                    <span className='text-xs text-default-400'>
                      {Number(item.latency_ms || 0)}ms
                    </span>
                  </div>
                  <div className='mt-1 text-xs text-default-500'>
                    tokens {Number(item.input_tokens || 0)} / {Number(item.output_tokens || 0)}
                    {' · '}重试 {Number(item.retry_count || 0)}
                  </div>
                  {String(item.fallback_json || '[]') !== '[]' && (
                    <div className='mt-1 break-all text-xs text-warning'>
                      fallback {String(item.fallback_json)}
                    </div>
                  )}
                </div>
              ))}
              {audit.map((item, index) => (
                <div key={index} className='p-4 text-sm'>
                  <div className='font-semibold'>{String(item.action || '')}</div>
                  <div className='mt-1 break-all text-default-500'>{String(item.target || '')}</div>
                  <div className='mt-2 text-xs text-default-400'>
                    {date(Number(item.created_at))}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  )
}
