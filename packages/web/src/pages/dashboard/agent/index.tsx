import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  Bot,
  Brain,
  Check,
  Archive,
  ArchiveRestore,
  CircleStop,
  Copy,
  Database,
  Network,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Pencil,
  RotateCcw,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'
import {
  agentRequest,
  type AgentApproval,
  type AgentConfig,
  type AgentJob,
  type AgentMemory,
  type AgentMessage,
  type AgentSkill,
  type AgentStatus,
  type AgentThread,
  type AgentToolCallView,
  type AgentProviderKind,
} from '@/request/agent'

type Page = 'chat' | 'tasks' | 'skills' | 'memories' | 'tools' | 'approvals' | 'runs' | 'config'

const tabs: Array<{ id: Page; label: string; icon: typeof Bot }> = [
  { id: 'chat', label: '对话', icon: Bot },
  { id: 'tasks', label: '定时任务', icon: Workflow },
  { id: 'skills', label: 'Skills', icon: Brain },
  { id: 'memories', label: '记忆', icon: Database },
  { id: 'tools', label: 'Tools', icon: Settings },
  { id: 'approvals', label: '审批', icon: ShieldCheck },
  { id: 'runs', label: '运行记录', icon: Workflow },
  { id: 'config', label: '配置', icon: Settings },
]

const date = (value: number | null | undefined) => (value ? new Date(value).toLocaleString() : '—')
const recordLines = (value: Record<string, string> | undefined) =>
  Object.entries(value || {}).map(([key, item]) => `${key}=${item}`).join('\n')
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

