import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { karinPathTemp } from '@/root'
import { command } from '@/core/karin/command'
import { renderHtml } from '@/adapter/render/admin/cache'
import { segment } from '@/utils/message'
import {
  helpAppearance,
  helpBackgroundDataUrl,
} from '@/utils/config/file/help'
import { cache } from '../system/cache'

import type { MessageEventMap, Permission } from '@/types/event'
import type { Command, CommandClass, PkgInfo } from '@/types/plugin'

type CachedCommand =
  | Command<keyof MessageEventMap>
  | CommandClass<keyof MessageEventMap>

export interface CommandHelpItem {
  plugin: string
  pluginDescription: string
  name: string
  description: string
  permission: Permission
  usage: string[]
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
    description: 'Karin 核心常用命令',
  },
}

const coreHelpItems: CommandHelpItem[] = [
  ['#帮助', '查看 Karin Core 与插件帮助入口'],
  ['/new', '新建当前渠道的 Agent 会话'],
  ['/model', '查看当前模型和可切换模型列表'],
  ['/model reset', '恢复全局主模型'],
  ['/stop', '停止当前正在执行的 Agent 回合'],
  ['/help', '查看 Agent 会话命令说明'],
].map(([name, description]) => ({
  plugin: 'Karin Core',
  pluginDescription: 'Karin 核心常用命令',
  name,
  description,
  permission: 'all' as const,
  usage: [name],
}))

const usageList = (value?: string | string[]) => {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return [...new Set(list.map(item => item.trim()).filter(Boolean))]
}

/**
 * 仅从完全锚定、无参数的简单正则中提取展示命令。
 * 支持 /^#?kkk帮助$/ -> #kkk帮助；任何复杂结构都拒绝，绝不展示正则源码。
 */
