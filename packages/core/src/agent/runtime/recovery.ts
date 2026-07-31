import type {
  AgentConfig,
  AgentFailureClassification,
  AgentModelProvider,
  AgentPostcondition,
  AgentRecoveryEvent,
  AgentTaskGoal,
  AgentTaskPlan,
  AgentToolResultEnvelope,
  AgentTurnInput,
} from '@/types/agent'

interface AvailableTool {
  name: string
  description: string
  risk: string
  tags: string[]
}

export interface AgentPlanResult {
  plan: AgentTaskPlan
  attempts: number
  errors: string[]
}

export interface AgentVerificationResult {
  completed: boolean
  missing: AgentPostcondition[]
  classification?: AgentFailureClassification
  message: string
}

const planSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'goals', 'research', 'allowedSideEffects', 'stopCondition'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    goals: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description', 'capabilities', 'postconditions'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          description: { type: 'string', minLength: 1, maxLength: 500 },
          capabilities: {
            type: 'array',
            maxItems: 16,
            items: { type: 'string', minLength: 1, maxLength: 100 },
          },
          postconditions: {
            type: 'array',
            maxItems: 16,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'kind', 'description', 'toolNames', 'required'],
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 64 },
                kind: { enum: ['delivery', 'media', 'tool', 'information'] },
                description: { type: 'string', minLength: 1, maxLength: 500 },
                toolNames: {
                  type: 'array',
                  maxItems: 16,
                  items: { type: 'string', minLength: 1, maxLength: 200 },
                },
                required: { type: 'boolean' },
                minimumCount: { type: 'integer', minimum: 1, maximum: 32 },
              },
            },
          },
        },
      },
    },
    research: { enum: ['local-first', 'web-required', 'none'] },
    allowedSideEffects: {
      type: 'array',
      uniqueItems: true,
      items: { enum: ['read', 'write', 'external', 'destructive'] },
    },
    stopCondition: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as Record<string, unknown>

const text = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value.trim() : fallback

const stringList = (value: unknown, limit: number) =>
  Array.isArray(value)
    ? [...new Set(value.map(item => text(item)).filter(Boolean))].slice(0, limit)
    : []

const parseJsonObject = (content: string) => {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = fenced || content
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('规划结果不是 JSON 对象')
  const value = JSON.parse(source.slice(start, end + 1))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('规划结果不是 JSON 对象')
  }
  return value as Record<string, unknown>
}

const normalizePlan = (
  value: Record<string, unknown>,
  tools: AvailableTool[],
  createdBy: AgentTaskPlan['createdBy']
): AgentTaskPlan => {
  const toolNames = new Set(tools.map(tool => tool.name))
  const goals = (Array.isArray(value.goals) ? value.goals : [])
    .slice(0, 8)
    .map((raw, index): AgentTaskGoal | null => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const item = raw as Record<string, unknown>
      const postconditions = (Array.isArray(item.postconditions) ? item.postconditions : [])
        .slice(0, 16)
        .map((rawPostcondition, postconditionIndex): AgentPostcondition | null => {
          if (
            !rawPostcondition ||
            typeof rawPostcondition !== 'object' ||
            Array.isArray(rawPostcondition)
          ) return null
          const postcondition = rawPostcondition as Record<string, unknown>
          const kind = postcondition.kind
          if (!['delivery', 'media', 'tool', 'information'].includes(String(kind))) return null
          return {
            id: text(postcondition.id, `goal-${index + 1}-check-${postconditionIndex + 1}`),
            kind: kind as AgentPostcondition['kind'],
            description: text(postcondition.description, '验证任务结果'),
            toolNames: stringList(postcondition.toolNames, 16)
              .filter(name => toolNames.has(name)),
            required: postcondition.required !== false,
            minimumCount: Number.isInteger(postcondition.minimumCount)
              ? Math.max(1, Math.min(Number(postcondition.minimumCount), 32))
              : undefined,
          }
        })
        .filter((item): item is AgentPostcondition => Boolean(item))
      return {
        id: text(item.id, `goal-${index + 1}`),
        description: text(item.description, '完成用户请求'),
        capabilities: stringList(item.capabilities, 16),
        postconditions: postconditions.length
          ? postconditions
          : [{
            id: `goal-${index + 1}-answer`,
            kind: 'information',
            description: '生成非空且与任务相关的结果',
            toolNames: [],
            required: true,
          }],
      }
    })
    .filter((item): item is AgentTaskGoal => Boolean(item))
  if (!goals.length) throw new Error('规划结果缺少目标')
  const research = value.research
  return {
    version: 1,
    summary: text(value.summary, goals[0].description).slice(0, 500),
    goals,
    research: research === 'web-required' || research === 'none'
      ? research
      : 'local-first',
    allowedSideEffects: stringList(value.allowedSideEffects, 4)
      .filter(item => ['read', 'write', 'external', 'destructive'].includes(item)) as
        AgentTaskPlan['allowedSideEffects'],
    stopCondition: text(value.stopCondition, '所有必需完成条件通过验证').slice(0, 500),
    createdBy,
  }
}

