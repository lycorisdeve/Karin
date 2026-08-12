import { createHookId } from './cache'

export type AgentHookEvent =
  | 'beforeContext'
  | 'beforeCompaction'
  | 'afterCompaction'
  | 'beforeModel'
  | 'afterModel'
  | 'beforeTool'
  | 'afterTool'
  | 'approval'
  | 'turnComplete'
  | 'memoryWrite'
  | 'memoryRetrieved'
  | 'memoryPromoted'
  | 'turnFailed'

export interface AgentHookResult {
  context?: string
}

export type AgentHookCallback<T = unknown> = (
  payload: T
) => void | AgentHookResult | Promise<void | AgentHookResult>

interface AgentHookItem {
  id: number
  priority: number
  callback: AgentHookCallback
}

const hookCache = new Map<AgentHookEvent, AgentHookItem[]>()
let hookTimeoutMs = 5000

export const configureAgentHookTimeout = (value: number) => {
  hookTimeoutMs = Math.max(100, Math.min(Number(value) || 5000, 60_000))
}

const add = (
  event: AgentHookEvent,
  callback: AgentHookCallback,
  options: { priority?: number } = {}
) => {
  const id = createHookId()
  const list = hookCache.get(event) || []
  list.push({ id, priority: options.priority ?? 10000, callback })
  list.sort((a, b) => a.priority - b.priority)
  hookCache.set(event, list)
  return id
}

const register =
  (event: AgentHookEvent) =>
    (callback: AgentHookCallback, options: { priority?: number } = {}) =>
      add(event, callback, options)

export const agent = {
  beforeContext: register('beforeContext'),
  beforeCompaction: register('beforeCompaction'),
  afterCompaction: register('afterCompaction'),
  beforeModel: register('beforeModel'),
  afterModel: register('afterModel'),
  beforeTool: register('beforeTool'),
  afterTool: register('afterTool'),
  approval: register('approval'),
  turnComplete: register('turnComplete'),
  memoryWrite: register('memoryWrite'),
  memoryRetrieved: register('memoryRetrieved'),
  memoryPromoted: register('memoryPromoted'),
  turnFailed: register('turnFailed'),
  remove (id: number) {
    for (const [event, list] of hookCache) {
      hookCache.set(
        event,
        list.filter(item => item.id !== id)
      )
    }
  },
}

const deepFreeze = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const item of Object.values(value)) deepFreeze(item, seen)
  return Object.freeze(value)
}

const immutableSnapshot = (payload: unknown) => {
  try {
    return deepFreeze(structuredClone(payload))
  } catch {
    return deepFreeze(payload)
  }
}

const reportHookError = (event: AgentHookEvent, error: unknown) => {
  const wrapped = new Error(`[agent][hook] ${event} 执行失败`, { cause: error })
  if (typeof logger !== 'undefined') logger.error(wrapped)
  else console.warn(wrapped.message)
}

const runHooks = async (event: AgentHookEvent, payload: unknown) => {
  const results: AgentHookResult[] = []
  for (const hook of hookCache.get(event) || []) {
    try {
      const timeout = AbortSignal.timeout(hookTimeoutMs)
      const result = await Promise.race([
        hook.callback(immutableSnapshot(payload)),
        new Promise<never>((_resolve, reject) => {
          timeout.addEventListener(
            'abort',
            () => reject(new Error(`Hook ${event} 执行超过 ${hookTimeoutMs}ms`)),
            { once: true }
          )
        }),
      ])
      if (result && typeof result === 'object') results.push(result)
    } catch (error) {
      reportHookError(event, error)
    }
  }
  return results
}

export const agentHookEmit = async (event: AgentHookEvent, payload: unknown) => {
  await runHooks(event, payload)
}

export const agentHookContext = async (event: AgentHookEvent, payload: unknown) => {
  const fragments: string[] = []
  let bytes = 0
  for (const result of await runHooks(event, payload)) {
    const context = String(result.context || '').trim().slice(0, 4096)
    if (!context) continue
    const size = Buffer.byteLength(context, 'utf8')
    if (bytes + size > 8192) continue
    fragments.push(context)
    bytes += size
  }
  return fragments
}
