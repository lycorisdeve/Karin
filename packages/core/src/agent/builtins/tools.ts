import fs from 'node:fs'
import path from 'node:path'
import { cache } from '@/plugin/system/cache'
import { getAllBotList, sendMsg } from '@/service/bot'
import { taskSystem } from '@/service/task'
import { karinPathLogs, karinPathPlugins } from '@/root'
import { restartDirect } from '@/utils/system/restart'
import { startPluginInstall, startPluginUninstall } from '@/server/plugins/install'
import { StatusHelper } from '@/core/internal/status_listener'
import { AgentBrowserManager } from '../browser/manager'
import { agentDeliveryTarget } from '../ingress/context'
import {
  agentSendMessage,
  agentStructuredMessage,
} from '../ingress/message-elements'
import { updateNpmPlugin } from './plugin'
import { agentConfig } from '@/utils/config/file/agent'

import type { Contact, Scene } from '@/types/event'
import type { AgentDatabase } from '../persistence/database'
import type { AgentLearning } from '../learning/learning'
import type { AgentRuntime } from '../runtime/runtime'
import type { AgentScheduler } from '../automation/scheduler'
import type {
  AgentRepairManager,
  AgentRepairProposal,
} from '../repair/manager'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentTaskLedger } from '../tasks/ledger'
import type { AgentCapabilityCatalog } from '../capabilities/catalog'
import type { AgentGeneratedToolLibrary } from '../generated-tools/library'
import type { AgentScriptToolDefinition } from '@/types/agent'

const npmPackage = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._-]+)?$/
const browser = new AgentBrowserManager()
const diagnosticTextExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
  '.scss', '.ts', '.tsx', '.txt', '.yaml', '.yml',
])
const diagnosticDeniedNames = /^(?:\.env(?:\..*)?|credentials?|secrets?|cookies?)$/i
const diagnosticDeniedDirectories = new Set([
  '.git', 'node_modules', 'dist', 'coverage', '@karinjs',
])

const redactDiagnosticText = (value: string) => value
  .replace(
    /((?:authorization|cookie|token|password|api[-_]?key|secret)\s*[:=]\s*)[^\s,;]+/gi,
    '$1[REDACTED]'
  )
  .replace(/\b(?:sk|key|token)-[a-z0-9._-]{8,}\b/gi, '[REDACTED]')

const diagnosticRoot = (value: unknown) => {
  if (value === 'plugins') return path.resolve(karinPathPlugins)
  return path.resolve(process.cwd())
}

const diagnosticFile = async (root: string, relativePath: string) => {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('只能使用工作区相对路径')
  const segments = relativePath.split(/[\\/]+/)
  if (
    segments.some(segment =>
      diagnosticDeniedDirectories.has(segment) ||
      diagnosticDeniedNames.test(segment)
    )
  ) {
    throw new Error('诊断工具禁止读取凭据、构建产物、node_modules 或 Git 内部目录')
  }
  const filename = path.resolve(root, relativePath)
  const relative = path.relative(root, filename)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('诊断路径越过允许的工作区')
  }
  const realRoot = await fs.promises.realpath(root)
  const realFile = await fs.promises.realpath(filename)
  const realRelative = path.relative(realRoot, realFile)
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('诊断路径通过符号链接越过允许的工作区')
  }
  if (!diagnosticTextExtensions.has(path.extname(realFile).toLowerCase())) {
    throw new Error('诊断工具只允许读取文本源码和配置样例')
  }
  return realFile
}

const walkDiagnosticFiles = async (root: string, maximum = 5000) => {
  const files: string[] = []
  const pending = [root]
  while (pending.length && files.length < maximum) {
    const directory = pending.pop()!
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (diagnosticDeniedDirectories.has(entry.name) || diagnosticDeniedNames.test(entry.name)) {
        continue
      }
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(filename)
      else if (
        entry.isFile() &&
        diagnosticTextExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(filename)
      }
      if (files.length >= maximum) break
    }
  }
  return files
}
const scriptToolSchema = {
  type: 'object',
  required: [
    'id',
    'name',
    'description',
    'runtime',
    'source',
    'inputSchema',
    'semantics',
    'stop',
    'failure',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,63}$' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    runtime: { const: 'python' },
    source: { type: 'string', minLength: 1, maxLength: 65536 },
    sourceHash: { type: 'string' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    semantics: {
      type: 'object',
      required: ['objective', 'inputs', 'outputs', 'sideEffects', 'idempotent'],
      additionalProperties: false,
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 1000 },
        inputs: { type: 'string', minLength: 1, maxLength: 1000 },
        outputs: { type: 'string', minLength: 1, maxLength: 1000 },
        sideEffects: { type: 'array', maxItems: 0 },
        idempotent: { type: 'boolean' },
      },
    },
    stop: {
      type: 'object',
      required: ['completionCondition', 'timeoutMs', 'maxOutputBytes'],
      additionalProperties: false,
      properties: {
        completionCondition: { type: 'string', minLength: 1, maxLength: 1000 },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        maxOutputBytes: { type: 'integer', minimum: 1024, maximum: 1048576 },
      },
    },
    failure: {
      type: 'object',
      required: ['strategy', 'maxAttempts', 'retryDelayMs', 'userMessage'],
      additionalProperties: false,
      properties: {
        strategy: { enum: ['fail', 'retry'] },
        maxAttempts: { type: 'integer', minimum: 1, maximum: 3 },
        retryDelayMs: { type: 'integer', minimum: 0, maximum: 10000 },
        userMessage: { type: 'string', minLength: 1, maxLength: 1000 },
      },
    },
  },
} as const

const memoryScopeFor = (actor: {
  id: string
  role: string
  scene: string
  contactKey: string
}, requested?: string) => {
  if (requested === 'global') {
    if (!['master', 'admin'].includes(actor.role)) throw new Error('只有管理员可以写入全局记忆')
    return { scope: 'global' as const, key: 'global' }
  }
  if (['group', 'groupTemp', 'guild'].includes(actor.scene)) {
    return { scope: 'group' as const, key: actor.contactKey }
  }
  return { scope: 'user' as const, key: actor.id }
}

