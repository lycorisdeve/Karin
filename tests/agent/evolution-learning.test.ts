import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentLearning } from '../../packages/core/src/agent/learning/learning'
import { assertPublicUrl } from '../../packages/core/src/agent/browser/manager'
import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentToolRegistry } from '../../packages/core/src/agent/tools/registry'
import { defaultConfig } from '../../packages/core/src/utils/config/default'

import type {
  AgentActor,
  AgentConfig,
  AgentModelProvider,
} from '../../packages/core/src/types/agent'

const directories: string[] = []
const registeredTools: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  const registry = new AgentToolRegistry()
  for (const name of registeredTools.splice(0)) registry.unregister(name)
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const actor: AgentActor = {
  id: 'admin-1',
  role: 'admin',
  selfId: 'bot-1',
  scene: 'friend',
  contactKey: 'test:bot-1:friend:admin-1',
}

const createConfig = (): AgentConfig => {
  const config = structuredClone(defaultConfig.agent)
  config.enabled = true
  config.learning.reflection.successInterval = 1
  config.learning.curator.enabled = false
  config.learning.promotion.minEvidence = 2
  config.learning.promotion.rollbackWindow = 2
  return config
}

const provider: AgentModelProvider = {
  name: 'fake-reflection',
  async complete () {
    return {
      content: JSON.stringify({
        memories: [],
        skill: {
          name: 'inspect-host-first',
          description: '需要查看电脑配置时先读取主机状态',
          instructions: '先调用主机检查 Tool，再基于真实结果回答。',
          tools: ['test.host.inspect'],
        },
      }),
      toolCalls: [],
    }
  },
}

