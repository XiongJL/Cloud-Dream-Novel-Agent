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
| [python-ai-capability-migration-requirements.md](./python-ai-capability-migration-requirements.md) | Agent 模型调用渐进迁移至 Python：ModelGateway、双协议适配、Structured Output、灰度回滚与分阶段验收 |
| [tooling-and-mcp.md](./tooling-and-mcp.md) | Automation、RAG、AI 工作台、MCP/FastMCP、权限边界 |
| [intent-service-requirements.md](./intent-service-requirements.md) | IntentService 分层、输入输出契约、路由优先级与权限边界 |
| [structured-user-input-requirements.md](./structured-user-input-requirements.md) | Codex-like 结构化问答、先读取后提问、计划前澄清与执行中决策统一协议 |
| [agent-workspace-continuity-requirements.md](./agent-workspace-continuity-requirements.md) | 写作/Agent 无损切换、后台 Run、输入与确认表单恢复、跨模式状态提醒和渲染性能约束 |
| [context-compression-requirements.md](./context-compression-requirements.md) | 长会话压缩边界、领域语义摘要、近期原文保护、按需召回、失败熔断与验收标准 |
| [chapter-read-scope-delegation-requirements.md](./chapter-read-scope-delegation-requirements.md) | 全局跨卷章节顺序、用户读取委托、自适应扩展、可执行范围选项与读写范围隔离 |
| [chapter-targeting-and-context-expansion-requirements.md](./chapter-targeting-and-context-expansion-requirements.md) | 小说级 Agent、任意章节目标解析、初始 contextScope、范围外只读扩展及续写/新增/改写边界 |
| [agent-skill-requirements.md](./agent-skill-requirements.md) | Agent Skill、用户自定义 Skill、版本、解析、Prompt 与安全边界 |
| [运行时兼容逻辑清理](./compatibility-cleanup-2026-10-15.md) | 删除功能探测降级、旧调用签名回退和无引用旧界面；保留历史数据兼容的清单与原因 |
| [章节提示词与来源文风设计](./chapter-prompt-and-style-fidelity-design-2026-10-14.md) | 输入去重、连续新增 10 章、来源画像与条件化成员 |
| [章节提示词与来源文风验收](./acceptance-chapter-prompt-style-fidelity-2026-10-14.md) | 实现范围、检查点恢复、1.4.0 提炼与验证边界 |
| [新增章定位、记忆与文风修订验收](./acceptance-chapter-generation-quality-2026-10-15.md) | 正确章号、章末摘录、真实核验范围、交付警告和现有 Skill 1.0.2 修订 |
| [Skill 自适应执行设计](./skill-adaptive-execution-design-2026-10-09.md) | 方法说明与执行提示分离、内置执行绑定、通用子 Agent 调度、全书文风提炼与输出预算修复 |
| [Skill 执行 Review 修订设计](./skill-adaptive-execution-revision-2026-10-10.md) | 拆分限定为任务内分析阶段、保留专家审核与交付契约、阶段预算联动、缓存隔离与请求恢复 |
| [Skill 执行修订验收](./acceptance-skill-execution-revision-2026-10-11.md) | 专家审核、完整候选分页、阶段预算、未知请求与存储隔离的实现和验证边界 |
| [文风分析引文核验与分片恢复](./acceptance-skill-evidence-quality-2026-10-12.md) | 非逐字引文剔除、证据缺口传递与已保存失败响应的复用 |
| [分片分析中断与 Runtime 重启恢复](./acceptance-runtime-analysis-restart-2026-10-12.md) | 连接重置保护、旧失败状态修复、检查点手动继续与未知模型结果核对 |
| [模型检查点写锁与长任务历史写入](./acceptance-model-checkpoint-lock-2026-10-12.md) | 真实 SQLite 锁重试、历史事件增量写入与锁失败的检查点恢复 |
| [已完成分析结果收尾](./acceptance-completed-results-2026-10-12.md) | 冻结核验结果、跳过剩余章节、保留原审核与交付、明确实际覆盖范围 |
| [未确认请求与检查点恢复](./acceptance-unconfirmed-request-retry-2026-10-12.md) | 修正恢复按钮空转、先找回返回、明确授权重试未确认分片并保留计费记录 |
| [文风证据、内容审核与应用验收](./acceptance-style-quality-2026-10-13.md) | 真实操作兼容、完整候选分页复核、编写后审核、实际试写和内置 Skill 1.3.0 |
| [文风证据审核输出截断修复](./acceptance-style-evidence-truncation-2026-10-13.md) | 小批次审核、确认截断后减半、已完成页复用与旧失败检查点恢复 |
| [分析与审核网络错误手动恢复](./acceptance-analysis-network-recovery-2026-10-13.md) | 网络失败恢复入口、未知请求先核对、明确缺失后定向重试与传输分层诊断 |
| [文风编写与修订稳定性](./acceptance-style-authoring-stability-2026-10-13.md) | 程序生成文件头、正文修订、阻塞与建议区分、群像试写、草稿恢复和重复错误合并 |
| [旧文风草稿恢复的校验顺序](./acceptance-style-validate-resume-2026-10-13.md) | 纠正整理逻辑误接编译阶段、真实旧检查点回放与完整 Pack 校验 |
| [文风成员审核输入预算](./acceptance-style-review-input-budget-2026-10-13.md) | 48,065 字节真实预检失败、成员例证组织、旧成功审核复用与剩余审核恢复 |
| [Skill Pack 统一选择与运行设计](./skill-pack-runtime-selection-design-2026-10-13.md) | 设计稿：整包选择、本书默认、成员组合、版本冻结、多包隔离与旧绑定迁移 |
| [Skill Pack 统一入口实施记录](./acceptance-skill-pack-runtime-selection-2026-10-13.md) | 整包菜单、默认设置、原子解析、精确版本、旧规划兼容与备份恢复 |
| [Skill 可见范围设置](./skill-creation-visibility-design-2026-10-13.md) | 创建和后续修改小说/全部可见范围，含包成员、关联清理和运行快照兼容 |
| [Skill 可见范围实施记录](./acceptance-skill-visibility-2026-10-14.md) | 菜单及卡片设置、范围事务、共享及冲突副本、独立发布设置、迁移与验收 |
| [toolchain-requirements.md](./toolchain-requirements.md) | 领域 Toolchain 定义、首批链路、运行约束与验收标准 |
| [multi-chapter-processing-requirements.md](./multi-chapter-processing-requirements.md) | 多章节统一范围、分层上下文、专家处理、三层审批与批次草稿契约 |
| [chat-context-reading-and-activity-requirements.md](./chat-context-reading-and-activity-requirements.md) | 聊天按需章节读取、统一 deadline、真实取消、总结重试与工具活动生命周期 |
| [intent-first-retrieval-bugfix-2026-07-28.md](./intent-first-retrieval-bugfix-2026-07-28.md) | Intent 优先路由、正文按需读取、稳定 Toolchain 确定性计划与低成本只读自动执行 Bugfix |
| [file-import-requirements.md](./file-import-requirements.md) | 首页确定性小说导入、Agent 会话附件、正文追加与创作素材审核导入 |
| [完整备份与恢复](../../BackupDesign.md) | 作品资料与资源完整备份、旧包兼容、候选恢复与回滚、Agent 历史及副作用隔离 |
| [备份首版验收记录](./acceptance-backup-2026-10-08.md) | 全量导出/恢复、周期保护、Windows 实机证据、回归限制与后续范围 |
| [备份 2026-10-09 复验](./acceptance-backup-2026-10-09.md) | 五组专项检查、真实恢复重启、自动保护持久性、归档边界与既有回归问题 |
| [空章节备份修复](./backup-empty-chapter-fix-2026-10-09.md) | 人工测试发现的 JSON 误判、历史格式字节保留、真实库只读快照验证 |
| [retry-failover-resilience-requirements.md](./retry-failover-resilience-requirements.md) | Agent 全流程运行韧性：网络重试、模型结果 checkpoint、本地处理/发布恢复、产物级审核可用性、部分成功与多 Agent 恢复 |
| [durable-draft-operation-requirements.md](./durable-draft-operation-requirements.md) | LangGraph 异步草稿 Operation、幂等状态机、SQLite 原子提交、历史清理与灰度切换 |
| [ui-and-prototype.md](./ui-and-prototype.md) | Stitch 原型、UI 模块、写作/Agent 数据流 |
| [sse-event-stream.md](./sse-event-stream.md) | SSE 事件流 v1 设计、事件模型、断线恢复、取消逻辑 |
| [roadmap.md](./roadmap.md) | Phase 1-3 路线图、当前落实状态、后续补齐项 |
| [manual-acceptance-checklist.md](./manual-acceptance-checklist.md) | Phase 1 真实接口、长任务、刷新、取消与草稿写回手动验收步骤 |
| [manual-test-fix-plan-2026-07-20.md](./manual-test-fix-plan-2026-07-20.md) | 人工测试发现的失败重试、可折叠 Inspector、对话报告与当前对话修订批次待修复计划 |
| [chapter-writing-budget-and-recovery-fix-plan-2026-09-05.md](./chapter-writing-budget-and-recovery-fix-plan-2026-09-05.md) | 完整章节实测后的输出预算、截断恢复、占位草稿兜底与计划审校链路待修复方案 |
| [chapter-writing-retest-2026-09-07.md](./chapter-writing-retest-2026-09-07.md) | 输出预算与首章守卫修复、真实草稿审校和写回复测证据 |
| [chapter-writing-product-defaults-2026-09-09.md](./chapter-writing-product-defaults-2026-09-09.md) | 整章默认 2300 字、正文 18K 自动额度、篇幅校验和审校失败恢复 |
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
