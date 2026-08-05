# Agent 上下文压缩与长会话连续性需求

版本：v0.5<br>
日期：2026-07-30<br>
状态：需求决策已确认；v0.5 已解除剩余接口歧义，P0 已实现，P1 主体已实现并处于验收中，P2 部分实现<br>
适用范围：`AgentContextAssembler`、`AiService`、`AgentConversationStore`、Agent Workspace、模型 Provider、章节与附件上下文、长会话恢复和上下文诊断。

源码核对基线：`novalEditor` 当前工作区与本地 `D:\aiproject\free-code`，核对日期为 2026-07-30。本文中的“当前实现”以第 5 节核对时的生产调用链为准；某个类、Schema 或测试文件已经存在，不代表第 17、18 节的端到端契约已经验收完成。

v0.5 修订说明：保留 v0.4 的 ledger、generation、分块重建和诊断决议，并补齐三条端到端接口契约：依赖变化可以在 coverage 不推进时提交同 generation 的 dependency refresh revision；已持久化的当前用户请求必须凭稳定 message ID 从历史候选中排除并在受保护分区恰好注入一次；共享压缩任务必须绑定具体 CAS 快照、操作类型、Provider/模型及目标来源身份，非等价请求不得错误共享结果。

## 0. v0.5 阻塞点决议

以下决议是后续实现和验收的前置条件；若其他章节存在歧义，以本表和第 6、10、18 节的强制约束为准：

| 阻塞点 | 决议 | 可验证结果 |
| --- | --- | --- |
| ledger 永久引用 `SummaryEntry`，但模型可见投影又必须长期有界 | 删除 ledger 到投影条目的永久引用；`SummaryEntry.id` 只在当前 revision 内有效 | 淘汰或合并投影条目后不存在悬空 ID，原消息仍可由 ledger gist 和完整历史召回 |
| 后续纠正需要改变旧消息语义，但同 generation ledger 又要求不可变 | 纠正关系只由新 user ledger 条目的 `supersedesMessageIds` 前向指向旧 user 消息 | 旧条目逐字段不变，纠正、否定和新语义可同时保留 |
| 消息编辑、删除或重排后，旧 ledger/hash 已无效，无法继续 append-only | 引入 `generation`；同 generation 只追加，来源变化或显式质量重建创建下一 generation | 普通更新不改变 generation；完整重建严格 `generation + 1` 并重新校验整个目标 coverage |
| 超长历史无法在一次 Compactor 请求内完成整代重建，又不能发布半成品 | 按连续原子单元生成非权威分块候选；所有分块完成后只做一次最终 CAS | 任一中间结果、取消、超时、来源再变化或 CAS 冲突均不改变权威摘要和 coverage |
| 完整 ledger 随会话线性增长，每轮重发会令 Compactor 输入失去上界 | 模型输入仅包含旧/候选语义投影、新增前缀和确定性召回的有界历史摘录 | Compactor 和主模型 payload 均不包含完整 ledger，ledger 大小单独进入存储诊断 |
| 大量短 user 消息可能令 ledger delta 输出先于输入达到上限 | 候选选择同时受 Compactor 输入预算和最坏情况结构化输出预算约束 | 在发起请求前即可证明 prompt 与最坏情况输出都不超过各自预算 |
| “有界投影”若没有基线数值则无法验收 | P1 使用第 10.1 节的量化上限；模型档案只能收紧，放宽必须同步更新需求、Schema 上限和 8K/32K/128K 测试 | 长会话多 revision 后，条目数、单条文本、来源引用和历史摘录仍稳定受限 |
| dependencyHash 变化时可能没有任何新消息可推进，现有增量校验却要求非空 ledger delta | 定义同 generation 的 dependency refresh revision；coverage/sourceHash/ledger 完全不变，只重建受影响投影和来源指纹并推进 revision | 仅项目/Artifact 变化也能清除 stale 状态；不会伪造新 coverage、空转 generation 或改写旧 ledger |
| 当前请求在调用前已经持久化时，可能同时进入历史候选和受保护分区 | 用户驱动调用必须携带稳定 `currentRequest.messageId`；Coordinator 先按该 ID 从历史候选中排除，再在受保护分区按原持久化正文恰好注入一次 | 当前请求不会被压缩、coverage、召回或重复计数；ID/正文不一致时在调用 Provider 前失败 |
| 仅按会话或 revision 共享任务会让不同模式、模型或 CAS 快照错误复用结果 | 共享任务身份绑定 `summaryCasToken` 摘要、操作类型、目标 generation、来源/依赖哈希、当前请求身份、Provider/模型和 Prompt 版本 | 只有完全等价请求共享底层任务；非等价 waiter 等待后重新读取快照并重新决策 |

## 1. 背景与问题定性

CloudDream Novel Agent 已经具备长会话上下文管理第一版：

- `AgentConversation` 和 `AgentMessage` 保存完整会话，不因模型窗口不足删除原消息。
- Electron Main 在每次模型调用前根据模型窗口、输出预算、系统提示和安全余量组装 `agent-context-v1`。
- 最近消息保留原文，较早消息可使用确定性滚动摘要；长资料可以精简或省略。
- `agent-conversation-summary-v1` 保存摘要 revision、来源消息、用户决策、未决问题、旧助手 outcome 和 Artifact 引用。
- 当前请求可以按来源 ID、关键词和 Artifact 引用召回有界原消息或产物内容。
- Renderer 展示本次调用的压缩、预算和来源诊断，诊断消息不进入后续模型历史。

这套方向适合小说编辑器，必须保留。它与编码 Agent 的核心区别是：小说正文、设定、人物资料、草稿和报告已经拥有独立的持久化事实源，聊天摘要只应承担会话连续性和召回索引，不应成为新的项目事实库。

但当前第一版仍存在一个必须优先修复的语义丢失风险：

1. `AgentContextAssembler` 把以摘要表示的消息和本轮完全省略的消息共同加入 `newlyCoveredMessageIds`。
2. `advanceAgentConversationSummary` 只用关键词规则把部分消息提取为事实、决定、问题或 outcome。
3. 下一轮组装时，所有 `coveredMessageIds` 都从默认历史中排除。
4. 因此，一条未命中关键词规则的关键创作信息可能既没有进入持久摘要，也不再进入后续默认上下文，形成静默且长期的语义丢失。

例如“她把钥匙藏在钟里”可能是后续剧情所需的关键事实，但它不一定命中当前事实或决定关键词。系统不能因为本轮预算不足就把该消息标记为“已经总结”。

本需求不是重做聊天存储，而是在当前完整历史、可追溯摘要和按引用召回基础上，引入适合本产品的压缩边界、领域语义摘要、近期原文保护、压缩后回检、失败熔断和微压缩机制。

## 2. 已确认决策

1. **完整历史始终是事实源。** 压缩只改变单次模型输入和派生摘要，不删除、覆盖或改写 `AgentMessage`、Artifact、Run、审批答案和正文数据。
2. **借鉴机制，不复制 Claude Code 实现。** 参考 `free-code` 的自动压缩缓冲、session-memory/partial compact 近期原文保留、API 原子边界、压缩后消息体回检和连续失败熔断；本项目把这些思路改造为最终 payload 回检和小说领域摘要，不复制 JSONL 链重连、代码文件恢复、Skill 重注入或编码任务摘要模板。
3. **当前用户请求不可做有损压缩。** 当前消息正文必须完整进入模型输入。若单条请求本身超过硬预算，返回可操作的类型化错误，引导改用附件、缩小范围或分批处理，不能静默截断。
4. **结构化运行状态不可由会话摘要替代。** 当前计划、SelectionContext、待回答问题、待审批状态、与当前活动对象直接关联的用户原始答案、活动 Run、Draft Operation 和 Artifact 引用继续从各自持久化对象注入，始终高于普通聊天历史；已完成旧事务的答案保留权威来源并按需召回。
5. **覆盖和省略是两种状态。** `covered` 表示消息已经通过验证的语义压缩流程纳入连续前缀：每条用户消息都有不可变 ledger 索引，当前仍重要的语义进入有界投影，其他细节仍可从 ledger 和原消息召回；它不表示每条历史消息永久对应一个当前 `SummaryEntry`。`omitted` 只表示本轮没有进入模型输入。省略消息不得推进持久摘要覆盖边界。
6. **持久摘要是可追溯投影，不是权威记忆。** 摘要中的每个事实、决定、问题、进展和产物必须带来源 ID；需要具体细节时从完整消息、Artifact 或项目数据重新召回。
7. **只压缩连续的较早前缀。** 语义压缩以完整会话回合为边界，保留近期连续原文尾部，不在历史中制造难以解释的随机空洞。
8. **压缩后必须重新预算。** 压缩成功不等于结果可用；系统必须使用最终 payload 重新计数，并确认低于硬预算且保留足够回差，避免下一轮立即再次压缩。
9. **压缩失败不得破坏旧状态。** 超时、取消、无效 JSON、来源校验失败或并发冲突时保留上一 revision，不推进 coverage，不循环调用压缩模型。
10. **模型切换只触发重新组装。** 更换 Provider 或模型不会删除会话或使摘要失效；新请求按新窗口重新选择近期原文、摘要和召回内容。
11. **用户能看到压缩事实，但看不到隐藏推理。** 时间线和 Inspector 展示触发原因、覆盖范围、保留/省略数量、预算和失败降级；不展示摘要模型的分析草稿或思维过程。
12. **只有验证通过的 v2 coverage 才能排除默认历史。** 既有 v1 `coveredMessageIds` 只可用于摘要展示、诊断和召回，P0 起不得再作为历史过滤边界；首次 v2 压缩必须从完整消息重新建立可信前缀。
13. **持久摘要只有一个写入者。** 启用 Coordinator 后，只有 Electron Main 中的 `AgentContextCompressionCoordinator -> AgentConversationStore.compareAndSwapContextSummary` 可以更新 `contextSummaryJson`；Renderer 的普通会话保存不得携带或覆盖该字段。
14. **持久化会话 ID 与 Runtime 会话 ID 明确分离。** `storageConversationId` 对应 SQLite `AgentConversation.id` 和 Renderer 的 `agentConversationId`，用于锁、幂等、查询和 CAS；`runtimeConversationId` 只用于 Python Runtime 连续性，禁止作为摘要持久化主键。
15. **边界建立在显式原子单元上。** 不能仅按 user/assistant 角色交替猜测回合；消息顺序、结构化问答、审批、Run、工具结果和 Artifact 的关联必须先投影成稳定的 `ContextAtomicUnit`，coverage 只能落在已关闭单元之间。
16. **硬预算只能使用可证明不会低估的计数结果。** 精确 tokenizer/count 优先；不可用时使用 Provider 能力配置声明的保守上界计数器。模型名称只用于选择已登记的推荐档案，不是准入白名单，也不得从名称中的 `32k`、`1m` 等字样猜测能力。普通启发式估算可用于诊断和排序，但不得单独支撑“最终 payload 不超硬预算”的验收。
17. **来源索引与模型可见摘要分层。** 完整 user ledger 可以随 coverage 线性增长并持久化，但其不可变字段只证明消息已被逐条检查并提供召回入口，不永久引用当前投影条目。Compactor 只接收旧语义投影、本次 ledger delta 所对应的新前缀，以及为理解纠正/指代而确定性召回的有界历史摘录；不得在每次压缩时重发完整 ledger，也不得把 ledger 存储大小计入模型可见摘要 Token 上限。
18. **模型可见摘要是当前状态，不是完整审计日志。** `semanticProjection` 中的条目和条目 ID 只在当前 revision 内有效；后续 revision 可以合并、重写或淘汰已经不影响当前协作的条目。跨 revision 的永久追溯依赖来源消息、ledger 和项目来源指纹，不依赖指向已淘汰 `SummaryEntry` 的悬空 ID。
19. **ledger 不可变性以 generation 为边界。** 正常 coverage 增量只增加 revision，同一 generation 内旧 ledger 只能逐条保留并追加 delta。消息编辑、删除、顺序变化或用户显式质量重建必须创建下一 generation，从权威完整消息重新计算 coverage、投影、ledger 和哈希；只有该完整重建路径可以替换旧派生 ledger。
20. **依赖刷新与消息 coverage 解耦。** Artifact 或项目来源变化而消息前缀未变化时，允许提交 `dependency refresh` revision：revision 严格加一，generation、coverage、sourceHash 和完整 ledger 逐字段不变，`userMessageLedgerDelta=[]`，只更新失效后的 `semanticProjection`、来源指纹和 dependencyHash。它是 Coordinator 的明确操作类型，Compactor 结果仍使用 `mode=incremental`，不得伪装成 coverage 增量或 generation 重建。
21. **当前请求以稳定消息身份恰好注入一次。** 用户驱动调用中的 `currentRequest.messageId` 必须对应当前会话已持久化的 user `AgentMessage`，且 `content` 与该消息的规范化正文一致。Coordinator 和 Assembler 必须按该 ID 从历史、召回和压缩候选中排除，再把同一正文放入受保护分区；维护任务使用独立 action，不伪造用户 message ID。
22. **共享任务只复用等价工作。** 同一 `storageConversationId` 仍串行化摘要更新，但只有绑定同一 CAS 快照、操作类型、目标 generation、目标 sourceHash/dependencyHash、当前请求身份、Provider/模型、模型档案和 Prompt 版本的 waiter 才能共享结果。任一字段不同的请求只能等待当前任务结束，然后重新读取 Store 并重新决策。

