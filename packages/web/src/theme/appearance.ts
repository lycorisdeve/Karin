export type WebUIColorMode = 'system' | 'light' | 'dark'
export type WebUISkin = 'bloom' | 'classic'
export type WebUIDensity = 'compact' | 'comfortable' | 'spacious'
export type ResolvedTheme = 'light' | 'dark'

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

export const bloomTheme: WebUIThemeDefinition = {
  id: 'karin-bloom',
  name: 'Karin Bloom',
  skin: 'bloom',
  builtin: true,
  light: {
    background: '#FFF8F6',
    surface: '#FFFFFF',
    elevatedSurface: '#FFFFFF',
    foreground: '#28232D',
    mutedForeground: '#746B78',
    border: '#E8DDE1',
    primary: '#6B5DD3',
    primaryForeground: '#FFFFFF',
    accent: '#ED7894',
    success: '#2E9B7D',
    warning: '#D98B2B',
    danger: '#D9576C',
    codeBackground: '#F4EEF1',
  },
  dark: {
    background: '#18151D',
    surface: '#221E29',
    elevatedSurface: '#2A2532',
    foreground: '#F7EFF3',
    mutedForeground: '#B8ADB7',
    border: '#39313F',
    primary: '#A89AF1',
    primaryForeground: '#18151D',
    accent: '#FF91AB',
    success: '#65C6A9',
    warning: '#F0B15B',
    danger: '#F17C8E',
    codeBackground: '#131017',
  },
  radius: 18,
  density: 'comfortable',
}

export const classicTheme: WebUIThemeDefinition = {
  id: 'karin-classic',
  name: 'Karin Classic',
  skin: 'classic',
  builtin: true,
  light: {
    background: '#FFFFFF',
    surface: '#FFFFFF',
    elevatedSurface: '#FFFFFF',
    foreground: '#0A0A0A',
    mutedForeground: '#737373',
    border: '#E5E5E5',
    primary: '#18181B',
    primaryForeground: '#FAFAFA',
    accent: '#F5F5F5',
    success: '#17C964',
    warning: '#F5A524',
    danger: '#F31260',
    codeBackground: '#F5F5F5',
  },
  dark: {
    background: '#0A0A0A',
    surface: '#0A0A0A',
    elevatedSurface: '#171717',
    foreground: '#FAFAFA',
    mutedForeground: '#A3A3A3',
    border: '#262626',
    primary: '#FAFAFA',
    primaryForeground: '#18181B',
    accent: '#262626',
    success: '#17C964',
    warning: '#F5A524',
    danger: '#F31260',
    codeBackground: '#171717',
  },
  radius: 8,
  density: 'comfortable',
}

export const defaultAppearance: WebUIAppearanceConfig = {
  version: 1,
  revision: 1,
  activeThemeId: bloomTheme.id,
  mode: 'system',
  themes: [bloomTheme, classicTheme],
}

export const appearanceCacheKey = 'karin-webui-appearance'

export const readAppearanceCache = (): WebUIAppearanceConfig => {
  try {
    const value = JSON.parse(localStorage.getItem(appearanceCacheKey) || 'null')
    if (value?.version === 1 && Array.isArray(value.themes)) return value
  } catch {
    // 使用内置安全默认值
  }
  return structuredClone(defaultAppearance)
}

export const systemTheme = (): ResolvedTheme =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

export const resolveColorMode = (mode: WebUIColorMode): ResolvedTheme =>
  mode === 'system' ? systemTheme() : mode

export const activeThemeOf = (appearance: WebUIAppearanceConfig) =>
  appearance.themes.find(theme => theme.id === appearance.activeThemeId) ||
  appearance.themes.find(theme => theme.id === bloomTheme.id) ||
  bloomTheme

const hexPart = (value: string, offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16)

export const hexToHsl = (hex: string) => {
  const red = hexPart(hex, 1) / 255
  const green = hexPart(hex, 3) / 255
  const blue = hexPart(hex, 5) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  if (max === min) return `0 0% ${Math.round(lightness * 10000) / 100}%`
  const delta = max - min
  const saturation = lightness > 0.5
    ? delta / (2 - max - min)
    : delta / (max + min)
  let hue = 0
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0)
  else if (max === green) hue = (blue - red) / delta + 2
  else hue = (red - green) / delta + 4
  hue /= 6
  return `${Math.round(hue * 36000) / 100} ${Math.round(saturation * 10000) / 100}% ${Math.round(lightness * 10000) / 100}%`
}

const mix = (left: string, right: string, amount: number) => {
  const channel = (offset: number) => Math.round(
    hexPart(left, offset) * (1 - amount) + hexPart(right, offset) * amount
  ).toString(16).padStart(2, '0')
  return `#${channel(1)}${channel(3)}${channel(5)}`.toUpperCase()
}

