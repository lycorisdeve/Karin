# Karin Domain Context

## Agent

Karin Agent 是 Core 内置的自然语言运行时。它只接收固定命令路由未匹配的消息，并通过结构化 Tool 调用能力。

## Fixed Command

Fixed Command 是现有正则命令。其匹配优先级、权限失败和异常行为具有兼容性要求，任何结果都不会回退到 Agent。

## Tool

Tool 是 Agent 可调用的结构化能力，包含稳定名称、JSON Schema、Karin 权限、风险、超时和执行函数。Tool 不伪造 Message，也不递归调用 Fixed Command。

## Thread and Turn

Thread 是持久化会话。私聊按用户隔离，群聊与频道按会话共享。Turn 是 Thread 内一次串行的 Agent 执行。

## Agent Task List

Agent Task List 是 Thread 内持久化、模型可见的执行清单。复杂请求必须先通过
`karin.agent.todo` 分解，列表顺序就是优先级，且同一列表最多一个 `in_progress`。
它取代独立规划模型生成、主模型不可见的隐藏计划。

## Capability Catalog

Capability Catalog 统一描述 Tool、Skill、Toolset、来源、版本、风险、可逆性、可用性和依赖。
核心编排能力始终可见，其他能力由 `karin.tool.search` 按需发现；Skill 正文通过
`karin.skill.list` 与 `karin.skill.view` 渐进加载。

## Approval

Approval 是高风险 Tool 的一次性授权。版本化声明式 Skill、用户作用域记忆、任务清单和
通过沙箱验证的纯计算 Tool 可以作为可信且可逆的本地写入自动放行；插件声明本身不能获得
这种信任。外部发送、安装、任意代码、权限或凭据变更、生产配置和删除仍必须询问或拒绝。

## Memory and Skill

Memory 是有来源和作用域的长期事实。Skill 是经过静态校验、带版本的声明式工作流；新版本只进入新 Thread 的技能快照。

## Generated Tool

Generated Tool 是独立于 Skill 的不可变版本化纯计算能力。它只运行在受限 Python Adapter 中，
不能读取文件、网络、环境变量或启动子进程。需要这些权限的能力只能形成待审批提案。

## Completion Guard

Completion Guard 在最终答复前检查任务状态、待审批和 Tool receipt。未完成任务、未恢复的必要
Tool 失败，或缺少写入/发送/媒体等真实回执时，Agent 不得宣称完成。

## Execution Budget

Execution Budget 是模型—Tool 循环的进展感知预算。它以任务状态、Tool 回执和结果证据是否新增
决定是否继续；连续无进展会提前停止，配置的 1–99 轮迭代上限仅作为防止无限循环的最终熔断器。

## Context Engine

Context Engine 按 Provider 上下文窗口和实际 Token 使用量管理模型输入。它保护最近消息、完整
Tool-call/result 对、活动任务和非幂等回执，并用不可变摘要版本保存压缩血缘。

## Run Journal

Run Journal 是 Turn 的持久执行记录，保存幂等请求键、检查点、租约和脱敏事件。重启只恢复
可安全重放的幂等操作；无法确认的非幂等副作用必须失败关闭并等待人工核对。

## Message Lifecycle

Message Lifecycle 在渠道 I/O 前保存投递意图，并区分 `sent`、`not_sent` 和
`unknown_after_send`。只有明确未发送的操作可以自动重试；渠道消息 ID 只证明平台接受，
不表示终端用户已读。

## Tool Result Artifact

Tool Result Artifact 是大 Tool 结果的内容寻址、脱敏持久副本。模型只接收有效 JSON 预览和
Artifact 引用，Completion Guard 使用独立结构化 receipt，不依赖截断文本。

## Provider Registry

Provider Registry 是所有模型调用的唯一解析入口。它选择主 Provider，按瞬时错误重试一次并按配置顺序 fallback，同时记录实际 Provider、模型、Token、重试原因和延迟。OpenAI、DeepSeek、Kimi、MiMo 与 Custom 都映射到 OpenAI-compatible Chat Completions 实现。

## Channel Registry

Channel Registry 管理 Core 第一方企业微信、飞书和 Telegram 多账号实现的启动、停止、探测、状态与热重载。OneBot 只接入统一状态展示，仍由原 OneBot 模块管理连接与热重载。