## 3. 目标与非目标

### 3.1 目标

- 在 8K、32K、128K 及更大模型窗口下稳定继续同一会话。
- 保证当前用户请求、未决输入、审批、计划、项目选择和其他受保护状态不因压缩丢失。
- 使用小说创作领域的结构化语义摘要维持意图、约束、设定、人物状态、剧情连续性和当前工作进展。
- 始终保留一段近期完整原文，并按完整回合保护 user/assistant 与相关产物结果的关联。
- 对已持久化的长工具结果、章节正文、附件和 Artifact 做引用式微压缩，减少重复发送。
- 压缩行为可预测、可诊断、可取消、可恢复，并能在失败后安全降级。
- 通过完整历史和来源索引召回摘要未展开的具体细节。

### 3.2 非目标

- 不删除或物理裁剪 SQLite 中的历史消息。
- 不把聊天摘要升级为人物、世界观、章节正文或其他项目实体的权威存储。
- 不在第一期引入向量数据库；先使用稳定 ID、Artifact 引用、摘要条目和全历史词法召回。
- 不实现与 Claude Code 相同的 JSONL compact boundary、父子 UUID 重连或 Transcript 文件回放协议。
- 不在第一期提供 `/compact` 命令、从某条消息开始压缩或压缩到某条消息等手动局部压缩 UI。
- 不为了压缩开放工具调用。压缩模型只产生经过 Schema 校验的文本/JSON，不读写项目数据。
- 不在本需求中改变 DraftSession、Run、审批或正文写回的授权边界。

## 4. 术语

| 术语 | 定义 |
| --- | --- |
| 硬输入预算 | 模型窗口扣除输出、系统提示、安全余量及 Provider 保留量后，本次 payload 绝不能超过的上限 |
| 触发预算 | 低于硬输入预算的高水位；候选上下文达到该值时提前压缩 |
| 目标预算 | 压缩后希望达到的低水位；必须明显低于触发预算，形成回差 |
| 受保护上下文 | 当前请求、未决输入/审批、当前计划、SelectionContext、活动 Run、与当前未决事务/计划/Run 直接关联的用户原始答案及必要 Artifact 引用 |
| 近期原文尾部 | 压缩后仍按原文保留的连续最近回合 |
| 压缩前缀 | 位于近期原文尾部之前、按完整回合选出的连续较早消息 |
| 持久摘要 | 对压缩前缀的版本化当前状态投影及来源索引；不是全部历史语义的永久副本 |
| 微压缩 | 不调用摘要模型，把可重新读取的大块内容替换成短摘录、内容哈希和稳定来源引用 |
| 本轮省略 | 因预算不足未进入当前请求，但未被标记为持久摘要已覆盖的内容 |
| 压缩边界 | 某个摘要 revision 已覆盖到的连续消息终点及其来源指纹 |
| 摘要 generation | 一条共享同一来源历史假设的增量摘要链；来源消息变化或显式完整重建时递增，允许重新生成派生 ledger |
| `storageConversationId` | SQLite `AgentConversation.id`；Coordinator 锁、幂等键、摘要读取与 CAS 的唯一会话标识 |
| `runtimeConversationId` | Python Runtime 的会话连续性标识；可以重建或为空，不参与摘要 CAS |
| 原子上下文单元 | 由消息及结构化状态来源组成的稳定顺序单元；只有已关闭单元之间可以成为 coverage 边界 |
| 模型可见摘要 | 注入主模型或作为旧摘要交给 Compactor 的有界当前状态投影，不包含完整 user ledger；条目 ID 只在当前 revision 内有效 |
| 来源索引 | 持久化的不可变 user ledger、Artifact/项目来源指纹及召回入口，用于校验、诊断和召回，默认不注入模型 |
| 依赖刷新 revision | 消息 coverage 不变时，因 Artifact/项目依赖变化而在同 generation 内生成的新 revision；只更新投影、来源指纹和 dependencyHash，ledger 不变 |
| 动态上下文 Token | 会随当前请求变化、可参与压缩分配的消息、摘要、受保护上下文、召回和 section Token；不含固定 system/tool/Provider 包装 |
| Provider 总输入 Token | 序列化后实际发给 Provider 的完整输入 Token，包括固定 system/tool/Provider 包装和动态上下文；它与动态上下文 Token 必须分别回检 |

## 5. 当前实现核对

### 5.1 应保留的能力

| 能力 | 当前实现 | 后续要求 |
| --- | --- | --- |
| 完整消息持久化 | `AgentConversationStore` 保存全部消息 | 保持不变，压缩路径不得删除消息 |
| 统一预算入口 | `AiService -> AgentContextAssembler` | 保持单一最终预算入口 |
| 模型窗口档案和用户覆盖 | `resolveAgentContextWindow` | 改为可维护的 Provider/模型能力表，估算仍保留兜底 |
| 来源诊断 | `historySources`、`sectionSources` | 扩展触发、边界、压缩模式、前后 Token 和失败原因 |
| 持久摘要 revision | `contextSummaryJson` | 升级为 v2 连续边界和领域语义摘要 |
| Artifact 引用召回 | 摘要引用和标题/ID 匹配 | 保留并扩展到覆盖前缀的全历史召回 |
| 可见压缩提示 | 时间线 `context_compression` system message | 保留；增加降级和重新压缩状态，但不污染模型历史 |

### 5.2 必须修正的能力

| 当前行为 | 风险 | 要求 |
| --- | --- | --- |
| `summaryIndexes + omittedIndexes` 共同推进 coverage | 未摘要内容永久退出默认上下文 | P0 起禁止 omitted 推进 coverage |
| 持久摘要主要由正则分类和定长截断生成 | 小说事实和隐含创作约束容易漏掉 | 引入领域化语义 Compactor；确定性摘要只作临时降级 |
| 已覆盖消息在组装前全部过滤 | 摘要漏项后难以自然恢复 | 召回必须能搜索完整覆盖前缀，不只搜索摘要条目 |
| 既有 v1 `coveredMessageIds` 会继续参与历史过滤 | 修复新增 coverage 后，旧会话仍可能永久排除曾被误覆盖的消息 | P0 起 v1 coverage 仅作提示和召回；只有验证通过的 v2 coverage 可以过滤默认历史 |
| `AiService` 先执行 `trimText(payload.message, 8000)`，Assembler 随后还可对 `currentRequest` 执行 `compactValue` | 最新用户意图可能在两个边界被静默改写 | 两处有损路径都必须移除；当前请求完整保留，超限返回类型化错误 |
| Renderer 的 `conversationContext` 只传当前计划、部分 Run/审批和产物；会话级 `pendingUserInput`、活动对象关联的 `userInputResolutions` 及活动 Run 的 `pendingUserInput` 未进入该对象，且 `conversation-state` 仍是可压缩的 `high` section | 恢复提问、原始答案和授权状态可能缺失或被压缩 | 建立独立受保护分区，显式传递未决输入、活动对象关联的原始答案、审批、计划、范围和活动 Run 身份 |
| 多个分区采用固定百分比，名义上限合计超过 100% | 依赖事后删除收敛，极端输入不稳定 | 改为带 floor/cap 的动态优先分配器 |
| 压缩完成后只看估算 payload 是否勉强入窗 | 可能下一轮立即重压 | 同时校验硬预算、目标预算和 `wouldRetriggerNextTurn` |
| 没有压缩级连续失败状态 | Provider 故障时可能反复尝试 | 每会话/模型组合加入最多三次连续失败熔断 |
| Renderer 整对象 upsert 会无条件覆盖 `contextSummaryJson` | Coordinator 的 CAS 成功结果可能被较旧 Renderer 状态回写覆盖 | 建立 Main 单写者；普通 upsert 保留数据库当前摘要，摘要只通过独立 CAS API 更新 |
| 系统同时存在 SQLite 会话 ID 和 Runtime 会话 ID | 锁、幂等或 CAS 可能命中错误对象 | Renderer -> Runtime -> Main 顶层显式传递 `storageConversationId`，Coordinator 禁止从 SelectionContext 或 runtime ID 猜测 |
| 历史消息没有可直接验证问答、审批和 Run 关联的原子边界描述符 | 仅凭角色交替可能切开结构化交互或无法稳定复现边界 | 在选择压缩前缀前构建带稳定顺序和来源引用的 `ContextAtomicUnit[]` |

## 6. 强制不变量

以下不变量属于 P0/P1 验收门槛，任何优化不得绕过：

### 6.1 数据不变量

1. 压缩前后 `AgentMessage` 数量、ID、角色、正文和创建时间保持不变。
2. Artifact、Run、pending request、approval response、Draft Operation 和 SelectionContext 不从自由文本摘要反向重建。
3. 持久摘要只引用当前小说、当前会话中真实存在的消息、Artifact 和带版本/内容哈希的项目来源。
4. 旧助手回复只能标记为 `assistant_outcome`、`proposal` 或工作进展，不得自动升级为 `canon_fact` 或用户决定。
5. 消息发生编辑、删除或顺序变化时，coverage 根据 sourceHash 失效并进入下一 generation：可以复用首个变化点之前重新校验后完全一致的派生前缀，但必须从权威完整消息生成并校验新 generation 的完整 coverage、投影和 ledger，不能把它伪装成同 generation 增量；Artifact 或项目数据发生编辑、删除、版本更新时，根据 dependencyHash 使依赖条目失效并重新投影，不反向修改 coverage 中的原消息。
6. dependency refresh 只能更新由项目依赖派生的投影和来源指纹；不得改变当前 generation、coverage、sourceHash 或任何已有 ledger 字段，也不得把项目新值反写为新的 user 消息语义。

### 6.2 覆盖不变量

1. coverage 只能沿持久稳定 sequence 单调推进到一个由已关闭 `ContextAtomicUnit` 组成的连续前缀边界。
2. coverage 不得切在 user/assistant 回合中间，也不得拆开待处理问答、审批请求与答案；遇到 open 或无效原子单元不得跨越推进。
3. 本轮 `omitted`、低优先级 section 删除或任意字符串截断不得推进 coverage。
4. 新 coverage 只能在摘要 Schema、来源 ID、来源角色、稳定 sequence、原子边界、sourceHash 和 dependencyHash 全部校验成功后提交。
5. 摘要失败或 CAS 冲突时，旧 revision 与旧 coverage 原样保留。
6. dependency refresh 不属于 coverage 推进：允许 `newlyCoveredMessages=[]` 和 `userMessageLedgerDelta=[]`，但仅限旧 coverage/sourceHash 已重新验证且逐字段保持不变的显式刷新路径；普通增量仍必须推进至少一个完整原子单元。

### 6.3 输入不变量

