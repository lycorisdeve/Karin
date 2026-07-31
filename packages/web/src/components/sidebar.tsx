import clsx from 'clsx'
import toast from 'react-hot-toast'
import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMediaQuery } from 'react-responsive'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Moon,
  RefreshCw,
  Sun,
  X,
} from 'lucide-react'
import { Icon } from './ui/icon'
import { useTheme } from '@/hooks/use-theme'
import { initSiteConfig, type SiteConfigType, defaultSiteConfig } from '@/config/site'
import useDialog from '@/hooks/use-dialog'
import ClassicSidebar from './sidebar-classic'

interface SidebarProps {
  isOpen: boolean
  onToggle: () => void
}

function BloomSidebar ({ isOpen, onToggle }: SidebarProps) {
  const desktop = useMediaQuery({ minWidth: 768 })
  const location = useLocation()
  const navigate = useNavigate()
  const dialog = useDialog()
  const { toggleTheme, isDark } = useTheme()
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem('karin-sidebar-collapsed') === 'true'
  )
  const [expanded, setExpanded] = useState<string | null>('/agent')
  const [loading, setLoading] = useState(false)
  const [config, setConfig] = useState<SiteConfigType>({ ...defaultSiteConfig })

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    try {
      setConfig(await initSiteConfig(refresh))
      if (refresh) toast.success('插件列表已刷新')
    } catch (error) {
      toast.error('插件列表加载失败')
      console.error(error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const active = config.navItems.find(item =>
      location.pathname === item.href ||
      (item.href !== '/' && location.pathname.startsWith(`${item.href}/`)) ||
      item.children?.some(child =>
        location.pathname === child.href ||
        (!child.href.startsWith('/agent/') && location.pathname.includes(child.id))
      )
    )
    if (active?.children?.length) setExpanded(active.href)
  }, [config.navItems, location.pathname])

  const go = (href: string) => {
    navigate(href)
    if (!desktop) onToggle()
  }

  const signOut = () => {
    dialog.confirm({
      title: '退出登录',
      content: '退出后需要重新登录 Karin WebUI。',
      onConfirm: async () => {
        localStorage.removeItem('userId')
        localStorage.removeItem('accessToken')
        localStorage.removeItem('refreshToken')
        navigate('/login')
      },
    })
  }

  if (!isOpen && !desktop) return null

  return (
    <>
      {!desktop && (
        <button
          aria-label='关闭导航'
          className='fixed inset-0 z-40 bg-[#28232d]/25 backdrop-blur-[2px]'
          onClick={onToggle}
        />
      )}
      <aside
        className={clsx(
          'karin-sidebar bloom-sidebar z-50 flex shrink-0 flex-col border border-border bg-card/90 shadow-[0_18px_55px_rgba(66,45,83,0.09)] backdrop-blur-xl',
          'transition-[width,transform,margin] duration-150 motion-reduce:transition-none',
          desktop ? 'relative m-3 mr-0 h-[calc(100dvh-1.5rem)] rounded-[24px]' : 'fixed inset-y-0 left-0 h-[100dvh] rounded-r-[24px] shadow-2xl',
          collapsed && desktop ? 'w-[76px]' : 'w-[252px]',
          !isOpen && desktop && '-ml-[252px]'
        )}
      >
        <div className='flex h-[76px] shrink-0 items-center gap-3 px-4'>
          {collapsed && desktop
            ? (
              <div className='grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary text-lg font-semibold text-primary-foreground'>
                K
              </div>
            )
            : (
              <div className='h-11 w-[92px] shrink-0 overflow-hidden'>
                <img
                  src='/web/karin.png'
                  alt='Karin'
                  className='h-full w-full scale-[1.75] object-contain dark:invert'
                />
              </div>
            )}
          {(!collapsed || !desktop) && (
            <div className='min-w-0 flex-1'>
              <div className='text-[11px] text-default-400'>和你的 Agent 一起完成事情</div>
            </div>
          )}
          {!desktop && (
            <button
              type='button'
              aria-label='关闭导航'
              className='rounded-lg p-2 text-default-500 hover:bg-default-100'
              onClick={onToggle}
            >
              <X size={18} />
            </button>
          )}
        </div>

        <nav className='karin-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2'>
          <div className='space-y-1.5'>
            {config.navItems.map(item => {
              const active = location.pathname === item.href ||
                (item.href !== '/' && location.pathname.startsWith(`${item.href}/`)) ||
                item.children?.some(child => location.pathname === child.href)
              const opened = expanded === item.href
              return (
                <div key={item.href}>
                  <div className='flex items-center gap-1'>
                    <button
                      type='button'
                      data-karin-route={item.href}
                      title={collapsed && desktop ? item.label : undefined}
                      onClick={() => {
                        if (item.groupOnly) {
                          if (collapsed && desktop) setCollapsed(false)
                          setExpanded(item.href)
                          if (item.children?.[0]) go(item.children[0].href)
                        } else {
                          go(item.href)
                        }
                      }}
                      className={clsx(
                        'group relative flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-2.5 text-sm',
                        'text-default-600 transition-colors duration-150 hover:bg-primary/8 hover:text-foreground',
                        active && 'bg-primary text-primary-foreground shadow-[0_8px_22px_rgba(107,93,211,0.2)]',
                        collapsed && desktop && 'justify-center px-2'
                      )}
                    >
                      <item.Icon className='h-[19px] w-[19px] shrink-0' />
                      {(!collapsed || !desktop) && (
                        <span className='truncate font-medium'>{item.label}</span>
                      )}
                    </button>
                    {item.children && (!collapsed || !desktop) && (
                      <button
                        type='button'
                        aria-label={opened ? '收起子菜单' : '展开子菜单'}
                        onClick={() => setExpanded(opened ? null : item.href)}
                        className='rounded-xl p-2 text-default-400 hover:bg-primary/8 hover:text-foreground'
                      >
                        <ChevronDown
                          size={14}
                          className={clsx('transition-transform duration-150', opened && 'rotate-180')}
                        />
                      </button>
                    )}
                  </div>
                  {item.children && opened && (!collapsed || !desktop) && (
                    <div className='ml-[21px] mt-1.5 border-l border-border/80 pl-4'>
                      {item.href === '/plugins-dashboard' && (
                        <button
                          type='button'
                          disabled={loading}
                          onClick={() => load(true)}
                          className='mb-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-default-400 hover:bg-primary/8 hover:text-foreground'
                        >
                          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                          刷新插件
                        </button>
                      )}
                      {item.children.map(child => {
                        const childActive = location.pathname === child.href
                        return (
                          <button
                            key={child.id}
                            type='button'
                            data-karin-route={child.href}
                            onClick={() => {
                              if (child.kind === 'route') go(child.href)
                              else if (child.hasConfig) go(`/plugins/config?name=${child.id}`)
                              else toast.error(`插件“${child.label || child.id}”没有配置页面`)
                            }}
                            className={clsx(
                              'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] text-default-500',
                              'transition-colors duration-150 hover:bg-primary/8 hover:text-foreground',
                              childActive && 'bg-primary/10 font-medium text-primary'
                            )}
                          >
                            {child.Icon && <child.Icon className='h-4 w-4 shrink-0' />}
                            {child.icon && (
                              <Icon
                                name={child.icon.name || ''}
                                size={16}
                                color={child.icon.color || 'currentColor'}
                              />
                            )}
                            <span className='truncate'>{child.label || child.id}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </nav>

        <div className='shrink-0 space-y-1.5 p-3'>
          {desktop && (
            <button
              type='button'
              onClick={() => {
                const value = !collapsed
                setCollapsed(value)
                window.localStorage.setItem('karin-sidebar-collapsed', String(value))
              }}
              className='flex w-full items-center justify-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-default-500 hover:bg-primary/8'
            >
              {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
              {!collapsed && '收起导航'}
            </button>
          )}
          <button
            type='button'
            onClick={toggleTheme}
            className='flex w-full items-center justify-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-default-500 hover:bg-primary/8'
          >
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
            {(!collapsed || !desktop) && (isDark ? '浅色模式' : '深色模式')}
          </button>
          <button
            type='button'
            onClick={signOut}
            className='flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm text-default-500 hover:bg-danger-50 hover:text-danger'
          >
            <LogOut size={17} />
            {(!collapsed || !desktop) && '退出登录'}
          </button>
        </div>
      </aside>
    </>
  )
}

export default function Sidebar (props: SidebarProps) {
  const { activeTheme } = useTheme()
  return activeTheme.skin === 'classic'
    ? <ClassicSidebar {...props} />
    : <BloomSidebar {...props} />
}
