import { watch } from '../../fs/watch'
import { FILE_CHANGE } from '@/utils/fs'
import { diffArray } from '@/utils/common/number'
import { requireFileSync } from '../../fs/require'
import { listeners } from '@/core/internal/listeners'
import { cacheMap } from '@/adapter/onebot/core/cache'
import { createOneBotClient, createOneBotHttp } from '@/adapter/onebot/create/create'

import type {
  Adapters,
  ChannelAccountBase,
  FeishuAccountConfig,
  TelegramAccountConfig,
  WeComAccountConfig,
  QQBotAccountConfig,
  WeChatAccountConfig,
  DingTalkAccountConfig,
  DiscordAccountConfig,
  WhatsAppAccountConfig,
  EmailAccountConfig,
} from '@/types/config'

/** adapter.json 缓存 */
let cache: Adapters

/**
 * @description 格式化配置
 * @param data 配置
 * @returns 格式化后的配置
 */
const formatBase = <T extends ChannelAccountBase>(value: T, prefix: string, index: number) => ({
  id: String(value.id || `${prefix}-${index + 1}`).trim().slice(0, 64),
  name: String(value.name || `${prefix}-${index + 1}`).trim().slice(0, 100),
  enable: value.enable === true,
  trigger: {
    wakeWords: Array.isArray(value.trigger?.wakeWords)
      ? value.trigger.wakeWords.map(String).map(item => item.trim()).filter(Boolean)
      : [],
  },
})

const uniqueAccounts = <T extends { id: string }>(accounts: T[]) =>
  accounts.filter((account, index, list) =>
    list.findIndex(item => item.id === account.id) === index
  )

export const formatAdapterConfig = (data: Adapters): Adapters => {
  return {
    console: {
      ...data.console,
      token: String(data.console.token),
    },
    onebot: {
      ws_server: {
        ...data.onebot.ws_server,
        timeout: Number(data.onebot.ws_server.timeout) || 120,
      },
      ws_client: data.onebot.ws_client.map(v => ({
        ...v,
        token: String(v.token),
      })),
      http_server: data.onebot.http_server.map(v => ({
        ...v,
        self_id: String(v.self_id),
        api_token: String(v?.api_token) || String(v.token),
        post_token: String(v.post_token),
      })),

    },
    wecom: (Array.isArray(data.wecom) ? data.wecom : [])
      .map((value, index) => ({
        ...formatBase(value, 'wecom', index),
        botId: String(value.botId || ''),
        secret: String(value.secret || ''),
        wsUrl: String(value.wsUrl || ''),
        reconnectInterval: Math.max(1000, Number(value.reconnectInterval) || 5000),
        maxReconnectAttempts: Math.max(0, Number(value.maxReconnectAttempts) || 20),
      }))
      .filter((account, index, list) =>
        list.findIndex(item => item.id === account.id) === index
      ),
    feishu: (Array.isArray(data.feishu) ? data.feishu : [])
      .map((value, index) => ({
        ...formatBase(value, 'feishu', index),
        appId: String(value.appId || ''),
        appSecret: String(value.appSecret || ''),
        domain: value.domain === 'lark' ? 'lark' as const : 'feishu' as const,
        reconnectInterval: Math.max(1000, Number(value.reconnectInterval) || 5000),
        maxReconnectAttempts: Math.max(0, Number(value.maxReconnectAttempts) || 20),
      }))
      .filter((account, index, list) =>
        list.findIndex(item => item.id === account.id) === index
      ),
    telegram: (Array.isArray(data.telegram) ? data.telegram : [])
      .map((value, index) => ({
        ...formatBase(value, 'telegram', index),
        botToken: String(value.botToken || ''),
        apiBase: String(value.apiBase || 'https://api.telegram.org').replace(/\/+$/, ''),
        pollTimeout: Math.max(1, Math.min(Number(value.pollTimeout) || 30, 50)),
        allowedUpdates: Array.isArray(value.allowedUpdates)
          ? value.allowedUpdates.map(String)
          : ['message'],
      }))
      .filter((account, index, list) =>
        list.findIndex(item => item.id === account.id) === index
      ),
    qqbot: uniqueAccounts((Array.isArray(data.qqbot) ? data.qqbot : []).map((value, index) => ({
      ...formatBase(value, 'qqbot', index),
      appId: String(value.appId || ''),
      clientSecret: String(value.clientSecret || ''),
      apiBase: String(value.apiBase || 'https://api.sgroup.qq.com').replace(/\/+$/, ''),
      gatewayUrl: String(value.gatewayUrl || ''),
    }))),
    wechat: uniqueAccounts((Array.isArray(data.wechat) ? data.wechat : []).map((value, index) => ({
      ...formatBase(value, 'wechat', index),
      serverUrl: String(value.serverUrl || '').replace(/\/+$/, ''),
      token: String(value.token || ''),
      pollInterval: Math.max(500, Number(value.pollInterval) || 1500),
    }))),
    dingtalk: uniqueAccounts((Array.isArray(data.dingtalk) ? data.dingtalk : []).map((value, index) => ({
      ...formatBase(value, 'dingtalk', index),
      clientId: String(value.clientId || ''),
      clientSecret: String(value.clientSecret || ''),
      robotCode: String(value.robotCode || ''),
    }))),
    discord: uniqueAccounts((Array.isArray(data.discord) ? data.discord : []).map((value, index) => ({
      ...formatBase(value, 'discord', index),
      applicationId: String(value.applicationId || ''),
      botToken: String(value.botToken || ''),
      intents: Array.isArray(value.intents) ? value.intents.map(String) : ['Guilds', 'GuildMessages', 'DirectMessages', 'MessageContent'],
    }))),
    whatsapp: uniqueAccounts((Array.isArray(data.whatsapp) ? data.whatsapp : []).map((value, index) => ({
      ...formatBase(value, 'whatsapp', index),
      phoneNumberId: String(value.phoneNumberId || ''),
      accessToken: String(value.accessToken || ''),
      appSecret: String(value.appSecret || ''),
      verifyToken: String(value.verifyToken || ''),
      graphVersion: String(value.graphVersion || 'v23.0'),
    }))),
    email: uniqueAccounts((Array.isArray(data.email) ? data.email : []).map((value, index) => ({
      ...formatBase(value, 'email', index),
      address: String(value.address || ''),
      imapHost: String(value.imapHost || ''),
      imapPort: Math.max(1, Number(value.imapPort) || 993),
      imapSecure: value.imapSecure !== false,
      imapUser: String(value.imapUser || ''),
      imapPassword: String(value.imapPassword || ''),
      mailbox: String(value.mailbox || 'INBOX'),
      smtpHost: String(value.smtpHost || ''),
      smtpPort: Math.max(1, Number(value.smtpPort) || 465),
      smtpSecure: value.smtpSecure !== false,
      smtpUser: String(value.smtpUser || ''),
      smtpPassword: String(value.smtpPassword || ''),
    }))),
  }
}