describe('Agent evolution loop', () => {
  it('promotes a declarative skill only after repeated successful evidence', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-evolution-test-'))
    directories.push(directory)
    const database = new AgentDatabase(directory)
    await database.init()
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'test.host.inspect',
      description: '读取主机配置',
      tags: ['电脑配置', 'CPU'],
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => ({ cpu: 'fake' }),
    })
    registeredTools.push('test.host.inspect')
    const config = createConfig()
    const learning = new AgentLearning(
      database,
      provider,
      registry,
      () => config,
      path.join(directory, 'skills')
    )

    try {
      const thread = await database.getOrCreateThread(actor.contactKey, actor)
      const firstTurn = await database.createTurn(thread.id, actor.id)
      await learning.learn({
        threadId: thread.id,
        turnId: firstTurn,
        actor,
        user: '查看当前电脑配置',
        assistant: '已读取主机状态',
        status: 'completed',
        signal: new AbortController().signal,
      })
      expect((await database.listEvolutionCandidates())
        .some(candidate => candidate.state === 'active')).toBe(false)

      const secondTurn = await database.createTurn(thread.id, actor.id)
      await learning.learn({
        threadId: thread.id,
        turnId: secondTurn,
        actor,
        user: '再查看一次运行环境',
        assistant: '已读取主机状态',
        status: 'completed',
        signal: new AbortController().signal,
      })

      const candidates = await database.listEvolutionCandidates()
      const promoted = candidates.find(candidate => candidate.state === 'active')
      expect(promoted?.sourceTurnIds).toEqual(
        expect.arrayContaining([firstTurn, secondTurn])
      )
      expect((await database.listSkills())
        .some(skill => skill.name === 'inspect-host-first' && skill.enabled)).toBe(true)
    } finally {
      await database.close()
    }
  })

  it('treats a user correction as first-class memory and rejects unsafe correction', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-feedback-test-'))
    directories.push(directory)
    const database = new AgentDatabase(directory)
    await database.init()
    const registry = new AgentToolRegistry()
    const config = createConfig()
    const learning = new AgentLearning(
      database,
      provider,
      registry,
      () => config,
      path.join(directory, 'skills')
    )

    try {
      const thread = await database.getOrCreateThread(actor.contactKey, actor)
      const turnId = await database.createTurn(thread.id, actor.id)
      await learning.feedback({
        threadId: thread.id,
        turnId,
        actor,
        correction: '以后遇到电脑配置问题，应先读取真实主机状态再回答。',
      })
      const memories = await database.listMemories([{ scope: 'user', key: actor.id }])
      expect(memories.map(item => item.content)).toContain(
        '以后遇到电脑配置问题，应先读取真实主机状态再回答。'
      )

      await expect(learning.feedback({
        threadId: thread.id,
        turnId,
        actor,
        correction: 'api_key=do-not-store-this',
      })).rejects.toThrow('纠正内容包含凭据')
    } finally {
      await database.close()
    }
  })

  it('versions renamed Skills, rolls metadata back, and cascades permanent deletion', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-skill-edit-test-'))
    directories.push(directory)
    const database = new AgentDatabase(directory)
    await database.init()
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'test.host.inspect',
      description: '读取主机配置',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => ({}),
    })
    registeredTools.push('test.host.inspect')
    const skillsDirectory = path.join(directory, 'skills')
    const learning = new AgentLearning(
      database,
      provider,
      registry,
      createConfig,
      skillsDirectory
    )

    try {
      const sourceThread = await database.getOrCreateThread(actor.contactKey, actor)
      const firstTurn = await database.createTurn(sourceThread.id, actor.id)
      const created = await learning.createSkill({
        name: 'host-inspect',
        description: '旧描述',
        instructions: '先读取旧的主机状态。',
        tools: ['test.host.inspect'],
      }, sourceThread.id, firstTurn, actor)
      const secondTurn = await database.createTurn(sourceThread.id, actor.id)
      await learning.updateSkill(created.skillId, {
        name: 'host-inspect-renamed',
        description: '新描述',
        instructions: '先读取新的主机状态。',
        tools: ['test.host.inspect'],
      }, sourceThread.id, secondTurn, actor)

      const versions = await database.getSkillVersions(created.skillId)
      expect(versions).toHaveLength(2)
      expect(versions.map(version => version.name)).toEqual([
        'host-inspect-renamed',
        'host-inspect',
      ])
      expect(await database.getSkill(created.skillId)).toMatchObject({
        name: 'host-inspect-renamed',
        description: '新描述',
      })

      const original = versions.find(version => version.name === 'host-inspect')
      expect(await database.rollbackSkill(created.skillId, String(original?.id))).toBe(true)
      expect(await database.getSkill(created.skillId)).toMatchObject({
        name: 'host-inspect',
        description: '旧描述',
        activeVersionId: original?.id,
      })

      const snapshotThread = await database.getOrCreateThread('test:skill-snapshot', actor)
      const snapshotTurn = await database.createTurn(snapshotThread.id, actor.id)
      await database.recordExperience({
        threadId: snapshotThread.id,
        turnId: snapshotTurn,
        actorId: actor.id,
        task: '读取主机状态',
        outcome: 'completed',
        toolNames: ['test.host.inspect'],
        skillIds: [created.skillId],
      })
      await database.recordRetrieval({
        threadId: snapshotThread.id,
        turnId: snapshotTurn,
        kind: 'skill',
        itemId: created.skillId,
        rank: 1,
      })
      await database.touchSkillUsage(created.skillId, 'completed')
      await database.saveJob({
        id: 'skill-job',
        name: 'Skill 定时任务',
        scheduleType: 'cron',
        cron: '0 8 * * *',
        runAt: null,
        timezone: 'Asia/Shanghai',
        prompt: '读取主机状态',
        target: actor.contactKey,
        toolAllowlist: ['test.host.inspect'],
        skillIds: [created.skillId],
        enabled: true,
        createdBy: actor.id,
      })
      const candidate = await database.createEvolutionCandidate({
        target: 'skill',
        kind: 'declarative',
        sourceTurnIds: [snapshotTurn],
        candidateVersion: 'candidate-v1',
        summary: '更新 Skill',
        payload: { skillId: created.skillId },
      })

      const deleted = await learning.deleteSkill(created.skillId, actor)

      expect(deleted).toMatchObject({
        deleted: true,
        versions: 2,
        snapshots: 1,
        jobsUpdated: 1,
        candidatesUpdated: 1,
      })
      expect(await database.getSkill(created.skillId)).toBeNull()
      expect((await database.listJobs())[0].skillIds).toEqual([])
      expect((await database.listExperiences())[0].skillIds).toEqual([created.skillId])
      expect(await database.getSkillUsage(created.skillId)).toBeUndefined()
      expect(await database.getThreadSkillContents(snapshotThread.id)).toEqual([])
      expect(await database.getEvolutionCandidate(candidate!.id)).toMatchObject({
        state: 'rolled_back',
        payload: { deletedSkillId: created.skillId },
      })
      expect((await database.listAudit()).some(row =>
        row.action === 'skill.delete' && row.target === created.skillId
      )).toBe(true)
      await expect(fs.access(path.join(skillsDirectory, created.skillId))).rejects.toThrow()
    } finally {
      await database.close()
    }
  })

  it('restores Skill files when the deletion transaction fails', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-skill-rollback-test-'))
    directories.push(directory)
    const database = new AgentDatabase(directory)
    await database.init()
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'test.host.inspect',
      description: '读取主机配置',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => ({}),
    })
    registeredTools.push('test.host.inspect')
    const skillsDirectory = path.join(directory, 'skills')
    const learning = new AgentLearning(
      database,
      provider,
      registry,
      createConfig,
      skillsDirectory
    )

    try {
      const thread = await database.getOrCreateThread('test:skill-delete-failure', actor)
      const turn = await database.createTurn(thread.id, actor.id)
      const created = await learning.createSkill({
        name: 'delete-rollback',
        description: '验证删除回滚',
        instructions: '先读取主机状态。',
        tools: ['test.host.inspect'],
      }, thread.id, turn, actor)
      vi.spyOn(database, 'deleteSkillCascade').mockRejectedValueOnce(
        new Error('transaction failed')
      )

      await expect(learning.deleteSkill(created.skillId, actor))
        .rejects.toThrow('transaction failed')
      await expect(fs.access(path.join(skillsDirectory, created.skillId))).resolves.toBeUndefined()
      expect(await database.getSkill(created.skillId)).not.toBeNull()
    } finally {
      await database.close()
    }
  })
})