1. 当前用户消息经输入层既有空白规范化后的持久化值、Assembler 输入值和 Provider payload 值必须同源一致；不得再经过 `trimText(..., 8000)`、`compactValue`、尾部截断或摘要替换。
2. 未解决的 `pendingUserInput`、`pendingApproval`，以及与当前未决事务、当前计划或活动/恢复中 Run 直接关联的原始答案始终进入受保护分区。已完成旧计划/Run 的答案保留在权威对象和来源索引中，按需召回，不永久内联到硬保底分区。
3. 当前计划、显式章节范围、当前章节 ID 和未保存正文身份始终进入受保护分区；大正文可以通过已有 ContextBuilder/引用策略控制，但目标身份不能丢失。
4. 最终 payload 必须小于等于硬输入预算；不能依赖 Provider 的 context overflow 错误作为正常控制流。
5. 若仅受保护上下文本身已超过硬预算，调用必须在本地失败并返回 `CONTEXT_PROTECTED_INPUT_TOO_LARGE`，说明最大值、当前值和可缩小的来源。
6. 已持久化的当前 user 消息必须按稳定 message ID 从历史、召回、近期尾部和压缩候选中排除，并在受保护分区恰好出现一次。ID 不存在、角色不是 user、所属会话不符或规范化正文不一致时返回 `CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH`，不得靠内容相等猜测或继续调用 Provider。

## 7. 目标架构与职责

```text
完整 AgentConversation / 结构化运行状态 / 项目上下文
  -> ContextAtomicUnitBuilder
       1. 使用稳定消息顺序生成原子单元
       2. 关联问答、审批、Run、工具结果和 Artifact 来源
       3. 标记单元是否已关闭以及允许的 coverage 边界
  -> AgentContextCompressionCoordinator
       1. 计算模型预算和压缩触发状态
       2. 应用无损投影与微压缩
       3. 必要时选择连续较早前缀生成语义摘要
       4. 校验并 CAS 持久化摘要 revision
       5. 处理失败、取消、熔断和降级
  -> AgentContextAssembler
       1. 动态分配各分区预算
       2. 注入受保护上下文
       3. 注入持久摘要、近期原文和按需召回
       4. 删除低优先级可选 section
       5. 生成最终 agent-context-v1/v2 payload 和诊断
  -> TokenCounter
       1. 优先使用 Provider 精确计数
       2. 不可用时使用经模型档案验证的保守上界
       3. 对最终 payload 再次计数
  -> Provider
```

Coordinator/Assembler 的受保护输入必须使用显式顶层契约，不能继续把它埋在可压缩的 `conversationContext: Record<string, unknown>` 中。以下字段名称可随现有共享类型落地，但信息边界不可弱化：

```ts
interface AgentProtectedContextInput {
  storageConversationId: string;
  currentRequest: {
    messageId: string;
    content: string;
  };
  selectionContext: {
    novelId: string;
    volumeId?: string;
    chapterId?: string;
    chapterScope?: AgentChapterScopeSelection;
    unsavedEditorSnapshotRef?: {
      sourceId: string;
      chapterId?: string;
      contentHash: string;
      characterCount: number;
    };
  };
  currentPlan: AgentPlan | null;
  activeRun: {
    runId: string;
    planId: string;
    status: AgentRunStatus;
    currentStepId?: string;
    draftSessionId?: string;
    draftBatchId?: string;
    draftOperationId?: string;
    pendingUserInput?: AgentUserInputRequest | null;
    pendingApproval?: AgentApprovalRequest | null;
    artifactRefs: ArtifactSummaryRef[];
  } | null;
  conversationPendingUserInput: AgentUserInputRequest | null;
  relatedUserInputResolutions: AgentUserInputResolution[];
  relatedApprovalResponses: AgentApprovalResponse[];
}
```

- `currentRequest.content` 使用本轮已经持久化/规范化的同一字符串，后续各层只能引用，不能重新截断或摘要。
- 对用户驱动调用，Renderer -> Runtime -> Main 顶层契约统一使用 `currentRequest.messageId`，它必须等于当前会话中该条 user `AgentMessage.id`。pending input 等工作流对象中的 `sourceMessageId` 只表示“来源指向”，其值必须复制自这个 message ID；兼容别名只能在进程边界规范化一次，进入 Coordinator 后不得并存。后续追问、结构化问答和恢复调用继续携带同一来源关联，不能生成只按正文匹配的新身份。
- Main 根据 `storageConversationId` 从 Store 读取 plan、Run、pending request、approval 和 resolution 的权威快照，再与 Renderer 提供的当前请求及未保存编辑器选择合并；Renderer 携带的旧结构化状态不能覆盖 Store 新状态。
- 会话级与 Run 级 pending input 按 `requestId` 去重，审批按 `checkpointId` 去重；同一个对象不能因来自两条路径而重复占用硬预算。
- `relatedUserInputResolutions` 和 `relatedApprovalResponses` 必须通过 `requestId/inputSessionId/runId/planId/checkpointId` 中可用的稳定关联键筛选。无法证明与当前未决事务、当前计划或活动/恢复中 Run 相关的旧答案不进入硬保底分区。
- 受保护输入中的大型正文和 Artifact 内容只携带稳定引用、版本/哈希及必要短摘录；“受保护”保护的是当前意图、身份、状态和原始答案，不等于无界内联所有来源正文。

### 7.1 `AgentContextCompressionCoordinator`

新增协调层，负责有状态决策，不把网络调用和持久化塞入纯组装器：

- 每个 `storageConversationId` 同一时间最多运行一个摘要更新；不得用 `runtimeConversationId` 建锁或持久化。
- 同一会话的等价并发请求共享进行中的压缩 Promise；非等价请求只等待当前任务结束，随后重新读取 Store 并重新决策，不能直接消费前一个任务的摘要或诊断。
- 共享任务/幂等键至少包含 `storageConversationId + summaryCasTokenDigest + operationKind + targetGeneration + rebuildReason + targetSourceHash + targetDependencyHash + currentRequest.messageId/contentHash + providerProfileId + model + compactorPromptVersion`。`operationKind` 至少区分 `coverage_increment / dependency_refresh / generation_rebuild / background_precompression`；不在键中存放当前请求明文。
- 每个调用以独立 waiter 等待共享任务。waiter 的 `AbortSignal` 只取消该调用的等待；仅当共享任务没有其他 waiter、后台消费者或已承诺的主请求时，Coordinator 才中止底层 Compactor。单调用独占任务时，用户取消应立即中止。
- 底层任务使用 Coordinator 自有的 `AbortController`；已取消 waiter 不接收结果、不更新 UI，取消不计入连续失败。提交 CAS 前必须再次检查底层任务未被整体取消。
- 记录连续失败次数、最近成功边界和是否触发熔断。
- 返回已验证摘要或明确的降级结果，不直接修改 UI。
- 每次决策从 `AgentConversationStore` 重新读取最新完整消息和当前摘要，不把 Renderer 请求携带的 summary 副本视为 CAS 权威值。
- Renderer -> Python Runtime -> Electron Main 的 `agent.generate_chat` 顶层契约必须显式透传 `storageConversationId`；`selectionContext.agentConversationId` 只作兼容读取，不能作为长期隐式入口。
- generation 重建作为同一 Coordinator 管理的共享候选任务，按连续原子前缀和 Compactor 输入/输出预算分块处理。中间候选不得写入权威 `contextSummaryJson` 或用于过滤历史；只有整个目标 coverage 的投影、ledger、sourceHash 和 dependencyHash 完整校验通过后，才以单个 revision CAS 发布下一 generation。
- dependencyHash stale 且 sourceHash 仍有效时进入 `operationKind=dependency_refresh`。Coordinator 先从旧投影中确定性移除依赖旧版本的条目/Artifact 摘要，再允许 Compactor 在同 generation 重建当前投影；存在紧邻的新 closed 原子前缀时可以在同一 revision 同时完成合法 coverage 增量，不存在时必须走 coverage 零推进的显式刷新校验。
- 主请求触发的重建仍遵守单请求 Compactor 调用上限：若一个安全分块无法完成整代重建，本轮返回 `CONTEXT_REBUILD_IN_PROGRESS`，使用不信任旧 coverage 的降级组装，并让共享后台任务继续。该状态表示权威摘要尚未改变，不得展示为压缩成功或失败。重建任务必须可取消、可熔断、可因来源再次变化而丢弃，不能在请求内循环阻塞到全部完成。
- sourceHash 已 stale 的旧摘要只能作为 generation/CAS 基线和诊断材料，不能用于过滤默认历史，也不能作为主模型的可信语义投影；新 generation 最终发布前，主请求按“无可信 coverage”组装并明确记录降级。
- 分块候选可以保存在 Coordinator 内存或专用临时存储中，但必须与权威摘要隔离并绑定起始 `summaryCasToken`、目标 sourceHash/dependencyHash 和任务 ID。进程退出可丢弃未发布候选；恢复时必须从权威消息重新开始，禁止把临时候选自动提升为可信摘要。
- 发布前重新读取权威消息和摘要，复算目标 coverage 的 sourceHash/dependencyHash，并使用任务起始 CAS token 做一次单语句 CAS。期间任何已发布 revision、来源变化或 token 不一致都令整个候选失效。

### 7.2 `AgentConversationCompactor`

新增领域语义压缩服务：

- 输入只包含增量模式下旧的模型可见语义投影、重建模式下上一分块产生的临时候选投影、候选连续前缀、必要 Artifact/项目来源引用、为理解本次纠正或模糊指代而确定性召回的有界历史摘录，以及固定 Schema 指令；不得把 stale 持久投影作为重建基线，也不得包含完整历史 ledger。
- `mode=incremental` 时，Compactor 只为本次新增前缀输出 `userMessageLedgerDelta`，旧 ledger 由 Coordinator 确定性保留并与 delta 合并；当 Coordinator 明确标记 `operationKind=dependency_refresh` 且没有新增前缀时，仍使用 `mode=incremental`，但 delta 必须为空。`mode=rebuild_chunk` 时，delta 只对应当前重建分块，并追加到尚未发布的新 generation 候选中。模型在两种 mode 下都不得重写已经纳入各自候选链的 ledger 条目。
- dependency refresh 的 Compactor 输入不得包含已经失效的投影条目或旧版本项目正文；只提供过滤后的当前投影、仍有效的消息来源和最新可验证项目来源。刷新失败时，旧持久 revision 保留，但 Assembler 继续排除失效条目且不得基于 stale dependency 推进 coverage。
- 历史摘录由 Coordinator 从旧投影、ledger gist 和完整覆盖前缀中检索，必须带稳定来源 ID，并受独立条数/Token 上限约束。检索结果只辅助更新当前投影和识别 `supersedesMessageIds`，不扩大 coverage。
- 禁止调用工具，温度使用低值，限制输出 Token，强制结构化 JSON。
- Prompt 明确逐条检查所有用户消息，尤其是用户纠正、否定、长期约束、创作事实和最近改变的意图。
- 输出分析草稿如存在必须丢弃，只持久化经过验证的结构结果。
- Provider 不支持结构化输出时可以从文本提取 JSON，但必须经过同一严格校验器。

### 7.3 `AgentContextAssembler`

继续保持纯函数性质：

- 不发起摘要模型调用，不访问数据库，不自行更新 summary revision。
- 接收已验证的模型可见摘要、完整历史描述符、`ContextAtomicUnit[]`、受保护上下文和候选 sections。
- 组装前按 `currentRequest.messageId` 从所有历史来源和召回候选中去重，并断言受保护分区中恰好存在一次相同正文；不能仅依靠 Renderer 预先过滤。
- 通过动态优先级分配器构建 payload。
- 返回 prompt、来源诊断、最终 Token 和是否仍会在下一轮触发压缩。

### 7.4 `AgentConversationStore`

