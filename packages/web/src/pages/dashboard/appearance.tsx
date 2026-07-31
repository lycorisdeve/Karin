import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { Button } from '@heroui/button'
import { Input } from '@heroui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@heroui/popover'
import { SketchPicker } from 'react-color'
import {
  Check,
  Download,
  Moon,
  Palette,
  Plus,
  RotateCcw,
  Save,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react'
import { useTheme } from '@/hooks/use-theme'
import { activeThemeOf } from '@/theme/appearance'
import { request } from '@/lib/request'

import type {
  WebUIAppearanceConfig,
  WebUIColorMode,
  WebUIThemeDefinition,
  WebUIThemePalette,
} from '@/theme/appearance'

const paletteFields: Array<{ key: keyof WebUIThemePalette, label: string }> = [
  { key: 'background', label: '页面背景' },
  { key: 'surface', label: '内容表面' },
  { key: 'elevatedSurface', label: '浮层表面' },
  { key: 'foreground', label: '主要文字' },
  { key: 'mutedForeground', label: '次要文字' },
  { key: 'border', label: '边框' },
  { key: 'primary', label: '主色' },
  { key: 'primaryForeground', label: '主色文字' },
  { key: 'accent', label: '强调色' },
  { key: 'success', label: '成功' },
  { key: 'warning', label: '警告' },
  { key: 'danger', label: '危险' },
  { key: 'codeBackground', label: '代码背景' },
]

const colorChannel = (hex: string, offset: number) =>
  Number.parseInt(hex.slice(offset, offset + 2), 16) / 255

const luminance = (hex: string) => {
  const values = [colorChannel(hex, 1), colorChannel(hex, 3), colorChannel(hex, 5)]
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]
}

const contrast = (left: string, right: string) => {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (bright + 0.05) / (dark + 0.05)
}

const cloneTheme = (theme: WebUIThemeDefinition): WebUIThemeDefinition => {
  const suffix = Date.now().toString(36)
  return {
    ...structuredClone(theme),
    id: `custom-${suffix}`,
    name: `${theme.name} 副本`,
    builtin: false,
  }
}

