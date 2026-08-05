# Agent 多章节处理 V1 需求

版本：v1.0  
日期：2026-07-17  
状态：开发中；既有主链与 Renderer 已完成，2026-07-29 起补充全局章节顺序与读取委托

适用范围：CloudDream Novel Agent 章节范围、上下文装配、专家 Toolchain、报告审批、草稿批次与审核界面。

## 1. 背景与定位

现有 Agent 已具备单章上下文读取、单章续写、一致性审核、情节线分析、DraftSession、结构化 Artifact 和计划审批，但章节范围仍分散在不同 Toolchain 中，多章节写作也尚未形成稳定的批次契约。

多章节能力不归属于“续写”，而是 Agent 平台的统一范围层。作者、编辑、读者、世界观、考据和团队 Agent 必须复用同一范围快照、基础上下文和审批边界，再按角色投影不同的可见内容。

总体链路固定为：

```text
AgentChapterScope
  -> chapter.scope_context
  -> ChapterScopeBundle
  -> 角色专属上下文投影
  -> 作者 / 编辑 / 读者 / 世界观 / 考据
  -> 团队 Supervisor 汇总
  -> 计划 / 报告 / 草稿审批
  -> 修订任务或正文提交
```

## 2. 建设目标

1. 为当前章、选择章节、章节区间、当前卷和整本小说提供统一范围契约。
2. 让各专家复用同一份章节读取、版本快照、覆盖统计和证据集合。
3. 让单章续写与多章续写复用现有 `ContextBuilder` 的分层上下文策略。
4. 支持多章节新增、批量改写、跨章审核、读者旅程、世界观一致性和考据核验。
5. 为大范围分析提供可见的分页、摘要、预算和覆盖率，而不是静默截断。
6. 为报告与草稿建立不同的审批、过期和写回语义。
7. 保持 Renderer、IntentService、Planner、Runtime、Toolchain 和 Electron 数据边界清晰。

## 3. V1 边界与默认限制

- 详细逐章分析的单批阈值为 20 章，默认每批处理 4 章；这是处理模式和窗口预算，不是读取授权的语义上限。
- 超过 20 章自动进入分批摘要模式，必须显示全文覆盖率、摘要覆盖率、未覆盖范围和原因；证据不足时可以继续下一批。
- 写作类任务每批 1 至 5 章，默认 2 章。
- Renderer 显式范围和结构化入口携带的真实章节 ID 高于模型推断。
- 未获得用户读取委托时，模型不得自行把当前章扩大到其他章节、当前卷或整本小说；用户明确允许自适应选择后，可以在该只读授权内扩展。
- 目标范围、写入范围或处理模式变化必须重新审批计划；已授权的自适应上下文读取不因每次 resolved scope 增加而重复审批。
- V1 不支持整本小说批量改写、自动合并冲突、强制覆盖或无需审核的正文写回。
- 现有 `chapter.continuation@1.0.0` 保持单章语义；多章新增使用独立 `chapter.sequence_continuation@1.0.0`。

## 4. 公共范围契约

新增统一 `AgentChapterScope`：

```ts
type AgentChapterScope = {
  scopeId: string;
  novelId: string;
  kind:
    | 'current_chapter'
    | 'selected_chapters'
    | 'chapter_range'
    | 'current_volume'
    | 'novel';
  volumeId?: string;
  chapterIds: string[];
  anchorChapterId?: string;
  processingMode: 'detailed' | 'batched';
  snapshot: Array<{
    chapterId: string;
    version: number;
    contentHash: string;
  }>;
};
```

范围规则：

- `chapterIds` 始终按作品顺序固定。
- `selected_chapters` 允许不连续选择。
- 未选中的中间章节可以作为只读连续性上下文，但不能成为改写或提交目标。
- `anchorChapterId` 由写作页快捷桥或用户显式选择确定；已存在时不得重复询问起点。
- “当前章”“这一章”等指代优先解析为 Renderer 当前 SelectionContext。
- Planner 或模型给出的范围只是建议，Runtime 必须重新校验用户原话、结构化入口和审批结果。
- 快照中的版本与正文哈希用于报告过期判断、草稿依赖判断和提交冲突检查。

### 4.1 目标范围、读取范围与写入范围

- `AgentChapterScope` 继续表达用户明确选择的目标章节；额外上下文章节以 `target=false` 进入 Bundle。
- `readAuthorization` 和 `resolvedReadScope` 遵循 [Agent 章节读取范围与委托需求](./chapter-read-scope-delegation-requirements.md)，不得塞进单个 `kind` 字段后丢失授权语义。
- 章节邻接按整本小说的 `volume.order -> chapter.order` 计算。卷只用于组织和展示，不是相邻读取边界。
- 明确范围必须全部读取；委托范围可以根据证据缺口自适应扩展，不设置固定同卷或前后 N 章的语义硬上限。
- `ChapterScopeBundle` 必须区分目标章节和只读上下文章节，并记录全局顺序指纹、选择理由、内容模式与实际 coverage。
- 只读上下文可以支撑修改计划，但不能自动进入 `writeScope`、批次草稿或正文提交。

## 5. 共享章节上下文

新增 `chapter.scope_context@1.0.0`，统一分页读取：

- 目标章节正文与章节摘要。
- 小说级、卷级叙事摘要。
- 人物、物品、地图和世界观规则。
- 情节线、伏笔和状态信息。
- RAG 与外部检索证据。
- 当前编辑器未保存内容。
- 覆盖率、Token 预算、裁剪记录和警告。

输出 `ChapterScopeBundle`：

```ts
type ChapterScopeBundle = {
  scope: AgentChapterScope;
  chapters: ChapterContextItem[];
  narrativeSummaries: NarrativeSummary[];
  entityContext: EntityContext;
  plotContext: PlotContext;
  evidence: EvidenceRef[];
  stateLedger: NarrativeStateLedger;
  coverage: ScopeCoverage;
  sourceSnapshot: SourceSnapshot[];
  warnings: ContextWarning[];
};
```

职责边界：

- Electron `ContextBuilder` 是小说上下文选择、摘要新鲜度判断和预算裁剪的唯一事实来源。
- Python Runtime 负责范围校验、Toolchain 编排、审批、并发和恢复，不重新实现上下文选择逻辑。
- `AgentContextAssembler` 继续负责最终模型窗口预算；它不得改变 `ChapterScopeBundle` 的来源语义。
- 综合协作视角只装配一次基础 Bundle，再按 AI 工作视角生成受限投影。
- 完整工具结果和长正文通过 Artifact 或上下文引用传递，不在会话消息中重复复制。

## 6. 分层续写上下文

单章续写和多章续写复用 `ContinuationContextPolicy`。该策略是 `ChapterScopeBundle` 的作者投影，不建立第二套上下文系统。

默认上下文按以下优先级装配：

1. 人物、物品、地图、世界观规则和生效情节线。
2. 小说级摘要、当前卷摘要和长期叙事状态。
3. 单次模型投影中装配目标章节之前最多 8 章的章节摘要，允许配置，单窗口硬上限 20 章。
4. 单次模型投影中装配目标章节之前最近 2 章全文，允许配置为 1 至 3 章。
5. 当前编辑器内容；未保存内容以编辑器缓冲区快照为准。
6. 用户批准的整批章节节拍和每章交付目标。
7. 相关人物、伏笔、设定和 RAG 证据。
8. 当前会话中已经确认的创作要求。

这里的 1 至 3 章全文和最多 20 章摘要都是单次模型投影窗口，不是读取授权或任务总覆盖上限。更早或更多章节可由前序读取批次、带版本摘要和状态台账承接；证据仍不足时继续下一批，并在 Artifact 中保留完整 resolved scope 与 coverage。

每次生成保存 `ContinuationContextSnapshot`，至少记录：

- 来源章节、摘要、实体和证据 ID。
- 章节版本、正文哈希和摘要版本。
- 全文窗口、摘要窗口和处理顺序。
- Token 用量、裁剪和退化记录。
- 编辑器缓冲区哈希。
- 批次节拍 revision。

摘要新鲜度规则：

- 优先使用与当前正文版本匹配的活动摘要。
- 摘要缺失或过期时优先根据当前正文重新生成。
- 无法生成时退化为有界原文摘录。
- Inspector 必须显示摘要缺失、过期或退化警告。
- 不得静默使用与正文版本不一致的摘要。

## 7. 多章生成与依赖管理

`chapter.sequence_continuation@1.0.0` 在正文生成前必须产出并审批整批章节节拍。每章节拍包含：

