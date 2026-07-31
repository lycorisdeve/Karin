import type { WebUIAppearanceConfig } from './appearance'

export type WebUIAppearanceSelectionPatch = Pick<
  Partial<WebUIAppearanceConfig>,
  'activeThemeId' | 'mode'
>

export interface WebUIAppearancePersistenceTransport {
  patch: (
    patch: WebUIAppearanceSelectionPatch
  ) => Promise<{ status: number, value?: WebUIAppearanceConfig }>
  read: () => Promise<WebUIAppearanceConfig>
  put: (appearance: WebUIAppearanceConfig) => Promise<WebUIAppearanceConfig>
}

export const persistAppearanceSelection = async (
  patch: WebUIAppearanceSelectionPatch,
  transport: WebUIAppearancePersistenceTransport
) => {
  const response = await transport.patch(patch)
  if (response.status !== 404) {
    if (!response.value) throw new Error('服务端未返回主题配置')
    return response.value
  }

  const latest = await transport.read()
  return transport.put({ ...latest, ...patch })
}
