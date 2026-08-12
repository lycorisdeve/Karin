import { describe, expect, it, vi } from 'vitest'
import { AgentTurnRecovery } from '../../packages/core/src/agent/runtime/recovery'

import type {
  AgentConfig,
  AgentModelProvider,
  AgentTaskPlan,
  AgentToolResultEnvelope,
  AgentTurnInput,
} from '../../packages/core/src/types/agent'

const config = (verified = false): AgentConfig => ({
  version: 7,
  enabled: true,
  providers: [{
    id: 'fake',
    name: 'Fake',
    kind: 'custom',
    enabled: true,
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-only',
    model: 'fake',
    timeout: 30000,
    verification: verified
      ? {
        testedAt: Date.now(),
        chat: true,
        stream: true,
        tools: true,
        latency: 1,
        fingerprint: 'test',
      }
      : undefined,
  }],
  routing: { primary: 'fake', fallback: [] },
  trigger: { private: true, groupMention: true, wakeWords: [] },
  limits: {
    maxToolRounds: 8,
    maxToolOutputBytes: 65536,
    maxRecentMessages: 40,
    maxSubagents: 3,
  },
  policy: {
    approvalTtlMs: 300000,
    hardDeny: [],
    rules: [],
    defaults: {
      read: 'allow',
      write: 'ask',
      external: 'ask',
      destructive: 'ask',
    },
  },
  learning: {
    memory: true,
    skills: true,
    reflection: { enabled: true, afterFailure: true, successInterval: 5 },
    curator: {
      enabled: true,
      intervalHours: 168,
      minIdleMinutes: 120,
      staleAfterDays: 30,
      archiveAfterDays: 90,
    },
    promotion: {
      autoMemory: true,
      autoRouting: true,
      autoDeclarativeSkills: true,
      minEvidence: 3,
      minSuccessRate: 0.8,
      maxRegressionRate: 0.05,
      autoRollback: true,
      rollbackWindow: 20,
    },
  },
  recovery: {
    enabled: true,
    maxCycles: 2,
    maxDiagnosticCalls: 8,
    maxDurationMs: 120000,
    researchPolicy: 'evidence-driven',
    repair: { requireApproval: true, workspaceRoots: [] },
  },
  tools: { disabled: [], disabledToolsets: [] },
  mcp: { enabled: false, servers: [] },
  scriptRuntime: {
    pythonExecutable: '',
    defaultTimeoutMs: 30000,
    maxTimeoutMs: 120000,
    defaultMaxOutputBytes: 65536,
    maxOutputBytes: 1048576,
  },
})

const input: AgentTurnInput = {
  threadKey: 'test',
  actor: {
    id: 'user',
    role: 'admin',
    selfId: 'bot',
    scene: 'friend',
    contactKey: 'onebot:bot:friend:user',
    origin: {
      channel: 'onebot',
      protocol: 'onebot11',
      accountId: 'bot',
      accountName: 'Bot',
      contactKey: 'onebot:bot:friend:user',
      contactId: 'user',
      contactSubId: '',
      contactName: 'User',
    },
  },
  content: '发一张猫的照片给我',
}

const tools = [
  {
    name: 'karin.browser.search',
    description: 'search',
    risk: 'read',
    tags: ['图片'],
  },
  {
    name: 'karin.browser.screenshot',
    description: 'screenshot',
    risk: 'read',
    tags: ['截图'],
  },
  {
    name: 'karin.browser.download',
    description: 'download',
    risk: 'read',
    tags: ['图片'],
  },
  {
    name: 'karin.bot.send_message',
    description: 'send',
    risk: 'external',
    tags: ['发送图片'],
  },
]

const provider = (content: string): AgentModelProvider => ({
  name: 'fake',
  complete: vi.fn(async () => ({ content, toolCalls: [] })),
})

