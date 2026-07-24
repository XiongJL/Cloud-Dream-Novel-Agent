# CloudDream Novel Agent（云梦小说智能体）

CloudDream Novel Agent 是一款面向长篇小说创作的可离线优先桌面应用。它把富文本写作、作品资料管理、本地检索与可审核的 AI Agent 工作流放在同一个项目中：作者可以专注写作，也可以让创作专家读取指定范围、形成计划、执行分析并生成草稿，再由作者决定是否写回。

当前源码版本为 **0.2.0**。Agent 主链、恢复机制和自动化测试已经落地，真实模型长任务与各平台发布包仍需持续验收。稳定安装包的实际功能以对应 Release 说明为准。

## 核心能力

### 写作模式

- Lexical 富文本编辑、心流模式、卷章管理与小说导入。
- 故事线、情节点、章节锚点和叙事矩阵。
- 角色、关系、物品、世界观、地图与灵感管理。
- 章节、资料和创作实体的全局搜索。
- 本地摘要、AI 摘要、标题生成、章节续写与 AI 创作工坊。
- 加密备份、自动备份和跨设备恢复。

### Agent 模式

- 小说级多会话，支持团队、作者、编辑、读者、世界观和考据六种工作视角。
- 普通讨论、结构化计划、计划审核、执行进度和用户决策断点保留在同一条会话时间线中。
- 支持当前章、多选章节、章节区间、当前卷和整本小说范围。
- 提供章节审校、读者旅程、世界观一致性、项目内事实核对、情节线分析和团队综合审计。
- 续写、场景改写、创作素材和多章节改写先生成 DraftSession / DraftBatch，不直接覆盖正文。
- 草稿支持原文对照、差异查看、审核意见、版本冲突保护、失败恢复和事务性写回。
- Run、事件、审批、报告和会话持久化到本地 SQLite；刷新、SSE 断线或 Runtime 重启后可恢复明确状态。
- 根据模型上下文窗口组装输入，支持长会话压缩、持久摘要、来源诊断和按引用召回。

### AI 与工具接入

- HTTP Provider 支持 OpenAI-compatible Chat Completions 和 Responses API。
- MCP CLI Provider 可接入 Codex、Claude Code 等本地 CLI。
- 本地 MCP bridge 允许外部客户端通过受控 Automation API 操作作品数据，而不是直接访问 SQLite。
- RAG 支持章节与结构化资料检索；Embedding 不可用时可回退到本地 Hash 索引。
- AI API Key / Token 只保存在当前设备的 Electron `userData` 中，不写入小说数据库，也不进入备份。

## 数据与安全边界

- 小说数据、Agent 会话和运行状态默认使用本地 SQLite。
- Electron Main 是数据库、AI 设置、工具权限和草稿写回的唯一业务边界。
- Python Runtime 负责 Agent 编排，不直接访问 Prisma 小说业务库。
- 只读探索受工具白名单、范围和预算限制；生成草稿或修改数据必须经过计划与审核流程。
- 使用云端模型时，筛选后的提示词、正文片段或证据会发送给所配置的 Provider，请根据数据敏感性选择服务。

## 下载

