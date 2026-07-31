import { cache } from '@/plugin/system/cache'
import { getAllBotList, sendMsg } from '@/service/bot'
import { taskSystem } from '@/service/task'
import { restartDirect } from '@/utils/system/restart'
import { startPluginInstall, startPluginUninstall } from '@/server/plugins/install'
import { updateNpmPlugin } from './plugin'

import type { Contact, Scene } from '@/types/event'
import type { AgentDatabase } from '../persistence/database'
import type { AgentLearning } from '../learning/learning'
import type { AgentRuntime } from '../runtime/runtime'
import type { AgentScheduler } from '../automation/scheduler'
import type { AgentToolRegistry } from '../tools/registry'

const npmPackage = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._-]+)?$/

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
  learning: AgentLearning
) => {
  const register = (options: Parameters<typeof registry.register>[0]) => {
    registry.register(options, true)
  }

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
      return (await database.listMemories(scopes))
        .filter(item => item.enabled && item.content.toLowerCase().includes(query))
        .slice(0, 50)
    },
  })

  register({
    name: 'karin.skill.list',
    description: '列出 Agent 声明式技能和当前活动版本',
    inputSchema: { type: 'object', additionalProperties: false },
    risk: 'read',
    idempotent: true,
    execute: () => database.listSkills(),
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
      },
    },
    risk: 'write',
    execute: async (input, context) => {
      const content = String(input.content).trim()
      if (/api[_ -]?key|token|password|cookie|private key/i.test(content)) {
        throw new Error('长期记忆不得包含密钥或认证信息')
      }
      const target = memoryScopeFor(
        context.actor,
        input.scope === 'global' ? 'global' : undefined
      )
      const id = await database.addMemory(target.scope, target.key, content, context.turnId)
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
    description: '查看指定声明式 Skill 的所有版本',
    toolset: 'karin.skill',
    inputSchema: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1 } },
    },
    risk: 'read',
    idempotent: true,
    execute: input => database.getSkillVersions(String(input.id)),
  })

  register({
    name: 'karin.skill.create',
    description: '创建或更新一个声明式 Skill；内容只能引用已注册 Tool，不允许脚本或依赖安装',
    toolset: 'karin.skill',
    tags: ['技能', '工作流', '创建技能'],
    inputSchema: {
      type: 'object',
      required: ['name', 'description', 'instructions'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,63}$' },
        description: { type: 'string', minLength: 1, maxLength: 500 },
        instructions: { type: 'string', minLength: 1, maxLength: 8192 },
        tools: {
          type: 'array',
          uniqueItems: true,
          maxItems: 50,
          items: { type: 'string' },
        },
      },
    },
    risk: 'write',
    permission: 'admin',
    execute: async (input, context) => {
      await learning.createSkill({
        name: String(input.name),
        description: String(input.description),
        instructions: String(input.instructions),
        tools: Array.isArray(input.tools) ? input.tools.map(String) : [],
      }, context.threadId, context.turnId, context.actor)
      return { created: true, name: String(input.name) }
    },
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
    permission: 'admin',
    execute: input => database.setSkillEnabled(String(input.id), Boolean(input.enabled)),
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
    permission: 'admin',
    execute: input => database.rollbackSkill(String(input.id), String(input.versionId)),
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
    description: '根据 cron 表达式创建持久化 Agent 任务；例如每天九点为 0 9 * * *',
    toolset: 'karin.cron',
    tags: ['定时任务', '计划', '提醒'],
    inputSchema: {
      type: 'object',
      required: ['name', 'cron', 'prompt'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        cron: { type: 'string', minLength: 5, maxLength: 120 },
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
        enabled: { type: 'boolean' },
      },
    },
    risk: 'write',
    permission: 'admin',
    execute: (input, context) => scheduler.save({
      name: String(input.name),
      scheduleType: 'cron',
      cron: String(input.cron),
      runAt: null,
      timezone: input.timezone ? String(input.timezone) : 'Asia/Shanghai',
      prompt: String(input.prompt),
      target: input.target ? String(input.target) : context.actor.contactKey,
      toolAllowlist: Array.isArray(input.toolAllowlist)
        ? input.toolAllowlist.map(String)
        : [],
      skillIds: Array.isArray(input.skillIds) ? input.skillIds.map(String) : [],
      enabled: input.enabled !== false,
      createdBy: context.actor.id,
    }),
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
    description: '通过指定机器人向联系人发送消息',
    inputSchema: {
      type: 'object',
      required: ['selfId', 'scene', 'peer', 'message'],
      additionalProperties: false,
      properties: {
        selfId: { type: 'string', minLength: 1 },
        scene: { enum: ['group', 'friend', 'guild', 'direct', 'groupTemp'] },
        peer: { type: 'string', minLength: 1 },
        subPeer: { type: 'string' },
        message: { type: 'string', minLength: 1, maxLength: 10000 },
      },
    },
    risk: 'external',
    permission: 'admin',
    execute: input =>
      sendMsg(
        String(input.selfId),
        {
          scene: input.scene as Scene,
          peer: String(input.peer),
          subPeer: input.subPeer ? String(input.subPeer) : undefined,
          name: '',
          subName: '',
        } as Contact,
        String(input.message)
      ),
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
}
