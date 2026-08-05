# ADR 0013：Context Engine 与持久 Run Journal

- 状态：Accepted
- 日期：2026-08-03

## 决策

模型输入按上下文窗口 Token 预算压缩，而不是只按消息数量裁剪。摘要为不可变版本并记录父摘要
和来源消息；完整 Tool-call/result、活动任务和已验证非幂等 receipt 不可拆分或丢弃。

Turn 同时是公开 Run。交互输入通过幂等键去重，终态消息、Turn 状态、Thread 状态和 terminal
event 原子提交。运行事件持久化且只保存脱敏元数据。重启时使用租约接管未完成 Turn；只有幂等、
`restartSafe` 的操作可以恢复，未知非幂等副作用失败关闭。

## 结果

`AgentRuntime` 保留为兼容 Adapter；Context Engine 和 Run Journal 形成更深的 Module，压缩、
恢复和事件一致性获得单一测试 Seam。
