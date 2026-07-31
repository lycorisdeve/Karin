import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentDatabase } from '@/agent/persistence/database'

import type { AgentScriptToolDefinition } from '@/types/agent'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true })
    )
  )
})

const script = (sourceHash: string): AgentScriptToolDefinition => ({
  id: 'normalize_data',
  name: 'Normalize data',
  description: 'Normalize an object',
  runtime: 'python',
  source: 'def run(payload):\n    return payload\n',
  sourceHash,
  inputSchema: { type: 'object' },
  semantics: {
    objective: 'Normalize data',
    inputs: 'An object',
    outputs: 'An object',
    sideEffects: [],
    idempotent: true,
  },
  stop: {
    completionCondition: 'run returns',
    timeoutMs: 30000,
    maxOutputBytes: 65536,
  },
  failure: {
    strategy: 'fail',
    maxAttempts: 1,
    retryDelayMs: 0,
    userMessage: 'failed',
  },
})

describe('Script Tool Skill version persistence', () => {
  it('persists immutable script definitions and follows rollback and cascade deletion', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-agent-script-db-'))
    directories.push(directory)
    const database = new AgentDatabase(directory)
    await database.init()

    const first = await database.addSkillVersion({
      newSkillId: 'skill-script-test',
      name: 'script-skill',
      description: 'script skill',
      content: 'version one',
      tools: ['skill.skill_skill-script-test.normalize_data'],
      sourceTurnId: 'turn-1',
      contentHash: 'content-1',
      scriptTools: [script('source-1')],
    })
    const second = await database.addSkillVersion({
      skillId: first.skillId,
      name: 'script-skill',
      description: 'script skill v2',
      content: 'version two',
      tools: ['skill.skill_skill-script-test.normalize_data'],
      sourceTurnId: 'turn-2',
      contentHash: 'content-2',
      scriptTools: [script('source-2')],
    })

    const versions = await database.getSkillVersions(first.skillId)
    expect(versions).toHaveLength(2)
    expect(JSON.parse(String(versions[0].script_tools_json))).toMatchObject([
      { id: 'normalize_data', sourceHash: 'source-2' },
    ])
    expect(await database.getActiveScriptSkillVersions()).toMatchObject([{
      skillId: first.skillId,
      versionId: second.versionId,
      scriptTools: [{ sourceHash: 'source-2' }],
    }])

    expect(await database.rollbackSkill(first.skillId, first.versionId)).toBe(true)
    expect(await database.getActiveScriptSkillVersions()).toMatchObject([{
      versionId: first.versionId,
      scriptTools: [{ sourceHash: 'source-1' }],
    }])

    const deleted = await database.deleteSkillCascade(first.skillId, 'admin')
    expect(deleted).toMatchObject({ deleted: true, versions: 2 })
    expect(await database.getActiveScriptSkillVersions()).toEqual([])
    await database.close()
  })
})
