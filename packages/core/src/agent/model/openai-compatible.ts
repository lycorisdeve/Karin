import { createHash } from 'node:crypto'

import type {
  AgentModelMessage,
  AgentModelProvider,
  AgentModelRequest,
  AgentModelResponse,
  AgentToolCall,
  AgentProviderProtocol,
  AgentProviderCapabilities,
} from '@/types/agent'

export interface OpenAICompatibleOptions {
  baseUrl: string
  apiKey: string
  timeout: number
  protocol?: AgentProviderProtocol
}

export class AgentProviderError extends Error {
  constructor (
    message: string,
    readonly status?: number,
    readonly transient = false
  ) {
    super(message)
  }
}

const protocolToolName = (name: string) => {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name
  const readable = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'tool'
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 16)
  return `${readable}_${hash}`
}

const createToolNameCodec = (request: AgentModelRequest) => {
  const names = new Set(request.tools.map(tool => tool.name))
  for (const message of request.messages) {
    for (const call of message.toolCalls || []) names.add(call.name)
  }

  const canonicalToProtocol = new Map<string, string>()
  const protocolToCanonical = new Map<string, string>()
  for (const name of names) {
    let alias = protocolToolName(name)
    const collision = protocolToCanonical.get(alias)
    if (collision && collision !== name) {
      alias = `tool_${createHash('sha256').update(name).digest('hex').slice(0, 40)}`
    }
    canonicalToProtocol.set(name, alias)
    protocolToCanonical.set(alias, name)
  }

  return {
    encode: (name: string) => canonicalToProtocol.get(name) || protocolToolName(name),
    decode: (name: string) => protocolToCanonical.get(name) || name,
  }
}

const toMessage = (message: AgentModelMessage, encodeToolName: (name: string) => string) => {
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: {
          name: encodeToolName(call.name),
          arguments: JSON.stringify(call.arguments),
        },
      })),
    }
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name,
    }
  }

  return {
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map(part => part.type === 'image'
        ? {
          type: 'image_url',
          image_url: { url: part.imageUrl },
        }
        : {
          type: 'text',
          text: part.text,
        })
      : message.content,
  }
}

const toResponsesInput = (
  messages: AgentModelMessage[],
  encodeToolName: (name: string) => string
) => messages.flatMap(message => {
  if (message.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
    }]
  }
  const output: Array<Record<string, unknown>> = [{
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map(part => part.type === 'text'
        ? { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
        : { type: 'input_image', image_url: part.imageUrl }),
  }]
  for (const call of message.toolCalls || []) {
    output.push({
      type: 'function_call',
      call_id: call.id,
      name: encodeToolName(call.name),
      arguments: JSON.stringify(call.arguments),
    })
  }
  return output
})

const parseArguments = (value: string): Record<string, unknown> => {
  if (!value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // The caller reports malformed model arguments as a Tool validation error.
  }
  return { __invalid_json: value }
}

const redact = (value: string, secrets: string[] = []) => {
  let result = value
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(secret).join('[REDACTED]')
  }
  return result
    .replace(/\b(?:sk|key|token)-[a-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(
      /("(?:api[_-]?key|authorization|token|password)"\s*:\s*")[^"]+(")/gi,
      '$1[REDACTED]$2'
    )
}

const normalizeResponse = (
  data: any,
  decodeToolName: (name: string) => string
): AgentModelResponse => {
  const message = data?.choices?.[0]?.message || {}
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call: any, index: number) => ({
        id: String(call.id || `tool-call-${index}`),
        name: decodeToolName(String(call.function?.name || '')),
        arguments: parseArguments(String(call.function?.arguments || '{}')),
      }))
      : [],
    usage: {
      inputTokens: Number(data?.usage?.prompt_tokens) || undefined,
      outputTokens: Number(data?.usage?.completion_tokens) || undefined,
    },
  }
}

export class OpenAICompatibleProvider implements AgentModelProvider {
  readonly name = 'openai-compatible'
  readonly capabilities: AgentProviderCapabilities
  private readonly endpoint: string