- P1 首期继续复用 `contextSummaryJson`，不要求立即新增数据库表。
- Store 读取会话时同时返回不可伪造的 `summaryCasToken`，至少包含数据库中 `contextSummaryJson` 的原始值/摘要和解析后的 `version/revision/generation/sourceHash/dependencyHash`。新增独立 `compareAndSwapContextSummary(storageConversationId, summaryCasToken, nextSummary)`，底层 `UPDATE` 必须按会话 ID 和读取时的原始持久值做单语句 CAS；影响行数不是 1 即视为冲突。这样 `null -> v2`、`v1 -> v2` 和 `v2 -> v2` 都有明确比较语义，不能把 v1 缺失的 hash 当成空字符串猜测。
- CAS 前仍必须验证 token 中的 version/revision/sourceHash/dependencyHash 与解析对象一致，v2 增量提交还必须满足 revision 连续和新 hash 已重新计算；原始持久值 CAS 负责阻止同 revision 内容不同或 v1/v2 revision 数字碰撞的并发覆盖。
- 启用 Coordinator 后，`contextSummaryJson` 由 Main 单写。Renderer 的 `upsertAgentConversation` 输入不再接受该字段，Store 的普通 upsert 必须保留数据库当前摘要，不能用 `null`、旧 revision 或未知版本覆盖它。
- 压缩路径不得调用会删除并重插全部 `AgentMessage` 的整会话 upsert；CAS 只更新摘要及明确的压缩状态字段。
- Store 必须提供稳定的消息全序。若 `createdAt` 不能保证唯一顺序，P1 必须增加持久化 sequence（可使用列或受校验的消息元数据）；不能只依赖 `ORDER BY datetime(createdAt)` 或运行时数组下标建立 coverage/sourceHash。
- 完整消息仍按当前模型保存。后续若优化消息增量写入，不能改变本需求的数据不变量。

### 7.5 `TokenCounter`

- 对同一份序列化请求返回动态上下文和 Provider 总输入两个口径，例如 `{ contextTokens, providerInputTokens, method, profileId }`；其中 `method` 只能是 `provider_exact`、`tokenizer_exact` 或 `conservative_upper_bound` 才能参与硬预算判定。普通 `estimated` 结果只用于排序和诊断。
- P1 必须为正式支持的 Provider 能力配置提供精确计数器或经过测试的保守上界计数器，并覆盖 system prompt、user payload、工具/JSON Schema、消息包装和 Provider 固定包装。
- Provider 响应中的 usage 只能用于事后校准，不能替代调用前硬预算检查。
- 窗口解析优先级固定为：用户明确选择的窗口档位或高级自定义值 > 已登记的 Provider/模型能力档案 > Provider 兼容能力。模型切换后恢复自动，禁止沿用上一个模型的手动窗口。
- 当前 HTTP 兼容能力使用 128K 自动建议和通用保守 UTF-8 上界计数；`gpt-5.4`、`gpt-5.6` 使用已登记的 258K 推荐档。8K 只作为小窗口和上下文压缩测试档，不是未知模型默认值。
- 内置能力目录按精确模型 ID 保存供应商、显示名和推荐窗口，并直接驱动模型选择器与硬预算；首批覆盖 OpenAI、Volcengine、DeepSeek、Zhipu、Baidu Qianfan、Alibaba Bailian、Moonshot、StepFun、LongCat、MiniMax、BaiLing、Xiaomi、xAI 和 NVIDIA NIM。相同模型在多个渠道出现不同窗口时，自动档采用已知最小值，渠道专属值后续只能通过显式 Provider 档案收紧或放宽。
- 能力目录是可维护产品数据，不与计数算法耦合。新增供应商或模型只需增加目录项和一致性测试，不得再次修改 TokenCounter 准入逻辑。
- 模型输入框、持久化设置和最终 Provider 请求必须始终使用完全一致的原始模型 ID，例如 `gpt-5.6`。供应商、显示名和窗口容量只允许作为建议列表元数据展示，不得拼接进输入框或请求值；用户手动输入任意模型 ID 后，按 Enter 或离开字段即可直接提交。
- 模型名称不承载可靠的窗口契约；例如 `deepseek-1m` 不会仅因名称自动采用 1M。明确知道其容量时，用户在设置中选择“百万上下文 1M”即可覆盖推荐值。
- 新 GPT 英文代号或其他厂商 HTTP 模型必须能够使用 Provider 兼容能力，不能因未命中模型名称档案返回 `CONTEXT_TOKEN_COUNTER_UNAVAILABLE`。只有连 Provider 级最低计数与包装能力契约都无法建立时才返回该错误。
- P2 可以用更精确、更低冗余的 tokenizer 替换保守上界，以提高可用上下文；这属于成本与容量优化，不再是正确性前置条件。

## 8. 预算与触发机制

### 8.1 预算计算

```text
hardProviderInputLimit
  = contextWindowTokens
  - outputReserveTokens
  - safetyReserveTokens

fixedProviderInputTokens
  = systemPromptTokens
  + toolSchemaTokens
  + fixedProviderWrapperTokens

hardContextBudget
  = hardProviderInputLimit
  - fixedProviderInputTokens
  - providerReserveTokens
```

- `outputReserveTokens` 使用本次调用真实最大输出配置。
- `fixedProviderInputTokens` 必须计入实际系统提示、工具 Schema 和 Provider 固定包装；只有 Provider 提供调用前 count API、本地精确 tokenizer 或经验证的保守上界档案时，才能用于本次硬预算。响应后的 usage 只用于校准后续模型档案。
- `safetyReserveTokens` 和 `providerReserveTokens` 来自模型能力档案，用户不能配置为负数。
- 所有预算使用 Token 强类型或明确带 `Tokens` 后缀，禁止与字符数混用。
- `hardContextBudget`、`triggerContextBudget`、`targetContextBudget` 只与动态上下文 Token 比较；Provider 总输入 Token 则独立校验 `providerInputTokens + outputReserveTokens + safetyReserveTokens + providerReserveTokens <= contextWindowTokens`。禁止拿包含 system/tool 的总输入再次与已经扣除 system/tool 的上下文预算比较，造成重复扣减。

### 8.2 高低水位

不能直接复制固定 13K 缓冲。默认回差按窗口缩放：

```text
triggerReserveTokens
  = max(1024, min(13000, floor(contextWindowTokens * 0.08)))

triggerContextBudget = hardContextBudget - triggerReserveTokens
targetGapTokens
  = max(512, min(4096, floor(triggerContextBudget * 0.25)))

targetContextBudget = max(0, triggerContextBudget - targetGapTokens)
```

- 具体比例必须通过 8K、32K、128K 压测后进入模型档案，可配置但有安全上下界。
- 候选动态上下文达到 `triggerContextBudget` 时提前压缩，不等到硬预算溢出。
- 压缩后最终动态上下文应不高于 `targetContextBudget`；在只有受保护上下文或极小窗口时可以高于目标预算，但绝不能高于 `hardContextBudget`，Provider 总输入也绝不能超过 `hardProviderInputLimit`，并必须记录原因。
- 诊断必须计算 `wouldRetriggerNextTurn`。若为 true，当前摘要结果不得视为健康成功；协调器优先进一步移除可选内容。单次用户请求最多产生一个成功摘要 revision，只有 13.3 规定的安全重试可以产生第二次模型调用，不能为了反复扩大前缀循环调用 Compactor。

`wouldRetriggerNextTurn` 使用模型档案中的保守下一轮增量，不猜测用户下一条消息正文：

```text
nextTurnReserveTokens
  = maxOutputTokens
  + defaultUserTurnReserveTokens
  + nextTurnMessageWrapperTokens

projectedNextTurnContextTokens
  = finalContextTokens + nextTurnReserveTokens

wouldRetriggerNextTurn
  = projectedNextTurnContextTokens >= triggerContextBudget
```

- `defaultUserTurnReserveTokens` 和 `nextTurnMessageWrapperTokens` 属于 Provider/模型档案，必须有安全上下界并在诊断中展示。
- 该值是稳定的健康度判定，不承诺预测任意长度的下一条用户消息；下一条消息仍按真实内容重新组装和计数。

### 8.3 动态优先级分配

预算采用“先保底、后竞争”分配，不再为所有分区预先划出合计超过 100% 的固定比例：

| 阶段 | 分区 | 策略 |
| --- | --- | --- |
| 硬保底 | 当前请求 | 完整保留；超限类型化失败 |
| 硬保底 | 未决输入/审批、当前计划、SelectionContext、活动 Run 身份、与这些活动对象直接关联的原始答案 | 结构化完整保留；大型正文或产物只保留稳定引用 |
| 连续性保底 | 当前有效硬约束、持久摘要核心字段、近期原文最小尾部 | 先为三者保留 floor；任何召回或可选 section 不得挤占这些 floor |
| 请求证据 | 与当前请求直接命中的原消息/Artifact、required/high sections | 按相关度和来源类型竞争剩余预算；大块内容先微压缩 |
| 可选扩展 | 超出 floor 的更多近期原文、normal/low sections | 按完整回合从新到旧扩展；不足时省略并记录，不推进 coverage |

`required` 不能意味着无限大。required section 超过自身安全上限时必须转为引用、分批读取或返回类型化错误。

已完成且不再关联当前计划、活动/恢复中 Run 或未决事务的历史答案不属于永久硬保底。它们继续保存在 `userInputResolutions`、审批记录或 Run 中，通过来源索引、摘要和按需召回进入上下文；压缩不得删除这些权威对象。

## 9. 分层压缩策略

系统按成本和信息损失从低到高依次处理：

### 9.1 第零层：无损投影

- 过滤仅用于 UI 的 `system/context_compression` 消息和重复状态通知。
- 同一结构化计划、审批、范围或 Artifact 元数据只保留一份权威投影。
- JSON payload 使用稳定、紧凑字段，不重复嵌入可通过 ID 解析的大对象。
- 这一层不改变用户或助手自然语言内容，不记为语义压缩。

### 9.2 第一层：引用式微压缩

满足以下条件的大块内容优先替换为 `sourceRef + contentHash + excerpt + metadata`：

- 已持久化为 Artifact 的完整报告、草稿或审查结果。
- 已保存且可通过章节 ID/版本重新读取的章节正文。
- 已导入且可通过 Attachment ID/内容哈希重新读取的附件正文。
- 已有结构化结果的旧工具输出或重复检索结果。

要求：

- `sourceRef` 必须可解析，且指向当前小说内允许读取的对象。
- 微压缩只改变本次模型 payload，不修改原消息或产物。
- 不能仅留下“内容已省略”；必须保留用途、来源、短摘录和重新读取标识。
- 当前请求直接要求检查原文时，相关内容应按预算重新读取或分批处理，不能继续只给摘要。

### 9.3 第二层：领域语义压缩

当无损投影和微压缩后仍达到触发预算时：

1. 从现有 coverage 之后开始选择连续较早前缀。
2. 尾部至少保留模型档案定义的最小原文 Token 和最小完整回合数；默认建议不少于 5 个含文本回合和 10K Token，极小窗口按比例降低。
3. 边界向前调整，不能拆开 user/assistant、工具请求/结果、结构化问答/答案或审批请求/决议。
4. 候选前缀必须同时适配 Compactor 的独立输入预算和结构化输出预算。选择器应按用户消息数、每条 ledger gist 上限、投影上限及 JSON 包装预留最坏情况输出 Token；首次迁移或超长历史只选择单次可安全处理的最大连续前缀，不能把溢出转嫁给摘要请求。
5. Compactor 将旧 `semanticProjection`、新增前缀和有界相关历史摘录合并为新的有界当前状态投影，同时只输出新增前缀的 ledger delta，而不是重发完整 ledger 或无限追加摘要块。旧投影条目可以合并或淘汰，其来源仍由 ledger 和完整消息保留。
6. 新 semanticProjection、ledger delta 和来源指纹通过 Schema、来源、边界、哈希和预算校验后，由 Coordinator 合并 sourceIndex 并原子提交。
7. 最终组装使用“持久摘要 + 近期原文尾部 + 当前相关召回”。
8. 单次可处理前缀不足以让主请求进入硬预算时，使用本轮有诊断省略或类型化失败，并在后续/后台继续推进；同一用户请求内不得循环调用多个摘要 revision。

依赖变化是本层的显式子路径，不要求必须有新的聊天前缀：

