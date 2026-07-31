import { createHash } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import PostalMime from 'postal-mime'
import { BuiltinChannelAdapter } from './adapter'
import { channelStateStore } from './state'
import { redactSecrets } from './security'
import { resolveChannelImage, saveInboundChannelImage } from './media'
import { segment } from '@/utils/message'

import type { Adapters, Contact, Elements } from '@/types'
import type { ChannelDriver, ChannelProbeResult, ChannelStatus } from './types'
import type { Transporter } from 'nodemailer'

type EmailConfig = Adapters['email'][number]

const peerAddress = (peer: string) => decodeURIComponent(peer.split('|', 1)[0])
const threadKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20)

export class EmailChannelDriver implements ChannelDriver<EmailConfig> {
  readonly kind = 'email' as const
  readonly capabilities = { text: true, image: true, inboundImage: true }
  private config: EmailConfig
  private imap: ImapFlow | null = null
  private mailer: Transporter | null = null
  private bot: BuiltinChannelAdapter | null = null
  private poller: NodeJS.Timeout | null = null
  private polling = false
  private routes = new Map<string, {
    subject: string
    inReplyTo: string
    references: string[]
  }>()

  private current: ChannelStatus

  constructor (config: EmailConfig) {
    this.config = config
    this.current = {
      kind: this.kind,
      id: config.id,
      name: config.name,
      enabled: config.enable,
      state: config.enable ? 'connecting' : 'disabled',
      botId: config.address,
      lastInbound: null,
      lastError: '',
      reconnects: 0,
    }
  }

  private createImap (config: EmailConfig, verifyOnly = false) {
    return new ImapFlow({
      host: config.imapHost,
      port: config.imapPort,
      secure: config.imapSecure,
      auth: { user: config.imapUser, pass: config.imapPassword },
      logger: false,
      verifyOnly,
      connectionTimeout: 15000,
      socketTimeout: 60000,
      maxLiteralSize: 25 * 1024 * 1024,
    })
  }

