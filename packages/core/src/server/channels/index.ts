import { Router } from 'express'
import { channelRegistry } from '@/adapter/channels'
import { redactChannelError } from '@/adapter/channels/security'
import {
  createBadRequestResponse,
  createServerErrorResponse,
  createSuccessResponse,
} from '@/server/utils/response'

import type { ChannelKind } from '@/adapter/channels'

export const channelsRouter: Router = Router()

channelsRouter.get('/status', (_req, res) => {
  createSuccessResponse(res, channelRegistry.status())
})

channelsRouter.post('/probe', async (req, res) => {
  try {
    const { kind, id } = req.body as { kind?: ChannelKind, id?: string }
    if (!kind || !['wecom', 'feishu', 'telegram'].includes(kind) || !id) {
      return createBadRequestResponse(res, 'kind/id 无效')
    }
    createSuccessResponse(res, await channelRegistry.probe(kind, id))
  } catch (error) {
    createServerErrorResponse(res, redactChannelError(error))
  }
})

channelsRouter.post('/reload', async (_req, res) => {
  try {
    const { adapter } = await import('@/utils/config/file/adapter')
    await channelRegistry.reload(adapter())
    createSuccessResponse(res, channelRegistry.status())
  } catch (error) {
    createServerErrorResponse(res, redactChannelError(error))
  }
})

channelsRouter.post('/telegram/delete-webhook', async (req, res) => {
  try {
    const { id, dropPendingUpdates } = req.body as {
      id?: string
      dropPendingUpdates?: boolean
    }
    if (!id) return createBadRequestResponse(res, 'id 无效')
    const result = await channelRegistry.deleteTelegramWebhook(id, dropPendingUpdates)
    createSuccessResponse(res, { deleted: result })
  } catch (error) {
    createServerErrorResponse(res, redactChannelError(error))
  }
})