const setScale = (
  root: HTMLElement,
  name: string,
  color: string,
  background: string,
  foreground: string
) => {
  const steps = [0.92, 0.84, 0.68, 0.5, 0.24, 0, 0.12, 0.28, 0.44, 0.62]
  steps.forEach((amount, index) => {
    const shade = index < 5
      ? mix(color, background, amount)
      : index === 5
        ? color
        : mix(color, foreground, amount)
    root.style.setProperty(`--heroui-${name}-${(index + 1) * 50}`, hexToHsl(shade))
  })
  root.style.setProperty(`--heroui-${name}`, hexToHsl(color))
}

const semanticProperties = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
]

const heroScales = ['primary', 'secondary', 'success', 'warning', 'danger', 'default']

const directProperties = [
  '--radius',
  '--theme-accent',
  '--theme-code',
  '--theme-surface-elevated',
  '--heroui-background',
  '--heroui-foreground',
  '--heroui-content1',
  '--heroui-content1-foreground',
  '--heroui-content2',
  '--heroui-content2-foreground',
  '--heroui-primary-foreground',
]

const clearAppearanceProperties = (root: HTMLElement) => {
  semanticProperties.forEach(name => root.style.removeProperty(`--${name}`))
  directProperties.forEach(name => root.style.removeProperty(name))
  heroScales.forEach(name => {
    root.style.removeProperty(`--heroui-${name}`)
    for (let shade = 50; shade <= 500; shade += 50) {
      root.style.removeProperty(`--heroui-${name}-${shade}`)
    }
  })
}

export const applyAppearance = (
  appearance: WebUIAppearanceConfig,
  forcedMode?: ResolvedTheme
) => {
  const root = document.documentElement
  const theme = activeThemeOf(appearance)
  const resolved = forcedMode || resolveColorMode(appearance.mode)
  const palette = theme[resolved]
  clearAppearanceProperties(root)
  root.classList.remove('light', 'dark')
  root.classList.add(resolved)
  root.dataset.theme = resolved
  root.dataset.themeId = theme.id
  root.dataset.skin = theme.skin

  if (theme.id === classicTheme.id && theme.builtin) {
    delete root.dataset.density
    return { theme, resolved, palette }
  }

  root.dataset.density = theme.density

  const values: Record<string, string> = {
    background: palette.background,
    foreground: palette.foreground,
    card: palette.surface,
    'card-foreground': palette.foreground,
    popover: palette.elevatedSurface,
    'popover-foreground': palette.foreground,
    primary: palette.primary,
    'primary-foreground': palette.primaryForeground,
    secondary: mix(palette.accent, palette.background, 0.82),
    'secondary-foreground': palette.foreground,
    muted: mix(palette.foreground, palette.background, 0.92),
    'muted-foreground': palette.mutedForeground,
    accent: mix(palette.accent, palette.background, 0.84),
    'accent-foreground': palette.foreground,
    destructive: palette.danger,
    'destructive-foreground': '#FFFFFF',
    border: palette.border,
    input: palette.border,
    ring: palette.primary,
  }
  Object.entries(values).forEach(([name, value]) => {
    root.style.setProperty(`--${name}`, hexToHsl(value))
  })
  root.style.setProperty('--radius', `${theme.radius / 16}rem`)
  root.style.setProperty('--theme-accent', palette.accent)
  root.style.setProperty('--theme-code', palette.codeBackground)
  root.style.setProperty('--theme-surface-elevated', palette.elevatedSurface)

  root.style.setProperty('--heroui-background', hexToHsl(palette.background))
  root.style.setProperty('--heroui-foreground', hexToHsl(palette.foreground))
  root.style.setProperty('--heroui-content1', hexToHsl(palette.surface))
  root.style.setProperty('--heroui-content1-foreground', hexToHsl(palette.foreground))
  root.style.setProperty('--heroui-content2', hexToHsl(palette.elevatedSurface))
  root.style.setProperty('--heroui-content2-foreground', hexToHsl(palette.foreground))
  root.style.setProperty('--heroui-primary-foreground', hexToHsl(palette.primaryForeground))
  setScale(root, 'primary', palette.primary, palette.background, palette.foreground)
  setScale(root, 'secondary', palette.accent, palette.background, palette.foreground)
  setScale(root, 'success', palette.success, palette.background, palette.foreground)
  setScale(root, 'warning', palette.warning, palette.background, palette.foreground)
  setScale(root, 'danger', palette.danger, palette.background, palette.foreground)
  setScale(root, 'default', palette.mutedForeground, palette.background, palette.foreground)

  return { theme, resolved, palette }
}
