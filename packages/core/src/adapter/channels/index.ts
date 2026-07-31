import { channelRegistry } from './registry'

export * from './types'
export * from './registry'
export * from './whatsapp'

/** 启动 Core 内置多渠道；OneBot 仍由原初始化路径管理。 */
export const initBuiltinChannels = () => channelRegistry.start()
