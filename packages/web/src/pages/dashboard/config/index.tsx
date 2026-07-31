import { Card } from '@heroui/card'
import toast from 'react-hot-toast'
import { request } from '@/lib/request'
import { Tabs, Tab } from '@heroui/tabs'
import { Button } from '@heroui/button'
import { useParams, useNavigate } from 'react-router-dom'
import { lazy, useState, useRef, useEffect, Suspense } from 'react'
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from '@heroui/dropdown'
import {
  Settings,
  Users,
  MessageSquare,
  Palette,
  Server,
  Cpu,
  Eye,
  FoldVertical,
  RotateCw,
  Save,
  Settings2,
  Database,
} from 'lucide-react'

import type { RefObject } from 'react'

export type ConfigType =
  | 'config'
  | 'env'
  | 'groups'
  | 'privates'
  | 'render'
  | 'redis'
  | 'pm2'

interface ConfigPanelProps {
  data: unknown
  formRef: RefObject<HTMLFormElement | null>
}

type ConfigFactory = (
  data: never,
  formRef: RefObject<HTMLFormElement | null>
) => React.ReactNode

const createConfigPanel = (
  loader: () => Promise<{ default: ConfigFactory }>
) => lazy(async () => {
  const module = await loader()
  return {
    default: ({ data, formRef }: ConfigPanelProps) =>
      module.default(data as never, formRef),
  }
})

/**
 * 组件类型必须保持稳定。不要在 render 中调用 lazy()，否则 Suspense 重试会创建
 * 新组件类型并重复挂载复杂表单。
 */
const configPanels: Record<ConfigType, React.LazyExoticComponent<React.ComponentType<ConfigPanelProps>>> = {
  config: createConfigPanel(() => import('@/components/config/system/config')),
  env: createConfigPanel(() => import('@/components/config/system/env')),
  render: createConfigPanel(() => import('@/components/config/system/render')),
  redis: createConfigPanel(() => import('@/components/config/system/redis')),
  pm2: createConfigPanel(() => import('@/components/config/system/pm2')),
  groups: createConfigPanel(() => import('@/components/config/system/group')),
  privates: createConfigPanel(() => import('@/components/config/system/private')),
}

const tabItems = [
  { key: 'config', icon: Settings, label: '基本配置' },
  { key: 'env', icon: Settings2, label: '环境变量' },
  { key: 'groups', icon: Users, label: '群聊频道' },
  { key: 'privates', icon: MessageSquare, label: '好友私信' },
  { key: 'render', icon: Palette, label: '渲染器' },
  { key: 'redis', icon: Database, label: 'Redis' },
  { key: 'pm2', icon: Server, label: 'PM2' },
] satisfies Array<{ key: ConfigType; icon: React.ComponentType<{ size?: number }>; label: string }>

const configTypes = new Set<ConfigType>(tabItems.map(item => item.key))

const isConfigType = (value: string | undefined): value is ConfigType =>
  Boolean(value && configTypes.has(value as ConfigType))

const LoadingState = () => (
  <div className='flex flex-col items-center justify-center space-y-4 p-8'>
    <div className='relative h-12 w-12'>
      <div className='absolute left-0 top-0 h-full w-full animate-ping rounded-full border-4 border-primary-200 opacity-75' />
      <div className='absolute left-0 top-0 h-full w-full animate-spin rounded-full border-4 border-b-transparent border-l-transparent border-r-transparent border-t-primary-500' />
    </div>
    <p className='animate-pulse text-gray-600'>正在加载配置...</p>
  </div>
)