- 标题。
- 章节目标。
- 核心冲突。
- 关键事件。
- 信息揭示。
- 结尾钩子。
- 目标字数。

用户确认后固定 `outlineRevision`，正文按顺序连续生成。

滚动上下文规则：

- 第一章使用锚点章节及其前文。
- 后续章节始终保留时间线上最近 2 章全文。
- 本批更早章节转为结构化摘要。
- 每生成一章立即更新章节摘要和 `NarrativeStateLedger`。
- 状态台账记录人物位置、关系变化、认知范围、伏笔、时间线、物品状态和未解决冲突。
- 人物位置、关系、认知和物品状态由生成正文后的低温结构化抽取形成；每条变化必须携带正文连续原句证据，无法在正文中精确匹配的条目确定性丢弃。
- 状态增量以 `childIndex + generationRevision + draftSessionId` 保存来源历史；后续章读取推导后的最新状态及有界增量记录。
- 状态抽取失败时保留已生成草稿，并明确降级到节拍、正文摘要、时间线、钩子和冲突台账，不把抽取失败误报成草稿生成失败。
- 下一章使用整批节拍、当前章节拍、最近全文、此前摘要和最新状态台账。

失败、重写与失效规则：

- 某章失败后立即停止；此前成功章节保持可审核，后续章节保持 `pending`。
- 审批意见只挂在不满意的行、段落、diff 块或章节上；未添加意见的内容默认认可，不增加逐章通过勾选。
- 同一批次的审批意见必须整体发送。发送前确认范围：`仅重写有意见的章节` 或 `从最早意见章节起重新生成`。
- `仅重写有意见的章节` 为全部被批注章节创建新的子 DraftSession，保留其他草稿并统一执行连续性复核。复核通过时后续章保持可审核；检测到情节、角色状态、时间线、伏笔、物品状态或结尾钩子冲突时，只将受影响的后续草稿标记为 `stale`。
- `从最早意见章节起重新生成` 沿用保守依赖规则，将最早被批注章节及所有依赖它的后续草稿标记为 `stale`，回滚状态台账后连续重生成。
- 人工编辑第 N 章时，第 N 章及后续的旧状态增量立即失效；后续生成读取修改后的正文，不得继续使用旧正文抽取的状态。
- `从这里重新生成` 从首个失败或过期章节创建关联 Run。
- 每章拥有独立 invocation key、状态、错误和重试边界。
- 副作用未知时使用 `draftBatchId + childIndex + generationRevision` 对账。
- 无法确认生成结果时 fail-closed，不自动重复调用模型。

## 8. 多角色 Toolchain

| Agent | Toolchain | 结构化产物 | 核心行为 |
| --- | --- | --- | --- |
| 作者 | `writer.range_revision_plan` | `writer_revision_plan` | 文风漂移、场景强弱、改写顺序和续写准备 |
| 作者 | `chapter.sequence_continuation` | `chapter_draft_batch` | 连续新增 1 至 5 章 |
| 作者 | `chapter.batch_rewrite` | `chapter_draft_batch` | 改写明确选择的已有章节 |
| 编辑 | `editor.range_review` | `chapter_range_review` | 结构、节奏、动机、文字质量和跨章连续性 |
| 读者 | `reader.journey_review` | `reader_journey` | 困惑、情绪、悬念、弃读风险和追更动力 |
| 世界观 | `worldbuilding.range_consistency` | `worldbuilding_consistency` | 规则、术语、能力、地点、物品和状态漂移 |
| 考据 | `research.range_fact_check` | `research_fact_check` | 可核验陈述、证据、来源和可信度 |
| 团队 | `novel.scope_audit` | `scope_audit` | 并行专家分析、去重、冲突仲裁和综合结论 |

综合协作视角规则：

- 默认建议编辑、读者和世界观。
- 作者与考据根据任务目标推荐。
- 实际专家、执行顺序和外部检索必须在计划卡中列明。
- 基础 `ChapterScopeBundle` 只装配一次。
- 专家模型调用最大并发为 2，其余排队。
- Supervisor 只能汇总实际执行专家的结果，不得伪造未执行专家意见。

## 9. 读者知识隔离

读者使用严格顺序盲读投影：

- 评估第 N 章时，只能看到第 N 章及此前正文。
- 允许读取此前形成的读者状态摘要。
- 不得读取未来章节、未来节拍、后台世界观条目或其他专家报告。
- 团队 Supervisor 可以读取读者报告，但不能向读者子链回灌作者知识。
- 自动化测试必须使用未来章节特征词验证请求中不存在知识泄露。

## 10. 三层审批

### 10.1 范围与计划审批

计划卡必须展示：

- 章节范围、目标章节和处理模式。
- 将调用的专家及执行顺序。
- 是否使用外部检索。
- 预计模型调用数和正文生成数。
- 全文、摘要覆盖率和可能省略范围。
- 多章写作的整批节拍。

目标范围、写入范围、处理模式或批次节拍变化都必须重新审批。用户已经委托的只读上下文自适应扩展只更新 coverage 和活动记录；超出用户授权语义时才重新询问。

### 10.2 报告审批

```ts
type FindingDecision = {
  findingId: string;
  status: 'accepted' | 'rejected' | 'deferred';
  note?: string;
};
```

- 支持按章节、专家和严重度批量处理 finding。
- 接受 finding 不修改正文。
- 接受的问题在事务中创建 `AgentRevisionTask`，初始状态为 `open`。
- 修订任务保存来源 Artifact、finding、目标章节和建议角色。
- 报告使用独立 `reviewStatus`，不复用草稿的 committed/discarded 状态。
- 源章节变化后报告标记为过期；仍可阅读，但生成修订计划前必须刷新分析。

创作者界面的决策文案与内部状态分离，且不随 AI 工作视角变化：

- `帮我修改` 映射为 `accepted`，表示把问题加入修订范围，不表示无条件接受模型给出的具体改法。
- `稍后处理` 映射为 `deferred`，任务进入“待改清单”，不打断当前创作。
- `忽略建议` 映射为 `rejected`，只记录本次决定，不删除原报告。
- 每项必须允许填写可选创作约束或审核备注；生成草稿时必须带入，而不是只使用模型原 recommendation。
- 报告卡必须展示问题位置、阅读影响、建议方向、证据和不确定性。内部 Artifact/Finding ID 只在技术详情中出现。
- 没有明确目标章节的全局 finding 在进入修订前必须补充范围，不能创建一个后续无法执行的任务。
- “全部接受”不作为默认操作；批量加入修订前显示条目数、涉及章节和已知冲突。

### 10.3 草稿审批

- 多章草稿由一个 `DraftBatchRecord` 和 N 个有序 `DraftSession` 组成。
- 新章节在审核提交前不进入正式章节树。
- 只能提交连续且非过期的前缀，例如“提交前 2 章”。
- 当前章节不是卷末时，必须确认“当前章后插入”或“卷末追加”。
- 改写已有章节时，提交前统一校验版本和正文哈希。
- 任一目标冲突则整次提交零写入。
- V1 不支持自动合并或强制覆盖。

## 11. Agent 界面要求

### 11.0 Stitch 原型门禁

- 所有新增或调整 Renderer 界面的需求，必须先在 Stitch 完成原型设计并经用户确认，之后才能进入前端实现。
- 原型至少覆盖主流程、空状态、加载状态、失败/冲突状态、长内容滚动以及桌面与窄窗口布局。
- Stitch 原型确认后，需要将 screen、关键交互、状态文案和验收截图链接回本需求文档或对应实施记录。
- 未完成原型评审时，可以继续开发 Schema、Runtime、Automation、持久化和测试，但不得提前实现对应 Renderer 页面或控件。
- 原型发生范围、交互或信息架构变更时，相关前端实现任务重新进入原型评审；仅颜色、间距等不改变行为的细节可在既有设计系统内调整。

原型登记（2026-07-18）：

- 已在 Stitch 项目 `7717701781434255808` 生成范围与计划审核、专家报告、报告审批、多章草稿批次审核、团队执行态、修订任务池和窄窗口异常态七张第一轮 Screen。
- Screen ID、覆盖状态和待修订项记录在 `docs/agent/ui-and-prototype.md` 的“多章节 V1 原型包”中。
- 首轮信息架构和“右侧 Inspector 不扩大”的布局约束已经用户确认。范围选择、专家报告、报告审批、多章批次审核、修订任务池及副作用未知对账均已按对应 Stitch Screen 实现。

### 11.1 范围选择

