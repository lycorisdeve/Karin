import fs from 'node:fs'
import path from 'node:path'
import { watch } from '../../fs/watch'
import { requireFileSync } from '../../fs/require'
import { FILE_CHANGE } from '@/utils/fs'
import { listeners } from '@/core/internal/listeners'

import type {
  WebUIAppearanceConfig,
  WebUIColorMode,
  WebUIDensity,
  WebUISkin,
  WebUIThemeDefinition,
  WebUIThemePalette,
} from '@/types/config'

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const THEME_ID = /^[a-z0-9][a-z0-9-]{1,47}$/
const MODES = new Set<WebUIColorMode>(['system', 'light', 'dark'])
const SKINS = new Set<WebUISkin>(['bloom', 'classic'])
const DENSITIES = new Set<WebUIDensity>(['compact', 'comfortable', 'spacious'])

const bloomLight: WebUIThemePalette = {
  background: '#FFF8F6',
  surface: '#FFFFFF',
  elevatedSurface: '#FFFFFF',
  foreground: '#28232D',
  mutedForeground: '#746B78',
  border: '#E8DDE1',
  primary: '#6B5DD3',
  primaryForeground: '#FFFFFF',
  accent: '#ED7894',
  success: '#2E9B7D',
  warning: '#D98B2B',
  danger: '#D9576C',
  codeBackground: '#F4EEF1',
}

const bloomDark: WebUIThemePalette = {
  background: '#18151D',
  surface: '#221E29',
  elevatedSurface: '#2A2532',
  foreground: '#F7EFF3',
  mutedForeground: '#B8ADB7',
  border: '#39313F',
  primary: '#A89AF1',
  primaryForeground: '#18151D',
  accent: '#FF91AB',
  success: '#65C6A9',
  warning: '#F0B15B',
  danger: '#F17C8E',
  codeBackground: '#131017',
}

const classicLight: WebUIThemePalette = {
  background: '#FFFFFF',
  surface: '#FFFFFF',
  elevatedSurface: '#FFFFFF',
  foreground: '#0A0A0A',
  mutedForeground: '#737373',
  border: '#E5E5E5',
  primary: '#18181B',
  primaryForeground: '#FAFAFA',
  accent: '#F5F5F5',
  success: '#17C964',
  warning: '#F5A524',
  danger: '#F31260',
  codeBackground: '#F5F5F5',
}

const classicDark: WebUIThemePalette = {
  background: '#0A0A0A',
  surface: '#0A0A0A',
  elevatedSurface: '#171717',
  foreground: '#FAFAFA',
  mutedForeground: '#A3A3A3',
  border: '#262626',
  primary: '#FAFAFA',
  primaryForeground: '#18181B',
  accent: '#262626',
  success: '#17C964',
  warning: '#F5A524',
  danger: '#F31260',
  codeBackground: '#171717',
}

export const builtinWebUIThemes = (): WebUIThemeDefinition[] => [
  {
    id: 'karin-bloom',
    name: 'Karin Bloom',
    skin: 'bloom',
    builtin: true,
    light: bloomLight,
    dark: bloomDark,
    radius: 18,
    density: 'comfortable',
  },
  {
    id: 'karin-classic',
    name: 'Karin Classic',
    skin: 'classic',
    builtin: true,
    light: classicLight,
    dark: classicDark,
    radius: 8,
    density: 'comfortable',
  },
]

const paletteKeys: Array<keyof WebUIThemePalette> = [
  'background',
  'surface',
  'elevatedSurface',
  'foreground',
  'mutedForeground',
  'border',
  'primary',
  'primaryForeground',
  'accent',
  'success',
  'warning',
  'danger',
  'codeBackground',
]

const validatePalette = (value: unknown, label: string): WebUIThemePalette => {
  if (!value || typeof value !== 'object') throw new Error(`${label} 配色无效`)
  const source = value as Record<string, unknown>
  const palette = {} as WebUIThemePalette
  for (const key of paletteKeys) {
    const color = String(source[key] || '').toUpperCase()
    if (!HEX_COLOR.test(color)) throw new Error(`${label}.${key} 必须是六位十六进制颜色`)
    palette[key] = color
  }
  return palette
}

const channel = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
const luminance = (hex: string) => {
  const values = [channel(hex, 1), channel(hex, 3), channel(hex, 5)]
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]
}
const contrast = (left: string, right: string) => {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (bright + 0.05) / (dark + 0.05)
}

const validateContrast = (palette: WebUIThemePalette, label: string) => {
  if (contrast(palette.foreground, palette.background) < 4.5) {
    throw new Error(`${label} 正文与背景对比度必须至少为 4.5:1`)
  }
  if (contrast(palette.primaryForeground, palette.primary) < 3) {
    throw new Error(`${label} 主按钮对比度必须至少为 3:1`)
  }
}

