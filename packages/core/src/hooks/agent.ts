import { createHookId } from './cache'

export type AgentHookEvent =
  | 'beforeContext'
  | 'beforeModel'
  | 'afterModel'
  | 'beforeTool'
  | 'afterTool'
  | 'approval'
  | 'turnComplete'
  | 'memoryWrite'

export type AgentHookCallback<T = unknown> = (payload: T) => void | Promise<void>

interface AgentHookItem {
  id: number
  priority: number
  callback: AgentHookCallback
}

const hookCache = new Map<AgentHookEvent, AgentHookItem[]>()

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
  beforeModel: register('beforeModel'),
  afterModel: register('afterModel'),
  beforeTool: register('beforeTool'),
  afterTool: register('afterTool'),
  approval: register('approval'),
  turnComplete: register('turnComplete'),
  memoryWrite: register('memoryWrite'),
  remove (id: number) {
    for (const [event, list] of hookCache) {
      hookCache.set(
        event,
        list.filter(item => item.id !== id)
      )
    }
  },
}

export const agentHookEmit = async (event: AgentHookEvent, payload: unknown) => {
  for (const hook of hookCache.get(event) || []) {
    try {
      await hook.callback(payload)
    } catch (error) {
      logger.error(new Error(`[agent][hook] ${event} 执行失败`, { cause: error }))
    }
  }
}