- 输入框旁增加章节范围控件。
- 显示“当前章”“已选 6 章”“第 3–8 章”“当前卷”等状态。
- 支持章节树复选、连续区间选择和清除。
- 多选顺序固定为作品顺序，不允许拖动。
- 显示“用户明确选择”“AI 自适应选择”和“实际已读取”的区别；跨卷邻接章节显示卷名，但不要求用户按卷重新授权。
- AI 范围选项必须能展开真实章节标题或自适应策略，选择后产生真实正文读取记录，不能只改变 `rag.ask` 提示词。

### 11.2 执行过程

- 会话中只显示一条持续变化的运行状态。
- 折叠摘要示例为“正在分析第 5/12 章”或“读者评估 2/4 批次”。
- 展开后显示上下文读取、工具调用、模型调用和阶段结果。
- 中间过程不得作为普通助手消息散落在会话中。

### 11.3 Inspector 与审核中心

- 对话报告卡提供审核摘要、关键建议、选择状态和“修改选中项”，Inspector 折叠时主流程仍可完成。
- Inspector 的“审核”Tab 是草稿、文章修改、结构化产物和报告的统一审核入口；长正文仍可在该 Tab 内切换到既有宽幅审核视图，不新增一级审核页面。
- Inspector 可完全折叠且不得被新事件自动打开；按需显示实际使用的大纲、摘要、全文章节和证据。
- Inspector 显示来源版本、上下文用量、裁剪和退化原因。
- 专家标签、章节矩阵、总体趋势和逐章 finding 的摘要留在对话；完整证据和长内容进入用户主动打开的专注审核视图。
- 综合报告保留专家子 Artifact，但对话只发布一张去重、排序并保留真实冲突的综合报告卡，首屏显示 3 至 5 项。
- 草稿批次显示生成中、待审核、已通过、过期、失败和冲突状态。
- 会话中每个历史产物卡必须能重新打开其对应的 Artifact、DraftSession 或 DraftBatch；历史版本只读，不增加独立版本对比页。
- 报告建议处理和草稿确认使用独立操作与状态文案。
- 所有 AI 工作视角共享轻量“待改清单”；默认只显示 `待处理 / 处理中 / 已完成 / 已失效`，章节、人物、情节线、来源视角和严重度筛选按需展开。

### 11.4 当前对话修订批次

- 用户在报告卡点击“修改选中项”后，在原对话创建单个 `RevisionWorkBatch`，不得为每条建议新建会话。
- 折叠态显示 `第 N/M 项修订 · 当前事项`；展开态显示用户选择的修订事项及等待、处理中、待审核、完成、跳过和失败状态。
- M 是用户确认后的稳定修订事项数。LangGraph 节点、Tool 调用、模型请求和重试只作为事项明细，不增加 M。
- 相同章节或存在依赖的事项可以共享草稿生成单元，但每个 `AgentRevisionTask` 保留来源、状态和最终验证结果。
- 小范围可逆草稿以“修改选中项”作为执行授权；跨多章结构调整、主线重排、大段删除或范围不明确时必须额外确认修订方案。
- 所有正文写回仍必须经过最终草稿或 diff 审核。

#### 11.4.1 批量改写的章节拍检查点与状态可达性

“修改选中项”只免除通用形式化计划审批，不免除多章节正文生成前的章节拍检查点。`chapter.batch_rewrite` 创建 `DraftBatchRecord` 并生成逐章节拍后，必须以 `waiting_approval / chapter_beats` 暂停；该检查点属于同一 `RevisionWorkBatch` 进度，不得显示为另一张普通计划卡。

| Runtime / 批次阶段 | 对话中的稳定状态 | 可执行操作 |
| --- | --- | --- |
| 尚未创建 Run 或正在生成章节拍 | `正在准备修订` / `正在生成 N 章节拍` | 展开修订事项；其他写操作禁用 |
| `waiting_approval / chapter_beats` | `待确认 · N 章节拍`，并明确“正文尚未生成” | 查看节拍、提交调整、确认并生成、取消任务 |
| `running / waiting_operation` 且批次未完成 | `正在生成正文 · X/N` | 查看生成进度；已有内容只读预览 |
| 已生成部分子草稿后失败或取消 | `生成未完成 · 已生成 X/N` | 查看已生成内容；由现有进度卡提供续跑或重试 |
| `ready_for_review` 或存在正式 `chapter_draft_batch` Artifact | `N 章待审核` | 打开批次审核、差异对比和现有审核操作 |
| `stale / failed / discarded` | 对应只读终态 | 查看已有内容和失败原因，不得把残缺结果表现为正式报告或完整批次 |

- `RevisionWorkBatch` 进度卡从创建到最终草稿就绪始终占据同一位置；章节拍确认卡作为该位置下的当前决策区显示，确认后原地切换为生成进度。
- `draftBatchId` 一经创建，对话就必须提供唯一的当前批次主卡；可读节拍就绪后显示“查看章节拍”，生成中显示“查看生成进度”，部分完成显示“查看已生成内容”，正式产物就绪后才称为“打开批次审核”。
- 任何当前 Run 进入 `waiting_approval` 时，对话中必须存在且只能存在一个可提交该 checkpoint 的操作入口。Inspector 折叠、刷新、Runtime 重启或修订批次专用 Renderer 均不得使该入口不可达。
- Inspector 可以在正文生成前只读预览节拍和子项状态，但确认动作必须留在会话；生成期间打开的详情需要跟随批次状态刷新，不能让用户误判为停止或无产物。
- 正文是否已经生成必须使用明确文案表达，不能仅通过按钮出现或消失让用户推断。

#### 11.4.2 单一稳定卡片与章节拍历史

##### 11.4.2.1 渲染归属

- 每个 `Run + draftBatchId` 在会话中只能有一个当前批次主卡。该卡在 `DraftBatchRecord` 创建后出现，并持续到批次提交、丢弃或进入不可恢复终态；状态变化只能更新原卡，不得在其下方追加另一张同级“章节拍”“生成详情”或“批次审核”卡。
- 对 `RevisionWorkBatch`，当前批次主卡属于原位修订进度的当前工作区；对 `chapter.sequence_continuation`，它属于对应 Run 的稳定执行区。两种入口共用相同状态机和文案，不因 Toolchain 来源不同产生两套卡片。
- `waiting_approval / chapter_beats` 的章节拍检查点必须嵌入当前批次主卡。章节列表摘要、调整输入、唯一的“确认并生成”、取消任务和当前阶段唯一的查看入口都由该卡提供；不得同时渲染独立 `ChapterBeatConfirmationCard` 与独立 `DraftBatchCard`。
- `draftBatchId`、`operationId`、调用次数和原始错误栈只进入“活动详情”或诊断视图，默认卡片不显示裸 UUID。用户可见标题只描述创作阶段和进度。

##### 11.4.2.2 卡片结构

当前批次主卡固定包含以下区域，未满足显示条件的区域不占位：

1. 状态头：阶段标题、业务状态徽标、折叠按钮，以及当前阶段唯一的查看动作。
2. 阶段摘要：明确正文是否尚未开始、正在生成、已部分生成或已经可审核。
3. 当前决策区：仅在存在活动 checkpoint 时显示调整、确认和取消；同一时刻只能绑定最新活动 `checkpointId`。
4. 业务进度：按章节显示 `待生成 / 排队中 / 生成中 / 已生成 / 失败 / 已过期`，技术调用放入更深一层活动详情。
5. 节拍记录：默认折叠，保存已替代和已确认的节拍版本入口，不与当前状态争夺主操作层级。

##### 11.4.2.3 阶段、文案与动作

| 归一化 UI 阶段 | 主标题 | 必须显示的摘要 | 唯一主查看动作 | Inspector 模式 |
| --- | --- | --- | --- | --- |
| `preparing_outline` | `正在生成 N 章节拍` | `正在准备生成前检查点，正文尚未生成。` | 无；存在可读快照后才出现入口 | 无 |
| `awaiting_outline` | `章节拍待确认 · N 章` | `正文尚未生成。确认章节拍后才会开始生成正文。` | `查看章节拍` | 指定 revision 的只读快照 |
| `starting_generation` | `节拍已确认 · 正在启动正文生成` | `已确认节拍 vR，正文任务正在排队。` | `查看生成进度` | 当前批次实时状态 |
| `generating` 且 `X = 0` | `正在生成正文 · 0/N` | `正文草稿正在生成中。` | `查看生成进度` | 当前批次实时状态 |
| `generating` 且 `0 < X < N` | `已生成 X/N · 继续生成中` | `已有内容可只读查看，其余章节仍在生成。` | `查看已生成内容` | 当前批次实时状态 |
| `interrupted` 且 `X = 0` | `章节生成未完成` | 显示失败、取消或需恢复的业务原因，不得暗示已有正文 | `查看失败原因` | 当前批次实时状态与恢复操作 |
| `interrupted` 且 `X > 0` | `生成未完成 · 已生成 X/N` | `已生成内容仍可查看；后续章节尚未完成。` | `查看已生成内容` | 当前批次实时状态与恢复操作 |
| `ready_for_review` | `N 章待审核` | `正文草稿已生成，尚未写回正式章节。` | `打开批次审核` | 正式批次审核 |
| `committed / discarded / stale` | 对应明确终态 | 显示写回、丢弃或过期结果 | 仅提供与终态一致的只读入口 | 对应历史批次 |

