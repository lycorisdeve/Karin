import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import dns from 'node:dns/promises'
import { createHash, randomUUID } from 'node:crypto'
import { karinPathTemp } from '@/root'
import { callRender, getRenderCount } from '@/adapter/render/admin/cache'

import type { Browser, BrowserContext, Page } from 'playwright'

interface BrowserSession {
  browser: Browser
  context: BrowserContext
  page: Page
}

interface ManagedBrowserLaunchOptions {
  headless: true
  channel?: 'chrome' | 'msedge'
  executablePath?: string
}

interface BrowserLaunchCandidate {
  label: string
  options: ManagedBrowserLaunchOptions
}

const existingExecutable = (
  label: string,
  executablePath: string | undefined,
  exists: (value: string) => boolean
): BrowserLaunchCandidate | null => executablePath && exists(executablePath)
  ? { label, options: { headless: true, executablePath } }
  : null

export const browserLaunchCandidates = (
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (value: string) => boolean = fs.existsSync
): BrowserLaunchCandidate[] => {
  const values: Array<BrowserLaunchCandidate | null> = [
    { label: 'playwright-chromium', options: { headless: true } },
  ]
  const custom = String(environment.KARIN_AGENT_BROWSER_EXECUTABLE || '').trim()
  if (custom) values.push(existingExecutable('configured-executable', custom, exists))

  if (platform === 'win32') {
    values.push(
      { label: 'system-edge', options: { headless: true, channel: 'msedge' } },
      { label: 'system-chrome', options: { headless: true, channel: 'chrome' } },
      existingExecutable(
        'edge-program-files',
        environment.PROGRAMFILES
          ? path.join(environment.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
          : undefined,
        exists
      ),
      existingExecutable(
        'chrome-program-files',
        environment.PROGRAMFILES
          ? path.join(environment.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
          : undefined,
        exists
      ),
      existingExecutable(
        'chrome-local-app-data',
        environment.LOCALAPPDATA
          ? path.join(environment.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
          : undefined,
        exists
      )
    )
  } else if (platform === 'darwin') {
    values.push(
      { label: 'system-chrome', options: { headless: true, channel: 'chrome' } },
      { label: 'system-edge', options: { headless: true, channel: 'msedge' } },
      existingExecutable(
        'macos-chrome',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        exists
      ),
      existingExecutable(
        'macos-edge',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        exists
      )
    )
  } else {
    values.push(
      { label: 'system-chrome', options: { headless: true, channel: 'chrome' } },
      { label: 'system-edge', options: { headless: true, channel: 'msedge' } },
      ...[
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
      ].map(value => existingExecutable(`system-executable:${value}`, value, exists))
    )
  }

  const seen = new Set<string>()
  return values.filter((value): value is BrowserLaunchCandidate => Boolean(value)).filter(value => {
    const key = JSON.stringify(value.options)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const decodeXml = (value: string) => value
  .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1')
  .replace(/&#(x?[0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(
    code.toLowerCase().startsWith('x')
      ? Number.parseInt(code.slice(1), 16)
      : Number.parseInt(code, 10)
  ))
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&apos;/gi, "'")
  .replace(/&amp;/gi, '&')

const xmlField = (value: string, name: string) => {
  const match = value.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return decodeXml(match?.[1]?.trim() || '')
}

const stripMarkup = (value: string) => decodeXml(value.replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ')
  .trim()

const parseBingRss = (value: string, limit: number) => [...value.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
  .slice(0, limit)
  .map(match => ({
    title: stripMarkup(xmlField(match[1], 'title')).slice(0, 300),
    url: xmlField(match[1], 'link').slice(0, 2048),
    snippet: stripMarkup(xmlField(match[1], 'description')).slice(0, 1000),
  }))
  .filter(item => {
    if (!item.title) return false
    try {
      return ['http:', 'https:'].includes(new URL(item.url).protocol)
    } catch {
      return false
    }
  })

const privateIpv4 = (address: string) => {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
  )
}

const privateAddress = (address: string) => {
  if (net.isIPv4(address)) return privateIpv4(address)
  if (!net.isIPv6(address)) return true
  const normalized = address.toLowerCase()
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
  )
}

export const assertPublicUrl = async (value: string) => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('浏览器只允许 HTTP 或 HTTPS URL')
  }
  if (url.username || url.password) throw new Error('URL 不得包含认证信息')
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new Error('浏览器默认禁止访问本机、私网和云元数据地址')
  }
  if (net.isIP(hostname)) {
    if (privateAddress(hostname)) throw new Error('浏览器默认禁止访问私网地址')
    return url
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  if (!records.length || records.some(record => privateAddress(record.address))) {
    throw new Error('域名解析到私网或不可用地址')
  }
  return url
}

export class AgentBrowserManager {
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly directory = path.join(karinPathTemp, 'agent-browser')

  private async renderScreenshot (threadId: string, url: URL, fullPage: boolean) {
    const rendered = await callRender({
      file: url.toString(),
      name: 'agent-browser',
      type: 'png',
      fullPage,
      pageGotoParams: {
        waitUntil: 'networkidle2',
        timeout: 30_000,
      },
    })
    if (Array.isArray(rendered)) throw new Error('Karin 渲染器返回了非预期的多图结果')

    const encoded = rendered
      .replace(/^base64:\/\//, '')
      .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
    const buffer = Buffer.from(encoded, 'base64')
    if (buffer.byteLength === 0) throw new Error('Karin 渲染器返回了空图片')
    if (buffer.byteLength > 10 * 1024 * 1024) throw new Error('Karin 渲染器截图超过 10 MiB 限制')
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error('Karin 渲染器返回的内容不是有效 PNG 图片')
    }

    const safeThread = threadId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    const directory = path.join(this.directory, safeThread)
    await fs.promises.mkdir(directory, { recursive: true })
    const filename = path.join(directory, `${Date.now()}-${randomUUID()}.png`)
    await fs.promises.writeFile(filename, buffer, { flag: 'wx' })
    return { path: filename, url: url.toString(), renderer: 'karin' as const }
  }

  private async session (threadId: string) {
    const existing = this.sessions.get(threadId)
    if (existing) return existing
    const { chromium } = await import('playwright')
    let browser: Browser | undefined
    const failures: string[] = []
    for (const candidate of browserLaunchCandidates()) {
      try {
        browser = await chromium.launch(candidate.options)
        break
      } catch (error) {
        failures.push(`${candidate.label}: ${(error as Error).message.split('\n', 1)[0]}`)
      }
    }
    if (!browser) {
      throw new Error(
        [
          '交互式浏览器不可用：已尝试 Playwright Chromium 和系统 Chrome/Edge/Chromium。',
          '基础网页搜索和已注册的 Karin 渲染器截图仍可使用；点击与动态页面需要安装 Chromium，或设置 KARIN_AGENT_BROWSER_EXECUTABLE。',
          failures.slice(0, 3).join('；'),
        ].filter(Boolean).join(' ')
      )
    }
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 900 },
    })
    await context.route('**/*', async route => {
      try {
        await assertPublicUrl(route.request().url())
        await route.continue()
      } catch {
        await route.abort('blockedbyclient')
      }
    })
    const page = await context.newPage()
    const created = { browser, context, page }
    this.sessions.set(threadId, created)
    return created
  }

  async open (threadId: string, value: string) {
    const url = await assertPublicUrl(value)
    const { page } = await this.session(threadId)
    const response = await page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    return {
      url: page.url(),
      title: await page.title(),
      status: response?.status(),
      text: (await page.locator('body').innerText()).slice(0, 20_000),
    }
  }

  async snapshot (threadId: string) {
    const { page } = await this.session(threadId)
    const links = await page.locator('a').evaluateAll(elements =>
      elements.slice(0, 200).map(element => ({
        text: (element.textContent || '').trim().slice(0, 200),
        href: (element as HTMLAnchorElement).href,
      }))
    )
    return {
      url: page.url(),
      title: await page.title(),
      text: (await page.locator('body').innerText()).slice(0, 40_000),
      links,
    }
  }

  async search (_threadId: string, query: string, limit = 8) {
    const normalized = query.trim().slice(0, 500)
    if (!normalized) throw new Error('搜索词不能为空')
    const maximum = Math.max(1, Math.min(limit, 20))
    const url = `https://www.bing.com/search?format=rss&count=${maximum}&q=${encodeURIComponent(normalized)}`
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'user-agent': 'Karin-Agent/2.0',
      },
    })
    if (!response.ok) throw new Error(`网页搜索失败：HTTP ${response.status}`)
    const body = await response.text()
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('网页搜索响应超过 2 MiB 上限')
    const results = parseBingRss(body, maximum)
    return {
      query: normalized,
      engine: 'bing-rss',
      results,
      note: '搜索摘要仅用于发现来源；技术结论应继续打开官方文档或上游源码验证。',
    }
  }

  async click (threadId: string, selector: string) {
    const { page } = await this.session(threadId)
    await page.locator(selector).first().click({ timeout: 15_000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
    return { url: page.url(), title: await page.title() }
  }

  async type (threadId: string, selector: string, text: string, submit = false) {
    const { page } = await this.session(threadId)
    const target = page.locator(selector).first()
    await target.fill(text, { timeout: 15_000 })
    if (submit) await target.press('Enter')
    return { url: page.url(), submitted: submit }
  }

  async extract (threadId: string, selector: string) {
    const { page } = await this.session(threadId)
    const values = await page.locator(selector).evaluateAll(elements =>
      elements.slice(0, 500).map(element => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent || '').trim().slice(0, 2000),
        href: element instanceof HTMLAnchorElement ? element.href : undefined,
      }))
    )
    return { url: page.url(), values }
  }

  async screenshot (threadId: string, fullPage = false, value?: string) {
    const existing = this.sessions.get(threadId)
    const currentUrl = existing?.page.url()
    const target = value || (currentUrl?.startsWith('http') ? currentUrl : '')
    const url = target ? await assertPublicUrl(target) : undefined
    let renderError: Error | undefined

    if (url && getRenderCount() > 0) {
      try {
        return await this.renderScreenshot(threadId, url, fullPage)
      } catch (error) {
        renderError = error as Error
      }
    }

    let page: Page
    try {
      page = (existing || await this.session(threadId)).page
      if (url && page.url() !== url.toString()) {
        await page.goto(url.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        })
      }
    } catch (error) {
      if (renderError) {
        throw new Error(
          `Karin 渲染器与交互式浏览器均无法截图：${renderError.message}；${(error as Error).message}`
        )
      }
      throw error
    }

    const safeThread = threadId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    const directory = path.join(this.directory, safeThread)
    await fs.promises.mkdir(directory, { recursive: true })
    const filename = path.join(directory, `${Date.now()}-${randomUUID()}.png`)
    await page.screenshot({ path: filename, fullPage })
    return { path: filename, url: page.url(), renderer: 'interactive' as const }
  }

  async download (threadId: string, value: string) {
    const maximumBytes = 10 * 1024 * 1024
    let url = await assertPublicUrl(value)
    let response: Response | undefined

    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'Karin-Agent/2.0' },
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (!location) throw new Error('下载重定向缺少 Location')
      if (redirects === 3) throw new Error('下载重定向次数超过限制')
      url = await assertPublicUrl(new URL(location, url).toString())
    }

    if (!response?.ok) throw new Error(`下载失败：HTTP ${response?.status ?? 'unknown'}`)
    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > maximumBytes) throw new Error('下载文件超过 10 MiB 限制')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maximumBytes) throw new Error('下载文件超过 10 MiB 限制')

    const safeThread = threadId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    const directory = path.join(this.directory, safeThread, 'downloads')
    await fs.promises.mkdir(directory, { recursive: true })
    const extension = path.extname(url.pathname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12)
    const hash = createHash('sha256').update(buffer).digest('hex')
    const filename = path.join(directory, `${Date.now()}-${hash.slice(0, 12)}${extension}`)
    await fs.promises.writeFile(filename, buffer, { flag: 'wx' })
    return {
      path: filename,
      url: url.toString(),
      bytes: buffer.byteLength,
      sha256: hash,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
    }
  }

  async close (threadId: string) {
    const session = this.sessions.get(threadId)
    if (!session) return { closed: false }
    this.sessions.delete(threadId)
    await session.context.close().catch(() => undefined)
    await session.browser.close().catch(() => undefined)
    return { closed: true }
  }

  async closeAll () {
    await Promise.all([...this.sessions].map(([threadId]) => this.close(threadId)))
  }
}
