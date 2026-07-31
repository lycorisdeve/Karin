import { createFile, createPkg } from '@/plugin/tools'

import type { AgentToolOptions } from '@/types/agent'
import type { AgentTool } from '@/types/plugin'

const TOOL_NAME = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/

export const createAgentTool = <
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown
>(
    options: AgentToolOptions<TInput, TOutput>,
    allowReserved = false
  ): AgentTool => {
  if (!TOOL_NAME.test(options.name)) {
    throw new Error(`[agent][tool] 非法工具名称: ${options.name}`)
  }

  if (!allowReserved && options.name.startsWith('karin.')) {
    throw new Error('[agent][tool] karin.* 是内置工具保留命名空间')
  }

  if (!options.description?.trim()) {
    throw new Error(`[agent][tool] ${options.name} 缺少描述`)
  }

  if (!options.inputSchema || typeof options.inputSchema !== 'object') {
    throw new Error(`[agent][tool] ${options.name} 缺少 inputSchema`)
  }

  return {
    ...options,
    permission: options.permission || 'all',
    risk: options.risk || 'read',
    timeout: options.timeout || 30_000,
    idempotent: options.idempotent ?? false,
    execute: options.execute as AgentTool['execute'],
    file: createFile('tool', options.name),
    pkg: createPkg(),
  }
}

/**
 * 注册供 Karin Agent 调用的结构化工具。
 *
 * 固定命令与 Tool 是两条独立调用路径；Tool 不会伪造消息或递归触发命令。
 */
export const tool = <
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown
>(
    options: AgentToolOptions<TInput, TOutput>
  ) => createAgentTool(options)
