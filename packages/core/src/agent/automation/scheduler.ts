import { randomUUID } from 'node:crypto'
import schedule, { type Job } from 'node-schedule'
import { sendMsg } from '@/service/bot'
import { agentDeliveryTarget } from '../ingress/context'
import { agentSendMessage } from '../ingress/message-elements'

import type { AgentDatabase, AgentJobRecord } from '../persistence/database'
import type { AgentRuntime } from '../runtime/runtime'

export class AgentScheduler {
  private readonly scheduled = new Map<string, Job>()

  constructor (
    private readonly database: AgentDatabase,
    private readonly runtime: AgentRuntime
  ) {}

  async init () {
    for (const job of await this.database.listJobs()) {
      if (job.enabled) this.schedule(job)
    }
  }

  private schedule (record: AgentJobRecord) {
    this.scheduled.get(record.id)?.cancel()
    const rule = record.scheduleType === 'once'
      ? new Date(record.runAt || 0)
      : { rule: record.cron, tz: record.timezone }
    if (record.scheduleType === 'once' && (!record.runAt || record.runAt <= Date.now())) {
      throw new Error('一次性任务的执行时间必须晚于当前时间')
    }
    const job = schedule.scheduleJob(rule, () => {
      this.run(record).catch(error => {
        logger.error(new Error(`[agent][job] ${record.name} 执行失败`, { cause: error }))
      })
    })
    if (!job) throw new Error(`无效 cron: ${record.cron}`)
    this.scheduled.set(record.id, job)
  }

  private async run (record: AgentJobRecord) {
    await this.database.markJobRun(record.id)
    const runId = await this.database.startJobRun(record.id)
    await this.database.audit(record.createdBy, 'job.run', record.id, { target: record.target })
    try {
      const actor = {
        id: record.createdBy,
        role: 'admin' as const,
        selfId: 'automation',
        scene: 'automation',
        contactKey: record.target,
      }
      const result = await this.runtime.runTurn({
        threadKey: `job:${record.id}:${Date.now()}`,
        actor,
        content: record.prompt,
        automated: true,
        allowedTools: record.toolAllowlist,
        personaVersionId: record.personaId
          ? (await this.database.getPersona(record.personaId))?.activeVersionId
          : undefined,
      })
      const delivery = agentDeliveryTarget(actor)
      if (delivery && result.content) {
        await sendMsg(
          delivery.selfId,
          delivery.contact,
          await agentSendMessage(result.content)
        )
      }
      await this.database.finishJobRun(runId, 'completed')
    } catch (error) {
      await this.database.finishJobRun(runId, 'failed', (error as Error).message)
      throw error
    } finally {
      if (record.scheduleType === 'once') {
        this.scheduled.delete(record.id)
        await this.database.saveJob({ ...record, enabled: false, lastRunAt: Date.now() })
      }
    }
  }

  async save (input: {
    id?: string
    name: string
    scheduleType?: 'cron' | 'once'
    cron: string
    runAt?: number | null
    timezone?: string
    prompt: string
    target: string
    toolAllowlist: string[]
    skillIds?: string[]
    personaId?: string | null
    enabled: boolean
    createdBy: string
  }) {
    if (input.personaId) {
      const persona = await this.database.getPersona(input.personaId)
      if (!persona?.enabled) throw new Error('定时任务人物预设不存在或已停用')
    }
    const record: AgentJobRecord = {
      id: input.id || randomUUID(),
      name: input.name,
      scheduleType: input.scheduleType || 'cron',
      cron: input.cron,
      runAt: input.runAt || null,
      timezone: input.timezone || 'Asia/Shanghai',
      prompt: input.prompt,
      target: input.target,
      toolAllowlist: [...new Set(input.toolAllowlist)],
      skillIds: [...new Set(input.skillIds || [])],
      personaId: input.personaId || null,
      enabled: input.enabled,
      createdBy: input.createdBy,
      lastRunAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    if (record.enabled) {
      this.schedule(record)
    } else {
      this.scheduled.get(record.id)?.cancel()
      this.scheduled.delete(record.id)
    }
    await this.database.saveJob(record)
    return record
  }

  async delete (id: string) {
    this.scheduled.get(id)?.cancel()
    this.scheduled.delete(id)
    return this.database.deleteJob(id)
  }

  async setEnabled (id: string, enabled: boolean) {
    const existing = (await this.database.listJobs()).find(item => item.id === id)
    if (!existing) throw new Error(`自动任务不存在: ${id}`)
    return this.save({
      id: existing.id,
      name: existing.name,
      scheduleType: existing.scheduleType,
      cron: existing.cron,
      runAt: existing.runAt,
      timezone: existing.timezone,
      prompt: existing.prompt,
      target: existing.target,
      toolAllowlist: existing.toolAllowlist,
      skillIds: existing.skillIds,
      personaId: existing.personaId,
      enabled,
      createdBy: existing.createdBy,
    })
  }

  async runNow (id: string) {
    const existing = (await this.database.listJobs()).find(item => item.id === id)
    if (!existing) throw new Error(`自动任务不存在: ${id}`)
    await this.run(existing)
    return { id, completed: true }
  }

  stop () {
    for (const job of this.scheduled.values()) job.cancel()
    this.scheduled.clear()
  }
}
