import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentDatabase } from '@/agent/persistence/database'
import { AgentLearning } from '@/agent/learning/learning'
import { AgentToolRegistry } from '@/agent/tools/registry'
import { scriptToolName } from '@/agent/scripts/runtime'

import type {
  AgentActor,
  AgentConfig,
  AgentScriptToolDefinition,
} from '@/types/agent'
import type { AgentModelProvider } from '@/types/agent'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true })
    )
  )
})

const config = () => ({
  scriptRuntime: {
    pythonExecutable: '',
    defaultTimeoutMs: 30000,
    maxTimeoutMs: 120000,
    defaultMaxOutputBytes: 65536,
    maxOutputBytes: 1048576,
  },
} as AgentConfig)

const actor: AgentActor = {
  id: 'admin',
  role: 'admin',
  selfId: 'web',
  scene: 'web',
  contactKey: 'web:admin',
}

const script = (multiplier: number): AgentScriptToolDefinition => ({
  id: 'multiply_value',
  name: 'Multiply value',
  description: 'Multiply an input number',
  runtime: 'python',
  source: `def run(payload):\n    return {"value": payload["value"] * ${multiplier}}\n`,
  sourceHash: '',
  inputSchema: {
    type: 'object',
    required: ['value'],
    additionalProperties: false,
    properties: { value: { type: 'number' } },
  },
  outputSchema: {
    type: 'object',
    required: ['value'],
    additionalProperties: false,
    properties: { value: { type: 'number' } },
  },
  semantics: {
    objective: 'Multiply a number',
    inputs: 'An object containing value',
    outputs: 'An object containing multiplied value',
    sideEffects: [],
    idempotent: true,
  },
  stop: {
    completionCondition: 'run returns the result',
    timeoutMs: 30000,
    maxOutputBytes: 65536,
  },
  failure: {
    strategy: 'fail',
    maxAttempts: 1,
    retryDelayMs: 0,
    userMessage: 'Multiplication failed',
  },
})

describe('Script Tool Skill lifecycle', () => {
  it('registers only the active immutable version and audits its source hash', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-script-skill-'))
    directories.push(directory)
    const database = new AgentDatabase(path.join(directory, 'database'))
    await database.init()
    const registry = new AgentToolRegistry()
    registry.unregisterPrefix('skill.')
    const learning = new AgentLearning(
      database,
      {} as AgentModelProvider,
      registry,
      config,
      path.join(directory, 'skills')
    )
    const status = await learning.scriptRuntime.status()
    if (!status.available) {
      await database.close()
      return
    }

    const first = await learning.createSkill({
      name: 'python-multiplier',
      description: 'Multiply values with Python',
      instructions: 'Use the Script Tool to multiply a value.',
      tools: [],
      scriptTools: [script(2)],
    }, 'web', 'turn-1', actor)
    const name = scriptToolName(first.skillId, 'multiply_value')
    expect(registry.list().find(tool => tool.name === name)).toMatchObject({
      risk: 'read',
      permission: 'all',
    })
    const firstVersion = (await database.getSkillVersions(first.skillId))[0]
    await expect(fs.stat(path.join(
      directory,
      'skills',
      first.skillId,
      String(firstVersion.id),
      'multiply_value.py'
    ))).resolves.toMatchObject({ size: expect.any(Number) })

    const context = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      actor,
      signal: new AbortController().signal,
      automated: false,
    }
    await expect(registry.execute(name, { value: 5 }, context, 65536))
      .resolves.toEqual({ value: 10 })

    await learning.updateSkill(first.skillId, {
      name: 'python-multiplier',
      description: 'Multiply values with Python',
      instructions: 'Use the active Script Tool version.',
      tools: [],
      scriptTools: [script(3)],
    }, 'web', 'turn-2', actor)
    await expect(registry.execute(name, { value: 5 }, context, 65536))
      .resolves.toEqual({ value: 15 })

    expect(await learning.rollbackSkill(
      first.skillId,
      String(firstVersion.id),
      actor
    )).toBe(true)
    await expect(registry.execute(name, { value: 5 }, context, 65536))
      .resolves.toEqual({ value: 10 })

    const audit = await database.listAudit(50)
    expect(audit.some(item =>
      item.action === 'script.execute.completed' &&
      String(item.target).includes('@')
    )).toBe(true)

    const removed = await learning.deleteSkill(first.skillId, actor)
    expect(removed.deleted).toBe(true)
    expect(registry.list().some(tool => tool.name === name)).toBe(false)

    registry.unregisterPrefix('skill.')
    await database.close()
    vi.restoreAllMocks()
  })
})