  constructor (private readonly options: OpenAICompatibleOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, '')
    const protocol: AgentProviderProtocol = options.protocol === 'responses'
      ? 'responses'
      : 'chat-completions'
    this.endpoint = `${baseUrl}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`
    this.capabilities = {
      protocol,
      stream: true,
      tools: true,
      structuredOutput: true,
      vision: true,
    }
  }

  async complete (
    request: AgentModelRequest,
    onDelta?: (delta: string) => void | Promise<void>
  ): Promise<AgentModelResponse> {
    if (this.capabilities.protocol === 'responses') {
      return this.completeResponses(request, onDelta)
    }
    const toolNames = createToolNameCodec(request)
    const timeoutSignal = AbortSignal.timeout(this.options.timeout)
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(message => toMessage(message, toolNames.encode)),
        tools: request.tools.length
          ? request.tools.map(tool => ({
            type: 'function',
            function: {
              name: toolNames.encode(tool.name),
              description: tool.description,
              parameters: tool.inputSchema,
            },
          }))
          : undefined,
        tool_choice: request.tools.length
          ? request.toolChoice || 'auto'
          : undefined,
        response_format: request.responseSchema
          ? {
            type: 'json_schema',
            json_schema: {
              name: request.responseSchema.name,
              strict: request.responseSchema.strict !== false,
              schema: request.responseSchema.schema,
            },
          }
          : undefined,
        stream: Boolean(onDelta),
        stream_options: onDelta ? { include_usage: true } : undefined,
      }),
      signal,
    })

    if (!response.ok) {
      const detail = redact((await response.text()).slice(0, 2048), [this.options.apiKey])
      throw new AgentProviderError(
        `[agent][model] 请求失败 ${response.status}: ${detail || response.statusText}`,
        response.status,
        response.status === 408 || response.status === 429 || response.status >= 500
      )
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      return normalizeResponse(await response.json(), toolNames.decode)
    }

    if (!response.body) throw new Error('[agent][model] SSE 响应缺少 body')
    return this.readStream(response.body, toolNames.decode, onDelta)
  }

  private async completeResponses (
    request: AgentModelRequest,
    onDelta?: (delta: string) => void | Promise<void>
  ): Promise<AgentModelResponse> {
    const toolNames = createToolNameCodec(request)
    const timeoutSignal = AbortSignal.timeout(this.options.timeout)
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify({
        model: request.model,
        input: toResponsesInput(request.messages, toolNames.encode),
        tools: request.tools.map(tool => ({
          type: 'function',
          name: toolNames.encode(tool.name),
          description: tool.description,
          parameters: tool.inputSchema,
          strict: true,
        })),
        tool_choice: request.tools.length
          ? request.toolChoice || 'auto'
          : undefined,
        text: request.responseSchema
          ? {
            format: {
              type: 'json_schema',
              name: request.responseSchema.name,
              schema: request.responseSchema.schema,
              strict: request.responseSchema.strict !== false,
            },
          }
          : undefined,
        stream: Boolean(onDelta),
      }),
      signal,
    })
    if (!response.ok) {
      const detail = redact((await response.text()).slice(0, 2048), [this.options.apiKey])
      throw new AgentProviderError(
        `[agent][model] Responses 请求失败 ${response.status}: ${detail || response.statusText}`,
        response.status,
        response.status === 408 || response.status === 429 || response.status >= 500
      )
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      return this.normalizeResponses(await response.json(), toolNames.decode)
    }
    if (!response.body) throw new Error('[agent][model] Responses SSE 缺少 body')
    return this.readResponsesStream(response.body, toolNames.decode, onDelta)
  }

  private normalizeResponses (data: any, decodeToolName: (name: string) => string) {
    const output = Array.isArray(data?.output) ? data.output : []
    const content = output.flatMap((item: any) => item.type === 'message'
      ? (item.content || []).filter((part: any) => part.type === 'output_text')
        .map((part: any) => String(part.text || ''))
      : []).join('') || String(data?.output_text || '')
    const toolCalls = output.filter((item: any) => item.type === 'function_call').map(
      (item: any, index: number) => ({
        id: String(item.call_id || item.id || `tool-call-${index}`),
        name: decodeToolName(String(item.name || '')),
        arguments: parseArguments(String(item.arguments || '{}')),
      })
    )
    return {
      content,
      toolCalls,
      usage: {
        inputTokens: Number(data?.usage?.input_tokens) || undefined,
        outputTokens: Number(data?.usage?.output_tokens) || undefined,
      },
    }
  }

  private async readResponsesStream (
    stream: ReadableStream<Uint8Array>,
    decodeToolName: (name: string) => string,
    onDelta?: (delta: string) => void | Promise<void>
  ): Promise<AgentModelResponse> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let completed: any
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    const consume = async (block: string) => {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        const event = JSON.parse(payload)
        if (event.type === 'response.output_text.delta') {
          const delta = String(event.delta || '')
          content += delta
          await onDelta?.(delta)
        } else if (event.type === 'response.output_item.added' &&
          event.item?.type === 'function_call') {
          calls.set(Number(event.output_index || 0), {
            id: String(event.item.call_id || event.item.id || ''),
            name: String(event.item.name || ''),
            arguments: String(event.item.arguments || ''),
          })
        } else if (event.type === 'response.function_call_arguments.delta') {
          const index = Number(event.output_index || 0)
          const call = calls.get(index) || { id: '', name: '', arguments: '' }
          call.arguments += String(event.delta || '')
          calls.set(index, call)
        } else if (event.type === 'response.completed') {
          completed = event.response
        }
      }
    }
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      for (const block of blocks) await consume(block)
      if (done) break
    }
    if (buffer.trim()) await consume(buffer)
    const normalized = completed
      ? this.normalizeResponses(completed, decodeToolName)
      : { content: '', toolCalls: [], usage: {} }
    return {
      ...normalized,
      content: content || normalized.content,
      toolCalls: calls.size
        ? [...calls.entries()].sort(([left], [right]) => left - right).map(([index, call]) => ({
          id: call.id || `tool-call-${index}`,
          name: decodeToolName(call.name),
          arguments: parseArguments(call.arguments || '{}'),
        }))
        : normalized.toolCalls,
    }
  }

  private async readStream (
    stream: ReadableStream<Uint8Array>,
    decodeToolName: (name: string) => string,
    onDelta?: (delta: string) => void | Promise<void>
  ): Promise<AgentModelResponse> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const calls = new Map<
      number,
      {
        id: string
        name: string
        arguments: string
      }
    >()
    let content = ''
    let buffer = ''
    let usage: AgentModelResponse['usage']

    const consume = async (block: string) => {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let data: any
        try {
          data = JSON.parse(payload)
        } catch {
          throw new Error('[agent][model] 收到无法解析的 SSE 数据')
        }

        if (data.usage) {
          usage = {
            inputTokens: Number(data.usage.prompt_tokens) || undefined,
            outputTokens: Number(data.usage.completion_tokens) || undefined,
          }
        }

        const delta = data?.choices?.[0]?.delta
        if (!delta) continue
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content
          await onDelta?.(delta.content)
        }

        for (const call of delta.tool_calls || []) {
          const index = Number(call.index || 0)
          const current = calls.get(index) || { id: '', name: '', arguments: '' }
          if (call.id) current.id += String(call.id)
          if (call.function?.name) current.name += String(call.function.name)
          if (call.function?.arguments) {
            current.arguments += String(call.function.arguments)
          }
          calls.set(index, current)
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      for (const block of blocks) await consume(block)
      if (done) break
    }
    if (buffer.trim()) await consume(buffer)

    const toolCalls: AgentToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        id: call.id || `tool-call-${index}`,
        name: decodeToolName(call.name),
        arguments: parseArguments(call.arguments),
      }))

    return { content, toolCalls, usage }
  }

  async listModels (signal?: AbortSignal) {
    const timeoutSignal = AbortSignal.timeout(this.options.timeout)
    const response = await fetch(this.endpoint.replace(/\/(?:chat\/completions|responses)$/, '/models'), {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        Accept: 'application/json',
      },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    })
    if (!response.ok) {
      const detail = redact((await response.text()).slice(0, 2048), [this.options.apiKey])
      throw new AgentProviderError(
        `[agent][model] 模型发现失败 ${response.status}: ${detail || response.statusText}`,
        response.status,
        response.status === 408 || response.status === 429 || response.status >= 500
      )
    }
    const data = await response.json() as { data?: Array<{ id?: string }> }
    return (data.data || []).map(item => String(item.id || '')).filter(Boolean).sort()
  }
}
