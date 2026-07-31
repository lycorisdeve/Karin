import { useMemo, useState } from 'react'
import { Button } from '@heroui/button'
import { Card } from '@heroui/card'
import { Input } from '@heroui/input'
import { Switch } from '@heroui/switch'
import { AlertTriangle, Plus, Trash2, Wifi } from 'lucide-react'
import {
  Controller,
  useFieldArray,
  useFormContext,
  useWatch,
} from 'react-hook-form'

import type { FieldPath } from 'react-hook-form'
import type { AdapterFormValues } from './adapter-model'

export type ExtendedChannelKind =
  | 'qqbot'
  | 'wechat'
  | 'dingtalk'
  | 'discord'
  | 'whatsapp'
  | 'email'

interface Status {
  kind: string
  id: string
  state: string
  botId: string
  lastError: string
}

interface Props {
  statuses: Status[]
  probe: (kind: ExtendedChannelKind, id: string) => Promise<void>
}

interface FieldDefinition {
  key: string
  label: string
  type?: 'text' | 'password' | 'number' | 'boolean' | 'list'
  placeholder?: string
  description?: string
  configuredKey?: string
}

const definitions: Record<ExtendedChannelKind, {
  label: string
  description: string
  fields: FieldDefinition[]
}> = {
  qqbot: {
    label: 'QQBot',
    description: '腾讯 QQ 开放平台 Gateway / REST',
    fields: [
      { key: 'appId', label: 'App ID' },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        configuredKey: 'clientSecretConfigured',
      },
      { key: 'apiBase', label: 'API Base' },
      { key: 'gatewayUrl', label: 'Gateway URL', description: '留空时自动发现' },
    ],
  },
  wechat: {
    label: '个人微信',
    description: '连接独立部署的 WeChatPadPro',
    fields: [
      { key: 'serverUrl', label: 'WeChatPadPro 地址', placeholder: 'http://127.0.0.1:1238' },
      { key: 'token', label: 'Token', type: 'password', configuredKey: 'tokenConfigured' },
      { key: 'pollInterval', label: '轮询间隔（ms）', type: 'number' },
    ],
  },
  dingtalk: {
    label: '钉钉',
    description: 'DingTalk Stream 与机器人 OpenAPI',
    fields: [
      { key: 'clientId', label: 'Client ID' },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        configuredKey: 'clientSecretConfigured',
      },
      { key: 'robotCode', label: 'Robot Code' },
    ],
  },
  discord: {
    label: 'Discord',
    description: 'Gateway、私信、服务器频道与原生附件',
    fields: [
      { key: 'applicationId', label: 'Application ID' },
      {
        key: 'botToken',
        label: 'Bot Token',
        type: 'password',
        configuredKey: 'botTokenConfigured',
      },
      {
        key: 'intents',
        label: 'Gateway Intents',
        type: 'list',
        description: '群消息正文需要在开发者后台开启 Message Content Intent',
      },
    ],
  },
  whatsapp: {
    label: 'WhatsApp',
    description: '官方 Cloud API，仅支持私聊',
    fields: [
      { key: 'phoneNumberId', label: 'Phone Number ID' },
      {
        key: 'accessToken',
        label: 'Access Token',
        type: 'password',
        configuredKey: 'accessTokenConfigured',
      },
      {
        key: 'appSecret',
        label: 'App Secret',
        type: 'password',
        configuredKey: 'appSecretConfigured',
      },
      {
        key: 'verifyToken',
        label: 'Webhook Verify Token',
        type: 'password',
        configuredKey: 'verifyTokenConfigured',
      },
      { key: 'graphVersion', label: 'Graph API 版本', placeholder: 'v23.0' },
    ],
  },
  email: {
    label: 'Email',
    description: 'IMAP 收取、SMTP 回复与 CID 内嵌图片',
    fields: [
      { key: 'address', label: '邮箱地址' },
      { key: 'imapHost', label: 'IMAP Host' },
      { key: 'imapPort', label: 'IMAP Port', type: 'number' },
      { key: 'imapSecure', label: 'IMAP TLS', type: 'boolean' },
      { key: 'imapUser', label: 'IMAP 用户名' },
      {
        key: 'imapPassword',
        label: 'IMAP 密码',
        type: 'password',
        configuredKey: 'imapPasswordConfigured',
      },
      { key: 'mailbox', label: '收件箱', placeholder: 'INBOX' },
      { key: 'smtpHost', label: 'SMTP Host' },
      { key: 'smtpPort', label: 'SMTP Port', type: 'number' },
      { key: 'smtpSecure', label: 'SMTP TLS', type: 'boolean' },
      { key: 'smtpUser', label: 'SMTP 用户名' },
      {
        key: 'smtpPassword',
        label: 'SMTP 密码',
        type: 'password',
        configuredKey: 'smtpPasswordConfigured',
      },
    ],
  },
}

const createId = (kind: ExtendedChannelKind) =>
  `${kind}-${crypto.randomUUID().slice(0, 8)}`

