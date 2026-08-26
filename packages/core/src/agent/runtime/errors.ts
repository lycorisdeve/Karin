import { AgentProviderError } from '../model/openai-compatible'

import type { AgentErrorCode, AgentErrorInfo } from '@/types/agent'

const retryableCodes = new Set<AgentErrorCode>([
  'USAGE_LIMIT_EXCEEDED',
  'HTTP_CONNECTION_FAILED',
  'RESPONSE_STREAM_CONNECTION_FAILED',
  'RESPONSE_STREAM_DISCONNECTED',
  'RESPONSE_TOO_MANY_FAILED_ATTEMPTS',
  'MODEL_TIMEOUT',
])

export const safeAgentErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .slice(0, 2048)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|key|token)-[a-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(
      /("(?:api[_-]?key|authorization|token|password)"\s*:\s*")[^"]+(")/gi,
      '$1[REDACTED]$2'
    )
}

const statusCode = (error: unknown) => {
  if (error instanceof AgentProviderError) return error.status
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined
  const status = Number(error.status)
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

const inferSource = (error: unknown, message: string): AgentErrorInfo['source'] => {
  if (
    error instanceof AgentProviderError ||
    error instanceof TypeError ||
    /\[agent\]\[model\]|provider|sse|http/i.test(message)
  ) return 'provider'
  return 'runtime'
}

const inferCode = (
  error: unknown,
  message: string,
  status: number | undefined,
  source: AgentErrorInfo['source'],
  interrupted: boolean
): AgentErrorCode => {
  if (interrupted) return 'INTERRUPTED'
  if (error instanceof AgentProviderError && error.code) return error.code
  if (/context (?:window|length)|maximum context|上下文.{0,12}(?:超|限制)/i.test(message)) {
    return 'CONTEXT_WINDOW_EXCEEDED'
  }
  if (status === 429 || /rate.?limit|usage limit|insufficient_quota|配额|额度|限流/i.test(message)) {
    return 'USAGE_LIMIT_EXCEEDED'
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api.?key|鉴权失败/i.test(message)) {
    return 'UNAUTHORIZED'
  }
  if (status === 408 || /timeout|请求超时|响应超时/i.test(message)) return 'MODEL_TIMEOUT'
  if (/所有 Provider 均不可用|too many failed attempts|max(?:imum)? attempts/i.test(message)) {
    return 'RESPONSE_TOO_MANY_FAILED_ATTEMPTS'
  }
  if (source === 'runtime' && /最大.{0,12}(?:调用|迭代)|总时限|预算耗尽|无限循环/i.test(message)) {
    return 'RUNTIME_LIMIT_EXCEEDED'
  }
  if (status && status >= 400 && status < 500) return 'BAD_REQUEST'
  if (error instanceof TypeError || (status && status >= 500)) return 'HTTP_CONNECTION_FAILED'
  return 'OTHER'
}

export const normalizeAgentError = (
  error: unknown,
  options: {
    interrupted?: boolean
    source?: AgentErrorInfo['source']
  } = {}
) => {
  const message = safeAgentErrorMessage(error)
  const status = statusCode(error)
  const source = options.source || inferSource(error, message)
  const code = inferCode(error, message, status, source, Boolean(options.interrupted))
  const retryable = error instanceof AgentProviderError
    ? error.transient
    : retryableCodes.has(code)
  return {
    message,
    info: {
      code,
      source,
      retryable,
      ...(status ? { httpStatusCode: status } : {}),
    } satisfies AgentErrorInfo,
  }
}
