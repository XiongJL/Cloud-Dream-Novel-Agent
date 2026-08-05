# Agent 路线图

## Phase 1：基础 Agent MVP

目标：

用户能在 Agent 模式输入：

> 帮我把第三章打磨得更有追更欲望。

系统能够：

1. 生成执行计划。
2. 读取当前章节与相关上下文。
3. 生成基础质检报告。
4. 生成一个章节修改草稿。
5. 把草稿放入审核中心。
6. 用户确认后写回正文。

## 当前已落实

- Python Runtime 工程。
- Python 依赖环境。
- Electron `PythonRuntimeClient`。
- `window.agent.*` API。
- `AgentWorkspace` UI。
- 编辑器 `写作 / Agent` 双模式。
- 写作模式快捷桥。
- 最小 `agent.plan / execute_plan` 同步链路。
- Agent 多会话 UI：会话列表、会话流、右侧 Inspector。
- Agent 会话持久化：SQLite `AgentConversation` / `AgentMessage` 扩展表。
- Agent 执行持久化：SQLite `AgentRun` / `AgentRunEvent` 扩展表。
- 输入框下方角色和工作模式选择。
- `需要用户审核` / `只讨论不执行` / `完全控制（禁用）` 工作模式。
- 明确任务自动生成计划草稿。
- 计划草稿卡支持 `忽略` / `提交` / `实施此计划`。
- 后台 run + SSE 事件流。
- `approval_required` 执行中用户决策断点。
- `submitApproval` 提交用户选择并恢复 run。
- `pendingApproval` / `approvalResponses` 随本地 `AgentRun` 持久化，页面刷新后可恢复“需要你确认”卡片。
- `AgentWorkspace` 对活跃 run 支持按最后 `sequence` 自动续订 SSE。
- Python Runtime 重启时会把旧的未完成 run 标记为中断失败，避免假运行状态。
- RAG 查询路径只读 SQLite 已有索引，不在查询时触发 embedding/rebuild。
- Agent 审核 Inspector 读取真实 DraftSession，支持编辑章节草稿、保存、丢弃和确认写回。
- 草稿审核中心已按 Stitch 方向改为宽幅右侧抽屉，支持原文/草稿双栏对照与单栏阅读；Lexical 章节内容在审核区转换为可读文本，写回时按标准 Lexical 节点追加，避免展示或保存原始 JSON。
- 输入框模型控件已接入 Electron AI 设置：展示真实 Provider/模型，HTTP 模式可修改当前文本模型并即时应用到后续 Agent 调用，MCP CLI 模式展示实际 CLI 配置。
- `agent.execute_plan` 改为显式审批；缺少批准或步骤 ID 非法时拒绝执行，只运行批准步骤。
- 分析范围审批会真实映射为 RAG scope、证据数量和用户提示。
- SSE 断线后即使 run 已终止，也会按 `lastSequence` 回放遗漏事件。
- Electron 端按事件增量持久化，并保留会话下的全部历史 run。
- Python Runtime 已有审批、批准步骤、分析范围和终态 replay 回归测试。
- `agent.chat` 已通过 Electron Automation 调用真实 AiService provider，不再返回本地模板回复。
- `agent.plan` 已通过真实 AiService provider 生成结构化计划，Python Runtime 对 Agent 与工具白名单做最终校验。
- Renderer 不在普通对话和计划请求中整体附带正文；`review_required` 可在回答或形成计划前通过白名单只读工具按需读取项目上下文，副作用工具仍必须等待用户批准。
- AgentConversation / AgentMessage / AgentRun / AgentRunEvent 已纳入 Prisma schema，开发启动 `db push` 不再删除会话数据。
- 计划修改意见已接入结构化 `agent.revise_plan`，保留 plan/thread 身份并校验步骤 ID、Agent 和工具白名单。
- Runtime 集成测试已覆盖执行暂停、范围审批、RAG 恢复、DraftSession 创建和终止事件。
- Run 终态改为先持久化 `run_completed/run_failed/run_cancelled`，再发布最终状态，避免断线恢复窗口漏事件。
- RAG 返回低置信度、警告或空证据时会触发 `evidence_quality` 决策断点。
- 用户选择“只保留分析报告”后，后续草稿工具真实跳过并记录 `tool_result: skipped`。
- 首次草稿生成前通过真实 AiService 检测互斥创作方向；明确目标直接通过，存在分歧时触发 `creative_direction` checkpoint。
- 用户选择的创作方向会注入 `chapter.generate_draft.userIntent` 或 `creative_assets.generate_draft.brief`。
- SSE 协议与 Node HTTP 客户端已有自动化测试，覆盖分块 frame、重复 sequence、socket 强制断开、`afterSequence` 重连和终态关闭。
- Python `/events/{runId}` 已有 Bearer 鉴权、`afterSequence` 终态回放与流关闭集成测试。
- Renderer 的 Run 状态投影已提取为共享纯函数，自动化测试覆盖审批暂停/恢复、步骤状态、草稿引用、终态和 JSON 刷新恢复。
- DraftSession 存储测试覆盖章节草稿创建、审核编辑、进程重载、版本冲突和提交状态持久化。
- Main 的 Agent 会话 SQL 已提取为可测试仓储；真实临时 SQLite 测试覆盖增量事件写入、数据库重连、终态/草稿引用/审批响应恢复和级联清理。
- Run 完成前会调用真实模型综合计划、工具发现和用户确认，最终报告以助手消息进入会话；报告失败时 Run 明确失败，不再空完成。