- `queued`、`leased`、`running` 和可恢复的 `waiting_operation` 都属于启动中或生成中，不得仅因 Run 暂时没有新事件就归类为 `interrupted` 或显示“多章节生成未完成”。
- `interrupted` 只能由持久批次或 Operation 的失败、取消、对账阻断等终态事实推导；Renderer 不得只用 `Run.status in completed/failed/cancelled` 且没有 Artifact 这一条件猜测批次失败。
- 确认请求被持久接受后，原卡立即退出可提交态并进入 `starting_generation`；不得继续展示可点击的“确认并生成”，也不得等待首个正文事件后才切换文案。
- 主查看动作在任一阶段只能出现一次。卡片头、决策区和卡片底部不得重复提供指向同一对象的“查看节拍 / 查看章节拍”。

##### 11.4.2.4 节拍版本与历史回看

- 当前待确认 revision 是唯一可调整和确认的版本。提交调整后，原卡保持位置不变，新 revision 替换当前决策区，旧 revision 移入折叠的“节拍记录”。
- “节拍记录”按 revision 倒序显示 `vR · 已确认 / 已替代 / 调整已提交`。历史版本只能使用“查看 vR 节拍”打开只读快照，不提供确认、再次提交或写回动作。
- 确认后，`已确认节拍 vR` 作为当前主卡的次级元数据保留；其查看入口收在“节拍记录”内，不继续保留一张同级“确认 N 章节拍 · 已确认”大卡片。
- 历史快照以 `runId + checkpointId + draftBatchId + outlineRevision` 标识，显示该 checkpoint 发布时的不可变节拍。若标识与批次当前 revision 不一致，必须按历史版本展示，不得静默替换成最新节拍。
- 当前待确认节拍以活动 approval payload 为提交边界，同时校验 `draftBatchId` 和 `outlineRevision`；批次实时读取只用于生成进度和草稿状态，不得在用户确认前悄悄改变屏幕上的待确认内容。

##### 11.4.2.5 Inspector 选择与标题

Inspector 的审核选择必须使用互斥模式，不得依赖“是否恰好存在 beatPreview”之类的隐式优先级：

| 选择模式 | 数据源 | Inspector 标题 | 刷新行为 |
| --- | --- | --- | --- |
| `chapter_beat_snapshot` | 指定 checkpoint 的节拍快照 | `章节节拍预览 · vR` | 不轮询；始终保持所选 revision |
| `draft_batch_progress`，尚无正文 | 当前 `DraftBatchRecord` 与 Operation 状态 | `章节生成进度` | 订阅事件并轮询恢复，直到离开活动状态 |
| `draft_batch_progress`，已有部分正文 | 当前批次及已生成子草稿 | `已生成内容 · X/N` | 实时刷新，不允许编辑或提交残缺批次 |
| `draft_batch_interrupted` | 当前批次、Operation 和失败/对账信息 | `章节生成未完成` | 提供与状态匹配的恢复或重试入口 |
| `draft_batch_review` | 正式 `chapter_draft_batch` Artifact 与 DraftSession | `多章节草稿审核` | 使用既有审核和版本冲突规则 |

- Inspector 外壳只显示一次当前模式标题；内容区不得再次重复同名主标题。内容区可以显示版本、批次状态和章节计数等次级信息。
- 节拍快照始终只读，并明确“确认和调整请在会话中完成”。实时生成视图不得出现章节拍确认按钮。
- 点击历史节拍不会改变当前批次状态，也不会停止实时任务；关闭 Inspector 后，会话主卡仍保持当前阶段。用户再次点击主卡动作时，应切回当前批次实时模式。
- 打开、关闭、折叠或刷新 Inspector 均不得自动提交 checkpoint、丢失未提交的调整文字或自动展开 Inspector。窄窗口沿用覆盖抽屉，不增加新的一级页面。

##### 11.4.2.6 恢复与一致性

- 刷新或 Runtime 重启后，Renderer 必须根据活动 `pendingApproval`、最新 checkpoint、`DraftBatchRecord`、子草稿和持久 Operation 状态重建同一张主卡，不依赖组件内临时状态判断阶段。
- 多个重复的 `approval_required` 或恢复事件按 `checkpointId + outlineRevision` 去重；任何时刻只允许最新活动 checkpoint 进入当前决策区，其余版本进入“节拍记录”。
- 批次实时状态优先于会话事件数量推导的 `X/N`；事件流只用于活动展示，不能把重放的 `draft_created` 重复计数。
- 若 checkpoint 可提交但批次暂时读取失败，确认入口仍按持久 checkpoint 保持可达，预览区显示可恢复错误；不得因为 Inspector 或批次读取失败隐藏唯一确认入口。

##### 11.4.2.7 Renderer 投影契约

Renderer 应通过一个无副作用投影统一生成当前主卡，例如 `projectDraftBatchConversationState`，输出至少包含：

```ts
type DraftBatchConversationState = {
  stableKey: string; // runId + draftBatchId
  stage: 'preparing_outline' | 'awaiting_outline' | 'starting_generation'
    | 'generating' | 'interrupted' | 'ready_for_review'
    | 'committed' | 'discarded' | 'stale';
  generatedCount: number;
  totalCount: number;
  activeCheckpoint: ChapterBeatCheckpointSnapshot | null;
  beatHistory: ChapterBeatCheckpointSnapshot[];
  primaryView: 'none' | 'chapter_beat_snapshot' | 'draft_batch_progress'
    | 'draft_batch_interrupted' | 'draft_batch_review';
};
```

投影按以下事实优先级决策，排在前面的已成立事实不得被后面的弱信号覆盖：

1. 正式 `chapter_draft_batch` Artifact 或批次 `ready_for_review / committed` 状态。
2. 持久 `DraftBatchRecord` 状态、子项状态和有效 DraftSession。
3. 持久 Operation 的 `queued / leased / running / succeeded / failed / cancelled / reconciliation_required` 状态。
4. 当前 `pendingApproval` 与最新章节拍 checkpoint。
5. Run 事件和 Run 顶层状态，仅用于补充活动说明与无批次记录时的降级。

- `generatedCount` 按批次中已绑定有效 DraftSession 的唯一 `childIndex` 计算，不能直接统计 `draft_created` 事件数；`totalCount` 使用批次 children 数，批次暂不可读时才退化为当前节拍数。
- `activeCheckpoint` 仅在它与当前 Run 的 `pendingApproval.checkpointId` 一致时非空。其余章节拍 checkpoint 去重后进入 `beatHistory`，已确认版本也不能作为第二个根级时间线卡片返回。
- `stableKey` 在同一批次全生命周期内不得随 stage、revision 或 Operation attempt 改变，以保证原位更新、折叠状态和滚动锚点稳定。
- Inspector 选择使用显式判别联合：节拍快照必须携带 `runId + checkpointId + draftBatchId + outlineRevision + beats`；实时模式只携带 `runId + draftBatchId + mode` 并从持久批次读取。打开任一模式时必须整体替换旧选择，不能同时保留快照和实时选择再靠渲染顺序决定标题。

### 11.5 可逆草稿与低打扰执行

- DraftSession 继续保存原文、草稿、来源版本和批次快照；默认审核视图改为修改摘要与逐处高亮 diff，完整左右对照按需切换。
- 单章写回补齐与多章批次一致的版本/内容哈希冲突保护；写回后提供带版本校验的一次操作级撤销。
- 一次审核到修订只在对话保留综合报告卡、原位修订进度和最终草稿卡；章节拍确认与生成状态属于原位修订进度的子状态，不增加普通计划卡，`draft_created` 不自动展开 Inspector。
- 专注执行可以自动读取、分析和生成固定范围的可逆草稿，并合并必要确认；正文写回、版本冲突和未知副作用对账仍为硬阻断。
- 智能视角后续复用 IntentService `suggestedRole` 和 Capability Matcher，不增加独立分类调用，也不阻塞本节其他改造。

