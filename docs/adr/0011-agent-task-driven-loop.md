# ADR 0011：Agent 使用显式任务清单驱动执行

- 状态：Accepted
- 日期：2026-07-31

## 决策

多步骤、多个交付物或长时间请求由主 Agent 先用 `karin.agent.todo` 创建持久化 Task List。
不再为每个 Turn 调用独立模型生成主模型不可见的计划。Task List 进入 volatile prompt、
SSE 事件和只读 HTTP 接口。

最终回答前由 Completion Guard 同时检查未完成任务、失败操作、审批状态和真实 Tool receipt。
只读且幂等、相互独立的同批 Tool 可以并行；写入、外部副作用和交互 Tool 保持串行。

## 结果

执行状态可以跨 Turn 恢复和审计，模型与用户看到同一份计划。Fixed Command、Thread 串行队列、
渠道投递、插件 Tool 接口和原有恢复回执继续作为兼容边界。
