import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveChannelImage } from '@/adapter/channels/media'

import type { AgentMessageAttachmentInput } from '@/types/agent'
import type { AgentDatabase } from './database'

const MAX_IMAGES = 4
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

const safeExtension = (filename: string) => {
  const extension = path.extname(filename).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)
    ? extension
    : '.image'
}

export const persistAgentMessageImages = async (
  database: AgentDatabase,
  threadId: string,
  sources: string[]
): Promise<AgentMessageAttachmentInput[]> => {
  const directory = path.join(path.dirname(database.filename), 'media', threadId)
  const attachments: AgentMessageAttachmentInput[] = []
  let total = 0
  for (const source of sources.slice(0, MAX_IMAGES)) {
    try {
      const image = await resolveChannelImage(source)
      if (total + image.buffer.length > MAX_TOTAL_BYTES) break
      await fs.promises.mkdir(directory, { recursive: true })
      const storagePath = path.join(
        directory,
        `${randomUUID()}${safeExtension(image.filename)}`
      )
      await fs.promises.writeFile(storagePath, image.buffer, { flag: 'wx' })
      total += image.buffer.length
      attachments.push({
        type: 'image',
        storagePath,
        mime: image.mime,
        size: image.buffer.length,
        name: image.filename,
      })
    } catch (error) {
      logger.warn('[agent][media] 入站图片持久化失败', error)
    }
  }
  return attachments
}

export const isManagedAgentMediaPath = (
  database: AgentDatabase,
  filename: string
) => {
  const root = path.resolve(path.dirname(database.filename), 'media')
  const target = path.resolve(filename)
  return target.startsWith(`${root}${path.sep}`)
}
