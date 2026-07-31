import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sqlite3, { type Database } from 'sqlite3'
import { inferAgentOrigin } from '../ingress/origin'

import type {
  AgentActor,
  AgentEvolutionCandidate,
  AgentEvolutionMetrics,
  AgentEvolutionState,
  AgentEvolutionTarget,
  AgentMessageRole,
  AgentPolicyDecision,
  AgentThreadState,
  AgentToolRisk,
  AgentToolCall,
  AgentMessageAttachmentInput,
  AgentScriptToolDefinition,
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
  modelProviderId: string | null
  modelName: string | null
  channel: string
  protocol: string
  accountId: string
  accountName: string
  contactKey: string
  contactId: string
  contactSubId: string
  contactName: string
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
  approverContactKey: string | null
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

export interface AgentExperienceRecord {
  id: string
  threadId: string
  turnId: string
  actorId: string
  task: string
  outcome: 'completed' | 'failed' | 'interrupted'
  toolNames: string[]
  skillIds: string[]
  error?: string
  correction?: string
  createdAt: number
}

export interface AgentThreadGrantRecord {
  id: string
  threadId: string
  actorId: string
  toolName: string
  risk: AgentToolRisk
  mode: 'tool' | 'delegate'
  createdAt: number
  revokedAt: number | null
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
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_sessions (
        contact_key TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_thread
      ON agent_sessions(thread_id);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_experiences (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        task TEXT NOT NULL,
        outcome TEXT NOT NULL,
        tool_names_json TEXT NOT NULL DEFAULT '[]',
        skill_ids_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        correction TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_feedback (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        actor_id TEXT NOT NULL,
        rating INTEGER,
        correction TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_retrieval_log (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        selected INTEGER NOT NULL DEFAULT 1,
        outcome TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evolution_candidates (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_turn_ids_json TEXT NOT NULL,
        baseline_version TEXT,
        candidate_version TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        metrics_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evolution_evaluations (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        passed INTEGER NOT NULL,
        metrics_json TEXT NOT NULL,
        report TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(candidate_id) REFERENCES evolution_candidates(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS evolution_events (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_usage (
        skill_id TEXT PRIMARY KEY,
        use_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        correction_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        state TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS thread_tool_grants (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        risk TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_experiences_thread_created
      ON agent_experiences(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_feedback_thread_created
      ON agent_feedback(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_retrieval_turn
      ON agent_retrieval_log(turn_id, kind);
      CREATE INDEX IF NOT EXISTS idx_evolution_state_created
      ON evolution_candidates(state, created_at);
      CREATE INDEX IF NOT EXISTS idx_thread_grants_active
      ON thread_tool_grants(thread_id, tool_name, revoked_at);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE threads ADD COLUMN model_provider_id TEXT;
      ALTER TABLE threads ADD COLUMN model_name TEXT;
      ALTER TABLE skill_versions ADD COLUMN name TEXT NOT NULL DEFAULT '';
      ALTER TABLE skill_versions ADD COLUMN description TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE skill_versions
      ADD COLUMN script_tools_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE threads ADD COLUMN channel_kind TEXT NOT NULL DEFAULT '';
      ALTER TABLE threads ADD COLUMN protocol TEXT NOT NULL DEFAULT '';
      ALTER TABLE threads ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE threads ADD COLUMN account_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE threads ADD COLUMN contact_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE threads ADD COLUMN contact_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE threads ADD COLUMN contact_sub_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE threads ADD COLUMN contact_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE approvals ADD COLUMN approver_contact_key TEXT;

      CREATE INDEX IF NOT EXISTS idx_threads_channel_archived_updated
      ON threads(channel_kind, archived_at, updated_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_contact_status
      ON approvals(approver_contact_key, status, expires_at);
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_message_attachments_message
      ON message_attachments(message_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_message_attachments_thread
      ON message_attachments(thread_id);
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

const parseSkillFrontmatter = (content: string) => {
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || ''
  const name = header.match(/^name:\s*(.+)$/m)?.[1]?.trim() || ''
  const rawDescription = header.match(/^description:\s*(.+)$/m)?.[1]?.trim() || ''
  let description = rawDescription
  try {
    description = JSON.parse(rawDescription)
  } catch {
    // 兼容旧版本未使用 JSON 字符串的 frontmatter。
  }
  return { name, description: String(description || '') }
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

    const legacySkillVersions = await this.all<{
      id: string
      content: string
      name: string
      description: string
    }>(
      `SELECT id, content, name, description FROM skill_versions
       WHERE name = '' OR description = ''`
    )
    for (const version of legacySkillVersions) {
      const metadata = parseSkillFrontmatter(version.content)
      await this.run(
        'UPDATE skill_versions SET name = ?, description = ? WHERE id = ?',
        [
          version.name || metadata.name,
          version.description || metadata.description,
          version.id,
        ]
      )
    }

    const legacyThreads = await this.all<Record<string, unknown>>(
      `SELECT id, thread_key, parent_thread_id, actor_id, scene,
        channel_kind, protocol, account_id, account_name,
        contact_key, contact_id, contact_sub_id, contact_name
       FROM threads
       WHERE channel_kind = '' OR protocol = ''
         OR (contact_key = '' AND channel_kind NOT IN ('system'))`
    )
    if (legacyThreads.length) {
      const allThreads = await this.all<Record<string, unknown>>(
        `SELECT id, thread_key, parent_thread_id, actor_id, scene,
          channel_kind, protocol, account_id, account_name,
          contact_key, contact_id, contact_sub_id, contact_name
         FROM threads`
      )
      const rowsById = new Map(allThreads.map(row => [String(row.id), row]))
      const resolved = new Map<string, ReturnType<typeof inferAgentOrigin>>()
      const resolveOrigin = (
        row: Record<string, unknown>,
        visiting = new Set<string>()
      ): ReturnType<typeof inferAgentOrigin> => {
        const id = String(row.id)
        const cached = resolved.get(id)
        if (cached) return cached
        if (visiting.has(id)) {
          return inferAgentOrigin(
            String(row.thread_key),
            String(row.scene),
            String(row.actor_id)
          )
        }
        visiting.add(id)
        const parent = row.parent_thread_id
          ? rowsById.get(String(row.parent_thread_id))
          : undefined
        const inferred = parent
          ? resolveOrigin(parent, visiting)
          : inferAgentOrigin(
            String(row.thread_key),
            String(row.scene),
            String(row.actor_id)
          )
        const origin = {
          channel: String(row.channel_kind || inferred.channel),
          protocol: String(row.protocol || inferred.protocol),
          accountId: String(row.account_id || inferred.accountId),
          accountName: String(row.account_name || inferred.accountName),
          contactKey: String(row.contact_key || inferred.contactKey),
          contactId: String(row.contact_id || inferred.contactId),
          contactSubId: String(row.contact_sub_id || inferred.contactSubId),
          contactName: String(row.contact_name || inferred.contactName),
        }
        resolved.set(id, origin)
        visiting.delete(id)
        return origin
      }
      for (const row of legacyThreads) {
        const origin = resolveOrigin(row)
        await this.run(
          `UPDATE threads SET
            channel_kind = ?, protocol = ?, account_id = ?, account_name = ?,
            contact_key = ?, contact_id = ?, contact_sub_id = ?, contact_name = ?
           WHERE id = ?`,
          [
            origin.channel,
            origin.protocol,
            origin.accountId,
            origin.accountName,
            origin.contactKey,
            origin.contactId,
            origin.contactSubId,
            origin.contactName,
            String(row.id),
          ]
        )
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
    await this.run('UPDATE turns SET state = ?, error = ?, updated_at = ? WHERE state IN (?, ?, ?)', [
      'interrupted',
      'Karin 重启，运行中的回合已中断',
      now,
      'running',
      'waiting_approval',
      'stopping',
    ])
    await this.run('UPDATE threads SET state = ?, updated_at = ? WHERE state IN (?, ?, ?)', [
      'interrupted',
      now,
      'running',
      'waiting_approval',
      'stopping',
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
      modelProviderId: row.model_provider_id ? String(row.model_provider_id) : null,
      modelName: row.model_name ? String(row.model_name) : null,
      channel: String(row.channel_kind || ''),
      protocol: String(row.protocol || ''),
      accountId: String(row.account_id || ''),
      accountName: String(row.account_name || ''),
      contactKey: String(row.contact_key || ''),
      contactId: String(row.contact_id || ''),
      contactSubId: String(row.contact_sub_id || ''),
      contactName: String(row.contact_name || ''),
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

  private async refreshThreadOrigin (id: string, actor: AgentActor) {
    const origin = actor.origin
    if (!origin) return
    await this.run(
      `UPDATE threads SET
        channel_kind = CASE WHEN ? <> '' THEN ? ELSE channel_kind END,
        protocol = CASE WHEN ? <> '' THEN ? ELSE protocol END,
        account_id = CASE WHEN ? <> '' THEN ? ELSE account_id END,
        account_name = CASE WHEN ? <> '' THEN ? ELSE account_name END,
        contact_key = CASE WHEN ? <> '' THEN ? ELSE contact_key END,
        contact_id = CASE WHEN ? <> '' THEN ? ELSE contact_id END,
        contact_sub_id = CASE WHEN ? <> '' THEN ? ELSE contact_sub_id END,
        contact_name = CASE WHEN ? <> '' THEN ? ELSE contact_name END
       WHERE id = ?`,
      [
        origin.channel, origin.channel,
        origin.protocol, origin.protocol,
        origin.accountId, origin.accountId,
        origin.accountName, origin.accountName,
        origin.contactKey, origin.contactKey,
        origin.contactId, origin.contactId,
        origin.contactSubId, origin.contactSubId,
        origin.contactName, origin.contactName,
        id,
      ]
    )
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
    if (existing) {
      await this.refreshThreadOrigin(String(existing.id), actor)
      return (await this.getThread(String(existing.id)))!
    }

    const id = randomUUID()
    const now = Date.now()
    const parent = parentThreadId
      ? await this.get<Record<string, unknown>>(
        `SELECT model_provider_id, model_name, channel_kind, protocol,
          account_id, account_name, contact_key, contact_id, contact_sub_id, contact_name
         FROM threads WHERE id = ?`,
        [parentThreadId]
      )
      : null
    const inferred = inferAgentOrigin(threadKey, actor.scene, actor.id)
    const origin = actor.origin || (parent
      ? {
        channel: String(parent.channel_kind || ''),
        protocol: String(parent.protocol || ''),
        accountId: String(parent.account_id || ''),
        accountName: String(parent.account_name || ''),
        contactKey: String(parent.contact_key || ''),
        contactId: String(parent.contact_id || ''),
        contactSubId: String(parent.contact_sub_id || ''),
        contactName: String(parent.contact_name || ''),
      }
      : inferred)
    try {
      await this.run(
        `INSERT INTO threads(
          id, thread_key, parent_thread_id, actor_id, scene, state,
          model_provider_id, model_name, channel_kind, protocol,
          account_id, account_name, contact_key, contact_id, contact_sub_id, contact_name,
          created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          threadKey,
          parentThreadId || null,
          actor.id,
          actor.scene,
          'idle',
          parent?.model_provider_id || null,
          parent?.model_name || null,
          origin.channel,
          origin.protocol,
          origin.accountId,
          origin.accountName,
          origin.contactKey,
          origin.contactId,
          origin.contactSubId,
          origin.contactName,
          now,
          now,
        ]
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
      modelProviderId: parent?.model_provider_id ? String(parent.model_provider_id) : null,
      modelName: parent?.model_name ? String(parent.model_name) : null,
      channel: origin.channel,
      protocol: origin.protocol,
      accountId: origin.accountId,
      accountName: origin.accountName,
      contactKey: origin.contactKey,
      contactId: origin.contactId,
      contactSubId: origin.contactSubId,
      contactName: origin.contactName,
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

  async getThreadByKey (threadKey: string) {
    const row = await this.get<Record<string, unknown>>(
      `${this.threadSelect()} WHERE threads.thread_key = ?`,
      [threadKey]
    )
    return row ? this.mapThread(row) : null
  }

  async getOrCreateSession (actor: AgentActor) {
    const session = await this.get<{ thread_id: string }>(
      'SELECT thread_id FROM agent_sessions WHERE contact_key = ?',
      [actor.contactKey]
    )
    if (session) {
      const thread = await this.getThread(session.thread_id)
      if (thread) {
        await this.refreshThreadOrigin(thread.id, actor)
        return (await this.getThread(thread.id))!
      }
    }

    const thread = await this.getOrCreateThread(actor.contactKey, actor)
    await this.activateSession(actor.contactKey, thread.id)
    return thread
  }

  async createSession (actor: AgentActor) {
    const thread = await this.getOrCreateThread(
      `${actor.contactKey}:session:${randomUUID()}`,
      actor
    )
    await this.activateSession(actor.contactKey, thread.id)
    return thread
  }

  async activateSession (contactKey: string, threadId: string) {
    await this.run(
      `INSERT INTO agent_sessions(contact_key, thread_id, updated_at)
       VALUES(?, ?, ?)
       ON CONFLICT(contact_key) DO UPDATE SET
         thread_id = excluded.thread_id,
         updated_at = excluded.updated_at`,
      [contactKey, threadId, Date.now()]
    )
  }

  async listThreads (
    options: number | {
      limit?: number
      state?: 'active' | 'archived' | 'all'
      query?: string
      cursor?: number
      channel?: string
      rootOnly?: boolean
    } = 100
  ) {
    const normalized = typeof options === 'number' ? { limit: options } : options
    const conditions: string[] = []
    const params: unknown[] = []
    if (normalized.state === 'archived') conditions.push('threads.archived_at IS NOT NULL')
    else if (normalized.state !== 'all') conditions.push('threads.archived_at IS NULL')
    if (normalized.channel?.trim()) {
      conditions.push('threads.channel_kind = ?')
      params.push(normalized.channel.trim())
    }
    if (normalized.rootOnly) conditions.push('threads.parent_thread_id IS NULL')
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

  async listThreadChannels () {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT channel_kind,
        SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_count,
        MAX(updated_at) AS last_updated_at
       FROM threads
       WHERE parent_thread_id IS NULL
         AND channel_kind NOT IN ('', 'system')
       GROUP BY channel_kind
       ORDER BY last_updated_at DESC`
    )
    const channels = rows.map(row => ({
      channel: String(row.channel_kind),
      activeCount: Number(row.active_count || 0),
      archivedCount: Number(row.archived_count || 0),
      lastUpdatedAt: Number(row.last_updated_at || 0),
    }))
    if (!channels.some(item => item.channel === 'web')) {
      channels.push({
        channel: 'web',
        activeCount: 0,
        archivedCount: 0,
        lastUpdatedAt: 0,
      })
    }
    return channels
  }

  async getThreadTree (rootId: string) {
    const nodes = await this.all<{ id: string, depth: number }>(
      `WITH RECURSIVE tree(id, depth) AS (
        SELECT id, 0 FROM threads WHERE id = ?
        UNION ALL
        SELECT threads.id, tree.depth + 1
        FROM threads JOIN tree ON threads.parent_thread_id = tree.id
       )
       SELECT id, depth FROM tree ORDER BY depth ASC`,
      [rootId]
    )
    return (await Promise.all(nodes.map(async node => {
      const thread = await this.getThread(node.id)
      return thread ? { ...thread, depth: node.depth } : null
    }))).filter((thread): thread is AgentThreadRecord & { depth: number } => Boolean(thread))
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

  async setThreadModel (
    id: string,
    providerId: string | null,
    modelName: string | null
  ) {
    const result = await this.run(
      `UPDATE threads
       SET model_provider_id = ?, model_name = ?, updated_at = ?
       WHERE id = ?`,
      [providerId, modelName, Date.now(), id]
    )
    if (!result.changes) throw new Error('会话不存在')
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

  async listTurns (threadId: string) {
    const rows = await this.all<Record<string, unknown>>(
      'SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at ASC',
      [threadId]
    )
    return rows.map(row => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      actorId: String(row.actor_id),
      state: row.state as AgentThreadState,
      automated: Boolean(row.automated),
      error: row.error ? String(row.error) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
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
      attachments?: AgentMessageAttachmentInput[]
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
    for (const attachment of options.attachments || []) {
      await this.run(
        `INSERT INTO message_attachments(
          id, message_id, thread_id, type, storage_path, mime, size, name, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          id,
          threadId,
          attachment.type,
          attachment.storagePath,
          attachment.mime,
          attachment.size,
          attachment.name,
          now,
        ]
      )
    }
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
    const messageIds = rows.map(row => String(row.id))
    const attachments = messageIds.length
      ? await this.all<Record<string, unknown>>(
        `SELECT * FROM message_attachments
         WHERE message_id IN (${messageIds.map(() => '?').join(', ')})
         ORDER BY created_at ASC`,
        messageIds
      )
      : []
    return rows.map(row => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      turnId: row.turn_id ? String(row.turn_id) : null,
      role: row.role as AgentMessageRole,
      content: String(row.content),
      name: row.name ? String(row.name) : undefined,
      toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined,
      toolCalls: parseJson<AgentToolCall[]>(row.tool_calls_json as string, []),
      attachments: attachments
        .filter(item => String(item.message_id) === String(row.id))
        .map(item => ({
          id: String(item.id),
          messageId: String(item.message_id),
          type: 'image' as const,
          mime: String(item.mime),
          size: Number(item.size),
          name: String(item.name),
          url: `/api/v1/agent/media/${String(item.id)}`,
          createdAt: Number(item.created_at),
        })),
      createdAt: Number(row.created_at),
    }))
  }

  async getMessageAttachment (id: string) {
    const row = await this.get<Record<string, unknown>>(
      'SELECT * FROM message_attachments WHERE id = ?',
      [id]
    )
    if (!row) return null
    return {
      id: String(row.id),
      messageId: String(row.message_id),
      threadId: String(row.thread_id),
      type: 'image' as const,
      storagePath: String(row.storage_path),
      mime: String(row.mime),
      size: Number(row.size),
      name: String(row.name),
      createdAt: Number(row.created_at),
    }
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
    const attachments = await this.all<{ storage_path: string }>(
      `SELECT storage_path FROM message_attachments
       WHERE thread_id IN (${placeholders})`,
      ids
    )
    await this.exec('BEGIN IMMEDIATE')
    try {
      if (this.ftsAvailable) {
        await this.run(`DELETE FROM message_fts WHERE thread_id IN (${placeholders})`, ids)
      }
      for (const table of [
        'message_attachments',
        'thread_skill_snapshots',
        'thread_tool_grants',
        'approvals',
        'tool_calls',
        'usage',
        'agent_retrieval_log',
        'agent_feedback',
        'agent_experiences',
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
      await Promise.allSettled(attachments.map(attachment =>
        fs.promises.unlink(attachment.storage_path)
      ))
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
    approverContactKey: string | null,
    call: AgentToolCall,
    ttlMs: number
  ) {
    const id = randomUUID()
    const now = Date.now()
    await this.run(
      `INSERT INTO approvals(
        id, thread_id, turn_id, tool_call_id, actor_id, tool_name, input_json,
        approver_contact_key, status, expires_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        threadId,
        turnId,
        call.id,
        actorId,
        call.name,
        JSON.stringify(call.arguments),
        approverContactKey,
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
      approverContactKey: row.approver_contact_key
        ? String(row.approver_contact_key)
        : null,
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

  async listApprovalsByThread (threadId: string) {
    const rows = await this.all<Record<string, unknown>>(
      'SELECT * FROM approvals WHERE thread_id = ? ORDER BY created_at ASC',
      [threadId]
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

  async getActiveScriptSkillVersions () {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT sv.*
       FROM skills AS s
       INNER JOIN skill_versions AS sv ON sv.id = s.active_version_id
       WHERE s.enabled = 1
       ORDER BY s.updated_at DESC`
    )
    return rows.map(row => ({
      skillId: String(row.skill_id),
      versionId: String(row.id),
      version: Number(row.version),
      scriptTools: parseJson<AgentScriptToolDefinition[]>(
        row.script_tools_json as string,
        []
      ),
    }))
  }

  async addSkillVersion (input: {
    skillId?: string
    newSkillId?: string
    name: string
    description: string
    content: string
    tools: string[]
    sourceTurnId: string
    contentHash: string
    scriptTools?: AgentScriptToolDefinition[]
  }) {
    const now = Date.now()
    const existing = input.skillId
      ? await this.get<Record<string, unknown>>('SELECT * FROM skills WHERE id = ?', [input.skillId])
      : await this.get<Record<string, unknown>>('SELECT * FROM skills WHERE name = ?', [input.name])
    if (input.skillId && !existing) throw new Error('Skill 不存在')
    const duplicate = await this.get<{ id: string }>(
      'SELECT id FROM skills WHERE name = ? AND id != ?',
      [input.name, input.skillId || '']
    )
    if (duplicate) throw new Error(`Skill 名称已存在: ${input.name}`)
    const skillId = existing ? String(existing.id) : input.newSkillId || randomUUID()
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
        content_hash, validation_status, created_at, name, description, script_tools_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?)`,
      [
        versionId,
        skillId,
        Number(row?.version || 0) + 1,
        input.content,
        JSON.stringify(input.tools),
        input.sourceTurnId,
        input.contentHash,
        now,
        input.name,
        input.description,
        JSON.stringify(input.scriptTools || []),
      ]
    )
    await this.run(
      `UPDATE skills
       SET name = ?, description = ?, active_version_id = ?, updated_at = ?
       WHERE id = ?`,
      [input.name, input.description, versionId, now, skillId]
    )
    return { skillId, versionId }
  }

  async rollbackSkill (skillId: string, versionId: string) {
    const version = await this.get<{ id: string; name: string; description: string }>(
      `SELECT id, name, description FROM skill_versions
       WHERE id = ? AND skill_id = ?`,
      [versionId, skillId]
    )
    if (!version) return false
    const duplicate = await this.get<{ id: string }>(
      'SELECT id FROM skills WHERE name = ? AND id != ?',
      [version.name, skillId]
    )
    if (duplicate) throw new Error(`无法回滚：Skill 名称已被占用 ${version.name}`)
    await this.run(
      `UPDATE skills
       SET name = ?, description = ?, active_version_id = ?, updated_at = ?
       WHERE id = ?`,
      [version.name, version.description, versionId, Date.now(), skillId]
    )
    return true
  }

  async getSkill (skillId: string) {
    const row = await this.get<Record<string, unknown>>(
      'SELECT * FROM skills WHERE id = ?',
      [skillId]
    )
    if (!row) return null
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      enabled: Boolean(row.enabled),
      activeVersionId: row.active_version_id ? String(row.active_version_id) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    } satisfies AgentSkillRecord
  }

  async deleteSkillCascade (skillId: string, actorId: string) {
    const skill = await this.getSkill(skillId)
    if (!skill) throw new Error('Skill 不存在')
    const jobs = await this.listJobs()
    const affectedJobs = jobs.filter(job => job.skillIds.includes(skillId))
    const candidates = await this.all<{
      id: string
      state: string
      payload_json: string
    }>(
      'SELECT id, state, payload_json FROM evolution_candidates WHERE target = \'skill\''
    )
    const affectedCandidates = candidates.filter(candidate =>
      String(parseJson<Record<string, unknown>>(candidate.payload_json, {}).skillId || '') === skillId
    )
    const snapshotCount = Number((await this.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM thread_skill_snapshots WHERE skill_id = ?',
      [skillId]
    ))?.count || 0)
    const versionCount = Number((await this.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM skill_versions WHERE skill_id = ?',
      [skillId]
    ))?.count || 0)

    await this.exec('BEGIN IMMEDIATE')
    try {
      const now = Date.now()
      for (const job of affectedJobs) {
        await this.run(
          'UPDATE agent_jobs SET skill_ids_json = ?, updated_at = ? WHERE id = ?',
          [JSON.stringify(job.skillIds.filter(id => id !== skillId)), now, job.id]
        )
      }
      for (const candidate of affectedCandidates) {
        const payload = parseJson<Record<string, unknown>>(candidate.payload_json, {})
        delete payload.skillId
        payload.deletedSkillId = skillId
        const state = ['rejected', 'rolled_back'].includes(candidate.state)
          ? candidate.state
          : 'rolled_back'
        await this.run(
          `UPDATE evolution_candidates
           SET state = ?, payload_json = ?, updated_at = ?
           WHERE id = ?`,
          [state, JSON.stringify(payload), now, candidate.id]
        )
        await this.run(
          `INSERT INTO evolution_events(id, candidate_id, action, actor_id, detail_json, created_at)
           VALUES(?, ?, 'skill.deleted', ?, ?, ?)`,
          [randomUUID(), candidate.id, actorId, JSON.stringify({ skillId }), now]
        )
      }
      await this.run('DELETE FROM thread_skill_snapshots WHERE skill_id = ?', [skillId])
      await this.run(
        'DELETE FROM agent_retrieval_log WHERE kind = \'skill\' AND item_id = ?',
        [skillId]
      )
      await this.run('DELETE FROM skill_usage WHERE skill_id = ?', [skillId])
      await this.run('DELETE FROM skill_versions WHERE skill_id = ?', [skillId])
      await this.run('DELETE FROM skills WHERE id = ?', [skillId])
      await this.run(
        `INSERT INTO audit_log(
          id, thread_id, actor_id, action, target, detail_json, created_at
        ) VALUES(?, NULL, ?, 'skill.delete', ?, ?, ?)`,
        [
          randomUUID(),
          actorId,
          skillId,
          JSON.stringify({
            name: skill.name,
            versions: versionCount,
            snapshots: snapshotCount,
            jobsUpdated: affectedJobs.length,
            candidatesUpdated: affectedCandidates.length,
          }),
          now,
        ]
      )
      await this.exec('COMMIT')
      return {
        deleted: true,
        name: skill.name,
        versions: versionCount,
        snapshots: snapshotCount,
        jobsUpdated: affectedJobs.length,
        candidatesUpdated: affectedCandidates.length,
      }
    } catch (error) {
      await this.exec('ROLLBACK')
      throw error
    }
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
    const rows = await this.all<{ id: string; name: string; content: string }>(
      `SELECT s.id, s.name, sv.content
       FROM thread_skill_snapshots snapshot
       JOIN skills s ON s.id = snapshot.skill_id
       JOIN skill_versions sv ON sv.id = snapshot.skill_version_id
       WHERE snapshot.thread_id = ?`,
      [threadId]
    )
    return rows
  }

  async recordExperience (
    input: Omit<AgentExperienceRecord, 'id' | 'createdAt'>
  ) {
    const id = randomUUID()
    await this.run(
      `INSERT INTO agent_experiences(
        id, thread_id, turn_id, actor_id, task, outcome, tool_names_json,
        skill_ids_json, error, correction, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.threadId,
        input.turnId,
        input.actorId,
        input.task.slice(0, 20000),
        input.outcome,
        JSON.stringify(input.toolNames),
        JSON.stringify(input.skillIds),
        input.error || null,
        input.correction || null,
        Date.now(),
      ]
    )
    return id
  }

  async listExperiences (limit = 200, outcome?: AgentExperienceRecord['outcome']) {
    const rows = outcome
      ? await this.all<Record<string, unknown>>(
        'SELECT * FROM agent_experiences WHERE outcome = ? ORDER BY created_at DESC LIMIT ?',
        [outcome, Math.max(1, Math.min(limit, 1000))]
      )
      : await this.all<Record<string, unknown>>(
        'SELECT * FROM agent_experiences ORDER BY created_at DESC LIMIT ?',
        [Math.max(1, Math.min(limit, 1000))]
      )
    return rows.map(row => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      actorId: String(row.actor_id),
      task: String(row.task),
      outcome: row.outcome as AgentExperienceRecord['outcome'],
      toolNames: parseJson<string[]>(row.tool_names_json as string, []),
      skillIds: parseJson<string[]>(row.skill_ids_json as string, []),
      error: row.error ? String(row.error) : undefined,
      correction: row.correction ? String(row.correction) : undefined,
      createdAt: Number(row.created_at),
    }))
  }

  async addFeedback (input: {
    threadId: string
    turnId?: string
    actorId: string
    rating?: number
    correction?: string
  }) {
    const id = randomUUID()
    await this.run(
      `INSERT INTO agent_feedback(
        id, thread_id, turn_id, actor_id, rating, correction, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.threadId,
        input.turnId || null,
        input.actorId,
        input.rating ?? null,
        input.correction?.trim().slice(0, 4000) || null,
        Date.now(),
      ]
    )
    return id
  }

  async recordRetrieval (input: {
    threadId: string
    turnId: string
    kind: 'memory' | 'skill' | 'tool'
    itemId: string
    rank: number
    selected?: boolean
    outcome?: string
  }) {
    await this.run(
      `INSERT INTO agent_retrieval_log(
        id, thread_id, turn_id, kind, item_id, rank, selected, outcome, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.threadId,
        input.turnId,
        input.kind,
        input.itemId,
        input.rank,
        input.selected === false ? 0 : 1,
        input.outcome || null,
        Date.now(),
      ]
    )
  }

  private mapEvolutionCandidate (row: Record<string, unknown>): AgentEvolutionCandidate {
    return {
      id: String(row.id),
      target: row.target as AgentEvolutionTarget,
      kind: row.kind === 'executable' ? 'executable' : 'declarative',
      sourceTurnIds: parseJson<string[]>(row.source_turn_ids_json as string, []),
      baselineVersion: row.baseline_version ? String(row.baseline_version) : undefined,
      candidateVersion: String(row.candidate_version),
      state: row.state as AgentEvolutionState,
      summary: String(row.summary),
      payload: parseJson<Record<string, unknown>>(row.payload_json as string, {}),
      metrics: parseJson<AgentEvolutionMetrics | undefined>(
        row.metrics_json as string,
        undefined
      ),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  async createEvolutionCandidate (input: {
    target: AgentEvolutionTarget
    kind: 'declarative' | 'executable'
    sourceTurnIds: string[]
    baselineVersion?: string
    candidateVersion: string
    summary: string
    payload: Record<string, unknown>
  }) {
    const id = randomUUID()
    const now = Date.now()
    await this.run(
      `INSERT INTO evolution_candidates(
        id, target, kind, source_turn_ids_json, baseline_version,
        candidate_version, state, summary, payload_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [
        id,
        input.target,
        input.kind,
        JSON.stringify([...new Set(input.sourceTurnIds)]),
        input.baselineVersion || null,
        input.candidateVersion,
        input.summary.slice(0, 500),
        JSON.stringify(input.payload),
        now,
        now,
      ]
    )
    return this.getEvolutionCandidate(id)
  }

  async getEvolutionCandidate (id: string) {
    const row = await this.get<Record<string, unknown>>(
      'SELECT * FROM evolution_candidates WHERE id = ?',
      [id]
    )
    return row ? this.mapEvolutionCandidate(row) : null
  }

  async listEvolutionCandidates (
    state?: AgentEvolutionState,
    limit = 200
  ) {
    const rows = state
      ? await this.all<Record<string, unknown>>(
        'SELECT * FROM evolution_candidates WHERE state = ? ORDER BY created_at DESC LIMIT ?',
        [state, Math.max(1, Math.min(limit, 1000))]
      )
      : await this.all<Record<string, unknown>>(
        'SELECT * FROM evolution_candidates ORDER BY created_at DESC LIMIT ?',
        [Math.max(1, Math.min(limit, 1000))]
      )
    return rows.map(row => this.mapEvolutionCandidate(row))
  }

  async updateEvolutionCandidate (
    id: string,
    state: AgentEvolutionState,
    metrics?: AgentEvolutionMetrics
  ) {
    const result = await this.run(
      `UPDATE evolution_candidates
       SET state = ?, metrics_json = COALESCE(?, metrics_json), updated_at = ?
       WHERE id = ?`,
      [state, metrics ? JSON.stringify(metrics) : null, Date.now(), id]
    )
    return result.changes > 0
  }

  async updateEvolutionPayload (
    id: string,
    payload: Record<string, unknown>,
    baselineVersion?: string
  ) {
    const result = await this.run(
      `UPDATE evolution_candidates
       SET payload_json = ?, baseline_version = COALESCE(?, baseline_version), updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(payload), baselineVersion || null, Date.now(), id]
    )
    return result.changes > 0
  }

  async addEvolutionEvaluation (
    candidateId: string,
    passed: boolean,
    metrics: AgentEvolutionMetrics,
    report: string
  ) {
    const id = randomUUID()
    await this.run(
      `INSERT INTO evolution_evaluations(
        id, candidate_id, passed, metrics_json, report, created_at
      ) VALUES(?, ?, ?, ?, ?, ?)`,
      [id, candidateId, passed ? 1 : 0, JSON.stringify(metrics), report.slice(0, 10000), Date.now()]
    )
    return id
  }

  async addEvolutionEvent (
    candidateId: string,
    action: string,
    actorId: string,
    detail: unknown
  ) {
    await this.run(
      `INSERT INTO evolution_events(
        id, candidate_id, action, actor_id, detail_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?)`,
      [randomUUID(), candidateId, action, actorId, JSON.stringify(detail), Date.now()]
    )
  }

  async evolutionOverview () {
    const [candidateCounts, outcomes, feedback, retrieval] = await Promise.all([
      this.all<{ state: string; count: number }>(
        'SELECT state, COUNT(*) AS count FROM evolution_candidates GROUP BY state'
      ),
      this.all<{ outcome: string; count: number }>(
        'SELECT outcome, COUNT(*) AS count FROM agent_experiences GROUP BY outcome'
      ),
      this.get<{ total: number; corrected: number }>(
        `SELECT COUNT(*) AS total,
         SUM(CASE WHEN correction IS NOT NULL AND correction != '' THEN 1 ELSE 0 END) AS corrected
         FROM agent_feedback`
      ),
      this.get<{ total: number; selected: number }>(
        `SELECT COUNT(*) AS total,
         SUM(CASE WHEN selected = 1 THEN 1 ELSE 0 END) AS selected
         FROM agent_retrieval_log`
      ),
    ])
    return {
      candidates: Object.fromEntries(candidateCounts.map(item => [item.state, Number(item.count)])),
      outcomes: Object.fromEntries(outcomes.map(item => [item.outcome, Number(item.count)])),
      feedback: {
        total: Number(feedback?.total || 0),
        corrected: Number(feedback?.corrected || 0),
      },
      retrieval: {
        total: Number(retrieval?.total || 0),
        selected: Number(retrieval?.selected || 0),
      },
    }
  }

  async touchSkillUsage (
    skillId: string,
    outcome: 'completed' | 'failed' | 'corrected'
  ) {
    await this.run(
      `INSERT INTO skill_usage(
        skill_id, use_count, success_count, failure_count, correction_count, last_used_at
      ) VALUES(?, 1, ?, ?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        use_count = use_count + 1,
        success_count = success_count + excluded.success_count,
        failure_count = failure_count + excluded.failure_count,
        correction_count = correction_count + excluded.correction_count,
        last_used_at = excluded.last_used_at`,
      [
        skillId,
        outcome === 'completed' ? 1 : 0,
        outcome === 'failed' ? 1 : 0,
        outcome === 'corrected' ? 1 : 0,
        Date.now(),
      ]
    )
  }

  async getSkillUsage (skillId: string): Promise<Record<string, unknown> | undefined>
  async getSkillUsage (): Promise<Record<string, unknown>[]>
  async getSkillUsage (skillId?: string) {
    if (skillId) {
      return this.get<Record<string, unknown>>(
        'SELECT * FROM skill_usage WHERE skill_id = ?',
        [skillId]
      )
    }
    return this.all<Record<string, unknown>>(
      'SELECT * FROM skill_usage ORDER BY last_used_at DESC'
    )
  }

  async curateSkillUsage (staleBefore: number, archiveBefore: number) {
    await this.run(
      `UPDATE skill_usage SET state = 'stale'
       WHERE pinned = 0 AND state = 'active' AND last_used_at IS NOT NULL AND last_used_at < ?`,
      [staleBefore]
    )
    await this.run(
      `UPDATE skill_usage SET state = 'archived', archived_at = ?
       WHERE pinned = 0 AND state IN ('active', 'stale')
       AND last_used_at IS NOT NULL AND last_used_at < ?`,
      [Date.now(), archiveBefore]
    )
    return this.getSkillUsage()
  }

  async grantThreadTool (input: {
    threadId: string
    actorId: string
    toolName: string
    risk: AgentToolRisk
    mode: 'tool' | 'delegate'
  }) {
    const id = randomUUID()
    await this.run(
      `INSERT INTO thread_tool_grants(
        id, thread_id, actor_id, tool_name, risk, mode, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.threadId,
        input.actorId,
        input.toolName,
        input.risk,
        input.mode,
        Date.now(),
      ]
    )
    return id
  }

  async hasThreadToolGrant (
    threadId: string,
    toolName: string,
    risk: AgentToolRisk
  ) {
    const row = await this.get<{ id: string }>(
      `SELECT id FROM thread_tool_grants
       WHERE thread_id = ? AND revoked_at IS NULL
       AND (
         (mode = 'tool' AND tool_name = ?) OR
         (mode = 'delegate' AND ? IN ('read', 'write'))
       )
       ORDER BY created_at DESC LIMIT 1`,
      [threadId, toolName, risk]
    )
    return Boolean(row)
  }

  async listThreadToolGrants (threadId: string) {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT * FROM thread_tool_grants
       WHERE thread_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      [threadId]
    )
    return rows.map(row => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      actorId: String(row.actor_id),
      toolName: String(row.tool_name),
      risk: row.risk as AgentToolRisk,
      mode: row.mode === 'delegate' ? 'delegate' as const : 'tool' as const,
      createdAt: Number(row.created_at),
      revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
    }))
  }

  async revokeThreadToolGrant (threadId: string, id: string) {
    const result = await this.run(
      `UPDATE thread_tool_grants SET revoked_at = ?
       WHERE id = ? AND thread_id = ? AND revoked_at IS NULL`,
      [Date.now(), id, threadId]
    )
    return result.changes > 0
  }

  async revokeAllThreadToolGrants (threadId: string) {
    const result = await this.run(
      `UPDATE thread_tool_grants SET revoked_at = ?
       WHERE thread_id = ? AND revoked_at IS NULL`,
      [Date.now(), threadId]
    )
    return result.changes
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
