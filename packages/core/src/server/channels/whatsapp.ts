import { createHmac, timingSafeEqual } from 'node:crypto'
import { Router, raw } from 'express'
import { channelRegistry } from '@/adapter/channels'
import { adapter } from '@/utils/config/file/adapter'
import { redactChannelError } from '@/adapter/channels/security'

export const verifyWhatsAppSignature = (
  secret: string,
  body: Buffer,
  header: string
) => {
  if (!secret || !header.startsWith('sha256=')) return false
  const actual = Buffer.from(header.slice(7), 'hex')
  const expected = createHmac('sha256', secret).update(body).digest()
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export const whatsappWebhookRouter: Router = Router()

whatsappWebhookRouter.get('/:id/webhook', (req, res) => {
  const account = adapter().whatsapp.find(item => item.id === req.params.id && item.enable)
  const mode = String(req.query['hub.mode'] || '')
  const token = String(req.query['hub.verify_token'] || '')
  const challenge = String(req.query['hub.challenge'] || '')
  if (!account || mode !== 'subscribe' || !account.verifyToken || token !== account.verifyToken) {
    return res.status(403).send('Forbidden')
  }
  res.status(200).send(challenge)
})

whatsappWebhookRouter.post(
  '/:id/webhook',
  raw({ type: 'application/json', limit: '25mb' }),
  async (req, res) => {
    const id = req.params.id
    const account = adapter().whatsapp.find(item => item.id === id && item.enable)
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const signature = String(req.header('x-hub-signature-256') || '')
    if (!account || !verifyWhatsAppSignature(account.appSecret, body, signature)) {
      return res.status(403).send('Forbidden')
    }
    try {
      const payload = JSON.parse(body.toString('utf8')) as unknown
      await channelRegistry.receiveWhatsAppWebhook(id, payload)
      res.sendStatus(200)
    } catch (error) {
      channelRegistry.reportWhatsAppWebhookError(id, error)
      logger.error(`[channel][whatsapp:${id}] ${redactChannelError(error)}`)
      res.sendStatus(500)
    }
  }
)
