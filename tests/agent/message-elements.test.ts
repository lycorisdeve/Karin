import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { karinPathTemp } from '@/root'
import {
  agentMessageElements,
  markdownToReadableText,
} from '@/agent/ingress/message-elements'
import { KarinConvertAdapter } from '@/adapter/onebot/core/convert'

const created: string[] = []
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const mockPublicImages = () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(png, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': String(png.length),
    },
  })))
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(created.splice(0).map(filename =>
    fs.rm(filename, { force: true, recursive: true })
  ))
})

describe('Agent Markdown to Karin elements', () => {
  it('converts Markdown text into readable native text', async () => {
    const elements = await agentMessageElements(
      '# 标题\n\n- **项目**\n- [官网](https://example.com)\n\n```ts\nconst ok = true\n```'
    )

    expect(elements).toEqual([{
      type: 'text',
      text: [
        '标题',
        '',
        '• 项目',
        '• 官网（https://example.com）',
        '',
        'const ok = true',
      ].join('\n'),
    }])
    expect(markdownToReadableText('| 名称 | 值 |\n| --- | --- |\n| A | B |'))
      .toBe('名称 ｜ 值\nA ｜ B')
  })

  it('preserves text and public images in their original order', async () => {
    mockPublicImages()
    const elements = await agentMessageElements(
      '第一段\n\n![封面](https://1.1.1.1/cover.png)\n\n第二段'
    )

    expect(elements.map(item => item.type)).toEqual(['text', 'image', 'text'])
    expect(elements[0]).toEqual({ type: 'text', text: '第一段' })
    expect(elements[1]).toEqual({
      type: 'image',
      file: `base64://${png.toString('base64')}`,
    })
    expect(elements[2]).toEqual({ type: 'text', text: '第二段' })

    const wire = KarinConvertAdapter(elements as never, {
      adapter: { address: 'ws://127.0.0.1:3001' },
    } as never)
    expect(wire).toEqual([
      { type: 'text', data: { text: '第一段' } },
      expect.objectContaining({
        type: 'image',
        data: expect.objectContaining({ file: `base64://${png.toString('base64')}` }),
      }),
      { type: 'text', data: { text: '第二段' } },
    ])
  })

  it('supports parenthesized Markdown images and standalone image URLs', async () => {
    mockPublicImages()
    const elements = await agentMessageElements(
      [
        '开头',
        '![结果图](https://1.1.1.1/report_(final).png "结果")',
        'https://1.1.1.1/standalone.webp?version=2',
        '[普通链接](https://1.1.1.1/not-an-inline-image.png)',
        '<img src="https://1.1.1.1/raw-html.png">',
      ].join('\n\n')
    )

    expect(elements.map(item => item.type)).toEqual(['text', 'image', 'image', 'text'])
    expect(elements[1]).toEqual({
      type: 'image',
      file: `base64://${png.toString('base64')}`,
    })
    expect(elements[2]).toEqual({
      type: 'image',
      file: `base64://${png.toString('base64')}`,
    })
    expect(JSON.stringify(elements[3])).toContain('普通链接（https://1.1.1.1/not-an-inline-image.png）')
    expect(JSON.stringify(elements[3])).toContain('<img src=')
  })

  it('falls back to text for private, invalid and unsupported image URLs', async () => {
    const elements = await agentMessageElements(
      [
        '![私网](http://127.0.0.1/a.png)',
        '![脚本](javascript:evil)',
        '![相对路径](../secret.png)',
      ].join('\n')
    )

    expect(elements).toHaveLength(3)
    expect(elements.every(item => item.type === 'text')).toBe(true)
    expect(JSON.stringify(elements)).toContain('图片地址不可安全发送')

    mockPublicImages()
    const mixed = await agentMessageElements(
      '![失败](http://127.0.0.1/a.png)\n![成功](https://1.1.1.1/b.png)'
    )
    expect(mixed.map(item => item.type)).toEqual(['text', 'image'])
  })

  it('allows local images only inside Agent controlled temporary directories', async () => {
    const allowedDirectory = path.join(karinPathTemp, 'agent-browser', 'message-test')
    const allowed = path.join(allowedDirectory, 'screen.png')
    await fs.mkdir(allowedDirectory, { recursive: true })
    await fs.writeFile(allowed, png)
    created.push(allowedDirectory)

    const outsideDirectory = await fs.mkdtemp(path.join(process.cwd(), '.tmp-agent-image-'))
    const outside = path.join(outsideDirectory, 'secret.png')
    await fs.writeFile(outside, png)
    created.push(outsideDirectory)

    const elements = await agentMessageElements(
      `![允许](${allowed})\n![拒绝](${outside})`
    )

    expect(elements[0]).toEqual({
      type: 'image',
      file: `base64://${png.toString('base64')}`,
    })
    expect(elements[1]).toEqual(expect.objectContaining({ type: 'text' }))
    expect(JSON.stringify(elements[1])).toContain('图片地址不可安全发送')
  })
})
