import Ajv, { type ValidateFunction } from 'ajv'
import { cache } from '@/plugin/system/cache'
import { createAgentTool } from '@/core/karin/tool'

import type {
  AgentCapabilitySource,
  AgentToolContext,
  AgentToolOptions,
  AgentToolResultEnvelope,
} from '@/types/agent'
import type { AgentTool } from '@/types/plugin'
import type { AgentDatabase } from '../persistence/database'

interface CompiledTool {
  tool: AgentTool
  input: ValidateFunction
  output?: ValidateFunction
}

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8')
const sensitiveKey = /authorization|cookie|token|password|api[-_]?key|secret/i

const redactArtifactValue = (value: unknown, key = ''): unknown => {
  if (sensitiveKey.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redactArtifactValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([itemKey, item]) => [itemKey, redactArtifactValue(item, itemKey)])
    )
  }
  return value
}

export class AgentToolRegistry {
  private readonly ajv = new Ajv({
    allErrors: true,
    strict: true,
    removeAdditional: false,
  })

  private readonly compiled = new Map<string, CompiledTool>()
  private readonly sources = new Map<string, AgentCapabilitySource>()

  constructor (private readonly database?: AgentDatabase) {}

  register (
    options: AgentToolOptions,
    allowReserved = false,
    source: AgentCapabilitySource = allowReserved ? 'core' : 'plugin'
  ) {
    const tool = createAgentTool(options, allowReserved)
    this.validateDefinition(tool)
    if (cache.tool.some(item => item.name === tool.name)) {
      throw new Error(`[agent][tool] 工具名称重复: ${tool.name}`)
    }
    cache.tool.push(tool)
    cache.count.tool++
    this.sources.set(tool.name, source)
    return tool
  }

  unregister (name: string) {
    const previous = cache.tool.length
    cache.tool = cache.tool.filter(tool => tool.name !== name)
    this.compiled.delete(name)
    this.sources.delete(name)
    if (cache.tool.length !== previous) {
      cache.count.tool = Math.max(0, cache.count.tool - 1)
      return true
    }
    return false
  }

  unregisterPrefix (prefix: string) {
    for (const tool of cache.tool.filter(item => item.name.startsWith(prefix))) {
      this.unregister(tool.name)
    }
  }

  validateDefinition (tool: AgentTool) {
    let input: ValidateFunction
    let output: ValidateFunction | undefined
    try {
      input = this.ajv.compile(tool.inputSchema)
      output = tool.outputSchema ? this.ajv.compile(tool.outputSchema) : undefined
    } catch (error) {
      throw new Error(`[agent][tool] ${tool.name} Schema 无效`, { cause: error })
    }
    this.compiled.set(tool.name, { tool, input, output })
  }

  get (name: string) {
    const tool = cache.tool.find(item => item.name === name)
    if (!tool) return null
    const existing = this.compiled.get(name)
    if (existing?.tool === tool) return existing
    this.validateDefinition(tool)
    return this.compiled.get(name) || null
  }

  isolation (name: string) {
    const compiled = this.get(name)
    const source = this.sources.get(name) || (
      name.startsWith('karin.')
        ? 'core'
        : name.startsWith('mcp.')
          ? 'mcp'
          : name.startsWith('skill.') ? 'generated-sandbox' : 'plugin'
    )
    if (source === 'core') return 'core-inline' as const
    if (source === 'generated-sandbox') return 'generated-sandbox' as const
    if (source === 'mcp') {
      return compiled?.tool.isolation === 'mcp-stdio' ? 'mcp-stdio' as const : 'mcp-remote' as const
    }
    return compiled?.tool.isolation === 'process-isolated'
      ? 'process-isolated' as const
      : 'legacy-inline' as const
  }

  list (allowedTools?: string[]) {
    const allowed = allowedTools?.length ? new Set(allowedTools) : null
    return cache.tool
      .filter(tool => !allowed || allowed.has(tool.name))
      .map(tool => ({
        available: (() => {
          try {
            return tool.availability ? Boolean(tool.availability()) : true
          } catch {
            return false
          }
        })(),
        name: tool.name,
        description: tool.description,
        source: tool.name.startsWith('karin.')
          ? 'Karin Core'
          : tool.name.startsWith('mcp.')
            ? tool.name.split('.').slice(0, 2).join('.')
            : tool.pkg?.name || 'unknown',
        sourceKind: this.sources.get(tool.name) || (
          tool.name.startsWith('mcp.')
            ? 'mcp'
            : tool.name.startsWith('skill.')
              ? 'generated-sandbox'
              : tool.name.startsWith('karin.')
                ? 'core'
                : 'plugin'
        ),
        toolset: tool.toolset || (
          tool.name.startsWith('karin.')
            ? `karin.${tool.name.split('.')[1] || 'core'}`
            : tool.name.startsWith('mcp.')
              ? tool.name.split('.').slice(0, 2).join('.')
              : tool.pkg?.name || 'plugin'
        ),
        tags: tool.tags || [],
        inputSchema: tool.inputSchema,
        risk: tool.risk || 'read',
        permission: tool.permission || 'all',
        reversible: Boolean(tool.reversible),
        requirements: tool.requirements || [],
        owner: tool.owner || tool.pkg?.name || (
          tool.name.startsWith('karin.') ? 'karin-core' : undefined
        ),
        sensitivity: tool.sensitivity || 'private',
        restartSafe: Boolean(tool.restartSafe || (
          tool.idempotent && (tool.risk || 'read') === 'read'
        )),
        unavailableReason: (() => {
          try {
            if (!tool.availability || tool.availability()) return undefined
            return tool.requirements?.length
              ? `缺少运行要求：${tool.requirements.join('、')}`
              : '当前运行环境不可用'
          } catch (error) {
            return `可用性检查失败：${(error as Error).message}`
          }
        })(),
        isolation: this.isolation(tool.name),
      }))
  }

