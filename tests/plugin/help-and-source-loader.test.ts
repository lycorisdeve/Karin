import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { command } from '@/core/karin/command'
import {
  buildCommandHelpPages,
  collectCommandHelp,
  literalCommandUsage,
  renderCommandHelpImages,
} from '@/plugin/admin/help'
import { importModule } from '@/utils/system/import'

import type { PkgInfo } from '@/types/plugin'

const tempDirs: string[] = []
const renderHtml = vi.hoisted(() => vi.fn(async () => 'image-base64'))

vi.mock('@/adapter/render/admin/cache', () => ({ renderHtml }))

const pluginPkg = (name: string, description: string): PkgInfo => ({
  id: 1,
  type: 'git',
  name,
  dir: '',
  apps: [],
  allApps: [],
  pkgPath: '',
  pkgData: {
    name,
    version: '1.0.0',
    main: '',
    description,
  },
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('command help aggregation', () => {
  it('keeps one real help entry per plugin and never exposes complex regex source', () => {
    const systemHelp = command(/^#系统帮助$/, async () => true, {
      name: '系统帮助',
      description: '查看系统命令',
      usage: '#系统帮助',
    })
    systemHelp.pkg = pluginPkg('karin-plugin-system', '系统功能')

    const duplicate = command(/^#系统菜单$/, async () => true, {
      name: '系统菜单',
      description: '另一个入口',
      usage: '#系统菜单',
    })
    duplicate.pkg = pluginPkg('karin-plugin-system', '系统功能')

    const kkk = command(/^#?kkk帮助$/, async () => true, {
      name: 'kkk-帮助',
    })
    kkk.pkg = pluginPkg('karin-plugin-kkk', '短视频解析与推送')

    const complex = command(/^#天气\s+(.+)$/, async () => true, {
      name: '天气帮助',
    })
    complex.pkg = pluginPkg('karin-plugin-weather', '天气服务')

    const items = collectCommandHelp([complex, duplicate, kkk, systemHelp])
    expect(items.map(item => item.name)).toEqual(expect.arrayContaining([
      '#帮助',
      '/new',
      '/stop',
      '/model',
      '/help',
      '#kkk帮助',
      '#系统帮助',
    ]))
    expect(items).toContainEqual(expect.objectContaining({
      name: '#系统帮助',
      description: '查看系统命令',
      permission: 'all',
      usage: ['#系统帮助'],
    }))
    expect(items).toContainEqual(expect.objectContaining({
      name: '#kkk帮助',
      usage: ['#kkk帮助'],
    }))

    const output = buildCommandHelpPages(
      [complex, duplicate, kkk, systemHelp],
      10_000
    ).join('\n')
    expect(output).toContain('/model')
    expect(output).toContain('#系统帮助')
    expect(output).toContain('#kkk帮助')
    expect(output).not.toContain('天气帮助')
    expect(output).not.toContain('^#')
    expect(output).not.toContain('/i')
    expect(literalCommandUsage(/^#?kkk帮助$/)).toBe('#kkk帮助')
    expect(literalCommandUsage(/^#天气\s+(.+)$/)).toBe('')
  })

  it('renders all help entries as exactly one base64 image', async () => {
    const status = command(/^#系统帮助$/, async () => true, {
      name: '系统帮助',
      description: '查看机器人命令',
      usage: '#系统帮助',
    })
    status.pkg = pluginPkg('karin-plugin-system', '系统功能')
    let rendered = ''
    renderHtml.mockImplementationOnce(async (filename: string) => {
      rendered = await fs.readFile(filename, 'utf8')
      return 'image-base64'
    })

    await expect(renderCommandHelpImages([status])).resolves.toEqual(['image-base64'])
    expect(renderHtml).toHaveBeenCalledOnce()
    expect(renderHtml.mock.calls[0][0]).toMatch(/command-help-.*\.html$/)
    expect(rendered).toContain('width: 830px')
    expect(rendered).toContain('grid-template-columns: repeat(3')
    expect(rendered).toContain('backdrop-filter: blur')
    expect(rendered).toContain('background-image:')
    expect(rendered).toContain('#系统帮助')
    expect(rendered).toContain('/new')
    expect(rendered).toContain('KARIN development')
    expect(rendered).not.toMatch(/<span>\d{4}年/)
    expect(rendered).not.toContain('^#')
  })
})

describe('Git plugin source loader', () => {
  it('runs TypeScript source directly and applies the nearest plugin tsconfig paths', async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-karin-plugin-loader-'))
    tempDirs.push(dir)
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['src/*'],
          },
        },
      })
    )
    await fs.writeFile(path.join(dir, 'src', 'value.ts'), 'export const value: number = 42\n')
    await fs.writeFile(
      path.join(dir, 'src', 'index.ts'),
      "import { value } from '@/value'\nexport const answer: number = value\n"
    )

    const result = await importModule<{ answer: number }>(path.join(dir, 'src', 'index.ts'))
    expect(result.status).toBe(true)
    if (!result.status) return
    expect(result.data.answer).toBe(42)

    await fs.writeFile(path.join(dir, 'src', 'value.ts'), 'export const value: number = 84\n')
    await new Promise(resolve => setTimeout(resolve, 5))
    const refreshed = await importModule<{ answer: number }>(
      path.join(dir, 'src', 'index.ts'),
      true
    )
    expect(refreshed.status).toBe(true)
    if (!refreshed.status) return
    expect(refreshed.data.answer).toBe(84)
  })
})
