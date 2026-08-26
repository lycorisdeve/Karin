import { describe, expect, it } from 'vitest'

import { AgentProviderError } from '../../packages/core/src/agent/model/openai-compatible'
import {
  normalizeAgentError,
  safeAgentErrorMessage,
} from '../../packages/core/src/agent/runtime/errors'

describe('Agent runtime errors', () => {
  it('classifies common Provider failures into stable error codes', () => {
    expect(normalizeAgentError(
      new AgentProviderError('maximum context length exceeded', 400)
    ).info).toEqual({
      code: 'CONTEXT_WINDOW_EXCEEDED',
      source: 'provider',
      retryable: false,
      httpStatusCode: 400,
    })

    expect(normalizeAgentError(
      new AgentProviderError('rate limit exceeded', 429, true)
    ).info).toEqual({
      code: 'USAGE_LIMIT_EXCEEDED',
      source: 'provider',
      retryable: true,
      httpStatusCode: 429,
    })

    expect(normalizeAgentError(
      new AgentProviderError('invalid API key', 401)
    ).info).toEqual({
      code: 'UNAUTHORIZED',
      source: 'provider',
      retryable: false,
      httpStatusCode: 401,
    })
  })

  it('preserves explicit stream failures and runtime limits', () => {
    expect(normalizeAgentError(new AgentProviderError(
      'SSE disconnected',
      undefined,
      true,
      'RESPONSE_STREAM_DISCONNECTED'
    )).info).toEqual({
      code: 'RESPONSE_STREAM_DISCONNECTED',
      source: 'provider',
      retryable: true,
    })

    expect(normalizeAgentError(
      '执行已达到最大 12 次模型调用，已安全停止。',
      { source: 'runtime' }
    ).info).toEqual({
      code: 'RUNTIME_LIMIT_EXCEEDED',
      source: 'runtime',
      retryable: false,
    })
  })

  it('redacts credentials before errors are exposed or persisted', () => {
    const message = safeAgentErrorMessage(
      'Bearer abc.def.ghi {"api_key":"sk-sensitive-value","password":"secret"}'
    )
    expect(message).toBe(
      'Bearer [REDACTED] {"api_key":"[REDACTED]","password":"[REDACTED]"}'
    )
  })
})
