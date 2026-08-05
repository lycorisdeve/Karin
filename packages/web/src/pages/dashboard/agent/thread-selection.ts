import type { AgentMessage, AgentThread } from '@/request/agent'

export const threadSelectionKey = 'karin.agent.chat.selection.v1'

const channelNames: Record<string, string> = {
  onebot: 'OneBot',
  telegram: 'Telegram',
  wecom: '企业微信',
  feishu: '飞书',
  qqbot: 'QQBot',
  wechat: '个人微信',
  dingtalk: '钉钉',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  email: 'Email',
  web: '网页',
}

export interface ThreadSelection {
  channel: string
  threadId?: string
  rootId?: string
}

export type ThreadSelections = Partial<Record<'active' | 'archived', ThreadSelection>>

type SelectionStorage = Pick<Storage, 'getItem' | 'setItem'>

export const readThreadSelections = (
  storage: SelectionStorage = localStorage
): ThreadSelections => {
  try {
    return JSON.parse(storage.getItem(threadSelectionKey) || '{}') as ThreadSelections
  } catch {
    return {}
  }
}

export const writeThreadSelection = (
  state: 'active' | 'archived',
  selection: ThreadSelection,
  storage: SelectionStorage = localStorage
) => {
  try {
    storage.setItem(
      threadSelectionKey,
      JSON.stringify({ ...readThreadSelections(storage), [state]: selection })
    )
  } catch {
    // 浏览器禁用存储时仍可使用会话选择器。
  }
}

export const channelName = (channel: string) =>
  channelNames[channel] || channel || '未知渠道'

export const threadName = (thread: AgentThread) =>
  thread.title ||
  thread.contactName ||
  [thread.scene, thread.contactId].filter(Boolean).join(' · ') ||
  thread.threadKey

export const isRenderableChatMessage = (message: AgentMessage) =>
  message.role !== 'tool' &&
  (message.role !== 'assistant' || message.final !== false) &&
  (Boolean(message.content.trim()) || Boolean(message.attachments?.length))

export const restoredThreadRoot = (
  threads: AgentThread[],
  saved?: ThreadSelection
) => threads.find(item => item.id === saved?.rootId) ||
  threads.find(item => item.id === saved?.threadId) ||
  threads[0]