## Phase 1 后续补齐

- 作者多章节修订报告与明确范围批量改写已完成：统一范围读取、节拍审批、父子草稿、版本快照、失败恢复、宽幅审核和事务写回已接入既有 Agent 链路。

- 按 [Phase 1 手动验收清单](./manual-acceptance-checklist.md) 完成真实模型、长任务、审批、刷新、取消和草稿写回验证。
- 后台 run / SSE / 用户决策断点仍需真实长任务手动端到端验收。
- 轻量 `run_status` + SSE 续订已完成协议层和真实 socket 自动化测试；仍需在手动长任务中确认 UI 视觉状态恢复。
- 主动取消已贯通 Python Run task、Automation requestId、Electron AbortController、HTTP fetch 和 MCP CLI 子进程。
- `approval_required` 已覆盖分析范围、证据质量和创作方向分歧。
- Renderer、DraftSession 存储和 Main SQLite 仓储已有恢复测试；完整 Electron UI 自动化暂缓，先由手动刷新验收覆盖。

当前验收状态（2026-07-21）：底层自动化已经覆盖 Runtime、SSE/恢复、DraftSession、DraftBatch、报告审批、修订任务、版本冲突和事务写回；真实模型长任务、刷新/取消和批次草稿编辑仍需手动确认。整个 Agent 工作区已重新定向为“对话优先、侧栏按需”；作者/编辑/读者/世界观/考据/团队只作为 AI 工作视角，共享同一创作者交互。现有 360px 报告 Inspector 与独立修订任务池仅作为实现基线，必须完成对话报告卡、当前对话修订批次、可折叠 Inspector、轻量待改清单和专注审核原型后再恢复对应 UI 验收。

### 2026-07-21 创作者体验实施优先级

1. **优先：综合报告收敛与对话密度。** 多视角只发布一张综合报告卡，首屏 3 至 5 项；一次审核到修订只保留报告、进度、草稿三块稳定内容。
2. **优先：可逆草稿审核。** 在现有 DraftSession 左右对照上增加修改摘要、高亮 diff、单章版本校验和安全撤销；草稿创建不再自动展开 Inspector。
3. **随后：当前对话修订批次与轻量待改清单。** 立即处理不入清单，稍后、暂停和未完成事项才进入。
4. **随后：受约束的专注执行模式。** 自动读取、分析和生成可逆草稿，合并必要确认；永不自动越过正文写回、版本冲突和未知副作用对账。
5. **后续：智能工作视角。** 复用 IntentService `suggestedRole`、Operation Registry 和 Capability Matcher，增加 `auto` 与手动覆盖状态，不新增分类模型调用。