## 12. 数据与接口变更

新增核心类型与持久化对象：

- `AgentChapterScope`
- `ChapterScopeBundle`
- `ContinuationContextPolicy`
- `ContinuationContextSnapshot`
- `NarrativeStateLedger`
- `DraftBatchRecord`
- `DraftChapterRecord`
- `ExpertReport`
- `AgentRevisionTask`

新增 Deliverable：

- `expert_report`
- `chapter_draft_batch`

新增 Artifact 类型：

- `writer_revision_plan`
- `chapter_range_review`
- `reader_journey`
- `worldbuilding_consistency`
- `research_fact_check`
- `scope_audit`
- `chapter_draft_batch`

状态变更：

- `AgentRun.draftBatchId`
- `AgentArtifact.reviewStatus`
- `AgentArtifact.reviewRevision`
- 保留 `draftSessionId` 兼容单章任务。
- `draft-sessions.json` 增加向后兼容的 `batches` 集合，批次子草稿不再互相淘汰。

新增 API：

- `artifact.review.submit`
- `revision_task.list`
- `revision_task.create_plan`
- `draft.batch.get`
- `draft.batch.commit_prefix`
- `draft.batch.discard`
- `agent.regenerate_batch`

所有新增 Schema 必须同步 Python、Electron、preload、Renderer 和持久化层。旧 Run、Artifact 和 DraftSession 必须无迁移阻塞地加载。

## 13. 实施顺序

1. 落地公共范围、版本快照、`chapter.scope_context` 和角色上下文投影。
2. 将现有单章续写迁移到统一 `ContinuationContextPolicy`，保证行为不回归。
3. 实现多章节拍、滚动上下文、父子草稿批次和失效传播。
4. 实现编辑、读者、世界观和考据的范围报告 Toolchain。
5. 实现报告审批、修订任务池和团队 Supervisor 汇总。
6. 完成范围选择器、活动流、Inspector 和审核中心。
7. 最后开放卷/全书分批分析；写作范围仍保持最多 5 章。

## 14. 测试与验收

### 14.1 范围与上下文

- 覆盖当前章、多选、区间、卷、全书和非连续章节。
- 验证模型不能越权扩大 Renderer 指定范围。
- 验证当前卷卷首的“上一章”解析为上一卷卷尾，卷重排后旧顺序指纹失效。
- 验证用户读取委托允许跨卷自适应扩展，且不会扩大草稿或写回目标。
- 验证用户自定义范围覆盖 AI 推荐选项，并在内容选项或计划生成前完成正文读取。
- 单批 20 章以内逐章有结果；超过单批阈值时显示完整覆盖统计并可继续后续批次。
- 验证单次模型投影中最近 2 章使用全文、更早章节使用摘要，但实际读取 coverage 不被该投影窗口截断。
- 验证未保存编辑内容进入上下文快照。
- 验证过期摘要不会被静默使用。
- 验证综合协作视角只读取一次基础 Bundle。

### 14.2 专家与报告

- 验证读者无法访问未来剧情和后台设定。
- 验证 finding 证据属于范围章节或实际检索来源。
- 验证团队汇总不包含未执行专家的评价。
- 验证报告卡在 Inspector 折叠时仍可完成建议选择和修订发起，并能按需打开完整证据。
- 验证“帮我修改”创建或复用修订任务并在原对话形成单个 `RevisionWorkBatch`，不直接修改正文。
- 验证小范围修订不重复审批形式化计划，高风险修订会增加方案确认，二者都必须在写回前审核最终草稿。
- 验证报告过期后不能直接生成自动修订草稿或方案。

### 14.3 多章草稿

- 验证整批节拍审批和固定 revision。
- 验证一个 `Run + draftBatchId` 只投影一张稳定主卡；活动章节拍 checkpoint 嵌入该卡，确认前不存在第二张批次卡或第二个当前节拍查看入口。
- 验证节拍调整只替换当前决策区，旧 revision 进入卡内历史；确认后原卡立即进入启动或生成阶段，已确认 revision 不形成同级大卡。
- 验证 Inspector 的节拍快照与批次实时模式互斥，标题、revision、轮询行为和数据源不会串用。
- 验证 `generatedCount` 来自批次唯一子项和有效 DraftSession，重复 `draft_created` 事件不会重复计数。
- 验证每生成一章都会更新摘要和状态台账，并影响下一章。
- 验证顺序生成、部分失败、继续生成和前缀提交。
- 验证一次发送会包含分布在多个章节上的全部审批意见；“仅重写有意见的章节”会保留其他草稿并统一执行连续性复核，通过时不传播过期，发现跨章冲突时只传播到受影响后续章。
- 验证“从最早意见章节起重新生成”会使该章及全部依赖后续章过期，并回滚对应状态台账。
- 验证已有章节版本冲突时整次零写入。
- 验证副作用未知时不会自动重放。

### 14.4 恢复与回归

- 覆盖取消、Runtime 重启、SSE 重放、部分失败和调用账本对账。
- 覆盖 Operation 停留在 `queued / leased / running / waiting_operation` 后刷新和重放，确认仍恢复为启动中或生成中，不会仅凭 Run 顶层终态误报“生成未完成”。
- 覆盖 checkpoint 可提交但 DraftBatch 临时读取失败，确认唯一提交入口仍可达，恢复读取后仍是同一稳定卡片。
- 验证桌面与窄窗口下的范围选择、专家切换、章节矩阵和审核操作。
- 现有单章续写、一致性审核、情节线分析和创作素材草稿不得回归。

## 15. 已确认默认决策

- V1 覆盖团队、作者、编辑、读者、世界观和考据。
- 详细逐章处理单批阈值为 20 章，默认批次 4 章；自适应读取可以继续分批，不以 20 章作为授权上限。
- 多章写作默认 2 章，最多 5 章。
- 单次模型投影的最近全文窗口默认 2 章，可配置为 1 至 3 章；不构成读取授权上限。
- 单次模型投影的前文章节摘要默认 8 章，单窗口硬上限 20 章；任务可通过后续批次继续覆盖。
- 综合协作视角采用共享读取、专家并行、Supervisor 汇总。
- 读者采用严格顺序盲读。
- 多章节流程包含计划、报告和草稿三层审批。
- 接受报告建议后优先在当前对话形成修订批次，也可保存到“待改清单”；两者都不直接写回正文。
- 整批节拍必须由用户批准后才能生成正文。
- 正文连续生成、逐章审核、按前缀顺序提交。
- `ContextBuilder` 是小说上下文装配的唯一事实来源。

## 16. 当前实现状态（2026-07-18）

已完成第一增量：

- 新增 TypeScript/Python 公共范围、快照、覆盖率、状态台账和 Bundle Schema。
- 新增 Electron 只读能力 `chapter.scope_context.build`，由 `ContextBuilder` 解析范围并装配章节、摘要、实体、情节线和叙事摘要。
- 新增 `chapter.scope_context@1.0.0` Toolchain，接入 Intent Operation、Tool Manifest、Runtime 原子推进、RAG 补充、预算和 Artifact。
- 当前编辑器正文可以覆盖锚点章节，并以独立哈希进入快照。
- 非连续选择的中间章节以 `target=false` 作为只读连续性上下文，不会进入可处理目标快照。
- 摘要通过 `sourceContentHash` 判断新鲜度；缺失或过期时退化为原文摘录并记录警告。
- 读者投影在 Runtime 发布 Artifact 前移除未来章节、叙事摘要、后台实体、情节线和非章节证据。
- `chapter_scope_context` Artifact 已同步 Python、Electron Store、SSE 投影、Renderer 类型和 Inspector 通用视图。

已完成第二增量：

- 新增统一 `ContinuationContextPolicy` 与 `ContinuationContextSnapshot`，默认装配此前 8 章摘要和时间线上最近 2 章全文；两个窗口不重叠，另行加入当前编辑器正文。
- 单章续写改为按卷序和章序定位叙事前文，不再使用 `updatedAt` 推断最近章节。
- 未保存的当前编辑器正文以 `editor_buffer` 来源和独立内容哈希进入续写快照。
- 新增只读能力 `chapter.continuation_context.build`；`chapter.continuation` Toolchain 不再重复拼装 7 个原子资料源，RAG 只负责补充证据。
- 方向审批和 `chapter.generate_draft` 复用同一份已装配上下文，草稿记录持久化策略、版本、哈希、摘要新鲜度和估算 Token。
- 草稿审核页可展开查看前文章数、正文/摘要覆盖、当前编辑来源和逐章版本。

