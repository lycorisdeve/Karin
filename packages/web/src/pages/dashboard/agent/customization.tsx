import { useEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import toast from 'react-hot-toast'
import Markdown from '@/components/Markdown'
import {
  agentRequest,
  type AgentInstructionVersion,
  type AgentPersona,
  type AgentPersonaDefinition,
} from '@/request/agent'
import { BookOpen, History, Plus, Save } from 'lucide-react'

const emptyDefinition: AgentPersonaDefinition = {
  identity: '',
  expertise: [],
  tone: '',
  responseStyle: '',
  language: '',
}

const presetText = (definition: AgentPersonaDefinition) => [
  definition.identity,
  definition.expertise.length ? `专业领域：${definition.expertise.join('、')}` : '',
  definition.tone ? `语气：${definition.tone}` : '',
  definition.responseStyle ? `回答风格：${definition.responseStyle}` : '',
  definition.language ? `默认语言：${definition.language}` : '',
].filter(Boolean).join('\n')

const presetDefinition = (value: string): AgentPersonaDefinition => ({
  ...emptyDefinition,
  identity: value.trim(),
})

const Button = ({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) => (
  <button
    type='button'
    onClick={onClick}
    disabled={disabled}
    className='inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
  >
    {children}
  </button>
)

export default function AgentCustomization () {
  const [instruction, setInstruction] = useState<AgentInstructionVersion | null>(null)
  const [content, setContent] = useState('')
  const [versions, setVersions] = useState<AgentInstructionVersion[]>([])
  const [personas, setPersonas] = useState<AgentPersona[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [preset, setPreset] = useState('')
  const [saving, setSaving] = useState(false)
  const selected = useMemo(
    () => personas.find(item => item.id === selectedId) || null,
    [personas, selectedId]
  )

  const load = async () => {
    const [nextInstruction, nextVersions, nextPersonas] = await Promise.all([
      agentRequest.instructions(),
      agentRequest.instructionVersions(),
      agentRequest.personas(),
    ])
    setInstruction(nextInstruction.current)
    setContent(nextInstruction.current.content)
    setVersions(nextVersions)
    setPersonas(nextPersonas)
    setSelectedId(value => value || nextPersonas[0]?.id || '')
  }

  useEffect(() => {
    load().catch(error => toast.error((error as Error).message))
  }, [])

  useEffect(() => {
    if (!selected) {
      setName('')
      setPreset('')
      return
    }
    setName(selected.name)
    setPreset(presetText(selected.definition))
  }, [selected])

  const saveInstruction = async () => {
    if (!instruction) return
    setSaving(true)
    try {
      const next = await agentRequest.saveInstructions(content, instruction.contentHash)
      setInstruction(next)
      setVersions(await agentRequest.instructionVersions())
      toast.success(`AGENT.md v${next.version} 已保存；新会话自动使用该版本`)
    } catch (error) {
      toast.error((error as Error).message)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const savePersona = async () => {
    if (!name.trim() || !preset.trim()) {
      toast.error('预设名称和预设内容不能为空')
      return
    }
    setSaving(true)
    try {
      const input = {
        name,
        description: selected?.description || '',
        definition: presetDefinition(preset),
      }
      const next = selected
        ? await agentRequest.updatePersona(selected.id, input)
        : await agentRequest.createPersona(input)
      await load()
      setSelectedId(next.id)
      toast.success(`人物预设“${next.name}”v${next.version} 已保存`)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='grid gap-4 xl:h-[calc(100dvh-9.5rem)] xl:min-h-[560px] xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,.55fr)]'>
      <section className='flex min-h-[560px] min-w-0 flex-col overflow-hidden rounded-2xl border border-default-200 bg-content1 xl:min-h-0'>
        <div className='flex shrink-0 items-center justify-between border-b border-default-200 px-4 py-3'>
          <div>
            <h2 className='font-semibold'>AGENT.md</h2>
            <p className='mt-0.5 text-xs text-default-500'>
              v{instruction?.version || '—'} · 上限 32 KiB · 新会话生效
            </p>
          </div>
          <Button disabled={saving || !instruction} onClick={saveInstruction}>
            <Save size={15} />保存新版本
          </Button>
        </div>

        <div className='grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_280px]'>
          <div className='min-h-[420px] min-w-0 lg:min-h-0'>
            <Editor
              height='100%'
              language='markdown'
              value={content}
              onChange={value => setContent(value || '')}
              options={{
                minimap: { enabled: false },
                wordWrap: 'on',
                fontSize: 13,
                lineHeight: 21,
                padding: { top: 12 },
                scrollBeyondLastLine: false,
              }}
            />
          </div>
          <aside className='flex min-h-0 flex-col border-t border-default-200 p-3 lg:border-l lg:border-t-0'>
            <div className='mb-2 flex items-center gap-2 text-sm font-semibold'>
              <BookOpen size={15} />预览
            </div>
            <div className='min-h-28 flex-1 overflow-auto text-sm'>
              {content.trim()
                ? <Markdown content={content} />
                : <p className='text-default-400'>暂无额外工作章程。</p>}
            </div>
            <div className='mt-3 shrink-0 border-t border-default-200 pt-3'>
              <div className='flex items-center gap-2 text-xs font-semibold'>
                <History size={14} />最近版本
              </div>
              <div className='mt-1.5 max-h-24 space-y-0.5 overflow-auto text-[11px] text-default-500'>
                {versions.slice(0, 6).map(item => (
                  <button
                    key={item.id}
                    type='button'
                    onClick={() => setContent(item.content)}
                    className='flex w-full justify-between rounded-lg px-2 py-1 text-left hover:bg-default-100'
                  >
                    <span>v{item.version} · {item.source}</span>
                    <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section className='flex min-h-[520px] min-w-0 flex-col rounded-2xl border border-default-200 bg-content1 p-4 xl:min-h-0'>
        <div className='flex shrink-0 items-center justify-between gap-3'>
          <div>
            <h2 className='font-semibold'>人物预设</h2>
            <p className='mt-0.5 text-xs text-default-500'>只影响身份与表达。</p>
          </div>
          <button
            type='button'
            onClick={() => setSelectedId('')}
            className='rounded-xl border border-default-200 p-2 hover:bg-default-100'
            aria-label='新建人物预设'
          >
            <Plus size={17} />
          </button>
        </div>

        <div className='mt-3 flex max-h-20 shrink-0 flex-wrap gap-1.5 overflow-auto'>
          {personas.map(item => (
            <button
              key={item.id}
              type='button'
              onClick={() => setSelectedId(item.id)}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                selectedId === item.id
                  ? 'border-primary bg-primary-50 text-primary'
                  : 'border-default-200 text-default-600'
              }`}
            >
              {item.name}{item.isDefault ? ' · 默认' : ''}{!item.enabled ? ' · 停用' : ''}
            </button>
          ))}
        </div>

        <div className='mt-3 flex min-h-0 flex-1 flex-col gap-3'>
          <label className='shrink-0 text-xs text-default-500'>
            预设名称
            <input
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder='例如：代码审阅者'
              className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-2.5 text-sm'
            />
          </label>
          <label className='flex min-h-0 flex-1 flex-col text-xs text-default-500'>
            预设内容
            <textarea
              value={preset}
              onChange={event => setPreset(event.target.value)}
              placeholder='描述这个人物是谁、擅长什么，以及希望它如何表达。'
              className='mt-1 min-h-64 flex-1 resize-none rounded-xl border border-default-200 bg-default-50 p-3 text-sm leading-6'
            />
          </label>
          {selected && (
            <p className='shrink-0 text-[11px] text-default-400'>
              v{selected.version} · {selected.threadReferences} 个 Thread · {selected.jobReferences} 个定时任务引用
            </p>
          )}
          <div className='flex shrink-0 flex-wrap gap-2'>
            <Button disabled={saving} onClick={savePersona}>
              <Save size={15} />{selected ? '保存新版本' : '创建预设'}
            </Button>
            {selected && !selected.isDefault && (
              <button
                type='button'
                onClick={async () => {
                  await agentRequest.setDefaultPersona(selected.id)
                  await load()
                  toast.success(`“${selected.name}”已设为默认人物`)
                }}
                className='rounded-xl border border-default-200 px-3 py-2 text-sm'
              >
                设为默认
              </button>
            )}
            {selected && !selected.isDefault && (
              <button
                type='button'
                onClick={async () => {
                  await agentRequest.setPersonaState(selected.id, !selected.enabled)
                  await load()
                }}
                className='rounded-xl border border-default-200 px-3 py-2 text-sm'
              >
                {selected.enabled ? '停用' : '启用'}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
