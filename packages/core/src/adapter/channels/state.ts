import fs from 'node:fs'
import path from 'node:path'
import { karinPathData } from '@/root'

interface ChannelStateData {
  offsets: Record<string, number>
  events: Record<string, string[]>
}

const stateFile = path.join(karinPathData, 'adapter', 'channel-state.json')

export class ChannelStateStore {
  private data: ChannelStateData = { offsets: {}, events: {} }
  private loaded = false
  private writing = Promise.resolve()

  private async load () {
    if (this.loaded) return
    this.loaded = true
    try {
      this.data = JSON.parse(await fs.promises.readFile(stateFile, 'utf-8')) as ChannelStateData
    } catch {
      this.data = { offsets: {}, events: {} }
    }
  }

  private async save () {
    await fs.promises.mkdir(path.dirname(stateFile), { recursive: true })
    const temporary = `${stateFile}.tmp`
    await fs.promises.writeFile(temporary, JSON.stringify(this.data, null, 2), 'utf-8')
    await fs.promises.rename(temporary, stateFile)
  }

  private queueSave () {
    this.writing = this.writing.then(() => this.save())
    return this.writing
  }

  async offset (key: string) {
    await this.load()
    return this.data.offsets[key] || 0
  }

  async setOffset (key: string, value: number) {
    await this.load()
    this.data.offsets[key] = value
    await this.queueSave()
  }

  async seen (key: string, eventId: string) {
    await this.load()
    const events = this.data.events[key] || []
    if (events.includes(eventId)) return true
    events.push(eventId)
    this.data.events[key] = events.slice(-1000)
    await this.queueSave()
    return false
  }
}

export const channelStateStore = new ChannelStateStore()
