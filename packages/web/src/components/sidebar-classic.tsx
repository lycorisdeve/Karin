import clsx from 'clsx'
import toast from 'react-hot-toast'
import { Button } from '@heroui/button'
import { Spinner } from '@heroui/spinner'
import { ScrollShadow } from '@heroui/scroll-shadow'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { IoMenu } from 'react-icons/io5'
import { LuLogIn } from 'react-icons/lu'
import { FaChevronRight } from 'react-icons/fa6'
import { RiMenuUnfold2Line, RiRefreshLine } from 'react-icons/ri'
import { Moon, Sun } from 'lucide-react'
import { useMediaQuery } from 'react-responsive'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from './ui/icon'
import TextPressure from './TextPressure'
import { useTheme } from '@/hooks/use-theme'
import { initSiteConfig, type SiteConfigType, defaultSiteConfig } from '@/config/site'
import useDialog from '@/hooks/use-dialog'

interface SidebarProps {
  isOpen: boolean
  onToggle: () => void
}

const menuItemVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.2 } },
  exit: { opacity: 0, x: -20, transition: { duration: 0.2 } },
}

const subMenuVariants = {
  hidden: { height: 0, opacity: 0 },
  visible: {
    height: 'auto',
    opacity: 1,
    transition: { type: 'tween', ease: [0, 0, 0, 1], duration: 0.3 },
  },
}

