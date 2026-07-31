import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { karinPathData, karinPathRoot } from '@/root'
import { requireFileSync } from '../../fs/require'

import type { HelpAppearanceConfig } from '@/types/config'

const assetDirectory = path.join(karinPathData, 'help')
const defaultBackground = path.join(
  karinPathRoot,
  'default',
  'resources',
  'help',
  'main.png'
)
let cache: HelpAppearanceConfig
let configFile = ''

const positions = new Set<HelpAppearanceConfig['backgroundPosition']>([
  'top',
  'center',
  'bottom',
])

export const normalizeHelpAppearance = (
  value: Partial<HelpAppearanceConfig>,
  revision = Number(value.revision) || 1
): HelpAppearanceConfig => ({
  version: 1,
  revision: Math.max(1, revision),
  title: String(value.title || 'Karin 帮助').trim().slice(0, 80) || 'Karin 帮助',
  subtitle: String(value.subtitle || 'Karin Bot & Plugins').trim().slice(0, 120),
  backgroundAsset: /^[a-f0-9-]+\.(?:png|jpe?g|webp)$/i.test(
    String(value.backgroundAsset || '')
  )
    ? String(value.backgroundAsset)
    : '',
  backgroundPosition: positions.has(value.backgroundPosition as never)
    ? value.backgroundPosition as HelpAppearanceConfig['backgroundPosition']
    : 'top',
  overlay: Math.max(0, Math.min(Number(value.overlay) || 0, 0.75)),
})

const initHelp = (dir: string) => {
  configFile = path.join(dir, 'help.json')
  cache = normalizeHelpAppearance(
    requireFileSync<HelpAppearanceConfig>(configFile, { type: 'json' })
  )
}

const persist = async (next: HelpAppearanceConfig) => {
  const temporary = `${configFile}.tmp`
  await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2), 'utf8')
  await fs.promises.rename(temporary, configFile)
  cache = next
  return helpAppearance()
}

export const helpAppearance = () => structuredClone(
  cache || normalizeHelpAppearance({})
)

export const saveHelpAppearance = async (value: Partial<HelpAppearanceConfig>) => {
  if (!configFile) throw new Error('帮助配置尚未初始化')
  return persist(normalizeHelpAppearance(
    { ...cache, ...value, backgroundAsset: cache.backgroundAsset },
    cache.revision + 1
  ))
}

const imageFormat = (buffer: Buffer) => {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: 'png', mime: 'image/png' }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mime: 'image/jpeg' }
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: 'webp', mime: 'image/webp' }
  }
  throw new Error('帮助背景仅支持 PNG、JPEG 或 WebP')
}

export const saveHelpBackground = async (buffer: Buffer) => {
  if (!configFile) throw new Error('帮助配置尚未初始化')
  if (!buffer.length || buffer.byteLength > 10 * 1024 * 1024) {
    throw new Error('帮助背景必须为 1 byte 到 10 MiB')
  }
  const format = imageFormat(buffer)
  await fs.promises.mkdir(assetDirectory, { recursive: true })
  const asset = `${randomUUID()}.${format.extension}`
  const filename = path.join(assetDirectory, asset)
  await fs.promises.writeFile(filename, buffer, { flag: 'wx' })
  const previous = cache.backgroundAsset
  try {
    const saved = await persist(normalizeHelpAppearance(
      { ...cache, backgroundAsset: asset },
      cache.revision + 1
    ))
    if (previous && previous !== asset) {
      await fs.promises.rm(path.join(assetDirectory, previous), { force: true })
        .catch(() => undefined)
    }
    return saved
  } catch (error) {
    await fs.promises.rm(filename, { force: true }).catch(() => undefined)
    throw error
  }
}

export const resetHelpBackground = async () => {
  if (!configFile) throw new Error('帮助配置尚未初始化')
  const previous = cache.backgroundAsset
  const saved = await persist(normalizeHelpAppearance(
    { ...cache, backgroundAsset: '' },
    cache.revision + 1
  ))
  if (previous) {
    await fs.promises.rm(path.join(assetDirectory, previous), { force: true })
      .catch(() => undefined)
  }
  return saved
}

export const helpBackground = async () => {
  const filename = cache?.backgroundAsset
    ? path.join(assetDirectory, cache.backgroundAsset)
    : defaultBackground
  const buffer = await fs.promises.readFile(filename)
  const format = imageFormat(buffer)
  return { filename, buffer, mime: format.mime }
}

export const helpBackgroundDataUrl = async () => {
  const background = await helpBackground().catch(() => null)
  return background
    ? `data:${background.mime};base64,${background.buffer.toString('base64')}`
    : ''
}

export default initHelp