export const literalCommandUsage = (regexp: RegExp) => {
  if (regexp.flags.includes('g') || regexp.flags.includes('y')) return ''
  let source = regexp.source
  if (!source.startsWith('^') || !source.endsWith('$')) return ''
  source = source.slice(1, -1)
  if (source.startsWith('#?')) source = `#${source.slice(2)}`
  if (
    !source ||
    /(?<!\\)[()[\]{}.*+?|]/.test(source) ||
    /\\[AbBdDsSwWZzGkpPux0-9]/.test(source)
  ) {
    return ''
  }
  const literal = source.replace(/\\([\\^$.*+?()[\]{}|/#-])/g, '$1')
  if (literal.includes('\\') || /\s/.test(literal)) return ''
  return literal.slice(0, 120)
}

const helpUsage = (item: CachedCommand) => {
  const explicit = usageList(item.usage)
  const preferred = explicit.find(usage => /帮助|help|菜单|menu/i.test(usage))
  if (preferred) return preferred
  const inferred = literalCommandUsage(item.reg)
  return /帮助|help|菜单|menu/i.test(inferred) ? inferred : ''
}

/**
 * 全局帮助是插件入口索引：Core 常用入口 + 每个插件一个真实帮助命令。
 * 详细命令继续由插件自己的帮助页展示。
 */
export const collectCommandHelp = (
  commands: CachedCommand[] = cache.command
): CommandHelpItem[] => {
  const candidates = commands
    .map((item): CommandHelpItem | null => {
      const isCore = !item.pkg.name ||
        item.pkg.name === 'Karin Core' ||
        item.pkg.pkgData?.name === 'node-karin'
      const plugin = isCore ? 'Karin Core' : item.pkg.name
      const pluginDescription = String(
        item.pkg.pkgData?.description ||
        (plugin === 'Karin Core' ? 'Karin 核心常用命令' : '')
      ).trim()
      const usage = helpUsage(item)
      if (!usage) return null
      return {
        plugin,
        pluginDescription,
        name: usage,
        description: item.description?.trim() || pluginDescription || '查看插件命令帮助',
        permission: item.permission,
        usage: [usage],
      }
    })
    .filter((item): item is CommandHelpItem => Boolean(item))
    .filter(item => item.plugin !== 'Karin Core')
    .sort((left, right) =>
      (left.plugin === 'Karin Core' ? -1 : right.plugin === 'Karin Core' ? 1 : 0) ||
      left.plugin.localeCompare(right.plugin, 'zh-CN') ||
      left.name.localeCompare(right.name, 'zh-CN')
    )

  const seen = new Set<string>()
  return [...coreHelpItems, ...candidates.filter(item => {
    if (seen.has(item.plugin)) return false
    seen.add(item.plugin)
    return true
  })]
}

/** 无渲染器时使用的纯文字回退，不包含 Markdown、内部名称或正则。 */
export const buildCommandHelpPages = (
  commands: CachedCommand[] = cache.command,
  maxLength = 3500
): string[] => {
  const items = collectCommandHelp(commands)
  const header = `Karin 命令入口\n共 ${items.length} 个常用入口`
  const pages: string[] = []
  let page = header
  for (const item of items) {
    const permission = item.permission === 'all' ? '' : `（${item.permission}）`
    const line = `\n${item.name}${permission}  ${item.description}`
    if (page.length + line.length > maxLength && page !== header) {
      pages.push(page)
      page = `${header}\n续页`
    }
    page += line
  }
  pages.push(page)
  return pages
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;')

const pageHtml = (
  items: CommandHelpItem[],
  background: string
) => {
  const appearance = helpAppearance()
  const groups = new Map<string, CommandHelpItem[]>([
    ['常用功能', items.filter(item => item.plugin === 'Karin Core')],
    ['插件帮助', items.filter(item => item.plugin !== 'Karin Core')],
  ])
  const cards = [...groups.entries()].filter(([, commands]) => commands.length)
    .map(([plugin, commands]) => {
      const description = plugin === '常用功能'
        ? 'Karin Core 常用公开入口'
        : '打开对应插件自己的完整帮助页'
      const rows = commands.map(item => {
        const permission = item.permission === 'all'
          ? ''
          : `<span class="permission">${escapeHtml(item.permission)}</span>`
        return `
          <article class="command">
            <div class="command-icon" aria-hidden="true">✦</div>
            <div class="command-copy">
              <div class="command-plugin">${escapeHtml(item.plugin)}</div>
              <div class="command-title">
                <h3>${escapeHtml(item.name)}</h3>
                ${permission}
              </div>
              <p>${escapeHtml(item.description)}</p>
            </div>
          </article>`
      }).join('')
      return `
        <section class="plugin">
          <header>
            <h2>${escapeHtml(plugin)}</h2>
            <p>${escapeHtml(description)}</p>
          </header>
          <div class="commands">${rows}</div>
        </section>`
    }).join('')

  const backgroundStyle = background
    ? `background-image: url("${escapeHtml(background)}");`
    : 'background-image: linear-gradient(145deg, #d9d0f5, #8178ba 55%, #322d59);'
  const version = process.env.KARIN_VERSION || 'development'
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root {
      --ink: #1e1b2d;
      --muted: #59556c;
      --blue: #1689cf;
      --violet: #7560d8;
      --glass: rgba(255, 255, 255, .69);
      --glass-strong: rgba(255, 255, 255, .82);
      --line: rgba(42, 37, 69, .12);
    }
    * { box-sizing: border-box; }
    html { background: transparent; }
    body {
      margin: 0;
      width: 830px;
      color: var(--ink);
      font-family: "Microsoft YaHei UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    }
    .page {
      position: relative;
      display: flex;
      flex-direction: column;
      width: 830px;
      min-height: 1180px;
      padding: 44px 18px 24px;
      overflow: hidden;
      ${backgroundStyle}
      background-position: center ${appearance.backgroundPosition};
      background-size: cover;
      background-repeat: no-repeat;
    }
    .page::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(180deg, rgba(255,255,255,.28), transparent 220px),
        rgba(24, 18, 48, ${appearance.overlay});
      pointer-events: none;
    }
    .hero, main, footer { position: relative; z-index: 1; }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 24px;
      min-height: 142px;
      padding: 0 18px 28px;
      color: #fff;
      text-shadow: 0 3px 18px rgba(20, 13, 48, .72);
    }
    .eyebrow {
      margin-bottom: 8px;
      font: 700 10px/1.2 Consolas, "SFMono-Regular", monospace;
      letter-spacing: .24em;
      text-transform: uppercase;
      opacity: .86;
    }
    .hero h1 {
      margin: 0;
      font-size: 54px;
      font-weight: 900;
      line-height: 1;
      letter-spacing: -.06em;
    }
    .hero-copy {
      max-width: 310px;
      padding: 13px 16px;
      background: rgba(25, 19, 53, .32);
      border: 1px solid rgba(255,255,255,.28);
      border-radius: 14px;
      backdrop-filter: blur(10px);
    }
    .hero-copy strong { display: block; font-size: 15px; }
    .hero-copy span { display: block; margin-top: 4px; font-size: 11px; opacity: .85; }
    main { display: grid; flex: 0 0 auto; gap: 18px; }
    .plugin {
      overflow: hidden;
      background: var(--glass);
      border: 1px solid rgba(255,255,255,.68);
      border-radius: 17px;
      box-shadow: 0 11px 28px rgba(20, 13, 47, .17);
      backdrop-filter: blur(12px) saturate(1.08);
    }
    .plugin > header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 20px;
      min-height: 48px;
      padding: 12px 19px 10px;
      background: var(--glass-strong);
      border-bottom: 1px solid var(--line);
    }
    h2 {
      margin: 0;
      color: var(--blue);
      font-size: 18px;
      font-weight: 900;
      line-height: 1.3;
    }
    .plugin > header p {
      max-width: 62%;
      margin: 0;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.45;
      text-align: right;
    }
    .commands {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .command {
      display: flex;
      min-height: 92px;
      gap: 10px;
      padding: 15px 13px;
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .command:nth-child(3n) { border-right: 0; }
    .command-icon {
      display: grid;
      flex: 0 0 31px;
      width: 31px;
      height: 31px;
      place-items: center;
      color: #fff;
      background: linear-gradient(145deg, #20a4e2, var(--violet));
      border: 2px solid rgba(255,255,255,.8);
      border-radius: 10px 10px 10px 3px;
      box-shadow: 0 5px 13px rgba(61, 93, 185, .28);
      font-size: 13px;
    }
    .command-copy { min-width: 0; }
    .command-plugin {
      margin-bottom: 3px;
      color: #777187;
      font-size: 8px;
      font-weight: 800;
      letter-spacing: .04em;
    }
    .command-title { display: flex; align-items: flex-start; gap: 6px; }
    h3 {
      margin: 0;
      overflow-wrap: anywhere;
      color: var(--blue);
      font-size: 15px;
      font-weight: 900;
      line-height: 1.34;
    }
    .command p {
      margin: 7px 0 0;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.55;
    }
    .permission {
      padding: 2px 5px;
      color: #a33e61;
      background: rgba(255, 235, 243, .9);
      border-radius: 5px;
      font-size: 8px;
      font-weight: 800;
    }
    footer {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin-top: auto;
      padding: 22px 10px 0;
      color: rgba(255,255,255,.94);
      font: 700 10px/1.4 Consolas, "Microsoft YaHei UI", sans-serif;
      text-shadow: 0 2px 7px rgba(0,0,0,.7);
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="hero">
      <div>
        <div class="eyebrow">KARIN · COMMAND INDEX</div>
        <h1>${escapeHtml(appearance.title)}</h1>
      </div>
      <div class="hero-copy">
        <strong>${escapeHtml(appearance.subtitle)}</strong>
        <span>${items.length} 个已验证帮助入口 · 详细命令请打开对应插件帮助</span>
      </div>
    </header>
    <main>${cards}</main>
    <footer>
      <span>KARIN ${escapeHtml(version)}</span>
      <span>COMMAND INDEX</span>
    </footer>
  </div>
</body>
</html>`
}

export const renderCommandHelpImages = async (
  commands: CachedCommand[] = cache.command
) => {
  const items = collectCommandHelp(commands)
  const background = await helpBackgroundDataUrl()
  const directory = path.join(karinPathTemp, 'agent-render')
  await fs.mkdir(directory, { recursive: true })
  const filename = path.join(directory, `command-help-${randomUUID()}.html`)
  try {
    await fs.writeFile(filename, pageHtml(items, background), 'utf8')
    const rendered = await renderHtml(filename)
    const images = Array.isArray(rendered) ? rendered : [rendered]
    if (images.length !== 1 || !images[0]) {
      throw new Error('帮助渲染器未返回一张完整图片')
    }
    return [images[0]]
  } finally {
    await fs.rm(filename, { force: true }).catch(() => undefined)
  }
}

/** 注册固定命令 #帮助；必须在 Agent ingress 之前完成。 */
export const registerHelpCommand = () => {
  if (cache.command.some(item => item.pkg.name === corePkg.name && item.file.name === '命令帮助')) {
    return
  }

  const help = command(
    /^#帮助$/,
    async event => {
      try {
        const [image] = await renderCommandHelpImages()
        await event.reply([segment.image(`base64://${image}`)])
      } catch (error) {
        logger.warn(`[help] 单图渲染不可用，已回退为原生文字：${(error as Error).message}`)
        for (const page of buildCommandHelpPages()) {
          await event.reply([segment.text(page)])
        }
      }
      return true
    },
    {
      name: '命令帮助',
      description: '查看 Karin Core 与各插件的帮助入口',
      usage: '#帮助',
      permission: 'all',
      priority: Number.MIN_SAFE_INTEGER,
      log: true,
    }
  )

  help.pkg = corePkg
  cache.command.unshift(help)
  cache.count.command++
}
