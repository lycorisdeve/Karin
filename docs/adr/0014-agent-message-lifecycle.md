# ADR 0014：Agent 渠道投递采用持久 Message Lifecycle

- 状态：Accepted
- 日期：2026-08-03

## 决策

Agent 终态在渠道 I/O 前创建唯一投递意图。状态区分 `pending`、`dispatching`、`sent`、
`not_sent`、`unknown_after_send`、`failed` 和 `cancelled`。只有 `not_sent` 可以自动重试；
`unknown_after_send` 必须等待渠道协调或人工核对。

首批 Adapter 为 Agent 终态投递和 OneBot。旧 `sendMsg` Interface 保持兼容，思考和中断提示
不创建投递操作。渠道消息 ID 只表示平台接受，不表示终端用户已读。

OneBot 接受 Agent 消息后始终发送可撤回的“正在思考”文字提示；私聊原生输入状态仅作为附加
增强，不能替代文字反馈。终态、失败、中断或等待审批时统一撤回提示并关闭输入状态。

## 结果

网络超时和重启不会再盲目重复外部发送。其他渠道可以逐步接入同一 Seam，而无需把一致性逻辑
复制到每个 Adapter。
