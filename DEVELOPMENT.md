# 开发指南

本文面向源码开发与维护，包含环境搭建、架构、验证和发布规范。应用下载与使用见 [README](README.md) 和[用户指南](USER_GUIDE.md)。

## 环境搭建

### 依赖

- Node.js 24（与 CI 保持一致）。
- pnpm 8.15.9（与根目录 `packageManager` 一致）。
- Python 3.11+（开发内置 Agent、文档处理或生成安装包时需要）。
- JDK 17 与 MariaDB 仅用于可选的云同步后端，不是桌面端开发的必备依赖。

### 初始化 JavaScript 工作区

在仓库根目录执行：

```bash
pnpm install
pnpm run setup
```

`setup` 生成 Prisma Client、首启建库 SQL，并编译 `packages/core`。首次检出或更新数据库模型后，应先完成这一步。

### 初始化 Python Runtime

Windows PowerShell：

```powershell
cd agent_runtime
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev,build]"
cd ..
```

macOS / Linux：

```bash
cd agent_runtime
python3 -m venv .venv
./.venv/bin/python -m pip install -e '.[dev,build]'
cd ..
```

需要复现 CI 的锁定环境时，可使用工作流中的 uv 版本（当前为 0.11.32），在仓库根目录执行 `uv sync --frozen --project agent_runtime --extra dev --extra build`。

### 启动桌面端

```bash
pnpm dev:desktop
```

`pnpm dev` 同样启动桌面开发任务。Electron 会自动发现 `agent_runtime/.venv` 并启动 Runtime，无需另外常驻 Python 服务。

启动命令会检查 Prisma Client，必要时重新生成，再生成首启建库 SQL、编译 Core 并启动 Vite/Electron。`dev:local` 与 `dev:8080` 同样先执行准备步骤；现有客户端与 schema、SDK 和引擎一致时复用，减少 Windows 已加载引擎 DLL 的替换冲突。

## 常用命令与验证

在仓库根目录执行：

| 命令 | 用途 |
| --- | --- |
| `pnpm run setup` / `pnpm build:core` | 生成 Prisma Client、建库 SQL 并编译 Core |
| `pnpm dev:desktop` | 启动 Electron 桌面端 |
| `pnpm db:push` | 同步开发数据库结构 |
| `pnpm build:desktop` | 构建桌面端 |
| `pnpm build:desktop:win` | 构建 Windows 安装版与便携版 |
| `pnpm build:desktop:mac` | 在 macOS 构建当前机器架构的 DMG |
| `pnpm mcp:config` | 输出开发环境 stdio 兼容配置 |
| `pnpm --filter novel-editor-desktop run typecheck` | 检查应用与 Vite Node 配置的类型 |
| `pnpm --filter novel-editor-desktop run test:agent-recovery` | 验证 Agent 合约与恢复行为 |

Windows PowerShell 下的 Python 测试：

```powershell
.\agent_runtime\.venv\Scripts\python.exe -m pytest -q agent_runtime
```

macOS / Linux 使用 `./agent_runtime/.venv/bin/python`。验证 Renderer、Electron Main 与 Preload 构建可执行 `pnpm --dir apps/desktop exec vite build`，此前须已生成 Core 与 Prisma Client。CI 和发布回归所需的完整检查以 [CI 工作流](.github/workflows/ci.yml)与[发布工作流](.github/workflows/release.yml)为准。

## 架构与目录

```text
React Renderer
  ├─ 写作模式
  └─ AgentWorkspace
          │ IPC / SSE
Electron Main
  ├─ Prisma + SQLite
  ├─ AiService / ContextBuilder
  ├─ AutomationService / DraftSessionStore
  ├─ PythonRuntimeClient
  └─ MCP bridge
          │ FastAPI / FastMCP
Python Agent Runtime
  ├─ IntentService / Planner
  ├─ LangGraph + SQLite Checkpointer
  ├─ 领域 Toolchains
  └─ Retry / Recovery / Event Stream
```

- `apps/desktop`：Electron、React、AI 服务、Agent UI 和 Automation API。
- `agent_runtime`：Python、FastAPI、LangGraph、IntentService 与领域 Toolchain。
- `packages/core`：Prisma schema、生成客户端和共享数据层。
- `apps/backend`：可选的 Spring Boot + MariaDB 云同步后端。
- `docs/agent`：Agent 产品方向、架构、决策、需求和验收文档。