依赖关系：专注执行依赖可逆草稿和风险分级；智能视角不阻塞前四项，可独立在后续增量实现。

- 会话已改为消息与任务卡按时间交错的多轮时间线；终态任务后的消息会开启新一轮，并持久化历史任务计划快照与当前任务指针。
- Run 最终报告已纳入后续聊天上下文；结构化 `AgentArtifact` 已落地，Runtime 会保证生成型任务批准对应草稿工具、完成前产出目标草稿，并以角色选择约束最终报告主视角。
- 多模型上下文第一增量已落地：会话历史完整透传到 Electron，`AgentContextAssembler` 按模型窗口、输出和安全余量生成 `agent-context-v1`，并优先保留当前请求、约束、计划、审批、工具结果与 artifact 引用；章节和创作素材草稿的 `ContextBuilder` 输出也经过最终模型预算。
- 发生压缩时，会话时间线会在回答前显示持久化的可展开提示，说明原文/摘要消息数、未纳入项和 Token 预算；未压缩请求不显示提示。

## Phase 1 验收门槛

- `tsc --noEmit`、Vite build、Python compileall 和 pytest 全部通过。
- 章节打磨任务能从计划审核走到真实 DraftSession，并由用户确认写回正文。
- 未显式批准的计划不能调用草稿生成、数据修改、正文写回等副作用工具；`review_required` 下的白名单只读探索不受计划审批阻塞，但必须经过 Runtime 权限校验并留下审计事件。
- 页面刷新、SSE 断线后不丢失终态、草稿引用和执行事件。
- Runtime 重启时旧 run 明确失败，不显示为仍在执行。

## 多模型上下文管理与压缩

第一增量已经移除 Renderer、Runtime 和 AiService 对会话历史互相叠加的固定条数截断。Electron 现根据当前模型档案或用户配置的窗口，在每次调用前即时组装上下文；完整消息仍由 AgentConversation 持久化，切换模型不会删除或结束会话。

当前 `AgentContextAssembler` 已完成：

- 根据当前 provider / model 的上下文窗口、最大输出 Token 和安全余量计算输入预算，不再以固定消息条数作为主要边界。
- 使用保守的中英文 Token 估算作为通用兜底；支持 provider 提供精确 tokenizer 时替换估算结果。
- 按优先级保留上下文：系统约束与当前用户消息、待确认决策和当前计划、重要产物与最终报告摘要、最近原始对话、较早会话的滚动摘要、按需检索到的历史资料。
- 当前用户消息、尚未解决的问题、审批断点和已确认约束不得因压缩被丢弃。
- 长报告、草稿和工具结果以结构化摘要与 artifact 引用进入常规上下文；需要原文时再按引用检索，避免反复发送完整正文。
- 即时滚动摘要记录覆盖的消息索引范围；发生真实压缩后，Electron 同时生成 `agent-conversation-summary-v1` 增量记录，保存稳定 `messageId`、来源摘录、用户决策、未决问题和 artifact 引用。摘要不替换或删除原消息。
- 后续请求按当前问题匹配摘要来源 ID、关键词与 artifact 引用，召回有界原消息或产物摘录；旧助手结论只作为会话 outcome，不升级为项目事实。
- 用户切换模型后，下一次调用必须按新模型预算重新组装上下文；会话本身不得因模型窗口变小而失效或删除历史消息。
- 已统一移除 Renderer、Runtime 和 AiService 中针对 Agent 会话的固定 `slice(-N)`，保留单一可测试的预算入口。

Inspector 上下文诊断与持久摘要已完成：每轮聊天调用的预算、模型窗口、原文/精简/摘要/省略消息范围、长期约束、持久摘要版本和按引用召回数量绑定到助手消息；摘要自身通过 `contextSummaryJson` 随会话刷新恢复。源工具与小说内容的安全返回上限仍保留，不等同于会话条数截断。

