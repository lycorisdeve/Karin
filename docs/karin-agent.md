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
  "version": 10,
  "enabled": true,
  "providers": [{
    "id": "openai",
    "name": "OpenAI",
    "kind": "openai",
    "protocol": "chat-completions",
    "enabled": true,
    "baseUrl": "https://api.openai.com/v1",
    "model": "your-model",
    "apiKey": "",
    "timeout": 30000
  }],
  "routing": { "primary": "openai", "fallback": [] },
  "context": {
    "defaultWindowTokens": 65536,
    "softLimitRatio": 0.5,
    "hardLimitRatio": 0.85,
    "protectedRecentMessages": 12,
    "summaryTargetTokens": 4096
  },
  "memory": {
    "retrieval": {
      "maxCandidates": 50,
      "maxItems": 8,
      "maxPromptTokens": 1200,
      "minScore": 0.25,
      "recencyHalfLifeDays": 30
    }
  },
  "execution": {
    "isolationMode": "compat",
    "minimumIsolation": "none",
    "hookTimeoutMs": 5000,
    "maxModelCalls": 40,
    "maxTurnDurationMs": 300000
  }
}
```

v9 配置会在读取时迁移到 v10。Provider 默认继续使用 `chat-completions`；需要 OpenAI
Responses 兼容协议时将 `protocol` 设为 `responses`。迁移保留现有 Provider、密钥和路由，
不会自动删除用户数据。

密钥只放在运行环境：

```powershell
$env:KARIN_AGENT_API_KEY = 'replace-me'
pnpm dev
```

API Key 通过 Web 的只写字段或本地忽略配置保存。Web 接口和日志只显示密钥是否存在，
不返回密钥值；MCP 凭据必须用 `${ENV_NAME}` 引用环境变量。

## 任务驱动执行

复杂请求先调用 `karin.agent.todo` 建立 Thread 持久化清单；无参数读取，`merge=false`
替换，`merge=true` 按任务 ID 更新或追加。简单问答不会为了形式创建任务。

Prompt 由 `HarnessKernel`、`AgentInstructionStore`、人物版本、`MemoryRetriever` 与
`AgentPromptAssembler` 分层组成，优先级固定为：

```text
Harness Kernel > AGENT.md 版本 > 人物预设版本 > Skill 索引与会话摘要
  > 长期记忆 > 当前任务与用户消息