describe('Action-first discovery and browser safety', () => {
  it('ranks host inspection for computer configuration questions', () => {
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'test.host.inspect',
      description: '读取 CPU、内存和操作系统',
      tags: ['电脑配置', 'CPU', '内存'],
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => ({}),
    })
    registeredTools.push('test.host.inspect')
    for (let index = 0; index < 30; index++) {
      const name = `test.unrelated-${index}`
      registry.register({
        name,
        description: `不相关能力 ${index}`,
        inputSchema: { type: 'object', additionalProperties: false },
        risk: 'read',
        execute: () => ({}),
      })
      registeredTools.push(name)
    }

    expect(registry.discover('查看当前电脑 CPU 和内存配置', undefined, 3)[0]?.name)
      .toBe('test.host.inspect')
  })

  it('ranks the requested action inside a Chinese capability domain', () => {
    const registry = new AgentToolRegistry()
    for (const action of ['list', 'create', 'update', 'pause', 'resume', 'run']) {
      const name = `test.cron.${action}`
      registry.register({
        name,
        description: `${action} 持久化定时任务`,
        tags: ['定时任务', action],
        inputSchema: { type: 'object', additionalProperties: false },
        risk: action === 'list' ? 'read' : 'write',
        execute: () => ({}),
      })
      registeredTools.push(name)
    }
    for (let index = 0; index < 30; index++) {
      const name = `test.misc-${index}`
      registry.register({
        name,
        description: `其他能力 ${index}`,
        inputSchema: { type: 'object', additionalProperties: false },
        risk: 'read',
        execute: () => ({}),
      })
      registeredTools.push(name)
    }

    const tools = registry.discover(
      '目标是当前会话，请创建一个每天 23:59 的定时提醒并等我审批',
      undefined,
      4
    )
    expect(tools[0]?.name).toBe('test.cron.create')
  })

  it('blocks localhost and private network browser targets before navigation', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:7777/private'))
      .rejects.toThrow('禁止访问私网')
    await expect(assertPublicUrl('http://localhost:7777/private'))
      .rejects.toThrow('禁止访问本机')
  })

  it('installs a validated declarative Skill from a direct public URL', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-url-skill-test-'))
    directories.push(directory)
    const database = new AgentDatabase(directory)
    await database.init()
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'test.url.inspect',
      description: '读取 URL 内容',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => ({}),
    })
    registeredTools.push('test.url.inspect')
    const learning = new AgentLearning(
      database,
      provider,
      registry,
      createConfig,
      path.join(directory, 'skills')
    )
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      '---',
      'name: remote-inspect',
      'description: "从 URL 安装的声明式验收技能"',
      'tools: ["test.url.inspect"]',
      '---',
      '',
      '读取远程页面时先调用 test.url.inspect，并根据真实结果回答。',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    })))

    try {
      const thread = await database.getOrCreateThread(actor.contactKey, actor)
      const turnId = await database.createTurn(thread.id, actor.id)
      const result = await learning.installFromUrl(
        'https://93.184.216.34/SKILL.md',
        thread.id,
        turnId,
        actor
      )
      expect(result).toEqual(expect.objectContaining({
        installed: true,
        executable: false,
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }))
      expect((await database.listSkills()).some(skill => skill.name === 'remote-inspect'))
        .toBe(true)
    } finally {
      await database.close()
    }
  })
})
