import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@heroui/button'
import { Card } from '@heroui/card'
import { Divider } from '@heroui/divider'
import { Input } from '@heroui/input'
import { Spinner } from '@heroui/spinner'
import { Switch } from '@heroui/switch'
import {
  Bot,
  Building2,
  CheckCircle2,
  CircleOff,
  ExternalLink,
  MessageCircle,
  Network,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Send,
  Server,
  Terminal,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react'
import {
  Controller,
  FormProvider,
  useFieldArray,
  useForm,
  useWatch,
} from 'react-hook-form'
import toast from 'react-hot-toast'
import { request } from '@/lib/request'
import {
  toAdapterConfig,
  toAdapterFormValues,
  validateAdapterConfig,
} from './adapter-model'

import type { FieldPath } from 'react-hook-form'
import type { AdapterFormValues } from './adapter-model'
import type { Adapters } from 'node-karin'
import ExtendedAdapters from './extended-adapters'
import type { ExtendedChannelKind } from './extended-adapters'

type AdapterSection = 'console' | 'onebot' | 'wecom' | 'feishu' | 'telegram' | 'extended'

interface ChannelStatus {
  kind: 'onebot' | 'wecom' | 'feishu' | 'telegram' | ExtendedChannelKind
  id: string
  name: string
  state: string
  botId: string
  lastInbound: number | null
  lastError: string
  reconnects: number
}

interface SectionDefinition {
  key: AdapterSection
  label: string
  description: string
  Icon: React.ComponentType<{ className?: string; size?: number }>
}

const sections: SectionDefinition[] = [
  {
    key: 'console',
    label: 'Console',
    description: '资源地址与访问验证',
    Icon: Terminal,
  },
  {
    key: 'onebot',
    label: 'OneBot',
    description: '保留现有 WS 与 HTTP 连接',
    Icon: Bot,
  },
  {
    key: 'wecom',
    label: '企业微信',
    description: '智能机器人长连接',
    Icon: Building2,
  },
  {
    key: 'feishu',
    label: '飞书 / Lark',
    description: '官方 SDK 长连接',
    Icon: MessageCircle,
  },
  {
    key: 'telegram',
    label: 'Telegram',
    description: 'Bot API Long Polling',
    Icon: Send,
  },
  {
    key: 'extended',
    label: '更多渠道',
    description: 'QQ、微信、钉钉、Discord、WhatsApp、Email',
    Icon: MessageCircle,
  },
]

const splitCommaList = (value: string) =>
  value.split(',').map(item => item.trim()).filter(Boolean)

const stateLabel = (state: string) => {
  if (state === 'connected') return '已连接'
  if (state === 'connecting') return '连接中'
  if (state === 'error') return '异常'
  if (state === 'stopped') return '未运行'
  return state || '未知'
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败'

const StatusPill = ({ status }: { status?: ChannelStatus }) => {
  const connected = status?.state === 'connected'
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium',
        connected
          ? 'bg-success-50 text-success-700'
          : 'bg-default-100 text-default-500',
      ].join(' ')}
    >
      {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
      {status ? stateLabel(status.state) : '未配置'}
    </span>
  )
}