稳定版本统一发布在 [GitHub Releases](https://github.com/XiongJL/Cloud-Dream-Novel-Agent/releases)。新版发布工作流使用以下文件名：

- Windows 安装版：`clouddream-novel-agent-setup-<version>.exe`
- Windows 便携版：`clouddream-novel-agent-portable-<version>.exe`
- macOS：`clouddream-novel-agent-mac-<version>.dmg`

macOS 构建如果未签名，首次启动可能需要在系统安全设置中手动允许。Agent 功能是否包含在特定安装包中，请查看对应版本的 Release 说明。

## 本地开发

### 环境要求

- Node.js 20+（CI 使用 Node.js 24）
- pnpm 8.15.9
- Python 3.11+（开发 Agent 模式需要）
- JDK 17 与 MariaDB（仅开发可选的云同步后端时需要）

### 初始化 JavaScript 工作区

```bash
pnpm install
pnpm run setup
```

`pnpm run setup` 会生成 Prisma Client、首启建库 SQL，并编译 `packages/core`。

### 初始化 Python Agent Runtime

Windows PowerShell：

```powershell
cd agent_runtime
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
cd ..
```

macOS / Linux：

```bash
cd agent_runtime
python3 -m venv .venv
./.venv/bin/python -m pip install -e '.[dev]'
cd ..
```

开发模式下，Electron 会自动发现 `agent_runtime/.venv` 并启动本地 Runtime，无需单独常驻一个 Python 进程。

### 启动桌面端

```bash
pnpm dev:desktop
```

也可以运行 `pnpm dev`，通过 Turbo 启动工作区开发任务。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm run setup` | 首次生成并编译 Core |
| `pnpm dev:desktop` | 启动 Electron 桌面端 |
| `pnpm build:core` | 重新生成 Prisma Client 和建库 SQL |
| `pnpm db:push` | 将 Prisma schema 同步到开发数据库 |
| `pnpm build:desktop` | 构建桌面端 |
| `pnpm build:desktop:win` | 构建 Windows 安装版与便携版 |
| `pnpm build:desktop:mac` | 在 macOS 构建 universal DMG |
| `pnpm mcp:config` | 输出 Codex / Claude / JSON MCP 配置 |

### 验证

```powershell
# Python Runtime
.\agent_runtime\.venv\Scripts\python.exe -m pytest -q agent_runtime

# Desktop Agent 合约与恢复测试
pnpm --filter novel-editor-desktop run test:agent-recovery

# TypeScript
pnpm --dir apps/desktop exec tsc --noEmit

# Core / Prisma
pnpm run build:core

# Renderer、Electron Main 与 Preload
pnpm --dir apps/desktop exec vite build
```

macOS / Linux 运行 pytest 时，将 Python 路径替换为 `./agent_runtime/.venv/bin/python`。

## 架构

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

主要目录：

- `apps/desktop`：Electron、React、AI 服务、Agent UI 和 Automation API。
- `agent_runtime`：Python、FastAPI、LangGraph、IntentService 与领域 Toolchain。
- `packages/core`：Prisma schema、生成客户端和共享数据层。
- `apps/backend`：可选的 Spring Boot + MariaDB 云同步服务。
- `docs/agent`：Agent 产品方向、架构、决策、需求和验收文档。

## CLI / MCP 接入

先启动桌面应用，再生成或查看客户端配置：

```bash
pnpm mcp:config
```

外部客户端通过 MCP bridge 调用受控工具。Runtime 端口和临时 Bearer Token 由桌面应用管理，不需要写死在 CLI 配置中。详细步骤见：

- [MCP CLI 接入说明](docs/mcp-cli-setup.md)
- [MCP CLI Setup (English)](docs/mcp-cli-setup-en.md)

## 当前边界

- 考据 Agent 当前只使用项目内章节、设定、RAG 和全文搜索；外部网络检索尚未接入。
- `完全控制` 工作模式仍禁用，正文和结构化数据写回必须经过人工审核。
- Spring Boot 云同步服务不是本地写作与 Agent 模式的必需依赖，完整云同步仍在持续开发。
- 0.2.0 的真实模型长任务、刷新/取消和各平台安装包仍需按手动验收清单验证。

## 发布

1. 确认根 `package.json` 与 `apps/desktop/package.json` 版本一致。
2. 完成测试和平台构建验证。
3. 推送版本标签：

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` 会创建 GitHub Release，构建 Windows 与 macOS 产物并上传附件。

## 文档

- [用户指南](USER_GUIDE.md)
- [User Guide](USER_GUIDE_EN.md)
- [开发指南](DEVELOPMENT.md)
- [Agent 设计文档](docs/agent/README.md)
- [Agent 路线图](docs/agent/roadmap.md)
- [手动验收清单](docs/agent/manual-acceptance-checklist.md)
- [Python Runtime](agent_runtime/README.md)
- [云同步后端](apps/backend/README.md)

## License

本项目基于 [GNU AGPL v3](LICENSE) 发布。
