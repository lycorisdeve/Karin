import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { request } from '@/lib/request'
import {
  activeThemeOf,
  appearanceCacheKey,
  applyAppearance,
  readAppearanceCache,
  resolveColorMode,
} from '@/theme/appearance'
import { persistAppearanceSelection } from '@/theme/persistence'

import type {
  ResolvedTheme,
  WebUIAppearanceConfig,
  WebUIColorMode,
} from '@/theme/appearance'
import type { ServerResponse } from '@/types/server'

interface ThemeContextValue {
  appearance: WebUIAppearanceConfig
  activeTheme: ReturnType<typeof activeThemeOf>
  resolved: ResolvedTheme
  isDark: boolean
  isLight: boolean
  previewAppearance: (appearance: WebUIAppearanceConfig) => void
  cancelPreview: () => void
  saveAppearance: (appearance: WebUIAppearanceConfig) => Promise<WebUIAppearanceConfig>
  setActiveTheme: (id: string) => Promise<WebUIAppearanceConfig>
  setMode: (mode: WebUIColorMode) => Promise<WebUIAppearanceConfig>
  toggleTheme: () => Promise<WebUIAppearanceConfig>
  refreshAppearance: () => Promise<void>
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const fetchAppearance = async () => {
  const response = await fetch('/api/v1/webui/appearance', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('读取主题配置失败')
  const body = await response.json() as ServerResponse<WebUIAppearanceConfig>
  return body.data
}

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const [saved, setSaved] = useState<WebUIAppearanceConfig>(readAppearanceCache)
  const [appearance, setAppearance] = useState<WebUIAppearanceConfig>(readAppearanceCache)
  const [resolved, setResolved] = useState<ResolvedTheme>(
    () => resolveColorMode(readAppearanceCache().mode)
  )
  const isPreviewing = useRef(false)

  const apply = useCallback((next: WebUIAppearanceConfig) => {
    const result = applyAppearance(next)
    setAppearance(next)
    setResolved(result.resolved)
  }, [])

  const acceptSaved = useCallback((next: WebUIAppearanceConfig) => {
    isPreviewing.current = false
    localStorage.setItem(appearanceCacheKey, JSON.stringify(next))
    setSaved(next)
    apply(next)
  }, [apply])

  const refreshAppearance = useCallback(async () => {
    if (isPreviewing.current) return
    try {
      const next = await fetchAppearance()
      if (!isPreviewing.current) acceptSaved(next)
    } catch {
      if (!isPreviewing.current) apply(saved)
    }
  }, [acceptSaved, apply, saved])

  useEffect(() => {
    apply(saved)
    refreshAppearance()
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleMedia = () => {
      if (appearance.mode !== 'system') return
      const result = applyAppearance(appearance)
      setResolved(result.resolved)
    }
    const handleFocus = () => {
      refreshAppearance()
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== appearanceCacheKey || !event.newValue) return
      if (isPreviewing.current) return
      try {
        acceptSaved(JSON.parse(event.newValue) as WebUIAppearanceConfig)
      } catch {
        // 忽略损坏缓存
      }
    }
    media.addEventListener('change', handleMedia)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('storage', handleStorage)
    return () => {
      media.removeEventListener('change', handleMedia)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('storage', handleStorage)
    }
  }, [acceptSaved, appearance, refreshAppearance])

  const previewAppearance = useCallback((next: WebUIAppearanceConfig) => {
    isPreviewing.current = true
    apply(next)
  }, [apply])

  const cancelPreview = useCallback(() => {
    isPreviewing.current = false
    apply(saved)
  }, [apply, saved])

  const saveAppearance = useCallback(async (next: WebUIAppearanceConfig) => {
    const response = await request.put<ServerResponse<WebUIAppearanceConfig>>(
      '/api/v1/webui/appearance',
      next
    )
    const value = response.data.data
    acceptSaved(value)
    return value
  }, [acceptSaved])

  const patchAppearance = useCallback(async (
    patch: Pick<Partial<WebUIAppearanceConfig>, 'activeThemeId' | 'mode'>
  ) => {
    const previous = saved
    const optimistic = { ...saved, ...patch }
    apply(optimistic)
    try {
      const value = await persistAppearanceSelection(patch, {
        patch: async selection => {
          const response = await request.patch<ServerResponse<WebUIAppearanceConfig>>(
            '/api/v1/webui/appearance',
            selection,
            {
              validateStatus: status =>
                (status >= 200 && status < 300) || status === 404,
            }
          )
          return {
            status: response.status,
            value: response.status === 404 ? undefined : response.data.data,
          }
        },
        read: fetchAppearance,
        put: async appearance => {
          const response = await request.put<ServerResponse<WebUIAppearanceConfig>>(
            '/api/v1/webui/appearance',
            appearance
          )
          return response.data.data
        },
      })
      acceptSaved(value)
      return value
    } catch (error) {
      acceptSaved(previous)
      throw error
    }
  }, [acceptSaved, apply, saved])

  const setActiveTheme = useCallback(
    (activeThemeId: string) => patchAppearance({ activeThemeId }),
    [patchAppearance]
  )

  const setMode = useCallback(async (mode: WebUIColorMode) => {
    return patchAppearance({ mode })
  }, [patchAppearance])

  const value = useMemo<ThemeContextValue>(() => ({
    appearance,
    activeTheme: activeThemeOf(appearance),
    resolved,
    isDark: resolved === 'dark',
    isLight: resolved === 'light',
    previewAppearance,
    cancelPreview,
    saveAppearance,
    setActiveTheme,
    setMode,
    toggleTheme: () => setMode(resolved === 'dark' ? 'light' : 'dark'),
    refreshAppearance,
  }), [
    appearance,
    cancelPreview,
    previewAppearance,
    refreshAppearance,
    resolved,
    saveAppearance,
    setActiveTheme,
    setMode,
  ])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useThemeContext = () => {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return value
}