export const registerBuiltinTools = (
  registry: AgentToolRegistry,
  database: AgentDatabase,
  runtime: AgentRuntime,
  scheduler: AgentScheduler,
  learning: AgentLearning,
  taskLedger: AgentTaskLedger,
  capabilities: AgentCapabilityCatalog,
  generatedTools: AgentGeneratedToolLibrary,
  repair?: AgentRepairManager
) => {
  const register = (options: Parameters<typeof registry.register>[0]) => {
    registry.register(options, true)
  }

  register({
    name: 'karin.agent.todo',
    description: [
      '读取或更新当前 Thread 的持久化任务清单。',
      '无 todos 参数时读取；merge=false 替换清单；merge=true 按 id 更新或追加。',
      '多步骤任务必须先调用本工具，执行中及时维护状态；同一清单最多一个 in_progress。',
    ].join(' '),
    toolset: 'karin.agent',
    tags: ['任务分解', '计划', 'Todo', '执行状态'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: 2000 },
        merge: { type: 'boolean' },
        todos: {
          type: 'array',
          maxItems: 64,
          items: {
            type: 'object',
            required: ['id'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 100 },
              content: { type: 'string', minLength: 1, maxLength: 2000 },
              status: {
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
              },
            },
          },
        },
      },
    },
    risk: 'write',
    reversible: true,
    idempotent: true,
    execute: (input, context) => taskLedger.write(
      context.threadId,
      context.turnId,
      context.actor.id,
      String(input.goal || ''),
      {
        goal: input.goal ? String(input.goal) : undefined,
        merge: Boolean(input.merge),
        todos: Array.isArray(input.todos)
          ? input.todos.map(item => {
            const todo = item as Record<string, unknown>
            return {
              id: String(todo.id),
              content: todo.content === undefined ? undefined : String(todo.content),
              status: todo.status as
                | 'pending'
                | 'in_progress'
                | 'completed'
                | 'cancelled'
                | undefined,
            }
          })
          : undefined,
      }
    ),
  })

  register({
    name: 'karin.tool.search',
    description: [
      '统一检索全局注册的 Tool 与当前 Thread Skill。',
      '结果用 registered 表示全局注册态、available 表示运行环境可用态、',
      'callable 表示是否实际暴露给当前模型调用。',
    ].join(' '),
    toolset: 'karin.agent',
    tags: ['能力发现', 'Tool 搜索', 'Skill 搜索'],
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: (input, context) => capabilities.search(
      context.threadId,
      String(input.query),
      context.callableTools,
      Number(input.limit || 24)
    ),
  })

  register({
    name: 'karin.host.inspect',
    description: '读取当前电脑的 CPU、内存、操作系统、Node.js 和 Karin 进程配置',
    toolset: 'karin.system',
    tags: ['电脑配置', '主机信息', 'CPU', '内存', '操作系统', 'Node.js'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeNetwork: {
          type: 'boolean',
          description: '是否返回网卡名称；不会返回 IP、MAC 或认证信息',
        },
      },
    },
    risk: 'external',
    execute: input => {
      const status = new StatusHelper().systemStatus()
      return {
        cpu: status.cpu,
        memory: status.memory,
        system: {
          architecture: status.system.arch,
          name: status.system.osName,
          version: status.system.osVersion,
          platform: status.system.platform,
          hostname: status.system.hostname,
          uptime: status.system.uptime,
          loadAverage: status.system.loadavg,
        },
        runtime: {
          nodeVersion: status.process.nodeVersion,
          pid: status.process.pid,
          uptime: status.process.uptime,
          environment: status.process.env.nodeEnv,
          timezone: status.process.env.timezone,
        },
        network: input.includeNetwork
          ? { interfaces: Object.keys(status.network?.interfaces || {}) }
          : undefined,
      }
    },
  })

  register({
    name: 'karin.browser.open',
    description: '在隔离浏览器中访问公开 HTTP/HTTPS URL，并读取页面标题和正文',
    toolset: 'karin.browser',
    tags: ['浏览器', '打开网页', '访问网址', 'URL'],
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 8, maxLength: 2048 },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: (input, context) => browser.open(context.threadId, String(input.url)),
  })

  register({
    name: 'karin.browser.search',
    description: '使用受管浏览器搜索公开网页，返回标题、URL 和摘要；技术结论仍需打开官方来源验证',
    toolset: 'karin.browser',
    tags: ['浏览器', '搜索网页', '查询资料', '最新资料', '官方文档'],
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: (input, context) =>
      browser.search(context.threadId, String(input.query), Number(input.limit || 8)),
  })

  register({
    name: 'karin.browser.snapshot',
    description: '读取当前浏览器页面的正文和链接列表',
    toolset: 'karin.browser',
    tags: ['浏览器', '页面内容', '链接'],
    inputSchema: { type: 'object', additionalProperties: false },
    risk: 'read',
    idempotent: true,
    execute: (_input, context) => browser.snapshot(context.threadId),
  })

  register({
    name: 'karin.browser.click',
    description: '使用 CSS selector 点击当前网页中的元素',
    toolset: 'karin.browser',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      additionalProperties: false,
      properties: {
        selector: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    risk: 'external',
    execute: (input, context) =>
      browser.click(context.threadId, String(input.selector)),
  })

  register({
    name: 'karin.browser.type',
    description: '向当前网页输入框填写文本，可选择按 Enter 提交',
    toolset: 'karin.browser',
    inputSchema: {
      type: 'object',
      required: ['selector', 'text'],
      additionalProperties: false,
      properties: {
        selector: { type: 'string', minLength: 1, maxLength: 500 },
        text: { type: 'string', maxLength: 20_000 },
        submit: { type: 'boolean' },
      },
    },
    risk: 'external',
    execute: (input, context) =>
      browser.type(
        context.threadId,
        String(input.selector),
        String(input.text),
        Boolean(input.submit)
      ),
  })

  register({
    name: 'karin.browser.extract',
    description: '使用 CSS selector 从当前网页提取匹配元素的文本和链接',
    toolset: 'karin.browser',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      additionalProperties: false,
      properties: {
        selector: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: (input, context) =>
      browser.extract(context.threadId, String(input.selector)),
  })

  register({
    name: 'karin.browser.screenshot',
    description: '使用 Karin 已注册的 Puppeteer/Snapka 渲染器截图，必要时降级到当前交互式浏览器',
    toolset: 'karin.browser',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 8, maxLength: 2048 },
        fullPage: { type: 'boolean' },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: (input, context) =>
      browser.screenshot(
        context.threadId,
        Boolean(input.fullPage),
        input.url ? String(input.url) : undefined
      ),
  })

  register({
    name: 'karin.browser.download',
    description: '从公开 URL 下载不超过 10 MiB 的文件到 Karin 隔离临时目录',
    toolset: 'karin.browser',
    tags: ['浏览器', '下载文件', 'URL'],
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 8, maxLength: 2048 },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: (input, context) => browser.download(context.threadId, String(input.url)),
  })

  register({
    name: 'karin.browser.close',
    description: '关闭当前 Thread 的隔离浏览器会话',
    toolset: 'karin.browser',
    inputSchema: { type: 'object', additionalProperties: false },
    risk: 'read',
    idempotent: true,
    execute: (_input, context) => browser.close(context.threadId),
  })

  register({
    name: 'karin.system.status',
    description: '读取 Karin 当前进程与 Agent 状态',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      required: ['version', 'uptime', 'memory', 'bots', 'plugins', 'tools'],
      additionalProperties: false,
      properties: {
        version: { type: 'string' },
        uptime: { type: 'number' },
        memory: { type: 'number' },
        bots: { type: 'number' },
        plugins: { type: 'number' },
        tools: { type: 'number' },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: () => ({
      version: process.env.KARIN_VERSION || 'development',
      uptime: process.uptime(),
      memory: process.memoryUsage().rss,
      bots: getAllBotList().length,
      plugins: Object.keys(cache.index).length,
      tools: cache.tool.length,
    }),
  })

  register({
    name: 'karin.bot.list',
    description: '列出当前已连接的机器人适配器',
    inputSchema: { type: 'object', additionalProperties: false },
    risk: 'read',
    idempotent: true,
    execute: () =>
      getAllBotList().map(item => ({
        index: item.index,
        selfId: item.bot.selfId,
        name: item.bot.account.name,
        protocol: item.bot.adapter.protocol,
        adapter: item.bot.adapter.name,
      })),
  })

  register({
    name: 'karin.plugin.list',
    description: '列出已加载插件及各类插件方法数量',
    inputSchema: { type: 'object', additionalProperties: false },
    risk: 'read',
    idempotent: true,
    execute: () => ({
      plugins: Object.values(cache.index).map(item => ({
        name: item.name,
        type: item.type,
        apps: item.apps.length,
      })),
      count: cache.count,
    }),
  })

  register({
    name: 'karin.task.list',
    description: '列出 Karin 后台任务',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
    },
    risk: 'read',
    idempotent: true,
    execute: input => taskSystem.list({ limit: Number(input.limit || 100) }),
  })

  register({
    name: 'karin.diagnostics.turn_trace',
    description: '读取当前会话指定回合的消息、Tool 状态和真实执行错误，用于定位未完成任务',
    toolset: 'karin.diagnostics',
    tags: ['诊断', '调用轨迹', 'Tool 回执', '错误'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turnId: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: async (input, context) => {
      const turnId = input.turnId ? String(input.turnId) : context.turnId
      const [messages, toolCalls] = await Promise.all([
        database.listMessages(context.threadId, 100),
        database.listToolCalls(context.threadId, turnId),
      ])
      return {
        threadId: context.threadId,
        turnId,
        messages: messages
          .filter(message => message.turnId === turnId)
          .map(message => ({
            role: message.role,
            name: message.name,
            content: redactDiagnosticText(message.content).slice(0, 4000),
          })),
        toolCalls: toolCalls.map(call => ({
          id: call.id,
          name: call.name,
          risk: call.risk,
          decision: call.decision,
          status: call.status,
          error: call.error ? redactDiagnosticText(call.error) : undefined,
          output: call.output,
        })),
      }
    },
  })

  register({
    name: 'karin.diagnostics.channel',
    description: '读取当前会话绑定的渠道、账号、联系人、会话模型和最近投递审计',
    toolset: 'karin.diagnostics',
    tags: ['诊断', '渠道路由', '投递失败', 'OneBot'],
    inputSchema: { type: 'object', additionalProperties: false },
    risk: 'read',
    idempotent: true,
    execute: async (_input, context) => {
      const [thread, audit] = await Promise.all([
        database.getThread(context.threadId),
        database.listAudit(300),
      ])
      return {
        thread,
        deliveries: audit
          .filter(row =>
            String(row.thread_id || '') === context.threadId &&
            String(row.action || '').startsWith('thread.delivery.')
          )
          .slice(0, 20)
          .map(row => ({
            action: row.action,
            detail: redactDiagnosticText(String(row.detail_json || '')).slice(0, 4000),
            createdAt: row.created_at,
          })),
      }
    },
  })

  register({
    name: 'karin.diagnostics.logs',
    description: '在 Karin 日志目录中限量搜索脱敏日志，不允许指定任意文件路径',
    toolset: 'karin.diagnostics',
    tags: ['诊断', '运行日志', '错误日志', '堆栈'],
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: async input => {
      const query = String(input.query)
      const limit = Math.max(1, Math.min(Number(input.limit || 80), 200))
      const entries = await fs.promises.readdir(karinPathLogs, { withFileTypes: true })
        .catch(() => [])
      const files = entries
        .filter(entry => entry.isFile() && /\.(?:log|txt)$/i.test(entry.name))
        .map(entry => path.join(karinPathLogs, entry.name))
        .slice(-20)
      const matches: Array<{ file: string, line: number, text: string }> = []
      for (const filename of files) {
        const stat = await fs.promises.stat(filename)
        const start = Math.max(0, stat.size - 2 * 1024 * 1024)
        const handle = await fs.promises.open(filename, 'r')
        try {
          const buffer = Buffer.alloc(stat.size - start)
          await handle.read(buffer, 0, buffer.length, start)
          for (const [index, line] of buffer.toString('utf8').split(/\r?\n/).entries()) {
            if (!line.toLowerCase().includes(query)) continue
            matches.push({
              file: path.basename(filename),
              line: index + 1,
              text: redactDiagnosticText(line).slice(0, 2000),
            })
            if (matches.length >= limit) break
          }
        } finally {
          await handle.close()
        }
        if (matches.length >= limit) break
      }
      return { query, matches, truncated: matches.length >= limit }
    },
  })

  register({
    name: 'karin.diagnostics.source_read',
    description: '读取 Karin 工作区或本地源码插件中的文本源码；禁止凭据、node_modules 和越界路径',
    toolset: 'karin.diagnostics',
    tags: ['诊断', '读取源码', '检查实现'],
    inputSchema: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        workspace: { enum: ['karin', 'plugins'] },
        path: { type: 'string', minLength: 1, maxLength: 1000 },
        maxBytes: { type: 'integer', minimum: 1024, maximum: 131072 },
      },
    },
    risk: 'read',
    idempotent: true,
    permission: 'admin',
    execute: async input => {
      const root = diagnosticRoot(input.workspace)
      const filename = await diagnosticFile(root, String(input.path))
      const maximum = Math.max(1024, Math.min(Number(input.maxBytes || 65536), 131072))
      const content = await fs.promises.readFile(filename, 'utf8')
      return {
        workspace: input.workspace === 'plugins' ? 'plugins' : 'karin',
        path: path.relative(root, filename).replace(/\\/g, '/'),
        content: redactDiagnosticText(content.slice(0, maximum)),
        truncated: Buffer.byteLength(content, 'utf8') > maximum,
      }
    },
  })

  register({
    name: 'karin.diagnostics.source_search',
    description: '在 Karin 工作区或本地源码插件中搜索文本，不执行 Shell 或任意命令',
    toolset: 'karin.diagnostics',
    tags: ['诊断', '搜索源码', '定位实现'],
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        workspace: { enum: ['karin', 'plugins'] },
        query: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    risk: 'read',
    idempotent: true,
    permission: 'admin',
    execute: async input => {
      const root = diagnosticRoot(input.workspace)
      const query = String(input.query).toLowerCase()
      const limit = Math.max(1, Math.min(Number(input.limit || 80), 200))
      const matches: Array<{ path: string, line: number, text: string }> = []
      for (const filename of await walkDiagnosticFiles(root)) {
        const content = await fs.promises.readFile(filename, 'utf8').catch(() => '')
        if (!content.toLowerCase().includes(query)) continue
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (!line.toLowerCase().includes(query)) continue
          matches.push({
            path: path.relative(root, filename).replace(/\\/g, '/'),
            line: index + 1,
            text: redactDiagnosticText(line).slice(0, 1000),
          })
          if (matches.length >= limit) break
        }
        if (matches.length >= limit) break
      }
      return { query, matches, truncated: matches.length >= limit }
    },
  })

  register({
    name: 'karin.memory.search',
    description: '搜索 Agent 长期记忆',
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    },
    risk: 'read',
    idempotent: true,
    execute: async (input, context) => {
      const query = String(input.query).toLowerCase()
      const own = memoryScopeFor(context.actor)
      const scopes = own.scope === 'global'
        ? [{ scope: 'global', key: 'global' }]
        : [{ scope: 'global', key: 'global' }, { scope: own.scope, key: own.key }]
      return (await database.retrieveMemories(scopes, query, {
        ...agentConfig().memory.retrieval,
        maxItems: 50,
        maxPromptTokens: 20_000,
      })).map(item => ({ ...item.memory, score: item.score }))
    },
  })

  register({
    name: 'karin.skill.list',
    description: '列出或搜索当前 Thread 已固定版本的 Skill 紧凑索引；不会预加载正文',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', maxLength: 500 },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: async (input, context) => {
      const query = String(input.query || '').trim().toLowerCase()
      const skills = await database.getThreadSkillIndex(context.threadId)
      if (!query) return skills
      return skills.filter(skill =>
        `${skill.name} ${skill.description} ${skill.tools.join(' ')}`
          .toLowerCase()
          .includes(query)
      )
    },
  })

  register({
    name: 'karin.memory.remember',
    description: '保存一条对未来对话有用的长期记忆；普通用户只能写入自己的会话作用域',
    toolset: 'karin.memory',
    tags: ['记忆', '记住', '偏好'],
    inputSchema: {
      type: 'object',
      required: ['content'],
      additionalProperties: false,
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 2000 },
        scope: { enum: ['auto', 'global'] },
        kind: { enum: ['preference', 'fact', 'relationship', 'procedure', 'constraint'] },
        key: { type: 'string', maxLength: 200 },
      },
    },
    risk: 'write',
    riskResolver: input => input.scope === 'global' ? 'external' : 'write',
    reversible: true,
    execute: async (input, context) => {
      const content = String(input.content).trim()
      if (/api[_ -]?key|token|password|cookie|private key/i.test(content)) {
        throw new Error('长期记忆不得包含密钥或认证信息')
      }
      const target = memoryScopeFor(
        context.actor,
        input.scope === 'global' ? 'global' : undefined
      )
      const id = await database.addMemory(target.scope, target.key, content, context.turnId, {
        kind: (input.kind || 'fact') as 'preference' | 'fact' | 'relationship' |
          'procedure' | 'constraint',
        memoryKey: String(input.key || '').trim() || null,
        confidence: 1,
        importance: 0.8,
        sourceType: 'explicit',
      })
      await database.audit(
        context.actor.id,
        'memory.create',
        id,
        { scope: target.scope, key: target.key },
        context.threadId
      )
      return { id, scope: target.scope, scopeKey: target.key }
    },
  })

  register({
    name: 'karin.memory.state',
    description: '启用或禁用一条长期记忆',
    toolset: 'karin.memory',
    inputSchema: {
      type: 'object',
      required: ['id', 'enabled'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        enabled: { type: 'boolean' },
      },
    },
    risk: 'write',
    reversible: true,
    permission: 'admin',
    execute: input => database.setMemoryEnabled(String(input.id), Boolean(input.enabled)),
  })

  register({
    name: 'karin.memory.delete',
    description: '永久删除一条长期记忆；默认安全策略拒绝此操作',
    toolset: 'karin.memory',
    inputSchema: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1 } },
    },
    risk: 'destructive',
    permission: 'admin',
    execute: input => database.deleteMemory(String(input.id)),
  })

  register({
    name: 'karin.skill.view',
    description: [
      '按当前 Thread 固定版本读取 Skill 文件并记录加载轨迹。',
      '省略 filePath 或传 SKILL.md 读取主说明；支持文件路径必须来自返回的 files manifest。',
    ].join(' '),
    toolset: 'karin.skill',
    inputSchema: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        filePath: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
        },
      },
    },
    risk: 'read',
    idempotent: true,
    execute: async (input, context) => {
      const skill = await database.getThreadSkillVersion(
        context.threadId,
        String(input.id)
      )
      if (!skill) throw new Error('当前 Thread 未固定该 Skill')
      const filePath = String(input.filePath || 'SKILL.md')
      const content = filePath === 'SKILL.md'
        ? skill.content
        : await learning.readSkillFile(
          skill.id,
          skill.versionId,
          filePath,
          skill.filesManifest
        )
      await database.recordSkillLoad({
        threadId: context.threadId,
        turnId: context.turnId,
        skillId: skill.id,
        skillVersionId: skill.versionId,
        filePath,
      })
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        versionId: skill.versionId,
        version: skill.version,
        tools: skill.tools,
        filePath,
        content,
        files: Object.keys(skill.filesManifest),
      }
    },
  })

  register({
    name: 'karin.skill.manage',
    description: [
      '创建或更新版本化声明式 Skill。',
      '支持 create、patch、edit、write_file、remove_file、delete；优先用 patch。',
      '每次变更创建不可变版本，新版本只进入新 Thread；删除和移除文件必须审批。',
    ].join(' '),
    toolset: 'karin.skill',
    tags: ['Skill 创建', 'Skill patch', '支持文件', '版本化 Skill'],
    inputSchema: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: {
          enum: ['create', 'patch', 'edit', 'write_file', 'remove_file', 'delete'],
        },
        id: { type: 'string', minLength: 1 },
        name: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,63}$' },
        description: { type: 'string', minLength: 1, maxLength: 500 },
        instructions: { type: 'string', minLength: 1, maxLength: 8192 },
        tools: {
          type: 'array',
          uniqueItems: true,
          maxItems: 50,
          items: { type: 'string' },
        },
        filePath: { type: 'string', minLength: 1, maxLength: 500 },
        content: { type: 'string', maxLength: 65536 },
        search: { type: 'string', minLength: 1, maxLength: 8192 },
        replace: { type: 'string', maxLength: 8192 },
      },
    },
    risk: 'write',
    riskResolver: input =>
      ['remove_file', 'delete'].includes(String(input.action))
        ? 'destructive'
        : 'write',
    reversible: true,
    permission: 'admin',
    execute: (input, context) => learning.manageSkill({
      action: input.action as
        | 'create'
        | 'patch'
        | 'edit'
        | 'write_file'
        | 'remove_file'
        | 'delete',
      id: input.id === undefined ? undefined : String(input.id),
      name: input.name === undefined ? undefined : String(input.name),
      description: input.description === undefined
        ? undefined
        : String(input.description),
      instructions: input.instructions === undefined
        ? undefined
        : String(input.instructions),
      tools: Array.isArray(input.tools) ? input.tools.map(String) : undefined,
      filePath: input.filePath === undefined ? undefined : String(input.filePath),
      content: input.content === undefined ? undefined : String(input.content),
      search: input.search === undefined ? undefined : String(input.search),
      replace: input.replace === undefined ? undefined : String(input.replace),
    }, context.threadId, context.turnId, context.actor),
  })

  register({
    name: 'karin.tool.manage',
    description: [
      '管理独立的版本化 Generated Tool。',
      'create 只接受无文件、网络、环境变量和子进程权限的纯计算 Python Tool，',
      '通过 AST、JSON Schema 与隔离沙箱校验后可自动启用。',
    ].join(' '),
    toolset: 'karin.tool',
    tags: ['创建 Tool', '纯计算', '验证 Tool', '回滚 Tool'],
    inputSchema: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: {
          enum: ['create', 'validate', 'activate', 'deactivate', 'rollback', 'delete'],
        },
        name: { type: 'string', minLength: 3, maxLength: 128 },
        description: { type: 'string', minLength: 1, maxLength: 500 },
        definition: scriptToolSchema,
        versionId: { type: 'string', minLength: 1 },
      },
    },
    risk: 'write',
    riskResolver: input => input.action === 'delete' ? 'destructive' : 'write',
    reversible: true,
    permission: 'admin',
    execute: async (input, context) => {
      const action = String(input.action)
      const name = String(input.name || '')
      if (action === 'create') {
        if (!input.definition || typeof input.definition !== 'object') {
          throw new Error('create 需要 definition')
        }
        return generatedTools.create({
          name,
          description: String(input.description || ''),
          definition: input.definition as AgentScriptToolDefinition,
        }, context)
      }
      if (!name) throw new Error(`${action} 需要 name`)
      if (action === 'validate') return generatedTools.validate(name, context.signal)
      if (action === 'activate') {
        return generatedTools.setEnabled(name, true, context.actor, context.threadId)
      }
      if (action === 'deactivate') {
        return generatedTools.setEnabled(name, false, context.actor, context.threadId)
      }
      if (action === 'rollback') {
        if (!input.versionId) throw new Error('rollback 需要 versionId')
        return generatedTools.rollback(
          name,
          String(input.versionId),
          context.actor,
          context.threadId
        )
      }
      if (action === 'delete') {
        return generatedTools.delete(name, context.actor, context.threadId)
      }
      throw new Error(`不支持的 action: ${action}`)
    },
  })

  register({
    name: 'karin.skill.create',
    description: '创建或更新一个版本化 Skill，可附带受管 Python Script Tools',
    toolset: 'karin.skill',
    tags: ['技能', '工作流', '创建技能'],
    inputSchema: {
      type: 'object',
      required: ['name', 'description', 'instructions'],
      additionalProperties: false,
      properties: {
        skillId: { type: 'string', minLength: 1 },
        name: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,63}$' },
        description: { type: 'string', minLength: 1, maxLength: 500 },
        instructions: { type: 'string', minLength: 1, maxLength: 8192 },
        tools: {
          type: 'array',
          uniqueItems: true,
          maxItems: 50,
          items: { type: 'string' },
        },
        scriptTools: {
          type: 'array',
          uniqueItems: true,
          maxItems: 20,
          items: scriptToolSchema,
        },
      },
    },
    risk: 'write',
    reversible: true,
    permission: 'admin',
    execute: async (input, context) => {
      const skill = {
        name: String(input.name),
        description: String(input.description),
        instructions: String(input.instructions),
        tools: Array.isArray(input.tools) ? input.tools.map(String) : [],
        scriptTools: Array.isArray(input.scriptTools) ? input.scriptTools : [],
      }
      const skillId = input.skillId ? String(input.skillId) : ''
      const result = skillId
        ? await learning.updateSkill(
          skillId,
          skill,
          context.threadId,
          context.turnId,
          context.actor
        )
        : await learning.createSkill(
          skill,
          context.threadId,
          context.turnId,
          context.actor
        )
      return {
        created: !skillId,
        updated: Boolean(skillId),
        name: String(input.name),
        ...result,
      }
    },
  })

  register({
    name: 'karin.skill.install_url',
    description: '从公开 GitHub 仓库或直接 SKILL.md URL 安全导入 Skill',
    toolset: 'karin.skill',
    tags: ['安装技能', 'URL Skill', 'GitHub Skill'],
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 8, maxLength: 2048 },
      },
    },
    risk: 'external',
    permission: 'admin',
    timeout: 120_000,
    execute: (input, context) =>
      learning.installFromUrl(
        String(input.url),
        context.threadId,
        context.turnId,
        context.actor
      ),
  })

  register({
    name: 'karin.skill.state',
    description: '启用或禁用一个声明式 Skill；变更只影响新 Thread',
    toolset: 'karin.skill',
    inputSchema: {
      type: 'object',
      required: ['id', 'enabled'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        enabled: { type: 'boolean' },
      },
    },
    risk: 'write',
    reversible: true,
    permission: 'admin',
    execute: (input, context) =>
      learning.setSkillEnabled(
        String(input.id),
        Boolean(input.enabled),
        context.actor
      ),
  })

  register({
    name: 'karin.skill.rollback',
    description: '把声明式 Skill 的活动版本回滚到指定版本',
    toolset: 'karin.skill',
    inputSchema: {
      type: 'object',
      required: ['id', 'versionId'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        versionId: { type: 'string', minLength: 1 },
      },
    },
    risk: 'write',
    reversible: true,
    permission: 'admin',
    execute: (input, context) =>
      learning.rollbackSkill(
        String(input.id),
        String(input.versionId),
        context.actor
      ),
  })

  register({
    name: 'karin.cron.list',
    description: '列出 Karin Agent 的持久化定时任务',
    toolset: 'karin.cron',
    inputSchema: { type: 'object', additionalProperties: false },
    risk: 'read',
    idempotent: true,
    execute: () => database.listJobs(),
  })

  register({
    name: 'karin.cron.create',
    description: '创建持久化定时任务或一次性提醒；相对时间使用 delaySeconds，周期任务使用 cron',
    toolset: 'karin.cron',
    tags: ['定时任务', '一次性任务', '计划', '提醒', '稍后执行'],
    inputSchema: {
      type: 'object',
      required: ['name', 'prompt'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        scheduleType: { enum: ['cron', 'once'] },
        cron: { type: 'string', minLength: 5, maxLength: 120 },
        runAt: { type: 'integer', minimum: 1 },
        delaySeconds: { type: 'integer', minimum: 1, maximum: 31536000 },
        prompt: { type: 'string', minLength: 1, maxLength: 20000 },
        target: { type: 'string', maxLength: 500 },
        timezone: { type: 'string', maxLength: 100 },
        toolAllowlist: {
          type: 'array',
          uniqueItems: true,
          maxItems: 100,
          items: { type: 'string' },
        },
        skillIds: {
          type: 'array',
          uniqueItems: true,
          maxItems: 100,
          items: { type: 'string' },
        },
        personaId: { type: 'string', maxLength: 100 },
        enabled: { type: 'boolean' },
      },
    },
    risk: 'write',
    permission: 'all',
    execute: async (input, context) => {
      const scheduleType = input.scheduleType === 'once' ||
        input.runAt !== undefined ||
        input.delaySeconds !== undefined
        ? 'once'
        : 'cron'
      const runAt = input.delaySeconds !== undefined
        ? Date.now() + Number(input.delaySeconds) * 1000
        : input.runAt !== undefined
          ? Number(input.runAt)
          : null
      const cron = input.cron ? String(input.cron) : ''
      if (scheduleType === 'cron' && !cron) {
        throw new Error('周期任务必须提供 cron 表达式')
      }
      if (scheduleType === 'once' && (!runAt || runAt <= Date.now())) {
        throw new Error('一次性任务必须提供未来的 runAt 或正数 delaySeconds')
      }

      const target = input.target ? String(input.target) : context.actor.contactKey
      if (
        target !== context.actor.contactKey &&
        !['master', 'admin'].includes(context.actor.role)
      ) {
        throw new Error('普通用户只能为当前会话创建定时任务')
      }

      return scheduler.save({
        name: String(input.name),
        scheduleType,
        cron,
        runAt,
        timezone: input.timezone ? String(input.timezone) : 'Asia/Shanghai',
        prompt: String(input.prompt),
        target,
        toolAllowlist: Array.isArray(input.toolAllowlist)
          ? input.toolAllowlist.map(String)
          : [],
        skillIds: Array.isArray(input.skillIds) ? input.skillIds.map(String) : [],
        personaId: input.personaId ? String(input.personaId) : null,
        enabled: input.enabled !== false,
        createdBy: context.actor.id,
      })
    },
  })

  register({
    name: 'karin.cron.state',
    description: '暂停或恢复一个持久化 Agent 定时任务',
    toolset: 'karin.cron',
    inputSchema: {
      type: 'object',
      required: ['id', 'enabled'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        enabled: { type: 'boolean' },
      },
    },
    risk: 'write',
    permission: 'admin',
    execute: input => scheduler.setEnabled(String(input.id), Boolean(input.enabled)),
  })

  register({
    name: 'karin.cron.run',
    description: '立即执行一个已存在的 Agent 定时任务',
    toolset: 'karin.cron',
    inputSchema: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1 } },
    },
    risk: 'write',
    permission: 'admin',
    execute: input => scheduler.runNow(String(input.id)),
  })

  register({
    name: 'karin.cron.delete',
    description: '永久删除一个 Agent 定时任务；默认安全策略拒绝此操作',
    toolset: 'karin.cron',
    inputSchema: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1 } },
    },
    risk: 'destructive',
    permission: 'admin',
    execute: input => scheduler.delete(String(input.id)),
  })

  register({
    name: 'karin.bot.send_message',
    description: '向聊天渠道发送文字或图片。渠道回合必须省略 selfId、scene、peer、subPeer，由运行时绑定当前会话；仅 Web 或自动任务明确指定目标时填写。发送图片使用有序 elements，source 必须是安全公网 URL 或 Karin 受控文件',
    toolset: 'karin.message',
    tags: ['发送消息', '主动消息', '发送图片', '照片', '通知', '推送', '联系用户'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        selfId: { type: 'string', minLength: 1 },
        scene: { enum: ['group', 'friend', 'guild', 'direct', 'groupTemp'] },
        peer: { type: 'string', minLength: 1 },
        subPeer: { type: 'string' },
        message: { type: 'string', minLength: 1, maxLength: 10000 },
        elements: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: {
            oneOf: [
              {
                type: 'object',
                required: ['type', 'text'],
                additionalProperties: false,
                properties: {
                  type: { const: 'text' },
                  text: { type: 'string', minLength: 1, maxLength: 10000 },
                },
              },
              {
                type: 'object',
                required: ['type', 'source'],
                additionalProperties: false,
                properties: {
                  type: { const: 'image' },
                  source: { type: 'string', minLength: 1, maxLength: 2048 },
                  alt: { type: 'string', maxLength: 200 },
                },
              },
            ],
          },
        },
      },
    },
    risk: 'external',
    permission: 'all',
    execute: async (input, context) => {
      const hasMessage = typeof input.message === 'string' && input.message.length > 0
      const hasElements = Array.isArray(input.elements) && input.elements.length > 0
      if (hasMessage === hasElements) {
        throw new Error('message 与 elements 必须且只能提供一个')
      }
      const current = agentDeliveryTarget(context.actor, context.event)
      const hasExplicitTarget = Boolean(input.selfId || input.scene || input.peer || input.subPeer)
      const explicitTarget = hasExplicitTarget
        ? input.selfId && input.scene && input.peer
          ? {
            selfId: String(input.selfId),
            contact: {
              scene: input.scene as Scene,
              peer: String(input.peer),
              subPeer: input.subPeer ? String(input.subPeer) : undefined,
              name: '',
              subName: '',
            } as Contact,
          }
          : null
        : null
      if (hasExplicitTarget && !explicitTarget) {
        throw new Error('消息目标不完整')
      }
      const differsFromCurrent = Boolean(
        explicitTarget &&
        current &&
        (
          current.selfId !== explicitTarget.selfId ||
          current.contact.scene !== explicitTarget.contact.scene ||
          current.contact.peer !== explicitTarget.contact.peer ||
          current.contact.subPeer !== explicitTarget.contact.subPeer
        )
      )
      if (context.event && differsFromCurrent) {
        throw new Error('渠道回合只能向当前会话发送，请省略 selfId、scene、peer 和 subPeer')
      }
      const target = explicitTarget || current
      if (!target) throw new Error('消息目标不完整，且当前会话无法解析')
      if (
        hasExplicitTarget &&
        !['master', 'admin'].includes(context.actor.role) &&
        (!current || differsFromCurrent)
      ) {
        throw new Error('普通用户只能向当前会话发送消息')
      }
      const message = Array.isArray(input.elements)
        ? await agentStructuredMessage(input.elements.map(item => ({
          type: (item as { type?: unknown }).type === 'image' ? 'image' : 'text',
          text: String((item as { text?: unknown }).text || ''),
          source: String((item as { source?: unknown }).source || ''),
          alt: String((item as { alt?: unknown }).alt || ''),
        })))
        : await agentSendMessage(String(input.message))
      const sent = await sendMsg(
        target.selfId,
        target.contact,
        message
      )
      const normalized = Array.isArray(message) ? message : [message]
      const imageSegments = normalized.filter(item =>
        (item as { type?: unknown })?.type === 'image'
      ).length
      return {
        delivered: true,
        channel: context.actor.origin?.channel || context.actor.origin?.protocol || '',
        accountId: target.selfId,
        contactKey: context.actor.origin?.contactKey || context.actor.contactKey,
        scene: target.contact.scene,
        peer: target.contact.peer,
        textSegments: normalized.length - imageSegments,
        imageSegments,
        result: sent,
      }
    },
  })

  register({
    name: 'karin.task.run',
    description: '执行一个已存在的 Karin 后台任务',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      additionalProperties: false,
      properties: { taskId: { type: 'string', minLength: 1 } },
    },
    risk: 'write',
    permission: 'admin',
    execute: input => taskSystem.run(String(input.taskId)),
  })

  register({
    name: 'karin.plugin.install',
    description: '创建插件安装任务；npm 包名和外部 URL 均会经过校验与审批',
    inputSchema: {
      type: 'object',
      required: ['name', 'type'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 214 },
        type: { enum: ['npm', 'git'] },
        url: { type: 'string', maxLength: 2048 },
      },
    },
    risk: 'external',
    permission: 'master',
    execute: input => {
      const name = String(input.name)
      const type = input.type as 'npm' | 'git'
      if (type === 'npm' && !npmPackage.test(name)) throw new Error('npm 包名非法')
      if (type !== 'npm' && !/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error('插件目录名称非法')
      }
      const url = input.url ? new URL(String(input.url)).toString() : undefined
      if (type === 'git') {
        if (!url) throw new Error('git 插件缺少 URL')
        if (!url.startsWith('https://') || /["';&|<>`$()]/.test(url)) {
          throw new Error('git 插件只允许安全的 HTTPS URL')
        }
      }
      return { taskId: startPluginInstall({ name, type, url }) }
    },
  })

  register({
    name: 'karin.plugin.update',
    description: '更新一个已安装的 npm 插件到指定版本',
    inputSchema: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 214 },
        version: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    risk: 'external',
    permission: 'master',
    timeout: 120000,
    execute: (input, context) =>
      updateNpmPlugin(
        String(input.name),
        input.version ? String(input.version) : 'latest',
        context.signal
      ),
  })

  register({
    name: 'karin.plugin.uninstall',
    description: '卸载一个 npm 或 git 插件；默认硬拒绝，仅能由显式安全策略开放',
    inputSchema: {
      type: 'object',
      required: ['name', 'type'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 214 },
        type: { enum: ['npm', 'git'] },
      },
    },
    risk: 'destructive',
    permission: 'master',
    execute: input => {
      const name = String(input.name)
      const type = input.type as 'npm' | 'git'
      if (type === 'npm' && !npmPackage.test(name)) throw new Error('npm 包名非法')
      if (type === 'git' && !/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error('插件目录名称非法')
      }
      return { taskId: startPluginUninstall({ name, type }) }
    },
  })

  if (repair) {
    register({
      name: 'karin.repair.propose',
      description: '把已诊断的 Core 或本地源码插件缺陷保存为带业务语义、停止条件、失败策略和 Diff 的受管修复候选',
      toolset: 'karin.repair',
      tags: ['修复候选', '源码补丁', '能力缺口', '自我进化'],
      inputSchema: {
        type: 'object',
        required: [
          'target',
          'problem',
          'reproduction',
          'rootCause',
          'confidence',
          'patch',
          'semantics',
          'stopCondition',
          'failureStrategy',
          'verification',
          'rollback',
        ],
        additionalProperties: false,
        properties: {
          target: { enum: ['karin', 'plugin'] },
          pluginName: {
            type: 'string',
            pattern: '^[a-zA-Z0-9._-]+$',
            maxLength: 100,
          },
          problem: { type: 'string', minLength: 1, maxLength: 2000 },
          reproduction: { type: 'string', minLength: 1, maxLength: 4000 },
          rootCause: { type: 'string', minLength: 1, maxLength: 4000 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          patch: { type: 'string', minLength: 1, maxLength: 262144 },
          semantics: {
            type: 'object',
            required: ['objective', 'inputs', 'outputs', 'sideEffects', 'idempotent'],
            additionalProperties: false,
            properties: {
              objective: { type: 'string', minLength: 1, maxLength: 1000 },
              inputs: { type: 'string', minLength: 1, maxLength: 1000 },
              outputs: { type: 'string', minLength: 1, maxLength: 1000 },
              sideEffects: {
                type: 'array',
                maxItems: 20,
                items: { type: 'string', minLength: 1, maxLength: 500 },
              },
              idempotent: { type: 'boolean' },
            },
          },
          stopCondition: { type: 'string', minLength: 1, maxLength: 1000 },
          failureStrategy: { type: 'string', minLength: 1, maxLength: 1000 },
          verification: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: {
              enum: ['agent-tests', 'core-build', 'web-build', 'root-build'],
            },
          },
          rollback: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
      risk: 'write',
      permission: 'admin',
      timeout: 60_000,
      execute: (input, context) =>
        repair.propose(
          input as unknown as AgentRepairProposal,
          context.actor,
          context.threadId,
          context.turnId
        ),
    })

    register({
      name: 'karin.repair.artifact',
      description: '读取受管修复候选的完整 Diff 和验证元数据，仅供管理员审查',
      toolset: 'karin.repair',
      tags: ['修复候选', '补丁审查', 'Diff'],
      inputSchema: {
        type: 'object',
        required: ['candidateId'],
        additionalProperties: false,
        properties: {
          candidateId: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
      risk: 'read',
      permission: 'admin',
      idempotent: true,
      execute: input => repair.artifact(String(input.candidateId)),
    })

    register({
      name: 'karin.repair.apply',
      description: '应用已验证的受管修复候选，执行固定测试/构建；失败自动恢复触及文件，可在成功后重启 Core',
      toolset: 'karin.repair',
      tags: ['应用修复', '验证补丁', '重启 Core'],
      inputSchema: {
        type: 'object',
        required: ['candidateId'],
        additionalProperties: false,
        properties: {
          candidateId: { type: 'string', minLength: 1, maxLength: 100 },
          restartCore: { type: 'boolean' },
        },
      },
      risk: 'destructive',
      permission: 'master',
      timeout: 600_000,
      execute: (input, context) =>
        repair.apply(
          String(input.candidateId),
          context.actor,
          input.restartCore !== false
        ),
    })

    register({
      name: 'karin.repair.rollback',
      description: '从受管备份恢复一个已生效修复候选，并可重启 Core',
      toolset: 'karin.repair',
      tags: ['回滚修复', '恢复源码', '重启 Core'],
      inputSchema: {
        type: 'object',
        required: ['candidateId'],
        additionalProperties: false,
        properties: {
          candidateId: { type: 'string', minLength: 1, maxLength: 100 },
          restartCore: { type: 'boolean' },
        },
      },
      risk: 'destructive',
      permission: 'master',
      timeout: 120_000,
      execute: (input, context) =>
        repair.rollback(
          String(input.candidateId),
          context.actor,
          input.restartCore !== false
        ),
    })
  }

  register({
    name: 'karin.system.restart',
    description: '请求重启 Karin 运行时',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reloadDeps: { type: 'boolean' },
        isPm2: { type: 'boolean' },
      },
    },
    risk: 'write',
    permission: 'master',
    execute: async input => {
      await restartDirect({
        reloadDeps: Boolean(input.reloadDeps),
        isPm2: Boolean(input.isPm2),
      })
      return { accepted: true }
    },
  })

  register({
    name: 'karin.agent.delegate',
    description: '把一个有明确结果的子任务交给单层受限子 Agent',
    toolset: 'karin.agent',
    tags: ['子 Agent', '委派', '单个子任务'],
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 20000 },
        allowedTools: {
          type: 'array',
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string' },
        },
      },
    },
    risk: 'read',
    execute: (input, context) =>
      runtime.delegate(context, {
        prompt: String(input.prompt),
        allowedTools: Array.isArray(input.allowedTools)
          ? input.allowedTools.map(String)
          : undefined,
      }),
  })

  register({
    name: 'karin.agent.delegate_many',
    description: '把两个以上相互独立的检索或分析任务并行交给只读子 Agent，并返回可统一汇总的具名结果',
    toolset: 'karin.agent',
    tags: ['子 Agent', '并行', '委派', '分工', '多个子任务', '汇总'],
    inputSchema: {
      type: 'object',
      required: ['tasks'],
      additionalProperties: false,
      properties: {
        tasks: {
          type: 'array',
          minItems: 2,
          maxItems: 32,
          items: {
            type: 'object',
            required: ['id', 'label', 'prompt'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' },
              label: { type: 'string', minLength: 1, maxLength: 100 },
              prompt: { type: 'string', minLength: 1, maxLength: 20000 },
            },
          },
        },
      },
    },
    risk: 'read',
    timeout: 120000,
    execute: (input, context) =>
      runtime.delegateMany(
        context,
        (input.tasks as Array<Record<string, unknown>>).map(task => ({
          id: String(task.id),
          label: String(task.label),
          prompt: String(task.prompt),
        }))
      ),
  })
}