  private createMailer (config: EmailConfig) {
    return nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPassword },
      connectionTimeout: 15000,
    })
  }

  private async send (contact: Contact, elements: Elements[]) {
    if (!this.mailer) throw new Error('Email SMTP 尚未连接')
    const text: string[] = []
    const attachments: Array<{
      filename: string
      content: Buffer
      contentType: string
      cid: string
    }> = []
    const html: string[] = []
    for (const element of elements) {
      if (element.type === 'image') {
        const image = await resolveChannelImage(element.file)
        const cid = `karin-${attachments.length}-${Date.now()}@local`
        attachments.push({
          filename: image.filename,
          content: image.buffer,
          contentType: image.mime,
          cid,
        })
        text.push(`[图片: ${image.filename}]`)
        html.push(`<img src="cid:${cid}" alt="图片">`)
        continue
      }
      const value = BuiltinChannelAdapter.text([element]).trim()
      if (value) {
        text.push(value)
        html.push(`<p>${value
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('\n', '<br>')}</p>`)
      }
    }
    if (!text.length && !attachments.length) throw new Error('Email 没有可发送的内容')
    const route = this.routes.get(contact.peer)
    const info = await this.mailer.sendMail({
      from: this.config.address,
      to: peerAddress(contact.peer),
      subject: route?.subject
        ? /^re:/i.test(route.subject) ? route.subject : `Re: ${route.subject}`
        : 'Re: Karin Agent',
      text: text.join('\n\n'),
      html: html.join(''),
      attachments,
      inReplyTo: route?.inReplyTo,
      references: route?.references,
      headers: {
        'Auto-Submitted': 'auto-generated',
        'X-Karin-Agent': this.config.id,
      },
    })
    return { messageId: String(info.messageId || Date.now()), rawData: info }
  }

  async start (config: EmailConfig) {
    this.config = config
    this.current.enabled = config.enable
    if (!config.enable) {
      this.current.state = 'disabled'
      return
    }
    if (!config.address || !config.imapHost || !config.smtpHost) {
      throw new Error('Email 地址、IMAP 或 SMTP 未配置')
    }
    this.current.state = 'connecting'
    this.imap = this.createImap(config)
    this.mailer = this.createMailer(config)
    await this.imap.connect()
    await this.imap.mailboxOpen(config.mailbox || 'INBOX')
    this.bot = new BuiltinChannelAdapter(
      this.kind,
      `email:${config.address}`,
      config.name,
      `${config.imapHost}:${config.imapPort}`,
      (contact, elements) => this.send(contact, elements)
    )
    this.bot.account.subId.channel = config.id
    this.bot.register()
    this.current.state = 'connected'
    this.current.botId = config.address
    await this.poll()
    this.poller = setInterval(() => {
      this.poll().catch(error => this.fail(error))
    }, 15000)
  }

  private fail (error: unknown) {
    this.current.state = 'error'
    this.current.lastError = redactSecrets(
      error,
      [this.config.imapPassword, this.config.smtpPassword]
    )
  }

  private async poll () {
    if (this.polling || !this.imap?.usable || !this.bot) return
    this.polling = true
    try {
      const unseen = await this.imap.search({ seen: false }, { uid: true })
      if (!unseen) return
      for (const uid of unseen.slice(-50)) {
        const message = await this.imap.fetchOne(uid, { source: true }, { uid: true })
        if (!message || !message.source) continue
        const parsed = await PostalMime.parse(message.source)
        const id = parsed.messageId || `uid:${uid}`
        await this.imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
        if (await channelStateStore.seen(`email:${this.config.id}`, id)) continue
        const from = parsed.from?.address || ''
        const headers = new Map(parsed.headers.map(header => [
          header.key.toLowerCase(),
          header.value,
        ]))
        const autoSubmitted = headers.get('auto-submitted')?.toLowerCase()
        if (
          !from ||
          from.toLowerCase() === this.config.address.toLowerCase() ||
          headers.has('x-karin-agent') ||
          (headers.has('auto-submitted') && autoSubmitted !== 'no') ||
          headers.has('x-autoreply') ||
          headers.has('x-autorespond')
        ) continue
        const elements: Elements[] = []
        const body = (parsed.text || '').trim()
        if (body) elements.push(segment.text(body))
        for (const attachment of parsed.attachments || []) {
          if (!attachment.mimeType?.startsWith('image/') || !attachment.content) continue
          elements.push(segment.image(await saveInboundChannelImage(
            'email',
            this.config.id,
            typeof attachment.content === 'string'
              ? Buffer.from(attachment.content)
              : Buffer.from(new Uint8Array(attachment.content))
          )))
        }
        if (!elements.length) continue
        const reference = parsed.inReplyTo || parsed.references?.[0] || id
        const peer = `${encodeURIComponent(from)}|${threadKey(reference)}`
        this.routes.set(peer, {
          subject: parsed.subject || '',
          inReplyTo: id,
          references: [...new Set([...(parsed.references || []), id])],
        })
        this.current.lastInbound = Date.now()
        this.bot.receive({
          eventId: `email:${id}`,
          messageId: id,
          time: parsed.date ? Date.parse(parsed.date) : Date.now(),
          scene: 'friend',
          peerId: peer,
          userId: from,
          userName: parsed.from?.name,
          contactName: parsed.subject || from,
          elements,
          raw: parsed,
        })
      }
      this.current.state = 'connected'
    } finally {
      this.polling = false
    }
  }

  async stop () {
    if (this.poller) clearInterval(this.poller)
    this.poller = null
    this.bot?.unregister()
    this.bot = null
    this.mailer?.close()
    this.mailer = null
    this.routes.clear()
    if (this.imap?.usable) await this.imap.logout()
    else this.imap?.close()
    this.imap = null
    this.current.state = 'stopped'
  }

  async probe (config: EmailConfig): Promise<ChannelProbeResult> {
    const started = Date.now()
    const imap = this.createImap(config, true)
    const mailer = this.createMailer(config)
    try {
      await Promise.all([imap.connect(), mailer.verify()])
      return {
        ok: true,
        botId: config.address,
        name: config.name,
        latency: Date.now() - started,
        detail: 'IMAP 与 SMTP 均已通过连接验证',
      }
    } finally {
      if (imap.usable) await imap.logout()
      else imap.close()
      mailer.close()
    }
  }

  status () {
    return { ...this.current }
  }
}
