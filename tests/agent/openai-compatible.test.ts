import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentProviderError,
  OpenAICompatibleProvider,
} from '../../packages/core/src/agent/model/openai-compatible'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI-compatible provider', () => {
  it('maps dotted tool names to protocol-safe aliases and restores them', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const alias = body.tools[0].function.name
      expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
      expect(alias).not.toContain('.')
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: { name: alias, arguments: '{}' },
              }],
            },
          }],
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      apiKey: 'secret',
      timeout: 1000,
    })

    const result = await provider.complete({
      model: 'fake',
      messages: [{ role: 'user', content: 'status' }],
      tools: [{
        name: 'karin.system.status',
        description: 'status',
        inputSchema: { type: 'object', additionalProperties: false },
      }],
      toolChoice: 'auto',
    })

    expect(result.toolCalls[0].name).toBe('karin.system.status')
  })

  it('parses streamed text and fragmented tool calls', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-","function":{"name":"test.","arguments":"{\\"value\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"echo","arguments":"\\"ok\\"}"}}]}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start (controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
                controller.close()
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
      )
    )
    const deltas: string[] = []
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      apiKey: 'secret',
      timeout: 1000,
    })

    const response = await provider.complete(
      {
        model: 'fake',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      },
      delta => {
        deltas.push(delta)
      }
    )

    expect(deltas.join('')).toBe('hello')
    expect(response.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'test.echo',
        arguments: { value: 'ok' },
      },
    ])
    expect(response.usage).toEqual({ inputTokens: 3, outputTokens: 4 })
  })

  it('labels malformed SSE data as a retryable stream failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('data: not-json\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }))
    )
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      apiKey: 'secret',
      timeout: 1000,
    })

    const error = await provider.complete({
      model: 'fake',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    }).catch(error => error)

    expect(error).toBeInstanceOf(AgentProviderError)
    expect(error).toMatchObject({
      code: 'RESPONSE_STREAM_DISCONNECTED',
      transient: true,
    })
  })

  it('never includes the API key in a successful result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok', tool_calls: [] } }],
              usage: {},
            }),
            { headers: { 'content-type': 'application/json' } }
          )
      )
    )
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      apiKey: 'do-not-return',
      timeout: 1000,
    })
    const result = await provider.complete({
      model: 'fake',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })
    expect(JSON.stringify(result)).not.toContain('do-not-return')
  })

  it('normalizes Responses tool calls, tool outputs, streaming text, and usage', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      expect(body.input).toContainEqual({
        type: 'function_call_output',
        call_id: 'call-old',
        output: '{"ok":true}',
      })
      expect(body.input).toContainEqual(expect.objectContaining({
        type: 'function_call',
        call_id: 'call-old',
      }))
      const alias = body.tools[0].name
      const chunks = [
        'data: {"type":"response.output_text.delta","delta":"好"}\n\n',
        `data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call-new","name":"${alias}","arguments":""}}\n\n`,
        'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"value\\":\\"ok\\"}"}\n\n',
        'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
      ]
      return new Response(new ReadableStream({
        start (controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost/v1',
      apiKey: 'secret',
      timeout: 1000,
      protocol: 'responses',
    })
    const response = await provider.complete({
      model: 'fake',
      messages: [
        { role: 'user', content: 'run' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-old', name: 'test.echo', arguments: { value: 'old' } }],
        },
        {
          role: 'tool',
          content: '{"ok":true}',
          toolCallId: 'call-old',
          name: 'test.echo',
        },
      ],
      tools: [{
        name: 'test.echo',
        description: 'echo',
        inputSchema: { type: 'object' },
      }],
    }, () => undefined)

    expect(response.content).toBe('好')
    expect(response.toolCalls).toEqual([{
      id: 'call-new',
      name: 'test.echo',
      arguments: { value: 'ok' },
    }])
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
  })
})
