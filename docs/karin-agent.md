# Karin Agent 架构与运维

Karin Agent 是 `node-karin` Core 内置模块，不更改 npm 包名、CLI 名称或已有固定命令。

## 路由顺序

1. Karin 先运行现有消息 Hook、上下文、过滤器和 Fixed Command。
2. Fixed Command 匹配成功、权限失败或抛出异常时，消息处理结束。
3. 只有命令全部未匹配时才触发 empty message Hook。
4. Agent 私聊自动触发；群聊、群临时会话和频道仅在 `@机器人` 或唤醒词前缀命中时触发。
5. 不满足 Agent 触发条件时调用 `next()`，继续其他 empty message Hook。

## 配置

首次启动会生成 `@karinjs/config/agent.json`。Agent 默认关闭。

必须配置：

```json
{
  "enabled": true,
  "provider": {
    "type": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "model": "your-model",
    "apiKeyEnv": "KARIN_AGENT_API_KEY",
    "timeout": 30000
  }
}
```

密钥只放在运行环境：

```powershell
$env:KARIN_AGENT_API_KEY = 'replace-me'
pnpm dev
```

Web 接口和日志只显示密钥是否存在，不返回密钥值。

## Tool

插件通过 `karin.tool()` 暴露结构化能力：

```ts
export const status = karin.tool({
  name: 'example.status',
  description: '读取示例状态',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
  },
  risk: 'read',
  idempotent: true,
  execute: async (_input, context) => ({
    actor: context.actor.id,
    ok: true,
  }),
})
```

插件不得使用 `karin.*` 保留命名空间。重复名称、非法名称和非法 Schema 会在加载阶段拒绝。

策略计算顺序为 Karin 角色权限、硬拒绝、精确规则、通配规则、风险默认值。默认：

- `read`：允许。
- `write`、`external`：询问。
- `destructive`：拒绝。

审批命令：

```text
/同意
/始终同意
/拒绝
```

`/同意` 只允许当前调用；`/始终同意` 在当前会话内持续允许同一 Tool；
`/拒绝` 拒绝当前调用。旧的带审批 ID 命令继续兼容，但不再作为默认交互展示。

会话模型命令：

```text
/model
/model <序号>
/model <providerId> <model>
/model reset
```

`/model` 显示当前会话实际使用的 Provider、模型和可选模型；切换只影响当前会话，
并从下一回合开始生效。子 Agent 继承父会话的选择，自动任务仍使用全局路由。
会话模型不可用时继续按全局主模型和 Fallback 路由执行。群聊和频道中的模型切换
沿用 `/new`、`/stop` 的会话管理权限，私聊用户可以管理自己的会话。

## 数据

Agent 数据库位于 `@karinjs/data/db/agent/agent.db`，使用显式迁移和 WAL。运行中的 Turn 在重启后标记为 interrupted，待审批记录标记为 expired。

声明式技能副本位于 `@karinjs/data/agent/skills/`。技能不得包含脚本、依赖安装、密钥或权限绕过指令。

## MCP

只实现 MCP Client，支持 stdio 和 Streamable HTTP。MCP 默认关闭，配置中的 `${ENV_NAME}` 在连接时展开；敏感值不写入数据库。

所有 MCP Tool 映射为 `mcp.<server>.<tool>`，风险至少为 `external`，仍经过 Karin 权限、审批、Schema、超时和输出限制。

## Web 控制台

访问 `/web/agent`。控制台包含对话和 SSE 流、Thread/子 Agent、全文搜索、审批、记忆、技能版本、自动任务、MCP、配置和审计。

## 验证

```powershell
pnpm test
pnpm exec eslint "packages/**/*.ts"
pnpm build
```

Agent 默认关闭时，固定命令和其他 empty message Hook 的行为必须与改造前一致。