const ColorField = ({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) => (
  <div className='flex items-center gap-3 rounded-2xl border border-border/70 bg-card/70 p-3'>
    <Popover placement='bottom-start'>
      <PopoverTrigger>
        <button
          type='button'
          aria-label={`选择${label}`}
          className='h-9 w-9 shrink-0 rounded-xl border border-border shadow-sm'
          style={{ backgroundColor: value }}
        />
      </PopoverTrigger>
      <PopoverContent className='p-2'>
        <SketchPicker
          color={value}
          onChange={color => onChange(color.hex.toUpperCase())}
          className='!bg-transparent !shadow-none'
        />
      </PopoverContent>
    </Popover>
    <label className='min-w-0 flex-1'>
      <span className='mb-1 block text-xs text-default-500'>{label}</span>
      <input
        value={value}
        onChange={event => onChange(event.target.value.toUpperCase())}
        className='w-full bg-transparent font-mono text-xs uppercase outline-none'
      />
    </label>
  </div>
)

interface HelpAppearance {
  version: 1
  revision: number
  title: string
  subtitle: string
  backgroundAsset: string
  backgroundPosition: 'top' | 'center' | 'bottom'
  overlay: number
}

const HelpAppearancePanel = () => {
  const [value, setValue] = useState<HelpAppearance | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    setValue(await request.serverGet<HelpAppearance>('/api/v1/help/appearance'))
  }
  useEffect(() => {
    load().catch(error => toast.error((error as Error).message))
  }, [])

  if (!value) return null
  const backgroundUrl = value.backgroundAsset
    ? `/api/v1/help/appearance/background?v=${value.revision}`
    : ''

  const save = async () => {
    setBusy(true)
    try {
      const response = await request.put('/api/v1/help/appearance', value)
      setValue(response.data.data)
      toast.success('帮助图片外观已保存')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file?: File) => {
    if (!file) return
    setBusy(true)
    try {
      const response = await request.post(
        '/api/v1/help/appearance/background',
        await file.arrayBuffer(),
        { headers: { 'Content-Type': file.type || 'application/octet-stream' } }
      )
      setValue(response.data.data)
      toast.success('帮助背景已上传')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    try {
      const response = await request.delete('/api/v1/help/appearance/background')
      setValue(response.data.data)
      toast.success('帮助背景已重置')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className='mt-5 overflow-hidden rounded-[28px] border border-border bg-card/80 p-4 shadow-sm sm:p-6'>
      <div className='mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
        <div>
          <p className='text-xs font-medium uppercase tracking-[0.16em] text-primary'>Command help</p>
          <h2 className='mt-1 text-xl font-semibold'>帮助图片</h2>
          <p className='mt-1 text-xs text-default-500'>
            #帮助 会通过 Puppeteer 生成背景大图与三列半透明命令表。
          </p>
        </div>
        <div className='flex flex-wrap gap-2'>
          <label className='inline-flex cursor-pointer items-center gap-2 rounded-xl bg-default-100 px-3 py-2 text-xs font-medium hover:bg-default-200'>
            <Upload size={14} />选择本地背景
            <input
              type='file'
              accept='image/png,image/jpeg,image/webp'
              className='hidden'
              onChange={event => upload(event.target.files?.[0])}
            />
          </label>
          {value.backgroundAsset && (
            <Button size='sm' variant='flat' color='danger' onPress={reset}>
              移除背景
            </Button>
          )}
          <Button size='sm' color='primary' isLoading={busy} onPress={save}>
            保存帮助外观
          </Button>
        </div>
      </div>
      <div className='grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]'>
        <div
          className='relative min-h-[430px] overflow-hidden rounded-2xl bg-gradient-to-br from-violet-200 via-indigo-300 to-slate-700 bg-cover'
          style={{
            backgroundImage: backgroundUrl ? `url(${backgroundUrl})` : undefined,
            backgroundPosition: `center ${value.backgroundPosition}`,
          }}
        >
          <div className='absolute inset-0' style={{ background: `rgba(16,13,32,${value.overlay})` }} />
          <div className='relative p-5 text-slate-950'>
            <div className='font-serif text-4xl tracking-[-0.07em]'>{value.title}</div>
            <div className='ml-32 mt-1 text-xs'>{value.subtitle}</div>
            {['Karin Core', 'Agent Skills', 'Plugin Commands'].map((name, section) => (
              <div key={name} className='mt-4 overflow-hidden rounded-xl border border-white/60 bg-white/65 shadow-lg backdrop-blur'>
                <div className='border-b border-slate-500/20 bg-white/55 px-3 py-2 text-sm font-bold text-sky-600'>{name}</div>
                <div className='grid grid-cols-3'>
                  {[0, 1, 2].map(index => (
                    <div key={index} className='flex min-h-16 gap-2 border-r border-slate-500/15 p-2 last:border-r-0'>
                      <span className='grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-sky-400 to-violet-500 text-[9px] font-bold text-white'>
                        {section + 1}{index + 1}
                      </span>
                      <span>
                        <span className='block text-xs font-bold text-sky-600'>命令名称</span>
                        <span className='block text-[9px] text-slate-700'>#友好用法</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className='space-y-4'>
          <Input
            label='标题'
            value={value.title}
            onValueChange={title => setValue({ ...value, title })}
          />
          <Input
            label='副标题'
            value={value.subtitle}
            onValueChange={subtitle => setValue({ ...value, subtitle })}
          />
          <label className='block text-xs text-default-500'>
            背景位置
            <select
              value={value.backgroundPosition}
              onChange={event => setValue({
                ...value,
                backgroundPosition: event.target.value as HelpAppearance['backgroundPosition'],
              })}
              className='mt-1 w-full rounded-xl border border-default-200 bg-default-50 p-3 text-sm'
            >
              <option value='top'>顶部</option>
              <option value='center'>居中</option>
              <option value='bottom'>底部</option>
            </select>
          </label>
          <label className='block text-xs text-default-500'>
            <span className='mb-2 flex justify-between'>
              <span>背景遮罩</span><span>{Math.round(value.overlay * 100)}%</span>
            </span>
            <input
              type='range'
              min='0'
              max='0.75'
              step='0.01'
              value={value.overlay}
              onChange={event => setValue({ ...value, overlay: Number(event.target.value) })}
              className='w-full accent-primary'
            />
          </label>
          <p className='rounded-2xl bg-warning/10 p-3 text-xs leading-5 text-warning-700'>
            背景文件保存在 Karin 数据目录。不会从 Lycoris 项目复制受版权限制的图片。
          </p>
        </div>
      </div>
    </section>
  )
}

export default function AppearancePage () {
  const {
    appearance,
    previewAppearance,
    cancelPreview,
    saveAppearance,
    setActiveTheme,
    setMode,
  } = useTheme()
  const [draft, setDraft] = useState<WebUIAppearanceConfig>(() => structuredClone(appearance))
  const [selectedId, setSelectedId] = useState(appearance.activeThemeId)
  const [paletteMode, setPaletteMode] = useState<'light' | 'dark'>('light')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setDraft(structuredClone(appearance))
    setSelectedId(appearance.activeThemeId)
  }, [appearance.revision])

  const selected = draft.themes.find(theme => theme.id === selectedId) || activeThemeOf(draft)
  const palette = selected[paletteMode]
  const contrastIssues = useMemo(() => {
    const issues: string[] = []
    if (contrast(palette.foreground, palette.background) < 4.5) {
      issues.push('正文与背景对比度低于 4.5:1')
    }
    if (contrast(palette.primaryForeground, palette.primary) < 3) {
      issues.push('主按钮文字对比度低于 3:1')
    }
    return issues
  }, [palette])

  const updateDraft = (next: WebUIAppearanceConfig) => {
    setDraft(next)
    previewAppearance(next)
  }

  const updateSelected = (update: Partial<WebUIThemeDefinition>) => {
    updateDraft({
      ...draft,
      themes: draft.themes.map(theme =>
        theme.id === selected.id ? { ...theme, ...update } : theme
      ),
    })
  }

  const updateColor = (key: keyof WebUIThemePalette, value: string) => {
    updateSelected({
      [paletteMode]: { ...palette, [key]: value },
    })
  }

  const activate = async (id: string) => {
    setSelectedId(id)
    const persisted = appearance.themes.find(theme => theme.id === id)
    const candidate = draft.themes.find(theme => theme.id === id)
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(candidate)) {
      updateDraft({ ...draft, activeThemeId: id })
      toast('该主题包含未保存修改，请点击“保存并使用”')
      return
    }
    const previous = draft
    updateDraft({ ...draft, activeThemeId: id })
    setSaving(true)
    try {
      const saved = await setActiveTheme(id)
      setDraft(structuredClone(saved))
      toast.success('当前主题已保存')
    } catch (error) {
      setDraft(previous)
      previewAppearance(previous)
      toast.error(error instanceof Error ? error.message : '保存当前主题失败')
    } finally {
      setSaving(false)
    }
  }

  const duplicate = (theme: WebUIThemeDefinition) => {
    const copy = cloneTheme(theme)
    const next = { ...draft, themes: [...draft.themes, copy] }
    setSelectedId(copy.id)
    updateDraft(next)
  }

  const remove = (theme: WebUIThemeDefinition) => {
    if (theme.builtin) return
    const themes = draft.themes.filter(item => item.id !== theme.id)
    const activeThemeId = draft.activeThemeId === theme.id ? 'karin-bloom' : draft.activeThemeId
    setSelectedId(activeThemeId)
    updateDraft({ ...draft, themes, activeThemeId })
  }

  const save = async () => {
    if (contrastIssues.length) {
      toast.error(contrastIssues[0])
      return
    }
    setSaving(true)
    try {
      const saved = await saveAppearance(draft)
      setDraft(structuredClone(saved))
      toast.success('全局主题已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存主题失败')
    } finally {
      setSaving(false)
    }
  }

  const exportTheme = () => {
    const value = JSON.stringify(selected, null, 2)
    const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${selected.id}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const importTheme = async (file?: File) => {
    if (!file) return
    try {
      const value = JSON.parse(await file.text()) as WebUIThemeDefinition
      if (!value?.id || !value.light || !value.dark) throw new Error('主题文件结构无效')
      const copy = cloneTheme({ ...value, builtin: false })
      copy.name = value.name ? `${value.name}（导入）` : '导入主题'
      const next = { ...draft, themes: [...draft.themes, copy] }
      setSelectedId(copy.id)
      updateDraft(next)
      toast.success('主题已导入，保存后全局生效')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入主题失败')
    }
  }

  const modes: Array<{ id: WebUIColorMode, label: string, icon: typeof Sun }> = [
    { id: 'light', label: '浅色', icon: Sun },
    { id: 'dark', label: '深色', icon: Moon },
    { id: 'system', label: '跟随系统', icon: Palette },
  ]

  return (
    <div className='mx-auto w-full max-w-[1500px] pb-24'>
      <section className='mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
        <div>
          <p className='mb-2 text-xs font-medium uppercase tracking-[0.18em] text-primary'>Appearance</p>
          <h1 className='text-3xl font-semibold tracking-[-0.04em] sm:text-4xl'>让 Karin 看起来像你的工作空间</h1>
          <p className='mt-2 max-w-2xl text-sm leading-6 text-default-500'>
            Classic 永远保留原版外观。复制任意内置主题后，可以安全调整颜色、圆角和密度。
          </p>
        </div>
        <div className='flex flex-wrap gap-2'>
          {modes.map(mode => (
            <Button
              key={mode.id}
              variant={draft.mode === mode.id ? 'solid' : 'flat'}
              color={draft.mode === mode.id ? 'primary' : 'default'}
              startContent={<mode.icon size={15} />}
              onPress={async () => {
                const previous = draft
                updateDraft({ ...draft, mode: mode.id })
                setSaving(true)
                try {
                  const saved = await setMode(mode.id)
                  setDraft(value => ({
                    ...value,
                    mode: saved.mode,
                    revision: saved.revision,
                  }))
                  previewAppearance({ ...draft, mode: saved.mode, revision: saved.revision })
                } catch (error) {
                  setDraft(previous)
                  previewAppearance(previous)
                  toast.error(error instanceof Error ? error.message : '保存主题模式失败')
                } finally {
                  setSaving(false)
                }
              }}
            >
              {mode.label}
            </Button>
          ))}
        </div>
      </section>

      <div className='grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]'>
        <aside className='space-y-3'>
          <div className='flex items-center justify-between'>
            <h2 className='text-sm font-semibold'>主题库</h2>
            <label className='cursor-pointer rounded-xl p-2 text-default-500 hover:bg-default-100'>
              <Upload size={16} />
              <input
                type='file'
                accept='application/json'
                className='hidden'
                onChange={event => {
                  importTheme(event.target.files?.[0])
                }}
              />
            </label>
          </div>
          {draft.themes.map(theme => (
            <button
              key={theme.id}
              type='button'
              onClick={() => setSelectedId(theme.id)}
              className={clsx(
                'w-full rounded-[20px] border p-3 text-left transition-colors',
                selected.id === theme.id
                  ? 'border-primary bg-primary/8'
                  : 'border-border bg-card/70 hover:border-primary/40'
              )}
            >
              <div className='mb-3 flex gap-1.5'>
                {[theme.light.background, theme.light.primary, theme.light.accent, theme.dark.background].map(color => (
                  <span key={color} className='h-5 flex-1 rounded-full' style={{ backgroundColor: color }} />
                ))}
              </div>
              <div className='flex items-center gap-2'>
                <span className='min-w-0 flex-1 truncate text-sm font-semibold'>{theme.name}</span>
                {draft.activeThemeId === theme.id && <Check size={15} className='text-primary' />}
              </div>
              <div className='mt-1 text-[11px] text-default-400'>
                {theme.builtin ? '内置主题' : '自定义主题'} · {theme.skin === 'classic' ? 'Classic' : 'Bloom'}
              </div>
            </button>
          ))}
          <Button
            fullWidth
            variant='flat'
            startContent={<Plus size={16} />}
            onPress={() => duplicate(selected)}
          >
            复制为新主题
          </Button>
        </aside>

        <main className='min-w-0 space-y-5'>
          <section className='rounded-[28px] border border-border bg-card/80 p-4 shadow-sm sm:p-6'>
            <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
              <div className='min-w-0 flex-1'>
                {selected.builtin
                  ? (
                    <>
                      <h2 className='truncate text-xl font-semibold'>{selected.name}</h2>
                      <p className='mt-1 text-xs text-default-500'>内置主题不可修改，复制后即可自定义。</p>
                    </>
                  )
                  : (
                    <Input
                      label='主题名称'
                      value={selected.name}
                      onValueChange={name => updateSelected({ name })}
                      className='max-w-md'
                    />
                  )}
              </div>
              <div className='flex flex-wrap gap-2'>
                <Button
                  color='primary'
                  variant={draft.activeThemeId === selected.id ? 'flat' : 'solid'}
                  isLoading={saving}
                  isDisabled={draft.activeThemeId === selected.id}
                  onPress={() => {
                    if (draft.activeThemeId === selected.id) return
                    activate(selected.id)
                  }}
                >
                  {draft.activeThemeId === selected.id ? '当前使用' : '设为当前主题'}
                </Button>
                <Button isIconOnly variant='flat' aria-label='导出主题' onPress={exportTheme}>
                  <Download size={16} />
                </Button>
                {!selected.builtin && (
                  <Button
                    isIconOnly
                    color='danger'
                    variant='flat'
                    aria-label='删除主题'
                    onPress={() => remove(selected)}
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
            </div>
          </section>

          <section className='grid gap-5 2xl:grid-cols-[minmax(0,1fr)_360px]'>
            <div className='rounded-[28px] border border-border bg-card/80 p-4 sm:p-6'>
              <div className='mb-5 flex items-center justify-between gap-3'>
                <h2 className='text-sm font-semibold'>语义颜色</h2>
                <div className='flex rounded-xl bg-default-100 p-1'>
                  {(['light', 'dark'] as const).map(mode => (
                    <button
                      key={mode}
                      type='button'
                      onClick={() => setPaletteMode(mode)}
                      className={clsx(
                        'rounded-lg px-3 py-1.5 text-xs',
                        paletteMode === mode && 'bg-card font-medium shadow-sm'
                      )}
                    >
                      {mode === 'light' ? '浅色配色' : '深色配色'}
                    </button>
                  ))}
                </div>
              </div>
              <div className={clsx('grid gap-3 sm:grid-cols-2', selected.builtin && 'pointer-events-none opacity-65')}>
                {paletteFields.map(field => (
                  <ColorField
                    key={field.key}
                    label={field.label}
                    value={palette[field.key]}
                    onChange={value => updateColor(field.key, value)}
                  />
                ))}
              </div>
              {!!contrastIssues.length && (
                <div className='mt-4 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger'>
                  {contrastIssues.join('；')}
                </div>
              )}
            </div>

            <div className='space-y-5'>
              <section className='rounded-[28px] border border-border bg-card/80 p-5'>
                <h2 className='mb-4 text-sm font-semibold'>形状与密度</h2>
                <label className={clsx('block', selected.builtin && 'pointer-events-none opacity-65')}>
                  <span className='mb-2 flex justify-between text-xs text-default-500'>
                    <span>圆角</span><span>{selected.radius}px</span>
                  </span>
                  <input
                    type='range'
                    min='0'
                    max='32'
                    value={selected.radius}
                    onChange={event => updateSelected({ radius: Number(event.target.value) })}
                    className='w-full accent-primary'
                  />
                </label>
                <div className={clsx('mt-4 grid grid-cols-3 gap-2', selected.builtin && 'pointer-events-none opacity-65')}>
                  {(['compact', 'comfortable', 'spacious'] as const).map(density => (
                    <button
                      key={density}
                      type='button'
                      onClick={() => updateSelected({ density })}
                      className={clsx(
                        'rounded-xl px-2 py-2 text-[11px]',
                        selected.density === density ? 'bg-primary text-primary-foreground' : 'bg-default-100'
                      )}
                    >
                      {{ compact: '紧凑', comfortable: '舒适', spacious: '宽松' }[density]}
                    </button>
                  ))}
                </div>
              </section>

              <section
                className='overflow-hidden rounded-[28px] border p-4'
                style={{
                  backgroundColor: palette.background,
                  borderColor: palette.border,
                  color: palette.foreground,
                }}
              >
                <div className='mb-4 flex items-center gap-2'>
                  <span className='h-8 w-8 rounded-xl' style={{ backgroundColor: palette.primary }} />
                  <div>
                    <div className='text-sm font-semibold'>实时预览</div>
                    <div className='text-[10px]' style={{ color: palette.mutedForeground }}>Agent workspace</div>
                  </div>
                </div>
                <div className='space-y-3 rounded-2xl p-3' style={{ backgroundColor: palette.surface }}>
                  <div className='rounded-xl px-3 py-2 text-xs' style={{ backgroundColor: palette.primary, color: palette.primaryForeground }}>
                    让 Agent 检查当前运行状态
                  </div>
                  <div className='rounded-xl border px-3 py-2 text-xs' style={{ borderColor: palette.border }}>
                    正在调用 karin.host.inspect · 2 秒
                  </div>
                  <code className='block rounded-xl p-3 text-[11px]' style={{ backgroundColor: palette.codeBackground }}>
                    status: healthy
                  </code>
                </div>
              </section>
            </div>
          </section>
        </main>
      </div>
      <HelpAppearancePanel />

      <div className='fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-border bg-card/90 p-2 shadow-xl backdrop-blur-xl'>
        <Button
          variant='flat'
          startContent={<RotateCcw size={15} />}
          onPress={() => {
            setDraft(structuredClone(appearance))
            setSelectedId(appearance.activeThemeId)
            cancelPreview()
          }}
        >
          放弃更改
        </Button>
        <Button
          color='primary'
          isLoading={saving}
          isDisabled={contrastIssues.length > 0}
          startContent={!saving && <Save size={15} />}
          onPress={save}
        >
          保存并使用
        </Button>
      </div>
    </div>
  )
}
