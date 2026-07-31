import { describe, expect, it, vi } from 'vitest'
import { persistAppearanceSelection } from '../../packages/web/src/theme/persistence'

import type { WebUIAppearanceConfig } from '../../packages/web/src/theme/appearance'

const appearance = (): WebUIAppearanceConfig => ({
  version: 1,
  revision: 12,
  activeThemeId: 'karin-bloom',
  mode: 'system',
  themes: [],
})

describe('WebUI appearance client persistence', () => {
  it('falls back to the latest revision PUT when an older Core returns PATCH 404', async () => {
    const current = appearance()
    const patch = vi.fn().mockResolvedValue({ status: 404 })
    const read = vi.fn().mockResolvedValue(current)
    const put = vi.fn().mockImplementation(async value => ({
      ...value,
      revision: value.revision + 1,
    }))

    const saved = await persistAppearanceSelection(
      { mode: 'dark' },
      { patch, read, put }
    )

    expect(patch).toHaveBeenCalledWith({ mode: 'dark' })
    expect(read).toHaveBeenCalledOnce()
    expect(put).toHaveBeenCalledWith({
      ...current,
      mode: 'dark',
    })
    expect(saved).toMatchObject({ revision: 13, mode: 'dark' })
  })

  it('uses PATCH directly when the running Core supports it', async () => {
    const saved = { ...appearance(), revision: 13, mode: 'dark' as const }
    const patch = vi.fn().mockResolvedValue({ status: 200, value: saved })
    const read = vi.fn()
    const put = vi.fn()

    await expect(persistAppearanceSelection(
      { mode: 'dark' },
      { patch, read, put }
    )).resolves.toEqual(saved)
    expect(read).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })
})
