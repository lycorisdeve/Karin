# Karin Domain Context

## Agent

Karin Agent 是 Core 内置的自然语言运行时。它只接收固定命令路由未匹配的消息，并通过结构化 Tool 调用能力。

## Fixed Command

Fixed Command 是现有正则命令。其匹配优先级、权限失败和异常行为具有兼容性要求，任何结果都不会回退到 Agent。

## Tool

Tool 是 Agent 可调用的结构化能力，包含稳定名称、JSON Schema、Karin 权限、风险、超时和执行函数。Tool 不伪造 Message，也不递归调用 Fixed Command。

## Thread and Turn

Thread 是持久化会话。私聊按用户隔离，群聊与频道按会话共享。Turn 是 Thread 内一次串行的 Agent 执行。

## Approval

Approval 是 `write` 或 `external` Tool 的一次性授权。只有原始发起者或管理员能够处理，过期或重启后不可恢复执行。

## Memory and Skill

Memory 是有来源和作用域的长期事实。Skill 是经过静态校验、带版本的声明式工作流；新版本只进入新 Thread 的技能快照。

## Provider Registry

Provider Registry 是所有模型调用的唯一解析入口。它选择主 Provider，按瞬时错误重试一次并按配置顺序 fallback，同时记录实际 Provider、模型、Token、重试原因和延迟。OpenAI、DeepSeek、Kimi、MiMo 与 Custom 都映射到 OpenAI-compatible Chat Completions 实现。

## Channel Registry

Channel Registry 管理 Core 第一方企业微信、飞书和 Telegram 多账号实现的启动、停止、探测、状态与热重载。OneBot 只接入统一状态展示，仍由原 OneBot 模块管理连接与热重载。