  discover (
    query: string,
    allowedTools?: string[],
    limit = 24,
    requiredTools: string[] = []
  ) {
    const normalized = query.toLowerCase()
    const terms = [...new Set(
      normalized
        .split(/[\s,，。！？、:：;；()[\]{}"'`]+/)
        .map(item => item.trim())
        .filter(item => item.length >= 2)
    )]
    const score = (tool: ReturnType<AgentToolRegistry['list']>[number]) => {
      const name = tool.name.toLowerCase()
      const description = tool.description.toLowerCase()
      const tags = tool.tags.join(' ').toLowerCase()
      let value = normalized.includes(name) ? 20 : 0
      for (const term of terms) {
        if (name.includes(term)) value += 8
        if (tags.includes(term)) value += 5
        if (description.includes(term)) value += 3
      }
      if (tool.name === 'karin.host.inspect' &&
        /电脑|主机|系统|配置|cpu|内存|磁盘|node|操作系统/i.test(query)) {
        value += 30
      }
      const cronIntent = /定时|提醒|计划任务|cron|schedule/i.test(query)
      const skillIntent = /技能|skill/i.test(query)
      const memoryIntent = /记忆|记住|偏好|memory/i.test(query)
      const browserIntent = /网页|浏览器|网址|链接|url|https?:\/\//i.test(query)
      const messageIntent = /发送|发消息|通知|推送|告知|联系|提醒|send|message|notify/i.test(query)
      const imageIntent =
        /图片|照片|相片|图像|截图|发(?:一|个|张|图|给|送)|传图|image|photo|picture/i.test(query)
      const relativeTimeIntent =
        /(?:\d+|一|两|几)(?:秒|分钟|小时|天)后|稍后|待会|过一会/i.test(query)
      const createIntent = /创建|新增|添加|安排|设置|生成|create|add/i.test(query)
      const updateIntent = /修改|更新|调整|update|edit/i.test(query)
      const deleteIntent = /删除|移除|delete|remove/i.test(query)
      const listIntent = /列出|查看|有哪些|列表|list/i.test(query)
      const delegateIntent = /并行|分工|委派|子任务|子\s*Agent|多(?:个|项|路)/i.test(query)
      const diagnosticIntent =
        /诊断|排查|根因|报错|失败|日志|堆栈|调用轨迹|为什么|修复|diagnos|debug|error/i

      if (cronIntent && name.includes('.cron.')) value += 24
      if (skillIntent && name.includes('.skill.')) value += 24
      if (memoryIntent && name.includes('.memory.')) value += 24
      if (browserIntent && name.includes('.browser.')) value += 24
      if (messageIntent && name === 'karin.bot.send_message') value += 36
      if (imageIntent && name === 'karin.bot.send_message') value += 42
      if (
        imageIntent &&
        (
          name === 'karin.browser.search' ||
          name === 'karin.browser.open' ||
          name === 'karin.browser.download'
        )
      ) {
        value += 34
      }
      if (diagnosticIntent && name.startsWith('karin.diagnostics.')) value += 38
      if (relativeTimeIntent && name === 'karin.cron.create') value += 36
      if (createIntent && name.endsWith('.create')) value += 30
      if (createIntent && name.endsWith('.install_url')) value += 30
      if (updateIntent && (name.endsWith('.update') || name.endsWith('.state'))) value += 24
      if (deleteIntent && name.endsWith('.delete')) value += 24
      if (listIntent && (name.endsWith('.list') || name.endsWith('.search'))) value += 18
      if (delegateIntent && name === 'karin.agent.delegate_many') value += 36
      return value
    }
    const tools = this.list(allowedTools).filter(tool => tool.available)
    if (tools.length <= limit) return tools
    const selected = tools
      .map((tool, index) => ({ tool, index, score: score(tool) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map(item => item.tool)
    const pinned = tools.filter(tool => requiredTools.includes(tool.name))
    return [
      ...pinned,
      ...selected.filter(tool => !pinned.some(item => item.name === tool.name)),
    ].slice(0, 100)
  }

  async execute (
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
    maxOutputBytes: number
  ) {
    const compiled = this.get(name)
    if (!compiled) throw new Error(`未知工具: ${name}`)
    if ('__invalid_json' in input) throw new Error('模型生成的工具参数不是有效 JSON')
    if (!compiled.input(input)) {
      throw new Error(
        `工具参数校验失败: ${this.ajv.errorsText(compiled.input.errors, { separator: '; ' })}`
      )
    }

    const timeout = Math.max(1, compiled.tool.timeout || 30_000)
    const timeoutSignal = AbortSignal.timeout(timeout)
    const signal = AbortSignal.any([context.signal, timeoutSignal])
    let output: unknown
    try {
      output = await compiled.tool.execute(input, { ...context, signal })
    } catch (error) {
      if (timeoutSignal.aborted && !context.signal.aborted) {
        throw new Error(`工具 ${name} 执行超时（${timeout}ms）`, { cause: error })
      }
      throw error
    }
    if (compiled.output && !compiled.output(output)) {
      throw new Error(
        `工具输出校验失败: ${this.ajv.errorsText(compiled.output.errors, { separator: '; ' })}`
      )
    }

    const serialized = JSON.stringify(output ?? null)
    if (byteLength(serialized) <= maxOutputBytes) return output
    const redacted = JSON.stringify(redactArtifactValue(output ?? null))
    if (byteLength(redacted) > 5 * 1024 * 1024) {
      throw new Error('工具输出超过 Artifact 5 MiB 上限')
    }
    const preview = redacted.slice(0, Math.max(256, Math.min(maxOutputBytes / 2, 4096)))
    if (!this.database) {
      return { truncated: true, preview, bytes: byteLength(redacted) }
    }
    const artifact = await this.database.createToolArtifact({
      threadId: context.threadId,
      turnId: context.turnId,
      toolName: name,
      content: redacted,
      preview,
    })
    return {
      truncated: true,
      artifactId: artifact.id,
      preview: artifact.preview,
      hash: artifact.hash,
      bytes: artifact.bytes,
    }
  }

  async executeWithReceipt (
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
    maxOutputBytes: number
  ): Promise<AgentToolResultEnvelope> {
    const startedAt = Date.now()
    const compiled = this.get(name)
    const idempotent = Boolean(compiled?.tool.idempotent)
    try {
      const data = await this.execute(name, input, context, maxOutputBytes)
      const object = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {}
      const delivery = name === 'karin.bot.send_message'
        ? {
          completed: object.delivered === true,
          channel: typeof object.channel === 'string' ? object.channel : undefined,
          accountId: typeof object.accountId === 'string' ? object.accountId : undefined,
          contactKey: typeof object.contactKey === 'string' ? object.contactKey : undefined,
          textSegments: Math.max(0, Number(object.textSegments) || 0),
          imageSegments: Math.max(0, Number(object.imageSegments) || 0),
        }
        : undefined
      const path = typeof object.path === 'string' ? object.path : undefined
      const url = typeof object.url === 'string' ? object.url : undefined
      const media = path || (
        url && /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(url)
      )
        ? {
          path,
          url,
          mime: typeof object.contentType === 'string'
            ? object.contentType
            : typeof object.mime === 'string'
              ? object.mime
              : undefined,
          size: Number(object.bytes || object.size) || undefined,
        }
        : undefined
      return {
        status: 'completed',
        data,
        receipt: {
          toolName: name,
          status: 'completed',
          startedAt,
          completedAt: Date.now(),
          idempotent,
          restartSafe: Boolean(compiled?.tool.restartSafe || (
            compiled?.tool.idempotent && (compiled?.tool.risk || 'read') === 'read'
          )),
          artifactId: typeof object.artifactId === 'string'
            ? object.artifactId
            : undefined,
          delivery,
          media,
        },
        evidence: [
          delivery?.completed ? `delivery:${delivery.channel || 'channel'}:completed` : '',
          media?.path ? `media:${media.path}` : media?.url ? `media:${media.url}` : '',
        ].filter(Boolean),
      }
    } catch (error) {
      const message = (error as Error).message
      return {
        status: 'failed',
        errorCode: this.errorCode(message),
        error: message,
        receipt: {
          toolName: name,
          status: 'failed',
          startedAt,
          completedAt: Date.now(),
          idempotent,
        },
        evidence: [],
      }
    }
  }

  private errorCode (message: string) {
    if (/未知工具/.test(message)) return 'TOOL_NOT_FOUND'
    if (/参数|Schema|JSON/.test(message)) return 'TOOL_INVALID_INPUT'
    if (/超时|timeout/i.test(message)) return 'TOOL_TIMEOUT'
    if (/权限|拒绝|approval/i.test(message)) return 'TOOL_DENIED'
    if (/投递|发送|delivery/i.test(message)) return 'DELIVERY_FAILED'
    if (/私网|URL|域名|协议/.test(message)) return 'TOOL_UNSAFE_URL'
    return 'TOOL_FAILED'
  }
}
