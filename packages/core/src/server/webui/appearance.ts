import {
  saveWebUIAppearance,
  updateWebUIAppearanceSelection,
  webUIAppearanceConfig,
} from '@/utils/config/file/webui'
import {
  createBadRequestResponse,
  createResponse,
  createServerErrorResponse,
  createSuccessResponse,
  HTTPStatusCode,
} from '@/server/utils/response'

import type { RequestHandler } from 'express'
import type { WebUIAppearanceConfig } from '@/types/config'

export const getWebUIAppearance: RequestHandler = (_req, res) => {
  createSuccessResponse(res, webUIAppearanceConfig())
}

export const updateWebUIAppearance: RequestHandler = async (req, res) => {
  try {
    const body = req.body as Partial<WebUIAppearanceConfig>
    const revision = Number(body?.revision)
    if (!Number.isInteger(revision) || revision < 1) {
      return createBadRequestResponse(res, 'revision 必须是有效的正整数')
    }
    const result = await saveWebUIAppearance(body, revision)
    return createSuccessResponse(res, result, '外观设置已保存')
  } catch (error) {
    if (error instanceof Error && error.name === 'RevisionConflict') {
      return createResponse(res, HTTPStatusCode.Conflict, webUIAppearanceConfig(), error.message)
    }
    if (error instanceof Error) return createBadRequestResponse(res, error.message)
    return createServerErrorResponse(res, '保存外观设置失败')
  }
}

export const patchWebUIAppearance: RequestHandler = async (req, res) => {
  try {
    const body = req.body as Partial<WebUIAppearanceConfig>
    if (body.activeThemeId === undefined && body.mode === undefined) {
      return createBadRequestResponse(res, '至少需要提供 activeThemeId 或 mode')
    }
    const result = await updateWebUIAppearanceSelection({
      activeThemeId: body.activeThemeId,
      mode: body.mode,
    })
    return createSuccessResponse(res, result, '外观设置已保存')
  } catch (error) {
    if (error instanceof Error) return createBadRequestResponse(res, error.message)
    return createServerErrorResponse(res, '保存外观设置失败')
  }
}