const imageIntent = (content: string) =>
  /图片|照片|相片|图像|截图|发(?:一|个|张|图|给|送)|传图|image|photo|picture/i.test(content)

const deliveryIntent = (content: string) =>
  /发送|发消息|通知|推送|告知|联系|给我|send|message|notify/i.test(content)

const researchIntent = (content: string) =>
  /搜索|查询|查找|最新|官方文档|官网|网页|浏览器|网址|链接|https?:\/\//i.test(content)

const isWebConversation = (input: AgentTurnInput) =>
  !input.automated &&
  (input.actor.origin?.channel === 'web' || input.actor.scene === 'web')

const adaptPlanToConversation = (
  plan: AgentTaskPlan,
  input: AgentTurnInput,
  tools: AvailableTool[]
): AgentTaskPlan => {
  if (!isWebConversation(input)) return plan
  const available = new Set(tools.map(tool => tool.name))
  const wantsImage = imageIntent(input.content)
  return {
    ...plan,
    goals: plan.goals.map(goal => {
      const postconditions = goal.postconditions
        .filter(item => item.kind !== 'delivery')
        .map(item => ({
          ...item,
          toolNames: item.toolNames.filter(name => name !== 'karin.bot.send_message'),
        }))
      if (
        wantsImage &&
        !postconditions.some(item => item.kind === 'media')
      ) {
        postconditions.push({
          id: `${goal.id}-media`,
          kind: 'media',
          description: '取得至少一张经过校验并可在 Web 会话展示的图片',
          toolNames: ['karin.browser.download', 'karin.browser.screenshot']
            .filter(name => available.has(name)),
          required: true,
          minimumCount: 1,
        })
      }
      if (!postconditions.length) {
        postconditions.push({
          id: `${goal.id}-answer`,
          kind: 'information',
          description: '在当前 Web 会话生成非空结果',
          toolNames: [],
          required: true,
        })
      }
      return {
        ...goal,
        capabilities: goal.capabilities.filter(name => name !== 'karin.bot.send_message'),
        postconditions,
      }
    }),
  }
}

