import { cacheMap } from '@/adapter/onebot/core/cache'
import { adapter } from '@/utils/config/file/adapter'
import { FeishuChannelDriver } from './feishu'
import { TelegramChannelDriver } from './telegram'
import { WeComChannelDriver } from './wecom'
import { redactChannelError } from './security'

import type { Adapters } from '@/types/config'
import type {
  ChannelDriver,
  ChannelKind,
  ChannelProbeResult,
  ChannelStatus,
} from './types'

type AnyDriver = ChannelDriver<Adapters['wecom'][number]> |
  ChannelDriver<Adapters['feishu'][number]> |
  ChannelDriver<Adapters['telegram'][number]>

const keyFor = (kind: ChannelKind, id: string) => `${kind}:${id}`

const configuredAccounts = (config: Adapters) => [
  ...config.wecom.map(account => ({ kind: 'wecom' as const, account })),
  ...config.feishu.map(account => ({ kind: 'feishu' as const, account })),
  ...config.telegram.map(account => ({ kind: 'telegram' as const, account })),
]

export class ChannelRegistry {
  private drivers = new Map<string, AnyDriver>()
  private operation = Promise.resolve()

  private create (
    kind: ChannelKind,
    account: Adapters[ChannelKind][number]
  ): AnyDriver {
    if (kind === 'wecom') {
      return new WeComChannelDriver(account as Adapters['wecom'][number])
    }
    if (kind === 'feishu') {
      return new FeishuChannelDriver(account as Adapters['feishu'][number])
    }
    return new TelegramChannelDriver(account as Adapters['telegram'][number])
  }

  async start (config = adapter()) {
    for (const { kind, account } of configuredAccounts(config)) {
      const driver = this.create(kind, account)
      this.drivers.set(keyFor(kind, account.id), driver)
      try {
        await driver.start(account as never)
      } catch (error) {
        logger.error(
          `[channel][${kind}:${account.id}] 启动失败: ${
            redactChannelError(error)
          }`
        )
      }
    }
  }

  async stop () {
    const drivers = [...this.drivers.values()]
    this.drivers.clear()
    await Promise.allSettled(drivers.map(driver => driver.stop()))
  }

  reload (config: Adapters) {
    this.operation = this.operation
      .then(async () => {
        await this.stop()
        await this.start(config)
      })
      .catch(error => logger.error(`[channel] 重载失败: ${redactChannelError(error)}`))
    return this.operation
  }

  private oneBotStatus (): ChannelStatus[] {
    return [
      {
        kind: 'onebot',
        id: 'ws-server',
        name: 'OneBot WS Server',
        enabled: adapter().onebot.ws_server.enable,
        state: cacheMap.wsServer.size ? 'connected' : 'stopped',
        botId: `${cacheMap.wsServer.size}`,
        lastInbound: null,
        lastError: '',
        reconnects: 0,
      },
      {
        kind: 'onebot',
        id: 'ws-client',
        name: 'OneBot WS Client',
        enabled: adapter().onebot.ws_client.some(item => item.enable),
        state: cacheMap.wsClient.size ? 'connected' : 'stopped',
        botId: `${cacheMap.wsClient.size}`,
        lastInbound: null,
        lastError: '',
        reconnects: 0,
      },
      {
        kind: 'onebot',
        id: 'http',
        name: 'OneBot HTTP',
        enabled: adapter().onebot.http_server.some(item => item.enable),
        state: cacheMap.http.size ? 'connected' : 'stopped',
        botId: `${cacheMap.http.size}`,
        lastInbound: null,
        lastError: '',
        reconnects: 0,
      },
    ]
  }

  status () {
    return [
      ...this.oneBotStatus(),
      ...[...this.drivers.values()].map(driver => driver.status()),
    ]
  }

  async probe (kind: ChannelKind, id: string): Promise<ChannelProbeResult> {
    const config = adapter()
    const account = config[kind].find(item => item.id === id)
    if (!account) throw new Error(`${kind} 账号不存在: ${id}`)
    return this.create(kind, account).probe(account as never)
  }

  async deleteTelegramWebhook (id: string, dropPendingUpdates = false) {
    const driver = this.drivers.get(keyFor('telegram', id))
    if (!(driver instanceof TelegramChannelDriver)) {
      const account = adapter().telegram.find(item => item.id === id)
      if (!account) throw new Error(`Telegram 账号不存在: ${id}`)
      const temporary = new TelegramChannelDriver(account)
      return temporary.deleteWebhook(dropPendingUpdates)
    }
    return driver.deleteWebhook(dropPendingUpdates)
  }
}

export const channelRegistry = new ChannelRegistry()
