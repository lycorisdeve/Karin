import { command } from '@/core/karin/command'
import { cache } from '../system/cache'

import type { MessageEventMap } from '@/types/event'
import type { Command, CommandClass, PkgInfo } from '@/types/plugin'

type CachedCommand =
  | Command<keyof MessageEventMap>
  | CommandClass<keyof MessageEventMap>

export interface CommandHelpItem {
  plugin: string
  pluginDescription: string
  command: string
  description: string
  permission: string
}

const corePkg: PkgInfo = {
  id: 0,
  type: 'app',
  name: 'Karin Core',
  dir: '',
  apps: [],
  allApps: [],
  pkgPath: '',
  pkgData: {
    name: 'node-karin',
    version: process.env.KARIN_VERSION || '',
    main: '',
    description: 'Karin 核心内置命令',
  },
}

const commandPattern = (reg: RegExp): string => {
  const flags = reg.flags ? `/${reg.flags}` : '/'
  return `/${reg.source}${flags}`
}

/**
 * 从当前已加载命令中生成帮助数据。每次调用都读取运行时缓存，
 * 因此插件热更新、增加或删除命令后无需重启帮助索引。
 */
export const collectCommandHelp = (
  commands: CachedCommand[] = cache.command
): CommandHelpItem[] => {
  return commands
    .map(item => {
      const plugin = item.pkg.name || 'Karin Core'
      const pluginDescription = String(
        item.pkg.pkgData?.description || (plugin === 'Karin Core' ? 'Karin 核心内置命令' : '')
      ).trim()

      return {
        plugin,
        pluginDescription,
        command: commandPattern(item.reg),
        description: item.description?.trim() || item.file.name?.trim() || '暂无描述',
        permission: item.permission,
      }
    })
    .sort((left, right) => {
      return left.plugin.localeCompare(right.plugin, 'zh-CN') ||
        left.description.localeCompare(right.description, 'zh-CN') ||
        left.command.localeCompare(right.command, 'zh-CN')
    })
}

/**
 * 将帮助数据按插件分组，并按常见消息平台安全长度分页。
 */
export const buildCommandHelpPages = (
  commands: CachedCommand[] = cache.command,
  maxLength = 3500
): string[] => {
  const items = collectCommandHelp(commands)
  const groups = new Map<string, CommandHelpItem[]>()

  for (const item of items) {
    const group = groups.get(item.plugin) || []
    group.push(item)
    groups.set(item.plugin, group)
  }

  const header = `# Karin 命令帮助\n共 ${groups.size} 个插件，${items.length} 个正则命令`
  const pages: string[] = []
  let page = header

  const pushLine = (line: string) => {
    if (page.length + line.length + 1 > maxLength && page !== header) {
      pages.push(page)
      page = `${header}\n（续）`
    }
    page += `\n${line}`
  }

  for (const [plugin, pluginItems] of groups) {
    const pluginDescription = pluginItems[0]?.pluginDescription
    pushLine('')
    pushLine(`【${plugin}】${pluginDescription ? ` ${pluginDescription}` : ''}`)
    for (const item of pluginItems) {
      const permission = item.permission === 'all' ? '' : ` [权限: ${item.permission}]`
      pushLine(`• ${item.command} — ${item.description}${permission}`)
    }
  }

  pages.push(page)
  return pages
}

/** 注册固定命令 #帮助；必须在 Agent ingress 之前完成。 */
export const registerHelpCommand = () => {
  if (cache.command.some(item => item.pkg.name === corePkg.name && item.file.name === '命令帮助')) {
    return
  }

  const help = command(
    /^#帮助$/,
    async event => {
      for (const page of buildCommandHelpPages()) {
        await event.reply(page)
      }
      return true
    },
    {
      name: '命令帮助',
      description: '按插件查看当前已加载的全部正则命令',
      permission: 'all',
      priority: 1,
      log: true,
    }
  )

  help.pkg = corePkg
  cache.command.unshift(help)
  cache.count.command++
}
