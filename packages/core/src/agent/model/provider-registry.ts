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
  })

const isTransient = (error: unknown) => {
  if (error instanceof AgentProviderError) return error.transient
  if (error instanceof DOMException && error.name === 'AbortError') return false
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  return error instanceof TypeError
}

export class AgentProviderRegistry implements AgentModelProvider {
  readonly name = 'karin-provider-registry'

  constructor (private readonly getConfig: () => AgentConfig) {}

  private profiles () {
    const config = this.getConfig()
    return [config.routing.primary, ...config.routing.fallback]
      .map(id => config.providers.find(profile => profile.id === id))
      .filter(
        (profile): profile is AgentProviderProfile =>
          Boolean(profile?.enabled && profile.apiKey && profile.model)
      )
  }

  private profile (id: string) {
    return this.getConfig().providers.find(profile => profile.id === id) || null
  }

  async complete (
    request: AgentModelRequest,
    onDelta?: (delta: string) => void | Promise<void>
  ): Promise<AgentModelResponse> {
    const started = Date.now()
    const profiles = this.profiles()
    if (!profiles.length) throw new Error('[agent][model] 没有可用的 Provider')
    const fallbackFrom: string[] = []
    const retryReasons: string[] = []
    let retries = 0
    let lastError: unknown

    for (const profile of profiles) {
      const provider = clientFor(profile)
      for (let attempt = 0; attempt < 2; attempt++) {
        let emittedDelta = false
        try {
          const response = await provider.complete(
            { ...request, model: profile.model },
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
            model: profile.model,
            retries,
            fallbackFrom,
            retryReasons,
            latencyMs: Date.now() - started,
          }
        } catch (error) {
          lastError = error
          // A streamed response cannot be replayed safely without duplicating text
          // already delivered to the caller.
          if (request.signal?.aborted || emittedDelta || !isTransient(error)) throw error
          const reason = error instanceof AgentProviderError && error.status
            ? `${profile.id}:HTTP ${error.status}`
            : `${profile.id}:${error instanceof Error ? error.name : 'network'}`
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