export default function ExtendedAdapters ({ statuses, probe }: Props) {
  const { control, register } = useFormContext<AdapterFormValues>()
  const qqbot = useFieldArray({ control, name: 'qqbot', keyName: '_formKey' })
  const wechat = useFieldArray({ control, name: 'wechat', keyName: '_formKey' })
  const dingtalk = useFieldArray({ control, name: 'dingtalk', keyName: '_formKey' })
  const discord = useFieldArray({ control, name: 'discord', keyName: '_formKey' })
  const whatsapp = useFieldArray({ control, name: 'whatsapp', keyName: '_formKey' })
  const email = useFieldArray({ control, name: 'email', keyName: '_formKey' })
  const accounts = {
    qqbot: useWatch({ control, name: 'qqbot' }) ?? [],
    wechat: useWatch({ control, name: 'wechat' }) ?? [],
    dingtalk: useWatch({ control, name: 'dingtalk' }) ?? [],
    discord: useWatch({ control, name: 'discord' }) ?? [],
    whatsapp: useWatch({ control, name: 'whatsapp' }) ?? [],
    email: useWatch({ control, name: 'email' }) ?? [],
  }
  const arrays = { qqbot, wechat, dingtalk, discord, whatsapp, email }
  const [kind, setKind] = useState<ExtendedChannelKind>('qqbot')
  const [selected, setSelected] = useState<Partial<Record<ExtendedChannelKind, string>>>({})
  const definition = definitions[kind]
  const currentAccounts = accounts[kind]
  const selectedId = selected[kind] ?? currentAccounts[0]?.id
  const index = currentAccounts.findIndex(account => account.id === selectedId)
  const account = index >= 0 ? currentAccounts[index] : undefined
  const status = statuses.find(item => item.kind === kind && item.id === account?.id)

  const append = () => {
    const id = createId(kind)
    if (kind === 'qqbot') {
      arrays.qqbot.append({
        id,
        name: 'QQBot',
        enable: false,
        appId: '',
        clientSecret: '',
        apiBase: 'https://api.sgroup.qq.com',
        gatewayUrl: '',
        trigger: { wakeWords: [] },
      })
    }
    if (kind === 'wechat') {
      arrays.wechat.append({
        id,
        name: '个人微信',
        enable: false,
        serverUrl: '',
        token: '',
        pollInterval: 1500,
        trigger: { wakeWords: [] },
      })
    }
    if (kind === 'dingtalk') {
      arrays.dingtalk.append({
        id,
        name: '钉钉机器人',
        enable: false,
        clientId: '',
        clientSecret: '',
        robotCode: '',
        trigger: { wakeWords: [] },
      })
    }
    if (kind === 'discord') {
      arrays.discord.append({
        id,
        name: 'Discord Bot',
        enable: false,
        applicationId: '',
        botToken: '',
        intents: ['Guilds', 'GuildMessages', 'DirectMessages', 'MessageContent'],
        trigger: { wakeWords: [] },
      })
    }
    if (kind === 'whatsapp') {
      arrays.whatsapp.append({
        id,
        name: 'WhatsApp Cloud API',
        enable: false,
        phoneNumberId: '',
        accessToken: '',
        appSecret: '',
        verifyToken: '',
        graphVersion: 'v23.0',
        trigger: { wakeWords: [] },
      })
    }
    if (kind === 'email') {
      arrays.email.append({
        id,
        name: 'Email',
        enable: false,
        address: '',
        imapHost: '',
        imapPort: 993,
        imapSecure: true,
        imapUser: '',
        imapPassword: '',
        mailbox: 'INBOX',
        smtpHost: '',
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: '',
        smtpPassword: '',
        trigger: { wakeWords: [] },
      })
    }
    setSelected(current => ({ ...current, [kind]: id }))
  }

  const remove = () => {
    if (index < 0 || !account) return
    if (!window.confirm(`确定删除“${account.name || account.id}”吗？`)) return
    arrays[kind].remove(index)
    setSelected(current => ({ ...current, [kind]: undefined }))
  }

  const configured = useMemo(() => {
    if (!account) return new Set<string>()
    const record = account as unknown as Record<string, unknown>
    return new Set(definition.fields
      .filter(field => field.configuredKey && record[field.configuredKey] === true)
      .map(field => field.key))
  }, [account, definition.fields])

  const path = (key: string) =>
    `${kind}.${index}.${key}` as FieldPath<AdapterFormValues>

  return (
    <div className='space-y-4'>
      <div className='flex gap-2 overflow-x-auto pb-1'>
        {(Object.keys(definitions) as ExtendedChannelKind[]).map(item => (
          <Button
            key={item}
            size='sm'
            color={kind === item ? 'primary' : 'default'}
            variant={kind === item ? 'solid' : 'flat'}
            onPress={() => setKind(item)}
          >
            {definitions[item].label}
          </Button>
        ))}
      </div>

      {kind === 'wechat' && (
        <div className='flex gap-2 rounded-xl border border-warning-200 bg-warning-50 p-3 text-xs text-warning-700'>
          <AlertTriangle className='shrink-0' size={16} />
          WeChatPadPro 属于第三方逆向协议，存在封号、接口变更和稳定性风险。
        </div>
      )}

      <div className='grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]'>
        <div className='space-y-2'>
          <Button
            fullWidth
            size='sm'
            color='primary'
            variant='flat'
            startContent={<Plus size={15} />}
            onPress={append}
          >
            添加{definition.label}账号
          </Button>
          {currentAccounts.map(item => (
            <button
              key={item.id}
              type='button'
              className={[
                'w-full rounded-xl border px-3 py-3 text-left',
                item.id === selectedId
                  ? 'border-primary bg-primary-50/70'
                  : 'border-default-200',
              ].join(' ')}
              onClick={() => setSelected(current => ({ ...current, [kind]: item.id }))}
            >
              <span className='block truncate text-sm font-medium'>{item.name || item.id}</span>
              <span className='mt-1 block truncate font-mono text-[10px] text-default-400'>
                {item.id}
              </span>
            </button>
          ))}
        </div>

        {!account
          ? (
            <div className='grid min-h-72 place-items-center rounded-2xl border border-dashed border-default-200 text-sm text-default-400'>
              添加账号后在这里配置 {definition.label}
            </div>
          )
          : (
            <Card className='space-y-4 border border-default-200 p-4 shadow-none'>
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <p className='font-semibold'>{account.name || account.id}</p>
                  <p className='text-xs text-default-400'>{definition.description}</p>
                </div>
                <Button
                  isIconOnly
                  color='danger'
                  variant='light'
                  aria-label='删除账号'
                  onPress={remove}
                >
                  <Trash2 size={17} />
                </Button>
              </div>
              <div className='flex flex-wrap items-center gap-2 rounded-xl bg-default-50 px-3 py-2 text-xs'>
                <span>{status?.state || '未运行'}</span>
                {status?.botId && <span className='font-mono'>Bot {status.botId}</span>}
                {status?.lastError && <span className='text-danger'>{status.lastError}</span>}
              </div>
              <Controller
                control={control}
                name={path('enable')}
                render={({ field }) => {
                  const handleEnableChange = (value: boolean) => field.onChange(value)
                  return (
                    <Switch
                      isSelected={Boolean(field.value)}
                      onValueChange={handleEnableChange}
                      color='success'
                    >
                      启用账号
                    </Switch>
                  )
                }}
              />
              <div className='grid gap-4 md:grid-cols-2'>
                <Input label='显示名称' {...register(path('name'))} />
                <Input label='稳定 ID' isReadOnly {...register(path('id'))} />
                {definition.fields.map(field => {
                  if (field.type === 'boolean') {
                    return (
                      <Controller
                        key={field.key}
                        control={control}
                        name={path(field.key)}
                        render={({ field: value }) => {
                          const handleBooleanChange = (next: boolean) => value.onChange(next)
                          return (
                            <Switch
                              isSelected={Boolean(value.value)}
                              onValueChange={handleBooleanChange}
                            >
                              {field.label}
                            </Switch>
                          )
                        }}
                      />
                    )
                  }
                  if (field.type === 'list') {
                    return (
                      <Controller
                        key={field.key}
                        control={control}
                        name={path(field.key)}
                        render={({ field: value }) => (
                          <Input
                            label={field.label}
                            description={field.description}
                            value={Array.isArray(value.value) ? value.value.join(', ') : ''}
                            onValueChange={next => value.onChange(
                              next.split(',').map(item => item.trim()).filter(Boolean)
                            )}
                          />
                        )}
                      />
                    )
                  }
                  return (
                    <Input
                      key={field.key}
                      type={field.type === 'number' ? 'number' : field.type || 'text'}
                      label={field.label}
                      placeholder={
                        configured.has(field.key)
                          ? '已配置，留空保持不变'
                          : field.placeholder
                      }
                      description={
                        configured.has(field.key) ? '已配置' : field.description
                      }
                      autoComplete={field.type === 'password' ? 'new-password' : undefined}
                      {...register(path(field.key), {
                        valueAsNumber: field.type === 'number',
                      })}
                    />
                  )
                })}
                <Controller
                  control={control}
                  name={path('trigger.wakeWords')}
                  render={({ field }) => (
                    <Input
                      label='群聊唤醒词'
                      description='使用逗号分隔；固定命令始终优先'
                      value={Array.isArray(field.value) ? field.value.join(', ') : ''}
                      onValueChange={value => field.onChange(
                        value.split(',').map(item => item.trim()).filter(Boolean)
                      )}
                    />
                  )}
                />
              </div>
              <div className='flex justify-end'>
                <Button
                  size='sm'
                  color='primary'
                  variant='flat'
                  startContent={<Wifi size={15} />}
                  onPress={() => probe(kind, account.id)}
                >
                  测试已保存连接
                </Button>
              </div>
            </Card>
          )}
      </div>
    </div>
  )
}
