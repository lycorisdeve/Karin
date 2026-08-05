# ADR 0012：能力发现与可信可逆自动审批

- 状态：Accepted
- 日期：2026-07-31

## 决策

Capability Catalog 统一描述 Tool 和 Skill。Thread 只固定 Skill 索引与版本，正文和支持文件
通过 `karin.skill.list/view` 渐进加载。缺能力时固定按“现有 Skill → Tool/MCP → 声明式
Skill → 纯计算 Generated Tool → 高风险提案”处理。

自动审批要求同时满足：Core 受信入口、本地作用域、声明式或受限沙箱、版本化可回滚、风险不高于
`write`，且没有命中用户 policy rule。插件和 MCP 的自我声明不构成信任。

删除、外部发送、公开发布、安装依赖/插件、任意代码、凭据/权限、生产配置和源码补丁应用不能
无人值守执行。所有自动放行、拒绝、晋升和回滚写入审计。

## 结果

Skill 与 Generated Tool 生命周期分离。旧 Skill/Script Tool API 作为兼容 Adapter 保留，
v11 迁移复制旧 Script Tool 为 Generated Tool 版本，并保留 `skill.skill_*` Alias 和旧字段，
从而允许旧 Core 回退读取。
