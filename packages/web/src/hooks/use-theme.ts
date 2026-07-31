import { useThemeContext } from '@/contexts/theme'

export const useTheme = () => {
  const value = useThemeContext()
  return {
    ...value,
    theme: value.appearance.mode,
    appliedTheme: value.resolved,
    setSystemTheme: () => value.setMode('system'),
    setInverseTheme: () => value.setMode(value.isDark ? 'light' : 'dark'),
    isSystem: value.appearance.mode === 'system',
    isInverse: value.appearance.mode !== 'system',
  }
}
