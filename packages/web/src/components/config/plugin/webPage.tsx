import { Button } from '@heroui/button'
import { Card } from '@heroui/card'
import { ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { useTheme } from '@/hooks/use-theme'
import { systemTheme } from '@/theme/appearance'

import type { GetConfigResponse, WebConfigPage } from 'node-karin'

interface PluginWebConfigPageProps {
  page: WebConfigPage
  info: GetConfigResponse['info']
}

const isExternalUrl = (url: string) => /^https?:\/\//i.test(url)

const getTargetOrigin = (url: string) => {
  if (!isExternalUrl(url)) return window.location.origin

  try {
    return new URL(url).origin
  } catch {
    return '*'
  }
}

/**
 * 插件自定义配置页面
 * @param props 页面属性
 */
export const PluginWebConfigPage = ({ page, info }: PluginWebConfigPageProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const { appearance, activeTheme, appliedTheme } = useTheme()
  const title = page.title || info.name || info.id || '插件配置'
  const description = page.description || info.description || '插件提供的自定义配置页面'
  const external = isExternalUrl(page.url)
  const legacyTheme = appearance.mode === 'system' || appliedTheme === systemTheme()
    ? 'system'
    : 'inverse'
  const palette = activeTheme[appliedTheme]

  const postTheme = useCallback(() => {
    const iframeWindow = iframeRef.current?.contentWindow
    if (!iframeWindow) return

    iframeWindow.postMessage({
      type: 'karin-theme-change',
      theme: legacyTheme,
      appliedTheme,
      mode: appearance.mode,
      themeId: activeTheme.id,
      palette,
      radius: activeTheme.radius,
      density: activeTheme.density,
      revision: appearance.revision,
    }, getTargetOrigin(page.url))
  }, [activeTheme, appearance.mode, appearance.revision, appliedTheme, legacyTheme, page.url, palette])

  useEffect(() => {
    postTheme()
  }, [postTheme])

  return (
    <div className='flex flex-col gap-1.5 sm:gap-3 h-full py-1 sm:py-4'>
      <Card shadow='sm' className='glass-effect shrink-0'>
        <div className='flex items-center justify-between gap-2 px-2.5 py-1.5 sm:gap-3 sm:p-4'>
          <div className='min-w-0'>
            <h2 className='text-sm sm:text-base font-semibold text-default-900 truncate'>
              {title}
            </h2>
            <p className='hidden sm:mt-1 sm:block text-xs text-default-500 sm:line-clamp-2'>
              {description}
            </p>
            {external && (
              <p className='hidden sm:mt-1 sm:block text-xs text-warning-600 dark:text-warning-400'>
                外部配置页面
              </p>
            )}
          </div>
          <Button
            as='a'
            href={page.url}
            target='_blank'
            rel='noopener noreferrer'
            size='sm'
            color='primary'
            variant='flat'
            className='h-8 shrink-0 px-2.5 sm:h-9 sm:px-3'
          >
            <ExternalLink size={14} aria-hidden='true' />
            <span className='sm:hidden'>打开</span>
            <span className='hidden sm:inline'>新窗口打开</span>
          </Button>
        </div>
      </Card>
      <div className='flex-1 min-h-0 overflow-hidden rounded-3xl border border-default-200 bg-background'>
        <iframe
          ref={iframeRef}
          src={page.url}
          title={title}
          className='h-full w-full border-0 bg-background'
          referrerPolicy={external ? 'strict-origin-when-cross-origin' : 'same-origin'}
          onLoad={() => {
            postTheme()
          }}
          sandbox='allow-scripts allow-same-origin allow-forms allow-popups'
        />
      </div>
    </div>
  )
}