已完成第三增量（父子草稿批次基础）：

- 新增 TypeScript/Python `ChapterBeat`、`DraftBatchRecord`、有序子草稿、来源快照和批次状态台账 Schema。
- `draft-sessions.json` 向后兼容升级为 `{ sessions, batches }`；旧的仅含 `sessions` 文件可无迁移加载。
- 批次子 `DraftSession` 增加 `draftBatchId`、`childIndex`、`generationRevision` 和前序依赖引用，不再触发单草稿淘汰规则。
- 旧 `draft.get_active` 和默认 `draft.list` 排除批次子草稿，避免未完成的批次能力影响单章审核；可按批次或显式参数读取子草稿。
- 新增 `draft.batch.list/get/create/update_outline/approve_outline/attach_child/mark_stale_after/discard` Automation 能力。
- 章节节拍限制为 1 至 5 章；修改节拍会递增 revision 并重新进入审批，开始生成后禁止静默修改整批节拍。
- 子草稿只能按顺序挂接；已提供原子的后续失效传播操作，可将指定章节后的子草稿及其 DraftSession 一并标记为 `stale`。
- 整批丢弃会同步更新所有子草稿，版本冲突均 fail-closed；持久化恢复与 Python Schema 已有自动化测试。

已完成第四增量（连续多章生成主链）：

- 新增 `chapter.sequence_continuation@1.0.0`，单章 `chapter.continuation@1.0.0` 的输入语义保持不变。
- 新增真实模型能力 `agent.generate_chapter_beats`；未显式提供节拍时按用户目标生成 1 至 5 章节拍，并严格校验数量和字段。
- Runtime 在正文生成前创建 `DraftBatch` 并通过 `chapter_beats` checkpoint 暂停；用户确认后才调用 `draft.batch.approve_outline`。
- 正文严格按 `childIndex` 顺序逐章生成；每次只推进一个子草稿，前序未完成时 Electron Store 拒绝越序挂接。
- 新章节审核前使用 `draft-batch:{draftBatchId}:{childIndex}` 临时目标，不创建正式章节，也禁止通过旧 `draft.commit` 单独写回。
- 下一章上下文保留批次最近 2 章全文；更早草稿保存有界摘要，并携带整批节拍、当前节拍和最新状态台账。
- 每章生成成功时，时间线、信息揭示、核心冲突、结尾钩子和正文摘要与子 DraftSession 原子写入批次状态台账。
- Runtime 与 Renderer 增加 `draftBatchId`；批次最终发布单个 `chapter_draft_batch` Artifact，并保留所有子 DraftSession 引用。
- 副作用账本完整保存 DraftBatch 结构和批次子草稿的最小恢复正文；结果未知时 fail-closed，不自动重放生成。
- 明确的“续写一至五章”会路由到多章链并保留请求数量；成功、第二章失败停止和恢复路径已有自动化测试。

已完成第五增量（草稿连续前缀提交后端）：

- 新增 `draft.batch.commit_prefix` Automation 能力与 Tool Manifest 契约；输入使用总前缀长度，可先提交前 1 章，再提交前 2 章。
- 只允许提交从第 1 章开始、状态为 `draft` 且非过期的连续前缀；已提交前缀、子 DraftSession 和真实章节 ID 会同步回填到 `DraftBatchRecord`。
- 新章节在提交事务中才进入章节树；锚点不是卷末且首次提交未明确选择时，返回 `INSERTION_MODE_REQUIRED`，要求确认“当前章后插入”或“卷末追加”。
- “当前章后插入”会事务性移动后续章节顺序；分次提交时始终接在该批次最后一个已提交章节之后，保持批次连续。
- 写入前统一校验来源章节的 version 与 SHA-256 正文哈希；改写模式还要求每个目标章节都有来源快照，任一冲突则整次 SQLite 事务零写入。
- 新章节正文统一转换为标准 Lexical 文档；提交同时维护章节/小说字数、章节与卷版本、全文搜索顺序索引，并触发新正文摘要刷新。
- 已增加 JSON Store 前缀状态恢复、Lexical 新章序列化、真实 SQLite 分次提交与冲突回滚测试。

已完成第六增量（批次失败恢复与重新生成）：

- 新增 `agent.regenerate_batch`，要求用户显式确认并校验批次 version；默认从首个 `failed`、`stale`、`pending` 或中断的 `generating` 子章继续，也允许指定更早的未提交子章。
- 新增 `draft.batch.prepare_regeneration`：保留可审核的连续前缀，将重跑范围内旧 DraftSession 标记为 `stale`，回滚对应状态台账，并为每个待重跑子章递增 `generationRevision`。
- `chapter.generate_draft` 现在携带并校验 `generationRevision`；旧请求迟到、旧代结果或错误批次结果均以版本冲突拒绝，不能覆盖新一轮草稿。
- 新增 `draft.batch.mark_failed`：已知失败与 `sideEffectUnknown` 分别持久化；前者可从失败章继续，后者保持 fail-closed，必须先完成副作用对账。
- 重跑复用原批次已批准节拍，不重复进入节拍审批；前缀草稿继续进入滚动上下文，只重新生成指定子章及其后续依赖。
- 编辑批次中的第 N 章草稿会自动将 N 之后的子草稿与 DraftSession 标记为 `stale`，防止提交基于旧前文生成的后续章节。
- 已增加 Store 恢复、代际冲突、失败落盘和 Runtime 从第二章续跑的自动化测试；该增量不包含 Renderer 操作入口，界面仍受 Stitch 原型门禁约束。

目标增量（2026-07-23 统一审批意见）：

- 当前实现只有“从第 N 章起重新生成”，会无条件使后续草稿过期；这仍作为结构性修改和连续性风险较高时的保守路径。
- 新增“仅重写有意见的章节”，要求一次接收整批意见，为所有目标章生成新的子 DraftSession 而不覆盖旧版本，并在恢复提交资格前对保留的后续草稿执行连续性复核。
- 连续性复核必须读取新旧状态增量和后续草稿，输出可审计的通过或冲突结果；不能仅凭模型声明直接保留后续章。
- 发现冲突时从最早受影响章节传播 `stale`；无冲突时保留原后续 DraftSession 和生成修订，不重复生成。

已完成第七增量（专家报告审批与修订任务后端骨架）：

- 新增 TypeScript/Python `ExpertReportPayload`、结构化 `ExpertFinding`、finding 决策、独立 `reviewStatus/reviewRevision` 和 `AgentRevisionTask` 契约。
- 新增专家 Artifact 类型 `writer_revision_plan`、`chapter_range_review`、`reader_journey`、`worldbuilding_consistency`、`research_fact_check` 和 `scope_audit`，计划器新增独立 `expert_report` deliverable。
- `AgentArtifact` SQLite 表向后兼容增加审批状态、乐观锁 revision、决策记录、过期章节和审批时间；Runtime 重放同一 Artifact 时不会覆盖用户审批。
- 新增 `artifact.review.submit`：校验 finding、合并部分审批、按 `(sourceArtifactId, sourceFindingId)` 幂等创建修订任务；接受 finding 不修改章节正文，也不创建 DraftSession。
- 新增 `revision_task.list`：支持按小说、章节、专家、严重度和状态筛选；新建任务保存来源报告、finding、目标章节、建议角色和来源快照。
- 新增 `revision_task.create_plan`：只允许 `open` 且来源快照仍新鲜的任务生成可审核计划；章节 version 或 SHA-256 正文哈希变化时，报告与任务均标记为 `stale` 并 fail-closed。
- 已增加真实 SQLite 迁移、审批幂等、乐观锁、章节过期传播和任务计划挂接测试，并完成 TypeScript、Intent/Runtime 与旧会话恢复回归；本增量不包含报告审核或任务池 Renderer。

已完成第八增量（编辑多章节范围审核）：

- 新增稳定 Intent Operation 与 Toolchain `editor.range_review@1.0.0`，默认产物为 `expert_report`，只允许编辑或团队角色调用。
- 审核链复用 `chapter.scope_context.build + rag.ask` 共享读取，只装配一次已批准范围，再执行一次编辑模型综合；不调用草稿或正文写入能力。
- 支持当前章、选择章节、章节区间、当前卷和整本小说；当前实现以 20 章作为单批详细处理阈值，超限使用分批摘要、覆盖率和来源快照契约，不把阈值作为读取授权上限。
- 结构化审核覆盖结构、节奏、人物动机、文字质量和跨章连续性，发布 `chapter_range_review` Artifact，并在 `metadata.expertReport` 中保存可逐条审批的 finding。
- Runtime 发布前校验 finding 的目标章节和 evidence 来源；模型返回的越权章节、伪造 ID 或无法核验的证据会被移除并写入 warning。
- Intent Target 新增 `chapter_scope`，当前章节选择可以作为范围锚点；显式“多章节编辑审核”优先路由到范围链，不再退化为单章一致性审核。
- 已增加证据边界、稳定路由、只读副作用和完整 Runtime Artifact 测试；本增量不包含编辑报告的专用 Renderer。

