import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentRepairManager } from '../../packages/core/src/agent/repair/manager'

const execFileAsync = promisify(execFile)
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const fixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-repair-test-'))
  directories.push(directory)
  const workspace = path.join(directory, 'workspace')
  const artifacts = path.join(directory, 'artifacts')
  const databaseDirectory = path.join(directory, 'database')
  await fs.mkdir(workspace)
  await execFileAsync('git', ['init'], { cwd: workspace })
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspace })
  await execFileAsync('git', ['config', 'user.name', 'Karin Test'], { cwd: workspace })
  await fs.writeFile(path.join(workspace, 'value.ts'), "export const value = 'old'\n")
  await execFileAsync('git', ['add', 'value.ts'], { cwd: workspace })
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: workspace })
  const database = new AgentDatabase(databaseDirectory)
  await database.init()
  const restart = vi.fn(async () => undefined)
  const manager = new AgentRepairManager(
    database,
    restart,
    workspace,
    path.join(directory, 'plugins'),
    artifacts
  )
  return { workspace, database, manager, restart }
}

const actor = {
  id: 'master',
  role: 'master' as const,
  selfId: 'console',
  scene: 'web',
  contactKey: 'web:master',
}

const proposal = {
  target: 'karin' as const,
  problem: 'value is stale',
  reproduction: 'read value.ts',
  rootCause: 'fixture uses old value',
  confidence: 1,
  patch: [
    'diff --git a/value.ts b/value.ts',
    'index e6f5620..13f25a6 100644',
    '--- a/value.ts',
    '+++ b/value.ts',
    '@@ -1 +1 @@',
    "-export const value = 'old'",
    "+export const value = 'new'",
    '',
  ].join('\n'),
  semantics: {
    objective: 'replace stale value',
    inputs: 'value.ts',
    outputs: 'new value',
    sideEffects: ['modifies value.ts'],
    idempotent: true,
  },
  stopCondition: 'value.ts contains new',
  failureStrategy: 'restore touched files',
  verification: [] as const,
  rollback: 'restore the managed snapshot',
}

describe('Agent managed repair candidates', () => {
  it('validates, applies and rolls back a hashed patch without touching unrelated files', async () => {
    const { workspace, database, manager, restart } = await fixture()
    const candidate = await manager.propose(
      { ...proposal, verification: [] },
      actor,
      'thread',
      'turn'
    )

    expect(candidate?.state).toBe('ready')
    expect(candidate?.payload.patchHash).toMatch(/^[a-f0-9]{64}$/)
    await expect(manager.artifact(candidate!.id)).resolves.toMatchObject({
      patch: expect.stringContaining("+export const value = 'new'"),
    })

    await fs.writeFile(path.join(workspace, 'value.ts'), "export const value = 'changed'\n")
    await expect(manager.apply(candidate!.id, actor, false))
      .rejects.toThrow('文件在候选创建后已变化')

    await fs.writeFile(path.join(workspace, 'value.ts'), "export const value = 'old'\n")
    await expect(manager.apply(candidate!.id, actor, false))
      .resolves.toMatchObject({ state: 'active' })
    await expect(fs.readFile(path.join(workspace, 'value.ts'), 'utf8'))
      .resolves.toContain("'new'")
    expect(restart).not.toHaveBeenCalled()

    await expect(manager.rollback(candidate!.id, actor, false))
      .resolves.toMatchObject({ state: 'rolled_back' })
    await expect(fs.readFile(path.join(workspace, 'value.ts'), 'utf8'))
      .resolves.toContain("'old'")
    await database.close()
  })

  it('rejects traversal and node_modules paths before writing an artifact', async () => {
    const { database, manager } = await fixture()
    await expect(manager.propose({
      ...proposal,
      patch: [
        'diff --git a/../secret.ts b/../secret.ts',
        '--- a/../secret.ts',
        '+++ b/../secret.ts',
        '@@ -0,0 +1 @@',
        '+secret',
      ].join('\n'),
      verification: [],
    }, actor, 'thread', 'turn')).rejects.toThrow('补丁路径不在允许范围内')

    await expect(manager.propose({
      ...proposal,
      patch: [
        'diff --git a/node_modules/pkg/index.js b/node_modules/pkg/index.js',
        '--- a/node_modules/pkg/index.js',
        '+++ b/node_modules/pkg/index.js',
        '@@ -0,0 +1 @@',
        '+unsafe',
      ].join('\n'),
      verification: [],
    }, actor, 'thread', 'turn')).rejects.toThrow('补丁路径不在允许范围内')
    await database.close()
  })
})