describe('Agent verifiable recovery', () => {
  it('does not infer an image requirement from 发一下新闻', async () => {
    const recovery = new AgentTurnRecovery(provider('unused'), () => config(false))
    const result = await recovery.createPlan(
      {
        ...input,
        actor: {
          ...input.actor,
          scene: 'web',
          contactKey: 'web:admin',
          origin: {
            channel: 'web',
            protocol: 'web',
            accountId: 'web',
            accountName: 'WebUI',
            contactKey: 'web:admin',
            contactId: 'admin',
            contactSubId: '',
            contactName: 'Admin',
          },
        },
        content: '给我发一下今天的热点新闻',
      },
      tools,
      'fake',
      'fake',
      new AbortController().signal
    )

    expect(result.plan.goals[0].postconditions.map(item => item.kind)).toEqual([
      'information',
    ])
    expect(result.plan.goals[0].capabilities).not.toContain('karin.browser.download')
    expect(result.plan.goals[0].capabilities).not.toContain('karin.bot.send_message')
  })

  it('uses a conservative actionable plan until provider planning is verified', async () => {
    const model = provider('unused')
    const recovery = new AgentTurnRecovery(model, () => config(false))
    const result = await recovery.createPlan(
      input,
      tools,
      'fake',
      'fake',
      new AbortController().signal
    )

    expect(model.complete).not.toHaveBeenCalled()
    expect(result.plan.createdBy).toBe('fallback')
    expect(result.plan.goals[0].postconditions.map(item => item.kind)).toEqual([
      'media',
      'delivery',
    ])
  })

  it('treats a quoted image verification failure as a diagnostic question', async () => {
    const recovery = new AgentTurnRecovery(provider('unused'), () => config(false))
    const result = await recovery.createPlan(
      {
        ...input,
        content: [
          '你的进化中心是什么意思？而且每次都会报：',
          '任务未通过实际结果验证：未通过：取得至少一张经过校验的图片；',
          '向当前会话成功投递至少一张图片',
        ].join('\n'),
      },
      tools,
      'fake',
      'fake',
      new AbortController().signal
    )

    expect(result.plan.goals[0].postconditions.map(item => item.kind)).toEqual([
      'information',
    ])
  })

  it('presents downloaded images in a Web thread without requiring channel delivery', async () => {
    const model = provider('unused')
    const recovery = new AgentTurnRecovery(model, () => config(false))
    const result = await recovery.createPlan(
      {
        ...input,
        actor: {
          ...input.actor,
          scene: 'web',
          contactKey: 'web:admin',
          origin: {
            channel: 'web',
            protocol: 'web',
            accountId: 'web',
            accountName: 'WebUI',
            contactKey: 'web:admin',
            contactId: 'admin',
            contactSubId: '',
            contactName: 'Admin',
          },
        },
      },
      tools,
      'fake',
      'fake',
      new AbortController().signal
    )

    expect(result.plan.goals[0].postconditions.map(item => item.kind)).toEqual(['media'])
    expect(result.plan.goals[0].capabilities).not.toContain('karin.bot.send_message')
    const media: AgentToolResultEnvelope[] = [{
      status: 'completed',
      data: { path: 'controlled/dog.png' },
      receipt: {
        toolName: 'karin.browser.download',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        idempotent: true,
        media: { path: 'controlled/dog.png', mime: 'image/png', size: 1024 },
      },
      evidence: ['media:controlled/dog.png'],
    }]
    expect(recovery.finalContent(result.plan, media, '我没有发送图片的工具'))
      .toContain('附件展示')
  })

  it('accepts any completed Tool receipt that contains verified media', async () => {
    const recovery = new AgentTurnRecovery(provider('unused'), () => config(false))
    const result = await recovery.createPlan(
      {
        ...input,
        actor: {
          ...input.actor,
          scene: 'web',
          contactKey: 'web:admin',
          origin: {
            channel: 'web',
            protocol: 'web',
            accountId: 'web',
            accountName: 'WebUI',
            contactKey: 'web:admin',
            contactId: 'admin',
            contactSubId: '',
            contactName: 'Admin',
          },
        },
      },
      tools,
      'fake',
      'fake',
      new AbortController().signal
    )
    const screenshot: AgentToolResultEnvelope[] = [{
      status: 'completed',
      data: { path: 'controlled/news.png' },
      receipt: {
        toolName: 'karin.browser.screenshot',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        idempotent: true,
        media: { path: 'controlled/news.png', mime: 'image/png', size: 1024 },
      },
      evidence: ['media:controlled/news.png'],
    }]

    expect(result.plan.goals[0].capabilities).toContain('karin.browser.screenshot')
    expect(recovery.verify(result.plan, screenshot, '图片已准备好')).toMatchObject({
      completed: true,
      missing: [],
    })
  })

  it('requires a real image delivery receipt and replaces contradictory capability denial', () => {
    const recovery = new AgentTurnRecovery(provider(''), () => config())
    const plan: AgentTaskPlan = {
      version: 1,
      summary: 'send image',
      research: 'local-first',
      allowedSideEffects: ['read', 'external'],
      stopCondition: 'delivered',
      createdBy: 'fallback',
      goals: [{
        id: 'send',
        description: 'send image',
        capabilities: ['karin.bot.send_message'],
        postconditions: [
          {
            id: 'media',
            kind: 'media',
            description: 'image ready',
            toolNames: ['karin.browser.download'],
            required: true,
          },
          {
            id: 'delivery',
            kind: 'delivery',
            description: 'image delivered',
            toolNames: ['karin.bot.send_message'],
            required: true,
            minimumCount: 1,
          },
        ],
      }],
    }
    expect(recovery.verify(plan, [], '我没有发送图片的工具').completed).toBe(false)

    const results: AgentToolResultEnvelope[] = [
      {
        status: 'completed',
        data: { path: 'controlled/cat.png' },
        receipt: {
          toolName: 'karin.browser.download',
          status: 'completed',
          startedAt: 1,
          completedAt: 2,
          idempotent: true,
          media: { path: 'controlled/cat.png', mime: 'image/png', size: 1024 },
        },
        evidence: ['media:controlled/cat.png'],
      },
      {
        status: 'completed',
        data: { delivered: true },
        receipt: {
          toolName: 'karin.bot.send_message',
          status: 'completed',
          startedAt: 2,
          completedAt: 3,
          idempotent: false,
          delivery: {
            completed: true,
            channel: 'onebot',
            textSegments: 0,
            imageSegments: 1,
          },
        },
        evidence: ['delivery:onebot:completed'],
      },
    ]

    expect(recovery.verify(plan, results, '我没有发送图片的工具').completed).toBe(true)
    expect(recovery.finalContent(plan, results, '我没有发送图片的工具'))
      .toContain('投递回执验证')
  })

  it('accepts an informational answer that honestly reports a scoped capability limit', () => {
    const recovery = new AgentTurnRecovery(provider(''), () => config())
    const plan: AgentTaskPlan = {
      version: 1,
      summary: 'read logs',
      research: 'local-first',
      allowedSideEffects: ['read'],
      stopCondition: 'answer ready',
      createdBy: 'fallback',
      goals: [{
        id: 'logs',
        description: 'read logs',
        capabilities: ['karin.diagnostics.logs'],
        postconditions: [{
          id: 'answer',
          kind: 'information',
          description: 'return the inspected logs',
          toolNames: [],
          required: true,
        }],
      }],
    }

    expect(recovery.verify(
      plan,
      [],
      '日志内容已经检索完成；当前没有本地截图能力，但下面的日志文本可用。'
    )).toMatchObject({
      completed: true,
      missing: [],
    })
  })

  it('creates an evidence-only user failure without leaking internal candidates', () => {
    const recovery = new AgentTurnRecovery(provider(''), () => config())
    const verification = {
      completed: false,
      missing: [{
        id: 'media',
        kind: 'media' as const,
        description: '取得至少一张经过校验的图片',
        toolNames: ['karin.browser.open'],
        required: true,
      }],
      classification: 'postcondition_failed' as const,
      message: '未通过：取得至少一张经过校验的图片',
    }
    const content = recovery.failureContent(verification, [{
      status: 'failed',
      errorCode: 'TOOL_UNSAFE_URL',
      error: 'TOOL_UNSAFE_URL: 浏览器只允许 HTTP 或 HTTPS URL',
      receipt: {
        toolName: 'karin.browser.open',
        status: 'failed',
        startedAt: 1,
        completedAt: 2,
        idempotent: true,
      },
      evidence: [],
    }])

    expect(content).toContain('任务未能完成')
    expect(content).toContain('取得至少一张经过校验的图片')
    expect(content).toContain('karin.browser.open')
    expect(content).not.toContain('修复候选')
    expect(content).not.toContain('已完成')
  })

  it('uses a deterministic visible verification contract without a planner model call', async () => {
    const model = provider('not json')
    const recovery = new AgentTurnRecovery(model, () => config(true))
    const result = await recovery.createPlan(
      input,
      tools,
      'fake',
      'fake',
      new AbortController().signal
    )

    expect(model.complete).not.toHaveBeenCalled()
    expect(result.plan.createdBy).toBe('fallback')
    expect(result.errors).toHaveLength(0)
  })
})
