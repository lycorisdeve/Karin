import { empty } from './empty'
import { message } from './messaeg'
import { sendMsg } from './sendMsg'
import { eventCall } from './eventCall'
import { agent } from './agent'

/**
 * 消息钩子系统类型
 */
export type HooksType = {
  /** 消息hook */
  message: typeof message
  /** 发送消息钩子 */
  sendMsg: typeof sendMsg
  /** 未找到匹配插件钩子 */
  empty: typeof empty
  /** 事件调用插件钩子 */
  eventCall: typeof eventCall
  /** Agent 生命周期 hook */
  agent: typeof agent
}

/**
 * 消息钩子系统
 */
export const hooks: HooksType = {
  message,
  sendMsg,
  empty,
  eventCall,
  agent,
}

export * from './agent'
