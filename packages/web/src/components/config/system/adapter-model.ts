import type { Adapters } from 'node-karin'

export type WeComFormAccount = Adapters['wecom'][number] & {
  secretConfigured?: boolean
}

export type FeishuFormAccount = Adapters['feishu'][number] & {
  appSecretConfigured?: boolean
}

export type TelegramFormAccount = Adapters['telegram'][number] & {
  botTokenConfigured?: boolean
}

export type QQBotFormAccount = Adapters['qqbot'][number] & {
  clientSecretConfigured?: boolean
}

export type WeChatFormAccount = Adapters['wechat'][number] & {
  tokenConfigured?: boolean
}

export type DingTalkFormAccount = Adapters['dingtalk'][number] & {
  clientSecretConfigured?: boolean
}

export type DiscordFormAccount = Adapters['discord'][number] & {
  botTokenConfigured?: boolean
}

export type WhatsAppFormAccount = Adapters['whatsapp'][number] & {
  accessTokenConfigured?: boolean
  appSecretConfigured?: boolean
  verifyTokenConfigured?: boolean
}

export type EmailFormAccount = Adapters['email'][number] & {
  imapPasswordConfigured?: boolean
  smtpPasswordConfigured?: boolean
}

export interface AdapterFormValues {
  console: Omit<Adapters['console'], 'host'> & {
    protocol: 'http' | 'https'
    host: string
  }
  onebot: Adapters['onebot']
  wecom: WeComFormAccount[]
  feishu: FeishuFormAccount[]
  telegram: TelegramFormAccount[]
  qqbot: QQBotFormAccount[]
  wechat: WeChatFormAccount[]
  dingtalk: DingTalkFormAccount[]
  discord: DiscordFormAccount[]
  whatsapp: WhatsAppFormAccount[]
  email: EmailFormAccount[]
}

const splitHost = (host: string) => {
  const match = String(host || '').match(/^(https?):\/\/(.*)$/)
  return {
    protocol: match?.[1] === 'https' ? 'https' as const : 'http' as const,
    host: match?.[2] ?? String(host || ''),
  }
}

export const toAdapterFormValues = (data: Adapters): AdapterFormValues => {
  const host = splitHost(data.console.host)
  return {
    console: {
      isLocal: data.console.isLocal ?? true,
      token: data.console.token ?? '',
      protocol: host.protocol,
      host: host.host,
    },
    onebot: {
      ws_server: {
        enable: data.onebot.ws_server.enable ?? false,
        timeout: data.onebot.ws_server.timeout ?? 120,
      },
      ws_client: data.onebot.ws_client ?? [],
      http_server: data.onebot.http_server ?? [],
    },
    wecom: data.wecom ?? [],
    feishu: data.feishu ?? [],
    telegram: data.telegram ?? [],
    qqbot: data.qqbot ?? [],
    wechat: data.wechat ?? [],
    dingtalk: data.dingtalk ?? [],
    discord: data.discord ?? [],
    whatsapp: data.whatsapp ?? [],
    email: data.email ?? [],
  }
}

export const toAdapterConfig = (values: AdapterFormValues): Adapters => ({
  console: {
    isLocal: values.console.isLocal,
    token: values.console.token,
    host: values.console.host
      ? `${values.console.protocol}://${values.console.host}`
      : '',
  },
  onebot: values.onebot,
  wecom: values.wecom.map(account => {
    const config = { ...account }
    delete config.secretConfigured
    return config
  }),
  feishu: values.feishu.map(account => {
    const config = { ...account }
    delete config.appSecretConfigured
    return config
  }),
  telegram: values.telegram.map(account => {
    const config = { ...account }
    delete config.botTokenConfigured
    return config
  }),
  qqbot: values.qqbot.map(account => {
    const config = { ...account }
    delete config.clientSecretConfigured
    return config
  }),
  wechat: values.wechat.map(account => {
    const config = { ...account }
    delete config.tokenConfigured
    return config
  }),
  dingtalk: values.dingtalk.map(account => {
    const config = { ...account }
    delete config.clientSecretConfigured
    return config
  }),
  discord: values.discord.map(account => {
    const config = { ...account }
    delete config.botTokenConfigured
    return config
  }),
  whatsapp: values.whatsapp.map(account => {
    const config = { ...account }
    delete config.accessTokenConfigured
    delete config.appSecretConfigured
    delete config.verifyTokenConfigured
    return config
  }),
  email: values.email.map(account => {
    const config = { ...account }
    delete config.imapPasswordConfigured
    delete config.smtpPasswordConfigured
    return config
  }),
})

