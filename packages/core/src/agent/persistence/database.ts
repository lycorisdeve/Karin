import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sqlite3, { type Database } from 'sqlite3'

import type {
  AgentActor,
  AgentMessageRole,
  AgentPolicyDecision,
  AgentThreadState,
  AgentToolCall,
} from '@/types/agent'

export interface AgentThreadRecord {
  id: string
  threadKey: string
  parentThreadId: string | null
  actorId: string
  scene: string
  state: AgentThreadState
  summary: string
  title: string
  archivedAt: number | null
  messageCount: number
  lastMessagePreview: string
  createdAt: number
  updatedAt: number
}

export interface AgentApprovalRecord {
  id: string
  threadId: string
  turnId: string
  toolCallId: string
  actorId: string
  toolName: string
  input: Record<string, unknown>
  status: 'pending' | 'approved' | 'denied' | 'expired'
  expiresAt: number
  createdAt: number
  resolvedAt: number | null
}

export interface AgentMemoryRecord {
  id: string
  scope: 'user' | 'group' | 'global'
  scopeKey: string
  content: string
  sourceTurnId: string
  enabled: boolean
  createdAt: number
}

export interface AgentSkillRecord {
  id: string
  name: string
  description: string
  enabled: boolean
  activeVersionId: string | null
  createdAt: number
  updatedAt: number
}

