import type { Command } from '@/types/plugin'

/**
 * 命令选项
 */
export interface Options {
  /** 插件名称 */
  name?: string
  /** 功能描述，用于帮助菜单等命令发现能力 */
  description?: string
  /** 功能描述简写 */
  desc?: string
  /** 面向用户展示的命令用法，不应填写正则源码 */
  usage?: string | string[]
  /** 是否启用日志 */
  log?: boolean
  /** 权限 默认`all` */
  perm?: Command['permission']
  /** 优先级 默认`10000` */
  rank?: Command['priority']
  /** 生效的适配器 */
  adapter?: Command['adapter']
  /** 禁用的适配器 */
  dsbAdapter?: Command['dsbAdapter']
  /**
   * 权限
   * @default 'all'
   */
  permission?: Command['permission']
  /**
   * 插件优先级 数字越小优先级越高
   * @default 10000
   */
  priority?: Command['priority']
  /**
   * 禁用的适配器
   * @deprecated 已废弃 请使用`dsbAdapter`
   */
  notAdapter?: Command['dsbAdapter'],
}
