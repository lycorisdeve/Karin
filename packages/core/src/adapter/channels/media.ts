import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { karinPathHtml, karinPathTemp } from '@/root'
import { assertPublicUrl } from '@/agent/browser/manager'

const maximumBytes = 10 * 1024 * 1024
const roots = [
  path.join(karinPathTemp, 'agent-browser'),
  path.join(karinPathTemp, 'agent-images'),
  path.join(karinPathTemp, 'agent-render'),
  path.join(karinPathTemp, 'channel-media'),
  karinPathHtml,
]

const inside = (filename: string, root: string) => {
  const relative = path.relative(root, filename)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const sniff = (buffer: Buffer) => {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: 'image/png', extension: '.png' }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', extension: '.jpg' }
  }
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { mime: 'image/gif', extension: '.gif' }
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', extension: '.webp' }
  }
  throw new Error('只支持 PNG、JPEG、GIF 和 WebP 图片')
}

const limited = (buffer: Buffer) => {
  if (!buffer.length) throw new Error('图片内容为空')
  if (buffer.byteLength > maximumBytes) throw new Error('图片超过 10 MiB 限制')
  return buffer
}

const remote = async (value: string, fetcher: typeof fetch) => {
  let url = await assertPublicUrl(value)
  let response: Response | undefined
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetcher(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: { 'user-agent': 'Karin-Channel/2.0' },
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location || redirects === 3) throw new Error('图片重定向无效或次数过多')
    url = await assertPublicUrl(new URL(location, url).toString())
  }
  if (!response?.ok) throw new Error(`图片下载失败：HTTP ${response?.status || 'unknown'}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maximumBytes) throw new Error('图片超过 10 MiB 限制')
  if (!response.body) throw new Error('图片响应没有内容')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  while (true) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    size += chunk.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      throw new Error('图片超过 10 MiB 限制')
    }
    chunks.push(Buffer.from(chunk))
  }
  return limited(Buffer.concat(chunks))
}

const local = async (value: string) => {
  const filename = value.startsWith('file:')
    ? fileURLToPath(new URL(value))
    : path.resolve(value)
  const realFile = await fs.realpath(filename)
  const allowedRoots = await Promise.all(roots.map(root =>
    fs.realpath(root).catch(() => path.resolve(root))
  ))
  if (!allowedRoots.some(root => inside(realFile, root))) {
    throw new Error('本地图片不在 Karin 受控目录')
  }
  return limited(await fs.readFile(realFile))
}

export const resolveChannelImage = async (
  value: string,
  fetcher: typeof fetch = fetch
) => {
  const buffer = value.startsWith('base64://')
    ? limited(Buffer.from(value.slice('base64://'.length), 'base64'))
    : /^https?:\/\//i.test(value)
      ? await remote(value, fetcher)
      : await local(value)
  const format = sniff(buffer)
  return {
    buffer,
    mime: format.mime,
    filename: `karin-${randomUUID()}${format.extension}`,
  }
}

export const saveInboundChannelImage = async (
  kind: string,
  accountId: string,
  buffer: Buffer
) => {
  limited(buffer)
  const format = sniff(buffer)
  const safeKind = kind.replace(/[^a-z0-9_-]/gi, '-').slice(0, 32)
  const safeAccount = accountId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 64)
  const directory = path.join(karinPathTemp, 'channel-media', safeKind, safeAccount)
  await fs.mkdir(directory, { recursive: true })
  const filename = path.join(directory, `${Date.now()}-${randomUUID()}${format.extension}`)
  await fs.writeFile(filename, buffer, { flag: 'wx' })
  return filename
}

export const readableToBuffer = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > maximumBytes) throw new Error('图片超过 10 MiB 限制')
    chunks.push(buffer)
  }
  return limited(Buffer.concat(chunks))
}
