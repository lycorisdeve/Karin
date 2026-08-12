import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import {
  AgentBrowserManager,
  browserLaunchCandidates,
} from '../../packages/core/src/agent/browser/manager'
import {
  registerRender,
  unregisterRender,
} from '../../packages/core/src/adapter/render/admin/cache'

const launch = vi.hoisted(() => vi.fn())

vi.mock('playwright', () => ({
  chromium: { launch },
}))

afterEach(() => {
  launch.mockReset()
  vi.unstubAllGlobals()
})

describe('Agent browser manager', () => {
  it('keeps basic web search available without a Playwright browser binary', async () => {
    launch.mockRejectedValue(new Error('Executable does not exist'))
    const fetchMock = vi.fn(async () => new Response(`<?xml version="1.0"?>
      <rss><channel><item>
        <title>Karin &amp; Browser</title>
        <link>https://example.com/karin</link>
        <description>Cross-platform search result</description>
      </item></channel></rss>`, {
      headers: { 'content-type': 'application/rss+xml' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new AgentBrowserManager().search('thread-1', 'karin browser', 5)

    expect(result).toMatchObject({
      query: 'karin browser',
      engine: 'bing-rss',
      results: [{
        title: 'Karin & Browser',
        url: 'https://example.com/karin',
        snippet: 'Cross-platform search result',
      }],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(launch).not.toHaveBeenCalled()
  })

  it('discovers system browser fallbacks on Windows, macOS and Linux', () => {
    const windows = browserLaunchCandidates(
      'win32',
      { PROGRAMFILES: 'C:\\Program Files' },
      value => value.endsWith('msedge.exe')
    )
    const macos = browserLaunchCandidates('darwin', {}, value => value.includes('Google Chrome'))
    const linux = browserLaunchCandidates('linux', {}, value => value === '/usr/bin/chromium')

    expect(windows.map(item => item.label)).toEqual(expect.arrayContaining([
      'playwright-chromium',
      'system-edge',
      'system-chrome',
      'edge-program-files',
    ]))
    expect(macos.some(item => item.options.executablePath?.includes('Google Chrome'))).toBe(true)
    expect(linux.some(item => item.options.executablePath === '/usr/bin/chromium')).toBe(true)
  })

  it('uses the existing Karin renderer for URL screenshots', async () => {
    vi.stubGlobal('logger', {
      mark: vi.fn(),
      error: vi.fn(),
      green: (value: string) => value,
      yellow: (value: string) => value,
    })
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const render = vi.fn(async () => png)
    const index = registerRender('puppeteer', render)
    const browser = new AgentBrowserManager()
    let filename = ''
    try {
      const result = await browser.screenshot('thread-render', false, 'https://1.1.1.1')
      filename = result.path

      expect(render).toHaveBeenCalledOnce()
      expect(render.mock.calls[0][0]).toMatchObject({
        file: 'https://1.1.1.1/',
        type: 'png',
        fullPage: false,
      })
      expect((await fs.readFile(filename)).subarray(1, 4).toString('ascii')).toBe('PNG')
      expect(result).toMatchObject({ renderer: 'karin', url: 'https://1.1.1.1/' })
    } finally {
      await browser.closeAll()
      unregisterRender(index)
      if (filename) await fs.unlink(filename).catch(() => undefined)
    }
  })
})