- `operationKind=dependency_refresh`、`mode=incremental`，旧 coverage/sourceHash 已验证且保持不变。
- Coordinator 在调用 Compactor 前移除所有依赖 stale source 的旧投影条目和 Artifact 摘要，只传入最新可验证来源。
- 没有新增 closed 原子单元时，Compactor 输入的新增前缀为空，输出 `userMessageLedgerDelta=[]`；成功后 revision 加一，generation 和完整 ledger 不变。
- 同时存在紧邻的新 closed 原子单元时，可以在一个增量 revision 内同时刷新依赖并推进 coverage，但新增用户消息仍必须逐条产生 ledger delta，且提交前使用同一最新来源快照统一复算 sourceHash/dependencyHash。
- 刷新失败、取消或 CAS 冲突时不发布半刷新状态；旧持久摘要保留，运行时继续过滤 stale 条目，并禁止在未恢复依赖校验前单独推进 coverage。

### 9.4 第三层：本轮有诊断省略

语义压缩不可用或仍有低优先级资料无法纳入时，可以只在本轮省略：

- 省略必须记录 section/message 范围、原因和来源引用。
- 省略不得推进持久摘要 coverage。
- 下一轮仍可重新参与组装、语义压缩或按需召回。
- 受保护上下文不得进入这一层。

## 10. 持久摘要 v2 契约

P1 引入 `agent-conversation-summary-v2`。v1 继续可读，但不再用确定性关键词摘要推进新 coverage。

```ts
interface AgentConversationSummaryV2 {
  version: 'agent-conversation-summary-v2';
  revision: number;
  previousRevision: number;
  generation: number;
  rebuild?: {
    previousGeneration: number;
    reason: 'source_changed' | 'manual_quality_rebuild';
  };
  coverage: {
    startMessageId: string;
    endMessageId: string;
    messageCount: number;
    sourceHash: string;
  };
  semanticProjection: AgentConversationSemanticProjection;
  sourceIndex: AgentConversationSourceIndex;
  updatedAt: string;
  compactor: {
    providerType: string;
    model: string;
    promptVersion: string;
  };
}

interface AgentConversationSemanticProjection {
  activeIntent: SummaryEntry[];
  hardConstraints: SummaryEntry[];
  confirmedDecisions: SummaryEntry[];
  canonFacts: SummaryEntry[];
  creativeContinuity: SummaryEntry[];
  unresolvedQuestions: SummaryEntry[];
  completedOutcomes: SummaryEntry[];
  pendingWork: SummaryEntry[];
  artifactRefs: ArtifactSummaryRef[];
}

interface AgentConversationSourceIndex {
  userMessageLedger: UserMessageLedgerEntry[];
  sourceFingerprints: SummarySourceFingerprint[];
  dependencyHash: string;
}

interface SummaryEntry {
  id: string;
  text: string;
  sourceMessageIds?: string[];
  sourceArtifactIds?: string[];
  sourceProjectRefs?: ProjectSourceRef[];
  authority: 'user' | 'project' | 'assistant';
  status: 'active' | 'resolved' | 'superseded';
  supersededBy?: string;
}

interface UserMessageLedgerEntry {
  messageId: string;
  gist: string;
  classification: 'semantic' | 'transient';
  supersedesMessageIds?: string[];
}

interface ArtifactSummaryRef {
  artifactId: string;
  runId?: string;
  type: string;
  title: string;
  status?: string;
  sourceVersion?: string;
  contentHash: string;
  summary: string;
}

interface ProjectSourceRef {
  sourceType: 'chapter' | 'character' | 'world_setting' | 'plotline' | 'plot_point'
    | 'item' | 'skill' | 'map' | 'attachment' | 'artifact';
  sourceId: string;
  sourceVersion?: string;
  contentHash: string;
}

interface SummarySourceFingerprint extends ProjectSourceRef {
  title?: string;
}

interface AgentConversationCompactionResultV2 {
  mode: 'incremental' | 'rebuild_chunk';
  semanticProjection: AgentConversationSemanticProjection;
  userMessageLedgerDelta: UserMessageLedgerEntry[];
  referencedSources: SummarySourceFingerprint[];
}
```

### 10.1 字段规则

- `operationKind`、`dependencyRefresh` 和共享任务键属于 Coordinator 请求/校验上下文，不写入 `AgentConversationSummaryV2`，也不由模型自由输出。持久结果通过 revision、generation、coverage 和重新计算的 sourceHash/dependencyHash 表达最终状态。
- `coverage` 描述连续前缀，不再依赖把全部 covered ID 注入模型 prompt。
- P1 Schema 使用以下硬上限作为验收基线：`semanticProjection` 的 `SummaryEntry` 总数不超过 96，`artifactRefs` 不超过 32；单条 `SummaryEntry.text` 和 `ArtifactSummaryRef.summary` 各不超过 1,200 字符；单条 `SummaryEntry` 的消息、Artifact 和项目来源引用合计不超过 16；单条 ledger gist 不超过 280 字符。
- Compactor 的确定性历史摘录最多 12 条，每条正文最多 1,200 字符，并继续受 Compactor 总输入 Token 上限约束。字符上限只负责结构和存储防护，不能替代第 7.5、8 节要求的 Token 硬计数。
- 模型档案可以针对小窗口收紧上述上限；任何放宽都必须同时修改 Schema 校验、最坏情况输出预算公式和 8K/32K/128K 自动化，不能只提高 Prompt 或 Provider 的 `maxTokens`。
- 首次 v2 摘要固定为 `generation=1`。普通增量 revision 保持 generation 不变且不携带 `rebuild`；只有 sourceHash 失效或显式质量重建可以令 generation 严格加一，并携带匹配旧 generation 的 `rebuild.previousGeneration` 和原因。generation 重建必须从当前权威完整消息生成整个目标 coverage 的投影与 ledger，不能只让模型修补旧 ledger。
- dependency refresh 是普通 revision 的受限子类型：`previousRevision` 指向当前 revision，revision 严格加一，generation 和可选 `rebuild` 保持普通增量语义；coverage 四个字段及整个 `userMessageLedger` 必须与 previous 逐字段相同。只允许 `semanticProjection`、`sourceFingerprints`、`dependencyHash`、`updatedAt` 和 `compactor` 随最新来源合法变化。
- `AgentConversationCompactionResultV2.mode` 必须与 Coordinator 发起的任务模式一致。`rebuild_chunk` 结果只能合并到未发布的临时候选；它不能单独推进持久 revision、generation 或 coverage，也不能被 Assembler 当作可信摘要读取。
- `sourceHash` 使用规范化序列化后按 SHA-256 计算，输入至少包含按序 message ID、角色和正文哈希；它用于检测消息变化及 CAS 冲突，不能复用当前仅供本地稳定 ID 的非加密短哈希。
- `semanticProjection` 是唯一允许注入主模型或作为旧摘要传给 Compactor 的部分，受独立 Token 上限约束。
- `sourceIndex.userMessageLedger` 必须覆盖累计 coverage 中的每条用户消息，保存有界 gist、首次压缩分类和当时可确认的前向 supersession 关系；它用于校验、Inspector 和召回索引，默认不整表注入任何模型。
- 同一 generation 的普通增量中，Compactor 的 `userMessageLedgerDelta` 必须只包含本次新增前缀中的用户消息。Coordinator 校验 delta 后与旧 ledger 确定性追加合并；旧条目的 `messageId/gist/classification/supersedesMessageIds` 不可由模型删除、改写或重新分类。后来的用户纠正通过新 ledger 条目的 `supersedesMessageIds` 指向更早消息，不回写旧条目。进入新 generation 时，每个 `rebuild_chunk` 的 delta 只追加到临时候选；所有分块完成并整体验证后才替换持久 sourceIndex。
- ledger 不保存 `summaryEntryIds`，也不使用 `represented` 表示永久投影关系。`classification=semantic` 只表示该消息不是寒暄等瞬时输入，必须保留 gist 和召回能力；它可以被合并进当前投影，也可以在不再影响当前状态后只留在来源索引和完整历史中。
- `sourceIndex` 属于持久化索引，不计入 `semanticProjection` 的模型 Token 预算。P1 复用 `contextSummaryJson` 存储；必须记录索引字节数和条目数，后续达到数据库性能阈值时再迁移独立表，不能通过丢弃 ledger 解决增长问题。
- `classification=transient` 只允许寒暄、确认收到等不改变任务语义的输入；包含创作事实、否定、纠正、约束、范围、审批答案或新任务动词的消息必须标为 `semantic`。
- `supersedesMessageIds` 只允许出现在 `classification=semantic` 的条目中，并且只能指向稳定 sequence 更早、真实存在且已在旧 coverage 或本次 delta 中的 user 消息。一次纠正既可引入新语义又可 supersede 多条旧消息，不使用互斥的 `superseded` 分类表达。
- `canonFacts` 只接受 `authority=user|project`。模型从旧助手回复提取的内容只能进入 `completedOutcomes`、`pendingWork` 或标为 assistant 的建议。
- `authority=user` 至少引用一条 user 消息；`authority=assistant` 至少引用一条 assistant 消息；`authority=project` 至少引用一个当前小说内有效的 Artifact 或 `ProjectSourceRef`。每个 SummaryEntry 至少有一种有效来源，不能生成无来源条目。
- `hardConstraints` 必须保留用户的否定、禁止、必须、视角、文风、篇幅、范围和写回限制；新约束覆盖旧约束时保留 superseded 链。
- `creativeContinuity` 用于人物当前状态、关系变化、时空位置、伏笔、因果、叙事视角和语气等会话级连续信息；正式项目数据仍以章节和实体为准。
- Artifact 只保存稳定 ID、类型、标题、状态、来源版本、内容哈希和短摘要，不在持久会话摘要中复制完整正文；缺少来源版本时由协调器对规范化来源描述符计算 `contentHash`。
- 章节、人物、设定等非 Artifact 项目来源保存稳定类型、ID、版本和内容哈希；来源更新时只使依赖它的条目失效，不把旧投影反写回项目数据。
- `dependencyHash` 对按稳定顺序排列的 `sourceFingerprints` 做规范化 SHA-256，用于检测 Artifact/项目依赖变化；coverage `sourceHash` 只负责消息前缀，两者不得混用。
- `semanticProjection` 中所有文本字段、条目数和单条来源引用数都有独立上限；达到上限时应合并等价当前状态，并将已解决或不再影响当前协作的旧条目从模型可见投影淘汰，不能靠无限保留 `superseded` 条目或无限追加来源 ID 维持审计历史。每个仍存在的条目必须保留至少一种有效来源；被淘汰内容通过完整 ledger 和原消息召回。完整 ledger 使用每条 gist 上限和存储诊断，不受模型摘要总 Token 上限约束。
- `SummaryEntry.id` 和 `supersededBy` 是 revision 内引用；`supersededBy` 必须指向同一 `semanticProjection` 中真实存在的条目。外部持久对象、ledger 和后续 revision 不得把该 ID 当作永久主键。

### 10.2 Compactor 校验

提交新 revision 前至少执行：

