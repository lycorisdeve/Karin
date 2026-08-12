import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { karinPathConfig } from '@/root'

import type { AgentDatabase } from '../persistence/database'
import type { AgentInstructionVersion } from '@/types/agent'

const MAX_BYTES = 32 * 1024

const normalize = (value: string) => value.replace(/\r\n?/g, '\n')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const reportImportError = (error: unknown) => {
  const wrapped = new Error('[agent][instructions] 外部修改导入失败', { cause: error })
  if (typeof logger !== 'undefined') logger.error(wrapped)
  else console.warn(wrapped.message)
}

export class AgentInstructionStore {
  readonly filename: string
  private watcher: fs.FSWatcher | null = null
  private importing: Promise<void> = Promise.resolve()
  private knownHash = ''
  private writing = false
  private closed = false

  constructor (
    private readonly database: AgentDatabase,
    filename = path.join(karinPathConfig, 'AGENT.md')
  ) {
    this.filename = filename
  }

  private validate (content: string) {
    const normalized = normalize(content)
    if (normalized.includes('\0')) throw new Error('AGENT.md 不能包含 NUL 字符')
    if (normalized.includes('\uFFFD')) throw new Error('AGENT.md 必须是有效的 UTF-8 文本')
    if (Buffer.byteLength(normalized, 'utf8') > MAX_BYTES) {
      throw new Error('AGENT.md 不能超过 32 KiB')
    }
    return normalized
  }

  async init () {
    await fs.promises.mkdir(path.dirname(this.filename), { recursive: true })
    this.closed = false
    if (!fs.existsSync(this.filename)) await fs.promises.writeFile(this.filename, '', 'utf8')
    await this.importFile('file')
    const basename = path.basename(this.filename)
    this.watcher = fs.watch(path.dirname(this.filename), (_event, filename) => {
      if (this.writing || (filename && String(filename) !== basename)) return
      this.importing = this.importing
        .catch(() => undefined)
        .then(async () => {
          await new Promise(resolve => setTimeout(resolve, 80))
          if (this.closed) return
          await this.importFile('file')
        })
        .catch(reportImportError)
    })
  }

  private async importFile (source: AgentInstructionVersion['source']) {
    const content = this.validate(await fs.promises.readFile(this.filename, 'utf8'))
    const contentHash = digest(content)
    if (contentHash === this.knownHash) return this.database.getActiveInstruction()
    const current = await this.database.getActiveInstruction()
    if (current.contentHash === contentHash) {
      this.knownHash = contentHash
      return current
    }
    const version = await this.database.addInstructionVersion(
      content,
      contentHash,
      source,
      source === 'file' ? 'filesystem' : 'karin'
    )
    this.knownHash = contentHash
    return version
  }

  async current () {
    return this.database.getActiveInstruction()
  }

  async versions () {
    return this.database.listInstructionVersions()
  }

  async save (content: string, expectedHash: string, actorId: string) {
    const normalized = this.validate(content)
    const current = await this.current()
    if (expectedHash && expectedHash !== current.contentHash) {
      const error = new Error('AGENT.md 已被其他修改更新，请刷新后重试') as Error & {
        code?: string
      }
      error.code = 'INSTRUCTION_CONFLICT'
      throw error
    }
    const contentHash = digest(normalized)
    if (contentHash === current.contentHash) return current
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    await fs.promises.writeFile(temporary, normalized, { encoding: 'utf8', flag: 'wx' })
    this.writing = true
    try {
      await fs.promises.rename(temporary, this.filename)
    } finally {
      this.writing = false
      await fs.promises.unlink(temporary).catch(() => undefined)
    }
    const version = await this.database.addInstructionVersion(
      normalized,
      contentHash,
      'web',
      actorId
    )
    this.knownHash = contentHash
    return version
  }

  close () {
    this.closed = true
    this.watcher?.close()
    this.watcher = null
  }
}