建议分阶段实施：

1. 建立模型上下文窗口元数据、Token 预算器和纯函数上下文组装器。（已完成第一版）
2. 持久化结构化滚动摘要与 artifact 引用，并在消息超过预算时增量更新。（已完成首版）
3. 接入历史消息 / 产物检索，补充超长小说会话的按需召回。（已完成确定性引用召回；向量化长期记忆后续评估）
4. 在 Inspector 中展示本次上下文来源、估算 Token、压缩和省略情况，便于定位模型遗忘问题。（已完成）

验收标准：

- 自动化覆盖至少 8K、32K、128K 三档上下文窗口，以及中文为主、长报告、模型中途切换等场景。
- 在任何预算下，当前用户消息、待确认决策和明确的角色 / 产物约束始终存在。
- 切换到更小窗口模型时可以继续同一会话，并能通过摘要或引用回答此前已经确认的关键信息。
- 上下文估算超过预算时调用前可预测地压缩，不依赖 provider 返回超限错误后重试。
- Inspector 能说明哪些内容以原文、摘要或检索引用进入了本次调用。

## LangGraph 迁移方向

LangGraph 后续负责运行时，不负责定义产品入口：

- Planner node 承接当前 `agent.plan`。
- Plan review interrupt 承接计划草稿的 `忽略 / 提交 / 实施此计划`。
- Executor graph 承接当前后台 run。
- Runtime interrupt 承接 `approval_required` 用户决策断点。
- SQLite Checkpointer 承接暂停、恢复、断线重连。
- `AgentRunEvent` 继续作为 UI 事件协议，LangGraph 内部事件需要映射到当前 SSE 模型。

## Phase 2：运行时稳定化 + 创作专家团

当前进度（2026-07-20）：LangGraph 主动探索图、原子推进 Executor graph、SQLite Checkpointer、审批 `interrupt/resume`、折叠式 Run 活动流、结构化 `AgentArtifact`、统一 `AgentRole` 注册表、FastMCP tool adapter、多模型上下文组装器、持久化增量摘要、Inspector 上下文诊断、IntentService IS-0/IS-1/IS-2 首版和 Toolchain TC-0/TC-1/TC-2 已接入。`chapter.context`、`chapter.consistency_review`、`chapter.continuation`、`creative_asset.draft`、`plotline.analysis`、六类多章节角色链与 `novel.scope_audit` 已可按稳定版本执行；Renderer 已接入章节范围、专家报告、报告审批、多章草稿批次审核、未知副作用人工对账和修订任务池。当前功能开发缺口是外部网络考据能力；其余主体进入真实桌面端验收。

新增：

