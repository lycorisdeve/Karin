import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyWhatsAppSignature } from '../../packages/core/src/server/channels/whatsapp'

describe('WhatsApp webhook signature', () => {
  it('accepts only the exact sha256 HMAC for the raw request body', () => {
    const secret = 'test-app-secret'
    const body = Buffer.from('{"entry":[{"id":"1"}]}')
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

    expect(verifyWhatsAppSignature(secret, body, signature)).toBe(true)
    expect(verifyWhatsAppSignature(secret, Buffer.from('{}'), signature)).toBe(false)
    expect(verifyWhatsAppSignature('', body, signature)).toBe(false)
    expect(verifyWhatsAppSignature(secret, body, 'sha1=invalid')).toBe(false)
  })
})
