import React, {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import 'highlight.js/styles/atom-one-dark.css'
import 'katex/dist/katex.min.css'

interface MarkdownProps {
  content: string
  className?: string
}

interface MarkdownElement {
  tagName?: string
}

const safeInternalImage = /^\/(?:web\/|api\/v1\/agent\/media\/)/
const safeLinkProtocol = /^(?:https?:|mailto:)/i
const safeImageProtocol = /^https?:/i
let mermaidLoader: Promise<(typeof import('mermaid'))['default']> | undefined

const loadMermaid = () => {
  mermaidLoader ||= import('mermaid').then(module => module.default)
  return mermaidLoader
}

export const safeMarkdownUrl = (
  value: string,
  _key: string,
  node: MarkdownElement
) => {
  const url = value.trim()
  if (!url) return ''
  if (node.tagName === 'img') {
    return safeImageProtocol.test(url) || safeInternalImage.test(url) ? url : ''
  }
  if (safeLinkProtocol.test(url) || url.startsWith('/') || url.startsWith('#')) return url
  return ''
}

const textContent = (value: ReactNode): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textContent).join('')
  if (React.isValidElement<{ children?: ReactNode }>(value)) {
    return textContent(value.props.children)
  }
  return ''
}

const SafeImage = ({
  src,
  alt,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) => {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return <span className='text-default-500'>〔图片无法显示：{alt || '未命名图片'}〕</span>
  }
  return (
    <img
      {...props}
      src={src}
      alt={alt || ''}
      loading='lazy'
      referrerPolicy='no-referrer'
      onError={() => setFailed(true)}
      className='my-3 max-h-[32rem] max-w-full rounded-xl border border-default-200 object-contain'
    />
  )
}

const MermaidDiagram = ({ source }: { source: string }) => {
  const reactId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState('')
  const [failed, setFailed] = useState(false)
  const diagramId = useMemo(
    () => `karin-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId]
  )

  useEffect(() => {
    let active = true
    setRendered('')
    setFailed(false)
    loadMermaid()
      .then(instance => {
        instance.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
          suppressErrorRendering: true,
        })
        return instance.render(diagramId, source)
      })
      .then(result => {
        if (!active) return
        setRendered(result.svg)
        requestAnimationFrame(() => {
          if (active && containerRef.current) result.bindFunctions?.(containerRef.current)
        })
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [diagramId, source])

  if (failed) {
    return (
      <pre className='overflow-x-auto rounded-lg border border-default-200 bg-default-100 p-3 text-xs'>
        <code>{source}</code>
      </pre>
    )
  }
  if (!rendered) {
    return (
      <div className='rounded-lg border border-default-200 bg-default-50 p-3 text-xs text-default-500'>
        正在渲染图表…
      </div>
    )
  }
  return (
    <div
      ref={containerRef}
      className='my-3 overflow-x-auto rounded-xl border border-default-200 bg-content1 p-3 [&_svg]:mx-auto [&_svg]:max-w-full'
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  )
}

const CodeBlock = ({
  children,
  ...props
}: React.HTMLAttributes<HTMLPreElement>) => {
  const [copied, setCopied] = useState(false)
  const onlyChild = React.Children.count(children) === 1
    ? React.Children.toArray(children)[0]
    : null
  const codeElement = React.isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)
    ? onlyChild
    : null
  const language = codeElement?.props.className?.match(/language-([\w-]+)/)?.[1] || ''
  const source = textContent(codeElement?.props.children ?? children).replace(/\n$/, '')

  if (language === 'mermaid') return <MermaidDiagram source={source} />

  const copy = async () => {
    await navigator.clipboard.writeText(source)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className='group/code relative my-3 overflow-hidden rounded-xl border border-default-200 bg-[#282c34]'>
      <div className='flex min-h-8 items-center justify-between border-b border-white/10 px-3 text-[11px] text-zinc-300'>
        <span>{language || 'text'}</span>
        <button
          type='button'
          onClick={copy}
          className='inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-white/10'
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre {...props} className='overflow-x-auto p-3 text-xs leading-5 text-zinc-100'>
        {children}
      </pre>
    </div>
  )
}

const Markdown = memo(({ content, className = '' }: MarkdownProps) => (
  <div className={`karin-markdown min-w-0 break-words ${className}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        rehypeHighlight,
        [rehypeKatex, { trust: false, strict: 'warn', throwOnError: false }],
      ]}
      urlTransform={safeMarkdownUrl}
      components={{
        h1: ({ node: _node, ...props }) => (
          <h1 className='mb-2 mt-4 text-2xl font-bold text-foreground first:mt-0' {...props} />
        ),
        h2: ({ node: _node, ...props }) => (
          <h2 className='mb-2 mt-4 text-xl font-bold text-foreground first:mt-0' {...props} />
        ),
        h3: ({ node: _node, ...props }) => (
          <h3 className='mb-1.5 mt-3 text-lg font-semibold text-foreground first:mt-0' {...props} />
        ),
        h4: ({ node: _node, ...props }) => (
          <h4 className='mb-1 mt-3 font-semibold text-foreground first:mt-0' {...props} />
        ),
        p: ({ node: _node, ...props }) => (
          <p className='my-2 whitespace-pre-wrap text-foreground first:mt-0 last:mb-0' {...props} />
        ),
        a: ({ node: _node, ...props }) => (
          <a
            className='text-primary underline-offset-2 hover:underline'
            target='_blank'
            rel='noopener noreferrer'
            {...props}
          />
        ),
        img: ({ node: _node, ...props }) => <SafeImage {...props} />,
        ul: ({ node: _node, ...props }) => (
          <ul className='my-2 list-outside list-disc space-y-1 pl-5 text-foreground' {...props} />
        ),
        ol: ({ node: _node, ...props }) => (
          <ol className='my-2 list-outside list-decimal space-y-1 pl-5 text-foreground' {...props} />
        ),
        li: ({ node: _node, ...props }) => <li className='pl-1 text-foreground' {...props} />,
        blockquote: ({ node: _node, ...props }) => (
          <blockquote
            className='my-3 rounded-r-lg border-l-4 border-primary/40 bg-default-100 px-4 py-2 text-foreground/80'
            {...props}
          />
        ),
        code: ({ node: _node, className, ...props }) => (
          <code
            className={
              className ||
              'rounded border border-default-200 bg-default-100 px-1.5 py-0.5 font-mono text-[0.9em]'
            }
            {...props}
          />
        ),
        pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
        table: ({ node: _node, ...props }) => (
          <div className='my-3 overflow-x-auto rounded-lg border border-default-200'>
            <table className='w-full border-collapse text-left text-sm' {...props} />
          </div>
        ),
        thead: ({ node: _node, ...props }) => <thead className='bg-default-100' {...props} />,
        th: ({ node: _node, ...props }) => (
          <th className='border-b border-default-200 px-3 py-2 font-semibold' {...props} />
        ),
        td: ({ node: _node, ...props }) => (
          <td className='border-b border-default-100 px-3 py-2 align-top' {...props} />
        ),
        hr: ({ node: _node, ...props }) => (
          <hr className='my-4 border-default-200' {...props} />
        ),
        input: ({ node: _node, ...props }) => (
          <input className='mr-1.5 align-middle accent-primary' disabled {...props} />
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
))

Markdown.displayName = 'Markdown'

export default Markdown
