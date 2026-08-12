import { OpenAICompatibleProvider, AgentProviderError } from './openai-compatible'
import type {
  AgentConfig,
  AgentModelProvider,
  AgentModelRequest,
  AgentModelResponse,
  AgentProviderProfile,
} from '@/types/agent'

export interface AgentProviderProbe {
  provider: string
  model: string
  models: string[]
  chat: boolean
  stream: boolean
  tools: boolean
  latency: number
}

const wait = (duration: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, duration)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })

const clientFor = (profile: AgentProviderProfile) =>
  new OpenAICompatibleProvider({
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    timeout: profile.timeout,
    protocol: profile.protocol,
  })

const isTransient = (error: unknown) => {
  if (error instanceof AgentProviderError) return error.transient
  if (error instanceof DOMException && error.name === 'AbortError') return false
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  return error instanceof TypeError
}

const normalizeProviderError = (error: unknown, timeout: number) => {
  const message = error instanceof Error ? error.message : String(error)
  if (
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    /aborted due to timeout|TimeoutError/i.test(message)
  ) {
    return new AgentProviderError(
      `[agent][model] 模型请求超时（${timeout}ms）`,
      408,
      true
    )
  }
  return error
}

export class AgentProviderRegistry implements AgentModelProvider {
  readonly name = 'karin-provider-registry'

  constructor (private readonly getConfig: () => AgentConfig) {}

  private profiles (request: AgentModelRequest) {
    const config = this.getConfig()
    const defaults = [config.routing.primary, ...config.routing.fallback]
      .map(id => config.providers.find(profile => profile.id === id))
      .filter(
        (profile): profile is AgentProviderProfile =>
          Boolean(profile?.enabled && profile.apiKey && profile.model)
      )
      .map(profile => ({ profile, model: profile.model }))
    const selected = request.providerId
      ? config.providers.find(profile => profile.id === request.providerId)
      : null
    const entries = selected?.enabled && selected.apiKey && request.model
      ? [{ profile: selected, model: request.model }, ...defaults]
      : defaults
    return entries.filter(
      (entry, index, list) =>
        list.findIndex(item =>
          item.profile.id === entry.profile.id && item.model === entry.model
        ) === index
    )
  }

  private profile (id: string) {
    return this.getConfig().providers.find(profile => profile.id === id) || null
  }

  capabilitiesFor (id: string) {
    const profile = this.profile(id)
    if (!profile) throw new Error(`Provider 不存在: ${id}`)
    return clientFor(profile).capabilities
  }

  async complete (
    request: AgentModelRequest,
    onDelta?: (delta: string) => void | Promise<void>
  ): Promise<AgentModelResponse> {
    const started = Date.now()
    const profiles = this.profiles(request)
    if (!profiles.length) throw new Error('[agent][model] 没有可用的 Provider')
    const fallbackFrom: string[] = []
    const retryReasons: string[] = []
    let retries = 0
    let lastError: unknown

    for (const entry of profiles) {
      const { profile, model } = entry
      const sessionOverride =
        profile.id === request.providerId && model === request.model
      const provider = clientFor(profile)
      for (let attempt = 0; attempt < 2; attempt++) {
        let emittedDelta = false
        try {
          const response = await provider.complete(
            { ...request, providerId: undefined, model },
            async delta => {
              emittedDelta = true
              await onDelta?.(delta)
            }
          )
          if (!response.content && !response.toolCalls.length) {
            throw new AgentProviderError('[agent][model] Provider 返回空响应', undefined, true)
          }
          return {
            ...response,
            provider: profile.id,
            model,
            retries,
            fallbackFrom,
            retryReasons,
            latencyMs: Date.now() - started,
          }
        } catch (error) {
          const normalized = normalizeProviderError(error, profile.timeout)
          lastError = normalized
          // A streamed response cannot be replayed safely without duplicating text
          // already delivered to the caller.
          if (request.signal?.aborted || emittedDelta) throw normalized
          const reason = normalized instanceof AgentProviderError && normalized.status
            ? `${profile.id}:HTTP ${normalized.status}`
            : `${profile.id}:${normalized instanceof Error ? normalized.name : 'network'}`
          if (!isTransient(normalized)) {
            if (!sessionOverride) throw normalized
            retryReasons.push(`${reason}:session-fallback`)
            break
          }
          if (attempt === 0) {
            retries++
            retryReasons.push(`${reason}:retry`)
            await wait(250, request.signal)
            continue
          }
          retryReasons.push(`${reason}:fallback`)
        }
      }
      fallbackFrom.push(profile.id)
    }
    throw lastError instanceof Error ? lastError : new Error('[agent][model] 所有 Provider 均不可用')
  }

  async listModels (id: string, signal?: AbortSignal) {
    const profile = this.profile(id)
    if (!profile) throw new Error(`Provider 不存在: ${id}`)
    if (!profile.apiKey) throw new Error(`Provider ${id} 未配置 API Key`)
    return clientFor(profile).listModels(signal)
  }

  async probe (id: string, signal?: AbortSignal): Promise<AgentProviderProbe> {
    const profile = this.profile(id)
    if (!profile) throw new Error(`Provider 不存在: ${id}`)
    if (!profile.apiKey) throw new Error(`Provider ${id} 未配置 API Key`)
    if (!profile.model) throw new Error(`Provider ${id} 未配置模型`)
    const provider = clientFor(profile)
    const started = Date.now()
    let models: string[] = []
    try {
      models = await provider.listModels(signal)
    } catch {
      // Some compatible endpoints do not expose /models. Chat remains authoritative.
    }
    const chat = await provider.complete({
      model: profile.model,
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      tools: [],
      signal,
    })
    let streamed = ''
    await provider.complete(
      {
        model: profile.model,
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
        tools: [],
        signal,
      },
      delta => {
        streamed += delta
      }
    )
    const tool = await provider.complete({
      model: profile.model,
      messages: [{
        role: 'user',
        content: 'Call the health check tool now. Do not answer without calling it.',
      }],
      tools: [
        {
          name: 'karin.health.echo',
          description: 'Health check',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
        },
      ],
      toolChoice: 'auto',
      signal,
    })
    return {
      provider: id,
      model: profile.model,
      models,
      chat: Boolean(chat.content),
      stream: Boolean(streamed),
      tools: tool.toolCalls.some(call => call.name === 'karin.health.echo'),
      latency: Date.now() - started,
    }
  }
}
