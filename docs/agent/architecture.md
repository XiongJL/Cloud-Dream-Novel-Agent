# Agent 总体架构

## 架构概览

```text
Renderer UI
  ├─ 写作模式
  │   ├─ 目录 / 搜索 / 结构 / 人物 / 世界 / AI 工坊 / 灵感
  │   └─ Agent 快捷桥
  │
  └─ Agent 模式
      ├─ 小说级会话列表
      ├─ 当前会话流
      ├─ 会话内计划 / 执行 / 工具 / 草稿卡片
      └─ 右侧上下文与审核 Inspector

Electron Main
  ├─ IPC API
  ├─ Prisma / SQLite
  ├─ AiService
  ├─ AutomationService
  ├─ DraftSessionStore
  ├─ 外部 MCP bridge
  ├─ PythonRuntimeClient
  └─ 内置 Agent 工具桥

Python Agent Runtime
  ├─ FastAPI Control API
  ├─ LangGraph Workflow Runtime
  ├─ Supervisor / Writer / Editor / Reader
  ├─ FastMCP Client / Tool Adapter
  ├─ SQLite Agent State
  └─ Local Memory / Vector Store
```

## 技术栈

| 层级 | 技术 | 说明 |
| --- | --- | --- |
| 桌面框架 | Electron | 沿用现有应用 |
| 前端 | React + TypeScript | 沿用现有 UI 栈 |
| 小说数据 | Prisma + SQLite | Electron Main 管理 |
| Agent 编排 | Python + LangGraph | 管理计划、节点、审批、恢复 |
| Agent 控制 API | FastAPI | Electron 调用 Python |
| 工具协议 | FastMCP / MCP | 内置 Agent 工具桥目标方向 |
| Agent 状态 | SQLite | 桌面端默认本地状态 |
| 事件流 | SSE | Agent 执行过程实时反馈 |

## 进程模型

开发模式：

```text
Electron Main
  -> PythonRuntimeClient
  -> spawn agent_runtime/.venv/Scripts/python.exe -m novel_agent_runtime
  -> Python FastAPI listens on 127.0.0.1:<dynamic_port>
```

打包模式：

```text
resources/
  agent-runtime/
    novel-agent-runtime.exe
```

开发环境优先使用 `agent_runtime/.venv`。正式打包通过 PyInstaller onedir 生成平台 Runtime，并由 `electron-builder` 复制到 `resources/agent-runtime/`；Windows、macOS x64 与 macOS arm64 分别在对应 GitHub runner 上构建和执行健康检查。

## 通信边界

Renderer 不直接连接 Python：

```text
Renderer
  -> window.agent.*
  -> Electron IPC
  -> PythonRuntimeClient
  -> Python FastAPI
```

Python 不直接访问小说业务库：

```text
Python Runtime
  -> Automation HTTP /invoke
  -> Electron AutomationService
  -> AiService / Prisma / DraftSessionStore
```

## LangGraph 与计划模式边界

LangGraph 不提供像 Codex App 一样的产品级“计划模式按钮”。它提供的是实现计划模式所需的运行时能力：

- Plan-and-execute：Planner 先生成计划，Executor 再按步骤执行。
- Interrupt / resume：节点中遇到计划审核、范围不清、证据冲突或创作方向分歧时暂停，等待 UI 提交用户选择后恢复。
- Checkpoint：保存图状态，使后台 run、断线恢复、用户确认后继续执行成为可恢复流程。

因此产品层仍由 AgentWorkspace 定义：

```text
普通交流 -> 计划草稿 -> 忽略/提交/实施此计划 -> 执行中 -> 需要你确认 -> 草稿审核
```

后续 LangGraph 接入时，不新增一个独立的 `/plan` 命令入口，而是把当前手写的 `agent.plan`、`approval_required`、`submitApproval` 状态机迁移为 LangGraph 节点、interrupt 和 checkpoint。

## 会话与执行数据模型

UI 上以“会话”为主体验，执行任务作为会话内结构化对象存在。底层仍保持数据分离，便于恢复、审计和草稿写回。

```text
Novel
  -> AgentConversation[]
      -> AgentMessage[]
      -> AgentRun[]
          -> AgentRunEvent[]
      -> AgentArtifact[]
          -> DraftSession?
```

建议职责：

| 对象 | 职责 |
| --- | --- |
| AgentConversation | 小说下的一条历史会话，例如“大纲设计”“第三章节奏质检” |
| AgentMessage | 用户与 Agent 的自然语言消息 |
| AgentRun | 一次计划执行，包含状态、审批、取消和恢复信息 |
| AgentRunEvent | SSE 事件，记录步骤、工具调用、失败原因和产物创建 |
| AgentArtifact | 会话内产物卡片，指向报告、证据、草稿或 diff |
| DraftSession | 已存在的草稿审核实体，负责最终写回边界 |

会话和执行不要混成一个表。会话负责用户体验连续性；Run 负责可恢复状态机；Artifact 负责把计划、工具、报告、草稿和审计变更回填到会话流。

当前阶段已落地：

四张 Agent 表已正式声明在 `packages/core/prisma/schema.prisma`；`ensureAgentConversationSchema` 仅承担旧库兼容检查，不再是 schema 的唯一来源。

同一会话的 SQLite upsert/delete 在 Electron Main 中串行执行，避免自动保存并发触发“删除后重插”竞争；默认种子会话与消息 ID 按 `novelId` 隔离。

