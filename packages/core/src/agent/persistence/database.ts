import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sqlite3, { type Database } from 'sqlite3'
import { inferAgentOrigin } from '../ingress/origin'

import type {
  AgentActor,
  AgentEvolutionCandidate,
  AgentEvolutionLogEntry,
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
  AgentTaskItemStatus,
  AgentTaskList,
  AgentGeneratedToolRecord,
  AgentGeneratedToolVersion,
  AgentDeliveryState,
  AgentStreamEvent,
  AgentToolArtifact,
  AgentInstructionVersion,
  AgentPersonaDefinition,
  AgentPersonaRecord,
  AgentPersonaVersion,
} from '@/types/agent'

export interface AgentContextSummaryRecord {
  id: string
  threadId: string
  parentId: string | null
  content: string
  estimatedTokens: number
  sourceMessageIds: string[]
  createdAt: number
}

export interface AgentDeliveryOperationRecord {
  id: string
  threadId: string
  turnId: string
  finalMessageId: string
  idempotencyKey: string
  channel: string
  accountId: string
  contactKey: string
  payloadHash: string
  state: AgentDeliveryState
  adapterMessageId: string | null
  attempts: number
  errorCode: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

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
  instructionVersionId: string | null
  personaVersionId: string | null
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
  kind: 'preference' | 'fact' | 'relationship' | 'procedure' | 'constraint'
  memoryKey: string | null
  confidence: number
  importance: number
  pinned: boolean
  status: 'active' | 'superseded' | 'archived'
  contentHash: string
  sourceType: 'legacy' | 'reflection' | 'correction' | 'explicit' | 'web'
  expiresAt: number | null
  lastUsedAt: number | null
  useCount: number
  supersededBy: string | null
  createdAt: number
  updatedAt: number
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
  personaId: string | null
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
  {
    version: 11,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_task_lists (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_task_items (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(list_id) REFERENCES agent_task_lists(id) ON DELETE CASCADE,
        UNIQUE(list_id, item_key)
      );

      CREATE TABLE IF NOT EXISTS generated_tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        active_version_id TEXT,
        legacy_alias TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generated_tool_versions (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        validation_status TEXT NOT NULL,
        validation_report TEXT NOT NULL DEFAULT '',
        source_turn_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(tool_id) REFERENCES generated_tools(id) ON DELETE CASCADE,
        UNIQUE(tool_id, version)
      );

      CREATE TABLE IF NOT EXISTS thread_skill_loads (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_version_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      ALTER TABLE skill_versions
      ADD COLUMN files_manifest_json TEXT NOT NULL DEFAULT '{}';

      CREATE INDEX IF NOT EXISTS idx_agent_task_lists_thread_state
      ON agent_task_lists(thread_id, state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_agent_task_items_list_order
      ON agent_task_items(list_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_generated_tool_versions_tool
      ON generated_tool_versions(tool_id, version);
      CREATE INDEX IF NOT EXISTS idx_thread_skill_loads_turn
      ON thread_skill_loads(thread_id, turn_id, created_at);
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE turns ADD COLUMN final_message_id TEXT;
      ALTER TABLE turns ADD COLUMN resumed_from_turn_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_turns_resumed_from
      ON turns(resumed_from_turn_id);
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE turns ADD COLUMN request_key TEXT;
      ALTER TABLE turns ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE turns ADD COLUMN lease_token TEXT;
      ALTER TABLE turns ADD COLUMN lease_expires_at INTEGER;
      ALTER TABLE turns ADD COLUMN checkpoint_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE messages ADD COLUMN source_key TEXT;
      ALTER TABLE tool_calls ADD COLUMN idempotent INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tool_calls ADD COLUMN restart_safe INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE skills ADD COLUMN provenance TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE skills ADD COLUMN adopted_at INTEGER;
      ALTER TABLE skills ADD COLUMN disabled_at INTEGER;
      ALTER TABLE skills ADD COLUMN archived_at INTEGER;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_request_key
      ON turns(thread_id, request_key) WHERE request_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_key
      ON messages(thread_id, source_key) WHERE source_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS agent_turn_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_turn_events_thread
      ON agent_turn_events(thread_id, id);

      CREATE TABLE IF NOT EXISTS agent_context_summaries (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        parent_id TEXT,
        content TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_context_summaries_thread
      ON agent_context_summaries(thread_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_delivery_operations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        final_message_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        contact_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        adapter_message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_delivery_thread
      ON agent_delivery_operations(thread_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_tool_artifacts (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        content_json TEXT NOT NULL,
        preview TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS skill_activity (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_version_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(skill_id) REFERENCES skills(id)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_activity_skill
      ON skill_activity(skill_id, created_at);
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE threads ADD COLUMN instruction_version_id TEXT;
      ALTER TABLE threads ADD COLUMN persona_version_id TEXT;
      ALTER TABLE agent_jobs ADD COLUMN persona_id TEXT;

      ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact';
      ALTER TABLE memories ADD COLUMN memory_key TEXT;
      ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7;
      ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;
      ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE memories ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE memories ADD COLUMN source_type TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE memories ADD COLUMN expires_at INTEGER;
      ALTER TABLE memories ADD COLUMN last_used_at INTEGER;
      ALTER TABLE memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN superseded_by TEXT;
      ALTER TABLE memories ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS agent_instruction_versions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_personas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        active_version_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_persona_versions (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(persona_id, version),
        FOREIGN KEY(persona_id) REFERENCES agent_personas(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memories_retrieval
      ON memories(scope, scope_key, status, pinned, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memories_key
      ON memories(scope, scope_key, memory_key, status);
      CREATE INDEX IF NOT EXISTS idx_memory_sources_memory
      ON memory_sources(memory_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_personas_default
      ON agent_personas(is_default, enabled);
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
  private transactionQueue: Promise<unknown> = Promise.resolve()

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
    await this.migrateLegacyScriptTools()

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

    const bootstrapTime = Date.now()
    await this.run(
      `INSERT OR IGNORE INTO agent_instruction_versions(
        id, version, content, content_hash, source, created_by, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        'instruction-default-v1',
        1,
        '',
        createHash('sha256').update('').digest('hex'),
        'default',
        'karin',
        bootstrapTime,
      ]
    )
    const defaultPersona = {
      identity: 'Karin Agent，一个以解决问题为目标的行动型 Agent。',
      expertise: ['通用问题解决', '机器人自动化'],
      tone: '清晰、直接、诚实',
      responseStyle: '先给结论，再提供必要的过程与证据。',
      language: '跟随用户使用的语言',
    }
    await this.run(
      `INSERT OR IGNORE INTO agent_personas(
        id, name, description, enabled, is_default, active_version_id, created_at, updated_at
       ) VALUES(?, ?, ?, 1, 1, ?, ?, ?)`,
      [
        'karin-default',
        'Karin',
        '默认的行动型通用助手',
        'persona-karin-default-v1',
        bootstrapTime,
        bootstrapTime,
      ]
    )
    await this.run(
      `INSERT OR IGNORE INTO agent_persona_versions(
        id, persona_id, version, definition_json, created_by, created_at
       ) VALUES(?, ?, 1, ?, ?, ?)`,
      [
        'persona-karin-default-v1',
        'karin-default',
        JSON.stringify(defaultPersona),
        'karin',
        bootstrapTime,
      ]
    )

    const legacyMemories = await this.all<{ id: string; content: string; created_at: number }>(
      `SELECT id, content, created_at FROM memories
       WHERE content_hash = '' OR updated_at = 0`
    )
    for (const memory of legacyMemories) {
      await this.run(
        'UPDATE memories SET content_hash = ?, updated_at = ? WHERE id = ?',
        [
          createHash('sha256').update(memory.content.trim()).digest('hex'),
          Number(memory.created_at) || bootstrapTime,
          memory.id,
        ]
      )
    }

    try {
      await this.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS message_fts
        USING fts5(message_id UNINDEXED, thread_id UNINDEXED, content);
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
        USING fts5(memory_id UNINDEXED, scope UNINDEXED, scope_key UNINDEXED, content)
      `)
      await this.run('DELETE FROM memory_fts')
      await this.exec(`
        INSERT INTO memory_fts(memory_id, scope, scope_key, content)
        SELECT id, scope, scope_key, content FROM memories
        WHERE enabled = 1 AND status = 'active'
      `)
      this.ftsAvailable = true
    } catch (error) {
      this.ftsAvailable = false
      logger.warn(`[agent][database] FTS5 不可用: ${(error as Error).message}`)
    }

    const now = Date.now()
    await this.run('UPDATE turns SET state = ?, error = ?, updated_at = ? WHERE state IN (?, ?)', [
      'recovery_pending',
      'Karin 重启，等待安全恢复',
      now,
      'running',
      'stopping',
    ])
    await this.run('UPDATE threads SET state = ?, updated_at = ? WHERE state IN (?, ?)', [
      'recovery_pending',
      now,
      'running',
      'stopping',
    ])
    await this.run(
      'UPDATE approvals SET status = ?, resolved_at = ? WHERE status = ? AND expires_at <= ?',
      [
        'expired',
        now,
        'pending',
        now,
      ]
    )
  }

  private async migrateLegacyScriptTools () {
    const rows = await this.all<{
      skill_id: string
      id: string
      active_version_id: string | null
      script_tools_json: string
      source_turn_id: string
    }>(
      `SELECT
         sv.skill_id,
         sv.id,
         s.active_version_id,
         sv.script_tools_json,
         sv.source_turn_id
       FROM skill_versions sv
       JOIN skills s ON s.id = sv.skill_id
       WHERE sv.script_tools_json <> '[]'
       ORDER BY sv.skill_id ASC, sv.version ASC`
    )
    for (const row of rows) {
      const definitions = parseJson<AgentScriptToolDefinition[]>(
        row.script_tools_json,
        []
      )
      for (const definition of definitions) {
        const legacyAlias =
          `skill.skill_${row.skill_id.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}.${definition.id}`
        const current = await this.getGeneratedTool(legacyAlias)
        const versions = current
          ? await this.getGeneratedToolVersions(current.id)
          : []
        const duplicateVersion = versions.find(version =>
          version.definition.sourceHash === definition.sourceHash
        )
        if (duplicateVersion) {
          if (row.active_version_id === row.id) {
            await this.rollbackGeneratedTool(current!.id, duplicateVersion.id)
          }
          continue
        }
        await this.addGeneratedToolVersion({
          toolId: current?.id,
          name: legacyAlias,
          description: definition.description,
          definition,
          validationStatus: 'valid',
          validationReport: '从旧 Skill Script Tool 无损迁移',
          sourceTurnId: row.source_turn_id,
          activate: row.active_version_id === row.id,
          legacyAlias,
        })
      }
    }
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

  private transaction<T> (operation: () => Promise<T>): Promise<T> {
    const current = this.transactionQueue
      .catch(() => undefined)
      .then(async () => {
        await this.exec('BEGIN IMMEDIATE')
        try {
          const result = await operation()
          await this.exec('COMMIT')
          return result
        } catch (error) {
          await this.exec('ROLLBACK')
          throw error
        }
      })
    this.transactionQueue = current.then(() => undefined, () => undefined)
    return current
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
      instructionVersionId: row.instruction_version_id
        ? String(row.instruction_version_id)
        : null,
      personaVersionId: row.persona_version_id ? String(row.persona_version_id) : null,
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
        `SELECT model_provider_id, model_name, instruction_version_id, persona_version_id,
          channel_kind, protocol,
          account_id, account_name, contact_key, contact_id, contact_sub_id, contact_name
         FROM threads WHERE id = ?`,
        [parentThreadId]
      )
      : null
    const instructionVersionId = parent?.instruction_version_id
      ? String(parent.instruction_version_id)
      : (await this.get<{ id: string }>(
        'SELECT id FROM agent_instruction_versions ORDER BY version DESC LIMIT 1'
      ))?.id || 'instruction-default-v1'
    const personaVersionId = parent?.persona_version_id
      ? String(parent.persona_version_id)
      : (await this.get<{ active_version_id: string }>(
          `SELECT active_version_id FROM agent_personas
           WHERE is_default = 1 AND enabled = 1 LIMIT 1`
      ))?.active_version_id || 'persona-karin-default-v1'
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
          model_provider_id, model_name, instruction_version_id, persona_version_id,
          channel_kind, protocol,
          account_id, account_name, contact_key, contact_id, contact_sub_id, contact_name,
          created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          threadKey,
          parentThreadId || null,
          actor.id,
          actor.scene,
          'idle',
          parent?.model_provider_id || null,
          parent?.model_name || null,
          instructionVersionId,
          personaVersionId,
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
           WHERE enabled = 1 AND archived_at IS NULL AND active_version_id IS NOT NULL`,
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
      instructionVersionId,
      personaVersionId,
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

  async updateThreadSummary (id: string, summary: string) {
    const value = summary.trim().slice(-12_000)
    await this.run(
      'UPDATE threads SET summary = ?, updated_at = ? WHERE id = ?',
      [value, Date.now(), id]
    )
    return value
  }

  async createContextSummary (input: {
    threadId: string
    parentId?: string | null
    content: string
    estimatedTokens: number
    sourceMessageIds: string[]
  }): Promise<AgentContextSummaryRecord> {
    return this.transaction(async () => {
      const id = randomUUID()
      const now = Date.now()
      const content = input.content.trim().slice(-64_000)
      await this.run(
        `INSERT INTO agent_context_summaries(
          id, thread_id, parent_id, content, estimated_tokens,
          source_message_ids_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.threadId,
          input.parentId || null,
          content,
          Math.max(0, input.estimatedTokens),
          JSON.stringify(input.sourceMessageIds),
          now,
        ]
      )
      await this.run(
        'UPDATE threads SET summary = ?, updated_at = ? WHERE id = ?',
        [content.slice(-12_000), now, input.threadId]
      )
      return {
        id,
        threadId: input.threadId,
        parentId: input.parentId || null,
        content,
        estimatedTokens: Math.max(0, input.estimatedTokens),
        sourceMessageIds: input.sourceMessageIds,
        createdAt: now,
      }
    })
  }

  async latestContextSummary (threadId: string): Promise<AgentContextSummaryRecord | null> {
    const row = await this.get<Record<string, unknown>>(
      `SELECT * FROM agent_context_summaries
       WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [threadId]
    )
    if (!row) return null
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      content: String(row.content),
      estimatedTokens: Number(row.estimated_tokens),
      sourceMessageIds: parseJson<string[]>(row.source_message_ids_json as string, []),
      createdAt: Number(row.created_at),
    }
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

  async createTurn (
    threadId: string,
    actorId: string,
    automated = false,
    resumedFromTurnId?: string,
    requestKey?: string
  ) {
    if (requestKey) {
      const existing = await this.get<{ id: string }>(
        'SELECT id FROM turns WHERE thread_id = ? AND request_key = ?',
        [threadId, requestKey]
      )
      if (existing) return String(existing.id)
    }
    const id = randomUUID()
    const now = Date.now()
    await this.run(
      `INSERT INTO turns(
        id, thread_id, actor_id, state, automated, resumed_from_turn_id, request_key,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        threadId,
        actorId,
        'running',
        automated ? 1 : 0,
        resumedFromTurnId || null,
        requestKey || null,
        now,
        now,
      ]
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
      finalMessageId: row.final_message_id ? String(row.final_message_id) : null,
      resumedFromTurnId: row.resumed_from_turn_id
        ? String(row.resumed_from_turn_id)
        : null,
      requestKey: row.request_key ? String(row.request_key) : null,
      recoveryAttempts: Number(row.recovery_attempts || 0),
      checkpoint: parseJson<Record<string, unknown>>(row.checkpoint_json as string, {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
  }

  async updateTurn (
    turnId: string,
    threadId: string,
    state: AgentThreadState,
    error?: string,
    finalMessageId?: string | null
  ) {
    const now = Date.now()
    await this.run(
      `UPDATE turns
       SET state = ?, error = ?, final_message_id = COALESCE(?, final_message_id), updated_at = ?
       WHERE id = ?`,
      [state, error || null, finalMessageId || null, now, turnId]
    )
    await this.updateThreadState(threadId, state)
  }

  async getTurnResultByRequestKey (threadId: string, requestKey: string) {
    const row = await this.get<Record<string, unknown>>(
      `SELECT turns.*, messages.content AS final_content
       FROM turns
       LEFT JOIN messages ON messages.id = turns.final_message_id
       WHERE turns.thread_id = ? AND turns.request_key = ?`,
      [threadId, requestKey]
    )
    if (!row) return null
    return {
      threadId,
      turnId: String(row.id),
      state: row.state as AgentThreadState,
      content: String(row.final_content || ''),
    }
  }

  async checkpointTurn (
    turnId: string,
    checkpoint: Record<string, unknown>,
    leaseToken?: string,
    leaseExpiresAt?: number
  ) {
    await this.run(
      `UPDATE turns SET checkpoint_json = ?, lease_token = COALESCE(?, lease_token),
       lease_expires_at = COALESCE(?, lease_expires_at), updated_at = ? WHERE id = ?`,
      [JSON.stringify(checkpoint), leaseToken || null, leaseExpiresAt || null, Date.now(), turnId]
    )
  }

  async ensureFinalMessage (
    threadId: string,
    turnId: string,
    content: string
  ) {
    const current = await this.get<Record<string, unknown>>(
      `SELECT id, content FROM messages
       WHERE turn_id = ? AND role = 'assistant'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [turnId]
    )
    if (current && String(current.content) === content) return String(current.id)
    return this.addMessage(threadId, turnId, 'assistant', content)
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
      sourceKey?: string
    } = {}
  ) {
    if (options.sourceKey) {
      const existing = await this.get<{ id: string }>(
        'SELECT id FROM messages WHERE thread_id = ? AND source_key = ?',
        [threadId, options.sourceKey]
      )
      if (existing) return String(existing.id)
    }
    const id = randomUUID()
    const now = Date.now()
    await this.run(
      `INSERT INTO messages(
        id, thread_id, turn_id, role, content, name, tool_call_id, tool_calls_json,
        source_key, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        threadId,
        turnId || null,
        role,
        content,
        options.name || null,
        options.toolCallId || null,
        options.toolCalls ? JSON.stringify(options.toolCalls) : null,
        options.sourceKey || null,
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
    const turnIds = [...new Set(
      rows.map(row => row.turn_id ? String(row.turn_id) : '').filter(Boolean)
    )]
    const turns = turnIds.length
      ? await this.all<Record<string, unknown>>(
        `SELECT id, state, final_message_id FROM turns
         WHERE id IN (${turnIds.map(() => '?').join(', ')})`,
        turnIds
      )
      : []
    const turnById = new Map(turns.map(turn => [String(turn.id), turn]))
    const legacyFinals = new Map<string, string>()
    for (const row of rows) {
      if (row.role !== 'assistant' || !row.turn_id) continue
      const turnId = String(row.turn_id)
      const turn = turnById.get(turnId)
      if (
        turn &&
        !turn.final_message_id &&
        String(turn.state) === 'completed'
      ) {
        legacyFinals.set(turnId, String(row.id))
      }
    }
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
      final: row.role === 'assistant' && Boolean(
        row.turn_id &&
        (
          String(turnById.get(String(row.turn_id))?.final_message_id || '') === String(row.id) ||
          legacyFinals.get(String(row.turn_id)) === String(row.id)
        )
      ),
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
    status: string,
    semantics: { idempotent?: boolean; restartSafe?: boolean } = {}
  ) {
    const now = Date.now()
    await this.run(
      `INSERT OR REPLACE INTO tool_calls(
        id, thread_id, turn_id, tool_name, input_json, risk, decision, status,
        idempotent, restart_safe, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        call.id,
        threadId,
        turnId,
        call.name,
        JSON.stringify(call.arguments),
        risk,
        decision,
        status,
        semantics.idempotent ? 1 : 0,
        semantics.restartSafe ? 1 : 0,
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
      idempotent: Boolean(row.idempotent),
      restartSafe: Boolean(row.restart_safe),
      error: row.error ? String(row.error) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
    }))
  }

  private async mapTaskList (
    row: Record<string, unknown>
  ): Promise<AgentTaskList> {
    const items = await this.all<Record<string, unknown>>(
      `SELECT * FROM agent_task_items
       WHERE list_id = ?
       ORDER BY ordinal ASC, created_at ASC`,
      [String(row.id)]
    )
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      sourceTurnId: String(row.source_turn_id),
      goal: String(row.goal),
      state: row.state as AgentTaskList['state'],
      items: items.map(item => ({
        id: String(item.item_key),
        content: String(item.content),
        status: item.status as AgentTaskItemStatus,
        order: Number(item.ordinal),
        createdAt: Number(item.created_at),
        updatedAt: Number(item.updated_at),
      })),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  async getActiveTaskList (threadId: string) {
    const row = await this.get<Record<string, unknown>>(
      `SELECT * FROM agent_task_lists
       WHERE thread_id = ? AND state = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
      [threadId]
    )
    return row ? this.mapTaskList(row) : null
  }

  async listTaskLists (threadId: string, limit = 50) {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT * FROM agent_task_lists
       WHERE thread_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
      [threadId, Math.max(1, Math.min(limit, 200))]
    )
    return Promise.all(rows.map(row => this.mapTaskList(row)))
  }

  async writeTaskList (input: {
    threadId: string
    sourceTurnId: string
    goal: string
    merge: boolean
    maxItems: number
    items: Array<{
      id: string
      content?: string
      status?: AgentTaskItemStatus
    }>
  }) {
    const allowed = new Set<AgentTaskItemStatus>([
      'pending',
      'in_progress',
      'completed',
      'cancelled',
    ])
    const last = new Map<string, {
      id: string
      content?: string
      status?: AgentTaskItemStatus
      index: number
    }>()
    for (const [index, value] of input.items.entries()) {
      const id = String(value.id || '').trim().slice(0, 128)
      if (!id) throw new Error('任务 ID 不能为空')
      const status = value.status
      if (status && !allowed.has(status)) throw new Error(`非法任务状态: ${status}`)
      const content = value.content === undefined
        ? undefined
        : String(value.content).trim().slice(0, 4000)
      last.set(id, { id, content, status, index })
    }
    const items = [...last.values()]
      .sort((left, right) => left.index - right.index)
      .slice(0, Math.max(1, Math.min(input.maxItems, 256)))
    if (items.filter(item => item.status === 'in_progress').length > 1) {
      throw new Error('同一任务清单最多只能有一个进行中的任务')
    }

    await this.exec('BEGIN IMMEDIATE')
    try {
      const now = Date.now()
      let active = await this.get<Record<string, unknown>>(
        `SELECT * FROM agent_task_lists
         WHERE thread_id = ? AND state = 'active'
         ORDER BY updated_at DESC LIMIT 1`,
        [input.threadId]
      )
      if (!input.merge || !active) {
        if (active) {
          await this.run(
            `UPDATE agent_task_lists
             SET state = 'cancelled', updated_at = ?
             WHERE id = ?`,
            [now, String(active.id)]
          )
        }
        const listId = randomUUID()
        await this.run(
          `INSERT INTO agent_task_lists(
            id, thread_id, source_turn_id, goal, state, created_at, updated_at
          ) VALUES(?, ?, ?, ?, 'active', ?, ?)`,
          [
            listId,
            input.threadId,
            input.sourceTurnId,
            input.goal.slice(0, 20000),
            now,
            now,
          ]
        )
        active = {
          id: listId,
          thread_id: input.threadId,
          source_turn_id: input.sourceTurnId,
          goal: input.goal.slice(0, 20000),
          state: 'active',
          created_at: now,
          updated_at: now,
        }
      }

      const listId = String(active.id)
      if (!input.merge) {
        await this.run('DELETE FROM agent_task_items WHERE list_id = ?', [listId])
        for (const [index, item] of items.entries()) {
          if (!item.content) throw new Error(`任务 ${item.id} 缺少内容`)
          await this.run(
            `INSERT INTO agent_task_items(
              id, list_id, item_key, ordinal, content, status, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              listId,
              item.id,
              index,
              item.content,
              item.status || 'pending',
              now,
              now,
            ]
          )
        }
      } else {
        const existing = await this.all<Record<string, unknown>>(
          `SELECT * FROM agent_task_items
           WHERE list_id = ? ORDER BY ordinal ASC`,
          [listId]
        )
        let ordinal = existing.length
        for (const item of items) {
          const current = existing.find(row => String(row.item_key) === item.id)
          if (current) {
            await this.run(
              `UPDATE agent_task_items
               SET content = ?, status = ?, updated_at = ?
               WHERE id = ?`,
              [
                item.content || String(current.content),
                item.status || String(current.status),
                now,
                String(current.id),
              ]
            )
          } else {
            if (!item.content) throw new Error(`新增任务 ${item.id} 缺少内容`)
            await this.run(
              `INSERT INTO agent_task_items(
                id, list_id, item_key, ordinal, content, status, created_at, updated_at
              ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                listId,
                item.id,
                ordinal++,
                item.content,
                item.status || 'pending',
                now,
                now,
              ]
            )
          }
        }
      }

      const stored = await this.all<{ status: AgentTaskItemStatus }>(
        'SELECT status FROM agent_task_items WHERE list_id = ?',
        [listId]
      )
      if (stored.filter(item => item.status === 'in_progress').length > 1) {
        throw new Error('同一任务清单最多只能有一个进行中的任务')
      }
      const state: AgentTaskList['state'] = stored.some(item =>
        item.status === 'pending' || item.status === 'in_progress'
      )
        ? 'active'
        : 'completed'
      await this.run(
        `UPDATE agent_task_lists
         SET goal = ?, state = ?, updated_at = ?
         WHERE id = ?`,
        [input.goal.slice(0, 20000) || String(active.goal), state, now, listId]
      )
      await this.exec('COMMIT')
      const row = await this.get<Record<string, unknown>>(
        'SELECT * FROM agent_task_lists WHERE id = ?',
        [listId]
      )
      return this.mapTaskList(row!)
    } catch (error) {
      await this.exec('ROLLBACK')
      throw error
    }
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
        'agent_turn_events',
        'agent_context_summaries',
        'agent_delivery_operations',
        'agent_tool_artifacts',
        'skill_activity',
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

  async getActiveInstruction (): Promise<AgentInstructionVersion> {
    const row = await this.get<Record<string, unknown>>(
      'SELECT * FROM agent_instruction_versions ORDER BY version DESC LIMIT 1'
    )
    if (!row) throw new Error('AGENT.md 默认版本不存在')
    return this.mapInstruction(row)
  }

  async getInstructionVersion (id: string) {
    const row = await this.get<Record<string, unknown>>(
      'SELECT * FROM agent_instruction_versions WHERE id = ?',
      [id]
    )
    return row ? this.mapInstruction(row) : null
  }

  async listInstructionVersions (limit = 100) {
    const rows = await this.all<Record<string, unknown>>(
      'SELECT * FROM agent_instruction_versions ORDER BY version DESC LIMIT ?',
      [Math.max(1, Math.min(limit, 500))]
    )
    return rows.map(row => this.mapInstruction(row))
  }

  async addInstructionVersion (
    content: string,
    contentHash: string,
    source: AgentInstructionVersion['source'],
    createdBy: string
  ) {
    const latest = await this.get<{ version: number }>(
      'SELECT version FROM agent_instruction_versions ORDER BY version DESC LIMIT 1'
    )
    const value: AgentInstructionVersion = {
      id: randomUUID(),
      version: Number(latest?.version || 0) + 1,
      content,
      contentHash,
      source,
      createdBy,
      createdAt: Date.now(),
    }
    await this.run(
      `INSERT INTO agent_instruction_versions(
        id, version, content, content_hash, source, created_by, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        value.id,
        value.version,
        value.content,
        value.contentHash,
        value.source,
        value.createdBy,
        value.createdAt,
      ]
    )
    return value
  }

  private mapInstruction (row: Record<string, unknown>): AgentInstructionVersion {
    return {
      id: String(row.id),
      version: Number(row.version),
      content: String(row.content || ''),
      contentHash: String(row.content_hash),
      source: row.source as AgentInstructionVersion['source'],
      createdBy: String(row.created_by),
      createdAt: Number(row.created_at),
    }
  }

  private mapPersona (row: Record<string, unknown>): AgentPersonaRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description || ''),
      enabled: Boolean(row.enabled),
      isDefault: Boolean(row.is_default),
      activeVersionId: String(row.active_version_id),
      definition: parseJson<AgentPersonaDefinition>(String(row.definition_json || '{}'), {
        identity: '', expertise: [], tone: '', responseStyle: '', language: '',
      }),
      version: Number(row.version || 1),
      threadReferences: Number(row.thread_references || 0),
      jobReferences: Number(row.job_references || 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  async listPersonas (includeDisabled = true) {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT p.*, v.version, v.definition_json,
        (SELECT COUNT(*) FROM threads t
         JOIN agent_persona_versions pv ON pv.id = t.persona_version_id
         WHERE pv.persona_id = p.id) AS thread_references,
        (SELECT COUNT(*) FROM agent_jobs j WHERE j.persona_id = p.id) AS job_references
       FROM agent_personas p
       JOIN agent_persona_versions v ON v.id = p.active_version_id
       ${includeDisabled ? '' : 'WHERE p.enabled = 1'}
       ORDER BY p.is_default DESC, p.name ASC`
    )
    return rows.map(row => this.mapPersona(row))
  }

  async getPersona (id: string) {
    const row = await this.get<Record<string, unknown>>(
      `SELECT p.*, v.version, v.definition_json,
        (SELECT COUNT(*) FROM threads t
         JOIN agent_persona_versions pv ON pv.id = t.persona_version_id
         WHERE pv.persona_id = p.id) AS thread_references,
        (SELECT COUNT(*) FROM agent_jobs j WHERE j.persona_id = p.id) AS job_references
       FROM agent_personas p
       JOIN agent_persona_versions v ON v.id = p.active_version_id
       WHERE p.id = ?`,
      [id]
    )
    return row ? this.mapPersona(row) : null
  }

  async getPersonaVersion (id: string): Promise<AgentPersonaVersion | null> {
    const row = await this.get<Record<string, unknown>>(
      'SELECT * FROM agent_persona_versions WHERE id = ?',
      [id]
    )
    return row
      ? {
        id: String(row.id),
        personaId: String(row.persona_id),
        version: Number(row.version),
        definition: parseJson<AgentPersonaDefinition>(String(row.definition_json || '{}'), {
          identity: '', expertise: [], tone: '', responseStyle: '', language: '',
        }),
        createdBy: String(row.created_by),
        createdAt: Number(row.created_at),
      }
      : null
  }

  async getDefaultPersona () {
    const row = await this.get<Record<string, unknown>>(
      `SELECT p.*, v.version, v.definition_json
       FROM agent_personas p
       JOIN agent_persona_versions v ON v.id = p.active_version_id
       WHERE p.is_default = 1 AND p.enabled = 1 LIMIT 1`
    )
    if (!row) throw new Error('默认人物预设不存在')
    return this.mapPersona(row)
  }

  async createPersona (input: {
    name: string
    description: string
    definition: AgentPersonaDefinition
    createdBy: string
  }) {
    return this.transaction(async () => {
      const id = randomUUID()
      const versionId = randomUUID()
      const now = Date.now()
      await this.run(
        `INSERT INTO agent_personas(
          id, name, description, enabled, is_default, active_version_id, created_at, updated_at
         ) VALUES(?, ?, ?, 1, 0, ?, ?, ?)`,
        [id, input.name, input.description, versionId, now, now]
      )
      await this.run(
        `INSERT INTO agent_persona_versions(
          id, persona_id, version, definition_json, created_by, created_at
         ) VALUES(?, ?, 1, ?, ?, ?)`,
        [versionId, id, JSON.stringify(input.definition), input.createdBy, now]
      )
      return (await this.getPersona(id))!
    })
  }

  async updatePersona (id: string, input: {
    name: string
    description: string
    definition: AgentPersonaDefinition
    createdBy: string
  }) {
    return this.transaction(async () => {
      const current = await this.getPersona(id)
      if (!current) throw new Error('人物预设不存在')
      const versionId = randomUUID()
      const version = current.version + 1
      const now = Date.now()
      await this.run(
        `INSERT INTO agent_persona_versions(
          id, persona_id, version, definition_json, created_by, created_at
         ) VALUES(?, ?, ?, ?, ?, ?)`,
        [versionId, id, version, JSON.stringify(input.definition), input.createdBy, now]
      )
      await this.run(
        `UPDATE agent_personas
         SET name = ?, description = ?, active_version_id = ?, updated_at = ? WHERE id = ?`,
        [input.name, input.description, versionId, now, id]
      )
      return (await this.getPersona(id))!
    })
  }

  async listPersonaVersions (personaId: string): Promise<AgentPersonaVersion[]> {
    const rows = await this.all<Record<string, unknown>>(
      'SELECT * FROM agent_persona_versions WHERE persona_id = ? ORDER BY version DESC',
      [personaId]
    )
    return rows.map(row => ({
      id: String(row.id),
      personaId: String(row.persona_id),
      version: Number(row.version),
      definition: parseJson<AgentPersonaDefinition>(String(row.definition_json || '{}'), {
        identity: '', expertise: [], tone: '', responseStyle: '', language: '',
      }),
      createdBy: String(row.created_by),
      createdAt: Number(row.created_at),
    }))
  }

  async setDefaultPersona (id: string) {
    const persona = await this.getPersona(id)
    if (!persona?.enabled) throw new Error('只能把已启用的人物设为默认')
    await this.transaction(async () => {
      await this.run('UPDATE agent_personas SET is_default = 0 WHERE is_default = 1')
      await this.run(
        'UPDATE agent_personas SET is_default = 1, updated_at = ? WHERE id = ?',
        [Date.now(), id]
      )
    })
    return (await this.getPersona(id))!
  }

  async setPersonaEnabled (id: string, enabled: boolean) {
    const persona = await this.getPersona(id)
    if (!persona) throw new Error('人物预设不存在')
    if (!enabled && persona.isDefault) throw new Error('默认人物预设不能停用')
    if (!enabled) {
      const job = await this.get<{ id: string }>(
        'SELECT id FROM agent_jobs WHERE persona_id = ? AND enabled = 1 LIMIT 1',
        [id]
      )
      if (job) throw new Error('人物预设仍被启用的定时任务引用')
    }
    await this.run(
      'UPDATE agent_personas SET enabled = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, Date.now(), id]
    )
    return (await this.getPersona(id))!
  }

  async setThreadInstructionVersion (threadId: string, versionId: string) {
    if (!await this.getInstructionVersion(versionId)) throw new Error('AGENT.md 版本不存在')
    const result = await this.run(
      'UPDATE threads SET instruction_version_id = ?, updated_at = ? WHERE id = ?',
      [versionId, Date.now(), threadId]
    )
    return result.changes > 0
  }

  async setThreadPersonaVersion (threadId: string, versionId: string) {
    if (!await this.getPersonaVersion(versionId)) throw new Error('人物预设版本不存在')
    const result = await this.run(
      'UPDATE threads SET persona_version_id = ?, updated_at = ? WHERE id = ?',
      [versionId, Date.now(), threadId]
    )
    return result.changes > 0
  }

  async ensureThreadCustomization (threadId: string) {
    const thread = await this.getThread(threadId)
    if (!thread) throw new Error('Thread 不存在')
    const instruction = thread.instructionVersionId
      ? await this.getInstructionVersion(thread.instructionVersionId)
      : await this.getActiveInstruction()
    const persona = thread.personaVersionId
      ? await this.getPersonaVersion(thread.personaVersionId)
      : await this.getPersonaVersion((await this.getDefaultPersona()).activeVersionId)
    if (!instruction || !persona) throw new Error('Thread 定制版本不可用')
    if (!thread.instructionVersionId || !thread.personaVersionId) {
      await this.run(
        `UPDATE threads SET instruction_version_id = ?, persona_version_id = ?, updated_at = ?
         WHERE id = ?`,
        [instruction.id, persona.id, Date.now(), threadId]
      )
    }
    return { instruction, persona }
  }

  async addMemory (
    scope: AgentMemoryRecord['scope'],
    scopeKey: string,
    content: string,
    sourceTurnId: string,
    options: Partial<Pick<
      AgentMemoryRecord,
      'kind' | 'memoryKey' | 'confidence' | 'importance' | 'pinned' | 'sourceType' |
      'expiresAt'
    >> = {}
  ) {
    const id = randomUUID()
    const now = Date.now()
    const normalized = content.trim()
    const contentHash = createHash('sha256').update(normalized).digest('hex')
    const kind = options.kind || 'fact'
    const memoryKey = options.memoryKey?.trim().slice(0, 200) || null
    const confidence = Math.max(0, Math.min(Number(options.confidence) || 0.7, 1))
    const importance = Math.max(0, Math.min(Number(options.importance) || 0.5, 1))
    if (memoryKey && ['explicit', 'correction', 'web'].includes(options.sourceType || '')) {
      const previous = await this.all<{ id: string }>(
        `SELECT id FROM memories
         WHERE scope = ? AND scope_key = ? AND memory_key = ? AND status = 'active'`,
        [scope, scopeKey, memoryKey]
      )
      for (const item of previous) {
        await this.run(
          `UPDATE memories SET status = 'superseded', enabled = 0,
            superseded_by = ?, updated_at = ? WHERE id = ?`,
          [id, now, item.id]
        )
        if (this.ftsAvailable) {
          await this.run('DELETE FROM memory_fts WHERE memory_id = ?', [item.id])
        }
      }
    }
    await this.run(
      `INSERT INTO memories(
        id, scope, scope_key, content, source_turn_id, enabled, kind, memory_key,
        confidence, importance, pinned, status, content_hash, source_type,
        expires_at, use_count, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0, ?, ?)`,
      [
        id, scope, scopeKey, normalized, sourceTurnId, kind, memoryKey,
        confidence, importance, options.pinned ? 1 : 0, contentHash,
        options.sourceType || 'legacy', options.expiresAt || null, now, now,
      ]
    )
    await this.run(
      `INSERT INTO memory_sources(
        id, memory_id, source_turn_id, evidence, source_type, created_at
       ) VALUES(?, ?, ?, '', ?, ?)`,
      [randomUUID(), id, sourceTurnId, options.sourceType || 'legacy', now]
    )
    if (this.ftsAvailable) {
      await this.run(
        'INSERT INTO memory_fts(memory_id, scope, scope_key, content) VALUES(?, ?, ?, ?)',
        [id, scope, scopeKey, normalized]
      )
    }
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
        `SELECT * FROM memories WHERE enabled = 1 AND status = 'active' AND (${conditions})
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
      kind: (row.kind || 'fact') as AgentMemoryRecord['kind'],
      memoryKey: row.memory_key ? String(row.memory_key) : null,
      confidence: Number(row.confidence ?? 0.7),
      importance: Number(row.importance ?? 0.5),
      pinned: Boolean(row.pinned),
      status: (row.status || 'active') as AgentMemoryRecord['status'],
      contentHash: String(row.content_hash || ''),
      sourceType: (row.source_type || 'legacy') as AgentMemoryRecord['sourceType'],
      expiresAt: row.expires_at ? Number(row.expires_at) : null,
      lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
      useCount: Number(row.use_count || 0),
      supersededBy: row.superseded_by ? String(row.superseded_by) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at || row.created_at),
    }))
  }

  async retrieveMemories (
    scopes: Array<{ scope: string; key: string }>,
    query: string,
    options: {
      maxCandidates: number
      maxItems: number
      minScore: number
      recencyHalfLifeDays: number
      maxPromptTokens: number
      threadId?: string
      turnId?: string
    }
  ) {
    const memories = await this.listMemories(scopes)
    const normalized = query.toLowerCase()
    const words = normalized
      .split(/[\s,，。！？、:：;；()[\]{}"'`]+/)
      .map(item => item.trim())
      .filter(item => item.length >= 2)
    const cjk = [...normalized.matchAll(/[\u3400-\u9fff]{2,}/g)]
      .flatMap(match => [...match[0]].slice(0, -1).map((char, index) =>
        `${char}${[...match[0]][index + 1]}`
      ))
    const terms = [...new Set([...words, ...cjk])].slice(0, 32)
    let ftsIds = new Set<string>()
    if (this.ftsAvailable && terms.length) {
      const expression = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
      try {
        const rows = await this.all<{ memory_id: string }>(
          `SELECT memory_id FROM memory_fts
           WHERE memory_fts MATCH ? LIMIT ?`,
          [expression, Math.max(1, Math.min(options.maxCandidates, 500))]
        )
        ftsIds = new Set(rows.map(row => row.memory_id))
      } catch {
        ftsIds = new Set()
      }
    }
    const now = Date.now()
    const halfLifeMs = Math.max(1, options.recencyHalfLifeDays) * 86_400_000
    const ranked = memories.map(memory => {
      const content = memory.content.toLowerCase()
      const hits = terms.filter(term => content.includes(term)).length
      const lexical = terms.length ? hits / terms.length : 0
      const fts = ftsIds.has(memory.id) ? 1 : 0
      const age = Math.max(0, now - (memory.lastUsedAt || memory.updatedAt))
      const recency = Math.pow(0.5, age / halfLifeMs)
      const score = memory.pinned
        ? 1
        : 0.45 * fts + 0.2 * lexical + 0.15 * memory.importance +
          0.1 * memory.confidence + 0.1 * recency
      return { memory, score, matched: fts > 0 || lexical > 0 }
    }).filter(item => item.memory.pinned || item.matched)
      .filter(item => item.memory.pinned || item.score >= options.minScore)
      .sort((left, right) =>
        Number(right.memory.pinned) - Number(left.memory.pinned) ||
        right.score - left.score || right.memory.updatedAt - left.memory.updatedAt
      )
      .slice(0, Math.max(1, Math.min(options.maxCandidates, 500)))

    const selected: Array<(typeof ranked)[number]> = []
    let estimatedTokens = 0
    for (const item of ranked) {
      const tokens = Math.max(1, Math.ceil(Buffer.byteLength(item.memory.content, 'utf8') / 3))
      if (selected.length >= options.maxItems) break
      if (selected.length && estimatedTokens + tokens > options.maxPromptTokens) continue
      selected.push(item)
      estimatedTokens += tokens
    }
    if (selected.length) {
      const ids = selected.map(item => item.memory.id)
      const placeholders = ids.map(() => '?').join(', ')
      await this.run(
        `UPDATE memories SET use_count = use_count + 1, last_used_at = ?, updated_at = updated_at
         WHERE id IN (${placeholders})`,
        [now, ...ids]
      )
    }
    if (options.threadId && options.turnId) {
      const selectedIds = new Set(selected.map(item => item.memory.id))
      for (const [rank, item] of ranked.entries()) {
        await this.recordRetrieval({
          threadId: options.threadId,
          turnId: options.turnId,
          kind: 'memory',
          itemId: item.memory.id,
          rank,
          selected: selectedIds.has(item.memory.id),
          outcome: 'retrieved',
        })
      }
    }
    return selected
  }

  async updateMemory (id: string, input: Partial<Pick<
    AgentMemoryRecord,
    'content' | 'kind' | 'memoryKey' | 'confidence' | 'importance' | 'pinned' | 'expiresAt' |
    'status'
  >>) {
    const current = (await this.listMemories()).find(item => item.id === id)
    if (!current) throw new Error('记忆不存在')
    const content = input.content?.trim() || current.content
    const status = input.status || current.status
    const enabled = status === 'active'
    await this.run(
      `UPDATE memories SET content = ?, kind = ?, memory_key = ?, confidence = ?,
        importance = ?, pinned = ?, expires_at = ?, status = ?, enabled = ?,
        content_hash = ?, updated_at = ? WHERE id = ?`,
      [
        content,
        input.kind || current.kind,
        input.memoryKey === undefined ? current.memoryKey : input.memoryKey || null,
        Math.max(0, Math.min(Number(input.confidence ?? current.confidence), 1)),
        Math.max(0, Math.min(Number(input.importance ?? current.importance), 1)),
        input.pinned === undefined ? Number(current.pinned) : Number(input.pinned),
        input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
        status,
        Number(enabled),
        createHash('sha256').update(content).digest('hex'),
        Date.now(),
        id,
      ]
    )
    if (this.ftsAvailable) {
      await this.run('DELETE FROM memory_fts WHERE memory_id = ?', [id])
      if (enabled) {
        await this.run(
          'INSERT INTO memory_fts(memory_id, scope, scope_key, content) VALUES(?, ?, ?, ?)',
          [id, current.scope, current.scopeKey, content]
        )
      }
    }
    return (await this.listMemories()).find(item => item.id === id) || null
  }

  async curateMemories (staleBefore: number, archiveBefore: number) {
    const now = Date.now()
    const active = await this.all<Record<string, unknown>>(
      `SELECT * FROM memories WHERE status = 'active'
       ORDER BY pinned DESC, importance DESC, confidence DESC, created_at ASC`
    )
    const canonical = new Map<string, string>()
    let merged = 0
    for (const row of active) {
      const key = [row.scope, row.scope_key, row.memory_key || '', row.content_hash].join('\0')
      const keeper = canonical.get(key)
      if (!keeper) {
        canonical.set(key, String(row.id))
        continue
      }
      const duplicateId = String(row.id)
      await this.run(
        `UPDATE memories SET status = 'superseded', enabled = 0,
          superseded_by = ?, updated_at = ? WHERE id = ?`,
        [keeper, now, duplicateId]
      )
      await this.run(
        'UPDATE OR IGNORE memory_sources SET memory_id = ? WHERE memory_id = ?',
        [keeper, duplicateId]
      )
      if (this.ftsAvailable) {
        await this.run('DELETE FROM memory_fts WHERE memory_id = ?', [duplicateId])
      }
      merged++
    }
    const expired = await this.run(
      `UPDATE memories SET status = 'archived', enabled = 0, updated_at = ?
       WHERE status = 'active' AND pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?`,
      [now, now]
    )
    const archived = await this.run(
      `UPDATE memories SET status = 'archived', enabled = 0, updated_at = ?
       WHERE status = 'active' AND pinned = 0 AND importance < 0.7
         AND COALESCE(last_used_at, created_at) < ? AND created_at < ?`,
      [now, staleBefore, archiveBefore]
    )
    if (this.ftsAvailable && (expired.changes || archived.changes)) {
      await this.run(
        `DELETE FROM memory_fts WHERE memory_id IN (
          SELECT id FROM memories WHERE status <> 'active' OR enabled = 0
        )`
      )
    }
    return { merged, expired: expired.changes, archived: archived.changes }
  }

  async setMemoryEnabled (id: string, enabled: boolean) {
    const result = await this.run(
      'UPDATE memories SET enabled = ?, status = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, enabled ? 'active' : 'archived', Date.now(), id]
    )
    if (this.ftsAvailable) {
      await this.run('DELETE FROM memory_fts WHERE memory_id = ?', [id])
      if (enabled) {
        await this.run(`
          INSERT INTO memory_fts(memory_id, scope, scope_key, content)
          SELECT id, scope, scope_key, content FROM memories WHERE id = ?
        `, [id])
      }
    }
    return result.changes > 0
  }

  async deleteMemory (id: string) {
    if (this.ftsAvailable) await this.run('DELETE FROM memory_fts WHERE memory_id = ?', [id])
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
    filesManifest?: Record<string, { size: number; hash: string }>
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
        `INSERT INTO skills(
          id, name, description, enabled, provenance, created_at, updated_at
        ) VALUES(?, ?, ?, 1, ?, ?, ?)`,
        [
          skillId,
          input.name,
          input.description,
          input.sourceTurnId && input.sourceTurnId !== 'legacy' ? 'agent' : 'user',
          now,
          now,
        ]
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
        content_hash, validation_status, created_at, name, description, script_tools_json,
        files_manifest_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?)`,
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
        JSON.stringify(input.filesManifest || {}),
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
    const now = Date.now()
    const result = await this.run(
      'UPDATE skills SET enabled = ?, disabled_at = ?, updated_at = ? WHERE id = ?', [
        enabled ? 1 : 0,
        enabled ? null : now,
        now,
        skillId,
      ]
    )
    return result.changes > 0
  }

  async getThreadSkillContents (threadId: string) {
    const rows = await this.all<{ id: string; name: string; content: string }>(
      `SELECT s.id, s.name, sv.content
       FROM thread_skill_snapshots snapshot
       JOIN skills s ON s.id = snapshot.skill_id
       JOIN skill_versions sv ON sv.id = snapshot.skill_version_id
       WHERE snapshot.thread_id = ? AND s.enabled = 1`,
      [threadId]
    )
    return rows
  }

  async getThreadSkillIndex (threadId: string) {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT
         s.id,
         COALESCE(NULLIF(sv.name, ''), s.name) AS name,
         COALESCE(NULLIF(sv.description, ''), s.description) AS description,
         sv.id AS version_id,
         sv.version,
         sv.tools_json
       FROM thread_skill_snapshots snapshot
       JOIN skills s ON s.id = snapshot.skill_id
       JOIN skill_versions sv ON sv.id = snapshot.skill_version_id
       WHERE snapshot.thread_id = ? AND s.enabled = 1
       ORDER BY name ASC`,
      [threadId]
    )
    return rows.map(row => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      versionId: String(row.version_id),
      version: Number(row.version),
      tools: parseJson<string[]>(row.tools_json as string, []),
    }))
  }

  async getThreadSkillVersion (threadId: string, reference: string) {
    const row = await this.get<Record<string, unknown>>(
      `SELECT
         s.id,
         COALESCE(NULLIF(sv.name, ''), s.name) AS name,
         COALESCE(NULLIF(sv.description, ''), s.description) AS description,
         sv.id AS version_id,
         sv.version,
         sv.content,
         sv.tools_json,
         sv.files_manifest_json
       FROM thread_skill_snapshots snapshot
       JOIN skills s ON s.id = snapshot.skill_id
       JOIN skill_versions sv ON sv.id = snapshot.skill_version_id
       WHERE snapshot.thread_id = ? AND s.enabled = 1 AND (s.id = ? OR s.name = ?)
       LIMIT 1`,
      [threadId, reference, reference]
    )
    if (!row) return null
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      versionId: String(row.version_id),
      version: Number(row.version),
      content: String(row.content),
      tools: parseJson<string[]>(row.tools_json as string, []),
      filesManifest: parseJson<Record<string, {
        size: number
        hash: string
      }>>(row.files_manifest_json as string, {}),
    }
  }

  async recordSkillLoad (input: {
    threadId: string
    turnId: string
    skillId: string
    skillVersionId: string
    filePath: string
  }) {
    const id = randomUUID()
    await this.run(
      `INSERT INTO thread_skill_loads(
        id, thread_id, turn_id, skill_id, skill_version_id, file_path, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.threadId,
        input.turnId,
        input.skillId,
        input.skillVersionId,
        input.filePath,
        Date.now(),
      ]
    )
    await this.recordSkillActivity({
      skillId: input.skillId,
      skillVersionId: input.skillVersionId,
      threadId: input.threadId,
      turnId: input.turnId,
      action: input.filePath === 'SKILL.md' ? 'view' : 'use',
      detail: { filePath: input.filePath },
    })
    return id
  }

  async listTurnSkillLoads (threadId: string, turnId: string) {
    const rows = await this.all<{ skill_id: string }>(
      `SELECT DISTINCT skill_id FROM thread_skill_loads
       WHERE thread_id = ? AND turn_id = ?`,
      [threadId, turnId]
    )
    return rows.map(row => String(row.skill_id))
  }

  private mapGeneratedTool (row: Record<string, unknown>): AgentGeneratedToolRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      enabled: Boolean(row.enabled),
      activeVersionId: row.active_version_id ? String(row.active_version_id) : null,
      legacyAlias: row.legacy_alias ? String(row.legacy_alias) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  private mapGeneratedToolVersion (
    row: Record<string, unknown>
  ): AgentGeneratedToolVersion {
    return {
      id: String(row.id),
      toolId: String(row.tool_id),
      version: Number(row.version),
      definition: parseJson<AgentScriptToolDefinition>(
        row.definition_json as string,
        {} as AgentScriptToolDefinition
      ),
      validationStatus: row.validation_status as AgentGeneratedToolVersion['validationStatus'],
      validationReport: String(row.validation_report || ''),
      sourceTurnId: String(row.source_turn_id),
      createdAt: Number(row.created_at),
    }
  }

  async listGeneratedTools () {
    const rows = await this.all<Record<string, unknown>>(
      'SELECT * FROM generated_tools ORDER BY updated_at DESC'
    )
    return rows.map(row => this.mapGeneratedTool(row))
  }

  async getGeneratedTool (reference: string) {
    const row = await this.get<Record<string, unknown>>(
      'SELECT * FROM generated_tools WHERE id = ? OR name = ? LIMIT 1',
      [reference, reference]
    )
    return row ? this.mapGeneratedTool(row) : null
  }

  async getGeneratedToolVersions (toolId: string) {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT * FROM generated_tool_versions
       WHERE tool_id = ? ORDER BY version DESC`,
      [toolId]
    )
    return rows.map(row => this.mapGeneratedToolVersion(row))
  }

  async getActiveGeneratedToolVersions () {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT v.*
       FROM generated_tools t
       JOIN generated_tool_versions v ON v.id = t.active_version_id
       WHERE t.enabled = 1 AND v.validation_status = 'valid'
       ORDER BY t.updated_at DESC`
    )
    return rows.map(row => this.mapGeneratedToolVersion(row))
  }

  async addGeneratedToolVersion (input: {
    toolId?: string
    name: string
    description: string
    definition: AgentScriptToolDefinition
    validationStatus: AgentGeneratedToolVersion['validationStatus']
    validationReport: string
    sourceTurnId: string
    activate: boolean
    legacyAlias?: string
  }) {
    const now = Date.now()
    await this.exec('BEGIN IMMEDIATE')
    try {
      const existing = input.toolId
        ? await this.get<Record<string, unknown>>(
          'SELECT * FROM generated_tools WHERE id = ?',
          [input.toolId]
        )
        : await this.get<Record<string, unknown>>(
          'SELECT * FROM generated_tools WHERE name = ?',
          [input.name]
        )
      if (input.toolId && !existing) throw new Error('Generated Tool 不存在')
      const duplicate = await this.get<{ id: string }>(
        'SELECT id FROM generated_tools WHERE name = ? AND id != ?',
        [input.name, input.toolId || '']
      )
      if (duplicate) throw new Error(`Generated Tool 名称已存在: ${input.name}`)
      const toolId = existing ? String(existing.id) : randomUUID()
      if (!existing) {
        await this.run(
          `INSERT INTO generated_tools(
            id, name, description, enabled, active_version_id, legacy_alias,
            created_at, updated_at
          ) VALUES(?, ?, ?, 1, NULL, ?, ?, ?)`,
          [
            toolId,
            input.name,
            input.description,
            input.legacyAlias || null,
            now,
            now,
          ]
        )
      }
      const latest = await this.get<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) AS version
         FROM generated_tool_versions WHERE tool_id = ?`,
        [toolId]
      )
      const versionId = randomUUID()
      await this.run(
        `INSERT INTO generated_tool_versions(
          id, tool_id, version, definition_json, validation_status,
          validation_report, source_turn_id, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          toolId,
          Number(latest?.version || 0) + 1,
          JSON.stringify(input.definition),
          input.validationStatus,
          input.validationReport.slice(0, 20000),
          input.sourceTurnId,
          now,
        ]
      )
      await this.run(
        `UPDATE generated_tools
         SET name = ?, description = ?, updated_at = ?,
             active_version_id = CASE WHEN ? = 1 THEN ? ELSE active_version_id END
         WHERE id = ?`,
        [
          input.name,
          input.description,
          now,
          input.activate && input.validationStatus === 'valid' ? 1 : 0,
          versionId,
          toolId,
        ]
      )
      await this.exec('COMMIT')
      return { toolId, versionId }
    } catch (error) {
      await this.exec('ROLLBACK')
      throw error
    }
  }

  async setGeneratedToolEnabled (toolId: string, enabled: boolean) {
    const result = await this.run(
      'UPDATE generated_tools SET enabled = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, Date.now(), toolId]
    )
    return result.changes > 0
  }

  async rollbackGeneratedTool (toolId: string, versionId: string) {
    const version = await this.get<{ id: string; validation_status: string }>(
      `SELECT id, validation_status FROM generated_tool_versions
       WHERE id = ? AND tool_id = ?`,
      [versionId, toolId]
    )
    if (!version) return false
    if (version.validation_status !== 'valid') {
      throw new Error('只能回滚到验证通过的 Generated Tool 版本')
    }
    const result = await this.run(
      `UPDATE generated_tools
       SET active_version_id = ?, updated_at = ?
       WHERE id = ?`,
      [versionId, Date.now(), toolId]
    )
    return result.changes > 0
  }

  async deleteGeneratedTool (toolId: string) {
    const result = await this.run('DELETE FROM generated_tools WHERE id = ?', [toolId])
    return result.changes > 0
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

  async completeRetrievals (threadId: string, turnId: string, outcome: string) {
    await this.run(
      `UPDATE agent_retrieval_log SET outcome = ?
       WHERE thread_id = ? AND turn_id = ? AND selected = 1`,
      [outcome, threadId, turnId]
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

  async listEvolutionLog (limit = 200): Promise<AgentEvolutionLogEntry[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT
         event.id,
         event.candidate_id,
         event.action,
         event.actor_id,
         event.detail_json,
         event.created_at,
         candidate.target,
         candidate.summary,
         candidate.candidate_version,
         candidate.source_turn_ids_json,
         candidate.payload_json
       FROM evolution_events event
       JOIN evolution_candidates candidate ON candidate.id = event.candidate_id
       WHERE event.action IN (
         'promoted',
         'repair.applied',
         'rolled_back',
         'rollback.triggered',
         'repair.rolled_back',
         'repair.apply.failed'
       )
       ORDER BY event.created_at DESC
       LIMIT ?`,
      [Math.max(1, Math.min(limit, 1000))]
    )
    return rows.map(row => {
      const detail = parseJson<Record<string, unknown>>(row.detail_json as string, {})
      const payload = parseJson<Record<string, unknown>>(row.payload_json as string, {})
      const sourceTurnIds = parseJson<string[]>(row.source_turn_ids_json as string, [])
      const rawAction = String(row.action)
      const action = rawAction === 'promoted' || rawAction === 'repair.applied'
        ? 'improved'
        : rawAction === 'repair.apply.failed'
          ? 'failed'
          : 'rolled_back'
      const files = Array.isArray(detail.files) ? detail.files.map(String) : []
      const resourceName = String(
        payload.name || payload.skillId || payload.memoryId || payload.routingKey || ''
      )
      const change = files.length
        ? `修改文件：${files.join('、')}`
        : resourceName
          ? `${row.target}：${resourceName}`
          : String(row.summary)
      return {
        id: String(row.id),
        candidateId: String(row.candidate_id),
        action,
        target: row.target as AgentEvolutionTarget,
        summary: String(row.summary),
        change,
        candidateVersion: String(row.candidate_version),
        sourceTurnIds,
        actorId: String(row.actor_id),
        detail,
        createdAt: Number(row.created_at),
      }
    })
  }

  async deleteEvolutionLog (id: string) {
    const result = await this.run(
      `DELETE FROM evolution_events
       WHERE id = ? AND action IN (
         'promoted',
         'repair.applied',
         'rolled_back',
         'rollback.triggered',
         'repair.rolled_back',
         'repair.apply.failed'
       )`,
      [id]
    )
    return result.changes > 0
  }

  async clearEvolutionLog () {
    const result = await this.run(
      `DELETE FROM evolution_events
       WHERE action IN (
         'promoted',
         'repair.applied',
         'rolled_back',
         'rollback.triggered',
         'repair.rolled_back',
         'repair.apply.failed'
       )`
    )
    return result.changes
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
    const now = Date.now()
    await this.exec('BEGIN IMMEDIATE')
    try {
      await this.run(
        `UPDATE skill_usage SET state = 'archived', archived_at = ?
         WHERE pinned = 0 AND state IN ('active', 'stale')
         AND last_used_at IS NOT NULL AND last_used_at < ?
         AND skill_id IN (
           SELECT id FROM skills WHERE provenance = 'agent' AND adopted_at IS NULL
         )`,
        [now, archiveBefore]
      )
      await this.run(
        `UPDATE skills SET archived_at = ?, updated_at = ?
         WHERE provenance = 'agent' AND adopted_at IS NULL AND id IN (
           SELECT skill_id FROM skill_usage WHERE state = 'archived' AND pinned = 0
         )`,
        [now, now]
      )
      await this.exec('COMMIT')
    } catch (error) {
      await this.exec('ROLLBACK')
      throw error
    }
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

  async appendTurnEvent (
    threadId: string,
    type: AgentStreamEvent['type'],
    data: unknown,
    turnId?: string
  ): Promise<AgentStreamEvent> {
    const createdAt = Date.now()
    const result = await this.run(
      `INSERT INTO agent_turn_events(thread_id, turn_id, type, data_json, created_at)
       VALUES(?, ?, ?, ?, ?)`,
      [threadId, turnId || null, type, JSON.stringify(data ?? null), createdAt]
    )
    return {
      id: result.lastID,
      threadId,
      turnId,
      type,
      data,
      createdAt,
    }
  }

  async listTurnEvents (threadId: string, afterId = 0, limit = 1000) {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT * FROM agent_turn_events
       WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      [threadId, Math.max(0, afterId), Math.max(1, Math.min(limit, 5000))]
    )
    return rows.map(row => ({
      id: Number(row.id),
      threadId: String(row.thread_id),
      turnId: row.turn_id ? String(row.turn_id) : undefined,
      type: row.type as AgentStreamEvent['type'],
      data: parseJson<unknown>(row.data_json as string, null),
      createdAt: Number(row.created_at),
    }))
  }

  async pruneTurnEvents (retentionDays: number) {
    const before = Date.now() - Math.max(1, retentionDays) * 86_400_000
    return (await this.run(
      'DELETE FROM agent_turn_events WHERE created_at < ?',
      [before]
    )).changes
  }

  async finalizeTurn (input: {
    threadId: string
    turnId: string
    state: 'completed' | 'failed' | 'interrupted'
    content: string
    error?: string
    publishFinal: boolean
  }) {
    return this.transaction(async () => {
      const now = Date.now()
      let finalMessageId: string | null = null
      const type: AgentStreamEvent['type'] = input.state === 'completed'
        ? 'turn.completed'
        : 'turn.failed'
      if (input.content && input.publishFinal) {
        const current = await this.get<{ id: string; content: string }>(
          `SELECT id, content FROM messages
           WHERE turn_id = ? AND role = 'assistant'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          [input.turnId]
        )
        if (current && String(current.content) === input.content) {
          finalMessageId = String(current.id)
        } else {
          finalMessageId = randomUUID()
          await this.run(
            `INSERT INTO messages(
              id, thread_id, turn_id, role, content, name, tool_call_id,
              tool_calls_json, source_key, created_at
            ) VALUES(?, ?, ?, 'assistant', ?, NULL, NULL, NULL, NULL, ?)`,
            [finalMessageId, input.threadId, input.turnId, input.content, now]
          )
          if (this.ftsAvailable) {
            await this.run(
              'INSERT INTO message_fts(message_id, thread_id, content) VALUES(?, ?, ?)',
              [finalMessageId, input.threadId, input.content]
            )
          }
        }
      }
      await this.run(
        `UPDATE turns SET state = ?, error = ?, final_message_id = ?,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        [input.state, input.error || null, finalMessageId, now, input.turnId]
      )
      await this.run(
        'UPDATE threads SET state = ?, updated_at = ? WHERE id = ?',
        [input.state, now, input.threadId]
      )
      const inserted = await this.run(
        `INSERT INTO agent_turn_events(thread_id, turn_id, type, data_json, created_at)
         VALUES(?, ?, ?, ?, ?)`,
        [
          input.threadId,
          input.turnId,
          type,
          JSON.stringify({ status: input.state, error: input.error }),
          now,
        ]
      )
      return {
        finalMessageId,
        event: {
          id: inserted.lastID,
          threadId: input.threadId,
          turnId: input.turnId,
          type,
          data: { status: input.state, error: input.error },
          createdAt: now,
        } satisfies AgentStreamEvent,
      }
    })
  }

  async createDeliveryOperation (input: {
    threadId: string
    turnId: string
    finalMessageId: string
    idempotencyKey: string
    channel: string
    accountId: string
    contactKey: string
    payload: string
  }): Promise<AgentDeliveryOperationRecord> {
    const existing = await this.get<Record<string, unknown>>(
      'SELECT * FROM agent_delivery_operations WHERE idempotency_key = ?',
      [input.idempotencyKey]
    )
    if (existing) return this.mapDeliveryOperation(existing)
    const id = randomUUID()
    const now = Date.now()
    const payloadHash = createHash('sha256').update(input.payload).digest('hex')
    await this.run(
      `INSERT INTO agent_delivery_operations(
        id, thread_id, turn_id, final_message_id, idempotency_key, channel,
        account_id, contact_key, payload_hash, state, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        id,
        input.threadId,
        input.turnId,
        input.finalMessageId,
        input.idempotencyKey,
        input.channel,
        input.accountId,
        input.contactKey,
        payloadHash,
        now,
        now,
      ]
    )
    return (await this.getDeliveryOperation(id))!
  }

  private mapDeliveryOperation (row: Record<string, unknown>): AgentDeliveryOperationRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      finalMessageId: String(row.final_message_id),
      idempotencyKey: String(row.idempotency_key),
      channel: String(row.channel),
      accountId: String(row.account_id),
      contactKey: String(row.contact_key),
      payloadHash: String(row.payload_hash),
      state: row.state as AgentDeliveryState,
      adapterMessageId: row.adapter_message_id ? String(row.adapter_message_id) : null,
      attempts: Number(row.attempts || 0),
      errorCode: row.error_code ? String(row.error_code) : null,
      error: row.error ? String(row.error) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  async getDeliveryOperation (id: string) {
    const row = await this.get<Record<string, unknown>>(
      'SELECT * FROM agent_delivery_operations WHERE id = ?',
      [id]
    )
    return row ? this.mapDeliveryOperation(row) : null
  }

  async updateDeliveryOperation (input: {
    id: string
    state: AgentDeliveryState
    adapterMessageId?: string
    errorCode?: string
    error?: string
    incrementAttempts?: boolean
  }) {
    await this.run(
      `UPDATE agent_delivery_operations SET state = ?,
       adapter_message_id = COALESCE(?, adapter_message_id),
       error_code = ?, error = ?,
       attempts = attempts + ?, updated_at = ? WHERE id = ?`,
      [
        input.state,
        input.adapterMessageId || null,
        input.errorCode || null,
        input.error || null,
        input.incrementAttempts ? 1 : 0,
        Date.now(),
        input.id,
      ]
    )
    return this.getDeliveryOperation(input.id)
  }

  async listDeliveryOperations (threadId: string, limit = 100) {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT * FROM agent_delivery_operations
       WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`,
      [threadId, Math.max(1, Math.min(limit, 500))]
    )
    return rows.map(row => this.mapDeliveryOperation(row))
  }

  async createToolArtifact (input: {
    threadId: string
    turnId: string
    toolName: string
    content: string
    preview: string
  }): Promise<AgentToolArtifact> {
    const hash = createHash('sha256').update(input.content).digest('hex')
    const existing = await this.get<Record<string, unknown>>(
      'SELECT * FROM agent_tool_artifacts WHERE hash = ?',
      [hash]
    )
    if (existing) return this.mapToolArtifact(existing)
    const id = randomUUID()
    const bytes = Buffer.byteLength(input.content, 'utf8')
    const createdAt = Date.now()
    await this.run(
      `INSERT INTO agent_tool_artifacts(
        id, hash, content_json, preview, bytes, thread_id, turn_id, tool_name, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        hash,
        input.content,
        input.preview,
        bytes,
        input.threadId,
        input.turnId,
        input.toolName,
        createdAt,
      ]
    )
    return { id, hash, bytes, preview: input.preview, createdAt }
  }

  private mapToolArtifact (row: Record<string, unknown>): AgentToolArtifact {
    return {
      id: String(row.id),
      hash: String(row.hash),
      bytes: Number(row.bytes),
      preview: String(row.preview),
      createdAt: Number(row.created_at),
    }
  }

  async getToolArtifact (id: string) {
    const row = await this.get<Record<string, unknown>>(
      'SELECT * FROM agent_tool_artifacts WHERE id = ?',
      [id]
    )
    if (!row) return null
    return {
      ...this.mapToolArtifact(row),
      content: String(row.content_json),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      toolName: String(row.tool_name),
    }
  }

  async recordSkillActivity (input: {
    skillId: string
    skillVersionId?: string
    threadId?: string
    turnId?: string
    action: 'view' | 'use' | 'patch' | 'archive' | 'restore' | 'adopt' | 'pin'
    detail?: unknown
  }) {
    await this.run(
      `INSERT INTO skill_activity(
        id, skill_id, skill_version_id, thread_id, turn_id, action, detail_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.skillId,
        input.skillVersionId || null,
        input.threadId || null,
        input.turnId || null,
        input.action,
        JSON.stringify(input.detail ?? null),
        Date.now(),
      ]
    )
  }

  async claimRecoverableTurns (maxAttempts: number, limit = 20) {
    if (maxAttempts <= 0) return []
    const now = Date.now()
    const rows = await this.all<Record<string, unknown>>(
      `SELECT * FROM turns
       WHERE state = 'recovery_pending' AND recovery_attempts < ?
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY updated_at ASC LIMIT ?`,
      [maxAttempts, now, Math.max(1, Math.min(limit, 100))]
    )
    const claimed: Array<{
      turnId: string
      thread: AgentThreadRecord
      userMessages: string[]
      toolCalls: Awaited<ReturnType<AgentDatabase['listToolCalls']>>
    }> = []
    for (const row of rows) {
      const leaseToken = randomUUID()
      const updated = await this.run(
        `UPDATE turns SET recovery_attempts = recovery_attempts + 1,
         lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND state = 'recovery_pending'
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        [leaseToken, now + 120_000, now, String(row.id), now]
      )
      if (!updated.changes) continue
      const thread = await this.getThread(String(row.thread_id))
      if (!thread) continue
      const messages = await this.all<{ content: string }>(
        `SELECT content FROM messages
         WHERE turn_id = ? AND role = 'user' ORDER BY created_at ASC, rowid ASC`,
        [String(row.id)]
      )
      claimed.push({
        turnId: String(row.id),
        thread,
        userMessages: messages.map(item => String(item.content)),
        toolCalls: await this.listToolCalls(thread.id, String(row.id)),
      })
    }
    return claimed
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
      personaId: row.persona_id ? String(row.persona_id) : null,
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
        tool_allowlist_json, skill_ids_json, persona_id, enabled, created_by, last_run_at,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        persona_id = excluded.persona_id,
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
        input.personaId,
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
