import Ajv, { type ValidateFunction } from 'ajv'
import { cache } from '@/plugin/system/cache'
import { createAgentTool } from '@/core/karin/tool'

import type { AgentToolOptions, AgentToolContext } from '@/types/agent'
import type { AgentTool } from '@/types/plugin'

interface CompiledTool {
  tool: AgentTool
  input: ValidateFunction
  output?: ValidateFunction
}

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8')

export class AgentToolRegistry {
  private readonly ajv = new Ajv({
    allErrors: true,
    strict: true,
    removeAdditional: false,
  })

  private readonly compiled = new Map<string, CompiledTool>()

  register (options: AgentToolOptions, allowReserved = false) {
    const tool = createAgentTool(options, allowReserved)
    this.validateDefinition(tool)
    if (cache.tool.some(item => item.name === tool.name)) {
      throw new Error(`[agent][tool] 工具名称重复: ${tool.name}`)
    }
    cache.tool.push(tool)
    cache.count.tool++
    return tool
  }

  unregister (name: string) {
    const previous = cache.tool.length
    cache.tool = cache.tool.filter(tool => tool.name !== name)
    this.compiled.delete(name)
    if (cache.tool.length !== previous) {
      cache.count.tool = Math.max(0, cache.count.tool - 1)
      return true
    }
    return false
  }

  unregisterPrefix (prefix: string) {
    for (const tool of cache.tool.filter(item => item.name.startsWith(prefix))) {
      this.unregister(tool.name)
    }
  }

  validateDefinition (tool: AgentTool) {
    let input: ValidateFunction
    let output: ValidateFunction | undefined
    try {
      input = this.ajv.compile(tool.inputSchema)
      output = tool.outputSchema ? this.ajv.compile(tool.outputSchema) : undefined
    } catch (error) {
      throw new Error(`[agent][tool] ${tool.name} Schema 无效`, { cause: error })
    }
    this.compiled.set(tool.name, { tool, input, output })
  }

  get (name: string) {
    const tool = cache.tool.find(item => item.name === name)
    if (!tool) return null
    const existing = this.compiled.get(name)
    if (existing?.tool === tool) return existing
    this.validateDefinition(tool)
    return this.compiled.get(name) || null
  }

  list (allowedTools?: string[]) {
    const allowed = allowedTools?.length ? new Set(allowedTools) : null
    return cache.tool
      .filter(tool => !allowed || allowed.has(tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        source: tool.name.startsWith('karin.')
          ? 'Karin Core'
          : tool.name.startsWith('mcp.')
            ? tool.name.split('.').slice(0, 2).join('.')
            : tool.pkg?.name || 'unknown',
        toolset: tool.toolset || (
          tool.name.startsWith('karin.')
            ? `karin.${tool.name.split('.')[1] || 'core'}`
            : tool.name.startsWith('mcp.')
              ? tool.name.split('.').slice(0, 2).join('.')
              : tool.pkg?.name || 'plugin'
        ),
        tags: tool.tags || [],
        inputSchema: tool.inputSchema,
        risk: tool.risk || 'read',
        permission: tool.permission || 'all',
      }))
  }

  async execute (
    name: string,
    input: Record<string, unknown>,
    context: AgentToolContext,
    maxOutputBytes: number
  ) {
    const compiled = this.get(name)
    if (!compiled) throw new Error(`未知工具: ${name}`)
    if ('__invalid_json' in input) throw new Error('模型生成的工具参数不是有效 JSON')
    if (!compiled.input(input)) {
      throw new Error(
        `工具参数校验失败: ${this.ajv.errorsText(compiled.input.errors, { separator: '; ' })}`
      )
    }

    const timeout = Math.max(1, compiled.tool.timeout || 30_000)
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeout)])
    const output = await compiled.tool.execute(input, { ...context, signal })
    if (compiled.output && !compiled.output(output)) {
      throw new Error(
        `工具输出校验失败: ${this.ajv.errorsText(compiled.output.errors, { separator: '; ' })}`
      )
    }

    const serialized = JSON.stringify(output ?? null)
    if (byteLength(serialized) <= maxOutputBytes) return output

    const suffix = `\n…[工具输出已截断，上限 ${maxOutputBytes} bytes]`
    const truncated = Buffer.from(serialized)
      .subarray(0, Math.max(0, maxOutputBytes - byteLength(suffix)))
      .toString('utf8')
    return `${truncated}${suffix}`
  }
}