const normalizeCustomTheme = (value: unknown): WebUIThemeDefinition => {
  if (!value || typeof value !== 'object') throw new Error('主题定义无效')
  const source = value as Partial<WebUIThemeDefinition>
  const id = String(source.id || '').trim().toLowerCase()
  const name = String(source.name || '').trim()
  if (!THEME_ID.test(id)) throw new Error('主题 ID 仅支持 2-48 位小写字母、数字和连字符')
  if (id === 'karin-bloom' || id === 'karin-classic') throw new Error('内置主题不可覆盖')
  if (!name || name.length > 48) throw new Error('主题名称长度必须为 1-48 个字符')
  if (!SKINS.has(source.skin as WebUISkin)) throw new Error('主题结构无效')
  if (!DENSITIES.has(source.density as WebUIDensity)) throw new Error('主题密度无效')
  const light = validatePalette(source.light, `${name} 浅色`)
  const dark = validatePalette(source.dark, `${name} 深色`)
  validateContrast(light, `${name} 浅色`)
  validateContrast(dark, `${name} 深色`)
  return {
    id,
    name,
    skin: source.skin as WebUISkin,
    builtin: false,
    light,
    dark,
    radius: Math.max(0, Math.min(Number(source.radius) || 0, 32)),
    density: source.density as WebUIDensity,
  }
}

let cache: WebUIAppearanceConfig
let configFile = ''

export const normalizeWebUIAppearance = (
  value: Partial<WebUIAppearanceConfig>,
  revision = Number(value.revision) || 1
): WebUIAppearanceConfig => {
  const custom = Array.isArray(value.themes)
    ? value.themes.filter(theme => !theme?.builtin).map(normalizeCustomTheme)
    : []
  if (custom.length > 32) throw new Error('自定义主题最多 32 个')
  const ids = new Set<string>()
  for (const theme of custom) {
    if (ids.has(theme.id)) throw new Error(`主题 ID 重复: ${theme.id}`)
    ids.add(theme.id)
  }
  const themes = [...builtinWebUIThemes(), ...custom]
  const activeThemeId = themes.some(theme => theme.id === value.activeThemeId)
    ? String(value.activeThemeId)
    : 'karin-bloom'
  return {
    version: 1,
    revision: Math.max(1, revision),
    activeThemeId,
    mode: MODES.has(value.mode as WebUIColorMode) ? value.mode as WebUIColorMode : 'system',
    themes,
  }
}

const initWebUI = (dir: string) => {
  const name = 'webui.json'
  configFile = path.join(dir, name)
  cache = normalizeWebUIAppearance(requireFileSync<WebUIAppearanceConfig>(configFile, { type: 'json' }))
  watch<WebUIAppearanceConfig>(
    configFile,
    (old, data) => {
      cache = normalizeWebUIAppearance(data)
      const options = { file: name, old, data: cache }
      listeners.emit(FILE_CHANGE, options)
      listeners.emit(`${FILE_CHANGE}:${name}`, options)
    },
    { type: 'json' }
  )
}

export const webUIAppearanceConfig = () => structuredClone(cache)

export const patchWebUIAppearance = (
  current: WebUIAppearanceConfig,
  value: Pick<Partial<WebUIAppearanceConfig>, 'activeThemeId' | 'mode'>
) => {
  if (value.activeThemeId !== undefined) {
    const activeThemeId = String(value.activeThemeId)
    if (!current.themes.some(theme => theme.id === activeThemeId)) {
      throw new Error(`主题不存在: ${activeThemeId}`)
    }
  }
  if (value.mode !== undefined && !MODES.has(value.mode)) {
    throw new Error('主题模式无效')
  }
  return normalizeWebUIAppearance(
    {
      ...current,
      activeThemeId: value.activeThemeId ?? current.activeThemeId,
      mode: value.mode ?? current.mode,
    },
    current.revision + 1
  )
}

const persistWebUIAppearance = async (next: WebUIAppearanceConfig) => {
  const stored = {
    ...next,
    themes: next.themes.filter(theme => !theme.builtin),
  }
  const temporary = `${configFile}.tmp`
  await fs.promises.writeFile(temporary, JSON.stringify(stored, null, 2), 'utf-8')
  await fs.promises.rename(temporary, configFile)
  cache = next
  return webUIAppearanceConfig()
}

export const saveWebUIAppearance = async (
  value: Partial<WebUIAppearanceConfig>,
  expectedRevision: number
) => {
  if (!configFile) throw new Error('WebUI 配置尚未初始化')
  if (expectedRevision !== cache.revision) {
    const error = new Error('主题配置已被其他客户端修改，请刷新后重试')
    error.name = 'RevisionConflict'
    throw error
  }
  const next = normalizeWebUIAppearance(value, cache.revision + 1)
  return persistWebUIAppearance(next)
}

export const updateWebUIAppearanceSelection = async (
  value: Pick<Partial<WebUIAppearanceConfig>, 'activeThemeId' | 'mode'>
) => {
  if (!configFile) throw new Error('WebUI 配置尚未初始化')
  return persistWebUIAppearance(patchWebUIAppearance(cache, value))
}

export default initWebUI
