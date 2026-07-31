import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../../packages/core/src/agent/model/provider-registry'

import type { AgentConfig } from '../../packages/core/src/types/agent'

afterEach(() => {
  vi.unstubAllGlobals()
})

const config = (): AgentConfig => ({
  version: 7,
  enabled: true,
  providers: [
    {
      id: 'primary',
      name: 'Primary',
      kind: 'deepseek',
      enabled: true,
      baseUrl: 'https://primary.example/v1',
      apiKey: 'primary-test-key',
      model: 'primary-model',
      timeout: 1000,
    },
    {
      id: 'fallback',
      name: 'Fallback',
      kind: 'kimi',
      enabled: true,
      baseUrl: 'https://fallback.example/v1',
      apiKey: 'fallback-test-key',
      model: 'fallback-model',
      timeout: 1000,
    },
  ],
  routing: { primary: 'primary', fallback: ['fallback'] },
  trigger: { private: true, groupMention: true, wakeWords: [] },
  limits: {
    maxToolRounds: 8,
    maxToolOutputBytes: 65536,
    maxRecentMessages: 40,
    maxSubagents: 3,
  },
  policy: {
    approvalTtlMs: 300000,
    hardDeny: [],
    rules: [],
    defaults: {
      read: 'allow',
      write: 'ask',
      external: 'ask',
      destructive: 'deny',
    },
  },
  learning: {
    memory: false,
    skills: false,
    reflection: { enabled: true, afterFailure: true, successInterval: 5 },
    curator: {
      enabled: true,
      intervalHours: 168,
      minIdleMinutes: 120,
      staleAfterDays: 30,
      archiveAfterDays: 90,
    },
    promotion: {
      autoMemory: true,
      autoRouting: true,
      autoDeclarativeSkills: true,
      minEvidence: 3,
      minSuccessRate: 0.8,
      maxRegressionRate: 0.05,
      autoRollback: true,
      rollbackWindow: 20,
    },
  },
  recovery: {
    enabled: true,
    maxCycles: 2,
    maxDiagnosticCalls: 8,
    maxDurationMs: 120000,
    researchPolicy: 'evidence-driven',
    repair: { requireApproval: true, workspaceRoots: [] },
  },
  tools: { disabled: [], disabledToolsets: [] },
  mcp: { enabled: false, servers: [] },
  scriptRuntime: {
    pythonExecutable: '',
    defaultTimeoutMs: 30000,
    maxTimeoutMs: 120000,
    defaultMaxOutputBytes: 65536,
    maxOutputBytes: 1048576,
  },
})

const request = {
  model: '',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [],
}

describe('Provider Registry', () => {
  it('retries transient failures once and then falls back in order', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('primary.example')) {
        return new Response('rate limited', { status: 429 })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'fallback ok', tool_calls: [] } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      }), { headers: { 'content-type': 'application/json' } })
    }))

    const result = await new AgentProviderRegistry(config).complete(request)

    expect(calls).toEqual([
      'https://primary.example/v1/chat/completions',
      'https://primary.example/v1/chat/completions',
      'https://fallback.example/v1/chat/completions',
    ])
    expect(result.content).toBe('fallback ok')
    expect(result.provider).toBe('fallback')
    expect(result.model).toBe('fallback-model')
    expect(result.retries).toBe(1)
    expect(result.fallbackFrom).toEqual(['primary'])
    expect(result.retryReasons).toEqual([
      'primary:HTTP 429:retry',
      'primary:HTTP 429:fallback',
    ])
    expect(result.latencyMs).toBeTypeOf('number')
  })

  it('does not retry or fall back after an authentication error', async () => {
    const fetchMock = vi.fn(async () => new Response('invalid api key', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const registry = new AgentProviderRegistry(config)

    await expect(registry.complete(request)).rejects.toThrow('401')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('tries the thread model first and falls back to global routing when it is invalid', async () => {
    const calls: Array<{ url: string; model: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      calls.push({ url: String(input), model: body.model })
      if (body.model === 'thread-model') {
        return new Response('model not found', { status: 404 })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'global ok', tool_calls: [] } }],
      }), { headers: { 'content-type': 'application/json' } })
    }))

    const result = await new AgentProviderRegistry(config).complete({
      ...request,
      providerId: 'fallback',
      model: 'thread-model',
    })

    expect(calls).toEqual([
      {
        url: 'https://fallback.example/v1/chat/completions',
        model: 'thread-model',
      },
      {
        url: 'https://primary.example/v1/chat/completions',
        model: 'primary-model',
      },
    ])
    expect(result).toMatchObject({
      provider: 'primary',
      model: 'primary-model',
      content: 'global ok',
      fallbackFrom: ['fallback'],
      retryReasons: ['fallback:HTTP 404:session-fallback'],
    })
  })

  it('discovers models without replacing the configured model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'model-b' }, { id: 'model-a' }],
    }), { headers: { 'content-type': 'application/json' } })))
    const value = config()
    const registry = new AgentProviderRegistry(() => value)

    await expect(registry.listModels('primary')).resolves.toEqual(['model-a', 'model-b'])
    expect(value.providers[0].model).toBe('primary-model')
  })
})
