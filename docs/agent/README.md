# CloudDream Novel Agent 化设计文档

版本：v0.4  
日期：2026-07-09  
适用范围：CloudDream Novel Agent 内置 Agent 产品、Python Agent Runtime、Agent UI、工具桥接与 SSE 事件流。

## 设计目标

CloudDream Novel Agent 的 Agent 化目标不是把现有编辑器改成聊天机器人，而是在保留“纯打字写小说”体验的基础上，新增一个 Codex-like 的 Agent 协作模式。

核心产品形态：

- **写作模式**：人类作者专注打字。保留目录、搜索、结构、世界观、AI 工坊、灵感等既有入口。Agent 不常驻侵占正文，只提供轻量快捷桥。
- **Agent 模式**：纯交流创作与任务执行。通过会话、创作专家团、工作模式、计划审核、用户决策断点、工具调用记录和草稿审核完成 Agent 协作。

核心工程原则：

- Electron Main 是数据库、AI 设置、工具权限、草稿写回的唯一边界。
- Python Runtime 只做 Agent 编排，不直接访问 Prisma/SQLite 小说业务库。
- Agent 产物默认进入 DraftSession，未经用户确认不写回正文。
- 外部 Codex / Claude MCP 与内置 Agent 工具通道分层处理。
- 第一阶段 SQLite-first，不引入 PostgreSQL/pgvector 作为桌面端默认依赖。

## 文档目录

| 文档 | 内容 |
| --- | --- |
| [product-direction.md](./product-direction.md) | 产品方向、双模式、创作专家团、写作模式边界 |
| [architecture.md](./architecture.md) | 总体架构、进程模型、通信边界、技术栈 |
| [python-runtime.md](./python-runtime.md) | Python Agent Runtime、已落地代码、API、开发环境 |
| [tooling-and-mcp.md](./tooling-and-mcp.md) | Automation、RAG、AI 工作台、MCP/FastMCP、权限边界 |
| [intent-service-requirements.md](./intent-service-requirements.md) | IntentService 分层、输入输出契约、路由优先级与权限边界 |
| [structured-user-input-requirements.md](./structured-user-input-requirements.md) | Codex-like 结构化问答、先读取后提问、计划前澄清与执行中决策统一协议 |
| [agent-workspace-continuity-requirements.md](./agent-workspace-continuity-requirements.md) | 写作/Agent 无损切换、后台 Run、输入与确认表单恢复、跨模式状态提醒和渲染性能约束 |
| [context-compression-requirements.md](./context-compression-requirements.md) | 长会话压缩边界、领域语义摘要、近期原文保护、按需召回、失败熔断与验收标准 |
| [chapter-read-scope-delegation-requirements.md](./chapter-read-scope-delegation-requirements.md) | 全局跨卷章节顺序、用户读取委托、自适应扩展、可执行范围选项与读写范围隔离 |
| [chapter-targeting-and-context-expansion-requirements.md](./chapter-targeting-and-context-expansion-requirements.md) | 小说级 Agent、任意章节目标解析、初始 contextScope、范围外只读扩展及续写/新增/改写边界 |
| [agent-skill-requirements.md](./agent-skill-requirements.md) | Agent Skill、用户自定义 Skill、版本、解析、Prompt 与安全边界 |
| [toolchain-requirements.md](./toolchain-requirements.md) | 领域 Toolchain 定义、首批链路、运行约束与验收标准 |
| [multi-chapter-processing-requirements.md](./multi-chapter-processing-requirements.md) | 多章节统一范围、分层上下文、专家处理、三层审批与批次草稿契约 |
| [chat-context-reading-and-activity-requirements.md](./chat-context-reading-and-activity-requirements.md) | 聊天按需章节读取、统一 deadline、真实取消、总结重试与工具活动生命周期 |
| [intent-first-retrieval-bugfix-2026-07-28.md](./intent-first-retrieval-bugfix-2026-07-28.md) | Intent 优先路由、正文按需读取、稳定 Toolchain 确定性计划与低成本只读自动执行 Bugfix |
| [file-import-requirements.md](./file-import-requirements.md) | 首页确定性小说导入、Agent 会话附件、正文追加与创作素材审核导入 |
| [retry-failover-resilience-requirements.md](./retry-failover-resilience-requirements.md) | Agent 全流程运行韧性：网络重试、模型结果 checkpoint、本地处理/发布恢复、产物级审核可用性、部分成功与多 Agent 恢复 |
| [durable-draft-operation-requirements.md](./durable-draft-operation-requirements.md) | LangGraph 异步草稿 Operation、幂等状态机、SQLite 原子提交、历史清理与灰度切换 |
| [ui-and-prototype.md](./ui-and-prototype.md) | Stitch 原型、UI 模块、写作/Agent 数据流 |
| [sse-event-stream.md](./sse-event-stream.md) | SSE 事件流 v1 设计、事件模型、断线恢复、取消逻辑 |
| [roadmap.md](./roadmap.md) | Phase 1-3 路线图、当前落实状态、后续补齐项 |
| [manual-acceptance-checklist.md](./manual-acceptance-checklist.md) | Phase 1 真实接口、长任务、刷新、取消与草稿写回手动验收步骤 |
| [manual-test-fix-plan-2026-07-20.md](./manual-test-fix-plan-2026-07-20.md) | 人工测试发现的失败重试、可折叠 Inspector、对话报告与当前对话修订批次待修复计划 |
| [decisions.md](./decisions.md) | 已确认的关键设计决策与不做项 |

## 当前实现基线

第一阶段已经落地：

- `agent_runtime/` Python Runtime 工程。
- `apps/desktop/electron/agent/PythonRuntimeClient.ts`。
- `window.agent.*` preload API。
- `AgentWorkspace` UI。
- 编辑器顶部 `写作 / Agent` 双模式切换。
- 写作模式快捷桥：`发送给 Agent`、`质检章节`、`下一段`。
- Agent 工作模式：`需要用户审核` / `只讨论不执行` / `完全控制（禁用）`。
- Codex-like 计划审核卡：`忽略` / `提交` / `实施此计划`。
- 后台 run + SSE 事件流。
- 执行中 `approval_required` 用户决策断点与 `submitApproval` 恢复执行。
- RAG 查询路径 SQLite-first，不在查询时自动触发 embedding/rebuild。

当前仍需补齐：

- LangGraph 主图与 SQLite Checkpointer。
- 外部 Node MCP bridge 与内置 Python tool manifest 的跨语言统一生成。
- `chapter.save` / `draft.commit` 后处理路径一致性。
- Stitch MCP 写入类操作当前需要重新加载有效 API key/header 状态后重试原型更新。