Electron Main 是数据库、AI 设置、工具权限和草稿写回的业务边界，Python Runtime 通过桌面业务服务操作作品，不直接访问 Prisma 小说业务库。Agent 的运行事件、审批、报告与会话保存在本地 SQLite；上下文组装、压缩摘要、来源诊断和检索回退的具体约束见实现与 Agent 文档，不应在产品首页列成实现清单。

## 设计与维护资料

- [Agent 设计文档](docs/agent/README.md) · [路线图](docs/agent/roadmap.md)
- [手动验收清单](docs/agent/manual-acceptance-checklist.md)
- [备份与恢复设计](BackupDesign.md) · [小说导出需求与设计](docs/novel-export-requirements.md)
- [Python Runtime](agent_runtime/README.md) · [云同步后端](apps/backend/README.md)
- [MCP 接入说明](docs/mcp-cli-setup.md)

发布前确认目标标签、检查结果和待发布提交。发布工作流从标签同步包版本并构建安装包，包清单中的开发版本号不等同于线上最新版本；对外版本与支持平台以 Releases 为准。维护规范如下。

## 1. 基本原则
- 架构：Electron + React + TypeScript（ESM）。
- 包管理器基线：`pnpm 8.15.9`。
- i18n：用户可见文案必须走国际化键，不直接硬编码。
- 分层：`packages/core` 保持纯逻辑/数据层，不引入 UI 依赖。

## 2. 数据库与模型变更流程
开发阶段修改 `packages/core/prisma/schema.prisma` 后，不再手工依赖运行时 `@prisma/client` 目录结构。当前流程是：

```bash
pnpm --filter @novel-editor/core run build
```

该命令会同时完成：
- Prisma Client 生成到 `packages/core/generated/client`
- 生成首启建库 SQL：`packages/core/generated/client/schema-init.sql`
- TypeScript 编译到 `packages/core/dist`

说明：
- Desktop 的 `dev` / `build` 等命令会显式执行 `prepare:core`，正常情况下无需额外手工运行；不要依赖 pnpm 自动调用 `predev` / `prebuild`。
- 开发环境需要同步本地数据库结构时，仍可使用 `pnpm db:push`，但打包版不依赖运行时 `prisma db push`。
- 打包版首次启动发现数据库缺表时，会执行内置的 `schema-init.sql` 自动建表。
- 仓库初始化命令使用 `pnpm run setup`，不要使用 `pnpm setup`（后者会命中 pnpm 自带命令）。

## 3. Electron IPC 约定
- Main：`ipcMain.handle('namespace:action')`
- Preload：`contextBridge.exposeInMainWorld`
- Renderer：仅通过 `window.xxx` 调用，不直连 Node API

## 4. 调试方式
- 前端问题：Electron DevTools Console。
- 主进程问题：`pnpm dev` 终端输出。
- 类型问题：`pnpm --filter novel-editor-desktop run typecheck`。

### 开发模式 Debug 日志
开发模式会额外写本地调试日志：

- 文件位置：Electron `userData/debug-dev.log`
- 生效范围：仅开发模式（不在打包用户环境启用）
- 文件策略：单文件上限 `15MB`，超出后直接覆盖重写

记录内容：
- 主进程错误：`console.error` / `console.warn` / `uncaughtException` / `unhandledRejection`
- AI 请求链路：HTTP Provider / MCP CLI Provider 的请求体、响应体、状态码、耗时、异常
- AI 业务入口摘要：标题生成、续写、AI 工坊、地图生成、提示词预览、确认入库

脱敏规则：
- 自动脱敏 `Authorization` / `apiKey` / `token` / `access_token` / `refresh_token`
- Prompt 和模型返回正文在开发模式下允许记录

### Desktop Dev Server 可选启动配置
默认开发命令不变：

```bash
pnpm --filter novel-editor-desktop run dev
```

如需固定到本机 `localhost:8080` 供 Cloudflare Tunnel 转发，使用：

```bash
pnpm --filter novel-editor-desktop run dev:8080
```

说明：
- `dev`：保持默认端口（当前由 Vite 默认或环境变量决定）。
- `dev:8080`：固定绑定 `127.0.0.1:8080`，仅本机监听，不直接对外暴露。
- `dev:local`：固定绑定 `127.0.0.1`，端口仍走默认值。

