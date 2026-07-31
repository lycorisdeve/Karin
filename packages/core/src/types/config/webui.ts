export type WebUIColorMode = 'system' | 'light' | 'dark'
export type WebUISkin = 'bloom' | 'classic'
export type WebUIDensity = 'compact' | 'comfortable' | 'spacious'

export interface WebUIThemePalette {
  background: string
  surface: string
  elevatedSurface: string
  foreground: string
  mutedForeground: string
  border: string
  primary: string
  primaryForeground: string
  accent: string
  success: string
  warning: string
  danger: string
  codeBackground: string
}

export interface WebUIThemeDefinition {
  id: string
  name: string
  skin: WebUISkin
  builtin: boolean
  light: WebUIThemePalette
  dark: WebUIThemePalette
  radius: number
  density: WebUIDensity
}

export interface WebUIAppearanceConfig {
  version: 1
  revision: number
  activeThemeId: string
  mode: WebUIColorMode
  themes: WebUIThemeDefinition[]
}
