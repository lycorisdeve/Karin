import { adapter } from '@/utils/config/file/adapter'

export const redactSecrets = (value: unknown, secrets: string[] = []) => {
  let result = value instanceof Error ? value.message : String(value)
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(secret).join('[REDACTED]')
  }
  return result
    .replace(
      /("(?:secret|appSecret|botToken|token|authorization)"\s*:\s*")[^"]+(")/gi,
      '$1[REDACTED]$2'
    )
    .replace(/\/bot[^/]+\/(getMe|getWebhookInfo|getUpdates|sendMessage)/gi, '/bot[REDACTED]/$1')
}

export const redactChannelError = (value: unknown) => {
  const config = adapter()
  return redactSecrets(value, [
    ...config.wecom.map(item => item.secret),
    ...config.feishu.map(item => item.appSecret),
    ...config.telegram.map(item => item.botToken),
    ...config.qqbot.map(item => item.clientSecret),
    ...config.wechat.map(item => item.token),
    ...config.dingtalk.map(item => item.clientSecret),
    ...config.discord.map(item => item.botToken),
    ...config.whatsapp.flatMap(item => [item.accessToken, item.appSecret, item.verifyToken]),
    ...config.email.flatMap(item => [item.imapPassword, item.smtpPassword]),
  ])
}