1. version、revision、generation、可选 rebuild、coverage 和所有枚举通过 Schema 校验。
2. Compactor 结果的 `mode` 与请求一致；`rebuild_chunk` 只能进入当前重建候选，分块 coverage 必须从候选起点连续推进且中间结果不得持久化为权威摘要。
3. 首次 v2 coverage 恰好等于请求压缩的连续前缀；普通增量 revision 的 coverage 恰好等于“旧可信 coverage + 本次紧邻新增前缀”，不多覆盖、不少覆盖且中间无空洞。显式 dependency refresh 没有新增前缀时，coverage 四字段必须与旧 revision 逐字段相同。
4. coverage 起止和 messageCount 必须按 Store 的稳定 sequence 验证，边界只能位于两个已关闭 `ContextAtomicUnit` 之间。
5. 所有 `sourceMessageIds`、`sourceArtifactIds`、`sourceProjectRefs` 在当前小说和会话中存在，当前版本/内容哈希与 `sourceIndex.sourceFingerprints` 一致。
6. 本次新增前缀或重建分块中的每条用户消息在 `userMessageLedgerDelta` 中恰好出现一次；完成增量合并或整代重建后，累计 coverage 中每条用户消息仍恰好出现一次。无新增前缀的 dependency refresh 必须满足 `userMessageLedgerDelta=[]`。
7. 同一 generation 增量的合并前后，所有旧 ledger 条目的不可变字段逐字段相同，只允许追加本次 delta；dependency refresh 没有新增 coverage 时整个 ledger 必须逐字段相同；不得要求旧条目继续关联当前 `SummaryEntry`。generation 重建则必须验证 generation 严格加一、rebuild 元数据正确，并对目标 coverage 的每条 user 消息重新执行唯一 ledger、分类、supersession、来源和哈希校验后才允许替换。
8. 每个 `supersedesMessageIds` 目标都是稳定 sequence 更早且存在的 user 消息，不允许自引用、后向引用或环。
9. 每个当前 `SummaryEntry` 至少有一种有效来源；其 `supersededBy` 如存在，必须指向同一 revision 中真实存在的当前条目。
10. 规则检测出的否定、纠正、硬约束、结构化答案和创作事实不能被标记为 transient。
11. `canonFacts` 不得只有 assistant 来源，project authority 必须有可验证项目来源。
12. 新 `semanticProjection` 序列化后不超过模型可见摘要预算，并满足条目数和单条来源引用数上限；完整 sourceIndex 单独检查结构、单条上限和存储大小。
13. sourceHash、dependencyHash 与提交时从同一权威消息/项目来源快照重新计算的值一致。dependency refresh 还必须验证旧 sourceHash 仍有效、旧 coverage 未变化、失效来源不再被新投影或来源指纹引用，并且新 dependencyHash 不再是 stale 值。

校验器只验证结构和来源，不声称能证明模型摘要语义完全正确。语义质量通过领域 golden cases、完整历史召回和用户可见诊断共同保障。

## 11. 近期原文与边界保护

### 11.1 保留策略

- 同时满足“最小 Token”和“最小文本回合数”，不能只按固定消息条数。
- 从会话尾部向前扩展，直到达到两个最小值或近期原文上限。
- 若最后一个回合本身很长，允许其超过近期尾部软上限，但最终硬预算仍必须满足。
- 当前用户消息永远位于尾部之外的受保护分区，不参与边界选择。

### 11.2 原子单元

下列组合不能被边界拆开：

- 用户请求及其直接助手回复。
- 助手发起的结构化问题与用户原始答案。
- approval request 与 approval response。
- tool call 与 tool result；若 UI 历史没有保存原始 Tool Block，则保护对应活动/Artifact 的结构化关联。
- Run 最终结果与其 Artifact 引用。
- 同一 Provider assistant response 被拆分保存的 thinking/text/tool 块；若本系统不持久化 thinking，则不得为压缩新增 thinking 持久化。

边界规划器使用以下只读描述符；它是从完整消息和权威结构化对象生成的派生投影，不替代原对象：

```ts
interface ContextAtomicUnit {
  unitId: string;
  sequenceStart: number;
  sequenceEnd: number;
  kind: 'chat_turn' | 'structured_input' | 'approval' | 'tool_exchange'
    | 'run_result' | 'provider_response';
  messageIds: string[];
  stateRefs: Array<{
    type: 'pending_input' | 'input_resolution' | 'approval_request' | 'approval_response'
      | 'run' | 'run_event' | 'artifact' | 'tool_result';
    id: string;
  }>;
  status: 'open' | 'closed';
}
```

- 每个可进入 coverage 的 user/assistant 消息必须恰好属于一个最外层原子单元；多个底层关系重叠时由 Builder 合并为一个更大的单元，不能生成交叉边界。
- `sequenceStart/sequenceEnd` 来自 Store 的持久稳定消息全序。相同输入在刷新、重启和 Renderer 重新加载后必须生成相同单元和边界。
- 结构化问题未保存为 assistant 聊天消息时，使用发起该问题的用户消息或工作流消息作为 anchor，并把 pending request/answer 放入 `stateRefs`；单元在回答或取消前保持 `open`。
- coverage 候选只能包含从会话开头连续排列的 `closed` 单元。遇到 `open` 单元立即停止，不能绕过它压缩更晚消息。
- Builder 找不到必需来源、发现重复 sequence、孤立 response/result 或交叉关系时，应返回可诊断的不可压缩边界；不得猜测配对后推进 coverage。

## 12. 按需召回

已覆盖前缀仍必须可被检索，召回不能只依赖摘要是否成功提取某个关键词。

召回顺序：

1. 当前请求中的显式 message ID、Artifact ID、章节 ID 和标题。
2. 持久摘要条目及其 `sourceMessageIds/sourceArtifactIds/sourceProjectRefs`。
3. `sourceIndex.userMessageLedger.gist` 的词法匹配。
4. 对完整 `AgentMessage` 覆盖前缀执行有界词法检索，并返回原文摘录。
5. 已有 RAG/向量能力成熟后再评估语义召回，但不能替代前四项确定性路径。

召回要求：

- 系统诊断消息、纯活动通知和隐藏内部状态不得进入召回结果。
- 召回结果携带来源 ID、角色、时间和摘录范围。
- 某条 semantic ledger 消息不再被当前 `semanticProjection` 直接引用时，仍必须能通过 ledger gist 命中并回读对应原消息；这属于正常的有界投影行为，不视为悬空引用。
- “之前、刚才、继续、那个设定”等模糊指代优先结合 active intent、近期原文和最近命中的摘要来源，不只依赖二字词切分。
- 召回原消息与持久摘要冲突时，以原消息和当前项目数据为准，并在诊断中记录摘要可能过期。
- 召回内容仍受独立预算控制；超长来源使用多段摘录或转为明确的分批读取任务。

## 13. 失败、取消与熔断

### 13.1 状态与失败分类

| 状态/错误码 | 含义 | 行为 |
| --- | --- | --- |
| `CONTEXT_INPUT_TOO_LARGE` | 当前用户消息本身超限 | 不调用模型；提示附件/分批处理 |
| `CONTEXT_PROTECTED_INPUT_TOO_LARGE` | 受保护结构化上下文超限 | 不删除保护项；说明超限来源 |
| `CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH` | 当前请求 message ID 缺失、不存在、角色/会话不符或正文与持久化值不一致 | 不调用 Compactor 或主模型；重新读取当前会话并恢复稳定请求身份 |
| `CONTEXT_TOKEN_COUNTER_UNAVAILABLE` | 当前 Provider 连最低计数与包装能力契约都无法建立 | 不调用模型；提示配置 Provider 级安全能力；不得仅因模型名称未登记而报错 |
| `CONTEXT_COMPACTION_TIMEOUT` | 摘要模型超时 | 保留旧 revision，执行本轮降级 |
| `CONTEXT_COMPACTION_ABORTED` | 用户取消 | 立即终止，不记普通失败，不提交摘要 |
| `CONTEXT_COMPACTION_INVALID` | JSON、Schema、来源或边界校验失败 | 保留旧 revision，计入连续失败 |
| `CONTEXT_COMPACTION_CONFLICT` | revision/sourceHash/dependencyHash CAS 冲突 | 重新读取最新状态；本轮最多重算一次纯组装，不重复调用摘要模型 |
| `CONTEXT_REBUILD_IN_PROGRESS` | generation 重建需要多个安全分块，前台请求只启动或加入共享任务 | 保留旧权威值且不信任旧 coverage；本轮降级组装，后台继续，UI 显示重建进度 |
| `CONTEXT_COMPACTION_REBUILD_LIMIT` | generation 重建达到最大分块数或总耗时上限 | 丢弃全部未发布候选，保留旧 revision/generation，不执行中间或最终 CAS，记录达到的具体上限 |
| `CONTEXT_COMPACTION_CIRCUIT_OPEN` | 当前会话、Provider 档案和模型组合已达到连续失败阈值 | 不再自动调用 Compactor；允许受限降级并在诊断中保留熔断原因 |
| `CONTEXT_PRECOMPRESSION_IN_PROGRESS` | P2 后台预压缩正在运行，前台请求已加入或绕过该共享任务 | 不是失败；不得重复启动等价任务，前台按当前可信 revision 继续组装或等待既定共享结果 |
| `CONTEXT_BUDGET_UNSATISFIABLE` | 删除所有可选内容后仍超硬预算 | 本地失败，列出受保护分区 Token |

`CONTEXT_REBUILD_IN_PROGRESS` 和 `CONTEXT_PRECOMPRESSION_IN_PROGRESS` 是可恢复状态码，不计入连续失败，也不得作为普通错误提示给用户；其是否伴随本轮降级由诊断字段单独表达。其余会中止本次阶段或主请求的代码是类型化错误码。所有代码必须进入 Main 返回契约、Renderer 类型声明和自动化断言，不能只作为自由文本 warning。

### 13.2 熔断

- 以 `storageConversationId + providerProfileId + model` 记录连续语义压缩失败。
- 连续三次非取消失败后，本会话/模型组合进入熔断；后续请求不再自动调用摘要模型。
- 一次成功压缩、用户切换模型、显式重试，或候选压缩前缀的 `sourceHash`/依赖来源的 `dependencyHash` 发生实质变化可以重置熔断；只在尾部新增普通消息而候选前缀与依赖未变，不得自动清零失败计数。
- 熔断期间仍允许无损投影、微压缩、旧摘要、近期原文和本轮诊断省略。
- UI 显示“上下文摘要暂时不可用，已使用受限上下文”，不能显示为普通成功压缩。

### 13.3 重试

- 单次压缩模型调用可以对连接建立前失败或明确未执行错误做至多一次短退避重试。
- 已开始接收模型输出后，不因 JSON 不完整自动无限重试。
- 单次用户请求最多产生一次成功的语义摘要 revision，最多调用两次摘要模型（初次 + 安全重试）。
- Provider 返回 context overflow 时允许缩小候选前缀输入后重试一次；仍失败则降级，不能进入循环。
- 分块 generation 重建是独立的共享后台/显式维护任务，不把多分块调用计入某个主请求的同步重试次数，但每个分块仍只允许初次调用和一次安全重试。P1 默认上限为最多 24 个成功处理分块、从任务启动到最终 CAS 前最多 180 秒；模型档案或部署配置可以收紧，放宽必须同步更新长会话压测和失败注入测试。跨分块连续失败同样进入熔断；达到任一上限后返回 `CONTEXT_COMPACTION_REBUILD_LIMIT`，丢弃未发布候选并保留旧持久状态，不能无限运行。

## 14. 压缩后恢复与防止重复压缩

- 每次成功压缩记录 `preCompressionContextTokens`、`postCompressionContextTokens`、`preCompressionProviderInputTokens`、`postCompressionProviderInputTokens`、`targetContextBudget` 和 `wouldRetriggerNextTurn`。
- 恢复会话时不能使用压缩前最后一次 Provider usage 直接判断当前上下文大小；必须根据当前摘要、近期尾部和受保护上下文重新组装。
- 已持久化 v2 coverage 后，加载历史从 coverage 终点之后建立近期尾部，不把旧压缩边界当普通历史再次摘要。
- 若恢复时 sourceHash 不匹配，整个 coverage 标记 stale，并通过下一 generation 从完整消息重建；若 dependencyHash 不匹配，只使引用变化来源的语义条目/Artifact 摘要失效并触发同 generation dependency refresh。没有新 coverage 时允许空 ledger delta 的刷新 revision；同时有紧邻新前缀时可以合并刷新与合法 coverage 增量。任一路径在提交前都必须从同一最新快照重算双 hash；恢复成功前不得单独基于 stale 状态推进 coverage。
- 恢复或重试用户驱动调用时，必须继续使用原始 `currentRequest.messageId` 读取持久化正文；若该消息已被编辑、删除或移到其他会话，返回 `CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH`，不能把正文相似的另一条消息当作当前请求。
- 同一轮压缩完成后的主模型调用不得再次触发语义压缩；如果最终 payload 超硬预算，使用本轮纯函数裁剪或类型化失败。

