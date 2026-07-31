# Karin 项目维护指南

## 项目概述

- 项目名称：Karin
- 项目用途：基于 Node.js 的插件化机器人/自动化应用框架，包含核心运行时、Web 管理界面、命令行工具、项目脚手架和 OneBot 适配实现。
- 仓库形态：pnpm workspace monorepo。
- 许可证：MIT。

## 技术栈与运行环境

- 语言：TypeScript、JavaScript，ES Module。
- 后端/运行时：Node.js、Express、WebSocket、Redis、SQLite。
- 前端：React 19、Vite 8、HeroUI、Tailwind CSS、React Router。
- 构建：TypeScript、tsdown、Vite。
- 质量工具：ESLint（neostandard）、Prettier、Vitest、Husky。
- 包管理器：pnpm；锁文件格式为 pnpm lockfile v9。
- Node.js：各主要 Node 包声明 `>=20`，发布工作流使用 Node 20。
- pnpm：CI 固定 pnpm 9。根 `package.json` 暂未声明 `packageManager`，本地维护优先使用 pnpm 9，避免不同主版本产生安装行为差异。

## 目录说明

- `packages/core/`：`node-karin` 核心运行时。负责进程启动、配置初始化、HTTP/WebSocket 服务、插件与适配器加载、任务系统、日志及数据访问。
- `packages/web/`：React Web 管理界面；生产构建输出到 `packages/core/dist/web/`。
- `packages/cli-Internal/`：核心 CLI 的 TypeScript 实现，构建时同时写入自身 `dist/` 和 `packages/core/dist/cli/`。
- `packages/cli/`：已发布 CLI 的轻量转发入口，调用当前项目安装的 `node-karin` CLI。
- `packages/create-karin/`：交互式项目/插件脚手架。
- `packages/onebot/`：OneBot API、事件、消息、HTTP 与 WebSocket 实现。
- `packages/types/`：独立发布的类型声明包。
- `packages/pm2/`、`packages/test/`：示例/运行环境包。
- `tests/agent/`：Karin Agent、Provider、策略、持久化、固定命令兼容性和 Fake Channel 自动化测试。
- `packages/karin-plugin-js/`、`packages/karin-plugin-ts/`：插件模板，已由 `pnpm-workspace.yaml` 排除，不参与根 workspace 命令。
- `scripts/`：仓库维护脚本。
- `.github/workflows/`：发布、临时包、依赖审查和 Issue 自动化。
- 构建产物：各包的 `dist/`，以及 `packages/core/dist/web/`；这些目录已被 Git 忽略。
- 测试目录：`tests/agent/`，由根目录 Vitest 配置执行。

## 主要入口与数据流

- 核心父进程入口：`packages/core/src/start/index.ts`。
- 核心应用入口：`packages/core/src/start/app.ts` → `packages/core/src/index.ts` 的 `start()`。
- 启动顺序：加载环境变量 → 初始化配置与日志 → 初始化进程 → 启动 Express/任务系统 → 初始化 Redis 与 SQLite → 初始化终端、插件、适配器和渲染服务。
- HTTP API：Express 路由统一挂载在 `/api/v1`，路由注册位于 `packages/core/src/server/router/`。
- Web UI：`packages/web/src/main.tsx`，通过 `packages/web/src/lib/request.ts` 的 Axios 实例访问 `/api/v1`，并处理 JWT 刷新。
- 数据访问：
  - Redis 可连接外部服务；连接失败或关闭时降级到 SQLite 持久化的 Redis mock。
  - 通用 KV 数据保存在 SQLite `kv.db`。
  - 后台任务由独立 SQLite 数据库保存。
- 插件/适配器通过事件、服务层和动态加载与核心运行时交互。

## 安装、启动、测试与构建

```powershell
# 严格按锁文件安装；不要无故改写 pnpm-lock.yaml
pnpm install --frozen-lockfile

# 核心开发模式
pnpm dev

# Web UI 开发模式（需要核心 API 时同时运行 pnpm dev）
pnpm dev:web

# 构建全部 workspace 包
pnpm build

# 构建后以前台模式启动核心
pnpm app

# 运行测试；当前会因没有测试文件而失败
pnpm test

# 非修复型 TypeScript ESLint 检查
pnpm exec eslint "packages/**/*.ts"
```

注意：