export interface AgentJobRecord {
  id: string
  name: string
  scheduleType: 'cron' | 'once'
  cron: string
  runAt: number | null
  timezone: string
  prompt: string
  target: string
  toolAllowlist: string[]
  skillIds: string[]
  enabled: boolean
  createdBy: string
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
}

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL UNIQUE,
        parent_thread_id TEXT,
        actor_id TEXT NOT NULL,
        scene TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        state TEXT NOT NULL,
        automated INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        name TEXT,
        tool_call_id TEXT,
        tool_calls_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        risk TEXT NOT NULL,
        decision TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        content TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        active_version_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        validation_status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(skill_id, version),
        FOREIGN KEY(skill_id) REFERENCES skills(id)
      );

      CREATE TABLE IF NOT EXISTS thread_skill_snapshots (
        thread_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_version_id TEXT NOT NULL,
        PRIMARY KEY(thread_id, skill_id),
        FOREIGN KEY(thread_id) REFERENCES threads(id),
        FOREIGN KEY(skill_id) REFERENCES skills(id),
        FOREIGN KEY(skill_version_id) REFERENCES skill_versions(id)
      );

      CREATE TABLE IF NOT EXISTS agent_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        target TEXT NOT NULL,
        tool_allowlist_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_key, enabled);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE usage ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage ADD COLUMN fallback_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE usage ADD COLUMN retry_reasons_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE usage ADD COLUMN latency_ms INTEGER;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE threads ADD COLUMN title TEXT NOT NULL DEFAULT '';
      ALTER TABLE threads ADD COLUMN archived_at INTEGER;
      ALTER TABLE tool_calls ADD COLUMN completed_at INTEGER;

      CREATE INDEX IF NOT EXISTS idx_threads_archived_updated
      ON threads(archived_at, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_thread_created
      ON tool_calls(thread_id, created_at);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE agent_jobs ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'cron';
      ALTER TABLE agent_jobs ADD COLUMN run_at INTEGER;
      ALTER TABLE agent_jobs ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
      ALTER TABLE agent_jobs ADD COLUMN skill_ids_json TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE IF NOT EXISTS agent_job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY(job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_job_runs_job_started
      ON agent_job_runs(job_id, started_at);
    `,
  },
]

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class AgentDatabase {
  readonly filename: string
  private db: Database | null = null
  private ftsAvailable = false

  constructor (directory: string) {
    this.filename = path.join(directory, 'agent.db')
  }

  async init () {
    await fs.promises.mkdir(path.dirname(this.filename), { recursive: true })
    this.db = await new Promise<Database>((resolve, reject) => {
      const database = new sqlite3.Database(this.filename, error => {
        if (error) reject(error)
        else resolve(database)
      })
    })

    await this.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
    await this.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `)

    const applied = await this.all<{ version: number }>('SELECT version FROM schema_migrations')
    const versions = new Set(applied.map(item => item.version))
    for (const migration of migrations) {
      if (versions.has(migration.version)) continue
      await this.exec('BEGIN IMMEDIATE')
      try {
        await this.exec(migration.sql)
        await this.run('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)', [
          migration.version,
          Date.now(),
        ])
        await this.exec('COMMIT')
      } catch (error) {
        await this.exec('ROLLBACK')
        throw error
      }
    }

    try {
      await this.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS message_fts
        USING fts5(message_id UNINDEXED, thread_id UNINDEXED, content)
      `)
      this.ftsAvailable = true
    } catch (error) {
      this.ftsAvailable = false
      logger.warn(`[agent][database] FTS5 不可用: ${(error as Error).message}`)
    }

    const now = Date.now()
    await this.run('UPDATE turns SET state = ?, error = ?, updated_at = ? WHERE state IN (?, ?)', [
      'interrupted',
      'Karin 重启，运行中的回合已中断',
      now,
      'running',
      'waiting_approval',
    ])
    await this.run('UPDATE threads SET state = ?, updated_at = ? WHERE state IN (?, ?)', [
      'interrupted',
      now,
      'running',
      'waiting_approval',
    ])
    await this.run('UPDATE approvals SET status = ?, resolved_at = ? WHERE status = ?', [
      'expired',
      now,
      'pending',
    ])
  }

  isFtsAvailable () {
    return this.ftsAvailable
  }

  async close () {
    if (!this.db) return
    const database = this.db
    this.db = null
    await new Promise<void>((resolve, reject) => {
      database.close(error => (error ? reject(error) : resolve()))
    })
  }

  private database () {
    if (!this.db) throw new Error('Agent 数据库尚未初始化')
    return this.db
  }

  private exec (sql: string) {
    return new Promise<void>((resolve, reject) => {
      this.database().exec(sql, error => (error ? reject(error) : resolve()))
    })
  }

  private run (sql: string, params: unknown[] = []) {
    return new Promise<{ changes: number; lastID: number }>((resolve, reject) => {
      this.database().run(sql, params, function (error) {
        if (error) reject(error)
        else resolve({ changes: this.changes, lastID: this.lastID })
      })
    })
  }

  private get<T>(sql: string, params: unknown[] = []) {
    return new Promise<T | undefined>((resolve, reject) => {
      this.database().get(sql, params, (error, row) => {
        if (error) reject(error)
        else resolve(row as T | undefined)
      })
    })
  }

  private all<T>(sql: string, params: unknown[] = []) {
    return new Promise<T[]>((resolve, reject) => {
      this.database().all(sql, params, (error, rows) => {
        if (error) reject(error)
        else resolve(rows as T[])
      })
    })
  }

  private mapThread (row: Record<string, unknown>): AgentThreadRecord {
    return {
      id: String(row.id),
      threadKey: String(row.thread_key),
      parentThreadId: row.parent_thread_id ? String(row.parent_thread_id) : null,
      actorId: String(row.actor_id),
      scene: String(row.scene),
      state: row.state as AgentThreadState,
      summary: String(row.summary || ''),
      title: String(row.title || ''),
      archivedAt: row.archived_at ? Number(row.archived_at) : null,
      messageCount: Number(row.message_count || 0),
      lastMessagePreview: String(row.last_message_preview || ''),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  private threadSelect () {
    return `
      SELECT threads.*,
        (SELECT COUNT(*) FROM messages WHERE messages.thread_id = threads.id)
          AS message_count,
        COALESCE((
          SELECT SUBSTR(content, 1, 160) FROM messages
          WHERE messages.thread_id = threads.id
          ORDER BY created_at DESC LIMIT 1
        ), '') AS last_message_preview
      FROM threads
    `
  }

  async getOrCreateThread (
    threadKey: string,
    actor: AgentActor,
    parentThreadId?: string
  ): Promise<AgentThreadRecord> {
    const existing = await this.get<Record<string, unknown>>(
      `${this.threadSelect()} WHERE thread_key = ?`,
      [threadKey]
    )
    if (existing) return this.mapThread(existing)

    const id = randomUUID()
    const now = Date.now()
    try {
      await this.run(
        `INSERT INTO threads(
          id, thread_key, parent_thread_id, actor_id, scene, state, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, threadKey, parentThreadId || null, actor.id, actor.scene, 'idle', now, now]
      )
      if (parentThreadId) {
        await this.run(
          `INSERT INTO thread_skill_snapshots(thread_id, skill_id, skill_version_id)
           SELECT ?, skill_id, skill_version_id FROM thread_skill_snapshots
           WHERE thread_id = ?`,
          [id, parentThreadId]
        )
      } else {
        await this.run(
          `INSERT INTO thread_skill_snapshots(thread_id, skill_id, skill_version_id)
           SELECT ?, id, active_version_id FROM skills
           WHERE enabled = 1 AND active_version_id IS NOT NULL`,
          [id]
        )
      }
    } catch (error) {
      const raced = await this.get<Record<string, unknown>>(
        `${this.threadSelect()} WHERE thread_key = ?`,
        [threadKey]
      )
      if (raced) return this.mapThread(raced)
      throw error
    }
    return {
      id,
      threadKey,
      parentThreadId: parentThreadId || null,
      actorId: actor.id,
      scene: actor.scene,
      state: 'idle',
      summary: '',
      title: '',
      archivedAt: null,
      messageCount: 0,
      lastMessagePreview: '',
      createdAt: now,
      updatedAt: now,
    }
  }

  async getThread (id: string) {
    const row = await this.get<Record<string, unknown>>(
      `${this.threadSelect()} WHERE threads.id = ?`,
      [id]
    )
    return row ? this.mapThread(row) : null
  }

  async listThreads (
    options: number | {
      limit?: number
      state?: 'active' | 'archived' | 'all'
      query?: string
      cursor?: number
    } = 100
  ) {
    const normalized = typeof options === 'number' ? { limit: options } : options
    const conditions: string[] = []
    const params: unknown[] = []
    if (normalized.state === 'archived') conditions.push('threads.archived_at IS NOT NULL')
    else if (normalized.state !== 'all') conditions.push('threads.archived_at IS NULL')
    if (normalized.query?.trim()) {
      conditions.push(`(
        threads.title LIKE ? OR threads.summary LIKE ? OR EXISTS(
          SELECT 1 FROM messages
          WHERE messages.thread_id = threads.id AND messages.content LIKE ?
        )
      )`)
      const query = `%${normalized.query.trim()}%`
      params.push(query, query, query)
    }
    if (normalized.cursor) {
      conditions.push('threads.updated_at < ?')
      params.push(normalized.cursor)
    }
    const limit = Math.max(1, Math.min(normalized.limit || 100, 500))
    params.push(limit)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await this.all<Record<string, unknown>>(
      `${this.threadSelect()} ${where} ORDER BY threads.updated_at DESC LIMIT ?`,
      params
    )
    return rows.map(row => this.mapThread(row))
  }

  async updateThread (
    id: string,
    input: {
      title?: string
      archived?: boolean
    }
  ) {
    const assignments: string[] = []
    const params: unknown[] = []
    if (input.title !== undefined) {
      assignments.push('title = ?')
      params.push(input.title.trim().slice(0, 120))
    }
    if (input.archived !== undefined) {
      assignments.push('archived_at = ?')
      params.push(input.archived ? Date.now() : null)
    }
    if (!assignments.length) return this.getThread(id)
    assignments.push('updated_at = ?')
    params.push(Date.now(), id)
    await this.run(`UPDATE threads SET ${assignments.join(', ')} WHERE id = ?`, params)
    return this.getThread(id)
  }

  async setThreadTitleIfEmpty (id: string, content: string) {
    const title = content.replace(/\s+/g, ' ').trim().slice(0, 48)
    if (!title) return
    await this.run(
      `UPDATE threads SET title = ?, updated_at = ?
       WHERE id = ? AND title = ''`,
      [title, Date.now(), id]
    )
  }

  async updateThreadState (id: string, state: AgentThreadState) {
    await this.run('UPDATE threads SET state = ?, updated_at = ? WHERE id = ?', [
      state,
      Date.now(),
      id,
    ])
  }

  async createTurn (threadId: string, actorId: string, automated = false) {
    const id = randomUUID()
    const now = Date.now()
    await this.run(
      `INSERT INTO turns(id, thread_id, actor_id, state, automated, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [id, threadId, actorId, 'running', automated ? 1 : 0, now, now]
    )
    await this.updateThreadState(threadId, 'running')
    return id
  }

  async updateTurn (turnId: string, threadId: string, state: AgentThreadState, error?: string) {
    const now = Date.now()
    await this.run('UPDATE turns SET state = ?, error = ?, updated_at = ? WHERE id = ?', [
      state,
      error || null,
      now,
      turnId,
    ])
    await this.updateThreadState(threadId, state)
  }

  async addMessage (
    threadId: string,
    turnId: string | undefined,
    role: AgentMessageRole,
    content: string,
    options: {
      name?: string
      toolCallId?: string
      toolCalls?: AgentToolCall[]
    } = {}
  ) {
    const id = randomUUID()
    const now = Date.now()
    await this.run(
      `INSERT INTO messages(
        id, thread_id, turn_id, role, content, name, tool_call_id, tool_calls_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        threadId,
        turnId || null,
        role,
        content,
        options.name || null,
        options.toolCallId || null,
        options.toolCalls ? JSON.stringify(options.toolCalls) : null,
        now,
      ]
    )
    if (this.ftsAvailable && content) {
      await this.run('INSERT INTO message_fts(message_id, thread_id, content) VALUES(?, ?, ?)', [
        id,
        threadId,
        content,
      ])
    }
    if (role === 'user') await this.setThreadTitleIfEmpty(threadId, content)
    return id
  }

  async listMessages (threadId: string, limit = 100, before?: number) {
    const beforeSql = before ? 'AND created_at < ?' : ''
    const params: unknown[] = [threadId]
    if (before) params.push(before)
    params.push(Math.max(1, Math.min(limit, 500)))
    const rows = await this.all<Record<string, unknown>>(
      `SELECT * FROM (
        SELECT * FROM messages
        WHERE thread_id = ? ${beforeSql}
        ORDER BY created_at DESC LIMIT ?
      ) ORDER BY created_at ASC`,
      params
    )
    return rows.map(row => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      turnId: row.turn_id ? String(row.turn_id) : null,
      role: row.role as AgentMessageRole,
      content: String(row.content),
      name: row.name ? String(row.name) : undefined,
      toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined,
      toolCalls: parseJson<AgentToolCall[]>(row.tool_calls_json as string, []),
      createdAt: Number(row.created_at),
    }))
  }

  async searchMessages (query: string, limit = 100) {
    if (!this.ftsAvailable) throw new Error('当前 SQLite 运行环境不支持 FTS5')
    return this.all<{
      message_id: string
      thread_id: string
      excerpt: string
    }>(
      `SELECT message_id, thread_id, snippet(message_fts, 2, '<mark>', '</mark>', '…', 16) AS excerpt
       FROM message_fts WHERE message_fts MATCH ? LIMIT ?`,
      [query, Math.max(1, Math.min(limit, 500))]
    )
  }

  async createToolCall (
    threadId: string,
    turnId: string,
    call: AgentToolCall,
    risk: string,
    decision: AgentPolicyDecision,
    status: string
  ) {
    const now = Date.now()
    await this.run(
      `INSERT OR REPLACE INTO tool_calls(
        id, thread_id, turn_id, tool_name, input_json, risk, decision, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        call.id,
        threadId,
        turnId,
        call.name,
        JSON.stringify(call.arguments),
        risk,
        decision,
        status,
        now,
        now,
      ]
    )
  }

  async completeToolCall (id: string, output: unknown, error?: string) {
    await this.run(
      `UPDATE tool_calls SET output_json = ?, status = ?, error = ?,
       updated_at = ?, completed_at = ? WHERE id = ?`,
      [
        output === undefined ? null : JSON.stringify(output),
        error ? 'failed' : 'completed',
        error || null,
        Date.now(),
        Date.now(),
        id,
      ]
    )
  }

  async listToolCalls (threadId: string, turnId?: string) {
    const rows = turnId
      ? await this.all<Record<string, unknown>>(
        `SELECT * FROM tool_calls
         WHERE thread_id = ? AND turn_id = ?
         ORDER BY created_at ASC`,
        [threadId, turnId]
      )
      : await this.all<Record<string, unknown>>(
        `SELECT * FROM tool_calls
         WHERE thread_id = ?
         ORDER BY created_at ASC`,
        [threadId]
      )
    return rows.map(row => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      name: String(row.tool_name),
      input: parseJson<unknown>(row.input_json as string, {}),
      output: parseJson<unknown>(row.output_json as string, undefined),
      risk: String(row.risk),
      decision: String(row.decision),
      status: String(row.status),
      error: row.error ? String(row.error) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
    }))
  }

  async getThreadTreeIds (rootId: string) {
    const rows = await this.all<{ id: string }>(
      `WITH RECURSIVE thread_tree(id) AS (
        SELECT id FROM threads WHERE id = ?
        UNION ALL
        SELECT threads.id FROM threads
        JOIN thread_tree ON threads.parent_thread_id = thread_tree.id
      )
      SELECT id FROM thread_tree`,
      [rootId]
    )
    return rows.map(row => row.id)
  }

  async deleteThreadTree (rootId: string, actorId: string) {
    const ids = await this.getThreadTreeIds(rootId)
    if (!ids.length) return false
    const placeholders = ids.map(() => '?').join(', ')
    await this.exec('BEGIN IMMEDIATE')
    try {
      if (this.ftsAvailable) {
        await this.run(`DELETE FROM message_fts WHERE thread_id IN (${placeholders})`, ids)
      }
      for (const table of [
        'thread_skill_snapshots',
        'approvals',
        'tool_calls',
        'usage',
        'audit_log',
        'messages',
        'turns',
      ]) {
        await this.run(`DELETE FROM ${table} WHERE thread_id IN (${placeholders})`, ids)
      }
      await this.run(`DELETE FROM threads WHERE id IN (${placeholders})`, ids)
      await this.run(
        `INSERT INTO audit_log(
          id, thread_id, actor_id, action, target, detail_json, created_at
        ) VALUES(?, NULL, ?, 'thread.delete', ?, ?, ?)`,
        [
          randomUUID(),
          actorId,
          rootId,
          JSON.stringify({ deletedThreads: ids.length }),
          Date.now(),
        ]
      )
      await this.exec('COMMIT')
      return true
    } catch (error) {
      await this.exec('ROLLBACK')
      throw error
    }
  }

  async createApproval (
    threadId: string,
    turnId: string,
    actorId: string,
    call: AgentToolCall,
    ttlMs: number
  ) {
    const id = randomUUID()
    const now = Date.now()
    await this.run(
      `INSERT INTO approvals(
        id, thread_id, turn_id, tool_call_id, actor_id, tool_name, input_json,
        status, expires_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        threadId,
        turnId,
        call.id,
        actorId,
        call.name,
        JSON.stringify(call.arguments),
        'pending',
        now + ttlMs,
        now,
      ]
    )
    return id
  }

  private mapApproval (row: Record<string, unknown>): AgentApprovalRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      toolCallId: String(row.tool_call_id),
      actorId: String(row.actor_id),
      toolName: String(row.tool_name),
      input: parseJson<Record<string, unknown>>(row.input_json as string, {}),
      status: row.status as AgentApprovalRecord['status'],
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
    }
  }

  async getApproval (id: string) {
    const row = await this.get<Record<string, unknown>>('SELECT * FROM approvals WHERE id = ?', [
      id,
    ])
    return row ? this.mapApproval(row) : null
  }

  async listApprovals (status?: AgentApprovalRecord['status']) {
    const rows = status
      ? await this.all<Record<string, unknown>>(
        'SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC',
        [status]
      )
      : await this.all<Record<string, unknown>>(
        'SELECT * FROM approvals ORDER BY created_at DESC LIMIT 500'
      )
    return rows.map(row => this.mapApproval(row))
  }

  async resolveApproval (id: string, status: 'approved' | 'denied' | 'expired') {
    const result = await this.run(
      `UPDATE approvals SET status = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
      [status, Date.now(), id]
    )
    return result.changes > 0
  }

  async addMemory (
    scope: AgentMemoryRecord['scope'],
    scopeKey: string,
    content: string,
    sourceTurnId: string
  ) {
    const id = randomUUID()
    await this.run(
      `INSERT INTO memories(id, scope, scope_key, content, source_turn_id, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [id, scope, scopeKey, content, sourceTurnId, Date.now()]
    )
    return id
  }

  async listMemories (scopes?: Array<{ scope: string; key: string }>) {
    let rows: Record<string, unknown>[]
    if (!scopes?.length) {
      rows = await this.all<Record<string, unknown>>(
        'SELECT * FROM memories ORDER BY created_at DESC LIMIT 500'
      )
    } else {
      const conditions = scopes.map(() => '(scope = ? AND scope_key = ?)').join(' OR ')
      const params = scopes.flatMap(item => [item.scope, item.key])
      rows = await this.all<Record<string, unknown>>(
        `SELECT * FROM memories WHERE enabled = 1 AND (${conditions})
         ORDER BY created_at DESC LIMIT 100`,
        params
      )
    }
    return rows.map(row => ({
      id: String(row.id),
      scope: row.scope as AgentMemoryRecord['scope'],
      scopeKey: String(row.scope_key),
      content: String(row.content),
      sourceTurnId: String(row.source_turn_id),
      enabled: Boolean(row.enabled),
      createdAt: Number(row.created_at),
    }))
  }

  async setMemoryEnabled (id: string, enabled: boolean) {
    const result = await this.run('UPDATE memories SET enabled = ? WHERE id = ?', [
      enabled ? 1 : 0,
      id,
    ])
    return result.changes > 0
  }

  async deleteMemory (id: string) {
    const result = await this.run('DELETE FROM memories WHERE id = ?', [id])
    return result.changes > 0
  }

  async listSkills () {
    const rows = await this.all<Record<string, unknown>>(
      'SELECT * FROM skills ORDER BY updated_at DESC'
    )
    return rows.map(row => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      enabled: Boolean(row.enabled),
      activeVersionId: row.active_version_id ? String(row.active_version_id) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
  }

  async getSkillVersions (skillId: string) {
    return this.all<Record<string, unknown>>(
      'SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC',
      [skillId]
    )
  }

  async addSkillVersion (input: {
    name: string
    description: string
    content: string
    tools: string[]
    sourceTurnId: string
    contentHash: string
  }) {
    const now = Date.now()
    const existing = await this.get<Record<string, unknown>>(
      'SELECT * FROM skills WHERE name = ?',
      [input.name]
    )
    const skillId = existing ? String(existing.id) : randomUUID()
    if (!existing) {
      await this.run(
        `INSERT INTO skills(id, name, description, enabled, created_at, updated_at)
         VALUES(?, ?, ?, 1, ?, ?)`,
        [skillId, input.name, input.description, now, now]
      )
    }
    const row = await this.get<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM skill_versions WHERE skill_id = ?',
      [skillId]
    )
    const versionId = randomUUID()
    await this.run(
      `INSERT INTO skill_versions(
        id, skill_id, version, content, tools_json, source_turn_id,
        content_hash, validation_status, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'valid', ?)`,
      [
        versionId,
        skillId,
        Number(row?.version || 0) + 1,
        input.content,
        JSON.stringify(input.tools),
        input.sourceTurnId,
        input.contentHash,
        now,
      ]
    )
    await this.run(
      'UPDATE skills SET description = ?, active_version_id = ?, updated_at = ? WHERE id = ?',
      [input.description, versionId, now, skillId]
    )
    return { skillId, versionId }
  }

  async rollbackSkill (skillId: string, versionId: string) {
    const version = await this.get<{ id: string }>(
      'SELECT id FROM skill_versions WHERE id = ? AND skill_id = ?',
      [versionId, skillId]
    )
    if (!version) return false
    await this.run('UPDATE skills SET active_version_id = ?, updated_at = ? WHERE id = ?', [
      versionId,
      Date.now(),
      skillId,
    ])
    return true
  }

  async setSkillEnabled (skillId: string, enabled: boolean) {
    const result = await this.run('UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?', [
      enabled ? 1 : 0,
      Date.now(),
      skillId,
    ])
    return result.changes > 0
  }

  async getThreadSkillContents (threadId: string) {
    const rows = await this.all<{ name: string; content: string }>(
      `SELECT s.name, sv.content
       FROM thread_skill_snapshots snapshot
       JOIN skills s ON s.id = snapshot.skill_id
       JOIN skill_versions sv ON sv.id = snapshot.skill_version_id
       WHERE snapshot.thread_id = ?`,
      [threadId]
    )
    return rows
  }

  async listJobs () {
    const rows = await this.all<Record<string, unknown>>(
      'SELECT * FROM agent_jobs ORDER BY updated_at DESC'
    )
    return rows.map(row => ({
      id: String(row.id),
      name: String(row.name),
      scheduleType: row.schedule_type === 'once' ? 'once' as const : 'cron' as const,
      cron: String(row.cron),
      runAt: row.run_at ? Number(row.run_at) : null,
      timezone: String(row.timezone || 'Asia/Shanghai'),
      prompt: String(row.prompt),
      target: String(row.target),
      toolAllowlist: parseJson<string[]>(row.tool_allowlist_json as string, []),
      skillIds: parseJson<string[]>(row.skill_ids_json as string, []),
      enabled: Boolean(row.enabled),
      createdBy: String(row.created_by),
      lastRunAt: row.last_run_at ? Number(row.last_run_at) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
  }

  async saveJob (
    input: Omit<AgentJobRecord, 'createdAt' | 'updatedAt' | 'lastRunAt'> & {
      lastRunAt?: number | null
    }
  ) {
    const now = Date.now()
    await this.run(
      `INSERT INTO agent_jobs(
        id, name, schedule_type, cron, run_at, timezone, prompt, target,
        tool_allowlist_json, skill_ids_json, enabled, created_by, last_run_at,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        schedule_type = excluded.schedule_type,
        cron = excluded.cron,
        run_at = excluded.run_at,
        timezone = excluded.timezone,
        prompt = excluded.prompt,
        target = excluded.target,
        tool_allowlist_json = excluded.tool_allowlist_json,
        skill_ids_json = excluded.skill_ids_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at`,
      [
        input.id,
        input.name,
        input.scheduleType,
        input.cron,
        input.runAt,
        input.timezone,
        input.prompt,
        input.target,
        JSON.stringify(input.toolAllowlist),
        JSON.stringify(input.skillIds),
        input.enabled ? 1 : 0,
        input.createdBy,
        input.lastRunAt || null,
        now,
        now,
      ]
    )
  }

  async deleteJob (id: string) {
    const result = await this.run('DELETE FROM agent_jobs WHERE id = ?', [id])
    return result.changes > 0
  }

  async markJobRun (id: string) {
    await this.run('UPDATE agent_jobs SET last_run_at = ?, updated_at = ? WHERE id = ?', [
      Date.now(),
      Date.now(),
      id,
    ])
  }

  async startJobRun (jobId: string) {
    const id = randomUUID()
    await this.run(
      `INSERT INTO agent_job_runs(id, job_id, status, started_at)
       VALUES(?, ?, 'running', ?)`,
      [id, jobId, Date.now()]
    )
    return id
  }

  async finishJobRun (id: string, status: 'completed' | 'failed', error?: string) {
    await this.run(
      'UPDATE agent_job_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?',
      [status, error || null, Date.now(), id]
    )
  }

  async listJobRuns (jobId?: string, limit = 200) {
    if (jobId) {
      return this.all<Record<string, unknown>>(
        'SELECT * FROM agent_job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?',
        [jobId, Math.max(1, Math.min(limit, 1000))]
      )
    }
    return this.all<Record<string, unknown>>(
      'SELECT * FROM agent_job_runs ORDER BY started_at DESC LIMIT ?',
      [Math.max(1, Math.min(limit, 1000))]
    )
  }

  async audit (actorId: string, action: string, target: string, detail: unknown, threadId?: string) {
    await this.run(
      `INSERT INTO audit_log(id, thread_id, actor_id, action, target, detail_json, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), threadId || null, actorId, action, target, JSON.stringify(detail), Date.now()]
    )
  }

  async listAudit (limit = 200) {
    return this.all<Record<string, unknown>>(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?',
      [Math.max(1, Math.min(limit, 1000))]
    )
  }

  async addUsage (
    threadId: string,
    turnId: string,
    provider: string,
    model: string,
    inputTokens?: number,
    outputTokens?: number,
    metadata: {
      retries?: number
      fallbackFrom?: string[]
      retryReasons?: string[]
      latencyMs?: number
    } = {}
  ) {
    await this.run(
      `INSERT INTO usage(
        id, thread_id, turn_id, provider, model, input_tokens, output_tokens,
        retry_count, fallback_json, retry_reasons_json, latency_ms, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        threadId,
        turnId,
        provider,
        model,
        inputTokens || null,
        outputTokens || null,
        metadata.retries || 0,
        JSON.stringify(metadata.fallbackFrom || []),
        JSON.stringify(metadata.retryReasons || []),
        metadata.latencyMs || null,
        Date.now(),
      ]
    )
  }

  async listUsage (limit = 200) {
    return this.all<Record<string, unknown>>(
      'SELECT * FROM usage ORDER BY created_at DESC LIMIT ?',
      [Math.max(1, Math.min(limit, 1000))]
    )
  }
}
