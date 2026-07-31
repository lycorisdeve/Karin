import type { Adapters } from '@/types/config'

export type ChannelKind =
  | 'wecom'
  | 'feishu'
  | 'telegram'
  | 'qqbot'
  | 'wechat'
  | 'dingtalk'
  | 'discord'
  | 'whatsapp'
  | 'email'

export type ChannelAccountConfig =
  | Adapters['wecom'][number]
  | Adapters['feishu'][number]
  | Adapters['telegram'][number]
  | Adapters['qqbot'][number]
  | Adapters['wechat'][number]
  | Adapters['dingtalk'][number]
  | Adapters['discord'][number]
  | Adapters['whatsapp'][number]
  | Adapters['email'][number]

export interface ChannelStatus {
  kind: ChannelKind | 'onebot'
  id: string
  name: string
  enabled: boolean
  state: 'disabled' | 'connecting' | 'connected' | 'stopped' | 'error' | 'webhook-conflict'
  botId: string
  lastInbound: number | null
  lastError: string
  reconnects: number
}

export interface ChannelProbeResult {
  ok: boolean
  botId: string
  name: string
  latency: number
  detail?: string
}

export interface ChannelDriver<T extends ChannelAccountConfig> {
  readonly kind: ChannelKind
  readonly capabilities?: {
    text: boolean
    image: boolean
    inboundImage: boolean
  }
  start(config: T): Promise<void>
  stop(): Promise<void>
  probe(config: T): Promise<ChannelProbeResult>
  status(): ChannelStatus
}