export const validateAdapterConfig = (values: AdapterFormValues) => {
  if (!values.console.isLocal && !values.console.token.trim()) {
    return 'Console 允许外部访问时必须设置 Token'
  }

  const validateIds = (
    label: string,
    accounts: Array<{ id: string }>
  ) => {
    const ids = accounts.map(account => account.id.trim())
    if (ids.some(id => !id)) return `${label}存在空的账号 ID`
    if (new Set(ids).size !== ids.length) return `${label}存在重复的账号 ID`
    return ''
  }

  for (const [label, accounts] of [
    ['企业微信', values.wecom],
    ['飞书', values.feishu],
    ['Telegram', values.telegram],
    ['QQBot', values.qqbot],
    ['个人微信', values.wechat],
    ['钉钉', values.dingtalk],
    ['Discord', values.discord],
    ['WhatsApp', values.whatsapp],
    ['Email', values.email],
  ] as const) {
    const message = validateIds(label, accounts)
    if (message) return message
  }

  for (const account of values.wecom) {
    if (account.enable && !account.botId.trim()) {
      return `企业微信账号“${account.name || account.id}”缺少 Bot ID`
    }
    if (account.enable && !account.secretConfigured && !account.secret.trim()) {
      return `企业微信账号“${account.name || account.id}”缺少 Secret`
    }
  }

  for (const account of values.feishu) {
    if (account.enable && !account.appId.trim()) {
      return `飞书账号“${account.name || account.id}”缺少 App ID`
    }
    if (account.enable && !account.appSecretConfigured && !account.appSecret.trim()) {
      return `飞书账号“${account.name || account.id}”缺少 App Secret`
    }
  }

  for (const account of values.telegram) {
    if (account.enable && !account.botTokenConfigured && !account.botToken.trim()) {
      return `Telegram 账号“${account.name || account.id}”缺少 Bot Token`
    }
  }

  for (const account of values.qqbot) {
    if (account.enable && (!account.appId.trim() ||
      (!account.clientSecretConfigured && !account.clientSecret.trim()))) {
      return `QQBot 账号“${account.name || account.id}”缺少 App ID 或 Client Secret`
    }
  }

  for (const account of values.wechat) {
    if (account.enable && (!/^https?:\/\//i.test(account.serverUrl) ||
      (!account.tokenConfigured && !account.token.trim()))) {
      return `个人微信账号“${account.name || account.id}”缺少有效服务地址或 Token`
    }
  }

  for (const account of values.dingtalk) {
    if (account.enable && (!account.clientId.trim() ||
      (!account.clientSecretConfigured && !account.clientSecret.trim()))) {
      return `钉钉账号“${account.name || account.id}”缺少 Client ID 或 Client Secret`
    }
  }

  for (const account of values.discord) {
    if (account.enable && (!account.applicationId.trim() ||
      (!account.botTokenConfigured && !account.botToken.trim()))) {
      return `Discord 账号“${account.name || account.id}”缺少 Application ID 或 Bot Token`
    }
  }

  for (const account of values.whatsapp) {
    if (account.enable && (
      !account.phoneNumberId.trim() ||
      (!account.accessTokenConfigured && !account.accessToken.trim()) ||
      (!account.appSecretConfigured && !account.appSecret.trim()) ||
      (!account.verifyTokenConfigured && !account.verifyToken.trim())
    )) {
      return `WhatsApp 账号“${account.name || account.id}”缺少 Cloud API 凭证`
    }
  }

  for (const account of values.email) {
    if (account.enable && (
      !account.address.trim() ||
      !account.imapHost.trim() ||
      !account.smtpHost.trim() ||
      (!account.imapPasswordConfigured && !account.imapPassword.trim()) ||
      (!account.smtpPasswordConfigured && !account.smtpPassword.trim())
    )) {
      return `Email 账号“${account.name || account.id}”缺少邮箱服务器或密码`
    }
  }

  const invalidWs = values.onebot.ws_client.find(item =>
    item.enable && !/^wss?:\/\//i.test(item.url)
  )
  if (invalidWs) return '启用的 OneBot WebSocket 客户端必须使用 ws:// 或 wss:// 地址'

  const invalidHttp = values.onebot.http_server.find(item =>
    item.enable && !/^https?:\/\//i.test(item.url)
  )
  if (invalidHttp) return '启用的 OneBot HTTP 服务端必须使用 http:// 或 https:// 地址'

  return ''
}