已完成第九增量（读者多章节顺序盲测）：

- 新增稳定 Intent Operation 与 Toolchain `reader.journey_review@1.0.0`，默认产物为 `expert_report`，只允许读者或团队角色调用；普通单章读者反馈继续保留 `reader.feedback`。
- 只调用一次 `chapter.scope_context.build` 获取已批准范围，不调用 RAG、项目后台资料检索或写入工具；目标章节按作品顺序固定，模型不得自行扩大范围。
- 每次模型请求只包含当前章正文/摘要和前一章产出的有界 `readerStateSummary`，不携带任务原文、未来章节、人物卡、世界观后台、情节线、RAG 证据或其他专家结论。
- 逐章输出理解度、情绪强度、悬念、追更动力、弃读风险、困惑点、出戏点、有效钩子和后续期待；Runtime 确定性汇总为 `reader_journey` Artifact。
- 每个 finding 在发布前强制收敛到当前章；模型返回的未来章节 ID、非当前章 evidence 和越权引用会被移除并记录 warning。
- 当前实现单批详细处理最多 20 章，对摘要或摘录章节仍可评估但会显示可信度警告；报告保存完整范围快照、覆盖率、逐章状态和可审批 finding，后续批次可以继续扩展实际覆盖。
- 自动化使用未来章节专属关键词验证前序请求零泄漏，并覆盖严格调用顺序、读者状态滚动、后台知识隔离、无 RAG、无草稿与无正文写入；本增量不包含专用 Reader Renderer。

已完成第十增量（世界观多章节一致性审核）：

- 新增稳定 Intent Operation 与 Toolchain `worldbuilding.range_consistency@1.0.0`，默认产物为 `expert_report`，只允许世界观或团队角色调用。
- 审核链复用 `chapter.scope_context.build + rag.ask`，一次装配已批准章节、世界观、人物、物品、地图、情节线和实际检索证据，再执行一次低温结构化模型综合。
- 结构化审核覆盖规则、术语、角色能力、地点空间、物品属性、时间关系和跨章状态漂移，并明确区分“实际冲突”“正文尚未解释”和“覆盖不足”。
- 发布 `worldbuilding_consistency` Artifact，保存一致性评分、维度评分、逐实体状态、可审批 finding、覆盖率和完整来源快照；接受 finding 仍只进入修订任务池。
- Runtime 会校验 finding 的目标章节、关联实体 ID 和 evidence 来源；越权章节、未登记实体、伪造证据和重复冲突会被移除或归并并写入 warning。
- 已覆盖稳定 Intent 路由、项目实体投影、RAG 证据、越权引用过滤、只读副作用和完整 Artifact 发布；本增量不包含世界观报告专用 Renderer。

已完成第十一增量（多章节考据与事实核查）：

- 新增稳定 Intent Operation 与 Toolchain `research.range_fact_check@1.0.0`，默认产物为 `expert_report`，只允许考据或团队角色调用；普通 `research.fact_check` 继续保留。
- 执行链分为声明提取、项目检索和报告综合三阶段：最多提取 8 条声明，最多执行 5 次项目全文搜索；连同范围读取与 RAG，总工具预算 7 次、模型预算 2 次。
- 声明限定为历史、科学、医学、法律、技术、地理、文化、经济等可核验陈述；纯虚构规则、人物情绪、审美评价和剧情预测不进入事实核查。
- 发布 `research_fact_check` Artifact，保存逐条 verdict、confidence、来源、未核验原因、覆盖率、搜索统计和完整来源快照，并接入统一报告审批与修订任务契约。
- Runtime 校验 claim、目标章节和 evidence 来源；无法关联的声明、伪造来源和越权 ID 会被移除。模型在无证据时返回 supported/contradicted/mixed 会被强制降级为 `unverified`，confidence 上限为 0.3。
- 当前 `search.query` 是小说项目全文检索，不是互联网搜索；报告会显式记录 `externalSearchAvailable=false`。需要外部资料且 RAG 未导入可靠来源时必须保持未核验，不得伪造 URL、出版物、机构或引文。
- 已覆盖范围声明清洗、项目搜索次数、RAG/搜索 evidence、无证据降级、外部搜索能力边界、只读副作用和完整 Artifact 发布；本增量不包含考据报告专用 Renderer。

已完成第十二增量（团队多章节综合审计）：

- 新增稳定 Intent Operation 与 Toolchain `novel.scope_audit@1.0.0`，由团队/Supervisor 执行，默认选择编辑、读者和世界观专家；考据专家可在计划中显式加入，实际专家列表必须保存在计划输入与最终 Artifact 中。
- 团队链只执行一次 `chapter.scope_context.build + rag.ask`，随后为各专家投影共享 `ChapterScopeBundle`；编辑与世界观模型按 `maxConcurrency=2` 并发，读者保持严格顺序盲测，考据按声明提取、项目搜索和核查报告三个阶段执行。
- 每位成功专家发布独立且可审批的子 Artifact，Supervisor 仅接收这些结构化子报告，不接收完整章节正文，也不得补写未执行专家的评价。专家失败会记录在 `failedExperts`，其余专家继续执行；全部失败才终止综合。
- 最终发布 `scope_audit` Artifact，保留子 Artifact ID、实际执行专家、失败专家、综合 finding、专家冲突、覆盖率与来源快照。综合 finding 必须引用真实 `sourceFindingIds`；伪造 finding、未执行专家、越权章节和无来源 evidence 会在 Runtime 发布前移除。
- Runtime 的活动请求跟踪已从单请求扩展为每 Run 多请求集合，取消团队并发批次时会同时撤销所有在途模型/工具请求；重放会按范围与专家引用复用已发布子 Artifact，避免生成不一致的新 ID。
- 自动化覆盖共享范围只读取一次、双专家真实并发、读者未来信息隔离、显式考据与项目搜索、伪造来源过滤、独立子报告审批状态和零正文写入；本增量不包含团队报告专用 Renderer。

已完成第十三增量（章节范围与专家报告 Renderer）：

- 输入框工具栏新增章节范围控件，支持当前章、不连续多选、连续区间、当前卷和整本小说；多选固定作品顺序，综合协作视角可显式选择编辑、读者、世界观和考据专家。
- Renderer 将同一份结构化 `chapterScope` 传入聊天、计划和计划修订；Python Runtime 在计划路由和模型修订后再次校验并覆盖 Toolchain 输入，模型不能把显式范围扩大、缩小或替换为虚构章节。
- `SelectionContext` 同步携带清洗后的章节范围和专家列表，供模型理解指代；计划卡显示范围、详细/分批模式和团队专家。
- Inspector 新增统一专家报告审核视图，支持团队根报告与专家子 Artifact 切换、覆盖率、严重度统计、章节矩阵、逐条详情及接受/暂缓/驳回。
- 报告审批通过既有 `artifact.review.submit` 提交乐观锁 revision；接受 finding 只创建或更新修订任务，不修改正文。审核结果即时回写当前会话 Run/Artifact 投影。
- Prisma 正式声明 Artifact 审核列与 `AgentRevisionTask` 表，避免开发启动 `db push` 删除运行时动态新增的审核字段；Runtime 的兼容性 `ALTER TABLE` 仍保留用于旧库升级。
- 报告审核保持现有 360px Inspector；仅章节草稿对照审核使用宽面板。范围弹层在窄窗口向上展开，支持 `Esc` 与点击外部关闭。
- 新增范围选择与报告投影纯函数测试；Python 回归覆盖模型伪造范围和计划修订后范围保留。TypeScript、审批 Store、上下文、SSE/恢复与 Lexical 回归通过。

已完成第十四增量（多章草稿批次审核 Renderer）：