export default function AdapterConfigPage () {
  const methods = useForm<AdapterFormValues>({
    defaultValues: {
      console: {
        isLocal: true,
        token: '',
        protocol: 'http',
        host: '',
      },
      onebot: {
        ws_server: { enable: false, timeout: 120 },
        ws_client: [],
        http_server: [],
      },
      wecom: [],
      feishu: [],
      telegram: [],
      qqbot: [],
      wechat: [],
      dingtalk: [],
      discord: [],
      whatsapp: [],
      email: [],
    },
  })
  const { control, register, reset, handleSubmit, formState } = methods
  const wsClients = useFieldArray({
    control,
    name: 'onebot.ws_client',
    keyName: '_formKey',
  })
  const httpServers = useFieldArray({
    control,
    name: 'onebot.http_server',
    keyName: '_formKey',
  })
  const wecomFields = useFieldArray({
    control,
    name: 'wecom',
    keyName: '_formKey',
  })
  const feishuFields = useFieldArray({
    control,
    name: 'feishu',
    keyName: '_formKey',
  })
  const telegramFields = useFieldArray({
    control,
    name: 'telegram',
    keyName: '_formKey',
  })

  const [section, setSection] = useState<AdapterSection>('console')
  const [statuses, setStatuses] = useState<ChannelStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selectedAccounts, setSelectedAccounts] = useState<
    Partial<Record<'wecom' | 'feishu' | 'telegram', string>>
  >({})

  const consoleConfig = useWatch({ control, name: 'console' })
  const onebotConfig = useWatch({ control, name: 'onebot' })
  const wecomAccounts = useWatch({ control, name: 'wecom' }) ?? []
  const feishuAccounts = useWatch({ control, name: 'feishu' }) ?? []
  const telegramAccounts = useWatch({ control, name: 'telegram' }) ?? []
  const extendedAccounts = {
    qqbot: useWatch({ control, name: 'qqbot' }) ?? [],
    wechat: useWatch({ control, name: 'wechat' }) ?? [],
    dingtalk: useWatch({ control, name: 'dingtalk' }) ?? [],
    discord: useWatch({ control, name: 'discord' }) ?? [],
    whatsapp: useWatch({ control, name: 'whatsapp' }) ?? [],
    email: useWatch({ control, name: 'email' }) ?? [],
  }

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    const next = await request.serverGet<ChannelStatus[]>(
      '/api/v1/channels/status',
      { signal }
    )
    if (!signal?.aborted) setStatuses(next)
    return next
  }, [])

  const loadConfig = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setLoadError('')
    try {
      const data = await request.serverPost<Adapters, { type: 'adapter' }>(
        '/api/v1/config/new/get',
        { type: 'adapter' },
        { signal }
      )
      if (signal?.aborted) return
      const values = toAdapterFormValues(data)
      reset(values)
      setSelectedAccounts({
        wecom: values.wecom[0]?.id,
        feishu: values.feishu[0]?.id,
        telegram: values.telegram[0]?.id,
      })
      await refreshStatus(signal)
    } catch (error) {
      if (signal?.aborted) return
      const message = errorMessage(error)
      setLoadError(message)
      toast.error(`适配器配置加载失败：${message}`)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [refreshStatus, reset])

  useEffect(() => {
    const controller = new AbortController()
    loadConfig(controller.signal)
    return () => controller.abort()
  }, [loadConfig])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!formState.isDirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    const handleRouteClick = (event: MouseEvent) => {
      if (!formState.isDirty) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('[data-karin-route]')) return
      if (window.confirm('适配器配置尚未保存，确定离开当前页面吗？')) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('click', handleRouteClick, true)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      document.removeEventListener('click', handleRouteClick, true)
    }
  }, [formState.isDirty])

  const statusBy = useCallback((kind: ChannelStatus['kind'], id: string) =>
    statuses.find(status => status.kind === kind && status.id === id),
  [statuses])

  const sectionStats = useMemo(() => {
    const countConnected = (kind: ChannelStatus['kind']) =>
      statuses.filter(status => status.kind === kind && status.state === 'connected').length
    return {
      console: {
        count: 1,
        enabled: consoleConfig?.isLocal === false || Boolean(consoleConfig?.host),
        connected: 0,
      },
      onebot: {
        count: 1 + (onebotConfig?.ws_client.length ?? 0) + (onebotConfig?.http_server.length ?? 0),
        enabled: Boolean(
          onebotConfig?.ws_server.enable ||
          onebotConfig?.ws_client.some(item => item.enable) ||
          onebotConfig?.http_server.some(item => item.enable)
        ),
        connected: countConnected('onebot'),
      },
      wecom: {
        count: wecomAccounts.length,
        enabled: wecomAccounts.some(account => account.enable),
        connected: countConnected('wecom'),
      },
      feishu: {
        count: feishuAccounts.length,
        enabled: feishuAccounts.some(account => account.enable),
        connected: countConnected('feishu'),
      },
      telegram: {
        count: telegramAccounts.length,
        enabled: telegramAccounts.some(account => account.enable),
        connected: countConnected('telegram'),
      },
      extended: {
        count: Object.values(extendedAccounts).reduce(
          (total, accounts) => total + accounts.length,
          0
        ),
        enabled: Object.values(extendedAccounts).some(accounts =>
          accounts.some(account => account.enable)
        ),
        connected: (Object.keys(extendedAccounts) as ExtendedChannelKind[])
          .reduce((total, kind) => total + countConnected(kind), 0),
      },
    }
  }, [
    consoleConfig,
    feishuAccounts,
    onebotConfig,
    statuses,
    telegramAccounts,
    wecomAccounts,
    extendedAccounts,
  ])

  const save = handleSubmit(async values => {
    const validation = validateAdapterConfig(values)
    if (validation) {
      toast.error(validation)
      return
    }
    setSaving(true)
    try {
      const response = await request.serverPost<
        string,
        { type: 'adapter'; data: Adapters }
      >('/api/v1/config/new/save', {
        type: 'adapter',
        data: toAdapterConfig(values),
      })
      toast.success(response)
      await loadConfig()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  })

  const reloadChannels = async () => {
    setReloading(true)
    try {
      const next = await request.serverPost<ChannelStatus[], Record<string, never>>(
        '/api/v1/channels/reload',
        {}
      )
      setStatuses(next)
      toast.success('已重新加载保存的渠道配置')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setReloading(false)
    }
  }

  const probe = async (
    kind: 'wecom' | 'feishu' | 'telegram' | ExtendedChannelKind,
    id: string
  ) => {
    try {
      const result = await request.serverPost<
        { ok: boolean; name: string; latency: number; detail?: string },
        { kind: typeof kind; id: string }
      >('/api/v1/channels/probe', { kind, id })
      if (result.ok) toast.success(`${result.name} 连接正常 · ${result.latency}ms`)
      else toast.error(`${result.name}：${result.detail || '连接不可用'}`)
      await refreshStatus()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const confirmRemove = (
    label: string,
    remove: (index: number) => void,
    index: number,
    kind?: 'wecom' | 'feishu' | 'telegram'
  ) => {
    if (!window.confirm(`确定删除“${label}”吗？保存后该配置将被永久移除。`)) return
    remove(index)
    if (kind) {
      setSelectedAccounts(current => ({ ...current, [kind]: undefined }))
    }
  }

  const switchField = (
    name: FieldPath<AdapterFormValues>,
    label: string,
    description?: string,
    color: 'success' | 'danger' | 'warning' = 'success'
  ) => (
    <Controller
      control={control}
      name={name}
      render={({ field }) => {
        const handleValueChange = (value: boolean) => field.onChange(value)
        return (
          <Switch
            isSelected={Boolean(field.value)}
            onValueChange={handleValueChange}
            color={color}
          >
            <span className='flex flex-col'>
              <span className='text-sm font-medium'>{label}</span>
              {description && <span className='text-xs text-default-400'>{description}</span>}
            </span>
          </Switch>
        )
      }}
    />
  )

  const commaListField = (
    name: FieldPath<AdapterFormValues>,
    label: string,
    description: string
  ) => (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <Input
          label={label}
          description={description}
          value={Array.isArray(field.value) ? field.value.join(', ') : ''}
          onValueChange={value => field.onChange(splitCommaList(value))}
        />
      )}
    />
  )

  const renderConsole = () => (
    <div className='space-y-5'>
      <div>
        <p className='text-sm font-semibold'>资源访问</p>
        <p className='mt-1 text-xs text-default-400'>
          控制 Karin 生成的资源链接是否只允许本机访问。
        </p>
      </div>
      <div className='rounded-2xl border border-default-200 bg-default-50/60 p-4'>
        {switchField(
          'console.isLocal',
          '只允许本地访问',
          '启用后，仅允许 127.0.0.1 访问资源文件'
        )}
      </div>
      <div className='grid gap-4 md:grid-cols-2'>
        <Input
          label='资源文件访问地址'
          description='本地模式下可留空'
          placeholder='127.0.0.1:7777'
          {...register('console.host')}
          startContent={
            <Controller
              control={control}
              name='console.protocol'
              render={({ field }) => {
                const handleProtocolChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
                  field.onChange(event)
                }
                return (
                  <select
                    aria-label='资源协议'
                    className='border-0 bg-transparent text-small text-primary outline-none'
                    value={field.value}
                    onChange={handleProtocolChange}
                  >
                    <option value='http'>http://</option>
                    <option value='https'>https://</option>
                  </select>
                )
              }}
            />
          }
        />
        <Input
          type='password'
          label='访问 Token'
          description='允许外部访问时必填'
          autoComplete='new-password'
          {...register('console.token')}
        />
      </div>
    </div>
  )

  const renderOneBot = () => (
    <div className='space-y-6'>
      <div className='rounded-2xl border border-default-200 bg-default-50/60 p-4'>
        <div className='grid gap-4 md:grid-cols-[1fr_220px] md:items-center'>
          {switchField(
            'onebot.ws_server.enable',
            '反向 WebSocket 服务器',
            '继续使用 Karin 当前 HTTP 端口接收 OneBot 连接'
          )}
          <Input
            type='number'
            label='请求超时（秒）'
            {...register('onebot.ws_server.timeout', { valueAsNumber: true })}
          />
        </div>
        <p className='mt-3 text-xs text-default-400'>
          WebSocket Server 鉴权密钥仍在环境变量配置中管理。
        </p>
      </div>

      <div className='space-y-3'>
        <div className='flex items-center justify-between gap-3'>
          <div>
            <p className='flex items-center gap-2 text-sm font-semibold'>
              <Network size={16} /> 正向 WebSocket 客户端
            </p>
            <p className='mt-1 text-xs text-default-400'>连接 OneBot 协议端提供的 WS API。</p>
          </div>
          <Button
            size='sm'
            variant='flat'
            color='primary'
            startContent={<Plus size={15} />}
            onPress={() => wsClients.append({ enable: false, url: '', token: '' })}
          >
            添加连接
          </Button>
        </div>
        {wsClients.fields.length === 0 && (
          <div className='rounded-2xl border border-dashed border-default-200 px-4 py-8 text-center text-sm text-default-400'>
            尚未配置正向 WebSocket 客户端
          </div>
        )}
        {wsClients.fields.map((field, index) => (
          <Card key={field._formKey} className='space-y-4 border border-default-200 p-4 shadow-none'>
            <div className='flex items-center justify-between gap-3'>
              {switchField(`onebot.ws_client.${index}.enable`, `WebSocket 客户端 ${index + 1}`)}
              <Button
                isIconOnly
                size='sm'
                variant='light'
                color='danger'
                aria-label={`删除 WebSocket 客户端 ${index + 1}`}
                onPress={() => confirmRemove(
                  `WebSocket 客户端 ${index + 1}`,
                  wsClients.remove,
                  index
                )}
              >
                <Trash2 size={16} />
              </Button>
            </div>
            <div className='grid gap-4 md:grid-cols-2'>
              <Input
                label='WebSocket 地址'
                placeholder='ws://127.0.0.1:6099'
                {...register(`onebot.ws_client.${index}.url`)}
              />
              <Input
                type='password'
                label='鉴权 Token'
                placeholder='协议端未设置时可留空'
                autoComplete='new-password'
                {...register(`onebot.ws_client.${index}.token`)}
              />
            </div>
          </Card>
        ))}
      </div>

      <Divider />

      <div className='space-y-3'>
        <div className='flex items-center justify-between gap-3'>
          <div>
            <p className='flex items-center gap-2 text-sm font-semibold'>
              <Server size={16} /> HTTP 服务端
            </p>
            <p className='mt-1 text-xs text-default-400'>
              接收 OneBot HTTP 事件并调用协议端 API。
            </p>
          </div>
          <Button
            size='sm'
            variant='flat'
            color='primary'
            startContent={<Plus size={15} />}
            onPress={() => httpServers.append({
              enable: false,
              self_id: 'default',
              url: '',
              token: '',
              api_token: '',
              post_token: '',
            })}
          >
            添加连接
          </Button>
        </div>
        {httpServers.fields.length === 0 && (
          <div className='rounded-2xl border border-dashed border-default-200 px-4 py-8 text-center text-sm text-default-400'>
            尚未配置 OneBot HTTP 服务端
          </div>
        )}
        {httpServers.fields.map((field, index) => (
          <Card key={field._formKey} className='space-y-4 border border-default-200 p-4 shadow-none'>
            <div className='flex items-center justify-between gap-3'>
              {switchField(`onebot.http_server.${index}.enable`, `HTTP 服务端 ${index + 1}`)}
              <Button
                isIconOnly
                size='sm'
                variant='light'
                color='danger'
                aria-label={`删除 HTTP 服务端 ${index + 1}`}
                onPress={() => confirmRemove(
                  `HTTP 服务端 ${index + 1}`,
                  httpServers.remove,
                  index
                )}
              >
                <Trash2 size={16} />
              </Button>
            </div>
            <div className='grid gap-4 md:grid-cols-2'>
              <Input
                label='Bot ID'
                {...register(`onebot.http_server.${index}.self_id`)}
              />
              <Input
                label='HTTP API 地址'
                placeholder='http://127.0.0.1:6099'
                {...register(`onebot.http_server.${index}.url`)}
              />
              <Input
                type='password'
                label='API Token'
                autoComplete='new-password'
                {...register(`onebot.http_server.${index}.api_token`)}
              />
              <Input
                type='password'
                label='事件上报 Token'
                autoComplete='new-password'
                {...register(`onebot.http_server.${index}.post_token`)}
              />
            </div>
          </Card>
        ))}
      </div>
    </div>
  )

  const accountList = (
    kind: 'wecom' | 'feishu' | 'telegram',
    accounts: Array<{ id: string; name: string; enable: boolean }>,
    add: () => void
  ) => (
    <div className='space-y-2'>
      <Button
        fullWidth
        size='sm'
        variant='flat'
        color='primary'
        startContent={<Plus size={15} />}
        onPress={add}
      >
        添加账号
      </Button>
      {accounts.length === 0 && (
        <div className='rounded-xl border border-dashed border-default-200 px-3 py-8 text-center text-xs text-default-400'>
          暂无账号
        </div>
      )}
      {accounts.map(account => {
        const selected = (selectedAccounts[kind] ?? accounts[0]?.id) === account.id
        const status = statusBy(kind, account.id)
        return (
          <button
            type='button'
            key={account.id}
            onClick={() => setSelectedAccounts(current => ({
              ...current,
              [kind]: account.id,
            }))}
            className={[
              'w-full rounded-xl border px-3 py-3 text-left transition-colors',
              selected
                ? 'border-primary bg-primary-50/70'
                : 'border-default-200 bg-content1 hover:bg-default-50',
            ].join(' ')}
          >
            <span className='flex items-center justify-between gap-2'>
              <span className='truncate text-sm font-medium'>{account.name || account.id}</span>
              <span className={`size-2 rounded-full ${account.enable ? 'bg-success' : 'bg-default-300'}`} />
            </span>
            <span className='mt-2 flex items-center justify-between gap-2'>
              <span className='truncate font-mono text-[10px] text-default-400'>{account.id}</span>
              <span className='text-[10px] text-default-400'>
                {status ? stateLabel(status.state) : '未运行'}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )

  const accountStatusPanel = (
    kind: 'wecom' | 'feishu' | 'telegram',
    id: string
  ) => {
    const status = statusBy(kind, id)
    return (
      <div className='flex flex-wrap items-center gap-2 rounded-xl border border-default-200 bg-default-50/60 px-3 py-2'>
        <StatusPill status={status} />
        {status?.botId && (
          <span className='font-mono text-[11px] text-default-500'>Bot {status.botId}</span>
        )}
        <span className='text-[11px] text-default-400'>
          重连 {status?.reconnects ?? 0}
        </span>
        {status?.lastError && (
          <span className='min-w-0 flex-1 truncate text-right text-[11px] text-danger'>
            {status.lastError}
          </span>
        )}
      </div>
    )
  }

  const renderWeCom = () => {
    const selectedId = selectedAccounts.wecom ?? wecomAccounts[0]?.id
    const index = wecomAccounts.findIndex(account => account.id === selectedId)
    const account = index >= 0 ? wecomAccounts[index] : undefined
    return (
      <div className='grid gap-4 xl:grid-cols-[230px_minmax(0,1fr)]'>
        {accountList('wecom', wecomAccounts, () => {
          const id = `wecom-${crypto.randomUUID().slice(0, 8)}`
          wecomFields.append({
            id,
            name: '企业微信机器人',
            enable: false,
            botId: '',
            secret: '',
            wsUrl: '',
            reconnectInterval: 5000,
            maxReconnectAttempts: 20,
            trigger: { wakeWords: [] },
          })
          setSelectedAccounts(current => ({ ...current, wecom: id }))
        })}
        {!account
          ? (
            <div className='grid min-h-72 place-items-center rounded-2xl border border-dashed border-default-200 text-sm text-default-400'>
              添加账号后在这里配置企业微信机器人
            </div>
          )
          : (
            <div className='space-y-4'>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <p className='font-semibold'>{account.name || account.id}</p>
                  <p className='text-xs text-default-400'>企业微信智能机器人 WebSocket 长连接</p>
                </div>
                <Button
                  isIconOnly
                  variant='light'
                  color='danger'
                  aria-label='删除企业微信账号'
                  onPress={() => confirmRemove(
                    account.name || account.id,
                    wecomFields.remove,
                    index,
                    'wecom'
                  )}
                >
                  <Trash2 size={17} />
                </Button>
              </div>
              {accountStatusPanel('wecom', account.id)}
              <div className='rounded-2xl border border-default-200 p-4'>
                <div className='mb-4'>
                  {switchField(`wecom.${index}.enable`, '启用账号')}
                </div>
                <div className='grid gap-4 md:grid-cols-2'>
                  <Input label='显示名称' {...register(`wecom.${index}.name`)} />
                  <Input label='稳定 ID' isReadOnly {...register(`wecom.${index}.id`)} />
                  <Input label='Bot ID' {...register(`wecom.${index}.botId`)} />
                  <Input
                    type='password'
                    label='Secret'
                    placeholder={account.secretConfigured ? '已配置，留空保持不变' : '请输入 Secret'}
                    description={account.secretConfigured ? '已配置' : '未配置'}
                    autoComplete='new-password'
                    {...register(`wecom.${index}.secret`)}
                  />
                  <Input
                    label='WebSocket URL'
                    placeholder='留空使用官方地址'
                    {...register(`wecom.${index}.wsUrl`)}
                  />
                  <Input
                    type='number'
                    label='重连间隔（ms）'
                    {...register(`wecom.${index}.reconnectInterval`, { valueAsNumber: true })}
                  />
                  <Input
                    type='number'
                    label='最大重连次数'
                    {...register(`wecom.${index}.maxReconnectAttempts`, { valueAsNumber: true })}
                  />
                  {commaListField(
                    `wecom.${index}.trigger.wakeWords`,
                    '群聊唤醒词',
                    '使用逗号分隔，平台 @ 仍然有效'
                  )}
                </div>
                <div className='mt-4 flex flex-wrap items-center justify-between gap-3'>
                  {switchField(
                    `wecom.${index}.clearSecret`,
                    '保存时清除 Secret',
                    undefined,
                    'danger'
                  )}
                  <Button
                    size='sm'
                    variant='flat'
                    color='primary'
                    startContent={<Wifi size={15} />}
                    onPress={() => probe('wecom', account.id)}
                  >
                    测试已保存连接
                  </Button>
                </div>
              </div>
            </div>
          )}
      </div>
    )
  }

  const renderFeishu = () => {
    const selectedId = selectedAccounts.feishu ?? feishuAccounts[0]?.id
    const index = feishuAccounts.findIndex(account => account.id === selectedId)
    const account = index >= 0 ? feishuAccounts[index] : undefined
    return (
      <div className='grid gap-4 xl:grid-cols-[230px_minmax(0,1fr)]'>
        {accountList('feishu', feishuAccounts, () => {
          const id = `feishu-${crypto.randomUUID().slice(0, 8)}`
          feishuFields.append({
            id,
            name: '飞书机器人',
            enable: false,
            appId: '',
            appSecret: '',
            domain: 'feishu',
            reconnectInterval: 5000,
            maxReconnectAttempts: 20,
            trigger: { wakeWords: [] },
          })
          setSelectedAccounts(current => ({ ...current, feishu: id }))
        })}
        {!account
          ? (
            <div className='grid min-h-72 place-items-center rounded-2xl border border-dashed border-default-200 text-sm text-default-400'>
              添加账号后在这里配置飞书或 Lark
            </div>
          )
          : (
            <div className='space-y-4'>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <p className='font-semibold'>{account.name || account.id}</p>
                  <p className='text-xs text-default-400'>订阅 im.message.receive_v1 事件</p>
                </div>
                <Button
                  isIconOnly
                  variant='light'
                  color='danger'
                  aria-label='删除飞书账号'
                  onPress={() => confirmRemove(
                    account.name || account.id,
                    feishuFields.remove,
                    index,
                    'feishu'
                  )}
                >
                  <Trash2 size={17} />
                </Button>
              </div>
              {accountStatusPanel('feishu', account.id)}
              <div className='rounded-2xl border border-default-200 p-4'>
                <div className='mb-4'>
                  {switchField(`feishu.${index}.enable`, '启用账号')}
                </div>
                <div className='grid gap-4 md:grid-cols-2'>
                  <Input label='显示名称' {...register(`feishu.${index}.name`)} />
                  <Input label='稳定 ID' isReadOnly {...register(`feishu.${index}.id`)} />
                  <Input label='App ID' {...register(`feishu.${index}.appId`)} />
                  <Input
                    type='password'
                    label='App Secret'
                    placeholder={account.appSecretConfigured ? '已配置，留空保持不变' : '请输入 App Secret'}
                    description={account.appSecretConfigured ? '已配置' : '未配置'}
                    autoComplete='new-password'
                    {...register(`feishu.${index}.appSecret`)}
                  />
                  <label className='text-xs text-default-500'>
                    服务域名
                    <select
                      {...register(`feishu.${index}.domain`)}
                      className='mt-1.5 w-full rounded-xl border border-default-200 bg-default-50 px-3 py-3 text-sm outline-none focus:border-primary'
                    >
                      <option value='feishu'>飞书</option>
                      <option value='lark'>Lark</option>
                    </select>
                  </label>
                  <Input
                    type='number'
                    label='重连间隔（ms）'
                    {...register(`feishu.${index}.reconnectInterval`, { valueAsNumber: true })}
                  />
                  <Input
                    type='number'
                    label='最大重连次数'
                    {...register(`feishu.${index}.maxReconnectAttempts`, { valueAsNumber: true })}
                  />
                  {commaListField(
                    `feishu.${index}.trigger.wakeWords`,
                    '群聊唤醒词',
                    '使用逗号分隔，平台 @ 仍然有效'
                  )}
                </div>
                <div className='mt-4 flex flex-wrap items-center justify-between gap-3'>
                  {switchField(
                    `feishu.${index}.clearSecret`,
                    '保存时清除 App Secret',
                    undefined,
                    'danger'
                  )}
                  <Button
                    size='sm'
                    variant='flat'
                    color='primary'
                    startContent={<Wifi size={15} />}
                    onPress={() => probe('feishu', account.id)}
                  >
                    测试已保存连接
                  </Button>
                </div>
              </div>
            </div>
          )}
      </div>
    )
  }

  const renderTelegram = () => {
    const selectedId = selectedAccounts.telegram ?? telegramAccounts[0]?.id
    const index = telegramAccounts.findIndex(account => account.id === selectedId)
    const account = index >= 0 ? telegramAccounts[index] : undefined
    return (
      <div className='grid gap-4 xl:grid-cols-[230px_minmax(0,1fr)]'>
        {accountList('telegram', telegramAccounts, () => {
          const id = `telegram-${crypto.randomUUID().slice(0, 8)}`
          telegramFields.append({
            id,
            name: 'Telegram Bot',
            enable: false,
            botToken: '',
            apiBase: 'https://api.telegram.org',
            pollTimeout: 30,
            allowedUpdates: ['message'],
            trigger: { wakeWords: [] },
          })
          setSelectedAccounts(current => ({ ...current, telegram: id }))
        })}
        {!account
          ? (
            <div className='grid min-h-72 place-items-center rounded-2xl border border-dashed border-default-200 text-sm text-default-400'>
              添加账号后在这里配置 Telegram Bot
            </div>
          )
          : (
            <div className='space-y-4'>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <p className='font-semibold'>{account.name || account.id}</p>
                  <p className='text-xs text-default-400'>Telegram Bot API Long Polling</p>
                </div>
                <Button
                  isIconOnly
                  variant='light'
                  color='danger'
                  aria-label='删除 Telegram 账号'
                  onPress={() => confirmRemove(
                    account.name || account.id,
                    telegramFields.remove,
                    index,
                    'telegram'
                  )}
                >
                  <Trash2 size={17} />
                </Button>
              </div>
              {accountStatusPanel('telegram', account.id)}
              <div className='rounded-2xl border border-default-200 p-4'>
                <div className='mb-4'>
                  {switchField(`telegram.${index}.enable`, '启用账号')}
                </div>
                <div className='grid gap-4 md:grid-cols-2'>
                  <Input label='显示名称' {...register(`telegram.${index}.name`)} />
                  <Input label='稳定 ID' isReadOnly {...register(`telegram.${index}.id`)} />
                  <Input
                    type='password'
                    label='Bot Token'
                    placeholder={account.botTokenConfigured ? '已配置，留空保持不变' : '请输入 Bot Token'}
                    description={account.botTokenConfigured ? '已配置' : '未配置'}
                    autoComplete='new-password'
                    {...register(`telegram.${index}.botToken`)}
                  />
                  <Input
                    label='API Base'
                    {...register(`telegram.${index}.apiBase`)}
                  />
                  <Input
                    type='number'
                    label='Poll timeout（秒）'
                    {...register(`telegram.${index}.pollTimeout`, { valueAsNumber: true })}
                  />
                  {commaListField(
                    `telegram.${index}.allowedUpdates`,
                    'Allowed updates',
                    '使用逗号分隔'
                  )}
                  {commaListField(
                    `telegram.${index}.trigger.wakeWords`,
                    '群聊唤醒词',
                    '使用逗号分隔，@username 仍然有效'
                  )}
                </div>
                <div className='mt-4 flex flex-wrap items-center justify-between gap-3'>
                  {switchField(
                    `telegram.${index}.clearSecret`,
                    '保存时清除 Bot Token',
                    undefined,
                    'danger'
                  )}
                  <div className='flex flex-wrap gap-2'>
                    <Button
                      size='sm'
                      variant='flat'
                      color='warning'
                      startContent={<ExternalLink size={15} />}
                      onPress={async () => {
                        try {
                          await request.serverPost<
                            { deleted: boolean },
                            { id: string; dropPendingUpdates: false }
                          >('/api/v1/channels/telegram/delete-webhook', {
                            id: account.id,
                            dropPendingUpdates: false,
                          })
                          toast.success('Webhook 已删除，可以启用 Long Polling')
                        } catch (error) {
                          toast.error(errorMessage(error))
                        }
                      }}
                    >
                      删除 Webhook
                    </Button>
                    <Button
                      size='sm'
                      variant='flat'
                      color='primary'
                      startContent={<Wifi size={15} />}
                      onPress={() => probe('telegram', account.id)}
                    >
                      测试已保存连接
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
      </div>
    )
  }

  const renderSection = () => {
    if (section === 'console') return renderConsole()
    if (section === 'onebot') return renderOneBot()
    if (section === 'wecom') return renderWeCom()
    if (section === 'feishu') return renderFeishu()
    if (section === 'telegram') return renderTelegram()
    return <ExtendedAdapters statuses={statuses} probe={probe} />
  }

  const activeDefinition = sections.find(item => item.key === section) ?? sections[0]
  const connectedCount = statuses.filter(status => status.state === 'connected').length

  if (loading) {
    return (
      <div className='grid min-h-[420px] place-items-center'>
        <div className='flex flex-col items-center gap-3 text-sm text-default-400'>
          <Spinner color='primary' />
          正在加载适配器配置
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <Card className='mx-auto mt-10 max-w-xl p-6 text-center'>
        <CircleOff className='mx-auto text-danger' size={32} />
        <h2 className='mt-3 font-semibold'>适配器配置加载失败</h2>
        <p className='mt-1 text-sm text-default-400'>{loadError}</p>
        <Button color='primary' className='mt-4' onPress={() => loadConfig()}>
          重新加载
        </Button>
      </Card>
    )
  }

  return (
    <FormProvider {...methods}>
      <form onSubmit={save} className='space-y-4 pb-4'>
        <Card className='border border-default-200 p-4 shadow-none md:p-5'>
          <div className='flex flex-col gap-4 md:flex-row md:items-center md:justify-between'>
            <div>
              <div className='flex items-center gap-2'>
                <div className='grid size-10 place-items-center rounded-2xl bg-primary-50 text-primary'>
                  <Wifi size={20} />
                </div>
                <div>
                  <h1 className='text-lg font-semibold'>适配器配置</h1>
                  <p className='text-xs text-default-400'>
                    连接机器人平台，并查看每个账号的实时状态
                  </p>
                </div>
              </div>
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <span className='rounded-full bg-default-100 px-3 py-1.5 text-xs text-default-500'>
                {connectedCount} 个连接在线
              </span>
              <Button
                size='sm'
                variant='flat'
                startContent={<RefreshCw size={15} />}
                onPress={() => refreshStatus().catch(error => toast.error(errorMessage(error)))}
              >
                刷新状态
              </Button>
              <Button
                size='sm'
                variant='flat'
                color='primary'
                isLoading={reloading}
                startContent={!reloading && <RotateCw size={15} />}
                onPress={reloadChannels}
              >
                重新加载
              </Button>
            </div>
          </div>
        </Card>

        <div className='md:hidden'>
          <label className='text-xs text-default-500'>
            当前适配器
            <select
              value={section}
              onChange={event => setSection(event.target.value as AdapterSection)}
              className='mt-1.5 w-full rounded-xl border border-default-200 bg-content1 px-3 py-3 text-sm outline-none focus:border-primary'
            >
              {sections.map(item => (
                <option key={item.key} value={item.key}>{item.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className='grid items-start gap-4 md:grid-cols-[270px_minmax(0,1fr)]'>
          <Card className='sticky top-4 hidden border border-default-200 p-2 shadow-none md:block'>
            <div className='space-y-1'>
              {sections.map(item => {
                const stats = sectionStats[item.key]
                const selected = section === item.key
                return (
                  <button
                    key={item.key}
                    type='button'
                    onClick={() => setSection(item.key)}
                    className={[
                      'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors',
                      selected
                        ? 'bg-primary-50 text-primary'
                        : 'text-default-600 hover:bg-default-100',
                    ].join(' ')}
                  >
                    <span className={[
                      'grid size-9 shrink-0 place-items-center rounded-xl',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-default-100',
                    ].join(' ')}
                    >
                      <item.Icon size={17} />
                    </span>
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate text-sm font-medium'>{item.label}</span>
                      <span className='block truncate text-[11px] text-default-400'>
                        {item.description}
                      </span>
                    </span>
                    <span className='text-right'>
                      <span className='block text-xs font-medium'>{stats.connected}/{stats.count}</span>
                      <span className='block text-[10px] text-default-400'>
                        {stats.enabled ? '已启用' : '未启用'}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </Card>

          <Card className='min-w-0 border border-default-200 p-4 shadow-none md:p-5'>
            <div className='mb-5 flex items-center justify-between gap-3'>
              <div className='flex items-center gap-3'>
                <span className='grid size-10 place-items-center rounded-2xl bg-default-100 text-default-600'>
                  <activeDefinition.Icon size={19} />
                </span>
                <div>
                  <h2 className='font-semibold'>{activeDefinition.label}</h2>
                  <p className='text-xs text-default-400'>{activeDefinition.description}</p>
                </div>
              </div>
              {sectionStats[section].enabled
                ? (
                  <span className='inline-flex items-center gap-1 text-xs text-success'>
                    <CheckCircle2 size={14} /> 已启用
                  </span>
                )
                : (
                  <span className='inline-flex items-center gap-1 text-xs text-default-400'>
                    <CircleOff size={14} /> 未启用
                  </span>
                )}
            </div>
            <Divider className='mb-5' />
            {renderSection()}
          </Card>
        </div>

        <Card className='sticky bottom-3 z-40 border border-default-200 bg-content1/95 p-3 shadow-xl backdrop-blur-xl'>
          <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
            <div>
              <p className='text-sm font-medium'>
                {formState.isDirty ? '有尚未保存的修改' : '配置已同步'}
              </p>
              <p className='text-xs text-default-400'>
                保存后 Core 会自动热重载 OneBot 和已启用渠道
              </p>
            </div>
            <Button
              type='submit'
              color='primary'
              isLoading={saving}
              isDisabled={!formState.isDirty || saving}
              startContent={!saving && <Save size={16} />}
            >
              保存全部适配器
            </Button>
          </div>
        </Card>
      </form>
    </FormProvider>
  )
}