export default function ClassicSidebar ({ isOpen, onToggle }: SidebarProps) {
  const isNotSmallScreen = useMediaQuery({ minWidth: 768 })
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null)
  const [pluginsLoading, setPluginsLoading] = useState(true)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [siteConfigState, setSiteConfigState] = useState<SiteConfigType>({ ...defaultSiteConfig })
  const location = useLocation()
  const navigate = useNavigate()
  const { toggleTheme, isDark } = useTheme()
  const dialog = useDialog()

  const loadPlugins = useCallback(async (isRefresh = false) => {
    setPluginsLoading(true)
    try {
      setSiteConfigState(await initSiteConfig(isRefresh))
      if (isRefresh) toast.success('插件列表刷新成功')
    } catch (error) {
      toast.error('加载插件列表失败')
      console.error(error)
    } finally {
      setPluginsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPlugins()
  }, [loadPlugins])

  useEffect(() => {
    const active = siteConfigState.navItems.find(item =>
      location.pathname === item.href ||
      (item.href !== '/' && location.pathname.startsWith(`${item.href}/`)) ||
      item.children?.some(child =>
        location.pathname === child.href ||
        (!child.href.startsWith('/agent/') && location.pathname.includes(child.id))
      )
    )
    if (active?.children?.length) setExpandedMenu(active.href)
  }, [location.pathname, siteConfigState])

  const goChild = (child: NonNullable<SiteConfigType['navItems'][number]['children']>[number]) => {
    if (child.kind === 'route') navigate(child.href)
    else if (child.hasConfig) navigate(`/plugins/config?name=${child.id}`)
    else toast.error(`插件 "${child.label || child.id}" 暂未提供可配置选项`)
  }

  const signOut = () => {
    dialog.confirm({
      title: '注销',
      content: '确认注销此次登录吗？注销后需要重新登录',
      onConfirm: async () => {
        localStorage.removeItem('userId')
        localStorage.removeItem('accessToken')
        localStorage.removeItem('refreshToken')
        toast.success('退出登录成功！')
        navigate('/login')
      },
    })
  }

  return (
    <>
      <motion.div
        className={clsx(
          'fixed left-0 top-0 z-50 h-full overflow-hidden md:static',
          'rounded-r-md bg-neutral-200 dark:bg-neutral-800 md:rounded-none'
        )}
        initial={{ width: 0 }}
        animate={{ width: isOpen ? (isNotSmallScreen && isCollapsed ? 72 : 240) : 0 }}
        transition={{ type: 'tween', duration: 0.3, ease: [0, 0, 0, 1] }}
        style={{ overflow: 'hidden' }}
      >
        <motion.div
          className='flex h-full touch-none flex-col gap-6 overflow-hidden bg-neutral-100 pt-4 dark:bg-neutral-800'
          onTouchStart={event => event.stopPropagation()}
        >
          {!isCollapsed && (
            <div className='relative'>
              <TextPressure
                text='Karin!'
                alpha={false}
                stroke={false}
                weight
                italic
                strokeColor='#ff0000'
              />
            </div>
          )}

          <div
            className={clsx(
              'hide-scrollbar flex flex-1 flex-col gap-2 overflow-y-auto p-2 pt-px',
              isCollapsed ? 'px-1' : 'px-4'
            )}
          >
            <ScrollShadow hideScrollBar>
              <AnimatePresence>
                {siteConfigState.navItems.map((item, index) => {
                  const active = location.pathname === item.href ||
                    (item.href !== '/' && location.pathname.startsWith(`${item.href}/`)) ||
                    item.children?.some(child => location.pathname === child.href)
                  return (
                    <motion.div
                      key={item.href}
                      variants={menuItemVariants}
                      initial='hidden'
                      animate='visible'
                      exit='exit'
                      transition={{ delay: index * 0.05 }}
                    >
                      <div
                        className={clsx(
                          'group my-1 mb-2 block cursor-default rounded-xl text-default-600 transition-all hover:text-primary md:cursor-pointer',
                          isCollapsed ? 'mx-auto' : 'mx-1',
                          active && '!text-primary font-medium'
                        )}
                      >
                        <motion.div
                          className={clsx(
                            'relative flex items-center overflow-hidden',
                            isCollapsed ? 'justify-center py-1.5' : 'justify-between py-2.5'
                          )}
                          initial={{ paddingLeft: isCollapsed ? 0 : 16, paddingRight: isCollapsed ? 0 : 16 }}
                          animate={{ paddingLeft: isCollapsed ? 0 : 16, paddingRight: isCollapsed ? 0 : 16 }}
                          whileHover={{ x: isCollapsed ? 0 : 4 }}
                          onClick={() => {
                            if (item.groupOnly) {
                              if (isCollapsed) setIsCollapsed(false)
                              setExpandedMenu(item.href)
                              if (item.children?.[0]) navigate(item.children[0].href)
                            } else {
                              navigate(item.href)
                            }
                          }}
                          data-karin-route={item.href}
                        >
                          <div className='flex items-center gap-4'>
                            <motion.div
                              className='relative z-10 flex items-center justify-center'
                              initial={{ fontSize: isCollapsed ? '1.875rem' : '1.625rem' }}
                              animate={{ fontSize: isCollapsed ? '1.875rem' : '1.625rem' }}
                              transition={{ type: 'spring', stiffness: 300, damping: 25, duration: 0.3 }}
                              whileHover={{ scale: 1.1 }}
                            >
                              <item.Icon />
                            </motion.div>
                            {!isCollapsed && (
                              <motion.div className='relative z-10 flex items-center gap-2 overflow-hidden whitespace-nowrap text-base'>
                                <span className='select-none'>{item.label}</span>
                                {item.href === '/plugins-dashboard' && pluginsLoading && (
                                  <Spinner className='h-4 w-10 text-primary' variant='wave' size='md' />
                                )}
                              </motion.div>
                            )}
                          </div>
                          {!isCollapsed && item.children && (
                            <motion.div
                              initial={{ rotate: 0 }}
                              animate={{ rotate: expandedMenu === item.href ? 90 : 0 }}
                              transition={{ duration: 0.2 }}
                              onClick={event => {
                                event.stopPropagation()
                                setExpandedMenu(expandedMenu === item.href ? null : item.href)
                              }}
                              className='cursor-pointer p-1'
                            >
                              <FaChevronRight className='h-2.5 w-2.5' />
                            </motion.div>
                          )}
                        </motion.div>

                        {item.children && !isCollapsed && (
                          <AnimatePresence>
                            {expandedMenu === item.href && (
                              <motion.div
                                variants={subMenuVariants}
                                initial='hidden'
                                animate='visible'
                                exit='hidden'
                                className='mx-2 overflow-hidden'
                              >
                                {item.href === '/plugins-dashboard' && (
                                  <Button
                                    variant='light'
                                    size='sm'
                                    fullWidth
                                    className='mb-2 flex items-center justify-start gap-3 px-3 py-2 text-sm text-default-600 transition-transform hover:-translate-y-0.5 hover:text-primary'
                                    isDisabled={pluginsLoading}
                                    onPress={() => loadPlugins(true)}
                                  >
                                    <RiRefreshLine className={clsx('h-4 w-4', pluginsLoading && 'animate-spin text-primary')} />
                                    <span>刷新插件列表</span>
                                  </Button>
                                )}
                                {item.children.map(child => (
                                  <Fragment key={child.id}>
                                    <Button
                                      variant='light'
                                      fullWidth
                                      data-karin-route={child.href}
                                      className={clsx(
                                        'mb-2 flex items-center justify-start gap-3 px-3 py-2 text-sm text-default-600 transition-transform hover:-translate-y-0.5 hover:text-primary',
                                        location.pathname === child.href && '!text-primary glass-effect'
                                      )}
                                      onPress={() => goChild(child)}
                                    >
                                      <div className='flex items-center gap-3'>
                                        {child.Icon && <child.Icon className='h-4 w-4 shrink-0' />}
                                        {child.icon && (
                                          <Icon
                                            name={child.icon.name || ''}
                                            size={child.icon.size || 20}
                                            color={child.icon.color || 'currentColor'}
                                            className='shrink-0'
                                          />
                                        )}
                                        <span>{child.label || child.id}</span>
                                      </div>
                                    </Button>
                                  </Fragment>
                                ))}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        )}
                      </div>
                    </motion.div>
                  )
                })}
              </AnimatePresence>
            </ScrollShadow>
          </div>

          <div className={clsx(
            'mb-2 flex shrink-0 flex-col gap-4 py-2',
            isCollapsed ? 'items-center px-2' : 'px-4'
          )}
          >
            {isNotSmallScreen && (
              <Button
                variant='light'
                color='primary'
                radius='full'
                className='glass-effect flex w-full items-center justify-center gap-2'
                isIconOnly={isCollapsed}
                onPress={() => setIsCollapsed(!isCollapsed)}
              >
                {isCollapsed
                  ? <RiMenuUnfold2Line className='h-5 w-5' />
                  : <><IoMenu className='h-5 w-5' /><span>收起侧边栏</span></>}
              </Button>
            )}
            <Button
              startContent={isDark ? <Sun className='h-5 w-5' /> : <Moon className='h-5 w-5' />}
              radius='full'
              variant='light'
              color='primary'
              className='glass-effect flex w-full items-center justify-center gap-2'
              isIconOnly={isCollapsed}
              onPress={toggleTheme}
            >
              {!isCollapsed && (isDark ? '浅色模式' : '深色模式')}
            </Button>
            <Button
              startContent={<LuLogIn className='h-5 w-5' />}
              radius='full'
              variant='light'
              color='primary'
              className='glass-effect flex w-full items-center justify-center gap-2'
              isIconOnly={isCollapsed}
              onPress={signOut}
            >
              {!isCollapsed && '退出登录'}
            </Button>
          </div>
        </motion.div>
      </motion.div>

      {!isNotSmallScreen && isOpen && (
        <motion.div
          className='fixed inset-0 z-[49] touch-none'
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onToggle}
        />
      )}
    </>
  )
}
