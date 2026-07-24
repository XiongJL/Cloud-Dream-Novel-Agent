# Agent 设计决策记录

## 已确认决策

1. 一级模式只保留 `写作 / Agent`。
2. 编辑、读者、作者、世界观、考据 RAG 是 Agent 模式内的角色，不是一级模式。
3. 写作模式保持纯编辑器，不常驻 Agent 面板。
4. Agent 模式采用 Codex-like 会话和执行计划布局。
5. UI 实现以 Stitch 项目 `7717701781434255808` 为视觉依据。
6. Python Runtime 负责 Agent 编排，不拥有小说数据主权。
7. Electron Main 是数据库、AI 设置、工具权限、草稿写回的边界。
8. Agent 产物默认进入 DraftSession，未经用户确认不写正文。
9. 桌面端默认 SQLite-first，不要求 PostgreSQL。
10. PostgreSQL/pgvector 只作为后续云端、多用户、大规模长期记忆扩展。
11. 外部 Codex / Claude MCP 暂不加权限审批。
12. 内置 Agent 必须有工具边界、审批和草稿审核。
13. FastMCP 优先用于内置 Python Agent 工具层，不立即替换外部 Node MCP bridge。
14. 内置 Agent 不采用 stdio JSON-RPC 作为主链路，采用 HTTP JSON envelope + SSE。
15. SSE 流执行事件，不流正文写回。
16. 底部下拉定义为 Agent 工作模式，不再仅称为权限选择。
17. 默认 `需要用户审核` 模式允许明确任务自动生成计划草稿。此条最初约束为“不自动执行工具”，现由决策 50、53 修订为：形成回答或计划前可以自动执行只读探索工具，但不能自动执行副作用工具。
18. 计划草稿采用 Codex-like 审核动作：`忽略`、`提交`、`实施此计划`。
19. 执行中分歧通过 `approval_required` 用户决策断点暂停 run，并由 `submitApproval` 恢复。
20. LangGraph 不作为产品级“计划模式”入口，只作为后续实现 plan-and-execute、interrupt/resume、checkpoint 的运行时。
21. 第一阶段区分“Renderer 刷新恢复”和“Python 进程级任务恢复”：前者通过 SSE `afterSequence` 续订支持，后者暂不支持，Runtime 重启时把未完成 run 标记为中断失败。
22. `agent.execute_plan` 采用 fail-closed 审批：必须显式批准并提交合法 `approvedStepIds`，Runtime 只执行批准步骤。
23. Electron 端保留会话下全部历史 run，`AgentRunEvent` 使用增量 upsert，前端内存不能截断持久化审计记录。
24. Phase 1 先完成真实 DraftSession 审核和写回闭环；LangGraph、FastMCP、AgentArtifact 拆表不阻塞 MVP 验收。
25. `agent.chat` 和 `agent.plan` 通过 Electron Automation 调用当前 AiService provider；Python 不持有模型 API Key。
26. Renderer 在对话和规划阶段不主动把章节正文整体塞入模型上下文。此条最初限制为“批准后才能读取小说库”，现由决策 50、53 修订为：Runtime 可在审批前通过白名单只读工具按需获取项目上下文，草稿生成、数据修改和正文写回仍需批准。
27. 模型生成的计划不是权限凭证，Python Runtime 必须再次校验 Agent、工具和批准步骤。
28. AgentConversation / AgentMessage / AgentRun / AgentRunEvent 必须进入 Prisma schema；禁止只用启动期 raw SQL 建表，以免 `prisma db push` 删除用户会话。
29. 开发启动的 `prisma db push` 使用 `--skip-generate`，Prisma Client 由构建阶段统一生成，避免运行中覆盖已加载的原生 DLL。
30. 计划修改使用 `agent.revise_plan` 原位修订，保留 `planId` / `threadId`；模型只能复用当前计划已有 stepId，新增步骤由 Runtime 分配 ID。
31. Run 终止必须先持久化终止事件再保存最终状态，确保终态 `run_status.lastSequence` 不会落后于 SSE 终止事件。
32. Agent 会话写入与删除按 conversationId 串行化；种子 conversation/message ID 必须包含 novelId，禁止跨小说共享固定主键。
33. RAG 明确返回低置信度、警告或空证据时必须触发 `evidence_quality` checkpoint；用户可选择谨慎生成草稿或只保留报告。
34. `report_only` 是执行语义，不只是 UI 文案：后续草稿工具必须跳过并写入可审计的 skipped 工具事件。
35. 首次草稿生成前由真实 AiService 检测互斥创作方向；无分歧不得打断用户，有分歧才发出 `creative_direction` checkpoint。
36. 模型生成的方向 option id 不可信，Runtime 重新编号；用户选择摘要必须注入真实草稿 `userIntent` / `brief`。
37. 每次 Run 工具调用分配独立 Automation requestId；`agent.cancel` 必须同时取消 Python task 和 Electron 上游请求。
38. AutomationServer 以 AbortController 管理活跃 requestId；HTTP provider 中止 fetch，MCP CLI provider 终止子进程，统一返回 `CANCELLED`。
39. 取消不得转化为 `run_failed`，且在 DraftSession 创建前取消时禁止产生迟到草稿。
40. Electron SSE 客户端必须把同一次底层 socket 故障合并为一次 `agent:run-disconnected` 通知；终态事件后的主动关闭不得触发恢复。
41. Renderer 对 Run 事件的状态投影必须使用可独立测试的共享纯函数；刷新恢复以持久化 run 的最大 `sequence`、终态、草稿引用和待审批信息为准。
42. AgentConversation / AgentRun / AgentRunEvent 的 SQLite 读写由 Main 可注入的 `AgentConversationStore` 统一负责；IPC handler 不再内嵌 SQL。
43. 工具步骤结束不等于任务完成；Runtime 必须先用有界工具结果生成并发布最终综合报告，再写入 `run_completed`。报告生成失败时写入 `run_failed`。
44. 会话正文按时间交错呈现消息和任务卡；任务完成、失败或取消后，下一条用户消息归档当前 Run 并开启新一轮，历史 Run 保留各自的计划快照且不再提供当前轮操作。
45. 澄清轮是计划生成的硬门槛：聊天模型显式返回 `needsClarification`，Runtime 与前端都必须在等待用户输入时压制 `agent.plan`，用户回答后再结合会话历史重新判断。
46. Run 完成不结束会话；后续聊天必须携带当前持久化会话消息，并将最终报告纳入模型上下文。计划必须声明 `report`、`chapter_draft` 或 `creative_assets_draft` 产物类型，草稿产物由 Runtime 保证存在对应工具。非团队角色是主视角，最终报告不得新增未执行角色的专属评估章节。
47. 会话滚动采用“底部跟随”状态：用户离开底部时暂停自动滚动并显示“查看最新”，发送、点击按钮或手动到底后恢复。真实模型调用采用 Provider、Automation、Runtime 逐层递增的超时预算，避免内层 60 秒提前中断。
48. 多模型上下文不能依赖固定保留最近 N 条消息。后续由 Electron AI 边界的统一 `AgentContextAssembler` 根据当前模型窗口、输出预算和安全余量组装上下文；会话历史完整持久化，压缩只影响单次模型输入。优先保留当前请求、待确认决策、用户约束和计划状态，较早内容使用可追溯的结构化滚动摘要与 artifact / 检索引用。切换模型时按新预算重新组装，不使会话失效。
49. 澄清只用于工具无法获得的用户偏好或创作决策。当前大纲、章节、角色、设定和项目进度属于只读工具可获取的事实，不得要求用户重复提供；明确的读取或分析请求可先执行白名单只读探索再回答，明确的生成或修改请求应形成可审核计划，批准后才执行副作用工具。多轮澄清后生成计划时，计划目标必须包含相关会话要求和用户回答，不能只使用最后一句短答。
50. Phase 2 将“工具审批”细分为只读探索和副作用执行。`review_required` 模式允许 LangGraph 在回答前主动循环调用 Runtime 白名单内的只读工具，并用 `agent_graph.db` checkpoint；草稿生成、数据修改和正文写回仍必须经过计划审批或 runtime interrupt。模型返回的工具名不是权限凭证，图节点必须重新校验白名单和调用上限。
51. Agent 中间过程采用 Codex-like 单条折叠活动流：折叠态由规范化事件确定性派生并原位更新，点击后展示工具、命令、LangGraph 节点、审批和产物明细；不展示隐藏思维链，也不将模型自由文本作为审计事实。明细沿用持久化 `AgentRunEvent` 与 artifact 引用，所有参数和输出在落库前脱敏并限制长度。
52. 后台计划执行采用 LangGraph 原子推进图，每个 checkpoint 只跨越一个步骤边界或一个工具调用。分析范围、证据质量和创作方向通过 `interrupt` 暂停，`submitApproval` 使用 `Command(resume=...)` 恢复；等待审批时不保留轮询任务。Runtime 重启只自动保留可证明停在 interrupt 的 `waiting_approval`，未知是否完成副作用的 `running/cancelling` 在幂等日志完成前继续 fail closed。
53. 现行工具权限模型以“是否产生持久化副作用”为审批边界，并正式覆盖决策 17、26 中的旧限制：
    - `chat_only` 不向模型暴露任何项目工具，只基于明确提供的会话上下文回答。
    - `review_required` 可在回答或形成计划前自动调用 Runtime 白名单内的只读探索工具，例如 `chapter.get`、`plotline.list`、`character.list`、`worldsetting.list`、`search.query` 和 `rag.ask`。
    - 创建 DraftSession、生成草稿、修改结构化数据、保存章节、写回正文以及外部命令等均视为副作用；必须在用户选择 `实施此计划` 并提交批准步骤后执行。执行中出现新的范围、风险或创作分歧时，仍可通过 Runtime interrupt 再次确认。
    - “模型请求调用工具”不构成授权。工具的只读/副作用分类、Agent 白名单、调用次数、参数范围和审批状态必须由 Electron/Runtime 在每次调用时重新校验。
    - 只读调用也必须进入可审计事件流并限制返回量；工具一旦无法证明无持久化副作用，就按副作用工具处理并 fail closed。
    - 计划审核与 Runtime interrupt 是两层不同门禁：前者授权计划中的副作用步骤，后者处理执行期间新出现的决策，Runtime interrupt 不能反向替代计划审批。
