import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Command, Menu, Search, X } from 'lucide-react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useMediaQuery } from 'react-responsive'
import Sidebar from '@/components/sidebar'
import { getPageTitle } from '@/lib/utils'
import { siteConfig } from '@/config/site'
import { useTheme } from '@/hooks/use-theme'
import ClassicDashboardLayout from './layout-classic'

function BloomDashboardLayout () {
  const desktop = useMediaQuery({ minWidth: 768 })
  const [isOpen, setIsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [query, setQuery] = useState('')
  const location = useLocation()
  const navigate = useNavigate()
  const searchRef = useRef<HTMLInputElement>(null)
  const title = getPageTitle(location.pathname)
  const fullHeight = (
    location.pathname === '/agent/chat' ||
    location.pathname === '/terminal' ||
    location.pathname === '/log'
  )
  const wide = location.pathname.startsWith('/agent') ||
    location.pathname.startsWith('/plugins/config')

  useEffect(() => {
    setIsOpen(desktop)
  }, [desktop])

  useEffect(() => {
    const open = () => setPaletteOpen(true)
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(value => !value)
      }
      if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('karin:command-palette', open)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('karin:command-palette', open)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    if (!paletteOpen) return
    setQuery('')
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [paletteOpen])

  const destinations = useMemo(() => siteConfig.navItems.flatMap(item => [
    { label: item.label, href: item.href },
    ...(item.children ?? []).map(child => ({
      label: `${item.label} / ${child.label ?? child.id}`,
      href: child.href,
    })),
  ]), [])
  const matches = destinations.filter(item =>
    `${item.label} ${item.href}`.toLowerCase().includes(query.trim().toLowerCase())
  ).slice(0, 12)

  const go = (href: string) => {
    navigate(href)
    setPaletteOpen(false)
  }

  return (
    <div className='flex h-[100dvh] w-full overflow-hidden bg-background text-foreground'>
      <Sidebar isOpen={isOpen} onToggle={() => setIsOpen(value => !value)} />
      <main className='flex min-w-0 flex-1 flex-col overflow-hidden'>
        <header className='flex h-[72px] shrink-0 items-center gap-3 px-4 md:px-7'>
          {!desktop && (
            <button
              type='button'
              aria-label='打开导航'
              onClick={() => setIsOpen(true)}
              className='rounded-2xl p-2.5 text-default-500 hover:bg-primary/8'
            >
              <Menu size={19} />
            </button>
          )}
          <div className='min-w-0 flex-1'>
            <div className='truncate text-lg font-semibold tracking-[-0.025em]'>{title}</div>
          </div>
          <button
            type='button'
            className='hidden min-w-[240px] items-center gap-2 rounded-2xl bg-card/80 px-4 py-2.5 text-left text-xs text-default-400 shadow-sm ring-1 ring-border/70 lg:flex'
            onClick={() => window.dispatchEvent(new CustomEvent('karin:command-palette'))}
          >
            <Search size={14} />
            搜索设置、插件和 Agent
            <kbd className='ml-auto rounded border border-border bg-card px-1.5 font-mono'>⌘K</kbd>
          </button>
        </header>
        <div
          className={clsx(
            'min-h-0 flex-1',
            fullHeight
              ? 'overflow-hidden px-3 pb-3 md:px-5 md:pb-5'
              : 'karin-scrollbar overflow-y-auto px-4 pb-6 md:px-7 md:pb-8',
            !wide && !fullHeight && 'mx-auto w-full max-w-[1480px]'
          )}
        >
          <Outlet />
        </div>
      </main>
      {paletteOpen && (
        <div
          className='fixed inset-0 z-[100] flex justify-center bg-[#28232d]/30 px-4 pt-[12vh] backdrop-blur-sm'
          role='dialog'
          aria-modal='true'
          aria-label='全局导航'
          onMouseDown={event => {
            if (event.currentTarget === event.target) setPaletteOpen(false)
          }}
        >
          <div className='h-fit w-full max-w-xl overflow-hidden rounded-[24px] border border-border bg-card shadow-2xl'>
            <div className='flex items-center gap-3 border-b border-border px-4 py-3'>
              <Search size={17} className='text-primary' />
              <input
                ref={searchRef}
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && matches[0]) go(matches[0].href)
                }}
                placeholder='搜索页面、Agent 能力或插件入口'
                className='min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-default-400'
              />
              <button
                type='button'
                aria-label='关闭'
                className='rounded-lg p-1.5 text-default-400 hover:bg-default-100'
                onClick={() => setPaletteOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className='karin-scrollbar max-h-[420px] overflow-y-auto p-2'>
              {matches.length
                ? matches.map(item => (
                  <button
                    key={`${item.href}-${item.label}`}
                    type='button'
                    onClick={() => go(item.href)}
                    className='group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-default-100'
                  >
                    <span className='grid size-8 place-items-center rounded-lg border border-border bg-default-50 text-default-500 group-hover:text-primary'>
                      <Command size={14} />
                    </span>
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate text-sm font-medium'>{item.label}</span>
                      <span className='block truncate font-mono text-[10px] text-default-400'>{item.href}</span>
                    </span>
                  </button>
                ))
                : (
                  <div className='px-4 py-10 text-center text-sm text-default-400'>
                    没有匹配的页面
                  </div>
                )}
            </div>
            <div className='border-t border-border px-4 py-2 text-[10px] text-default-400'>
              <kbd className='font-mono'>Enter</kbd> 打开首项 · <kbd className='font-mono'>Esc</kbd> 关闭
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function DashboardLayout () {
  const { activeTheme } = useTheme()
  return activeTheme.skin === 'classic'
    ? <ClassicDashboardLayout />
    : <BloomDashboardLayout />
}