- 根脚本 `pnpm lint:fix` 会直接修改文件，不应用作只读检查。
- `packages/web` 当前的 `lint` 脚本引用不存在的 `.eslintrc.json`，修复配置前不能作为有效检查命令。
- 不要为完成普通开发任务执行发布、同步 registry、全局安装或依赖升级命令。

## 环境变量与配置

- Core 从当前工作目录下的 `.env` 读取配置；开发脚本通过 `EBV_FILE=development.env` 切换文件。
- 主要变量包括：`HTTP_ENABLE`、`HTTP_PORT`、`HTTP_HOST`、`HTTP_AUTH_KEY`、`WS_SERVER_AUTH_KEY`、`REDIS_ENABLE`、`PM2_RESTART`、日志配置及 FFmpeg 路径。
- Karin Agent 默认关闭；多 Provider 与 API Key 直接保存在 Git 忽略的
  `@karinjs/config/agent.json`。Web API、日志、错误和审计不得回显 API Key。
- OneBot 现有 WS Server、WS Client 与 HTTP 配置保持不变；企业微信、飞书和 Telegram
  多账号配置追加在 `@karinjs/config/adapter.json`，其 Secret/Token 采用只写语义。
- MCP 认证信息必须通过 `${ENV_NAME}` 引用环境变量，不得把真实凭证写入 Agent 配置。
- 默认配置模板位于 `packages/core/default/config/`，运行期配置由 Core 初始化到项目配置目录。
- 不要在日志、Issue、提交信息或报告中输出真实密钥、JWT、Cookie、代理认证信息或完整 `.env` 内容。
- 仓库内环境文件包含示例值；部署前必须替换弱密钥，并根据暴露范围确认监听地址和 WebSocket 鉴权。

## 编码规范

- 遵循 `.editorconfig`：UTF-8、LF、2 空格缩进、文件末尾换行、清除行尾空格。
- 遵循 `.prettierrc`：单引号、无分号、100 字符打印宽度、必要时尾随逗号。
- TypeScript 使用严格模式；避免 `any`、未使用变量/参数和不一致的文件名大小写。
- 匹配现有模块边界、命名和导入别名；协议规定的 snake_case 字段可以保留，但应在最小范围配置 lint 例外。
- 公共导出、路由格式、配置结构和持久化格式属于兼容性接口，未经明确要求不要修改。
- Fixed Command 必须始终优先于 Agent；不得通过伪造 Message 从 Tool 递归调用命令处理器。

## 修改约束

- 修改前明确目标、影响范围、兼容性和成功标准。
- 优先最小改动，不为一次性需求增加抽象层，不顺手重构无关代码。
- 不删除或降低测试/校验标准，不通过绕过类型检查来使构建通过。
- 不随意升级依赖，不修改锁文件；依赖变更需要单独说明理由和影响。
- 不修改生成产物；修改源文件后重新构建生成。
- 数据迁移、权限/鉴权、生产配置、公共接口、依赖安装、删除文件和发布操作必须先取得明确授权。

## 安全要求

- 禁止提交真实密码、Token、JWT、Cookie、私钥、registry 凭据或第三方服务密钥。
- 禁止记录请求体中的认证数据；日志必须对 Authorization、Token 和用户隐私信息脱敏。
- 新增 HTTP/WebSocket 路由时默认要求鉴权，并检查路径穿越、命令注入、任意文件读写和 SSRF。
- 调用 shell、Git、npm/pnpm、PM2 或插件安装逻辑时，禁止直接拼接不可信输入。
- 外部 URL、插件包名、文件路径和配置内容都视为不可信输入，需要校验和限定范围。
- 修改 GitHub Actions 时使用最小权限；`pull_request_target` 不得执行或安装不受信任的 PR 代码。

## 完成任务前的验证

1. 检查 `git diff`，确保只改动任务范围内文件且没有敏感信息。
2. 对受影响包执行 TypeScript/ESLint 检查；不得使用自动修复掩盖无关问题。
3. 执行相关测试；若缺少测试，应补充最小回归测试或明确说明未覆盖原因。
4. 执行受影响包构建；跨包或发布相关改动执行根目录 `pnpm build`。
5. 涉及配置、鉴权、数据库、进程管理或部署时，额外验证失败路径、回滚方式和兼容性。
6. 报告所有失败项，区分本次引入与仓库既有问题，不得声称未执行的检查已通过。
