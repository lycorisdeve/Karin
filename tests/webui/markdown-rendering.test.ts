import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import Markdown, {
  safeMarkdownUrl,
} from '../../packages/web/src/components/Markdown'

const requireFromWeb = createRequire(new URL('../../packages/web/package.json', import.meta.url))
const React = requireFromWeb('react')
const { renderToStaticMarkup } = requireFromWeb('react-dom/server')

describe('Web Agent Markdown rendering', () => {
  it('renders GFM, highlighted code and KaTeX without enabling raw HTML', () => {
    const html = renderToStaticMarkup(React.createElement(Markdown, {
      content: [
        '# 标题',
        '',
        '- [x] 完成',
        '',
        '| 名称 | 值 |',
        '| --- | --- |',
        '| A | B |',
        '',
        '```ts',
        'const ok = true',
        '```',
        '',
        '$x^2$',
        '',
        '<script>alert(1)</script>',
      ].join('\n'),
    }))

    expect(html).toContain('<h1')
    expect(html).toContain('<table')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('hljs')
    expect(html).toContain('katex')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('routes Mermaid fences to the diagram component', () => {
    const html = renderToStaticMarkup(React.createElement(Markdown, {
      content: '```mermaid\ngraph TD\nA-->B\n```',
    }))

    expect(html).toContain('正在渲染图表')
    expect(html).not.toContain('language-mermaid')
  })

  it('rejects unsafe link and image protocols', () => {
    expect(safeMarkdownUrl('javascript:alert(1)', 'href', { tagName: 'a' })).toBe('')
    expect(safeMarkdownUrl('file:///tmp/a.png', 'src', { tagName: 'img' })).toBe('')
    expect(safeMarkdownUrl('data:image/png;base64,AA==', 'src', { tagName: 'img' })).toBe('')
    expect(safeMarkdownUrl('https://example.com/a.png', 'src', { tagName: 'img' }))
      .toBe('https://example.com/a.png')
    expect(safeMarkdownUrl('/api/v1/agent/media/a.png', 'src', { tagName: 'img' }))
      .toBe('/api/v1/agent/media/a.png')
  })
})
