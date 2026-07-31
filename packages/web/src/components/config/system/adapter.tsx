import { useEffect, useState } from 'react'
import { saveConfig } from './save'
import { request } from '@/lib/request'
import toast from 'react-hot-toast'
import { Form } from '@heroui/form'
import { Input } from '@heroui/input'
import { Switch } from '@heroui/switch'
import { Tooltip } from '@heroui/tooltip'
import { Divider } from '@heroui/divider'
import { InternalAccordion } from './accordion'
import { NumberInput } from '@heroui/number-input'
import { Terminal, Bot, Network, Server, Building2, MessageCircle, Send } from 'lucide-react'
import { useForm, FormProvider, useFieldArray } from 'react-hook-form'

import type { Adapters } from 'node-karin'

interface ChannelStatus {
  kind: 'onebot' | 'wecom' | 'feishu' | 'telegram'
  id: string
  name: string
  state: string
  botId: string
  lastInbound: number | null
  lastError: string
  reconnects: number
}

/**
 * 获取适配器组件
 * @param data 适配器数据
 * @param formRef 表单引用，用于外部触发表单提交
 * @returns 适配器组件
 */
const getAdapterComponent = (
  data: Adapters,
  formRef: React.RefObject<HTMLFormElement | null>
) => {
  const [protocol, setProtocol] = useState(data.console.host.split('://')[0] || 'http')
  const [channelStatus, setChannelStatus] = useState<ChannelStatus[]>([])

  const methods = useForm({
    defaultValues: {
      // 不要用解构赋值 否则会丢失数据
      console: {
        isLocal: data.console.isLocal ?? false,
        token: data.console.token ?? '',
        host: data.console.host.replace(/(http|https):\/\//, '') ?? '',
      },
      onebot: {
        ws_server: {
          enable: data.onebot.ws_server.enable ?? false,
          timeout: data.onebot.ws_server.timeout ?? 120,
        },
        ws_client: data.onebot.ws_client ?? [],
        http_server: data.onebot.http_server ?? [],
      },
      wecom: data.wecom ?? [],
      feishu: data.feishu ?? [],
      telegram: data.telegram ?? [],
    },
  })

  const wsClientFields = useFieldArray({
    control: methods.control,
    name: 'onebot.ws_client',
  })

  const httpServerFields = useFieldArray({
    control: methods.control,
    name: 'onebot.http_server',
  })

  const wecomFields = useFieldArray({
    control: methods.control,
    name: 'wecom',
  })

  const feishuFields = useFieldArray({
    control: methods.control,
    name: 'feishu',
  })

  const telegramFields = useFieldArray({
    control: methods.control,
    name: 'telegram',
  })

  const isLocal = methods.watch('console.isLocal')

  const refreshChannelStatus = async () => {
    setChannelStatus(await request.serverGet<ChannelStatus[]>('/api/v1/channels/status'))
  }

  useEffect(() => {
    refreshChannelStatus().catch(() => undefined)
  }, [])

  const probeChannel = async (kind: 'wecom' | 'feishu' | 'telegram', id: string) => {
    try {
      const result = await request.serverPost<
        { ok: boolean; name: string; latency: number; detail?: string },
        { kind: 'wecom' | 'feishu' | 'telegram'; id: string }
      >('/api/v1/channels/probe', { kind, id })
      toast.success(`${result.name}: ${result.ok ? '连接正常' : result.detail || '不可用'} (${result.latency}ms)`)
      await refreshChannelStatus()
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const onSubmit = (formData: Adapters) => {
    const finalData = {
      ...formData,
      console: {
        ...formData.console,
        host: formData.console.host ? `${protocol}://${formData.console.host}` : '',
      },
    }
    saveConfig('adapter', finalData)
  }

  const addWsClient = () => {
    wsClientFields.append({
      enable: false,
      url: '',
      token: '',
    })
  }

  const addHttpServer = () => {
    httpServerFields.append({
      enable: false,
      self_id: 'default',
      url: '',
      token: '',
      api_token: '',
      post_token: '',
    })
  }

  const addWeCom = () => wecomFields.append({
    id: `wecom-${crypto.randomUUID().slice(0, 8)}`,
    name: '企业微信机器人',
    enable: false,
    botId: '',
    secret: '',
    wsUrl: '',
    reconnectInterval: 5000,
    maxReconnectAttempts: 20,
    trigger: { wakeWords: [] },
  })

  const addFeishu = () => feishuFields.append({
    id: `feishu-${crypto.randomUUID().slice(0, 8)}`,
    name: '飞书机器人',
    enable: false,
    appId: '',
    appSecret: '',
    domain: 'feishu',
    reconnectInterval: 5000,
    maxReconnectAttempts: 20,
    trigger: { wakeWords: [] },
  })

  const addTelegram = () => telegramFields.append({
    id: `telegram-${crypto.randomUUID().slice(0, 8)}`,
    name: 'Telegram Bot',
    enable: false,
    botToken: '',
    apiBase: 'https://api.telegram.org',
    pollTimeout: 30,
    allowedUpdates: ['message'],
    trigger: { wakeWords: [] },
  })

  return (
    <FormProvider {...methods}>
      <Form
        className='w-full max-w-full flex flex-col'
        onSubmit={methods.handleSubmit(onSubmit)}
        ref={formRef}
      >
        <div className='w-full max-w-full px-6 py-4 space-y-4'>
          <div className='rounded-2xl border border-default-200 bg-default-50 p-4'>
            <div className='mb-3 flex items-center justify-between'>
              <div>
                <h3 className='font-semibold'>连接状态</h3>
                <p className='text-xs text-default-500'>OneBot 只汇总状态，不改变原连接实现。</p>
              </div>
              <button
                type='button'
                onClick={() => refreshChannelStatus()}
                className='rounded-lg bg-primary-50 px-3 py-2 text-xs text-primary'
              >
                刷新状态
              </button>
            </div>
            <div className='grid gap-2 md:grid-cols-2 xl:grid-cols-4'>
              {channelStatus.map(status => (
                <div key={`${status.kind}:${status.id}`} className='rounded-xl bg-content1 p-3 text-xs'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='font-semibold'>{status.name}</span>
                    <span className={status.state === 'connected' ? 'text-success' : 'text-warning'}>
                      {status.state}
                    </span>
                  </div>
                  <div className='mt-1 text-default-500'>
                    Bot {status.botId || '—'} · 重连 {status.reconnects}
                  </div>
                  {status.lastError && (
                    <div className='mt-1 truncate text-danger' title={status.lastError}>
                      {status.lastError}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className='text-lg font-medium flex items-center gap-2'>
            <Terminal className='w-5 h-5' />
            Console 适配器
          </div>
          <Divider className='w-full' />
          <div className='space-y-2'>
            <div className='flex items-center justify-between'>
              <Switch
                className='p-2 rounded-lg w-[500px]'
                {...methods.register('console.isLocal')}
                defaultChecked={data.console.isLocal}
                color='success'
              >
                <div className='flex flex-col'>
                  <span className='text-sm'>只允许本地访问</span>
                  <span className='text-xs text-gray-500'>打开后 适配器生成的资源文件连接将只允许127.0.0.1访问</span>
                </div>
              </Switch>
            </div>

            <div className='grid md:grid-cols-2 grid-cols-1 gap-y-4 md:gap-x-12'>
              <Input
                label='资源文件的访问地址'
                {...methods.register('console.host')}
                description='打印的资源文件访问地址，本地模式下可留空。'
                placeholder=''
                className='p-2 rounded-lg w-full'
                color='primary'
                startContent={
                  <div className='flex items-center'>
                    <label className='sr-only' htmlFor='protocol'>
                      Protocol
                    </label>
                    <select
                      className='outline-none border-0 bg-transparent text-primary text-small'
                      id='protocol'
                      name='protocol'
                      value={protocol}
                      onChange={(e) => setProtocol(e.target.value)}
                    >
                      <option value='http' className='text-primary'>http://</option>
                      <option value='https' className='text-primary'>https://</option>
                    </select>
                  </div>
                }
              />
              <Input
                {...methods.register('console.token')}
                label='Token'
                description='用于验证连接的安全令牌，本地模式下可留空'
                placeholder='请输入 Token'
                required={!isLocal}
                isRequired={!isLocal}
                className='p-2 rounded-lg'
                color='primary'
              />
            </div>
          </div>
          <div className='text-lg font-medium flex items-center gap-2'>
            <Bot className='w-5 h-5' />
            OneBot 适配器
          </div>
          <Divider className='w-full' />
          <div className='space-y-4'>
            <div className='flex items-center justify-between'>
              <Tooltip
                content={
                  <div className='space-y-2 p-2'>
                    <p>用于接收来自OneBot11协议的 WebSocket 连接</p>
                    <p className='text-xs text-default-500 '>1.打开此项开关</p>
                    <p className='text-xs text-default-500 '>2.将会启用一个挂载在HTTP端口上的WebSocket服务器</p>
                    <p className='text-xs text-default-500 '>3.通过组合HTTP端口，可以创建一个反向链接</p>
                    <p className='text-xs text-default-500 '>4. 如HTTP端口为7777，则反向链接为 <code className='text-xs text-blue-500'>ws://127.0.0.1:7777</code></p>
                    <br />
                    <p>理解这里最简单的方法就是:</p>
                    <p className='text-xs text-default-500 '>
                      karin开启了一个WebSocket服务器，并监听7777端口
                      然后karin等着协议端来疯狂连接，俗称诶c...
                    </p>
                  </div>
                }
                placement='right'
                showArrow
                classNames={{
                  content: 'p-0',
                }}
                delay={0}
                closeDelay={0}
              >
                <Switch
                  className='p-2 rounded-lg'
                  {...methods.register('onebot.ws_server.enable')}
                  defaultChecked={data.onebot.ws_server.enable}
                  color='success'
                >
                  <div className='flex flex-col'>
                    <span className='text-xs'>反向 WebSocket 服务器</span>
                    <span className='text-xs text-gray-500'>鼠标悬停可以查看详情(〃'▽'〃)</span>
                  </div>
                </Switch>
              </Tooltip>
            </div>
            <div className='flex'>
              {/* @ts-ignore */}
              <NumberInput
                label='请求回调等待时间'
                className='p-2 rounded-lg w-full'
                {...methods.register('onebot.ws_server.timeout')}
                defaultValue={data.onebot.ws_server.timeout}
                placeholder='请输入请求回调等待时间'
                description={
                  <>
                    如果你需要配置WebSocketServer的鉴权秘钥 请跳转到
                    <a
                      href='./env'
                      className='text-primary font-medium hover:underline'
                    > 环境变量
                    </a>
                    选项卡哦
                  </>
                }
                isRequired
                color='primary'
              />
            </div>

            {/* WS Client 部分 */}
            <div className='text-lg font-medium flex items-center gap-2 mt-4'>
              <Network className='w-5 h-5' />
              正向 WebSocket 客户端
            </div>
            <Divider className='w-full' />
            <InternalAccordion
              list={wsClientFields.fields}
              add={addWsClient}
              remove={wsClientFields.remove}
              description='管理OneBot11协议的WebSocket客户端 也就是正向WebSocket'
              title='WebSocket 客户端'
              render={(index: number) => (
                <div className='flex flex-col gap-2 p-2'>
                  <Switch
                    className='p-2 rounded-lg bg-default-200/50 mb-3'
                    {...methods.register(`onebot.ws_client.${index}.enable`)}
                    color='success'
                  >
                    <span className='text-xs'>启用</span>
                  </Switch>
                  <Input
                    label='WebSocketServer 地址'
                    description='WebSocket的地址 也就是协议端的WebSocket服务端api地址 例如: ws://127.0.0.1:6099'
                    {...methods.register(`onebot.ws_client.${index}.url`)}
                    placeholder='WebSocket的地址'
                    className='p-2 rounded-lg w-full'
                    color='primary'
                  />
                  <Input
                    label='Token'
                    description='用于验证连接的Token 如果协议端没有设置无需填写'
                    {...methods.register(`onebot.ws_client.${index}.token`)}
                    placeholder='请输入 Token'
                    className='p-2 rounded-lg w-full'
                    color='primary'
                  />
                </div>
              )}
            />

            {/* HTTP Server 部分 */}
            <div className='text-lg font-medium flex items-center gap-2 mt-4'>
              <Server className='w-5 h-5' />
              HTTP 服务端
            </div>
            <Divider className='w-full' />
            <InternalAccordion
              list={httpServerFields.fields}
              add={addHttpServer}
              remove={httpServerFields.remove}
              description='管理OneBot11协议的HTTP POST服务端， 上报事件url: http://127.0.0.1:7777/onebot'
              title='HTTP 服务端'
              render={(index: number) => (
                <div className='flex flex-col gap-2 p-2'>
                  <Switch
                    className='p-2 rounded-lg bg-default-200/50 mb-3'
                    {...methods.register(`onebot.http_server.${index}.enable`)}
                    color='success'
                  >
                    <span className='text-xs'>启用</span>
                  </Switch>
                  <Input
                    label='Bot的QQ号'
                    description='Bot的QQ号'
                    {...methods.register(`onebot.http_server.${index}.self_id`)}
                    placeholder='Bot的QQ号'
                    className='p-2 rounded-lg w-full'
                    color='primary'
                  />
                  <Input
                    label='发送Api请求的URL地址'
                    {...methods.register(`onebot.http_server.${index}.url`)}
                    description='协议端的http api地址 例如napcat的: http://127.0.0.1:6099'
                    placeholder='发送Api请求的URL地址'
                    className='p-2 rounded-lg w-full'
                    color='primary'
                  />
                  <Input
                    label='用于发送Api请求的鉴权Token'
                    description='用于发送Api请求的鉴权Token 也就是协议端的api_token'
                    {...methods.register(`onebot.http_server.${index}.api_token`)}
                    placeholder='请输入用于发送Api请求的鉴权Token'
                    className='p-2 rounded-lg w-full'
                    color='primary'
                  />
                  <Input
                    label='用于验证请求合法的Token'
                    description='用于验证请求合法的Token 也就是协议端的上报事件的post_token'
                    {...methods.register(`onebot.http_server.${index}.post_token`)}
                    placeholder='请输入用于验证请求合法的Token'
                    className='p-2 rounded-lg w-full'
                    color='primary'
                  />
                </div>
              )}
            />
          </div>

          <div className='mt-8 text-lg font-medium flex items-center gap-2'>
            <Building2 className='w-5 h-5' />
            企业微信智能机器人
          </div>
          <Divider className='w-full' />
          <InternalAccordion
            list={wecomFields.fields}
            add={addWeCom}
            remove={wecomFields.remove}
            description='官方智能机器人 WebSocket 长连接，无需公网回调'
            title='企业微信账号'
            render={(index: number) => (
              <div className='grid grid-cols-1 md:grid-cols-2 gap-3 p-2'>
                <Switch
                  className='p-2 rounded-lg bg-default-200/50 md:col-span-2'
                  {...methods.register(`wecom.${index}.enable`)}
                  color='success'
                >
                  <span className='text-xs'>启用账号</span>
                </Switch>
                <Input label='显示名称' {...methods.register(`wecom.${index}.name`)} />
                <Input label='稳定 ID' isReadOnly {...methods.register(`wecom.${index}.id`)} />
                <Input label='Bot ID' {...methods.register(`wecom.${index}.botId`)} />
                <Input
                  type='password'
                  label='Secret'
                  placeholder='已配置时留空可保留'
                  autoComplete='new-password'
                  {...methods.register(`wecom.${index}.secret`)}
                />
                <Switch {...methods.register(`wecom.${index}.clearSecret`)} color='danger'>
                  <span className='text-xs'>保存时清除 Secret</span>
                </Switch>
                <Input
                  label='WebSocket URL（可选）'
                  placeholder='留空使用官方地址'
                  {...methods.register(`wecom.${index}.wsUrl`)}
                />
                <Input
                  type='number'
                  label='重连间隔（ms）'
                  {...methods.register(`wecom.${index}.reconnectInterval`, { valueAsNumber: true })}
                />
                <Input
                  type='number'
                  label='最大重连次数'
                  {...methods.register(`wecom.${index}.maxReconnectAttempts`, { valueAsNumber: true })}
                />
                <Input
                  label='群聊唤醒词'
                  description='逗号分隔；平台 @ 仍然有效'
                  {...methods.register(`wecom.${index}.trigger.wakeWords`, {
                    setValueAs: value => String(value).split(',').map(item => item.trim()).filter(Boolean),
                  })}
                />
                <button
                  type='button'
                  onClick={() => probeChannel('wecom', methods.getValues(`wecom.${index}.id`))}
                  className='rounded-xl bg-primary-50 px-3 py-2 text-sm text-primary'
                >
                  测试已保存连接
                </button>
              </div>
            )}
          />

          <div className='mt-8 text-lg font-medium flex items-center gap-2'>
            <MessageCircle className='w-5 h-5' />
            飞书 / Lark
          </div>
          <Divider className='w-full' />
          <InternalAccordion
            list={feishuFields.fields}
            add={addFeishu}
            remove={feishuFields.remove}
            description='官方 SDK 长连接订阅 im.message.receive_v1'
            title='飞书账号'
            render={(index: number) => (
              <div className='grid grid-cols-1 md:grid-cols-2 gap-3 p-2'>
                <Switch
                  className='p-2 rounded-lg bg-default-200/50 md:col-span-2'
                  {...methods.register(`feishu.${index}.enable`)}
                  color='success'
                >
                  <span className='text-xs'>启用账号</span>
                </Switch>
                <Input label='显示名称' {...methods.register(`feishu.${index}.name`)} />
                <Input label='稳定 ID' isReadOnly {...methods.register(`feishu.${index}.id`)} />
                <Input label='App ID' {...methods.register(`feishu.${index}.appId`)} />
                <Input
                  type='password'
                  label='App Secret'
                  placeholder='已配置时留空可保留'
                  autoComplete='new-password'
                  {...methods.register(`feishu.${index}.appSecret`)}
                />
                <Switch {...methods.register(`feishu.${index}.clearSecret`)} color='danger'>
                  <span className='text-xs'>保存时清除 App Secret</span>
                </Switch>
                <label className='text-xs text-default-500'>
                  域名
                  <select
                    {...methods.register(`feishu.${index}.domain`)}
                    className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2 text-sm'
                  >
                    <option value='feishu'>飞书</option>
                    <option value='lark'>Lark</option>
                  </select>
                </label>
                <Input
                  type='number'
                  label='重连间隔（ms）'
                  {...methods.register(`feishu.${index}.reconnectInterval`, { valueAsNumber: true })}
                />
                <Input
                  type='number'
                  label='最大重连次数'
                  {...methods.register(`feishu.${index}.maxReconnectAttempts`, { valueAsNumber: true })}
                />
                <Input
                  label='群聊唤醒词'
                  description='逗号分隔；平台 @ 仍然有效'
                  {...methods.register(`feishu.${index}.trigger.wakeWords`, {
                    setValueAs: value => String(value).split(',').map(item => item.trim()).filter(Boolean),
                  })}
                />
                <button
                  type='button'
                  onClick={() => probeChannel('feishu', methods.getValues(`feishu.${index}.id`))}
                  className='rounded-xl bg-primary-50 px-3 py-2 text-sm text-primary'
                >
                  测试已保存连接
                </button>
              </div>
            )}
          />

          <div className='mt-8 text-lg font-medium flex items-center gap-2'>
            <Send className='w-5 h-5' />
            Telegram Bot API
          </div>
          <Divider className='w-full' />
          <InternalAccordion
            list={telegramFields.fields}
            add={addTelegram}
            remove={telegramFields.remove}
            description='原生 Bot API long polling；检测到 Webhook 时会拒绝启动'
            title='Telegram 账号'
            render={(index: number) => (
              <div className='grid grid-cols-1 md:grid-cols-2 gap-3 p-2'>
                <Switch
                  className='p-2 rounded-lg bg-default-200/50 md:col-span-2'
                  {...methods.register(`telegram.${index}.enable`)}
                  color='success'
                >
                  <span className='text-xs'>启用账号</span>
                </Switch>
                <Input label='显示名称' {...methods.register(`telegram.${index}.name`)} />
                <Input label='稳定 ID' isReadOnly {...methods.register(`telegram.${index}.id`)} />
                <Input
                  type='password'
                  label='Bot Token'
                  placeholder='已配置时留空可保留'
                  autoComplete='new-password'
                  {...methods.register(`telegram.${index}.botToken`)}
                />
                <Switch {...methods.register(`telegram.${index}.clearSecret`)} color='danger'>
                  <span className='text-xs'>保存时清除 Bot Token</span>
                </Switch>
                <Input label='API Base' {...methods.register(`telegram.${index}.apiBase`)} />
                <Input
                  type='number'
                  label='Poll timeout（秒）'
                  {...methods.register(`telegram.${index}.pollTimeout`, { valueAsNumber: true })}
                />
                <Input
                  label='Allowed updates'
                  description='逗号分隔'
                  {...methods.register(`telegram.${index}.allowedUpdates`, {
                    setValueAs: value => String(value).split(',').map(item => item.trim()).filter(Boolean),
                  })}
                />
                <Input
                  label='群聊唤醒词'
                  description='逗号分隔；@username 仍然有效'
                  {...methods.register(`telegram.${index}.trigger.wakeWords`, {
                    setValueAs: value => String(value).split(',').map(item => item.trim()).filter(Boolean),
                  })}
                />
                <button
                  type='button'
                  onClick={() => probeChannel('telegram', methods.getValues(`telegram.${index}.id`))}
                  className='rounded-xl bg-primary-50 px-3 py-2 text-sm text-primary'
                >
                  测试已保存连接
                </button>
                <button
                  type='button'
                  onClick={async () => {
                    try {
                      await request.serverPost('/api/v1/channels/telegram/delete-webhook', {
                        id: methods.getValues(`telegram.${index}.id`),
                        dropPendingUpdates: false,
                      })
                      toast.success('Webhook 已删除，可以启用 long polling')
                    } catch (error) {
                      toast.error((error as Error).message)
                    }
                  }}
                  className='rounded-xl bg-warning-50 px-3 py-2 text-sm text-warning'
                >
                  显式删除 Webhook
                </button>
              </div>
            )}
          />
        </div>
      </Form>
    </FormProvider>
  )
}
export default getAdapterComponent