/**
 * @internal
 * @description 初始化配置
 * @param listeners 事件监听器
 * @param dir 配置文件根目录
 */
const initAdapter = (dir: string) => {
  const name = 'adapter.json'

  const file = `${dir}/${name}`

  const data = requireFileSync<Adapters>(file, { type: 'json' })
  cache = formatAdapterConfig(data)

  watch<Adapters>(file, (old, data) => {
    cache = formatAdapterConfig(data)

    const options = { file: name, old, data: cache }
    listeners.emit(FILE_CHANGE, options)
    listeners.emit(`${FILE_CHANGE}:${name}`, options)
    hmrOneBot(old, data)
    import('@/adapter/channels')
      .then(({ channelRegistry }) => channelRegistry.reload(cache))
      .catch(error => logger.error('[channel] 热重载失败', error))
  }, { type: 'json' })
}

/**
 * @internal
 * @description 热重载
 * @param old 旧配置
 * @param data 新配置
 */
const hmrOneBot = (old: Adapters, data: Adapters) => {
  const client = diffArray(
    Array.isArray(old?.onebot?.ws_client) ? old?.onebot?.ws_client : [],
    Array.isArray(data?.onebot?.ws_client) ? data?.onebot?.ws_client : []
  )

  client.removed.forEach(v => {
    const bot = cacheMap.wsClient.get(v.url)
    if (!bot) return
    bot._onebot.close()
    cacheMap.wsClient.delete(v.url)
  })

  client.added.forEach(v => v.enable && createOneBotClient(v.url, v.token))

  const http = diffArray(
    Array.isArray(old?.onebot?.http_server) ? old?.onebot?.http_server : [],
    Array.isArray(data?.onebot?.http_server) ? data?.onebot?.http_server : []
  )

  http.removed.forEach(v => {
    const bot = cacheMap.http.get(v.url)
    if (!bot) return
    bot._onebot.close()
    cacheMap.http.delete(v.url)
  })
  http.added.forEach(v => v.enable && createOneBotHttp(v))
}

/**
 * @public 公开Api
 * @description 获取adapter.json
 */
export const adapter = () => cache

const maskAccount = <T extends object>(
  account: T,
  secretKey: keyof T
) => ({
    ...account,
    [secretKey]: '',
    [`${String(secretKey)}Configured`]: Boolean(account[secretKey]),
  })