也可手动通过环境变量覆盖：

```bash
VITE_DEV_HOST=127.0.0.1
VITE_DEV_PORT=8080
pnpm --filter novel-editor-desktop run dev
```

## 5. Dev Diagnostics（Terminal Only）
开发诊断不在用户界面暴露，只通过终端命令执行。

```bash
pnpm --filter novel-editor-desktop run ai:diag -- smoke mcp
pnpm --filter novel-editor-desktop run ai:diag -- smoke skill --json
pnpm --filter novel-editor-desktop run ai:diag -- coverage
```

可选参数：
- `--json`: JSON 输出
- `--db <path>`: 指定 SQLite 文件
- `--user-data <path>`: 按 `<path>/novel_editor.db` 推导数据库

退出码：
- `0`: 成功
- `1`: 运行失败
- `2`: 参数错误

## 6. 打包与发布注意事项
- 诊断脚本放在 `apps/desktop/scripts`，不作为用户可见功能入口。
- 打包前确认 `packages/core` 已可用，避免 Prisma Client 缺失。
- 平台化打包命令：
  - Windows：`pnpm --filter novel-editor-desktop run build:win`
  - macOS DMG（当前机器架构）：`pnpm --filter novel-editor-desktop run build:mac`
- Windows 图标链路：
  - `build:win` 会先生成 `release/win-unpacked`
  - 再执行 `apps/desktop/scripts/fix-win-exe-icon.ps1` 修正主程序 `.exe` 图标
  - 最后基于 `--prepackaged release/win-unpacked` 生成安装版与便携版，确保资源管理器中的 `.exe` 图标与窗口/任务栏图标一致
- `build:mac` 需要在 macOS 环境执行；当前 Windows 开发机不作为生成正式 mac 安装包的目标环境。
- GitHub 自动发布：
  - 工作流：`.github/workflows/release.yml`
  - 触发方式：推送实际版本标签，或通过 `workflow_dispatch` 指定已经存在的标签。先确认版本与目标提交，不要复用文档中的旧标签。
  - CI 中的 pnpm 版本与仓库声明保持一致，当前为 `8.15.9`
  - 行为：自动构建 Windows / macOS 产物，并上传到 GitHub Releases
- 打包体积控制：
  - `apps/desktop/package.json` 中仅保留主进程/预加载真正需要的运行时依赖在 `dependencies`
  - React、Lexical、UI 组件库等渲染层依赖应放在 `devDependencies`
  - `electron-builder.yml` 采用白名单 `files`，避免把 workspace 包源码、缓存和无关 `node_modules` 整包打入安装包
- 开发诊断参数（如 `--ai-diag`）仅开发环境可用，打包环境应拒绝。
- Prisma 打包策略已切换为：
  - 构建期生成 `packages/core/generated/client`
  - 打包时直接携带生成产物
  - 打包版首次启动通过 `ensureDbSchema()` 执行 `schema-init.sql`
- 当前不再把“运行时调用 Prisma CLI 做 `db push`”作为打包版初始化依赖。
- 后续版本升级建议走“版本化 migration runner”，而不是在用户机器上执行 `prisma db push`。

## 7. 文档更新原则
- 用户文档（`README.md` / `USER_GUIDE*.md`）仅描述用户可见能力。
- 开发诊断、覆盖矩阵、smoke 细节仅保留在开发文档。
- 每次阶段更新需同步 `.agent/*` 与用户文档，避免状态不一致。

## 8. AI 设置存储说明
- AI 设置持久化文件位于 Electron `userData` 目录下的 `ai-settings.json`。
- `http.apiKey` / `apiToken` 类敏感字段仅本地保存，不写入 `novel_editor.db`。
- 备份恢复流程不应导出或恢复 `ai-settings.json`；恢复后需要用户重新填写密钥。

## 9. 参考路径
- 桌面端：`apps/desktop`
- AI 主进程：`apps/desktop/electron/ai`
- 开发日志：`apps/desktop/electron/debug/devLogger.ts`
- AI 工坊 UI：`apps/desktop/src/components/AIWorkbench`
- 诊断脚本：`apps/desktop/scripts/ai-dev-diagnostics.mjs`
- Core Prisma 生成脚本：`packages/core/scripts/generate-prisma-client.mjs`
- 生成产物：`packages/core/generated/client`
