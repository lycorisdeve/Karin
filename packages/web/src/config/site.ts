import {
  RiArchiveFill,
  RiBrainFill,
  RiCalendarEventFill,
  RiChat3Fill,
  RiFileList3Fill,
  RiRobot2Fill,
  RiSettings2Fill,
  RiShieldCheckFill,
  RiSparkling2Fill,
  RiToolsFill,
  RiUserSettingsFill,
} from 'react-icons/ri'
import { BsInfoCircleFill } from 'react-icons/bs'
import {
  MdSpaceDashboard,
  MdCable,
  MdExtension,
  MdPalette,
  MdOutlineArticle, // 系统日志
  MdOutlineTerminal, // 仿真终端
} from 'react-icons/md'
import type { FrontendInstalledPluginListResponse } from 'node-karin'
import { getFrontendInstalledPluginListRequest } from '@/request/plugins'

export interface NavItem {
  Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  label: string
  href: string
  groupOnly?: boolean
  children?: {
    id: string
    href: string
    label?: string
    icon?: FrontendInstalledPluginListResponse['icon']
    Icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>
    kind?: 'route' | 'plugin'
    type?: 'git' | 'npm' | 'app'
    hasConfig?: boolean
  }[]
}

export interface SiteConfigType {
  name: string
  description: string
  navItems: NavItem[]
}

export const defaultSiteConfig: SiteConfigType = {
  name: 'Karin WebUI',
  description: 'Karin WebUI.',
  navItems: [
    {
      Icon: MdSpaceDashboard,
      label: '基础信息',
      href: '/',
    },
    {
      Icon: RiSettings2Fill,
      label: '系统配置',
      href: '/config',
      groupOnly: true,
      children: [
        {
          id: 'common-config',
          href: '/config/config',
          label: '常用配置',
          Icon: RiSettings2Fill,
          kind: 'route',
        },
        {
          id: 'adapter-config',
          href: '/config/adapter',
          label: '适配器配置',
          Icon: MdCable,
          kind: 'route',
        },
        {
          id: 'appearance',
          href: '/appearance',
          label: '外观与主题',
          Icon: MdPalette,
          kind: 'route',
        },
      ],
    },
    {
      Icon: RiRobot2Fill,
      label: 'Karin Agent',
      href: '/agent',
      children: [
        { id: 'agent-chat', href: '/agent/chat', label: '对话', Icon: RiChat3Fill, kind: 'route' },
        { id: 'agent-tasks', href: '/agent/tasks', label: '定时任务', Icon: RiCalendarEventFill, kind: 'route' },
        { id: 'agent-skills', href: '/agent/skills', label: 'Skills 管理', Icon: RiBrainFill, kind: 'route' },
        { id: 'agent-memories', href: '/agent/memories', label: '记忆管理', Icon: RiArchiveFill, kind: 'route' },
        { id: 'agent-evolution', href: '/agent/evolution', label: '进化中心', Icon: RiSparkling2Fill, kind: 'route' },
        { id: 'agent-tools', href: '/agent/tools', label: 'Tools 管理', Icon: RiToolsFill, kind: 'route' },
        { id: 'agent-mcp', href: '/agent/mcp', label: 'MCP 服务', Icon: MdCable, kind: 'route' },
        { id: 'agent-approvals', href: '/agent/approvals', label: '审批中心', Icon: RiShieldCheckFill, kind: 'route' },
        { id: 'agent-runs', href: '/agent/runs', label: '运行记录', Icon: RiFileList3Fill, kind: 'route' },
        { id: 'agent-customization', href: '/agent/customization', label: '指令与人物', Icon: RiUserSettingsFill, kind: 'route' },
        { id: 'agent-config', href: '/agent/config', label: '配置管理', Icon: RiSettings2Fill, kind: 'route' },
      ],
    },
    {
      Icon: MdExtension,
      label: '插件管理',
      href: '/plugins-dashboard',
      children: [],
    },
    {
      Icon: MdOutlineTerminal,
      label: '仿真终端',
      href: '/terminal',
    },
    {
      Icon: MdOutlineArticle,
      label: '系统日志',
      href: '/log',
    },
    {
      Icon: BsInfoCircleFill,
      label: '关于我们',
      href: '/about',
    },
  ],
}

export const siteConfig: SiteConfigType = { ...defaultSiteConfig }

/**
 * 获取已安装的插件列表
 * @param isRefresh 是否刷新缓存
 */
const getInstalledPlugins = async (isRefresh = false) => {
  const list = await getFrontendInstalledPluginListRequest(isRefresh)
  return list.map((item) => ({
    id: item.id,
    label: item.name,
    href: `/plugins/${item.id}`,
    icon: item.icon,
    type: item.type,
    hasConfig: item.hasConfig,
  }))
}

/**
 * 初始化插件配置
 * @param isRefresh 是否刷新缓存
 * @returns 更新后的站点配置对象
 */
export const initSiteConfig = async (isRefresh = false) => {
  // 获取插件列表并添加到侧边栏的"插件管理"菜单中
  const plugins = await getInstalledPlugins(isRefresh)

  // 创建一个新的配置对象，避免直接修改共享状态
  const updatedConfig = {
    ...siteConfig,
    navItems: siteConfig.navItems.map(item => {
      // 如果是插件管理菜单项
      if (item.href === '/plugins-dashboard' && plugins.length > 0) {
        return {
          ...item,
          children: plugins
            .map(plugin => ({
              id: plugin.id,
              href: plugin.href,
              label: plugin.label,
              icon: plugin.icon!,
              kind: 'plugin' as const,
              type: plugin.type,
              hasConfig: plugin.hasConfig,
            }))
            .sort((a, b) => {
              // 优先显示可配置的插件
              if (a.hasConfig && !b.hasConfig) return -1
              if (!a.hasConfig && b.hasConfig) return 1
              // 然后按名称排序
              return (a.label || a.id).localeCompare(b.label || b.id)
            }),
        }
      }
      return { ...item }
    }),
  }

  // 更新共享配置对象
  Object.assign(siteConfig, updatedConfig)

  console.log(siteConfig)
  return updatedConfig
}
