import { describe, expect, it, vi } from 'vitest'

import { authMiddleware } from '../../packages/core/src/server/auth/middleware'
import { auth } from '../../packages/core/src/server/common/common'

import type { NextFunction, Request, Response } from 'express'

vi.mock('@/server/common/common', () => ({
  auth: {
    getAuth: vi.fn(async () => true),
    postAuth: vi.fn(async () => true),
  },
}))

describe('server auth write methods', () => {
  it.each(['PATCH', 'DELETE', 'PUT'])('authenticates %s as a write request', async method => {
    const next = vi.fn() as NextFunction
    await authMiddleware(
      { method, path: '/agent/threads/thread' } as Request,
      {} as Response,
      next
    )

    expect(auth.postAuth).toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })
})
