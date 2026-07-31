import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentPolicy } from '../../packages/core/src/agent/policy/policy'
import { AgentRuntime } from '../../packages/core/src/agent/runtime/runtime'
import { AgentToolRegistry } from '../../packages/core/src/agent/tools/registry'
import { getAgentTriggerContent } from '../../packages/core/src/agent/ingress/message'

import type {
  AgentActor,
  AgentConfig,
  AgentModelProvider,
} from '../../packages/core/src/types/agent'
import type { Message } from '../../packages/core/src/types/event'
import type { AgentLearning } from '../../packages/core/src/agent/learning/learning'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const config = (): AgentConfig => ({
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
    rules: [],
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

const actor: AgentActor = {
  id: 'user-1',
  role: 'admin',
  selfId: 'bot-1',
  scene: 'friend',
  contactKey: 'test:bot-1:friend:user-1',
}

const database = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-agent-test-'))
  directories.push(directory)
  const db = new AgentDatabase(directory)
  await db.init()
  return db
}

const learning = {
  contextFor: vi.fn(async () => ({ memories: [], skills: [] })),
  learn: vi.fn(async () => undefined),
} as unknown as AgentLearning

describe('Agent runtime', () => {
  it('executes structured tools and returns the final answer', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'test.echo',
      description: 'echo',
      inputSchema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { type: 'string' } },
      },
      risk: 'read',
      execute: input => ({ value: input.value }),
    })
    let call = 0
    const provider: AgentModelProvider = {
      name: 'fake',
      async complete () {
        call++
        if (call === 1) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'test.echo',
                arguments: { value: 'hello' },
              },
            ],
          }
        }
        return { content: 'done', toolCalls: [] }
      },
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(config),
      provider,
      learning,
      config
    )

    const result = await runtime.runTurn({
      threadKey: actor.contactKey,
      actor,
      content: 'echo hello',
    })

    expect(result.state).toBe('completed')
    expect(result.content).toBe('done')
    expect(call).toBe(2)
    const messages = await db.listMessages(result.threadId)
    expect(messages.some(message => message.role === 'tool')).toBe(true)
    registry.unregister('test.echo')
    await db.close()
  })

  it('waits for approval before running a write tool', async () => {
    const db = await database()
    const registry = new AgentToolRegistry()
    const execute = vi.fn(async () => ({ changed: true }))
    registry.register({
      name: 'test.write',
      description: 'write',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'write',
      execute,
    })
    let call = 0
    const provider: AgentModelProvider = {
      name: 'fake',
      async complete () {
        call++
        return call === 1
          ? {
            content: '',
            toolCalls: [{ id: 'call-write', name: 'test.write', arguments: {} }],
          }
          : { content: 'approved result', toolCalls: [] }
      },
    }
    const runtime = new AgentRuntime(
      db,
      registry,
      new AgentPolicy(config),
      provider,
      learning,
      config
    )

    const waiting = await runtime.runTurn({
      threadKey: 'approval-thread',
      actor,
      content: 'change it',
    })
    expect(waiting.state).toBe('waiting_approval')
    expect(execute).not.toHaveBeenCalled()

    const completed = await runtime.resolveApproval(waiting.approvalId!, 'approved', actor)
    expect(completed.state).toBe('completed')
    expect(execute).toHaveBeenCalledOnce()
    registry.unregister('test.write')
    await db.close()
  })
})

describe('Agent ingress trigger', () => {
  it('always accepts private unmatched messages when enabled', () => {
    const event = {
      msg: 'hello',
      isPrivate: true,
    } as Message
    expect(getAgentTriggerContent(event, config())).toBe('hello')
  })

  it('requires mention or wake word in groups', () => {
    const event = {
      msg: 'hello',
      isPrivate: false,
      atBot: false,
    } as Message
    expect(getAgentTriggerContent(event, config())).toBeNull()
    expect(getAgentTriggerContent({ ...event, atBot: true } as Message, config())).toBe('hello')
    expect(getAgentTriggerContent({ ...event, msg: 'karin status' } as Message, config())).toBe(
      'status'
    )
  })
})