const fallbackPlan = (input: AgentTurnInput, tools: AvailableTool[]): AgentTaskPlan => {
  const content = input.content
  const available = new Set(tools.map(tool => tool.name))
  const wantsImage = imageIntent(content)
  const wantsDelivery = !isWebConversation(input) && (deliveryIntent(content) || wantsImage)
  const toolNames = [
    wantsImage && available.has('karin.browser.search') ? 'karin.browser.search' : '',
    wantsImage && available.has('karin.browser.open') ? 'karin.browser.open' : '',
    wantsImage && available.has('karin.browser.download') ? 'karin.browser.download' : '',
    wantsDelivery && available.has('karin.bot.send_message') ? 'karin.bot.send_message' : '',
  ].filter(Boolean)
  const postconditions: AgentPostcondition[] = []
  if (wantsImage) {
    postconditions.push({
      id: 'media-ready',
      kind: 'media',
      description: '取得至少一张经过校验的图片',
      toolNames: toolNames.filter(name => name.startsWith('karin.browser.')),
      required: true,
      minimumCount: 1,
    })
  }
  if (wantsDelivery) {
    postconditions.push({
      id: 'delivery-completed',
      kind: 'delivery',
      description: wantsImage ? '向当前会话成功投递至少一张图片' : '消息成功投递',
      toolNames: available.has('karin.bot.send_message') ? ['karin.bot.send_message'] : [],
      required: true,
      minimumCount: wantsImage ? 1 : undefined,
    })
  }
  if (!postconditions.length) {
    postconditions.push({
      id: 'answer-ready',
      kind: 'information',
      description: '生成非空且不虚构 Tool 执行结果的答复',
      toolNames: [],
      required: true,
    })
  }
  return {
    version: 1,
    summary: content.slice(0, 300) || '完成用户请求',
    goals: [{
      id: 'primary',
      description: content.slice(0, 500) || '完成用户请求',
      capabilities: toolNames,
      postconditions,
    }],
    research: researchIntent(content) ? 'local-first' : 'none',
    allowedSideEffects: wantsDelivery ? ['read', 'external'] : ['read'],
    stopCondition: '所有必需完成条件通过验证，或达到恢复预算后如实报告失败',
    createdBy: 'fallback',
  }
}

const capabilityDenial = (content: string) =>
  /(?:没有|无法|不具备|不能).{0,18}(?:工具|能力|发送|图片|访问|读取)|能力所限/i.test(content)

export class AgentTurnRecovery {
  constructor (
    private readonly provider: AgentModelProvider,
    private readonly getConfig: () => AgentConfig
  ) {}