/** Web API 使用的脱敏配置，OneBot 字段保持原样。 */
export const redactAdapterConfig = (config: Adapters) => ({
  ...config,
  wecom: config.wecom.map(account => maskAccount(account, 'secret')),
  feishu: config.feishu.map(account => maskAccount(account, 'appSecret')),
  telegram: config.telegram.map(account => maskAccount(account, 'botToken')),
  qqbot: config.qqbot.map(account => maskAccount(account, 'clientSecret')),
  wechat: config.wechat.map(account => maskAccount(account, 'token')),
  dingtalk: config.dingtalk.map(account => maskAccount(account, 'clientSecret')),
  discord: config.discord.map(account => maskAccount(account, 'botToken')),
  whatsapp: config.whatsapp.map(account => ({
    ...maskAccount(maskAccount(maskAccount(account, 'accessToken'), 'appSecret'), 'verifyToken'),
  })),
  email: config.email.map(account => ({
    ...maskAccount(maskAccount(account, 'imapPassword'), 'smtpPassword'),
  })),
})

export const publicAdapterConfig = () => redactAdapterConfig(cache)

type SecretUpdate = {
  clearSecret?: boolean
}

const mergeAccounts = <T extends ChannelAccountBase>(
  current: T[],
  incoming: Array<Partial<T> & Pick<T, 'id'>>,
  secretKey: keyof T
) => incoming.map(account => {
    const existing = current.find(item => item.id === account.id)
    const update = account as Partial<T> & Pick<T, 'id'> & SecretUpdate
    const submitted = update[secretKey]
    const secret = update.clearSecret
      ? ''
      : typeof submitted === 'string' && submitted
        ? submitted
        : existing?.[secretKey] || ''
    return { ...existing, ...update, [secretKey]: secret } as T
  })

const mergeAccountsWithSecrets = <T extends ChannelAccountBase>(
  current: T[],
  incoming: Array<Partial<T> & Pick<T, 'id'>>,
  secretKeys: Array<keyof T>
) => incoming.map(account => {
    const existing = current.find(item => item.id === account.id)
    const update = account as Partial<T> & Pick<T, 'id'> & SecretUpdate
    const merged = { ...existing, ...update } as T
    for (const secretKey of secretKeys) {
      const submitted = update[secretKey]
      merged[secretKey] = (
        update.clearSecret
          ? ''
          : typeof submitted === 'string' && submitted
            ? submitted
            : existing?.[secretKey] || ''
      ) as T[keyof T]
    }
    return merged
  })

/**
 * 合并 WebUI 写入。Secret 省略或空字符串时保留，clearSecret 才清除。
 */
export const mergeAdapterConfig = (
  current: Adapters,
  update: Partial<Adapters>
): Adapters => formatAdapterConfig({
  ...current,
  ...update,
  console: update.console || current.console,
  onebot: update.onebot || current.onebot,
  wecom: update.wecom
    ? mergeAccounts<WeComAccountConfig>(current.wecom, update.wecom, 'secret')
    : current.wecom,
  feishu: update.feishu
    ? mergeAccounts<FeishuAccountConfig>(current.feishu, update.feishu, 'appSecret')
    : current.feishu,
  telegram: update.telegram
    ? mergeAccounts<TelegramAccountConfig>(current.telegram, update.telegram, 'botToken')
    : current.telegram,
  qqbot: update.qqbot
    ? mergeAccounts<QQBotAccountConfig>(current.qqbot, update.qqbot, 'clientSecret')
    : current.qqbot,
  wechat: update.wechat
    ? mergeAccounts<WeChatAccountConfig>(current.wechat, update.wechat, 'token')
    : current.wechat,
  dingtalk: update.dingtalk
    ? mergeAccounts<DingTalkAccountConfig>(current.dingtalk, update.dingtalk, 'clientSecret')
    : current.dingtalk,
  discord: update.discord
    ? mergeAccounts<DiscordAccountConfig>(current.discord, update.discord, 'botToken')
    : current.discord,
  whatsapp: update.whatsapp
    ? mergeAccountsWithSecrets<WhatsAppAccountConfig>(
      current.whatsapp,
      update.whatsapp,
      ['accessToken', 'appSecret', 'verifyToken']
    )
    : current.whatsapp,
  email: update.email
    ? mergeAccountsWithSecrets<EmailAccountConfig>(
      current.email,
      update.email,
      ['imapPassword', 'smtpPassword']
    )
    : current.email,
})

export const mergeAdapterConfigUpdate = (update: Partial<Adapters>): Adapters =>
  mergeAdapterConfig(cache, update)

/**
 * @public 公开Api
 * @description onebotWs请求超时时间
 */
export const timeout = () => adapter().onebot.ws_server.timeout

/**
 * @public 公开Api
 * @description wsServer 鉴权token
 */
export const webSocketServerToken = () => process.env.WS_SERVER_AUTH_KEY

export default initAdapter
