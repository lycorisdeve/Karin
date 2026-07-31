import { Toaster as HotToaster } from 'react-hot-toast'
import { useTheme } from '@/hooks/use-theme'

export const Toaster = () => {
  const { activeTheme, appliedTheme } = useTheme()
  const palette = activeTheme[appliedTheme]

  return (
    <HotToaster
      toastOptions={{
        style: {
          borderRadius: '20px',
          background: palette.elevatedSurface,
          color: palette.foreground,
          border: `1px solid ${palette.border}`,
          zIndex: 10000,
        },
      }}
      containerStyle={{
        zIndex: 10000,
      }}
    />
  )
}

export default Toaster
