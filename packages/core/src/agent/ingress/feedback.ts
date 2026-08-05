import type { Message } from '@/types/event'

const nativeTimeoutMs = 500
const thinkingMessage = 'Karin Agent 正在思考中，请稍后！'

const oneBotEvent = (event: Message) =>
  event.bot?.adapter?.standard === 'onebot11' ||
  event.bot?.adapter?.protocol === 'onebot11'

const timeout = (ms: number) =>
  new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('input status timeout')), ms)
    timer.unref()
  })

export class AgentIngressFeedback {
  private stopped = false
  private nativeActive = false
  private fallbackMessageId = ''

  constructor (private readonly event: Message) {}

  start () {
    if (!oneBotEvent(this.event)) return
    this.showThinkingMessage().catch(() => undefined)

    if (!this.event.isPrivate || !this.event.bot.sendApi) return
    Promise.race([
      this.event.bot.sendApi('set_input_status', {
        user_id: Number(this.event.userId),
        typing: true,
      }),
      timeout(nativeTimeoutMs),
    ]).then(() => {
      if (this.stopped) {
        return this.setNative(false)
      }
      this.nativeActive = true
    }).catch(() => undefined)
  }

  async stop () {
    if (this.stopped) return
    this.stopped = true
    await Promise.allSettled([
      this.nativeActive ? this.setNative(false) : Promise.resolve(),
      this.fallbackMessageId
        ? this.event.bot.recallMsg(this.event.contact, this.fallbackMessageId)
        : Promise.resolve(),
    ])
  }

  private async showThinkingMessage () {
    if (this.stopped) return
    const result = await this.event.reply(thinkingMessage)
    if (this.stopped && result.messageId) {
      await this.event.bot.recallMsg(this.event.contact, result.messageId).catch(() => undefined)
      return
    }
    this.fallbackMessageId = result.messageId
  }

  private async setNative (typing: boolean) {
    if (!this.event.bot.sendApi || !this.event.isPrivate) return
    await this.event.bot.sendApi(
      'set_input_status',
      {
        user_id: Number(this.event.userId),
        typing,
      },
      nativeTimeoutMs
    ).catch(() => undefined)
    if (!typing) this.nativeActive = false
  }
}