```

`AGENT.md` 是全局工作章程；人物预设只定义身份、专业领域、语气、回答风格和默认语言；长期
记忆只保存特定用户/群组的事实、偏好与纠正。三者不重复，也都不能改变 Tool 权限、审批和
完成验证。`AGENT.md` 保存上限为 32 KiB，使用 UTF-8/LF、内容哈希、乐观锁和原子替换；外部
文件编辑会导入新版本，非法编码或超限文件不会覆盖最后有效版本。

新 Thread 锁定当时的 `AGENT.md` 和默认人物版本，已有 Thread 不会随全局编辑漂移；WebUI 可
手动升级。子 Agent 继承父 Thread 的两个版本，定时任务创建新 Thread 时解析所选人物的最新
有效版本。

模型上下文分为 stable、context 和 volatile 三层。stable 放 Kernel、工作章程、人物与 Thread
固定 Skill 索引，不预注入 Skill 全文；volatile 每轮加入相关记忆、当前任务清单、时间和恢复
信息。
Context Engine 在预计输入达到上下文窗口 50% 时预压缩、85% 时强制压缩。摘要采用不可变
版本并继承上一个摘要，最近消息、完整 Tool-call/result 对、活动任务和非幂等回执继续保留；
`maxRecentMessages` 只作为估算或摘要失败时的降级上限。

最终回答前由 Completion Guard 检查任务状态和 Tool receipt。仍有 pending/in_progress、
待审批、未满足的必要条件或行动缺少真实回执时，会要求模型继续执行，达到配置的纠正
次数后安全失败，而不是虚假宣称完成。

可选 Tool 失败和已经被替代能力满足的失败不会阻止信息任务结束；发送、媒体、写入等行动条件
仍只能由真实 receipt 满足。

Execution Budget 管理模型与 Tool 的循环。每轮比较任务状态、Tool 回执、错误和结果证据；
连续三轮没有新增证据时提前停止。`limits.maxToolRounds` 可配置为 1–99，默认 99，只承担防止
无限循环的最终熔断职责。`execution.maxModelCalls` 和 `execution.maxTurnDurationMs` 同时限制
整个 Turn 的模型调用次数和持续时间。诊断 Tool 的兼容计数仅作为额外安全熔断器。

模型 Provider 超时会在重试和 fallback 均失败后返回中文可操作提示，不再向用户暴露原生
`The operation was aborted due to timeout`。Tool 超时同样记录为包含 Tool 名称和毫秒数的失败回执。

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
Tool 可声明 `owner`、`sensitivity` 和 `restartSafe`，这些字段只用于策略解释、恢复和审计，
插件或 MCP 不能借此提升自己的信任级别。超过模型输出上限的结果保存为脱敏 Tool Result
Artifact，模型只收到有效 JSON 预览和 Artifact ID。

所有调用都经过 `AgentExecutionGateway`。隔离等级为 `core-inline`、`legacy-inline`、
`process-isolated`、`generated-sandbox`、`mcp-remote` 或 `mcp-stdio`。默认兼容模式允许旧插件的
`legacy-inline` 并在 WebUI 告警；严格模式拒绝。`karin.processTool()` 使用 JSON stdin/stdout、
环境变量白名单、受限 cwd、无 Shell 拼接、输出上限和进程树终止。进程隔离不等于安全沙箱；
Core 会探测 bwrap/Seatbelt，但当前未验证为硬隔离执行后端，因此配置要求 `os` 时失败关闭，
不会在 UI 中宣称为安全沙箱。

`karin.browser.search` 使用受控 HTTP/RSS 搜索，不依赖浏览器二进制。截图优先复用 Karin
Render Registry 中已有的 Puppeteer/Snapka 渲染器；没有可用渲染器或渲染失败时，再降级到
Agent 的交互式浏览器。动态页面和点击能力会依次尝试 Playwright Chromium、Windows/macOS
的系统 Edge/Chrome 和 Linux 的 Chromium/Chrome；特殊部署可通过
`KARIN_AGENT_BROWSER_EXECUTABLE` 指定浏览器绝对路径。

策略计算顺序为 Karin 角色权限、硬拒绝、精确规则、通配规则、风险默认值与可信可逆判定。默认：

- `read`：允许。
- `write`、`external`：询问。
- `destructive`：询问；自动任务中拒绝。

任务清单、用户作用域记忆、版本化声明式 Skill、通过静态校验和沙箱测试的纯计算 Tool，
以及这些对象的启停和回滚，可在 `autoApproveTrustedReversible=true` 时自动放行。只有 Core
受信编排入口可以获得该判定；插件和 MCP 不能仅凭 `reversible` 声明绕过审批。

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

会话人物命令：

```text
/persona
/persona <序号或ID>
/persona reset
```

人物切换只影响当前 Thread，不改变 Provider、Tool、权限或安全策略。

## 长期记忆 v2

记忆具有 `kind`、`memoryKey`、可信度、重要度、置顶、状态、内容哈希、来源、使用次数和过期
时间。召回先做 global/user/group 作用域隔离，再使用 SQLite FTS5 与词项匹配取候选；FTS5
不可用时自动退回词项检索。零相关且未置顶的记忆不会进入 Prompt，默认最多 8 条、约 1200
Token。

用户明确记住、纠正或管理员创建的记录具有较高可信度；相同 `memoryKey` 的明确纠正会把旧值
标记为 `superseded`。后台反思只能产生候选，不能覆盖用户或管理员记忆。Curator 合并完全重复
项和来源，归档到期或长期未召回的低重要度记录；置顶记录不自动归档，自动整理不物理删除。
召回候选、最终选择和 Turn 结果记录在统一日志中，便于后续评测或混合检索。

## 数据

Agent 数据库位于 `@karinjs/data/db/agent/agent.db`，使用显式迁移和 WAL。v14 增加指令版本、
人物及人物版本、记忆来源、Thread 版本锁和定时任务人物引用；v13 数据向前迁移，旧记忆按
`active/fact` 保留并补齐哈希与时间字段。v13 起 Turn、终态
消息和 terminal event 原子提交；运行中的 Turn 重启后先进入 `recovery_pending`。只读、幂等且
`restartSafe` 的未完成操作可由新 Turn 接管，无法确认的非幂等副作用不会自动重放。

Agent 最终答复通过 Message Lifecycle 投递。发送前先持久化意图；无消息 ID、连接超时或
断线后无法确认结果时记为 `unknown_after_send`，不会为了“重试成功”而重复发送。

声明式 Skill 副本位于 `@karinjs/data/agent/skills/`，每个不可变版本包含 `SKILL.md`，
以及可选的 `references/`、`templates/`、`scripts/` 支持文件。文件受路径、数量、大小、
凭据和危险指令校验；Skill 只引用 Tool 名，不拥有新 Tool 的可执行源码。

Generated Tool 独立保存在数据库中并有不可变版本。`karin.tool.manage` 只接受纯计算 Python
定义，经过 AST、导入白名单、Schema、超时和输出上限验证后运行；文件、网络、环境变量、
Shell、子进程和依赖安装能力只生成高风险提案。

## MCP

只实现 MCP Client，支持 stdio 和 Streamable HTTP。MCP 默认关闭，配置中的 `${ENV_NAME}` 在连接时展开；敏感值不写入数据库。

所有 MCP Tool 映射为 `mcp.<server>.<tool>`，风险至少为 `external`，仍经过 Karin 权限、审批、Schema、超时和输出限制。

## Web 控制台

访问 `/web/agent`。SSE 使用持久事件序号，页面重连或 Core 重启后可以继续回放。控制台包含
对话、当前任务清单、Thread/子 Agent、Skill/Tool
加载轨迹、审批理由、记忆、技能版本、Generated Tool、自我进化改进日志、自动任务、MCP、
配置和审计。

`/web/agent/customization` 提供“指令与人物”页面：Monaco 编辑与预览 `AGENT.md`、哈希冲突
提示、不可变版本恢复、人物 CRUD/版本历史/默认值及引用数量。对话页可选择人物、查看并升级
当前指令版本；定时任务可选择人物；记忆页展示类型、状态、来源、可信度、重要度、置顶、
过期和召回次数；Tool 与轨迹页展示实际执行来源和隔离等级。

“自我进化”页面是变更日志，只展示已经生效、已回滚或应用失败的改进及其来源 Turn；管理员可
删除单条或清空日志，操作需要二次确认并写入审计。候选评测、补丁 Diff、批准、应用和回滚
不在该页面提供操作入口。内部候选 ID 不进入聊天终态。

## 验证

```powershell
pnpm test
pnpm exec eslint "packages/**/*.ts"
pnpm build
```

Agent 默认关闭时，固定命令和其他 empty message Hook 的行为必须与改造前一致。
