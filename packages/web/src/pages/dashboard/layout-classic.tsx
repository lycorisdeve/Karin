import ClassicSidebar from '@/components/sidebar-classic'
import { Outlet, useLocation } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import clsx from 'clsx'
import { IoMenu } from 'react-icons/io5'
import { useMediaQuery } from 'react-responsive'
import { getPageTitle } from '@/lib/utils'
import { RiMenuUnfold2Line } from 'react-icons/ri'

const getMainPath = (pathname: string) => {
  const split = pathname.trim().split('/').filter(Boolean)
  return split.length ? `/${split[0]}` : ''
}

export default function ClassicDashboardLayout () {
  const [isOpen, setIsOpen] = useState(false)
  const isNotSmallScreen = useMediaQuery({ minWidth: 768 })
  const isMediumOrLargeScreen = useMediaQuery({ minWidth: 640 })
  const location = useLocation()
  const title = getPageTitle(location.pathname)
  const [currentMainPath, setCurrentMainPath] = useState(getMainPath(location.pathname))
  const isConfigPage = useMemo(
    () => location.pathname.startsWith('/config') || location.pathname.startsWith('/plugins/config'),
    [location.pathname]
  )
  useEffect(() => {
    if (isNotSmallScreen) setIsOpen(true)
  }, [isNotSmallScreen])

  useEffect(() => {
    setCurrentMainPath(getMainPath(location.pathname))
  }, [location])

  return (
    <div
      className='relative flex h-screen w-full overflow-hidden bg-white transition-colors duration-300 dark:bg-neutral-900'
      style={{ height: '100dvh' }}
    >
      <ClassicSidebar isOpen={isOpen} onToggle={() => setIsOpen(!isOpen)} />
      <motion.main
        style={{ touchAction: 'manipulation', WebkitOverflowScrolling: 'touch' }}
        className={clsx(
          'flex touch-auto flex-col bg-neutral-50 dark:bg-neutral-900',
          isNotSmallScreen
            ? 'flex-1 overflow-y-auto'
            : 'scrollbar-hide w-full overflow-y-auto'
        )}
        initial={false}
        animate={{
          width: isNotSmallScreen ? (isOpen ? 'calc(100% - 240px)' : '100%') : '100%',
          x: isOpen && !isNotSmallScreen ? 240 : 0,
        }}
        transition={{ type: 'tween', ease: [0, 0, 0, 1], duration: 0.3 }}
      >
        {!isNotSmallScreen && (
          <motion.div
            className={clsx(
              isConfigPage && !isMediumOrLargeScreen ? 'static' : 'sticky top-0',
              'z-40 flex min-h-10 w-full items-center justify-between border-b border-divider',
              'bg-opacity-50 px-2 py-1 shadow-sm backdrop-blur-md'
            )}
            initial={{ y: -50 }}
            animate={{ y: 0 }}
            transition={{ type: 'tween', ease: [0, 0, 0, 1], duration: 0.3 }}
          >
            <div className='flex min-w-0 items-center'>
              <motion.button
                onClick={() => setIsOpen(!isOpen)}
                className='min-w-0 rounded-md px-2 py-1.5 text-xs active:bg-default-100 dark:active:bg-default-100/10'
              >
                <div className='flex min-w-0 items-center gap-2'>
                  {isOpen
                    ? <RiMenuUnfold2Line className='h-4.5 w-4.5 shrink-0' />
                    : <IoMenu className='h-4.5 w-4.5 shrink-0' />}
                  <motion.h1 className='truncate text-sm font-medium leading-5'>
                    {title}
                  </motion.h1>
                </div>
              </motion.button>
            </div>
          </motion.div>
        )}
        <motion.div
          className={clsx(
            'container mx-auto flex-1 px-3',
            !location.pathname.startsWith('/plugins/config') && 'py-4'
          )}
          key={currentMainPath}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ type: 'tween', ease: [0, 0, 0, 1], duration: 0.3 }}
        >
          <AnimatePresence mode='popLayout'>
            <Outlet key={currentMainPath} />
          </AnimatePresence>
        </motion.div>
      </motion.main>
    </div>
  )
}
