import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { inferAgentOrigin } from '../../packages/core/src/agent/ingress/origin'

import type { AgentActor } from '../../packages/core/src/types/agent'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

const actor: AgentActor = {
  id: 'admin-1',
  role: 'admin',
  selfId: 'web',
  scene: 'web',
  contactKey: 'web:admin-1',
}

const createDatabase = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-agent-thread-'))
  directories.push(directory)
  const database = new AgentDatabase(directory)
  await database.init()
  return database
}

describe('Agent thread management', () => {
  it('persists the active session and keeps prior sessions available', async () => {
    const database = await createDatabase()
    const initial = await database.getOrCreateSession(actor)
    expect(initial.threadKey).toBe(actor.contactKey)
    expect((await database.getOrCreateSession(actor)).id).toBe(initial.id)

    const next = await database.createSession(actor)
    expect(next.id).not.toBe(initial.id)
    expect(next.threadKey).toContain(`${actor.contactKey}:session:`)
    expect((await database.getOrCreateSession(actor)).id).toBe(next.id)
    expect(await database.getThread(initial.id)).not.toBeNull()
    await database.close()
  })

  it('persists a thread model and lets child agents inherit it', async () => {
    const database = await createDatabase()
    const root = await database.getOrCreateThread('web:model-root', actor)
    await database.setThreadModel(root.id, 'provider-a', 'model-a')

    const child = await database.getOrCreateThread(
      'web:model-child',
      actor,
      root.id
    )

    expect(await database.getThread(root.id)).toMatchObject({
      modelProviderId: 'provider-a',
      modelName: 'model-a',
    })
    expect(child).toMatchObject({
      modelProviderId: 'provider-a',
      modelName: 'model-a',
    })
    await database.close()
  })

  it('groups root sessions by channel, refreshes names and returns a recursive tree', async () => {
    const database = await createDatabase()
    const onebot: AgentActor = {
      id: 'user-1',
      role: 'all',
      selfId: 'bot-1',
      scene: 'group',
      contactKey: 'onebot11:bot-1:group:10001',
      origin: {
        channel: 'onebot',
        protocol: 'onebot11',
        accountId: 'bot-1',
        accountName: 'QQ Bot',
        contactKey: 'onebot11:bot-1:group:10001',
        contactId: '10001',
        contactSubId: '',
        contactName: '研发群',
      },
    }
    const root = await database.getOrCreateSession(onebot)
    const child = await database.getOrCreateThread('subagent:first', onebot, root.id)
    const grandchild = await database.getOrCreateThread('subagent:second', onebot, child.id)
    const telegram = await database.getOrCreateThread(
      'telegram:tg-bot:friend:20002',
      {
        ...onebot,
        id: 'user-2',
        selfId: 'tg-bot',
        scene: 'friend',
        contactKey: 'telegram:tg-bot:friend:20002',
        origin: {
          channel: 'telegram',
          protocol: 'telegram',
          accountId: 'tg-bot',
          accountName: 'TG Bot',
          contactKey: 'telegram:tg-bot:friend:20002',
          contactId: '20002',
          contactSubId: '',
          contactName: 'Alice',
        },
      }
    )

    await database.getOrCreateSession({
      ...onebot,
      origin: { ...onebot.origin!, contactName: '新研发群' },
    })

    expect(await database.getThread(root.id)).toMatchObject({
      channel: 'onebot',
      protocol: 'onebot11',
      accountName: 'QQ Bot',
      contactName: '新研发群',
    })
    expect(await database.listThreads({
      channel: 'onebot',
      rootOnly: true,
      state: 'active',
    })).toEqual([expect.objectContaining({ id: root.id })])
    expect(await database.listThreads({
      channel: 'telegram',
      rootOnly: true,
      state: 'active',
    })).toEqual([expect.objectContaining({ id: telegram.id })])
    expect(await database.getThreadTree(root.id)).toEqual([
      expect.objectContaining({ id: root.id, depth: 0 }),
      expect.objectContaining({ id: child.id, depth: 1 }),
      expect.objectContaining({ id: grandchild.id, depth: 2 }),
    ])
    expect(await database.listThreadChannels()).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'onebot', activeCount: 1 }),
      expect.objectContaining({ channel: 'telegram', activeCount: 1 }),
      expect.objectContaining({ channel: 'web' }),
    ]))
    await database.close()
  })

  it('infers legacy OneBot and direct-channel origins without session suffixes', () => {
    expect(inferAgentOrigin(
      'onebot11:bot-1:group:10001:session:session-id',
      'group',
      'user-1'
    )).toMatchObject({
      channel: 'onebot',
      accountId: 'bot-1',
      contactKey: 'onebot11:bot-1:group:10001',
      contactId: '10001',
    })
    expect(inferAgentOrigin(
      'feishu:bot-2:direct:guild-1:channel-2:user-2:session:session-id',
      'direct',
      'user-2'
    )).toMatchObject({
      channel: 'feishu',
      contactKey: 'feishu:bot-2:direct:guild-1:channel-2:user-2',
      contactId: 'guild-1',
      contactSubId: 'channel-2',
    })
  })

  it('titles, archives, searches and permanently deletes a thread tree', async () => {
    const database = await createDatabase()
    const root = await database.getOrCreateThread('web:root', actor)
    const child = await database.getOrCreateThread('web:child', actor, root.id)
    const rootTurn = await database.createTurn(root.id, actor.id)
    const childTurn = await database.createTurn(child.id, actor.id)
    await database.addMessage(root.id, rootTurn, 'user', '创建一个每日天气任务')
    await database.addMessage(child.id, childTurn, 'assistant', '子任务结果')
    await database.createToolCall(
      root.id,
      rootTurn,
      { id: 'call-1', name: 'karin.system.status', arguments: {} },
      'read',
      'allow',
      'pending'
    )
    await database.completeToolCall('call-1', { ok: true })
    await database.addMemory('user', actor.id, '保留的独立记忆', rootTurn)
    await database.addSkillVersion({
      name: 'weather-daily',
      description: 'weather',
      content: 'weather instructions',
      tools: ['karin.system.status'],
      sourceTurnId: rootTurn,
      contentHash: 'hash',
    })

    const titled = await database.getThread(root.id)
    expect(titled?.title).toBe('创建一个每日天气任务')
    expect(titled?.messageCount).toBe(1)
    expect(titled?.lastMessagePreview).toContain('天气任务')
    expect((await database.listToolCalls(root.id))[0]).toMatchObject({
      name: 'karin.system.status',
      status: 'completed',
      output: { ok: true },
    })
    expect((await database.listTurns(root.id))[0]).toMatchObject({
      id: rootTurn,
      threadId: root.id,
      state: 'running',
    })

    await database.updateThread(root.id, { title: '天气对话', archived: true })
    expect(await database.listThreads({ state: 'active' })).toHaveLength(1)
    expect((await database.listThreads({ state: 'archived', query: '天气' }))[0].title)
      .toBe('天气对话')

    expect(await database.deleteThreadTree(root.id, actor.id)).toBe(true)
    expect(await database.getThread(root.id)).toBeNull()
    expect(await database.getThread(child.id)).toBeNull()
    expect(await database.listMemories()).toHaveLength(1)
    expect(await database.listSkills()).toHaveLength(1)
    expect((await database.listAudit()).some(row => row.action === 'thread.delete')).toBe(true)
    await database.close()
  })

  it('persists authenticated message attachments and removes their files with the thread', async () => {
    const database = await createDatabase()
    const thread = await database.getOrCreateThread('web:media', actor)
    const turn = await database.createTurn(thread.id, actor.id)
    const mediaDirectory = path.join(path.dirname(database.filename), 'media', thread.id)
    await fs.mkdir(mediaDirectory, { recursive: true })
    const storagePath = path.join(mediaDirectory, 'image.png')
    await fs.writeFile(storagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const messageId = await database.addMessage(thread.id, turn, 'user', '[图片]', {
      attachments: [{
        type: 'image',
        storagePath,
        mime: 'image/png',
        size: 4,
        name: 'image.png',
      }],
    })
    const [message] = await database.listMessages(thread.id)

    expect(message).toMatchObject({
      id: messageId,
      attachments: [expect.objectContaining({
        type: 'image',
        mime: 'image/png',
        size: 4,
        name: 'image.png',
      })],
    })
    expect(message.attachments[0].url).toMatch(/^\/api\/v1\/agent\/media\//)
    expect(await database.getMessageAttachment(message.attachments[0].id)).toMatchObject({
      storagePath,
      threadId: thread.id,
    })

    expect(await database.deleteThreadTree(thread.id, actor.id)).toBe(true)
    await expect(fs.stat(storagePath)).rejects.toThrow()
    await database.close()
  })
})
