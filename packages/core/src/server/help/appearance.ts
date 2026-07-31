import path from 'node:path'
import {
  helpAppearance,
  helpBackground,
  resetHelpBackground,
  saveHelpAppearance,
  saveHelpBackground,
} from '@/utils/config/file/help'
import {
  createBadRequestResponse,
  createServerErrorResponse,
  createSuccessResponse,
} from '@/server/utils/response'

import type { RequestHandler } from 'express'
import type { HelpAppearanceConfig } from '@/types/config'

export const getHelpAppearance: RequestHandler = (_req, res) => {
  createSuccessResponse(res, helpAppearance())
}

export const updateHelpAppearance: RequestHandler = async (req, res) => {
  try {
    const result = await saveHelpAppearance(req.body as Partial<HelpAppearanceConfig>)
    createSuccessResponse(res, result, '帮助外观已保存')
  } catch (error) {
    createBadRequestResponse(res, (error as Error).message)
  }
}

export const uploadHelpBackground: RequestHandler = async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      return createBadRequestResponse(res, '请求体必须是图片二进制')
    }
    const result = await saveHelpBackground(req.body)
    return createSuccessResponse(res, result, '帮助背景已上传')
  } catch (error) {
    return createBadRequestResponse(res, (error as Error).message)
  }
}

export const removeHelpBackground: RequestHandler = async (_req, res) => {
  try {
    return createSuccessResponse(res, await resetHelpBackground(), '帮助背景已重置')
  } catch (error) {
    return createServerErrorResponse(res, (error as Error).message)
  }
}

export const getHelpBackground: RequestHandler = async (_req, res) => {
  try {
    const background = await helpBackground()
    if (!background) return res.status(404).end()
    res.type(background.mime)
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(background.filename)}"`)
    return res.send(background.buffer)
  } catch {
    return res.status(404).end()
  }
}