- LangGraph 主动探索图、Executor graph 与 SQLite Checkpointer（已完成）；副作用调用账本、稳定 requestId 与未知结果 fail-closed 恢复（已完成）。
- FastMCP tool adapter：统一工具 manifest、参数校验、权限注解、错误与取消透传、HTTP 回退（已完成）。
- `AgentArtifact` 独立表、产物事件、Run 完成契约和 Inspector 产物视图（已完成）。
- 创作专家团视图增强：角色能力、工具范围、预置任务、专家报告、覆盖率、章节矩阵和评分视图已完成。
- AgentRole Runtime 注册表与 `agent.roles` 查询接口（已完成）。
- 专家预置任务入口：点击后切换角色并填充任务目标，用户确认发送后进入现有对话/计划链路（已完成）。
- 两阶段 IntentService、Operation Registry、Capability Matcher 与 Planner 提示（IS-0/IS-1，已完成）；上一轮 Intent 指代、风险降级、能力禁用和旧规则清理（IS-2 首版，已完成）。
- Codex-like 折叠式实时活动流：Run/SSE 事件投影、折叠摘要、展开明细和恢复已完成；聊天只读探索的逐条实时事件仍待接入统一事件流。
- 编辑 Agent 多章节范围质检报告后端。（已完成）
- 读者 Agent 盲测报告。（已完成后端）
- 世界观 Agent 设定一致性检查。（已完成后端）
- 考据 RAG Agent 证据整理。（项目内检索后端已完成；外部网络检索待接入）
- 多维评分已进入一致性审核和读者旅程报告。
- 版本化 Toolchain 注册、Planner/Runtime 路由、链/节点事件与预算（TC-0，已完成）。
- `chapter.context` 与 `chapter.consistency_review` 只读链、结构化审核 Artifact 和 Inspector 评分视图（TC-1，已完成）。
- `chapter.continuation` 与 `creative_asset.draft` 草稿链、方向/证据 interrupt、DraftSession 校验与未知结果不重放（TC-2/P1，已完成）。
- [Agent 多章节处理 V1](./multi-chapter-processing-requirements.md)：公共 `AgentChapterScope`、分层续写上下文、父子 `DraftBatch`、节拍审批、`chapter.sequence_continuation`、连续前缀提交、失败续跑、专家报告审批/过期/修订任务骨架、四类专家范围 Toolchain 和团队 Supervisor 后端均已完成；章节范围、专家报告矩阵、报告审批、批次审核和修订任务池 Renderer 已完成。
- `plotline.analysis` 长范围只读链、章节分页、范围 interrupt、共享预算、结构化 Artifact 与 Inspector 视图（TC-3/P2 首版，已完成）。
- 追更欲望、弃读风险与悬念评分已进入 `reader_journey`。
- 困惑点、出戏点、有效钩子与读者期待已进入 `reader_journey`。

界面开发门禁：

- 所有新增或调整的 Agent Renderer 界面必须先完成 Stitch 原型并经用户确认，再进入前端实现。
- 原型需覆盖主流程、空态、加载、失败/冲突、长内容和窄窗口；确认后的 screen 与交互说明回链到对应需求文档。

多章节 P1 固定实施顺序：

1. 收尾并测试 `agent.regenerate_batch`。（已完成）
2. 在 Stitch 完成并确认全套多章节原型。（主流程和 Inspector 宽度已确认；后续新增或调整界面继续遵守 Stitch 门禁）
3. 落地统一专家报告、审批、过期和修订任务骨架。（已完成）
4. 先实现编辑范围审核，验证公共契约。（`editor.range_review@1.0.0` 后端已完成）
5. 接入读者、世界观和考据。（后端已完成）
6. 实现团队 Supervisor。（后端已完成）
7. 最后开发范围选择、报告审批、章节矩阵和批次审核 Renderer。（已完成主流程）
- `sideEffectUnknown` 人工对账、正文状态台账、作者范围修订计划与已有章节批量改写均已完成。外部网络考据 Tool 已决策延期；恢复时优先实现独立 `web.search` / `web.fetch` 和 `ddgs` 直连 provider，具体边界见[设计决策 112](./decisions.md)与 [Skill 外部来源提炼](./agent-skill-requirements.md)。

可复用工具：

- `rag.ask`
- `search.query`
- `chapter.get`
- `plotline.list`
- `character.list`
- `worldsetting.list`

## 阶段边界

当前 Agent 产品只规划到 Phase 2。

不进入自动写入阶段：

- `需要用户审核` 模式允许明确任务自动生成计划草稿。
- 不做“高置信度自动执行”偏好。
- 允许 `plotline.list`、`chapter.get`、`rag.ask` 等只读工具在回答前主动探索；草稿生成、数据修改和正文写回仍需确认。
- 不做多 Agent 自动迭代闭环。

Phase 2 的意图识别只用于决定是否生成计划草稿和计划类型，例如：

- `生成质检计划`
- `生成续写计划`
- `生成读者反馈计划`
- `整理设定一致性计划`

只读探索可以在形成计划前调用，并受工具白名单、调用次数和上下文预算限制。用户选择 `实施此计划` 后才允许草稿生成或其他有副作用的计划工具。执行中遇到分歧时，通过 `需要你确认` 决策断点暂停并等待用户提交答案。
