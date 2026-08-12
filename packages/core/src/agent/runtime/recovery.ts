import type {
  AgentConfig,
  AgentFailureClassification,
  AgentModelProvider,
  AgentPostcondition,
  AgentRecoveryEvent,
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

const reportsVerificationFailure = (content: string) =>
  /任务未通过(?:实际结果验证|完成守卫)|已生成修复候选|(?:每次|总是|一直).{0,12}(?:报错|提示|出现)/i.test(content)

const explicitImageRetry = (content: string) =>
  /(?:重新|再|现在(?:就)?|继续).{0,12}(?:发|发送|投递|下载|生成|画|截图).{0,20}(?:图片|照片|相片|图像|截图|图)|(?:修好|修复).{0,12}(?:后|并).{0,12}(?:发|发送|生成).{0,20}(?:图片|照片|图)/i.test(content)

const imageIntent = (content: string) => {
  if (reportsVerificationFailure(content) && !explicitImageRetry(content)) return false
  return /图片|照片|相片|图像|截图|配图|传图|image|photo|picture/i.test(content)
}

const deliveryIntent = (content: string) =>
  /发送|发消息|通知|推送|告知|联系|给我|send|message|notify/i.test(content)

const researchIntent = (content: string) =>
  /搜索|查询|查找|最新|官方文档|官网|网页|浏览器|网址|链接|https?:\/\//i.test(content)

const isWebConversation = (input: AgentTurnInput) =>
  !input.automated &&
  (input.actor.origin?.channel === 'web' || input.actor.scene === 'web')

const fallbackPlan = (input: AgentTurnInput, tools: AvailableTool[]): AgentTaskPlan => {
  const content = input.content
  const available = new Set(tools.map(tool => tool.name))
  const wantsImage = imageIntent(content)
  const wantsDelivery = !isWebConversation(input) && (deliveryIntent(content) || wantsImage)
  const toolNames = [
    wantsImage && available.has('karin.browser.search') ? 'karin.browser.search' : '',
    wantsImage && available.has('karin.browser.open') ? 'karin.browser.open' : '',
    wantsImage && available.has('karin.browser.screenshot') ? 'karin.browser.screenshot' : '',
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
    _provider: AgentModelProvider,
    _getConfig: () => AgentConfig
  ) {
    if (!_provider || typeof _getConfig !== 'function') {
      throw new Error('Recovery 依赖未初始化')
    }
  }

  async createPlan (
    input: AgentTurnInput,
    tools: AvailableTool[],
    _providerId: string | undefined,
    _model: string,
    _signal: AbortSignal
  ): Promise<AgentPlanResult> {
    return { plan: fallbackPlan(input, tools), attempts: 0, errors: [] }
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
        return !completedResults.some(result =>
          Boolean(result.receipt.media?.path || result.receipt.media?.url) ||
          (result.receipt.delivery?.imageSegments || 0) >= (postcondition.minimumCount || 1)
        )
      }
      if (postcondition.kind === 'tool') return matching.length === 0
      return !assistantContent.trim()
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

  failureContent (
    verification: AgentVerificationResult,
    results: AgentToolResultEnvelope[]
  ) {
    const failures = results
      .filter(result => result.status === 'failed')
      .slice(-3)
      .map(result => {
        const error = String(result.error || result.errorCode || '执行失败')
          .split(/\r?\n/, 1)[0]
          .slice(0, 300)
        return `- ${result.receipt.toolName}: ${error}`
      })
    return [
      '任务未能完成。',
      `未满足：${verification.missing.map(item => item.description).join('；')}`,
      ...(failures.length ? ['最近失败：', ...failures] : []),
      '详细诊断已保存在 Agent 管理界面。',
    ].join('\n')
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