const Panel = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <section
    className={`rounded-2xl border border-default-200 bg-content1/80 shadow-sm ${className}`}
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
        : 'bg-primary-50 text-primary hover:bg-primary-100'
    }`}
  >
    {children}
  </button>
)

const ToolCallCard = ({ call }: { call: AgentToolCallView }) => (
  <details className='w-full rounded-2xl border border-warning-200 bg-warning-50/70 p-3 text-left'>
    <summary className='cursor-pointer list-none'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='font-mono text-xs font-semibold'>{call.name}</span>
          <span className='rounded-full bg-warning-100 px-2 py-0.5 text-[11px]'>
            {call.status}
          </span>
          <span className='rounded-full bg-default-100 px-2 py-0.5 text-[11px]'>
            {call.risk} · {call.decision}
          </span>
        </div>
        <span className='text-[11px] text-default-400'>
          {call.source} · {call.durationMs === undefined ? '—' : `${call.durationMs}ms`}
        </span>
      </div>
    </summary>
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
          <button
            type='button'
            onClick={() => navigator.clipboard.writeText(JSON.stringify(call.output, null, 2))}
            className='text-primary'
          >
            复制
          </button>
        </div>
        <pre className='max-h-64 overflow-auto rounded-xl bg-content1 p-3 text-xs'>
          {call.error || JSON.stringify(call.output ?? null, null, 2)}
        </pre>
      </div>
    </div>
  </details>
)

export default function AgentDashboard () {
  const location = useLocation()
  const navigate = useNavigate()
  const routePage = location.pathname.split('/').filter(Boolean)[1] as Page | undefined
  const tab: Page = tabs.some(item => item.id === routePage) ? routePage! : 'chat'
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [threads, setThreads] = useState<AgentThread[]>([])
  const [threadState, setThreadState] = useState<'active' | 'archived'>('active')
  const [current, setCurrent] = useState<AgentThread | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [toolCalls, setToolCalls] = useState<AgentToolCallView[]>([])
  const [streaming, setStreaming] = useState('')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState('')
  const [approvals, setApprovals] = useState<AgentApproval[]>([])
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [jobs, setJobs] = useState<AgentJob[]>([])
  const [jobRuns, setJobRuns] = useState<Array<Record<string, unknown>>>([])
  const [mcp, setMcp] = useState<Array<Record<string, unknown>>>([])
  const [tools, setTools] = useState<Array<Record<string, unknown>>>([])
  const [audit, setAudit] = useState<Array<Record<string, unknown>>>([])
  const [usage, setUsage] = useState<Array<Record<string, unknown>>>([])
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
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
  })
  const [memoryDraft, setMemoryDraft] = useState({
    scope: 'user',
    scopeKey: 'web-admin',
    content: '',
  })
  const [skillDraft, setSkillDraft] = useState({
    name: '',
    description: '',
    instructions: '',
    tools: '',
  })
  const threadKey = useMemo(() => `web:${crypto.randomUUID()}`, [])
  const lastEventId = useRef<Record<string, number>>({})
  const toolCallById = useMemo(
    () => new Map(toolCalls.map(call => [call.id, call])),
    [toolCalls]
  )

  const refresh = useCallback(async () => {
    const [
      nextStatus,
      nextThreads,
      nextApprovals,
      nextMemories,
      nextSkills,
      nextJobs,
      nextJobRuns,
      nextMcp,
      nextTools,
      nextAudit,
      nextUsage,
      nextConfig,
    ] = await Promise.all([
      agentRequest.status(),
      agentRequest.threads({ state: threadState }),
      agentRequest.approvals(),
      agentRequest.memories(),
      agentRequest.skills(),
      agentRequest.jobs(),
      agentRequest.jobRuns(),
      agentRequest.mcp(),
      agentRequest.tools(),
      agentRequest.audit(),
      agentRequest.usage(),
      agentRequest.config(),
    ])
    setStatus(nextStatus)
    setThreads(nextThreads)
    setApprovals(nextApprovals)
    setMemories(nextMemories)
    setSkills(nextSkills)
    setJobs(nextJobs)
    setJobRuns(nextJobRuns)
    setMcp(nextMcp)
    setTools(nextTools)
    setAudit(nextAudit)
    setUsage(nextUsage)
    setAgentConfig(nextConfig.config)
    setProviderPresets(await agentRequest.providerPresets())
  }, [threadState])

  useEffect(() => {
    refresh().catch(error => toast.error(error.message))
  }, [refresh])

  useEffect(() => {
    if (!current) {
      setMessages([])
      setToolCalls([])
      return
    }
    Promise.all([
      agentRequest.messages(current.id),
      agentRequest.toolCalls(current.id),
    ])
      .then(([nextMessages, nextToolCalls]) => {
        setMessages(nextMessages)
        setToolCalls(nextToolCalls)
      })
      .catch(error => setChatError(error.message))
    const source = agentRequest.events(current.id, lastEventId.current[current.id] || 0)
    const listen = (type: string, callback: (data: any) => void) => {
      ;(source as any).addEventListener(type, (event: { data: string; lastEventId?: string }) => {
        const payload = JSON.parse(event.data)
        const eventId = Number(event.lastEventId || payload.id || 0)
        if (eventId) lastEventId.current[current.id] = eventId
        callback(payload.data)
      })
    }
    const refreshConversation = () => {
      agentRequest.messages(current.id).then(setMessages)
      agentRequest.toolCalls(current.id).then(setToolCalls)
      agentRequest.threads({ state: threadState }).then(setThreads)
    }
    listen('turn.started', () => {
      setChatError('')
      setSending(true)
      setStreaming('')
    })
    listen('text.delta', data => setStreaming(value => value + String(data.delta || '')))
    listen('turn.completed', () => {
      setSending(false)
      setStreaming('')
      refreshConversation()
    })
    listen('turn.failed', data => {
      setSending(false)
      setStreaming('')
      setChatError(String(data.error || data.content || 'Agent 回合失败'))
      refreshConversation()
    })
    listen('approval.requested', () => {
      setSending(false)
      agentRequest.approvals().then(setApprovals)
      agentRequest.toolCalls(current.id).then(setToolCalls)
    })
    listen('tool.started', () => agentRequest.toolCalls(current.id).then(setToolCalls))
    listen('tool.completed', () => agentRequest.toolCalls(current.id).then(setToolCalls))
    return () => source.close()
  }, [current, threadState])

  const ensureThread = async () => {
    if (current) return current
    const created = await agentRequest.createThread(threadKey)
    setCurrent(created)
    setThreads(value => [created, ...value.filter(item => item.id !== created.id)])
    return created
  }

  const send = async (override?: string) => {
    const content = (override ?? prompt).trim()
    if (!content || sending) return
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
      await agentRequest.startTurn(thread.id, content)
    } catch (error) {
      setChatError((error as Error).message)
      setSending(false)
      setStreaming('')
    }
  }

  const resolveApproval = async (approval: AgentApproval, decision: 'approved' | 'denied') => {
    try {
      await agentRequest.resolveApproval(approval.id, decision)
      setApprovals(await agentRequest.approvals())
      if (current) setMessages(await agentRequest.messages(current.id))
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const saveConfig = async () => {
    if (!agentConfig) return
    try {
      await agentRequest.saveConfig(agentConfig)
      toast.success('Agent 配置已保存并重新加载')
      await refresh()
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const updateProvider = (
    id: string,
    patch: Partial<AgentConfig['providers'][number]>
  ) => {
    setAgentConfig(value => value
      ? {
        ...value,
        providers: value.providers.map(provider =>
          provider.id === id ? { ...provider, ...patch } : provider
        ),
      }
      : value)
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
      toast.success(
        `认证/对话/SSE/Tool 均通过，${result.latency}ms，模型 ${result.model}`
      )
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setProviderBusy('')
    }
  }

  const search = async () => {
    try {
      setThreads(await agentRequest.threads({
        state: threadState,
        query: searchText.trim() || undefined,
      }))
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
    setThreads(value => value.map(item => item.id === updated.id ? updated : item))
  }

  const archiveCurrent = async (archived: boolean) => {
    if (!current) return
    try {
      const updated = await agentRequest.updateThread(current.id, { archived })
      setCurrent(null)
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
      setJobs(await agentRequest.jobs())
      setJobDraft(value => ({ ...value, name: '', prompt: '' }))
      toast.success('自动任务已保存')
    } catch (error) {
      toast.error((error as Error).message)
    }
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

  const createSkill = async () => {
    try {
      await agentRequest.createSkill({
        ...skillDraft,
        tools: skillDraft.tools
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
      })
      setSkills(await agentRequest.skills())
      setSkillDraft({ name: '', description: '', instructions: '', tools: '' })
      toast.success('Skill 版本已创建')
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  return (
    <div className='mx-auto flex w-full max-w-[1600px] flex-col gap-5'>
      <header className='flex flex-col gap-4 rounded-3xl border border-primary-200/50 bg-gradient-to-br from-primary-50 via-content1 to-secondary-50 p-6 md:flex-row md:items-center md:justify-between'>
        <div>
          <div className='mb-2 flex items-center gap-3'>
            <div className='rounded-2xl bg-primary p-3 text-primary-foreground'>
              <Bot />
            </div>
            <h1 className='text-2xl font-semibold tracking-tight'>Karin Agent</h1>
          </div>
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

      <nav className='flex gap-2 overflow-x-auto rounded-2xl border border-default-200 bg-content1 p-2'>
        {tabs.map(item => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type='button'
              onClick={() => navigate(`/agent/${item.id}`)}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                tab === item.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-default-500 hover:bg-default-100'
              }`}
            >
              <Icon size={17} />
              {item.label}
            </button>
          )
        })}
      </nav>

      {tab === 'chat' && (
        <div className='grid min-h-[680px] gap-5 xl:grid-cols-[320px_1fr]'>
          <Panel className='flex flex-col overflow-hidden'>
            <div className='border-b border-default-200 p-4'>
              <div className='mb-3 flex items-center justify-between'>
                <h2 className='font-semibold'>Threads</h2>
                <Action
                  onClick={() => {
                    setCurrent(null)
                    setThreadState('active')
                    setChatError('')
                  }}
                >
                  新建
                </Action>
              </div>
              <div className='mb-3 grid grid-cols-2 gap-2 rounded-xl bg-default-100 p-1'>
                {(['active', 'archived'] as const).map(state => (
                  <button
                    key={state}
                    type='button'
                    onClick={() => {
                      setThreadState(state)
                      setCurrent(null)
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                      threadState === state ? 'bg-content1 text-primary shadow-sm' : 'text-default-500'
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
            <div className='flex-1 space-y-2 overflow-y-auto p-3'>
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
                <button
                  key={thread.id}
                  type='button'
                  onClick={() => setCurrent(thread)}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    current?.id === thread.id
                      ? 'border-primary bg-primary-50'
                      : 'border-transparent hover:bg-default-100'
                  }`}
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span className='truncate text-sm font-medium'>
                      {thread.title || thread.threadKey}
                    </span>
                    <span className='text-[11px] text-default-400'>{thread.state}</span>
                  </div>
                  <div className='mt-1 text-xs text-default-400'>
                    {thread.parentThreadId ? '子 Agent' : thread.scene} · {date(thread.updatedAt)}
                  </div>
                  {thread.lastMessagePreview && (
                    <div className='mt-1 truncate text-xs text-default-500'>
                      {thread.lastMessagePreview}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </Panel>

          <Panel className='flex min-h-[680px] flex-col overflow-hidden'>
            <div className='flex items-center justify-between border-b border-default-200 px-5 py-4'>
              <div>
                <h2 className='font-semibold'>
                  {current ? current.title || current.threadKey : '新对话'}
                </h2>
                <p className='text-xs text-default-400'>
                  {current ? `Thread ${current.id}` : '发送第一条消息后创建 Thread'}
                </p>
              </div>
              {current && (
                <div className='flex flex-wrap justify-end gap-2'>
                  <Action onClick={renameCurrent}>
                    <Pencil size={15} />
                    重命名
                  </Action>
                  <Action onClick={() => archiveCurrent(!current.archivedAt)}>
                    {current.archivedAt
                      ? <ArchiveRestore size={15} />
                      : <Archive size={15} />}
                    {current.archivedAt ? '恢复' : '归档'}
                  </Action>
                  <Action
                    onClick={async () => {
                      await agentRequest.interrupt(current.id)
                    }}
                    danger
                  >
                    <CircleStop size={16} />
                    中断
                  </Action>
                  <Action onClick={deleteCurrent} danger>
                    <Trash2 size={15} />
                    删除
                  </Action>
                </div>
              )}
            </div>
            {chatError && (
              <div className='border-b border-danger-200 bg-danger-50 px-5 py-3 text-sm text-danger'>
                {chatError}
              </div>
            )}
            <div className='flex-1 space-y-4 overflow-y-auto bg-default-50/40 p-5'>
              {messages.map(message => {
                const call = message.toolCallId
                  ? toolCallById.get(message.toolCallId)
                  : undefined
                if (message.role === 'tool' && call) {
                  return <ToolCallCard key={message.id} call={call} />
                }
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
                    <div className='whitespace-pre-wrap break-words'>{message.content}</div>
                    <button
                      type='button'
                      title='复制'
                      onClick={() => navigator.clipboard.writeText(message.content)}
                      className={`absolute -bottom-3 ${
                        message.role === 'user' ? 'right-2' : 'left-2'
                      } rounded-full border border-default-200 bg-content1 p-1 text-default-500 opacity-0 shadow-sm transition group-hover:opacity-100`}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                )
              })}
              {toolCalls
                .filter(call => !messages.some(message => message.toolCallId === call.id))
                .map(call => <ToolCallCard key={call.id} call={call} />)}
              {streaming && (
                <div className='max-w-[86%] rounded-2xl border border-primary-200 bg-content1 px-4 py-3 text-sm leading-6'>
                  <div className='whitespace-pre-wrap'>{streaming}</div>
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
            </div>
            <div className='border-t border-default-200 p-4'>
              <div className='flex items-end gap-3'>
                <textarea
                  value={prompt}
                  onChange={event => setPrompt(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      send()
                    }
                  }}
                  rows={3}
                  disabled={Boolean(current?.archivedAt)}
                  placeholder='输入自然语言；群聊中仅 @机器人或唤醒词触发。'
                  className='min-h-[84px] flex-1 resize-none rounded-2xl border border-default-200 bg-default-50 px-4 py-3 outline-none focus:border-primary'
                />
                <button
                  type='button'
                  disabled={
                    (!sending && (!prompt.trim() || status?.state !== 'ready')) ||
                    Boolean(current?.archivedAt)
                  }
                  onClick={() => {
                    if (sending && current) {
                      agentRequest.interrupt(current.id)
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
              只有原始发起者或管理员可处理，默认 5 分钟过期。
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
                      允许一次
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

      {(tab === 'memories' || tab === 'skills') && (
        <div className='grid gap-5'>
          {tab === 'memories' && (
            <Panel>
              <div className='border-b border-default-200 p-5'>
                <h2 className='flex items-center gap-2 text-lg font-semibold'>
                  <Database size={19} />
                  长期记忆
                </h2>
              </div>
              <div className='grid gap-3 border-b border-default-200 p-5 md:grid-cols-3'>
                <select
                  value={memoryDraft.scope}
                  onChange={event =>
                    setMemoryDraft(value => ({ ...value, scope: event.target.value }))}
                  className='rounded-xl border border-default-200 bg-default-50 px-3 py-2'
                >
                  <option value='user'>用户</option>
                  <option value='group'>群组</option>
                  <option value='global'>全局</option>
                </select>
                <input
                  value={memoryDraft.scopeKey}
                  onChange={event =>
                    setMemoryDraft(value => ({ ...value, scopeKey: event.target.value }))}
                  placeholder='作用域标识'
                  className='rounded-xl border border-default-200 bg-default-50 px-3 py-2'
                />
                <Action
                  disabled={!memoryDraft.content.trim() || !memoryDraft.scopeKey.trim()}
                  onClick={createMemory}
                >
                  创建记忆
                </Action>
                <textarea
                  value={memoryDraft.content}
                  onChange={event =>
                    setMemoryDraft(value => ({ ...value, content: event.target.value }))}
                  placeholder='只保存稳定、有长期价值且不含凭据的信息'
                  className='min-h-24 rounded-xl border border-default-200 bg-default-50 px-3 py-2 md:col-span-3'
                />
              </div>
              <div className='max-h-[720px] divide-y divide-default-200 overflow-auto'>
                {memories.map(item => (
                  <div key={item.id} className='p-4'>
                    <div className='mb-2 flex items-center justify-between gap-3'>
                      <span className='rounded-full bg-primary-50 px-2 py-1 text-xs text-primary'>
                        {item.scope}:{item.scopeKey}
                      </span>
                      <div className='flex gap-2'>
                        <Action
                          onClick={async () => {
                            await agentRequest.setMemoryState(item.id, !item.enabled)
                            setMemories(await agentRequest.memories())
                          }}
                        >
                          {item.enabled ? '禁用' : '启用'}
                        </Action>
                        <Action
                          danger
                          onClick={async () => {
                            if (!window.confirm('永久删除此条长期记忆？此操作不可恢复。')) return
                            await agentRequest.deleteMemory(item.id)
                            setMemories(await agentRequest.memories())
                          }}
                        >
                          <Trash2 size={15} />
                        </Action>
                      </div>
                    </div>
                    <p className='whitespace-pre-wrap text-sm'>{item.content}</p>
                    <p className='mt-2 text-xs text-default-400'>{date(item.createdAt)}</p>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          {tab === 'skills' && (
            <Panel>
              <div className='border-b border-default-200 p-5'>
                <h2 className='flex items-center gap-2 text-lg font-semibold'>
                  <Brain size={19} />
                  技能版本
                </h2>
                <p className='text-sm text-default-500'>新版本只对新 Thread 生效。</p>
              </div>
              <div className='grid gap-3 border-b border-default-200 p-5 md:grid-cols-2'>
                <input
                  value={skillDraft.name}
                  onChange={event =>
                    setSkillDraft(value => ({ ...value, name: event.target.value }))}
                  placeholder='skill-name（小写字母、数字、连字符）'
                  className='rounded-xl border border-default-200 bg-default-50 px-3 py-2'
                />
                <input
                  value={skillDraft.description}
                  onChange={event =>
                    setSkillDraft(value => ({ ...value, description: event.target.value }))}
                  placeholder='简单描述'
                  className='rounded-xl border border-default-200 bg-default-50 px-3 py-2'
                />
                <textarea
                  value={skillDraft.instructions}
                  onChange={event =>
                    setSkillDraft(value => ({ ...value, instructions: event.target.value }))}
                  placeholder='声明式操作说明；不允许脚本、依赖安装或权限绕过'
                  className='min-h-28 rounded-xl border border-default-200 bg-default-50 px-3 py-2 md:col-span-2'
                />
                <input
                  value={skillDraft.tools}
                  onChange={event =>
                    setSkillDraft(value => ({ ...value, tools: event.target.value }))}
                  placeholder='引用的已注册 Tool，逗号分隔'
                  className='rounded-xl border border-default-200 bg-default-50 px-3 py-2'
                />
                <Action
                  disabled={
                  !skillDraft.name.trim() ||
                  !skillDraft.description.trim() ||
                  !skillDraft.instructions.trim()
                }
                  onClick={createSkill}
                >
                  创建 Skill 版本
                </Action>
              </div>
              <div className='divide-y divide-default-200'>
                {skills.map(item => (
                  <div key={item.id} className='p-4'>
                    <div className='flex items-start justify-between gap-3'>
                      <div>
                        <h3 className='font-semibold'>{item.name}</h3>
                        <p className='mt-1 text-sm text-default-500'>{item.description}</p>
                        <p className='mt-2 text-xs text-default-400'>
                          active {item.activeVersionId || 'none'} · {date(item.updatedAt)}
                        </p>
                      </div>
                      <Action
                        onClick={async () => {
                          await agentRequest.setSkillState(item.id, !item.enabled)
                          setSkills(await agentRequest.skills())
                        }}
                      >
                        {item.enabled ? '禁用' : '启用'}
                      </Action>
                    </div>
                    <Action
                      onClick={async () => {
                        const versions = await agentRequest.skillVersions(item.id)
                        const selected = window.prompt(
                        `输入要回滚的 version id：\n${versions.map(value => `${value.id} (v${value.version})`).join('\n')}`
                        )
                        if (!selected) return
                        await agentRequest.rollbackSkill(item.id, selected)
                        setSkills(await agentRequest.skills())
                      }}
                    >
                      回滚版本
                    </Action>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>
      )}

      {tab === 'tasks' && (
        <div className='grid gap-5'>
          <Panel>
            <div className='border-b border-default-200 p-5'>
              <h2 className='text-lg font-semibold'>持久化自动任务</h2>
            </div>
            <div className='grid gap-3 p-5'>
              <select
                value={jobDraft.scheduleType}
                onChange={event =>
                  setJobDraft(value => ({
                    ...value,
                    scheduleType: event.target.value as 'cron' | 'once',
                  }))}
                className='rounded-xl border border-default-200 bg-default-50 px-3 py-2'
              >
                <option value='cron'>Cron 周期</option>
                <option value='once'>一次性时间</option>
              </select>
              <input
                value={jobDraft.name}
                onChange={event =>
                  setJobDraft(value => ({ ...value, name: event.target.value }))}
                placeholder='任务名称'
                className='rounded-xl border border-default-200 bg-default-50 px-3 py-2 outline-none focus:border-primary'
              />
              {jobDraft.scheduleType === 'cron'
                ? (
                  <input
                    value={jobDraft.cron}
                    onChange={event =>
                      setJobDraft(value => ({ ...value, cron: event.target.value }))}
                    placeholder='Cron 表达式'
                    className='rounded-xl border border-default-200 bg-default-50 px-3 py-2 outline-none focus:border-primary'
                  />
                )
                : (
                  <input
                    type='datetime-local'
                    value={jobDraft.runAt}
                    onChange={event =>
                      setJobDraft(value => ({ ...value, runAt: event.target.value }))}
                    className='rounded-xl border border-default-200 bg-default-50 px-3 py-2 outline-none focus:border-primary'
                  />
                )}
              <input
                value={jobDraft.timezone}
                onChange={event =>
                  setJobDraft(value => ({ ...value, timezone: event.target.value }))}
                placeholder='时区，例如 Asia/Shanghai'
                className='rounded-xl border border-default-200 bg-default-50 px-3 py-2 outline-none focus:border-primary'
              />
              <input
                value={jobDraft.target}
                onChange={event =>
                  setJobDraft(value => ({ ...value, target: event.target.value }))}
                placeholder='投递目标'
                className='rounded-xl border border-default-200 bg-default-50 px-3 py-2 outline-none focus:border-primary'
              />
              <textarea
                value={jobDraft.prompt}
                onChange={event => setJobDraft(value => ({ ...value, prompt: event.target.value }))}
                placeholder='每次运行的 Prompt'
                className='rounded-xl border border-default-200 bg-default-50 px-3 py-2 outline-none focus:border-primary'
              />
              <input
                value={jobDraft.toolAllowlist}
                onChange={event =>
                  setJobDraft(value => ({ ...value, toolAllowlist: event.target.value }))}
                placeholder='预授权 Tool，逗号分隔'
                className='rounded-xl border border-default-200 bg-default-50 px-3 py-2 outline-none focus:border-primary'
              />
              <input
                value={jobDraft.skillIds}
                onChange={event =>
                  setJobDraft(value => ({ ...value, skillIds: event.target.value }))}
                placeholder='附加 Skill ID，逗号分隔'
                className='rounded-xl border border-default-200 bg-default-50 px-3 py-2 outline-none focus:border-primary'
              />
              <Action onClick={saveJob}>保存任务</Action>
            </div>
            <div className='divide-y divide-default-200'>
              {jobs.map(item => (
                <div key={item.id} className='flex items-center justify-between gap-3 p-4'>
                  <div>
                    <h3 className='font-semibold'>{item.name}</h3>
                    <p className='text-sm text-default-500'>
                      {item.scheduleType === 'once' ? date(item.runAt) : item.cron} · {item.timezone} · {item.target}
                    </p>
                    <p className='text-xs text-default-400'>上次运行 {date(item.lastRunAt)}</p>
                  </div>
                  <Action
                    danger
                    onClick={async () => {
                      if (!window.confirm('永久删除此自动任务？')) return
                      await agentRequest.deleteJob(item.id)
                      setJobs(await agentRequest.jobs())
                    }}
                  >
                    <Trash2 size={15} />
                    删除
                  </Action>
                  <Action
                    onClick={async () => {
                      await agentRequest.setJobState(item.id, !item.enabled)
                      setJobs(await agentRequest.jobs())
                    }}
                  >
                    {item.enabled ? '暂停' : '恢复'}
                  </Action>
                  <Action
                    onClick={async () => {
                      await agentRequest.runJob(item.id)
                      setJobs(await agentRequest.jobs())
                      setJobRuns(await agentRequest.jobRuns())
                      toast.success('任务已运行')
                    }}
                  >
                    立即运行
                  </Action>
                </div>
              ))}
            </div>
            <div className='border-t border-default-200 p-5'>
              <h3 className='mb-3 font-semibold'>最近运行</h3>
              <div className='grid gap-2'>
                {jobRuns.slice(0, 20).map(item => (
                  <div
                    key={String(item.id)}
                    className='flex flex-wrap items-center justify-between gap-2 rounded-xl bg-default-50 p-3 text-sm'
                  >
                    <span className='font-mono text-xs'>{String(item.job_id)}</span>
                    <span>{String(item.status)}</span>
                    <span className='text-default-400'>{date(Number(item.started_at))}</span>
                    {item.error ? <span className='text-danger'>{String(item.error)}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          </Panel>
          <Panel>
            <div className='flex items-center justify-between border-b border-default-200 p-5'>
              <div>
                <h2 className='flex items-center gap-2 text-lg font-semibold'>
                  <Network size={19} />
                  MCP Client
                </h2>
                <p className='text-sm text-default-500'>
                  stdio 与 Streamable HTTP；默认 external 风险。
                </p>
              </div>
              <Action onClick={async () => setMcp(await agentRequest.reloadMcp())}>
                <RefreshCw size={16} />
                重新连接
              </Action>
            </div>
            <div className='divide-y divide-default-200'>
              {mcp.map((item, index) => (
                <div key={index} className='p-4'>
                  <div className='flex items-center justify-between'>
                    <span className='font-semibold'>{String(item.name)}</span>
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${
                        item.connected
                          ? 'bg-success-100 text-success-700'
                          : 'bg-danger-100 text-danger-700'
                      }`}
                    >
                      {item.connected ? 'connected' : 'offline'}
                    </span>
                  </div>
                  <pre className='mt-3 overflow-auto rounded-xl bg-default-50 p-3 text-xs'>
                    {JSON.stringify(item, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}

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
                      disabled
                        ? 'bg-danger-50 text-danger'
                        : 'bg-success-50 text-success-700'
                    }`}
                  >
                    {toolset} · {disabled ? '已禁用' : '已启用'}
                  </button>
                )
              })}
            </div>
          </div>
          <div className='grid gap-3 p-5 lg:grid-cols-2'>
            {tools.map((item, index) => (
              <details key={String(item.name || index)} className='rounded-2xl border border-default-200 p-4'>
                <summary className='cursor-pointer'>
                  <div className='inline-flex flex-wrap items-center gap-2'>
                    <span className='font-semibold'>{String(item.name || '')}</span>
                    <span className='rounded-full bg-primary-50 px-2 py-1 text-xs text-primary'>
                      {String(item.toolset || 'plugin')}
                    </span>
                    <span className='rounded-full bg-default-100 px-2 py-1 text-xs'>
                      {String(item.risk || 'read')}
                    </span>
                  </div>
                </summary>
                <p className='mt-3 text-sm text-default-500'>{String(item.description || '')}</p>
                <p className='mt-2 text-xs text-default-400'>
                  来源 {String(item.source || 'unknown')} · 权限 {String(item.permission || 'all')}
                </p>
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
                    <span className='text-xs text-default-400'>{Number(item.latency_ms || 0)}ms</span>
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
                  <div className='mt-2 text-xs text-default-400'>{date(Number(item.created_at))}</div>
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
                          onChange={event => updateProvider(provider.id, { name: event.target.value })}
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
                          onClick={() => setAgentConfig(value => {
                            if (!value) return value
                            const providers = value.providers.filter(item => item.id !== provider.id)
                            const primary = value.routing.primary === provider.id
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
                                name: kind === 'custom' ? provider.name : preset?.name || provider.name,
                                baseUrl: preset?.baseUrl || provider.baseUrl,
                              })
                            }}
                            className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                          >
                            {providerPresets.map(preset => (
                              <option key={preset.kind} value={preset.kind}>{preset.name}</option>
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
                            placeholder={provider.apiKeyConfigured ? '已配置（留空保留）' : '未配置'}
                            className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                            autoComplete='new-password'
                          />
                        </label>
                        <label className='text-xs text-default-500'>
                          模型
                          <input
                            list={`models-${provider.id}`}
                            value={provider.model}
                            onChange={event =>
                              updateProvider(provider.id, { model: event.target.value })}
                            placeholder='自由填写模型名称'
                            className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                          />
                          <datalist id={`models-${provider.id}`}>
                            {(providerModels[provider.id] || []).map(model => (
                              <option key={model} value={model} />
                            ))}
                          </datalist>
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
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        routing: { ...agentConfig.routing, primary: event.target.value },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    >
                      {agentConfig.providers.map(provider => (
                        <option key={provider.id} value={provider.id}>{provider.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className='text-xs text-default-500'>
                    Fallback 顺序（逗号分隔 ID）
                    <input
                      value={agentConfig.routing.fallback.join(', ')}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        routing: {
                          ...agentConfig.routing,
                          fallback: event.target.value.split(',').map(value => value.trim()).filter(Boolean),
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                </div>

                <div className='grid gap-4 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <h3 className='md:col-span-2 font-semibold'>触发与学习</h3>
                  {([
                    ['private', '未匹配私聊自动触发'],
                    ['groupMention', '群聊 @机器人触发'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className='flex items-center gap-2 text-sm'>
                      <input
                        type='checkbox'
                        checked={agentConfig.trigger[key]}
                        onChange={event => setAgentConfig({
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
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        trigger: {
                          ...agentConfig.trigger,
                          wakeWords: event.target.value.split(',').map(value => value.trim()).filter(Boolean),
                        },
                      })}
                      className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                    />
                  </label>
                  {([
                    ['memory', '自动记忆'],
                    ['skills', '自动技能学习'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className='flex items-center gap-2 text-sm'>
                      <input
                        type='checkbox'
                        checked={agentConfig.learning[key]}
                        onChange={event => setAgentConfig({
                          ...agentConfig,
                          learning: { ...agentConfig.learning, [key]: event.target.checked },
                        })}
                      />
                      {label}
                    </label>
                  ))}
                </div>

                <div className='grid gap-3 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <h3 className='md:col-span-2 font-semibold'>运行限制</h3>
                  {(Object.keys(agentConfig.limits) as Array<keyof AgentConfig['limits']>).map(key => (
                    <label key={key} className='text-xs text-default-500'>
                      {key}
                      <input
                        type='number'
                        value={agentConfig.limits[key]}
                        onChange={event => setAgentConfig({
                          ...agentConfig,
                          limits: { ...agentConfig.limits, [key]: Number(event.target.value) },
                        })}
                        className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                      />
                    </label>
                  ))}
                </div>

                <div className='grid gap-3 rounded-2xl border border-default-200 p-4 md:grid-cols-2'>
                  <h3 className='md:col-span-2 font-semibold'>默认风险策略</h3>
                  {(Object.keys(agentConfig.policy.defaults) as Array<
                    keyof AgentConfig['policy']['defaults']
                  >).map(risk => (
                    <label key={risk} className='text-xs text-default-500'>
                      {risk}
                      <select
                        value={agentConfig.policy.defaults[risk]}
                        onChange={event => setAgentConfig({
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
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        policy: {
                          ...agentConfig.policy,
                          hardDeny: event.target.value.split('\n').map(value => value.trim()).filter(Boolean),
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
                      onChange={event => setAgentConfig({
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
                      <Action onClick={() => setAgentConfig({
                        ...agentConfig,
                        policy: {
                          ...agentConfig.policy,
                          rules: [...agentConfig.policy.rules, { pattern: '', decision: 'ask' }],
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
                          onChange={event => setAgentConfig({
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
                          onChange={event => setAgentConfig({
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
                          onClick={() => setAgentConfig({
                            ...agentConfig,
                            policy: {
                              ...agentConfig.policy,
                              rules: agentConfig.policy.rules.filter((_, itemIndex) => itemIndex !== index),
                            },
                          })}
                        >
                          删除
                        </Action>
                      </div>
                    ))}
                  </div>
                </div>

                <div className='rounded-2xl border border-default-200 p-4'>
                  <label className='flex items-center justify-between'>
                    <span>
                      <span className='block font-semibold'>启用 MCP Client</span>
                      <span className='text-xs text-default-500'>stdio / Streamable HTTP</span>
                    </span>
                    <input
                      type='checkbox'
                      checked={agentConfig.mcp.enabled}
                      onChange={event => setAgentConfig({
                        ...agentConfig,
                        mcp: { ...agentConfig.mcp, enabled: event.target.checked },
                      })}
                    />
                  </label>
                  <div className='mt-4 space-y-3'>
                    {agentConfig.mcp.servers.map((server, index) => (
                      <div key={`${server.name}:${index}`} className='grid gap-2 rounded-xl bg-default-50 p-3 md:grid-cols-2'>
                        <input
                          value={server.name}
                          placeholder='Server 名称'
                          onChange={event => setAgentConfig({
                            ...agentConfig,
                            mcp: {
                              ...agentConfig.mcp,
                              servers: agentConfig.mcp.servers.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, name: event.target.value } : item
                              ),
                            },
                          })}
                          className='rounded-lg border border-default-200 p-2 text-sm'
                        />
                        <select
                          value={server.transport}
                          onChange={event => setAgentConfig({
                            ...agentConfig,
                            mcp: {
                              ...agentConfig.mcp,
                              servers: agentConfig.mcp.servers.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, transport: event.target.value as 'stdio' | 'http' }
                                  : item
                              ),
                            },
                          })}
                          className='rounded-lg border border-default-200 p-2 text-sm'
                        >
                          <option value='stdio'>stdio</option>
                          <option value='http'>Streamable HTTP</option>
                        </select>
                        <input
                          value={server.transport === 'http' ? server.url || '' : server.command || ''}
                          placeholder={server.transport === 'http' ? 'URL' : 'Command'}
                          onChange={event => setAgentConfig({
                            ...agentConfig,
                            mcp: {
                              ...agentConfig.mcp,
                              servers: agentConfig.mcp.servers.map((item, itemIndex) =>
                                itemIndex === index
                                  ? server.transport === 'http'
                                    ? { ...item, url: event.target.value }
                                    : { ...item, command: event.target.value }
                                  : item
                              ),
                            },
                          })}
                          className='rounded-lg border border-default-200 p-2 text-sm'
                        />
                        <label className='flex items-center gap-2 rounded-lg border border-default-200 p-2 text-sm'>
                          <input
                            type='checkbox'
                            checked={server.enabled}
                            onChange={event => setAgentConfig({
                              ...agentConfig,
                              mcp: {
                                ...agentConfig.mcp,
                                servers: agentConfig.mcp.servers.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, enabled: event.target.checked }
                                    : item
                                ),
                              },
                            })}
                          />
                          启用 Server
                        </label>
                        {server.transport === 'stdio' && (
                          <>
                            <input
                              value={(server.args || []).join(', ')}
                              placeholder='Arguments（逗号分隔）'
                              onChange={event => setAgentConfig({
                                ...agentConfig,
                                mcp: {
                                  ...agentConfig.mcp,
                                  servers: agentConfig.mcp.servers.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? {
                                        ...item,
                                        args: event.target.value
                                          .split(',')
                                          .map(value => value.trim())
                                          .filter(Boolean),
                                      }
                                      : item
                                  ),
                                },
                              })}
                              className='rounded-lg border border-default-200 p-2 text-sm'
                            />
                            <input
                              value={server.cwd || ''}
                              placeholder='Working directory'
                              onChange={event => setAgentConfig({
                                ...agentConfig,
                                mcp: {
                                  ...agentConfig.mcp,
                                  servers: agentConfig.mcp.servers.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, cwd: event.target.value }
                                      : item
                                  ),
                                },
                              })}
                              className='rounded-lg border border-default-200 p-2 text-sm'
                            />
                          </>
                        )}
                        <label className='text-xs text-default-500'>
                          HTTP Headers（KEY=VALUE；敏感值必须引用环境变量）
                          <textarea
                            value={recordLines(server.headers)}
                            placeholder={mcpHeaderExample}
                            onChange={event => setAgentConfig({
                              ...agentConfig,
                              mcp: {
                                ...agentConfig.mcp,
                                servers: agentConfig.mcp.servers.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, headers: linesRecord(event.target.value) }
                                    : item
                                ),
                              },
                            })}
                            className='mt-1 min-h-20 w-full rounded-lg border border-default-200 p-2 text-sm'
                          />
                        </label>
                        <label className='text-xs text-default-500'>
                          stdio 环境变量（KEY={environmentReference}）
                          <textarea
                            value={recordLines(server.env)}
                            placeholder={mcpEnvExample}
                            onChange={event => setAgentConfig({
                              ...agentConfig,
                              mcp: {
                                ...agentConfig.mcp,
                                servers: agentConfig.mcp.servers.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, env: linesRecord(event.target.value) }
                                    : item
                                ),
                              },
                            })}
                            className='mt-1 min-h-20 w-full rounded-lg border border-default-200 p-2 text-sm'
                          />
                        </label>
                        <Action
                          danger
                          onClick={() => setAgentConfig({
                            ...agentConfig,
                            mcp: {
                              ...agentConfig.mcp,
                              servers: agentConfig.mcp.servers.filter((_, itemIndex) => itemIndex !== index),
                            },
                          })}
                        >
                          删除 MCP
                        </Action>
                      </div>
                    ))}
                    <Action onClick={() => setAgentConfig({
                      ...agentConfig,
                      mcp: {
                        ...agentConfig.mcp,
                        servers: [
                          ...agentConfig.mcp.servers,
                          { name: `server-${agentConfig.mcp.servers.length + 1}`, enabled: true, transport: 'http', url: '' },
                        ],
                      },
                    })}
                    >
                      新增 MCP Server
                    </Action>
                  </div>
                </div>

                <details className='rounded-2xl border border-default-200 p-4'>
                  <summary className='cursor-pointer font-semibold'>只读 JSON 预览</summary>
                  <pre className='mt-3 max-h-96 overflow-auto text-xs'>
                    {JSON.stringify(agentConfig, null, 2)}
                  </pre>
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
