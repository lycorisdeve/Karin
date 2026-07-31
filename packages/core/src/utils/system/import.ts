import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ImportModuleResult } from '@/types/system'

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.cts', '.mts'])

/**
 * 从待加载文件向上查找最近的 tsconfig，确保 Git 插件自己的 paths 等配置生效。
 */
const findNearestTsconfig = (file: string): string | undefined => {
  let dir = path.dirname(file)
  const root = path.parse(dir).root

  while (dir !== root) {
    const tsconfig = path.join(dir, 'tsconfig.json')
    if (fs.existsSync(tsconfig)) return tsconfig
    dir = path.dirname(dir)
  }
}

/**
 * 动态导入模块
 * @param url 模块地址 仅支持绝对路径 无需传递 `file://` 前缀
 * @param isRefresh 是否重新加载 不使用缓存
 */
export const importModule = async <T = any> (
  url: string,
  isRefresh = false
): Promise<ImportModuleResult<T>> => {
  try {
    const ext = path.extname(url).toLowerCase()
    if (TYPESCRIPT_EXTENSIONS.has(ext)) {
      const { tsImport } = await import('tsx/esm/api')
      const module = await tsImport(
        pathToFileURL(url).href,
        {
          parentURL: import.meta.url,
          tsconfig: findNearestTsconfig(url),
        }
      ) as T
      return { status: true, data: module }
    }

    const fileUrl = pathToFileURL(url).href
    const module = await import(`${fileUrl}${isRefresh ? `?t=${Date.now()}` : ''}`)
    return { status: true, data: module }
  } catch (error) {
    return { status: false, data: error }
  }
}

/**
 * 动态导入模块
 * @param url 模块地址 仅支持绝对路径 无需传递 `file://` 前缀
 * @param options 选项
 * @param options.isRefresh 是否重新加载 不使用缓存
 * @param options.isImportDefault 是否返回默认导出
 */
export const imports = async <T = any> (url: string, options: {
  isRefresh?: boolean
  isImportDefault?: boolean
} = {}): Promise<T> => {
  const { isRefresh = false, isImportDefault = true } = options
  const module = await import(`file://${url}${isRefresh ? `?t=${Date.now()}` : ''}`)
  if (isImportDefault) {
    return module.default
  }
  return module
}