| 表 | 状态 | 说明 |
| --- | --- | --- |
| `AgentConversation` | 已落地 | Prisma 正式 schema 与 Electron 兼容迁移共同维护；按小说保存会话标题、角色、runtime conversation id、suggested goal、plan JSON、`contextSummaryJson` 和错误信息 |
| `AgentMessage` | 已落地 | 保存会话内用户与 Agent 消息 |
| `AgentRun` | 已落地 | 保存一次计划执行的状态、进度、草稿 session 和取消标记；会话读取保留全部历史 run |
| `AgentRunEvent` | 已落地 | 保存 run 下的 SSE 事件，按 `eventId` 增量写入并按 `sequence` 排序恢复 |
| `AgentArtifact` | 已完成首版 | 独立保存最终报告、`context_bundle`、`consistency_review` 与 DraftSession 草稿引用；diff 类型后续扩展 |

## Domain Toolchain 层

普通聊天在进入 Planner 前先经过 Python Runtime 内的两阶段 IntentService：

```text
IntentRequest
  -> IntentService.preflight（入口 / chat_only / 待澄清 / 待审批）
  -> LangGraph 只读探索 + Electron SemanticProposal
  -> IntentService.finalize
  -> 唯一 IntentDecision（respond / clarify / plan）
  -> Planner / Runtime Policy
```

IntentService 不执行工具，也不授予权限。Operation Registry 定义稳定任务语义；Capability Matcher 读取 Toolchain 的 `supportedOperations`、Tool Manifest 与角色注册表，只形成建议。Planner 根据有序 operations 生成正式步骤，Runtime 仍逐次校验版本、角色、输入、审批和原子工具白名单。

IS-2 首版把上一轮结构化 Intent 保存为轻量引用，明确的“按刚才方案继续”继承 Operation、deliverable 和角色。独立 Risk Assessment 只聚合 requestedEffect：`data_write` 回到审核中心结构化确认，`external` 在普通会话中拒绝；它不输出授权字段。禁用 Toolchain 不进入 Planner 公共列表，能力匹配记录降级原因后回退。

稳定、可复用的领域流程位于 Planner/Executor 与 FastMCP 原子工具之间：

```text
AgentPlanStep.toolchain
  -> ToolchainRegistry（ID / version / role / budget / schema）
  -> LangGraph 原子节点推进与 checkpoint
  -> FastMCP 或 HTTP AgentToolAdapter
  -> AutomationService
  -> ContextBundle / ReviewArtifact
```

TC-0/TC-1/TC-2 已注册 `chapter.context@1.0.0`、`chapter.consistency_review@1.0.0`、`chapter.continuation@1.0.0` 与 `creative_asset.draft@1.0.0`。链内模型综合仍通过 Electron AiService，原子项目读取和草稿调用仍经过 manifest 和 adapter；Toolchain ID 本身不是权限凭证。计划步骤只能选择 Toolchain 或原子 tools 之一。草稿链只创建 DraftSession/Artifact，副作用调用先进入 SQLite 幂等账本，结果未知时 fail closed 且禁止重放。链级状态进入折叠活动流，底层调用事件继续保留用于审计和 SSE 重放。

当前 IPC：

| API | 说明 |
| --- | --- |
| `db:get-agent-conversations` | 读取某本小说下的 Agent 会话和消息 |
| `db:upsert-agent-conversation` | 保存单个会话及其消息 |
| `db:delete-agent-conversation` | 删除单个会话 |

## 模型上下文边界

AgentConversation 保存完整消息和全部历史 Run，不承担模型窗口裁剪。Renderer 将可见会话、当前计划、审批响应和 artifact 引用完整同步到 Runtime；Runtime 只负责校验和编排，同样不截取最近固定条数。

所有 Agent 模型调用在 Electron `AiService` 进入 `AgentContextAssembler`：

```text
完整会话 / 当前请求 / 计划与审批 / 工具结果 / artifact 引用
  -> 模型窗口档案或 contextWindowTokens 覆盖
  -> 扣除输出预算、系统提示和安全余量
  -> 当前请求与约束优先
  -> 最近原文 + 持久增量摘要 + 按引用召回的原消息/产物摘录
  -> agent-context-v1 JSON
  -> 当前 Provider
```

压缩不修改 AgentMessage。真实压缩发生后，组装器返回 `agent-conversation-summary-v1` 增量记录，Electron 将其保存到 `AgentConversation.contextSummaryJson`；记录含 revision、稳定来源 messageId、事实摘录、用户决策、未决问题、会话 outcome 和 artifact 引用。后续调用仍以原消息与 Artifact 为事实源，摘要只负责定位并召回有界原文。章节续写和创作素材仍先由 `ContextBuilder` 选择小说正文、摘要和实体，再通过同一模型预算边界发送。

当诊断表明本次调用发生压缩时，Renderer 会在助手回答前保存一条版本化 `system` 消息。它负责呈现可展开的预算摘要，刷新后仍可恢复；同步模型历史时会被过滤，因此不会成为新的模型事实。

## JSON-RPC 借鉴边界

外部 Codex / Claude MCP 继续使用 JSON-RPC/MCP。

内置 Agent 不改成 stdio JSON-RPC 主链路，采用 HTTP JSON envelope + SSE：

- 控制 API 借鉴 `id/method/params/error` 形状。
- 事件流借鉴 JSON-RPC notification 形状。
- transport 保持 HTTP + SSE，便于桌面 UI、调试、重连和生命周期管理。