## 15. UI 与可观测性

### 15.1 时间线

仅在本次主请求真实使用了压缩或降级时插入一个稳定位置的 `context_compression` 系统消息：

- `语义压缩`：显示摘要 revision、覆盖消息数、近期原文数和前后 Token。
- `微压缩`：显示被引用替代的章节、附件、Artifact 或工具结果数量。
- `受限降级`：显示摘要失败/熔断及本轮省略数量。
- 多个阶段合并为一条消息，不连续追加多条技术通知。

### 15.2 Inspector 诊断

每次调用至少记录：

- Provider、模型、模型窗口及窗口来源。
- 输出、系统、安全、Provider 保留、硬输入、触发和目标预算。
- 压缩前候选 Token、最终 Token，以及硬预算计数与启发式估算各自的数值和方法。
- 硬预算计数方法必须标记为 `provider_exact / tokenizer_exact / conservative_upper_bound`；另行记录仅供诊断的启发式估算值。
- 压缩模式：`none / projection / micro / semantic / degraded`。
- summary version/revision/generation、`operationKind`、触发原因、rebuild 原因、任务 ID、状态、已完成/上限分块数、已用/上限总耗时、coverage 起止、sourceHash/dependencyHash 状态；dependency refresh 必须能区分“零 coverage 刷新”和“刷新并推进 coverage”。
- 当前请求 message ID 的校验状态及其在最终 payload 中的出现次数；正文或完整 task key 不进入诊断。
- 原文、摘要、召回、微压缩和本轮省略的消息/section 数量。
- 近期尾部 Token 和完整回合数。
- 原子单元总数、边界单元 ID、阻止推进的 open/invalid 单元及稳定 sequence 范围。
- Compactor Provider/模型、耗时、输入/输出 Token、重试次数。
- `nextTurnReserveTokens`、`projectedNextTurnContextTokens`、`wouldRetriggerNextTurn`、连续失败次数和熔断状态。
- sourceIndex ledger 条目数/字节数、semantic/transient 分类数、当前投影未直接引用但可召回的 semantic 消息数、dependencyHash 状态和失效项目来源数量。
- warnings 和类型化失败码。

跨 Main、preload、Renderer 和持久化助手消息使用同一组稳定字段名。下列接口是 P1/P2 共同诊断契约的必填子集；未发生相应阶段时使用 `null` 或零值，不得用缺字段区分状态：

```ts
interface AgentContextCompressionDiagnostics {
  operationKind:
    | 'none'
    | 'coverage_increment'
    | 'dependency_refresh'
    | 'generation_rebuild'
    | 'background_precompression';
  triggerReason:
    | 'none'
    | 'high_water'
    | 'forced'
    | 'source_changed'
    | 'dependency_changed'
    | 'manual_rebuild';
  currentRequestIdentityStatus: 'not_applicable' | 'valid' | 'mismatch';
  currentRequestPayloadOccurrences: number;
  preCompressionContextTokens: number;
  postCompressionContextTokens: number;
  preCompressionProviderInputTokens: number;
  postCompressionProviderInputTokens: number;
  hardTokenCountMethod:
    | 'provider_exact'
    | 'tokenizer_exact'
    | 'conservative_upper_bound';
  hardTokenCountProfileId: string;
  rebuildTaskId: string | null;
  rebuildStatus:
    | 'idle'
    | 'running'
    | 'completed'
    | 'discarded'
    | 'limit_exceeded';
  rebuildCompletedChunks: number;
  rebuildMaxChunks: number;
  rebuildElapsedMs: number;
  rebuildMaxDurationMs: number;
  statusCodes: Array<
    | 'CONTEXT_REBUILD_IN_PROGRESS'
    | 'CONTEXT_PRECOMPRESSION_IN_PROGRESS'
  >;
  errorCode?: string;
}
```

P1 默认 `rebuildMaxChunks=24`、`rebuildMaxDurationMs=180000`。`rebuildElapsedMs` 从共享任务创建时单调计时，到最终 CAS 成功、候选丢弃或达到上限时冻结；加入任务的 waiter 不得各自重新计时。`pre/postCompressionProviderInputTokens` 必须对压缩前后各自实际序列化的完整 Provider 输入计数，不能用动态上下文 Token 或 Provider 事后 usage 代填。

诊断数据随助手消息持久化但不进入后续模型历史。摘要模型的分析过程、隐藏提示和思维内容不得进入诊断。

## 16. 兼容与迁移

### 16.1 v1 立即修复

在 v2 上线前：

1. 禁止把 `omittedIndexes` 加入 `newlyCoveredMessageIds`。
2. 因 v1 关键词摘要不能证明覆盖完整性，停止用新的 v1 确定性摘要推进 coverage；它仍可作为单次请求的 rolling summary 和诊断。
3. v1 仍可更新 Artifact 短引用，但不得因此改变消息 coverage。
4. 已有 v1 摘要继续可读和召回，不自动删除；但 Assembler 不得再用 v1 `coveredMessageIds` 过滤 `historyForAssembly`。v1 摘要与完整历史重复时以原消息为准，由本轮预算器决定原文、rolling summary 和省略，不产生持久 coverage。
5. 增加未命中关键词的中文创作事实回归测试，证明 omitted 不会成为 covered。
6. 移除 `AiService.trimText(payload.message, 8000)` 和 Assembler 的 `currentRequest` 有损压缩；单条请求超限时在调用 Provider 前返回 `CONTEXT_INPUT_TOO_LARGE`。
7. 将会话级/Run 级 `pendingUserInput`、审批原始响应、当前计划、SelectionContext、活动 Run 身份，以及与这些活动对象直接关联的 `userInputResolutions` 显式注入受保护分区，不再仅依赖可压缩的 `conversation-state` section。已完成旧事务的 resolution 保留权威来源并按需召回，不永久硬保底。
8. 增加携带历史错误 v1 coverage 的回归会话，证明这些 ID 在 P0 后重新参与默认组装或本轮 rolling summary/省略决策，不会继续被当成可信 coverage 排除。

### 16.2 v2 迁移

- `contextSummaryJson` 根据 `version` 判别 v1/v2，无需第一期数据库列迁移。
- v1 不能直接声明为 v2 coverage，也不能作为首次 v2 `semanticProjection` 的权威输入；必须从完整消息、原子单元和当前项目来源重新计算候选前缀、sourceHash、dependencyHash、semanticProjection 和 ledger delta。v1 只可作为召回提示参与质量对照。
- v2 revision 使用独立命名空间：首次 v2 固定为 `revision=1, previousRevision=0, generation=1`，之后 revision 严格逐次加一，不继承或重用 v1 revision。普通增量保持 generation 不变；完整重建严格增加 generation。首次写入仍以读取到的 null/v1 `summaryCasToken` 做原始持久值 CAS，不能只比较 revision 数字。
- 若应用降级到只理解 v1 的旧版本，完整消息仍可读取；未知 v2 摘要应忽略而不是导致会话加载失败。
- v2 单写者切换后，Renderer 普通 upsert 必须忽略未知/旧摘要字段并保留数据库中的 v2；旧 Renderer 不得把 v2 回写为 null 或 v1。

## 17. 测试要求

### 17.1 单元测试

- 当前用户消息在所有预算档位下逐字保留；包含超过 8,000 字符但未超 Token 硬预算的回归样本，覆盖 AiService 和 Assembler 两个边界。
- 当前 user 消息已经存在于 Store 历史时，按 `currentRequest.messageId` 从历史、近期尾部、召回和压缩候选中全部排除，最终 Provider payload 中只在受保护分区出现一次；它不会进入本轮 coverage 或 ledger delta，也不会重复计入 Token。
- 当前请求 message ID 缺失、不存在、指向 assistant/其他会话或正文与持久化规范值不一致时返回 `CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH`，且 Compactor 和主 Provider 调用次数均为零；不能通过相同正文猜测消息身份。
- 单条当前消息或受保护上下文超限时返回正确错误码；未知 HTTP 模型使用 128K Provider 兼容能力且可正常计数，只有 Provider 级最低能力契约缺失时才返回 `CONTEXT_TOKEN_COUNTER_UNAVAILABLE` 且不调用 Provider。
- 未决输入、与活动对象关联的用户原始答案、审批响应、当前计划、SelectionContext 和活动 Run 身份完整进入受保护分区，普通 section 裁剪不影响它们；已完成旧 Run 的答案不永久内联但仍可按来源召回。
- omitted 消息不推进 coverage。
- 带有错误 v1 `coveredMessageIds` 的旧会话不会按这些 ID 过滤默认历史；只有验证通过的 v2 coverage 才能排除前缀。
- “她把钥匙藏在钟里”等未命中旧正则的创作事实不会静默退出后续上下文。
- coverage 只能是按稳定 sequence 排列的连续原子单元前缀，且不会拆开问答、审批和工具结果组合；open、孤立或交叉单元会阻止边界推进。
- 每条累计 coverage 用户消息都有唯一 ledger 条目；同一 generation 内 Compactor 每轮只输出新增前缀 delta，旧 ledger 条目的不可变字段在合并后逐字段保持不变。
- 新纠正消息通过自身 `supersedesMessageIds` 指向更早 user 消息，不改写旧 ledger；纠正消息同时保留新语义并能更新当前投影。
- 早期 semantic 消息对应的投影条目被合并或淘汰后，不存在 ledger -> `SummaryEntry` 悬空引用，且仍能通过 gist 和完整历史召回原消息。
- assistant-only 内容不能进入 `canonFacts`。
- 新旧约束的 superseded 链正确，否定和纠正不会被标为 transient。
- v1/v2 normalize、序列化、加载和未知版本降级正确。
- sourceHash 变化使 coverage stale；dependencyHash、Artifact 或项目实体版本变化只使依赖条目正确失效；CAS 冲突不覆盖较新 revision。
- dependencyHash stale 且没有任何新 closed 原子单元时，可以提交 coverage/sourceHash/generation/ledger 全部不变、revision 加一、`userMessageLedgerDelta=[]` 的 dependency refresh；同时存在新前缀时可在同一 revision 刷新并合法推进 coverage。两种路径都不保留 stale 来源引用。
- sourceHash 失效或显式质量重建会严格增加 generation 并重建完整派生 ledger；普通增量不得改变 generation，伪造 rebuild 或在同 generation 改写旧 ledger 必须校验失败。
- 多分块 generation 重建的中间候选不能被 Store/Assembler 当作权威摘要；仅最终一次 CAS 可发布新 generation，取消、超时、来源再次变化或任一分块无效都会丢弃候选并保留旧持久值。
- null/v1 首次迁移和 v2 并发更新都使用原始持久值 `summaryCasToken`；同 revision 但内容不同、v1/v2 revision 数字相同均不能绕过 CAS。
- user/project/assistant authority 的来源角色校验正确，章节等非 Artifact 项目事实带有效 `ProjectSourceRef`。
- 动态分配器使用精确或保守上界计数时永远不输出超过硬预算的 payload；启发式估算不得冒充硬计数结果。
- 动态上下文 Token 只与上下文预算比较，Provider 总输入 Token 独立与窗口比较；system/tool/Provider 包装不会漏算或被重复扣减。
- `wouldRetriggerNextTurn` 严格按档案中的 next-turn reserve 公式计算，8K/32K/128K 下结果可复现。

### 17.2 失败注入测试

