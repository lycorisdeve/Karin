import { describe, expect, it } from 'vitest'
import {
  builtinWebUIThemes,
  normalizeWebUIAppearance,
  patchWebUIAppearance,
} from '../../packages/core/src/utils/config/file/webui'

describe('WebUI appearance configuration', () => {
  it('always restores immutable Bloom and Classic themes', () => {
    const config = normalizeWebUIAppearance({
      version: 1,
      revision: 4,
      activeThemeId: 'karin-classic',
      mode: 'dark',
      themes: [],
    })

    expect(config.revision).toBe(4)
    expect(config.activeThemeId).toBe('karin-classic')
    expect(config.themes.map(theme => theme.id)).toEqual([
      'karin-bloom',
      'karin-classic',
    ])
    expect(config.themes.every(theme => theme.builtin)).toBe(true)
  })

  it('accepts a schema-safe custom copy without mutating builtins', () => {
    const base = builtinWebUIThemes()[0]
    const custom = {
      ...structuredClone(base),
      id: 'my-bloom',
      name: 'My Bloom',
      builtin: false,
      primary: undefined,
    }
    const config = normalizeWebUIAppearance({
      version: 1,
      revision: 1,
      activeThemeId: custom.id,
      mode: 'system',
      themes: [custom],
    })

    expect(config.activeThemeId).toBe('my-bloom')
    expect(config.themes.at(-1)).toMatchObject({
      id: 'my-bloom',
      name: 'My Bloom',
      builtin: false,
      skin: 'bloom',
    })
    expect(config.themes[0]).toEqual(base)
  })

  it('rejects builtin overrides, unsafe colors and inaccessible text', () => {
    const base = builtinWebUIThemes()[0]
    expect(() => normalizeWebUIAppearance({
      themes: [{ ...base, builtin: false }],
    })).toThrow('内置主题不可覆盖')

    expect(() => normalizeWebUIAppearance({
      themes: [{
        ...structuredClone(base),
        id: 'unsafe-theme',
        name: 'Unsafe',
        builtin: false,
        light: { ...base.light, primary: 'url(javascript:alert(1))' },
      }],
    })).toThrow('十六进制颜色')

    expect(() => normalizeWebUIAppearance({
      themes: [{
        ...structuredClone(base),
        id: 'low-contrast',
        name: 'Low Contrast',
        builtin: false,
        light: {
          ...base.light,
          foreground: '#FFFFFF',
          background: '#FFFFFF',
        },
      }],
    })).toThrow('对比度')
  })

  it('patches only the selected theme or mode and increments the revision', () => {
    const current = normalizeWebUIAppearance({
      revision: 7,
      activeThemeId: 'karin-bloom',
      mode: 'light',
      themes: [],
    })
    const next = patchWebUIAppearance(current, {
      activeThemeId: 'karin-classic',
      mode: 'dark',
    })

    expect(next).toMatchObject({
      revision: 8,
      activeThemeId: 'karin-classic',
      mode: 'dark',
    })
    expect(next.themes).toEqual(current.themes)
    expect(() => patchWebUIAppearance(current, {
      activeThemeId: 'missing-theme',
    })).toThrow('主题不存在')
  })
})