- 会话时间线和 `chapter_draft_batch` Artifact 增加批次审核入口；当前 Run、刷新恢复和后续聊天上下文均保留 `draftBatchId`。
- 宽幅审核中心按既有 Stitch 原型展示批次摘要、横向章节轨道、逐章状态、整批节拍及选中章节的原文/草稿对照，不扩大常规 360px Inspector。
- 草稿章节可逐章编辑并保存；修改第 N 章后重新读取批次状态，后续依赖章的 `stale` 传播立即反映在章节轨道和提交边界中。
- 提交控件只允许选择连续、非过期的绝对前缀；保存导致可提交范围缩小时会按最新批次 version 重新计算，避免提交旧状态。
- 非卷末续写在提交前强制选择“当前章后插入”或“卷末追加”；整批丢弃、版本冲突和失败状态使用现有 fail-closed Automation 契约。
- 失败、过期或未生成子章可从首个问题章触发 `agent.regenerate_batch`；新 Run 进入同一会话时间线并继续使用现有 SSE 活动流。`sideEffectUnknown` 明确阻断重新生成并提示先完成对账。
- 新增批次审核纯状态投影与自动化，覆盖已提交前缀、可审核前缀、续跑起点和副作用未知阻断；TypeScript、Vite build、SQLite 前缀提交与 DraftSession 恢复测试通过。

已完成第十五增量（修订任务池 Renderer）：

- 左侧 Agent 导航新增独立修订任务入口；中央区域按状态、严重度、专家和章节筛选任务，并展示待规划、已规划、已解决与已过期统计。
- 右侧保持现有 360px Inspector 占比，展示来源 Artifact/Finding、目标章节、审核备注、推荐角色和过期阻断说明，不扩大右栏。
- `open` 任务可生成可审核计划；计划先保存到任务，再通过 `agent.register_plan` 校验并注册到 Python Runtime，随后进入新的 Agent 会话和既有计划审批链路，不直接执行工具或修改正文。
- 已规划任务保留计划快照，可重新打开并幂等注册，避免 Electron 已保存计划但 Runtime 重启或注册失败后任务失联。
- 新增暂缓、重新打开、标记解决和关闭状态操作，使用 `updatedAt` 乐观锁；SQLite `DATETIME` 对外统一为 ISO 时间并保留原子更新冲突保护。
- Runtime 注册会校验审批要求、步骤 ID、原子工具、Toolchain 与显式章节范围；未知工具、混合调用和无效 Toolchain 均 fail-closed。

2026-07-21 产品方向修订：上述 Renderer 继续作为实现现状，但不再是目标主流程。软件的唯一用户是小说创作者，作者/编辑/读者/世界观/考据/团队仅是 AI 工作视角；所有视角都默认在原对话选择建议并创建单个 `RevisionWorkBatch`。独立任务池统一降级为轻量“待改清单”，现有“每个任务生成计划并进入新会话”需要由对话内批次流程替代，任务仅生成计划时不得标记为已解决。

已完成第十六增量（副作用未知人工对账）：

- Python invocation ledger 新增 `reconciled_succeeded` 与 `reconciled_absent` 终态；已接纳结果可按有界快照复用，确认未创建的旧 invocation 永不自动重放。
- `draft.batch.mark_failed` 把 `invocationKey`、`requestId`、工具名和生成修订持久化到失败子章；对账候选必须同时匹配 `draftBatchId + childIndex + generationRevision`。
- 新增只读 `draft.batch.inspect_reconciliation` 与写入 `draft.batch.reconcile_unknown`，以及 Runtime `agent.inspect_side_effect`、`agent.reconcile_side_effect`；对账先更新批次，再更新调用台账，响应丢失后可幂等补完台账。
- 接纳已有草稿只关联精确候选并恢复该章审核状态；确认未创建必须勾选显式声明，完成后只解除重生成阻断，不会立即调用模型。
- 批次审核中心按 Stitch Screen `0ee67f778c2b4fc6b7c09bf2f60e86f4` 显示工具、批次/子项/修订、requestId、台账状态和候选摘要；不显示隐藏提示词、思维过程或敏感参数，不提供强制重试/忽略。
- 自动化覆盖精确候选接纳、无候选确认、对账前禁止重生成、生成修订递增、旧对账记录清理、台账结果复用和“批次已落盘但 Runtime 响应丢失”恢复。

已完成第十七增量（多章正文状态台账抽取）：

- `chapter.generate_draft` 在批次正文生成后执行低温结构化状态抽取，覆盖人物章末位置、关系变化、角色认知增减、物品持有/位置/状态和冲突开闭；单章续写保持原链路。
- 所有状态变化必须带生成正文中的连续原句证据；Electron 对结构、长度、实体 key 和原文证据做确定性清洗，未登记实体只有在正文明确出现名称时才允许进入台账。
- `NarrativeStateLedger` 新增带 `childIndex + generationRevision + draftSessionId` 的 `stateDeltas` 来源历史，同时维护供下一章直接读取的当前位置、知识、物品和关系投影。
- 状态增量与子 DraftSession 在同一次 JSON Store flush 中原子写入；抽取失败只给 DraftSession 增加降级警告，保留草稿并继续使用节拍台账。
- 从中间章重生成时，状态台账按保留前缀重建；人工修改第 N 章会移除第 N 章及后续旧增量，避免旧正文状态污染新草稿。
- `chapter.sequence_continuation` 模型预算和 `chapter.generate_draft` 超时已按“正文生成 + 状态抽取”调整；专项测试覆盖证据过滤、跨章累积、关系/知识/物品投影、编辑失效和重生成回滚。

已完成第十八增量（作者范围修订与多章批量改写）：

- 新增 `writer.range_revision_plan@1.0.0`，复用已批准 `ChapterScopeBundle` 评估文风漂移、场景强弱、改写优先级和续写准备度，发布 `writer_revision_plan` 专家报告；越权章节、伪造证据和范围外改写顺序会在 Artifact 发布前移除。
- 作者报告沿用统一专家报告审批、独立 `reviewStatus` 和修订任务池；接受 finding 只创建修订任务，不生成正文、不写回章节。
- 新增 `chapter.batch_rewrite@1.0.0`，只接受显式当前章/选择章节/章节区间，目标限制 1 至 5 章且必须属于同一卷；范围模型不得自行扩大目标。
- 批量改写先共享读取完整目标正文和项目上下文，再生成与目标章节一一对应的修订节拍；用户确认节拍前不会生成正文。每个子草稿携带真实 `targetChapterId` 和原文，模型输出语义为完整替换正文，不再复用追加续写提示。
- `DraftBatchRecord.mode=batch_rewrite` 固定目标顺序与每章 `version + contentHash` 快照；Electron Store 即使绕过 Runtime 也会拒绝重复目标、目标数量不匹配和缺失快照。
- 批次审核复用现有宽幅原文/草稿对照、逐章编辑、连续前缀提交和整批丢弃；事务提交前校验未提交目标快照，任一冲突整次零写入，不自动合并或强制覆盖。
- 改写批次支持从首个失败/过期章节重新生成，保留可审核前缀和原节拍；恢复前重新读取范围并核对原快照，未知副作用仍必须先人工对账。

已完成第十九增量（章节拍与批次单一稳定主卡）：

- `chapter.batch_rewrite` 与 `chapter.sequence_continuation` 共用 `projectDraftBatchConversationState`，按 Artifact、持久批次、Operation、checkpoint 和 Run 降级信号投影同一张批次主卡；生成数只按绑定有效 DraftSession 的唯一子项计算。
- 会话不再并列渲染章节拍确认卡和批次状态卡。确认、调整、取消、生成进度、部分失败、审核入口、修订建议、活动详情和折叠节拍历史均在 `DraftBatchProgressCard` 原位更新，默认界面不显示裸 `draftBatchId`。
- 批次摘要通过现有 `draft.batch.get` 缓存；活动批次每 1.5 秒刷新，Run/SSE 与 Operation version 变化时立即重读，Inspector 的实时读取结果同步回主卡。批次读取暂时失败不影响 checkpoint 确认入口恢复。
- Inspector 改为 `chapter_beat_snapshot / draft_batch_progress / draft_batch_interrupted / draft_batch_review` 显式互斥选择；历史快照固定 revision 且不轮询，生成中内容只读，完整审核仅在批次进入审核模式后开放。
- 已新增纯投影和 Renderer 契约测试，覆盖排队与生成、部分结果、失败/取消/对账、终态、重复 checkpoint、稳定 key、单查看动作、无裸 UUID、标题矩阵和实时只读边界。

仍待实现：

- 真正的外部网络考据 Tool/连接器及其计划审批开关；不得将项目全文 `search.query` 作为外部检索展示。

界面开发门禁：

- 后续新增界面仍须以已确认 Stitch 信息架构为基础；交互范围变化时重新评审。
