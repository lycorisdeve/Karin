import path from 'node:path'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { segment } from '@/utils/message'
import { resolveChannelImage } from '@/adapter/channels/media'

import type { Elements, SendMessage } from '@/types/segment'

interface MarkdownPoint {
  offset?: number
}

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  alt?: string
  ordered?: boolean
  start?: number
  checked?: boolean | null
  children?: MarkdownNode[]
  position?: {
    start: MarkdownPoint
    end: MarkdownPoint
  }
}

interface ImageToken {
  start: number
  end: number
  source: string
  alt: string
}

const markdown = unified().use(remarkParse).use(remarkGfm)
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

export const agentImageElement = async (value: string) => {
  const image = await resolveChannelImage(value)
  return segment.image(`base64://${image.buffer.toString('base64')}`)
}

const renderInline = (node: MarkdownNode): string => {
  const children = () => (node.children || []).map(renderInline).join('')
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value || ''
    case 'break':
      return '\n'
    case 'link': {
      const label = children().trim() || node.url || ''
      return node.url && label !== node.url ? `${label}（${node.url}）` : label
    }
    case 'image':
      return node.alt || '图片'
    case 'html':
      return node.value || ''
    default:
      return children()
  }
}

const renderBlock = (node: MarkdownNode): string => {
  const blocks = () => (node.children || []).map(renderBlock).filter(Boolean)
  switch (node.type) {
    case 'root':
      return blocks().join('\n\n')
    case 'paragraph':
    case 'heading':
    case 'tableCell':
      return (node.children || []).map(renderInline).join('')
    case 'blockquote':
      return blocks().join('\n')
    case 'code':
      return node.value || ''
    case 'html':
      return node.value || ''
    case 'thematicBreak':
    case 'definition':
      return ''
    case 'list': {
      const start = node.start || 1
      return (node.children || []).map((item, index) => {
        const value = renderBlock(item)
        const marker = node.ordered ? `${start + index}. ` : '• '
        return `${marker}${value.replace(/\n/g, '\n  ')}`
      }).join('\n')
    }
    case 'listItem': {
      const value = blocks().join('\n')
      if (node.checked === true) return `[x] ${value}`
      if (node.checked === false) return `[ ] ${value}`
      return value
    }
    case 'table':
      return blocks().join('\n')
    case 'tableRow':
      return (node.children || []).map(renderBlock).join(' ｜ ')
    default:
      if (node.children?.length) return blocks().join('\n')
      return renderInline(node)
  }
}

const fallbackReadableText = (value: string) =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export const markdownToReadableText = (value: string) => {
  try {
    return renderBlock(markdown.parse(value) as MarkdownNode)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return fallbackReadableText(value)
  }
}

const offsets = (node: MarkdownNode) => {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null
}

const imageSource = (content: string, node: MarkdownNode, range: { start: number; end: number }) => {
  const raw = content.slice(range.start, range.end)
  const destinationStart = raw.indexOf('](')
  if (destinationStart === -1 || !raw.endsWith(')')) return node.url || ''
  let destination = raw.slice(destinationStart + 2, -1).trim()
  const title = destination.match(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/)
  if (title) destination = destination.slice(0, title.index).trim()
  if (destination.startsWith('<') && destination.endsWith('>')) {
    destination = destination.slice(1, -1)
  }
  return destination.startsWith('file:') || path.isAbsolute(destination)
    ? destination
    : node.url || destination
}

const isStandaloneImageUrl = (content: string, node: MarkdownNode) => {
  if (!node.url || !/^https?:\/\//i.test(node.url)) return null
  let parsed: URL
  try {
    parsed = new URL(node.url)
  } catch {
    return null
  }
  if (!imageExtensions.has(path.extname(parsed.pathname).toLowerCase())) return null
  const range = offsets(node)
  if (!range) return null
  const lineStart = content.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1
  const nextBreak = content.indexOf('\n', range.end)
  const lineEnd = nextBreak === -1 ? content.length : nextBreak
  const line = content.slice(lineStart, lineEnd).trim()
  if (line !== node.url && line !== `<${node.url}>`) return null
  return {
    start: lineStart,
    end: lineEnd,
    source: node.url,
    alt: '图片',
  } satisfies ImageToken
}

const imageTokens = (content: string) => {
  const tokens: ImageToken[] = []
  const walk = (node: MarkdownNode) => {
    const range = offsets(node)
    if (node.type === 'image' && node.url && range) {
      tokens.push({
        ...range,
        source: imageSource(content, node, range),
        alt: node.alt?.trim() || '图片',
      })
    } else if (node.type === 'link') {
      const token = isStandaloneImageUrl(content, node)
      if (token) tokens.push(token)
    }
    node.children?.forEach(walk)
  }
  walk(markdown.parse(content) as MarkdownNode)
  return tokens
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce<ImageToken[]>((result, token) => {
      if (!result.length || token.start >= result[result.length - 1].end) result.push(token)
      return result
    }, [])
}

/**
 * 只用于 Agent 产生的内容。普通插件仍沿用原有消息发送接口。
 */
export const agentMessageElements = async (content: string): Promise<Elements[]> => {
  const elements: Elements[] = []
  let offset = 0
  let imageCount = 0
  let imageBytes = 0

  for (const token of imageTokens(content)) {
    const text = markdownToReadableText(content.slice(offset, token.start))
    if (text) elements.push(segment.text(text))
    try {
      if (imageCount >= 4) throw new Error('单条消息最多发送 4 张图片')
      const image = await agentImageElement(token.source)
      const bytes = Buffer.from(image.file.slice('base64://'.length), 'base64').byteLength
      if (imageBytes + bytes > 20 * 1024 * 1024) {
        throw new Error('单条消息图片合计超过 20 MiB')
      }
      imageCount += 1
      imageBytes += bytes
      elements.push(image)
    } catch {
      elements.push(segment.text(`${token.alt}（图片地址不可安全发送：${token.source}）`))
    }
    offset = token.end
  }

  const tail = markdownToReadableText(content.slice(offset))
  if (tail) elements.push(segment.text(tail))
  return elements.length ? elements : [segment.text(markdownToReadableText(content) || content)]
}

export const agentSendMessage = async (content: string): Promise<SendMessage> =>
  agentMessageElements(content)

export interface AgentStructuredMessageElement {
  type: 'text' | 'image'
  text?: string
  source?: string
  alt?: string
}

export const agentStructuredMessage = async (
  input: AgentStructuredMessageElement[]
): Promise<SendMessage> => {
  const elements: Elements[] = []
  let imageCount = 0
  let imageBytes = 0
  for (const item of input.slice(0, 64)) {
    if (item.type === 'text') {
      const text = String(item.text || '').trim()
      if (text) elements.push(segment.text(text))
      continue
    }
    const source = String(item.source || '').trim()
    const alt = String(item.alt || '图片').trim() || '图片'
    if (!source) {
      elements.push(segment.text(`${alt}（缺少图片地址）`))
      continue
    }
    try {
      if (imageCount >= 4) throw new Error('单条消息最多发送 4 张图片')
      const image = await agentImageElement(source)
      const bytes = Buffer.from(image.file.slice('base64://'.length), 'base64').byteLength
      if (imageBytes + bytes > 20 * 1024 * 1024) {
        throw new Error('单条消息图片合计超过 20 MiB')
      }
      imageCount += 1
      imageBytes += bytes
      elements.push(image)
    } catch {
      elements.push(segment.text(`${alt}（图片地址不可安全发送：${source}）`))
    }
  }
  if (!elements.length) throw new Error('结构化消息至少需要一个有效的文字或图片元素')
  return elements
}