54. Agent 产物采用独立 `AgentArtifact` 契约，不再从消息文本或 `draftSessionId` 临时推断任务结果：
    - 每个成功 Run 必须生成一个 `report` artifact；声明 `chapter_draft` 或 `creative_assets_draft` 的计划还必须生成对应草稿 artifact。
    - 用户批准的步骤集合必须覆盖计划声明产物所需的生成工具，否则 `execute_plan` 在创建 Run 前拒绝执行。
    - 工具执行结束不代表产物成功。Runtime 只有在目标 artifact 已登记后才能发布 `run_completed`；缺失目标产物时必须发布 `run_failed`。
    - 报告 artifact 保存有界正文；草稿 artifact 保存 DraftSession 引用和摘要，正文仍由 DraftSession 管理，避免形成两份可编辑数据源。
    - artifact 使用稳定 `artifactId`，通过 `artifact_created` 事件进入 UI，并投影到 Electron SQLite 的独立 `AgentArtifact` 表；刷新和历史 Run 恢复不依赖内存事件。
    - 草稿被写回或丢弃后，artifact 状态同步为 `committed` 或 `discarded`。消息中的最终报告继续用于会话可读性，但 artifact 才是后续上下文组装和审核的结构化来源。
55. Run 中间过程与会话正文必须严格分流：步骤标题、节点状态、工具调用、工具结果和审批记录只进入折叠活动流，不得投影为独立助手气泡。`message` 事件只有 `kind: final_report` 或显式声明 `visibility: conversation` 时才能进入会话时间线；`approval_submitted` 仅更新 Run 状态并保留在活动明细。旧版本已经持久化的步骤气泡在加载时按历史计划步骤标题精确清理。
56. 活动流按操作生命周期合并展示，不把协议事件数量等同于操作数量：`step_started` 与对应的 `step_completed/step_failed` 合并为一个步骤项，`tool_call` 与对应的 `tool_result` 按 `stepId + toolName` 合并为一个工具项。行状态从执行中原位更新为完成、失败或跳过，并合并参数、结果摘要和耗时；底层事件仍分别持久化和重放，不因 UI 合并而丢失审计信息。
57. 章节草稿审核与写回必须区分“可读文本投影”和“持久化 Lexical 文档”：审核 UI 使用共享解析器把 Lexical JSON 投影为分段纯文本，并兼容历史上 JSON 后误拼正文的记录；DraftSession 保存和提交时把 Agent 纯文本转换为 Lexical 节点追加，禁止用字符串直接连接 Lexical JSON 与正文。旧草稿即使未被用户编辑，提交路径也必须重新规范化后再写回。
58. Agent 模型配置以 Electron `AiService` 为唯一数据源，不在 Renderer 或 Python Runtime 维护第二份 Provider/模型状态。输入框模型控件读取并更新现有 AI 设置：HTTP 模式可修改当前文本模型，MCP CLI 模式只显示 CLI 配置；应用后聊天、计划、报告、方向检测和草稿生成从下一次调用起统一生效。模型切换是全局 AI 配置变更，不伪装成尚未实现的会话级模型隔离。
59. `AgentRole` 由 Python Runtime 注册表统一定义，包含稳定角色 ID、执行 Agent、工具白名单、Skill 展示和专家预置任务；Planner 的合法角色集合与 `agent.roles` 查询接口复用该注册表。Renderer 启动时读取真实角色定义，Runtime 不可用时使用同结构本地回退。预置任务点击后只切换角色并填充可审阅目标，不自动发送、不越过澄清和计划审批门禁。
60. 内置 Agent 工具层默认使用 FastMCP in-memory adapter，精确工具名、参数 schema 和只读/副作用注解来自 Python `tool_manifest.py`；FastMCP tool 继续代理 Electron Automation HTTP，因此 Python 不直接访问业务库，DraftSession 和数据变更通知仍由 Electron 管理。`agent.generate_chat`、计划、报告和方向检测等模型能力不注册为 MCP 工具，继续直连 Automation HTTP。FastMCP 不是授权凭证，Runtime 在进入 adapter 前仍必须完成白名单、计划批准和 interrupt 校验。Automation requestId 穿透 MCP proxy，取消交给当前活动 transport；`--tool-transport http` / `NOVEL_AGENT_TOOL_TRANSPORT=http` 保留故障回退。
61. `AgentContextAssembler` 第一增量采用“完整历史持久化、单次调用即时压缩”：Renderer 与 Python Runtime 不再按固定消息条数截断，Electron 根据当前 Provider、模型窗口、输出预算、系统提示和安全余量重新组装每次输入。`contextWindowTokens=0` 表示使用保守模型档案，用户可在 HTTP 或 MCP CLI 设置中显式覆盖；覆盖值只影响后续请求，不修改会话。当前请求、用户长期约束、计划/审批、工具发现和 artifact 引用按优先级进入 `agent-context-v1` JSON；旧消息以带 `sourceMessageIndex/sourceRange` 的确定性滚动摘要表示。首版摘要只存在于本次模型输入与诊断消息元数据，不作为新的事实源持久化；带 messageId、版本和增量更新的持久摘要仍是后续增量。章节续写和创作素材继续由 `ContextBuilder` 选择小说上下文，再由同一组装器执行最终模型窗口预算。
62. 上下文压缩必须在会话时间线中可见。只有本次调用真实发生摘要、长消息/资料压缩或省略时，才在助手回答前插入“已压缩较早上下文/已压缩本次上下文”的 `system` 消息；点击后展示原文保留数、摘要数、未纳入数、输入预算、模型窗口和受影响资料。该消息随 AgentMessage 持久化，但 Renderer 向 Runtime 同步模型历史时必须过滤 `system` 消息，避免诊断提示参与后续推理。提示只展示预算事实，不展示隐藏思维链。
63. 每次 Agent 聊天模型调用都返回 `agent-context-v1` 诊断，并绑定到对应助手消息的 `metadataJson`；Inspector 上下文页展示模型窗口、输入/输出/安全预算、原文/精简/摘要/省略消息范围、长期约束数量和各资料 section 的纳入方式。诊断与 `contextReads` 一同随 AgentMessage 持久化，刷新后可恢复，但二者都不是后续模型历史正文。时间线压缩提示继续只在真实压缩时出现。
64. `PythonRuntimeClient` 的启动 Promise 是并发 health/invoke 的唯一启动门禁。子进程已 spawn 但健康检查尚未完成时，后续调用必须等待同一个 `startPromise`，不能仅凭 process/port 已赋值就访问端口；避免应用进入 Agent 工作区时并发初始化触发 `ECONNREFUSED` 和无效重启。
65. 稳定领域流程正式采用版本化 Toolchain 契约。Planner 步骤可声明 `toolchain={id, version, input}`，并与 `tools` 互斥；Planner 和 Runtime 复用 Python `ToolchainRegistry`，Runtime 对角色、版本、输入、原子工具只读属性和预算做最终校验。明确的当前章节一致性、前后矛盾或设定冲突任务在存在 chapter context 时由 Runtime 确定性路由到 `chapter.consistency_review@1.0.0`，开放式研究继续走动态工具探索。
66. Toolchain 继续运行在现有 LangGraph 原子推进图内。checkpoint 保存稳定 ID、版本、当前节点、已读结果、调用数、估算 Token 和 Artifact 引用；每次推进最多执行一个领域节点或一个底层 Tool。链级事件 `toolchain_started/node_started/node_completed/completed/failed` 负责折叠层级，底层 `tool_call/tool_result` 继续持久化并按 `stepId + toolName + nodeId` 合并，禁止投影成会话气泡。
67. TC-1 首批只读链固定为 `chapter.context@1.0.0` 和 `chapter.consistency_review@1.0.0`。前者允许可选资料源部分失败但目标章节缺失时 fail closed；后者只生成 `consistency_review` Artifact，不创建 DraftSession，并在无证据判断中强制保留 uncertainty。Toolchain 版本、结构化 ContextBundle/Review 和来源统计首期保存在 Artifact metadata，不新增数据库专用列。
68. 普通聊天意图统一采用 Python Runtime 内的 `IntentService.preflight -> 现有只读探索 -> IntentService.finalize`。Electron 模型返回的布尔值和 SemanticProposal 都是不可信建议；Runtime 只消费唯一 IntentDecision 的 `respond / clarify / plan`，不增加独立分类模型请求。
69. Intent Operation 是用户任务语义的稳定契约，支持有序复合操作。Toolchain 通过 `supportedOperations` 声明能力，Capability Matcher 只建议 ID、版本、原子 Tool 回退和角色；原关键词 Toolchain 路由停止参与决策。新增 Toolchain 不修改 IntentService 融合核心。
70. IntentService 的 requestedEffect 和 confidence 不构成授权。`chat_only` 保留用户原始副作用意图但禁止进入 Planner；普通输入框不能自动提交待审批回答；Planner、用户批准、Runtime 白名单和 DraftSession 审核仍是副作用边界。
71. 会话指代只继承上一轮持久化的结构化 Operation、deliverable 和建议角色，不从历史回复文本反向推断隐藏状态。明确的新任务动词和结构化入口优先于会话继承；模型在引用轮给出的冲突 Operation 不覆盖已解析引用。
72. requestedEffect 由独立 risk 模块聚合。`data_write` 在普通会话中降级为审核中心结构化确认提示，`external` 明确拒绝；两者保留原风险等级但不会生成可执行权限。没有注册 Operation 但模型请求规划时标记为 `unknown`，继续由 Planner/Runtime fail-safe 校验。
73. Toolchain `enabled=false` 时不暴露给 Planner、不参与 Capability Matcher 自动建议，显式解析返回 `TOOLCHAIN_DISABLED`。旧 TypeScript 聊天决策改写已退出 AiService 并删除，Electron 只产出 SemanticProposal，Python IntentService 是唯一最终路由决策者。
74. 所有 manifest 中的副作用工具先写入 SQLite `tool_invocations` 账本，再以持久化 requestId 发送。调用键固定由 `runId + stepId + method + canonical params hash` 组成；`succeeded` 可返回有界结果快照，`in_flight/unknown` 禁止重发。发送后的超时或异常无法证明未执行，因此统一标记 `SIDE_EFFECT_UNKNOWN`；Runtime 重启先把悬空 `in_flight` 转为 `unknown`，再让对应 Run fail closed，并提示用户检查审核中心后重新确认。工具超时也由同一 manifest 声明：普通读取默认 90 秒，草稿生成 240 秒，覆盖 Electron 210 秒生成上限，避免 Python/FastMCP 提前断开。
75. TC-2 草稿链固定为 `chapter.continuation@1.0.0` 与 `creative_asset.draft@1.0.0`。匹配链本身是唯一草稿生产者，Planner 不再追加原子生成步骤；章节链复用 ContextBundle、证据质量和方向 interrupt，素材链读取五类资料并在生成后调用现有校验接口。两者只创建 DraftSession 与 AgentArtifact，禁止调用 `draft.commit` 或正文保存。
76. P2 长范围分析固定为只读 `plotline.analysis@1.0.0`。范围只接受当前章、当前卷或整本小说；未明确时必须先触发 `analysis_scope` interrupt，Planner/模型写入的 `scope` 只是未授权提示，不能绕过用户原话或审批结果，整本范围不能由模型自行扩大。章节通过兼容分页的 `chapter.list(offset, limit, includeContent)` 分批读取，Lexical 正文只保存有界文本摘录；`maxChapters`、Tool 调用数和估算 Token 任一到限即停止并在 coverage 中记录省略。链只调用一次补充 RAG 和一次结构化综合，输出 `plotline_analysis` Artifact，不创建 DraftSession。模型证据 ID 必须属于实际输入中的情节线、覆盖章节或 RAG 来源，否则 Runtime 丢弃并保留不确定性。Python AutomationClient 对报告、一致性和情节线综合使用高于 Electron 外层窗口的方法级超时，避免 90 秒默认值提前中断长分析。
77. 长会话摘要固定为 `agent-conversation-summary-v1` 的可追溯投影，不是新的事实库。只有预算组装真实把旧消息表示为摘要或省略时才增量覆盖这些稳定 `messageId`；完整 AgentMessage 永不被摘要替换。摘要分开保存用户来源事实、明确决策、未决问题和旧助手 outcome，并只保存 Artifact 引用与短摘要。当前请求命中来源 ID、标题或关键词时，Electron 从完整消息/Artifact 中召回有界原文；旧助手 outcome 不得升级为项目事实。摘要 revision 与会话一起保存到 `contextSummaryJson`，模型切换只重新组装，不使摘要或会话失效。
78. 写作页进入 Agent 时，Renderer 的当前小说、卷、章节标题/ID 和可见正文组成显式 SelectionContext。当前 chapterId 对“这篇文章/本章/当前章”具有高于模型探索建议的确定性；Runtime 把冗余的 novel/volume/chapter 列表发现改为直接 `chapter.get`，IntentService 对已由当前选择满足的只读章节任务拒绝重复目标澄清。当前可见正文单独进入模型上下文，并优先于可能较旧的数据库正文。
79. 多章节连续续写不扩展 `chapter.continuation@1.0.0` 的单章语义，而是预留独立 `chapter.sequence_continuation` 批次链。批次必须显式确定锚点、数量、顺序和 append/rewrite 模式，建议首期限 1 到 5 章；先批准全局节拍，再顺序生成 N 个子 DraftSession，并提供逐章审核、部分失败、依赖过期和批量提交二次确认。整本小说范围首期只允许只读分析。
80. 多章节能力统一上移为 Agent 平台的 `AgentChapterScope` 范围层，作者、编辑、读者、世界观、考据和综合协作视角复用一次 `chapter.scope_context` 基础读取，再按角色投影上下文。详细逐章处理最多 20 章、默认每批 4 章；写作批次默认 2 章、最多 5 章。续写上下文沿用 `ContextBuilder`，默认保留最近 2 章全文、此前 8 章摘要、小说/卷摘要、大纲、实体规则、RAG 证据和当前未保存正文，并在每章生成后更新状态台账。读者使用严格顺序盲读投影。报告接受只创建修订任务；多章草稿必须经过节拍、计划和草稿审核，并按非过期前缀提交。完整契约见 [Agent 多章节处理 V1 需求](./multi-chapter-processing-requirements.md)。
81. Renderer 显式章节范围是计划执行的权威输入。它必须同时进入聊天 SelectionContext、计划和计划修订；Runtime 在模型计划构建或修订完成后重新校验并覆盖所有章节范围 Toolchain 输入。模型不能扩大、缩小、重排或用占位 ID 替换用户选择；团队专家列表也仅接受 Renderer 显式的合法角色。
82. （产品呈现部分已由决策 83 覆盖）多章节专家报告审核固定使用现有 360px Inspector，不因章节矩阵或长 finding 扩大右栏；矩阵水平滚动、finding 纵向展开。章节草稿原文/草稿对照仍可使用既有宽审核中心。报告的接受、暂缓、驳回使用 `reviewStatus/reviewRevision`，与草稿 committed/discarded 状态彻底分离。
83. 2026-07-21 起，整个 Agent 工作区采用“对话优先、详情按需、创作不中断”。本决策覆盖决策 82 中“完整报告审核固定使用 360px Inspector”的产品呈现约束：Inspector 改为可完全折叠的辅助面板，首次进入默认折叠并记住工作区选择；新事件不得自动展开。报告摘要、建议选择、修订发起、进度和结果确认必须在对话中完成，完整证据和长 diff 由用户主动打开专注审核视图。
84. CloudDream Novel Agent 的唯一产品用户是小说创作者。`writer/editor/reader/worldbuilding/research_rag/supervisor` 是 AI 工作视角而非不同的人类用户角色，只改变分析方法、能力边界和输出重点；交互复杂度只能由任务范围、风险和可逆性决定。所有视角使用同一套对话、Inspector、建议处理和草稿审核语言。
85. 同一报告中选定的建议通过原对话中的单个 `RevisionWorkBatch` 连续处理，不再为每条 RevisionTask 单独生成计划和新建会话。折叠进度显示 `第 N/M 项修订`，展开项对应用户可理解的修订事项；工具、节点和重试只进入事项明细。相同章节或依赖事项可共享草稿生成单元，但保留逐项来源和验证状态。
86. 创作者点击“修改选中项”构成对固定范围、可逆草稿生成的明确授权，系统可以持久化内部执行意图而不再要求额外审批形式化计划；跨多章结构调整、主线重排、大段删除或范围不明确时仍必须确认修订方案。所有正文写回始终需要最终草稿或 diff 审核。RevisionTask 只有在写回并完成针对性复核后才能自动 `resolved`；手动解决必须记录原因，生成计划本身不代表问题已解决。
87. 创作者界面不直接暴露 finding 审批术语。`帮我修改 / 稍后处理 / 忽略建议` 分别映射内部 `accepted / deferred / rejected`；“帮我修改”只代表把问题加入修订范围，不代表接受模型推荐方案。每项允许携带创作约束，缺少明确目标章节时必须先补充范围。
88. 所有 AI 工作视角共享一个轻量“待改清单”，不存在编辑或团队专用任务后台。默认用户状态固定为 `待处理 / 处理中 / 已完成 / 已失效`；内部 `open / planned / deferred / resolved / closed / stale` 继续服务持久化、恢复和审计。清单可以按章节、人物、情节线和来源视角归类，但继续处理时必须回到对话。
89. 多视角审核只向对话发布一份综合结果。Supervisor 在发布前去重、按创作影响排序并显式保留真实冲突；首屏显示 3 至 5 项，专家子 Artifact 和完整证据按需展开。一次审核到修订默认只保留报告卡、原位进度和最终草稿卡三块稳定内容。
90. `full_control` 的后续产品语义改为“专注执行”，不是无约束 YOLO。它可以自动读取、分析、选择 AI 工作视角并生成固定范围的可逆草稿，同时合并必要问题；正文写回、版本冲突和 `SIDE_EFFECT_UNKNOWN` 对账仍是不可绕过的硬边界。
91. 现有 DraftSession 继续作为草稿对比的唯一事实源，但审核体验必须从全文左右对照演进为修改摘要与逐处高亮 diff 优先。单章和多章写回都固定来源版本/哈希；写回后提供带版本校验的一次操作级撤销，存在后续编辑时拒绝覆盖。
92. 智能工作视角列入后续增量。实现复用现有 IntentService `suggestedRole`、Operation Registry 和 Capability Matcher，不增加分类模型调用；Renderer 增加 `auto` 状态、实际视角提示和手动覆盖，手动覆盖在当前任务内优先。
93. 待改清单只接收稍后处理、暂停或未完成事项；当前对话立即完成的建议不先入清单，完成项自动归档。
94. 所有待入库或待应用的 Agent 产物采用统一“审核包”语义。一次 Run 产出的多类型变更，例如情节、角色、设定、伏笔、文章段落或章节草稿，可以逐条添加审批意见和局部重写，但最终入库、应用或写回必须按审核包整体提交；任一类型仍未通过时不得只提交同包内另一类型，避免项目状态与产物上下文错位。报告类产物是例外：报告本身不入库，审批结果统一派生或更新修订任务。
95. 审批意见是审核层本地草稿，不等同于普通会话消息、通过确认或选择框。意见挂载在具体审核锚点上，例如素材条目、结构化字段、行、段落、diff 块、章节或批次子项；保存后显示为未发送的本地审批意见，并按审核包版本持久化。审核页不增加逐项通过或准备提交勾选框：没有审批意见的内容默认认可，有意见的锚点自动进入 Agent 重写范围；存在未发送意见时禁止提交当前版本，清空意见后恢复提交资格。报告中的“帮我修改 / 稍后处理 / 忽略建议”仍作为修订任务处置保留，不属于本条取消的确认勾选。
96. “发送审批意见给 Agent”是明确执行授权边界。用户可以选择“只发到会话讨论”而不触发生成，也可以选择“开始重新生成”创建新的 Run、Artifact 和 DraftSession。Agent 根据所有审批意见重新输出审核包的新版本，不自动入库、不自动写回正文，也不得通过更新旧 DraftSession 覆盖历史产物。完成后回到原会话展示“新版本已准备好”。
97. 审核版本回看复用会话历史产物，不增加独立版本对比页。会话必须让旧 Run 的产物卡重新打开其对应 Artifact、DraftSession 或 DraftBatch；已被替代、已提交和已丢弃版本只读。现有 `conversation.runs` 与旧产物引用已经持久化，但 Renderer 仅允许最新 Run 打开审核，本轮需通过显式审核来源选择补齐历史入口。
98. 多章审批意见必须整批发送，并在发送前确认重生成范围。`仅重写有意见的章节` 为所有被批注章节生成新版本，保留其他草稿并统一执行连续性复核，只有检测到情节、角色状态、时间线、伏笔、物品状态或结尾钩子冲突时才传播后续 `stale`；`从最早意见章节起重新生成` 沿用当前回滚状态台账并重置全部后续草稿的保守机制。Agent 可以推荐范围，但不能替用户静默扩大范围。
99. 右侧 Inspector 的“审核”Tab 是本轮统一审核入口；会话产物卡负责进入审核、运行反馈和历史版本回看。新审批意见、重新生成和新版本完成均不得自动展开 Inspector。已确认 Stitch Screen 只约束审核内容区与操作逻辑，不引入新的一级审核页面。
100. 历史产物属于当前小说并来源于某个会话，不采用仅随会话存活的所有权模型。`novelId` 负责持久归属，`sourceConversationId/sourceRunId` 负责来源导航，`targetRefs` 负责章节与素材关联，`revisionOfArtifactId/reviewRequestId` 负责版本链。首版只在来源会话时间线和当前会话 Inspector“产物”Tab 提供入口，不建设全局产物中心；删除或归档会话不得级联删除 DraftSession、Artifact、审批意见、写回记录和撤销依据。
101. Intent Operation 采用“候选召回、请求效果裁决、计划不可扩权”边界。规则和模型只能提出候选；诊断结果、建议、准备度、列表/报告产物、被否定动作和合理后续步骤均不构成草稿授权。`IntentDecision.requestedEffect` 是 Planner 可展开的最高请求效果，不是执行权限；Plan 持久化该上限，Planner、计划注册、修订和执行前都必须拒绝更高 sideEffect 的 Tool/Toolchain。AI 工作视角只影响分析方法、能力匹配和负责人，不得改变 Operation、deliverable 或 requestedEffect。同一句只读请求在团队、作者、编辑、读者、世界观和研究视角下必须保持相同副作用边界。

## 第一版明确不做

- 完整 Skill 市场。
- 热加载 Skill。
- 多客户端并发 Agent 产品化。
- 自动多轮重写闭环。
- 复杂知识图谱。
- Agent 直接批量修改正文。
- Token 级文本流式输出。
- Renderer 直连 Python。
- 外部 MCP 权限门禁。
- 独立 `approve_plan(runId)` 接口。
- `/plan` 或 `/chat` 作为用户显式命令入口。
- `完全控制` 自动执行模式。
- 直接照搬 Codex App 的计划模式命令交互。
- Python 进程重启后自动重放中断在副作用工具内部的 `running/cancelling` run；当前只恢复明确停在 interrupt 的 `waiting_approval`。

## 待评估问题

- 工具 manifest 如何统一生成，并同时服务外部 MCP 和内置 Agent。
- `chapter.save`、编辑器保存、`draft.commit` 如何合并为同一后处理路径。
- `agent_graph.db` 与 `agent_state.db` 长期保持分层还是在迁移工具成熟后合并。
- FastMCP proxy 与 Automation HTTP adapter 的切换边界。
- Agent 长期记忆是否独立库、是否需要向量索引。
- Stitch MCP 写入失败时如何刷新当前会话的 API key/header 状态。
