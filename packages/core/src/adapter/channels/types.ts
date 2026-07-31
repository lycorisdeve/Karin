import type { Adapters } from '@/types/config'

export type ChannelKind = 'wecom' | 'feishu' | 'telegram'

export type ChannelAccountConfig =
  | Adapters['wecom'][number]
  | Adapters['feishu'][number]
  | Adapters['telegram'][number]

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
  start(config: T): Promise<void>
  stop(): Promise<void>
  probe(config: T): Promise<ChannelProbeResult>
  status(): ChannelStatus
}
