import { resolveChannelImage } from '@/adapter/channels/media'

import type { AgentModelContent, AgentModelImagePart } from '@/types/agent'

const imagePart = async (value: string): Promise<AgentModelImagePart> => {
  const image = await resolveChannelImage(value)
  return {
    type: 'image',
    imageUrl: `data:${image.mime};base64,${image.buffer.toString('base64')}`,
  }
}

export const agentModelContent = async (
  text: string,
  images: string[],
  visionEnabled = true
): Promise<AgentModelContent> => {
  if (!images.length) return text
  if (!visionEnabled) {
    return `${text}\n${images.map((_, index) => `[图片 ${index + 1}：当前模型未启用视觉输入]`).join('\n')}`
  }
  const parts: Exclude<AgentModelContent, string> = []
  if (text.trim()) parts.push({ type: 'text', text })
  for (const [index, image] of images.slice(0, 4).entries()) {
    try {
      parts.push(await imagePart(image))
    } catch (error) {
      parts.push({
        type: 'text',
        text: `[图片 ${index + 1} 无法作为视觉输入：${(error as Error).message}]`,
      })
    }
  }
  return parts
}
