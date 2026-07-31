import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { command } from '@/core/karin/command'
import { buildCommandHelpPages, collectCommandHelp } from '@/plugin/admin/help'
import { importModule } from '@/utils/system/import'

import type { PkgInfo } from '@/types/plugin'

const tempDirs: string[] = []

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
  it('groups every regex command by plugin and exposes descriptions and permissions', () => {
    const status = command(/^#状态$/, async () => true, {
      name: '运行状态',
      description: '查看机器人状态',
    })
    status.pkg = pluginPkg('karin-plugin-system', '系统功能')

    const admin = command(/^#重启$/, async () => true, {
      name: '运行时重启',
      permission: 'master',
    })
    admin.pkg = pluginPkg('karin-plugin-system', '系统功能')

    const weather = command(/^#天气\s+(.+)$/, async () => true, {
      name: '天气查询',
    })
    weather.pkg = pluginPkg('karin-plugin-weather', '天气服务')

    const items = collectCommandHelp([weather, admin, status])
    expect(items).toHaveLength(3)
    expect(items.map(item => item.plugin)).toEqual([
      'karin-plugin-system',
      'karin-plugin-system',
      'karin-plugin-weather',
    ])
    expect(items).toContainEqual(expect.objectContaining({
      command: '/^#状态$/',
      description: '查看机器人状态',
      permission: 'all',
    }))
    expect(items).toContainEqual(expect.objectContaining({
      command: '/^#重启$/',
      description: '运行时重启',
      permission: 'master',
    }))

    const output = buildCommandHelpPages([weather, admin, status], 10_000).join('\n')
    expect(output).toContain('共 2 个插件，3 个正则命令')
    expect(output).toContain('【karin-plugin-system】 系统功能')
    expect(output).toContain('/^#重启$/ — 运行时重启 [权限: master]')
    expect(output).toContain('【karin-plugin-weather】 天气服务')
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
