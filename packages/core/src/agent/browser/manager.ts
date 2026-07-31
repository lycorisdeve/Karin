import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import dns from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { karinPathTemp } from '@/root'

import type { Browser, BrowserContext, Page } from 'playwright'

interface BrowserSession {
  browser: Browser
  context: BrowserContext
  page: Page
}

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

  private async session (threadId: string) {
    const existing = this.sessions.get(threadId)
    if (existing) return existing
    const { chromium } = await import('playwright')
    let browser: Browser
    try {
      browser = await chromium.launch({ headless: true })
    } catch (error) {
      throw new Error(
        'Playwright Chromium 启动失败，请先执行 pnpm exec playwright install chromium',
        { cause: error }
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

  async search (threadId: string, query: string, limit = 8) {
    const normalized = query.trim().slice(0, 500)
    if (!normalized) throw new Error('搜索词不能为空')
    const url = `https://www.bing.com/search?q=${encodeURIComponent(normalized)}`
    const { page } = await this.session(threadId)
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    const results = await page.locator('li.b_algo').evaluateAll((elements, maximum) =>
      elements.slice(0, Number(maximum)).map(element => {
        const anchor = element.querySelector('h2 a') as HTMLAnchorElement | null
        const snippet = element.querySelector('.b_caption p')
        return {
          title: (anchor?.textContent || '').trim().slice(0, 300),
          url: anchor?.href || '',
          snippet: (snippet?.textContent || '').trim().slice(0, 1000),
        }
      }).filter(item => item.title && item.url),
    Math.max(1, Math.min(limit, 20)))
    return {
      query: normalized,
      engine: 'bing',
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

  async screenshot (threadId: string, fullPage = false) {
    const { page } = await this.session(threadId)
    const safeThread = threadId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    const directory = path.join(this.directory, safeThread)
    await fs.promises.mkdir(directory, { recursive: true })
    const filename = path.join(directory, `${Date.now()}.png`)
    await page.screenshot({ path: filename, fullPage })
    return { path: filename, url: page.url() }
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
