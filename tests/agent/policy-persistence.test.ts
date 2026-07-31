import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentPolicy } from '../../packages/core/src/agent/policy/policy'
import { AgentToolRegistry } from '../../packages/core/src/agent/tools/registry'

import type {
  AgentActor,
  AgentConfig,
  AgentToolContext,
} from '../../packages/core/src/types/agent'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const baseConfig = (): AgentConfig => ({
  version: 3,
  enabled: true,
  providers: [{
    id: 'fake',
    name: 'Fake',
    kind: 'custom',
    enabled: true,
    baseUrl: 'http://localhost/v1',
    apiKey: 'test-only',
    model: 'fake',
    timeout: 30000,
  }],
  routing: { primary: 'fake', fallback: [] },
  trigger: {
    private: true,
    groupMention: true,
    wakeWords: ['karin'],
  },
  limits: {
    maxToolRounds: 8,
    maxToolOutputBytes: 65536,
    maxRecentMessages: 40,
    maxSubagents: 3,
  },
  policy: {
    approvalTtlMs: 300000,
    hardDeny: ['*.delete'],
    rules: [
      { pattern: 'test.*', decision: 'deny' },
      { pattern: 'test.exact', decision: 'allow' },
      { pattern: 'test.destructive', decision: 'allow' },
    ],
    defaults: {
      read: 'allow',
      write: 'ask',
      external: 'ask',
      destructive: 'deny',
    },
  },
  learning: { memory: false, skills: false },
  tools: { disabled: [], disabledToolsets: [] },
  mcp: { enabled: false, servers: [] },
})

const actor = (role: AgentActor['role'] = 'admin'): AgentActor => ({
  id: 'user-1',
  role,
  selfId: 'bot-1',
  scene: 'friend',
  contactKey: 'test:bot-1:friend:user-1',
})

const context = (
  role: AgentActor['role'] = 'admin',
  overrides: Partial<AgentToolContext> = {}
): AgentToolContext => ({
  threadId: 'thread-1',
  turnId: 'turn-1',
  actor: actor(role),
  signal: new AbortController().signal,
  automated: false,
  ...overrides,
})

describe('Agent policy and tool validation', () => {
  it('applies permission, hard-deny, exact and automated rules in order', () => {
    const registry = new AgentToolRegistry()
    const publicRead = registry.register({
      name: 'policy.public',
      description: 'public read',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => ({}),
    })
    const exact = registry.register({
      name: 'test.exact',
      description: 'exact rule',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => ({}),
    })
    const destructive = registry.register({
      name: 'test.destructive',
      description: 'destructive rule',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'destructive',
      execute: () => ({}),
    })
    const hardDenied = registry.register({
      name: 'test.delete',
      description: 'hard denied',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => ({}),
    })
    const write = registry.register({
      name: 'policy.write',
      description: 'write',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'write',
      execute: () => ({}),
    })
    const policy = new AgentPolicy(baseConfig)

    expect(policy.decide(publicRead, context('all'))).toBe('allow')
    expect(policy.decide(exact, context())).toBe('allow')
    expect(policy.decide(hardDenied, context())).toBe('deny')
    expect(policy.decide(destructive, context('admin', { automated: true }))).toBe('deny')
    expect(policy.decide(write, context('admin', { automated: true }))).toBe('deny')
    expect(
      policy.decide(
        write,
        context('admin', { automated: true, allowedTools: ['policy.write'] })
      )
    ).toBe('allow')

    for (const name of [
      'policy.public',
      'test.exact',
      'test.destructive',
      'test.delete',
      'policy.write',
    ]) {
      registry.unregister(name)
    }
  })

  it('rejects additional input fields and truncates oversized output', async () => {
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'schema.echo',
      description: 'schema validation',
      inputSchema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { type: 'string' } },
      },
      risk: 'read',
      execute: input => ({ value: `${input.value}`.repeat(100) }),
    })

    await expect(
      registry.execute(
        'schema.echo',
        { value: 'ok', unexpected: true },
        context(),
        64
      )
    ).rejects.toThrow('工具参数校验失败')

    const output = await registry.execute('schema.echo', { value: 'ok' }, context(), 64)
    expect(output).toEqual(expect.stringContaining('工具输出已截断'))

    registry.unregister('schema.echo')
  })
})

describe('Agent persistence', () => {
  it('isolates threads and either searches with FTS5 or reports it unavailable', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-agent-db-test-'))
    directories.push(directory)
    const database = new AgentDatabase(directory)
    await database.init()

    try {
      const first = await database.getOrCreateThread('private:user-1', actor())
      const same = await database.getOrCreateThread('private:user-1', actor())
      const second = await database.getOrCreateThread('private:user-2', {
        ...actor(),
        id: 'user-2',
        contactKey: 'test:bot-1:friend:user-2',
      })
      expect(same.id).toBe(first.id)
      expect(second.id).not.toBe(first.id)

      const turnId = await database.createTurn(first.id, actor().id)
      await database.addMessage(first.id, turnId, 'user', 'karin unique searchable phrase')

      if (database.isFtsAvailable()) {
        const results = await database.searchMessages('searchable')
        expect(results.some(result => result.thread_id === first.id)).toBe(true)
      } else {
        await expect(database.searchMessages('searchable')).rejects.toThrow(
          '当前 SQLite 运行环境不支持 FTS5'
        )
      }
    } finally {
      await database.close()
    }
  })
})
