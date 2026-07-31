/**
 * adapter.json 类型
 */
export interface ChannelTriggerConfig {
  /** 群聊额外唤醒词 */
  wakeWords: string[]
}

export interface ChannelAccountBase {
  /** WebUI 和热重载使用的稳定标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 是否启用 */
  enable: boolean
  /** Agent 触发设置 */
  trigger: ChannelTriggerConfig
  /** WebUI 写入语义：显式清除本账号凭证，不持久化此字段 */
  clearSecret?: boolean
}

export interface WeComAccountConfig extends ChannelAccountBase {
  botId: string
  secret: string
  wsUrl: string
  reconnectInterval: number
  maxReconnectAttempts: number
}

export interface FeishuAccountConfig extends ChannelAccountBase {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  reconnectInterval: number
  maxReconnectAttempts: number
}

export interface TelegramAccountConfig extends ChannelAccountBase {
  botToken: string
  apiBase: string
  pollTimeout: number
  allowedUpdates: string[]
}

export interface Adapters {
  /** `console`适配器配置 */
  console: {
    /** 是否为只允许本地访问 */
    isLocal: boolean
    /** 如果`isLocal`为`false`，则需要设置`token` */
    token: string
    /** 打印的资源地址 */
    host: string
  },
  /** onebot适配器配置 */
  onebot: {
    /** ws服务器的鉴权令牌 也就是反向ws的token */
    ws_server: {
      /** 是否启用 */
      enable: boolean
      /** onebot发送请求超时时间 */
      timeout: number
    },
    /** 正向ws的配置 */
    ws_client: {
      /** 是否启用 */
      enable: boolean
      /** 正向ws的地址 */
      url: string
      /** 正向ws的鉴权令牌 */
      token: string
    }[]
    /** http服务器的配置 */
    http_server: {
      /** 是否启用 */
      enable: boolean
      /** 正向http的QQ号 */
      self_id: string
      /** http服务的地址 */
      url: string
      /** @deprecated http服务的鉴权令牌  */
      token: string
      /** 用于发送Api请求的鉴权Token 如果协议端没有设置无需填写 */
      api_token: string
      /** 用于验证请求合法的Token 如果协议端没有设置无需填写 */
      post_token: string
    }[]
  }
  /** 企业微信智能机器人长连接账号 */
  wecom: WeComAccountConfig[]
  /** 飞书/Lark 长连接账号 */
  feishu: FeishuAccountConfig[]
  /** Telegram Bot API long polling 账号 */
  telegram: TelegramAccountConfig[]
}