- Compactor timeout、取消、空响应、非法 JSON、缺字段、伪造 message ID、错误 coverage 和超长输出。
- 连续三次失败后熔断，成功或切换模型后重置。
- 压缩成功但最终回检仍接近触发预算时扩大纯函数裁剪，不进行第二次语义压缩。
- Renderer 刷新、应用重启和会话切换后恢复相同 summary revision 和 coverage。
- 两个并发请求竞争同一 revision 时最多提交一个，另一个重新组装而不重复摘要；使用不同 `runtimeConversationId` 但相同 `storageConversationId` 时仍共享同一锁和 CAS。
- 相同会话但 CAS 快照、`operationKind`、目标 generation/hash、当前请求身份、Provider/模型或 Prompt 版本任一不同的 waiter 不共享结果；它等待当前任务结束后重新读取 Store。完全相同的 waiter 才共享同一底层调用、任务 ID、计时和最终结果。
- 共享压缩的一个 waiter 取消不会中止仍有其他 waiter 的底层任务；最后一个 waiter 取消会中止 Compactor，且不提交、不计失败、不残留 UI 状态。
- Coordinator CAS 成功后，携带旧 summary/null 的 Renderer 普通 upsert 不能覆盖新 revision；压缩路径不删除或重插 AgentMessage。
- 相同 createdAt、刷新重启和消息重新加载不会改变稳定 sequence、ContextAtomicUnit 或 coverage 边界。
- 长 ledger 多次增量压缩时，Compactor 输入不包含完整旧 ledger，只包含有界相关历史摘录；semanticProjection 的 Token、条目数和单条来源引用数保持有界，sourceIndex 条目完整保留。
- 超过 P1 Schema 基线的第 97 个投影条目、第 33 个 Artifact 引用、第 1,201 个文本字符、第 17 个合计来源引用、第 281 个 ledger gist 字符或第 13 条历史摘录会在调用前/提交前被拒绝或通过确定性候选收缩消除，不能依赖 Provider 截断。
- 大量短 user 消息场景下，候选前缀同时受 Compactor 输入和最坏情况 ledger delta 输出预算限制，不产生结构化输出截断或请求级多 revision 循环。
- 超长历史 generation 重建按连续原子单元分块、共享任务并只在完成后 CAS；主请求返回 `CONTEXT_REBUILD_IN_PROGRESS` 而不会等待无界分块。覆盖第 24 个分块可正常完成、第 25 个分块被拒绝，以及最终 CAS 前总耗时达到 180 秒的边界；达到任一上限均返回 `CONTEXT_COMPACTION_REBUILD_LIMIT`、丢弃未发布候选且不改变旧 revision/generation。

### 17.3 领域 golden cases

至少覆盖：

- 长篇中文会话中的人物秘密、伏笔、时间线和叙事视角。
- 用户先要求 A、后明确否定 A 并改为 B。
- 助手提出建议但用户没有确认，不能变成项目事实。
- 多轮范围澄清、结构化答案、计划审批和 Run 完成后继续追问。
- 长报告、章节正文、附件和重复工具结果由引用进入，按需追问时能召回原文。
- “继续刚才的”“按之前那个设定”等模糊指代。
- 从 128K 模型切到 8K 模型，再切回大窗口模型。

### 17.4 端到端与人工验收

- 自动化至少覆盖 8K、32K、128K 三档窗口。
- 同一会话跨多次压缩、刷新和重启后仍能说出已确认约束、当前工作和未解决问题，并能引用来源。
- Inspector 中 pre/post Token、coverage、近期尾部和 source mode 与实际 payload 一致。
- Main、preload、Renderer 和持久化助手消息对第 15.2 节诊断字段做契约测试；字段名、零值/null 语义和状态码不得在进程边界丢失或重命名。
- 用压缩前后两份实际序列化 Provider 输入对账 `preCompressionProviderInputTokens` 和 `postCompressionProviderInputTokens`，并验证 `hardTokenCountMethod/profileId` 与参与硬预算判定的计数器一致。
- generation 重建期间持续展示同一 `rebuildTaskId`；多个 waiter 观察到相同的 `rebuildMaxChunks/rebuildMaxDurationMs` 和单调递增的共享 `rebuildElapsedMs`，完成、丢弃或达到上限后状态正确冻结。
- Inspector 对 dependency-only 刷新展示 `operationKind=dependency_refresh`、`triggerReason=dependency_changed`、coverage 增量为零和更新后的 dependencyHash 状态；当前请求身份状态为 `valid` 且 payload 出现次数为 1。
- 压缩期间取消不会产生新 revision 或残留“压缩中”状态。
- 压缩 Provider 故障时主会话可以使用明确的降级策略继续，或给出类型化错误，不无限等待。

## 18. 验收标准

1. 任何本轮省略内容都不会被错误记录为持久摘要已覆盖。
2. 当前用户消息和全部受保护结构状态在最终 payload 中 100% 存在；已持久化的当前 user 消息凭稳定 ID 从其他分区排除并恰好注入一次，身份无法验证或预算无法满足时调用前类型化失败。
3. 每次 coverage 推进都通过稳定 sequence、已关闭原子单元、sourceHash、dependencyHash、来源存在性和用户消息 ledger delta/累计索引校验；同一 generation 内旧 ledger 只追加不改写，纠正关系由新消息前向引用旧消息，完整重建必须进入下一 generation 并重新校验全部目标 coverage。dependency refresh 可以不推进 coverage，但只能在 coverage/sourceHash/generation/ledger 全部不变且新 dependencyHash/投影完整校验后提交新 revision。
4. 最终 payload 使用精确或经档案验证的保守上界计数，100% 不超过硬输入预算；没有硬安全计数器时调用前失败。正常压缩后达到目标预算或记录无法达到的受保护原因。
5. 完整消息、Artifact、Run 和项目数据在压缩前后无删除、无覆盖。
6. 已覆盖前缀可以通过摘要来源、ledger 或全历史词法路径召回原消息。
7. 连续三次摘要失败后停止自动重试，不出现请求级无限压缩循环。
8. 压缩成功后下一轮不会仅因使用了压缩前 usage 而立即再次压缩。
9. 诊断能回答“为什么压缩、压了什么、保留什么、省略什么、用了多少 Token、是否降级”。
10. v1 会话可以无损加载并迁移到 v2；不理解 v2 的旧代码仍能依靠完整消息安全降级。
11. 既有 v1 coverage 从 P0 起不再过滤默认历史；Main 是 v2 摘要唯一写入者，Renderer 旧状态不能覆盖 CAS 成功结果。
12. 完整 ledger 不进入 Compactor 或主模型；语义投影、Artifact 引用、单条文本、来源引用、ledger gist 和历史摘录满足第 10.1 节的 P1 硬上限及 Token 总预算；ledger 不永久引用 revision 内 `SummaryEntry`，被投影淘汰的 semantic 消息仍可召回；非 Artifact 项目事实具有可验证的版本来源。
13. dependencyHash 变化在有、无新 coverage 两种情况下都能恢复为 valid；失败期间 stale 条目不进入主模型，且不会伪造 coverage、改写 ledger 或递增 generation。
14. 只有绑定同一 CAS 快照、操作类型、目标来源身份、当前请求身份和 Compactor 档案的并发调用共享任务；非等价调用完成等待后从 Store 最新状态重新决策。
15. Inspector 能稳定展示操作类型、触发原因、当前请求身份校验状态和最终 payload 出现次数；dependency-only 刷新不会被误报为 coverage 压缩或 generation 重建。

## 19. 分阶段实施

### P0：阻断静默丢失

1. 增加 omitted/covered 和中文隐含创作事实回归测试。
2. 停止 v1 确定性摘要推进新 coverage，omitted 永不进入 coverage；同时停止使用已有 v1 `coveredMessageIds` 过滤默认历史。
3. 同时移除 AiService 的 8,000 字符预截断和 Assembler 的 `currentRequest` 压缩，新增超限错误。
4. 补齐 Renderer -> Main 的未决输入、与活动对象关联的原始答案及授权状态契约，将其与计划、范围和活动 Run 一起放入受保护分区并补测试。
5. 保持现有 UI 和 v1 读取兼容，不引入数据库迁移。

### P1：可靠语义压缩

1. 新增 CompressionCoordinator、Compactor、v2 Schema 和校验器。
2. 显式透传 `storageConversationId` 和用户驱动调用的 `currentRequest.messageId`，建立 Main 单写者和独立 summary CAS；普通 Renderer upsert 保留数据库摘要，当前请求凭稳定 ID 从历史候选排除并恰好注入一次。
3. 建立稳定消息 sequence 和 ContextAtomicUnit Builder，使用已关闭连续单元、近期完整尾部、sourceHash/dependencyHash 持久化；补齐当前请求与 pending input/追问的稳定来源关联。
4. 改造动态预算分配器，为支持档案接入精确或保守上界 TokenCounter，并增加压缩后最终计数和 next-turn reserve 回检。
5. 将 v2 拆为有界 semanticProjection 与持久 sourceIndex；ledger 采用 generation 内不可变的首次分类和前向 supersession，Compactor 输出新增 delta 并可接收有界相关历史摘录，重建使用分块候选和完成后单次 CAS，dependency refresh 支持有/无新增 coverage 两条校验路径，召回扩展到累计 ledger 和完整覆盖前缀词法搜索。
6. 接入 waiter 级取消、绑定 CAS 快照和操作/模型身份的共享任务键、类型化错误、安全重试、三次失败熔断和完整诊断。
7. 完成 v1 到 v2 的惰性迁移、项目来源失效、当前请求身份回归和 8K/32K/128K 自动化。

### P2：成本与体验优化

1. 对 Artifact、章节、附件和旧工具结果启用引用式微压缩。
2. 在主回复成功后接近高水位时后台预生成下一 revision；下一请求与后台任务共享同一协调器。
3. 扩展更多 Provider 的精确 tokenizer/token count 接口，逐步替换 P1 的保守上界计数以释放更多可用窗口。
4. 增加摘要质量采样、重建入口和过期提示；显式重建创建下一 generation，并复用与 sourceHash 失效相同的完整校验和 CAS 路径。
5. 在确定性召回不足且本地能力成熟后，再评估向量化长期会话检索。

## 20. 参考机制与采用边界

本需求参考了本地 `free-code` 中 Claude Code 兼容实现。源码事实与本项目采用方式如下：

| 参考源码 | 源码可确认的行为 | 本项目采用方式 |
| --- | --- | --- |
| `src/services/compact/autoCompact.ts` | 自动压缩阈值使用固定 13K buffer；连续 3 次失败后在当前 session 停止重试 | 采用提前触发和三次熔断，但 buffer 按窗口缩放，熔断键细化为会话 + Provider profile + 模型 |
| `src/services/compact/sessionMemoryCompact.ts` | 这是受开关控制的实验路径；默认保留至少 10K Token、5 条含文本消息，上限 40K，并回退边界以保护 tool_use/tool_result 和同一 assistant response | 采用“最小 Token + 最小完整回合”的近期尾部与原子边界，不复制 session-memory 文件协议 |
| `src/services/compact/compact.ts` | 生成 compact boundary；另算 `truePostCompactTokenCount` 和 `willRetriggerNextTurn`，但源码明确说明该值仍未包含下一轮约 20–40K 的 system prompt、tools 和 user context | 采用回检思想，并提升为对本项目最终完整 payload 的精确计数或保守估算，不能把参考值称为完整真实输入 |
| `src/services/compact/microCompact.ts` | 按开关、模型和缓存能力清理较旧工具结果；部分路径只提交 cache edits，并不改写本地消息 | 采用“先处理可重新读取的大块结果”的次序，改造为稳定 `sourceRef + contentHash + excerpt`，不依赖 Claude 缓存编辑 API |
| `src/services/compact/prompt.ts`、`compact.ts` | 使用编码任务摘要模板，禁用/拒绝压缩 Agent 的工具执行，并在压缩后恢复文件、计划、Skill 等编码上下文 | 只采用无工具、低温、受限输出原则；摘要 Schema 和恢复内容改为小说创作领域 |

`free-code` 当前公开快照中的 `src/services/contextCollapse/*` 是禁用占位实现，不能作为已实现能力或本需求的直接依据。

明确不采用：

- JSONL Transcript 的父子 UUID 重连和物理跳过旧日志。
- 编码任务专用的文件恢复、Skill 恢复和九段式摘要模板。
- 对所有模型使用固定 13K 缓冲。
- 把完整 Transcript 文件路径交给模型自行读取。
- 在首期实现手动局部压缩和多方向恢复 UI。

采用后的产品形态仍以小说编辑器现有边界为准：SQLite 中保存完整会话，项目事实由章节、实体、Artifact 和用户确认状态持有，持久摘要只负责让模型在有限窗口内可靠地继续当前创作协作。