export default function ConfigPage () {
  const { tab } = useParams()
  const navigate = useNavigate()
  const selectedTab = isConfigType(tab) ? tab : 'config'
  const [refreshKey, setRefreshKey] = useState(0)
  const tabsContainerRef = useRef<HTMLDivElement>(null)
  const scrollPositionRef = useRef(0)
  const formRef = useRef<HTMLFormElement>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedConfig, setLoadedConfig] = useState<{
    type: ConfigType
    data: unknown
  } | null>(null)

  useEffect(() => {
    if (!isConfigType(tab)) {
      navigate('/config/config', { replace: true })
    }
  }, [navigate, tab])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)

    request.serverPost<unknown, { type: ConfigType }>('/api/v1/config/new/get', {
      type: selectedTab,
    })
      .then(data => {
        if (!active) return
        setLoadedConfig({ type: selectedTab, data })
      })
      .catch(error => {
        if (!active) return
        const message = error instanceof Error ? error.message : '加载配置失败'
        setError(message)
        toast.error(`配置加载失败: ${message}`)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [refreshKey, selectedTab])

  useEffect(() => {
    if (tabsContainerRef.current) {
      tabsContainerRef.current.scrollLeft = scrollPositionRef.current
    }
  }, [selectedTab])

  const handleTabChange = (key: string | number) => {
    if (tabsContainerRef.current) {
      scrollPositionRef.current = tabsContainerRef.current.scrollLeft
    }
    navigate(`/config/${key}`)
  }

  const handleSaveClick = () => {
    formRef.current?.requestSubmit()
  }

  const handleRefresh = () => {
    setRefreshKey(value => value + 1)
    toast.success('正在刷新配置')
  }

  const SettingsDropdownContent = () => (
    <DropdownMenu>
      <DropdownItem
        key='preview'
        startContent={<Eye size={18} />}
        onPress={() => toast.error('暂不支持预览配置')}
      >
        预览配置
      </DropdownItem>
      <DropdownItem
        key='fold'
        startContent={<FoldVertical size={18} />}
        onPress={() => toast.error('暂不支持全部折叠')}
      >
        全部折叠
      </DropdownItem>
      <DropdownItem key='refresh' startContent={<RotateCw size={18} />} onPress={handleRefresh}>
        刷新
      </DropdownItem>
    </DropdownMenu>
  )

  const SettingsButton = ({ showText = true }) => (
    <Dropdown>
      <DropdownTrigger>
        <Button
          variant='flat'
          color='primary'
          size='sm'
          startContent={<Settings2 size={18} />}
          className={!showText ? 'glass-effect min-w-0 p-2' : 'glass-effect'}
        >
          {showText ? '设置' : null}
        </Button>
      </DropdownTrigger>
      <SettingsDropdownContent />
    </Dropdown>
  )

  const SaveButton = ({ showText = true }) => (
    <Button
      color='primary'
      size='sm'
      variant='flat'
      startContent={<Save size={18} />}
      className={!showText ? 'glass-effect min-w-0 p-2' : 'glass-effect'}
      onPress={handleSaveClick}
      isDisabled={loading || loadedConfig?.type !== selectedTab}
    >
      {showText ? '保存' : null}
    </Button>
  )

  const ActionButtons = ({ showText = true }) => (
    <div className='flex shrink-0 items-center gap-2'>
      <SettingsButton showText={showText} />
      <SaveButton showText={showText} />
    </div>
  )

  const DesktopLayout = () => (
    <div className='hidden w-full items-center gap-4 md:flex'>
      <div className='flex-1 overflow-hidden'>
        <Tabs selectedKey={selectedTab} onSelectionChange={handleTabChange} className='w-full'>
          {tabItems.map(({ key, icon: Icon, label }) => (
            <Tab
              key={key}
              title={
                <div className='flex items-center gap-2 whitespace-nowrap'>
                  <Icon size={18} />
                  <span>{label}</span>
                </div>
              }
            />
          ))}
        </Tabs>
      </div>
      <ActionButtons showText />
    </div>
  )

  const MobileLayout = () => (
    <div className='flex flex-col gap-4 backdrop:blur-2xl md:hidden'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <Cpu size={24} className='text-primary-500' />
          <h2 className='text-sm font-semibold text-primary-500 lg:text-xl'>系统配置</h2>
        </div>
        <ActionButtons showText={false} />
      </div>
      <div className='w-full overflow-hidden' ref={tabsContainerRef}>
        <Tabs selectedKey={selectedTab} onSelectionChange={handleTabChange} className='w-full'>
          {tabItems.map(({ key, icon: Icon, label }) => (
            <Tab
              key={key}
              title={
                <div className='flex items-center gap-2 whitespace-nowrap'>
                  <Icon size={18} />
                  <span>{label}</span>
                </div>
              }
            />
          ))}
        </Tabs>
      </div>
    </div>
  )

  const Panel = configPanels[selectedTab]
  const canRender = !loading && !error && loadedConfig?.type === selectedTab

  return (
    <div className='space-y-4'>
      <Card className='sticky top-0 z-50 justify-center gap-2 overflow-hidden border-b border-l border-r border-t border-white/10 bg-gradient-to-br from-white/20 via-white/10 to-white/5 bg-opacity-5 p-4 shadow-2xl backdrop-blur-xl transition-all duration-500 dark:border-white/5 dark:from-white/15 dark:via-white/8 dark:to-white/3 lg:p-6 md:top-[23px] lg:top-[23px]'>
        <div className='flex flex-col gap-2'>
          <div className='hidden items-center gap-2 md:flex'>
            <Cpu size={24} className='text-primary-500' />
            <h2 className='text-xl font-semibold text-primary-500'>系统配置</h2>
          </div>
          <MobileLayout />
          <DesktopLayout />
        </div>
      </Card>

      <Card className='p-0'>
        <Suspense fallback={<LoadingState />}>
          {loading && <LoadingState />}
          {error && (
            <div className='p-4 text-danger'>
              <h3 className='font-bold'>加载失败</h3>
              <p>{error}</p>
              <Button color='primary' className='mt-4' onPress={handleRefresh}>
                重试
              </Button>
            </div>
          )}
          {canRender && (
            <Panel
              key={selectedTab}
              data={loadedConfig.data}
              formRef={formRef}
            />
          )}
        </Suspense>
      </Card>
    </div>
  )
}
