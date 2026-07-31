import { describe, expect, it } from 'vitest'
import { agentModelContent } from '../../packages/core/src/agent/ingress/model-content'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

describe('Agent multimodal model content', () => {
  it('converts validated images into ordered OpenAI-compatible content parts', async () => {
    await expect(agentModelContent(
      '看看这张图',
      [`base64://${png.toString('base64')}`],
      true
    )).resolves.toEqual([
      { type: 'text', text: '看看这张图' },
      {
        type: 'image',
        imageUrl: `data:image/png;base64,${png.toString('base64')}`,
      },
    ])
  })

  it('uses explicit placeholders when vision is disabled or an image is unsafe', async () => {
    await expect(agentModelContent(
      '请描述',
      ['https://127.0.0.1/private.png'],
      false
    )).resolves.toContain('当前模型未启用视觉输入')

    const unsafe = await agentModelContent(
      '请描述',
      ['https://127.0.0.1/private.png'],
      true
    )
    expect(unsafe).toEqual([
      { type: 'text', text: '请描述' },
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('无法作为视觉输入'),
      }),
    ])
  })
})