  async createPlan (
    input: AgentTurnInput,
    tools: AvailableTool[],
    providerId: string | undefined,
    model: string,
    signal: AbortSignal
  ): Promise<AgentPlanResult> {
    const config = this.getConfig().recovery
    const profile = this.getConfig().providers.find(item =>
      item.id === (providerId || this.getConfig().routing.primary)
    )
    if (!config.enabled || input.automated || (input.depth || 0) > 0) {
      return { plan: fallbackPlan(input, tools), attempts: 0, errors: [] }
    }
    if (!profile?.verification?.chat || !profile.verification.tools) {
      return {
        plan: fallbackPlan(input, tools),
        attempts: 0,
        errors: ['Provider 尚未验证结构化规划能力，已使用保守计划'],
      }
    }

    const prompt = [
      '为 Karin Agent 生成可验证的任务计划，只输出 JSON。',
      '不要执行任务，不要写解释，不要输出思维链。',
      '行动类目标必须使用 delivery/media/tool 完成条件，不能用 information 代替。',
      'toolNames 只能从给定 Tool 名称中选择。',
      `用户请求：${input.content}`,
      `渠道：${input.actor.origin?.channel || input.actor.scene || 'unknown'}`,
      `可用 Tool：${tools.map(tool => `${tool.name}(${tool.risk})`).join(', ') || '无'}`,
    ].join('\n')
    const errors: string[] = []
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await this.provider.complete({
          providerId,
          model,
          messages: [
            {
              role: 'system',
              content: '你是任务规划器。输出必须满足给定 JSON Schema。',
            },
            { role: 'user', content: prompt },
          ],
          tools: [],
          responseSchema: attempt === 1
            ? { name: 'karin_agent_task_plan', schema: planSchema, strict: true }
            : undefined,
          signal,
        })
        return {
          plan: adaptPlanToConversation(
            normalizePlan(parseJsonObject(response.content), tools, 'model'),
            input,
            tools
          ),
          attempts: attempt,
          errors,
        }
      } catch (error) {
        errors.push((error as Error).message.slice(0, 500))
      }
    }
    return {
      plan: fallbackPlan(input, tools),
      attempts: 2,
      errors,
    }
  }

  verify (
    plan: AgentTaskPlan,
    results: AgentToolResultEnvelope[],
    assistantContent: string
  ): AgentVerificationResult {
    const required = plan.goals.flatMap(goal =>
      goal.postconditions.filter(postcondition => postcondition.required)
    )
    const completedResults = results.filter(result => result.status === 'completed')
    const missing = required.filter(postcondition => {
      const matching = completedResults.filter(result =>
        !postcondition.toolNames.length ||
        postcondition.toolNames.includes(result.receipt.toolName)
      )
      if (postcondition.kind === 'delivery') {
        return !matching.some(result =>
          result.receipt.delivery?.completed &&
          (
            !postcondition.minimumCount ||
            (result.receipt.delivery.imageSegments || 0) >= postcondition.minimumCount
          )
        )
      }
      if (postcondition.kind === 'media') {
        return !matching.some(result =>
          Boolean(result.receipt.media?.path || result.receipt.media?.url) ||
          (result.receipt.delivery?.imageSegments || 0) >= (postcondition.minimumCount || 1)
        )
      }
      if (postcondition.kind === 'tool') return matching.length === 0
      return !assistantContent.trim() || capabilityDenial(assistantContent)
    })

    if (!missing.length) {
      return {
        completed: true,
        missing: [],
        message: '所有必需完成条件均已通过',
      }
    }
    const failed = results.find(result => result.status === 'failed')
    const deliveryMissing = missing.some(item => item.kind === 'delivery')
    return {
      completed: false,
      missing,
      classification: deliveryMissing
        ? 'delivery_failed'
        : failed
          ? 'tool_failed'
          : 'postcondition_failed',
      message: `未通过：${missing.map(item => item.description).join('；')}`,
    }
  }

  recoveryQuery (
    input: AgentTurnInput,
    verification: AgentVerificationResult,
    results: AgentToolResultEnvelope[]
  ) {
    const failures = results
      .filter(result => result.status === 'failed')
      .slice(-3)
      .map(result => `${result.receipt.toolName}: ${result.errorCode || result.error || '失败'}`)
    return [
      input.content,
      `恢复目标：${verification.missing.map(item => item.description).join('；')}`,
      failures.length ? `最近错误：${failures.join('；')}` : '',
      '请重新检查可用 Tool，先诊断真实原因，再完成缺失的验证条件。不要重复已成功的副作用。',
    ].filter(Boolean).join('\n')
  }

  finalContent (
    plan: AgentTaskPlan,
    results: AgentToolResultEnvelope[],
    content: string
  ) {
    const hasVerifiedAction = plan.goals.some(goal =>
      goal.postconditions.some(item =>
        item.required && ['delivery', 'media', 'tool'].includes(item.kind)
      )
    ) && results.some(result =>
      result.status === 'completed' &&
      (
        result.receipt.delivery?.completed ||
        result.receipt.media ||
        result.receipt.toolName === 'karin.system.restart'
      )
    )
    if (hasVerifiedAction && capabilityDenial(content)) {
      const delivery = results.find(result => result.receipt.delivery?.completed)
      if (delivery?.receipt.delivery?.imageSegments) {
        return `图片已发送，并已通过渠道投递回执验证（${delivery.receipt.delivery.imageSegments} 张）。`
      }
      if (results.some(result => result.status === 'completed' && result.receipt.media)) {
        return '图片已准备好，并已作为本条回复的附件展示。'
      }
      return '任务已完成，并已通过实际 Tool 回执验证。'
    }
    return content
  }

  event (
    phase: AgentRecoveryEvent['phase'],
    cycle: number,
    message: string,
    detail: Partial<AgentRecoveryEvent> = {}
  ): AgentRecoveryEvent {
    return {
      phase,
      cycle,
      message,
      createdAt: Date.now(),
      ...detail,
    }
  }
}
