# Agent 章节目标解析与上下文扩展需求

版本：v0.1

日期：2026-07-31

状态：需求已确认，待完整实现

适用范围：Agent 会话、章节范围选择、聊天探索、IntentService、计划生成、章节 Toolchain、上下文装配、草稿生成、批次新增/改写、计划审批、Run 恢复和 Inspector 可观测性。

## 1. 背景

当前 Agent 请求同时携带编辑器当前章节和章节范围。Renderer 会把 `currentChapter` 写入请求顶层 `chapterId`，Runtime 又将该字段注入章节 Toolchain。结果是会话虽然选择了“整本小说”，写作目标仍可能被编辑器当前打开的章节绑定。

同时，当前意图规则会把“续写最后一章”中的“一章”识别为生成数量，形成 `chapter.sequence_continuation(chapterCount=1)`；模型语义层仍可能返回 `chapter.continuation`，IntentService 将两者合并后便产生两个互相冲突的续写步骤。

典型错误场景：

```text
编辑器当前章：第 1 卷第 2 章《白色房间》
用户选择范围：整本小说
用户请求：帮我续写最后一章

错误结果：
- 写作目标仍是《白色房间》
- 同时生成“连续多章续写”和“章节续写”两个步骤
```

本需求不把问题修成“整本小说永远锚定末章”。正确目标是建立小说级 Agent、步骤级操作目标和可扩展只读上下文，使 Agent 可以读取、定位、创建和修改当前小说中的任意章节，同时保持写入审批、版本冲突和证据边界。

## 2. 产品目标

1. Agent 会话绑定小说，不绑定某一个章节。
2. 编辑器当前章节只是临时选择信息，只有用户表达“当前章”“这章”等指代，或满足明确的操作默认规则时，才能成为写作目标。
3. 每个计划步骤必须拥有独立、确定、可审计的操作目标。
4. `contextScope` 表示本次请求的初始上下文和装配偏好，不是模型读取章节的硬边界。
5. 在没有用户禁止条件时，模型可以为完成任务申请读取同一小说中 `contextScope` 之外的章节。
6. 上下文扩展只能增加只读证据，不能自动增加或改变写入目标。
7. Agent 可以对当前小说中的任意已有章节生成追加、改写草稿，也可以在明确位置生成一个或多个新章节草稿。
8. 用户批准计划前不产生写作副作用；草稿未经审核不得写回正文。
9. 目标解析、上下文扩展、实际读取、草稿生成和写回均可在活动流和 Inspector 中审计。

## 3. 非目标

本轮不包含：

- 跨小说读取或写入。
- 自动删除章节。
- 未经计划和草稿审核直接覆盖正文。
- 用模型猜测数据库 ID、章节顺序或重复标题对应关系。
- 将“整本小说”解释为默认修改全书。
- 以 RAG 命中代替明确章节正文或版本化摘录读取。

章节移动和删除后续应作为独立高风险 Operation 设计。现有新章提交为维持插入顺序而进行的事务性重排不属于此处的主动“移动章节”功能。

## 4. 核心原则

### 4.1 小说级会话，步骤级目标

AgentConversation 的稳定工作区身份是 `novelId`。章节 ID 不得成为会话身份的一部分。

章节目标在每次用户请求和每个计划步骤中独立解析、冻结和持久化。同一会话可以依次执行：

- 分析第 1 章。
- 改写第 7 章。
- 续写最后一章。
- 在第 2 卷第 3 章后新增两章。

这些任务不得要求用户先在编辑器中手动打开目标章节。

### 4.2 目标、上下文和写入权限分离

系统必须分别保存以下概念：

| 概念 | 含义 | 能否由模型自行改变 |
| --- | --- | --- |
| `workspaceRef` | 当前小说工作区 | 否 |
| `editorSelection` | 请求发起时编辑器当前选择 | 否；只是输入事实 |
| `operationTarget` | 本步骤分析、追加、改写或插入的目标 | 否；只能由用户语义、结构化选择和确定性解析产生 |
| `contextScope` | 初始装配范围、上下文种子和预算偏好 | 可以申请扩展 |
| `readPolicy` | 用户对只读扩展的约束，例如禁止后文 | 否；模型只能在策略内申请 |
| `resolvedContext` | Runtime 最终实际读取的章节和证据 | 可在 `readPolicy` 内扩展 |
| `writeScope` | 已批准计划允许生成草稿或写回的目标 | 否；必须由计划和审批建立 |

### 4.3 `contextScope` 不是访问控制

`contextScope` 用于决定第一批读取什么、如何分配预算和 UI 如何展示用户偏好。它不是章节访问白名单。

例如：

```text
用户：续写第三章
contextScope：当前章或第三章
operationTarget：第三章

模型发现需要承接前文：
  -> 申请读取第一章、第二章
  -> Runtime 校验它们属于同一小说且不违反 readPolicy
  -> 执行只读装配
  -> resolvedContext = 第一章、第二章、第三章

writeScope 仍然只包含第三章。
```

若用户明确说“只看第三章”“不要读取后文”“不要参考未发布章节”，这些表达进入 `readPolicy`，成为真实限制。范围选择器本身不隐式产生“禁止范围外读取”。

### 4.4 读取扩展不等于目标扩展

模型读取第一章和第二章用于续写第三章，不代表可以修改第一章或第二章。若模型认为前文也应调整，只能：

1. 在报告或计划建议中提出候选目标。
2. 展示为什么需要修改。
3. 等待用户批准新的写入步骤。
4. 建立新的 `writeScope` 后生成对应草稿。

禁止根据 `resolvedContext` 自动生成批量改写步骤。

## 5. 目标表达与确定性解析

### 5.1 目标类型

章节操作目标至少支持：

- 编辑器当前章：`current_editor_chapter`。
- 明确章节 ID：`chapter_id`。
- 卷内序号：`volume_chapter_ordinal`。
- 全书序号：`novel_chapter_ordinal`。
- 唯一标题：`chapter_title`。
- 选中章节集合：`selected_chapters`。
- 连续章节区间：`chapter_range`。
- 当前卷末章：`last_in_current_volume`。
- 指定卷末章：`last_in_volume`。
- 全书末章：`last_in_novel`。
- 用户明确选择集合中的末章：`last_in_selected_set`。
- 某章之前或之后的插入点：`before_chapter` / `after_chapter`。
- 小说末尾插入点：`novel_end`。

### 5.2 解析优先级

同一请求中目标来源优先级固定为：

```text
用户本轮结构化选择的目标 ID
> 用户本轮消息中的明确章节引用或插入位置
> 用户本轮消息中的“当前章/这章”指代
> 用户在独立目标控件中显式选择的单章
> 操作类型允许的确定性默认目标
> 无法确定时请求澄清
```

`editorSelection` 不得覆盖更高优先级目标。“整本小说”“当前卷”等 `contextScope` 也不得直接覆盖明确目标。

### 5.3 操作默认目标

只有在用户没有给出目标时才能使用默认规则：

| 操作 | 默认规则 |
| --- | --- |
| 单章分析、润色、改写 | 有编辑器当前章时使用当前章，否则澄清 |
| 单章追加续写 | 有编辑器当前章时使用当前章，否则澄清；“最后一章”属于用户明确目标，不依赖 `contextScope` 默认推断 |
| 连续新增章节 | 有明确锚点时使用该锚点；没有锚点时使用编辑器当前章；两者都不存在时澄清 |
| 批量改写 | 必须有明确章节集合，不允许从已读上下文推断 |
| 新增章节 | 必须解析出插入点；“在小说末尾新增”解析为 `novel_end` |

任何默认解析都必须进入计划卡，不能隐藏在 Toolchain 输入中。

### 5.4 模糊与冲突

- 标题唯一时可以确定性解析；标题重复时必须携带卷名/序号或请求澄清。
- “第三章”在产品语义上默认指全书展示序号；若 UI 和数据模型使用卷内编号，计划中必须展示完整卷章路径并允许用户修正。
- 用户明确目标与结构化目标冲突时，使用本轮最新、最明确的用户意见；无法判断先后关系时澄清。
- 目标不属于当前小说时 fail closed。
- 目标章节已删除、移动或版本变化时，在执行副作用前重新验证。

## 6. 续写、新增和改写的语义

以下表达必须区分，不能都落到含义模糊的 `chapterId`：

| 用户表达 | Operation | 写作语义 |
| --- | --- | --- |
| “补写第三章正文” | `chapter.continuation` | 在第三章现有内容后生成追加草稿 |
| “续写最后一章” | 模型决策或结构化提问 | “最后一章”只确定锚点；模型结合措辞与项目状态选择补写该章或新建下一章，无法可靠判断时询问用户 |
| “在第三章后新增一章” | `chapter.create` | 创建一个位于第三章之后的新章节草稿 |
| “接着第三章写下一章” | `chapter.create` | 以第三章为锚点创建下一章草稿 |
| “从第三章开始连续写三章” | `chapter.sequence_continuation` | 以第三章为锚点生成三个新章节草稿 |
| “改写第三章” | `chapter.rewrite` | 为第三章生成完整替换草稿 |
| “改写第二到第四章” | `chapter.batch_rewrite` | 为三个明确目标章生成批次替换草稿 |

### 6.1 数量与序号必须分词

数量解析不得从以下目标短语中截取“一章”：

- 最后一章。
- 末章。
- 最终章。
- 倒数第一章。
- 第一章。
- 第三章。

只有明确生成数量的表达才能产生 `chapterCount`：

- “续写三章”。
- “连续写三章”。
- “再写两章”。
- “生成接下来的五章”。

### 6.2 Operation 互斥归一化

同一个用户动作不得同时产生以下互斥组合：

- `chapter.continuation` 与 `chapter.sequence_continuation`。
- `chapter.continuation` 与 `chapter.create`。
- `chapter.rewrite` 与 `chapter.batch_rewrite`，除非用户明确要求两个独立动作。

规则检测、模型 SemanticProposal 和结构化入口可以共同提供候选 Operation，但 IntentService 必须在创建 `IntentDecision` 前根据目标、数量和动作语义归一化。不能把候选简单去重后全部执行。

“续写”属于高层创作意图，不是固定的持久化动作。确定性规则可以解析章节锚点、数量和明确的“补写/新增”措辞，但不得仅凭“续写”强制选择 `chapter.continuation` 或 `chapter.create`。模型应在计划前完成该决策；两种解释都合理且会改变交付结果时，返回一个结构化问题。

## 7. 上下文初始装配与扩展

### 7.1 初始装配

Runtime 根据 `operationTarget + contextScope + operation type` 确定第一批上下文：

- 对续写第三章，至少装配第三章当前内容和可用的直接前文。
- 对改写第三章，至少装配第三章正文；是否读取前后文由目标和证据需求决定。
- 对在第三章后新增新章，第三章是锚点，但上下文可以继续向前扩展。
- 对整本分析，按批次装配全书摘要和必要原文，不把所有正文一次塞入模型窗口。

初始装配失败时不得回退到编辑器当前章节。

### 7.2 模型申请扩展

模型可以返回结构化上下文扩展申请：

```ts
type AgentContextExpansionRequest = {
  requestId: string;
  reasonCode:
    | 'missing_precondition'
    | 'continuity_gap'
    | 'character_state_gap'
    | 'world_state_gap'
    | 'plot_reference_gap'
    | 'user_requested_history';
  reason: string;
  candidateChapterIds: string[];
  requiredContentMode: 'full' | 'excerpt' | 'summary';
  priority: 'required' | 'helpful';
};
```

约束：

1. 候选章节必须来自 Runtime 提供的真实、有序小说目录，模型不能编造 ID。
2. Runtime 校验候选属于当前小说、未删除且符合 `readPolicy`。
3. 合法的同小说只读扩展默认不要求用户逐次审批。
4. 违反“禁止后文”“仅限已发布章节”等约束时必须拒绝或请求用户确认。
5. Runtime 根据 deadline、Token 和正文大小决定分批、摘要或摘录，但不能把预算当作语义授权边界。
6. 每次申请、批准、拒绝、实际读取结果和理由都进入活动流。
7. 扩展完成后重新计算 evidence gap；证据仍不足时可以继续申请下一批。

### 7.3 默认读取策略

未设置限制时，默认 `readPolicy` 为：

```text
允许读取当前小说内完成任务所需的任意非删除章节；
优先读取 operationTarget 之前的历史章节；
读取后文必须符合任务语义，避免对读者盲测等任务泄露未来信息。
```

任务语义可以收紧默认策略：

- 续写：优先向前读取，除非用户明确要求参考后续既有章节。
- 读者盲测：禁止读取当前评估位置之后的章节。
- 一致性审核：可向前和向后扩展。
- 改写：可读取前后承接章节，但写入仍只针对批准目标。

### 7.4 Context coverage

`resolvedContext` 必须记录：

- 初始章节。
- 扩展章节。
- 每章选择理由。
- 正文、摘录或摘要覆盖方式。
- 章节版本和正文哈希。
- 失败和被策略拒绝的章节。
- 本次停止扩展的原因。

模型最终结论和草稿只能引用实际成功读取的证据。

## 8. 数据契约

建议新增或演进为以下协议：

```ts
type AgentWorkspaceRef = {
  novelId: string;
};

type AgentEditorSelection = {
  chapterId?: string;
  volumeId?: string;
  selectedText?: string;
  capturedAt: string;
};

type AgentTargetSelector =
  | { type: 'current_editor_chapter' }
  | { type: 'chapter_id'; chapterId: string }
  | { type: 'novel_chapter_ordinal'; ordinal: number }
  | { type: 'volume_chapter_ordinal'; volumeId: string; ordinal: number }
  | { type: 'chapter_title'; title: string; volumeId?: string }
  | { type: 'selected_chapters'; chapterIds: string[] }
  | { type: 'chapter_range'; startChapterId: string; endChapterId: string }
  | { type: 'last_in_volume'; volumeId: string }
  | { type: 'last_in_novel' }
  | { type: 'last_in_selected_set'; chapterIds: string[] }
  | { type: 'after_chapter'; chapterId: string }
  | { type: 'before_chapter'; chapterId: string }
  | { type: 'novel_end' };

type AgentResolvedOperationTarget = {
  selector: AgentTargetSelector;
  operationId: string;
  targetChapterIds: string[];
  anchorChapterId?: string;
  insertion?: 'append_existing' | 'before_anchor' | 'after_anchor' | 'novel_end';
  resolutionSource:
    | 'structured_selection'
    | 'user_message'
    | 'current_reference'
    | 'operation_default';
  novelOrderFingerprint: string;
  sourceSnapshots: Array<{
    chapterId: string;
    version: number;
    contentHash: string;
  }>;
  resolvedAt: string;
};

type AgentContextScope = {
  kind: 'current_chapter' | 'selected_chapters' | 'chapter_range' | 'current_volume' | 'novel';
  seedChapterIds: string[];
  anchorChapterId?: string;
  processingMode: 'detailed' | 'batched';
};

type AgentReadPolicy = {
  novelId: string;
  allowExpansion: boolean;
  direction: 'past' | 'future' | 'both';
  excludedChapterIds: string[];
  publishedOnly?: boolean;
  source: 'default' | 'user_text' | 'structured_option' | 'task_semantics';
};
```

协议要求：

- 新请求顶层不得再使用一个含义不明的 `chapterId` 同时表达编辑器选择、上下文锚点和写作目标。
- `editorSelection.chapterId` 只能进入目标解析器，不能由 Runtime 无条件覆盖 Toolchain 输入。
- `AgentResolvedOperationTarget` 在计划创建时冻结，并保存到计划快照和 Run checkpoint。
- `contextScope.anchorChapterId` 只服务于上下文排序，不构成写入目标。
- Planner 只能引用 Runtime 已解析的目标；模型输出不能直接成为最终数据库 ID。

## 9. Toolchain 输入契约

Toolchain 输入必须体现具体动作：

```ts
type ChapterContinuationInputV2 = {
  novelId: string;
  targetChapterId: string;
  operationTarget: AgentResolvedOperationTarget;
  contextPolicy: AgentReadPolicy;
};

type ChapterCreateInputV1 = {
  novelId: string;
  insertionPoint: {
    kind: 'before_chapter' | 'after_chapter' | 'novel_end';
    anchorChapterId?: string;
  };
  chapterCount: 1;
  operationTarget: AgentResolvedOperationTarget;
};

type ChapterSequenceContinuationInputV2 = {
  novelId: string;
  anchorChapterId: string;
  chapterCount: number;
  insertionMode: 'after_anchor' | 'volume_end' | 'novel_end';
  operationTarget: AgentResolvedOperationTarget;
  contextPolicy: AgentReadPolicy;
};

type ChapterRewriteInputV2 = {
  novelId: string;
  targetChapterId: string;
  sourceSnapshot: {
    version: number;
    contentHash: string;
  };
  operationTarget: AgentResolvedOperationTarget;
};
```

现有 `chapter.continuation@1.0.0` 和 `chapter.sequence_continuation@1.0.0` 的 checkpoint 需要继续可恢复。改变输入语义时应注册新版本，不在原版本上静默改变持久化契约。旧版本只用于恢复已有 Run；新计划一律生成新版本输入。

## 10. IntentService 与 Planner 要求

### 10.1 IntentService

IntentService 必须输出：

- 归一化后的唯一动作或用户明确要求的有序复合动作。
- 结构化 `targetSelector`。
- 生成数量与目标序号分离后的参数。
- 是否需要目标澄清。
- 建议初始 `contextScope`，但不能把它当作目标。

规则检测和模型提议冲突时，确定性语法和权限模块负责裁决；不得以 `MULTI_OPERATION` 为由原样保留语义冲突。

### 10.2 Target Resolver

计划前增加确定性的目标解析阶段：

```text
IntentDecision
  -> TargetSelector
  -> 获取小说级有序目录
  -> 解析真实 chapterId / insertion point
  -> 校验唯一性、归属、顺序和版本
  -> ResolvedOperationTarget
  -> Planner
```

Target Resolver 可以调用只读目录工具，不需要计划审批。无法解析时进入结构化澄清，不得回退编辑器当前章。

### 10.3 Planner

Planner 的每个章节写作步骤必须携带 `ResolvedOperationTarget`。计划标题可以由模型生成，但以下字段由 Runtime 确定性提供且模型不可覆盖：

- Operation ID。
- 目标章节 ID。
- 目标章节完整卷章路径和标题。
- 插入位置。
- 新增或修改语义。
- 来源章节版本。
- 初始上下文和读取策略。

`_apply_explicit_chapter_scope` 或等价逻辑只允许写入上下文字段，不得再覆盖 `targetChapterId`、`anchorChapterId` 或目标章节集合。

## 11. 计划、执行和并发

### 11.1 计划展示

计划卡必须同时展示：

```text
动作：追加续写已有章节
写作目标：第 3 卷第 12 章《……》
初始上下文：整本小说（分批装配）
允许扩展读取：是；同一小说内，优先历史章节
预计写入：仅目标章节的 DraftSession
```

对于新增章节：

```text
动作：新增 3 章
插入位置：第 3 卷第 12 章之后
预计写入：3 个批次草稿；审核提交后创建真实章节
```

### 11.2 目标冻结

计划创建后必须冻结目标 ID、顺序指纹和来源版本。用户切换编辑器章节不改变计划和 Run。

以下变化使计划或未完成草稿变为 `stale`：

- 目标章节删除。
- 目标章节正文版本或哈希变化。
- 插入锚点顺序变化。
- 小说目录重排导致 `novelOrderFingerprint` 变化。
- 用户修改操作目标或动作类型。

### 11.3 写入边界

- 上下文读取自动扩展不需要扩大 `writeScope`。
- Planner 新增写入目标必须再次展示并经过计划审批。
- 所有章节内容变更先生成 DraftSession 或 DraftBatch。
- 写回继续执行版本、哈希、顺序和幂等校验。
- 未知副作用、取消和人工对账继续沿用持久化 Operation 机制。

## 12. UI 与交互

### 12.1 输入区

现有“章节范围”控件应明确为“初始上下文”或在提示中说明：

> 决定 Agent 首先参考哪些章节；为完成任务，Agent 可以申请读取同一小说中的其他章节，实际读取会显示在活动记录中。

若产品保留“处理范围”名称，必须拆出独立的“写作目标”展示，避免用户把整本上下文误解为整本写入。

### 12.2 目标预览

在生成计划前或计划卡中显示 Runtime 解析结果：

- 完整卷章路径。
- 章节标题。
- 动作是追加、替换还是新增。
- 插入锚点。
- 解析依据，例如“来自用户消息：最后一章”。

用户可以在实施计划前修正目标。修正后重新生成目标快照和计划，不允许只修改 UI 文案。

### 12.3 活动流与 Inspector

活动流至少记录：

- 正在解析章节目标。
- 已确定目标章节或插入点。
- 初始上下文装配。
- 模型申请额外章节及理由。
- Runtime 批准、拒绝或分批读取。
- 实际章节 coverage。
- 计划目标与执行目标一致性校验。

Inspector 分别展示：

- 写作目标。
- 初始上下文。
- 实际扩展读取。
- 未满足的 evidence gap。
- 写入范围。

## 13. 兼容与迁移

### 13.1 Renderer 请求

新请求改为传递 `workspaceRef`、`editorSelection`、`contextScope` 和用户消息。过渡期可继续接收顶层 `chapterId`，但兼容层只能把它映射为 `editorSelection.chapterId`，不得直接成为 Toolchain 目标。

### 13.2 会话范围

旧会话保存的 `chapterScope.anchorChapterId` 可以作为上下文种子恢复，但不得作为新请求的隐式写作目标。用户切换到 `novel` 或 `current_volume` 时，不应继续携带旧单章写作锚点。

### 13.3 计划与 Run

- 已创建且正在等待/执行的旧 Run 按原 Toolchain 版本和输入恢复。
- 旧计划被用户重新实施或修订时，先迁移到新目标解析协议并重新确认目标。
- 新计划不得生成旧的多义 `chapterId` 输入。
- Artifact 和 DraftSession 保留原目标引用；迁移不重写历史审计记录。

## 14. 当前实现修复点

完整实现至少覆盖以下代码路径：

- Renderer `ChapterScopeSelector`：切换 `novel/current_volume` 时不得保留旧写作锚点；控件语义改为初始上下文。
- Renderer `AgentWorkspace`：请求拆分 `editorSelection` 与 `contextScope`，不再把当前章当作最终目标。
- Runtime `_explicit_chapter_scope`：只规范化上下文，不从请求顶层覆盖写作目标。
- Runtime `_apply_explicit_chapter_scope`：不得把上下文字段批量覆盖 Toolchain 目标字段。
- Intent `detect_explicit_operations`：修复“最后一章”数量误判。
- Planner `_sequence_toolchain_input`：使用归一化数量，不再二次从原始文本宽松提取。
- IntentService `finalize`：增加互斥 Operation 归一化。
- IntentService `_target_for`：停止将所有章节 Operation 默认指向 `currentSelection.chapterId`。
- ContextBuilder：支持从确定目标装配初始上下文，并接受受约束的扩展读取。
- Toolchain Schema：使用明确 `targetChapterId`、`anchorChapterId` 和 insertion 语义。
- 计划卡、活动流和 Inspector：显示目标、初始上下文、实际读取和写入范围。

## 15. 错误处理

| 场景 | 必须行为 |
| --- | --- |
| “最后一章”但小说没有章节 | 提示无法续写并提供新增首章入口 |
| 标题匹配多个章节 | 展示候选卷章路径并请求选择 |
| 目标章节不属于当前小说 | 拒绝，不跨小说读取或写入 |
| 模型申请虚构章节 ID | 拒绝并记录协议错误 |
| 扩展读取违反用户限制 | 拒绝或请求用户放宽限制 |
| 扩展读取部分失败 | 保存 coverage 和缺口，不声称上下文完整 |
| 目标在计划后变化 | 标记计划 `stale`，重新解析和审批 |
| 用户执行中切换当前章 | Run 继续使用冻结目标 |
| contextScope 外章节被读取 | 记录扩展理由和来源；不视为越权 |
| 已读章节被模型建议修改 | 只生成候选建议，不自动扩大 writeScope |
| 数量与目标序号冲突 | 进入确定性语法解析或澄清，不生成两个互斥步骤 |

## 16. 验收场景

### 16.1 本次缺陷

1. 编辑器打开《白色房间》，选择“整本小说”，输入“帮我续写最后一章”，目标锚点解析为全书实际末章；模型可以选择 `chapter.continuation`、`chapter.create`，或在无法可靠判断时返回一个结构化问题。
2. 同一请求不得出现 `chapter.sequence_continuation(chapterCount=1)`。
3. 计划卡显示实际末章的卷、序号、标题，并明确展示模型选择的“补写已有章节”或“新建下一章”动作。
4. 执行期间切换回《白色房间》不改变冻结目标。

### 16.2 任意章节操作

5. 编辑器停留在第 10 章，输入“续写第三章”，目标仍是第三章。
6. 输入“改写第二卷第三章”，能确定目标并生成替换草稿，无需先打开该章。
7. 输入唯一章节标题可以定位目标；重复标题会请求用户选择。
8. 输入“在第三章后新增一章”，生成新章草稿而不是追加第三章正文。
9. 输入“从第三章开始连续写三章”，只生成一个多章 Toolchain，`chapterCount=3`，锚点为第三章。
10. 输入“改写第二到第四章”，写入目标严格为三章，不包含为上下文读取的其他章节。

### 16.3 上下文扩展

11. 输入“续写第三章”时，模型可以申请读取第一章和第二章；读取成功后 `resolvedContext` 包含三章，`writeScope` 仍只有第三章。
12. 初始 `contextScope=current_chapter` 不阻止上述扩展。
13. 用户说“只看第三章”后，第一章和第二章的扩展申请被拒绝或要求用户确认。
14. 用户说“不要看后文”后，不得读取目标之后的章节。
15. 读者盲测不因通用扩展能力泄露未来章节。
16. 模型申请的章节必须来自真实目录；虚构 ID 无法进入工具调用。
17. 达到单批预算时可以分批继续读取，Artifact 显示完整或部分 coverage。

### 16.4 计划、审批和并发

18. 计划必须分别显示操作目标、初始上下文、实际读取策略和预计写入。
19. 模型从上下文发现第一章需要修改时，只能在计划中提出候选；未批准前不创建第一章 DraftSession。
20. 计划批准后目标正文变化，执行在副作用前以版本冲突停止。
21. 插入锚点顺序变化后，新增章节计划变为 `stale`。
22. 应用刷新和 Runtime 重启后，目标快照、上下文 coverage 和扩展记录可恢复。
23. 旧版本进行中的 Run 仍按原契约恢复；新计划全部使用新目标协议。

## 17. 自动化测试计划

### 17.1 类型与解析

- `AgentEditorSelection`、`AgentContextScope`、`AgentResolvedOperationTarget` 类型契约测试。
- “最后一章、第一章、倒数第一章”不产生生成数量。
- “续写三章、再写两章”正确产生数量。
- 标题、卷章序号、全书末章、插入点和章节区间解析测试。
- 重复标题、缺失章节和跨小说 ID fail-closed 测试。

### 17.2 Intent 与计划

- `chapter.continuation` 与 `chapter.sequence_continuation` 互斥归一化。
- 规则候选与模型候选冲突时只保留符合最终语义的 Operation。
- Planner 不从原始消息二次宽松提取数量。
- 所有章节写作步骤都包含冻结的 `ResolvedOperationTarget`。
- `contextScope` 不能覆盖目标字段。

### 17.3 Runtime 与上下文

- 当前编辑器章节与文本目标不同时，以文本目标为准。
- `contextScope` 外只读扩展成功、被策略拒绝、分批继续和失败 coverage。
- 扩展章节不进入 `writeScope`。
- 任务语义限制、用户明确排除和盲测未来信息隔离。
- 目录重排、正文版本变化和目标删除的 stale 传播。

### 17.4 Toolchain 与草稿

- 单章追加、单章替换、单章新增、连续新增和批量改写分别验证目标语义。
- 草稿生成只引用实际 resolvedContext。
- DraftSession/DraftBatch 目标与计划快照一致。
- 版本冲突、取消、未知副作用和人工对账回归。
- 旧 Toolchain checkpoint 恢复兼容测试。

### 17.5 Renderer

- 选择整本小说后不保留旧写作目标。
- 计划卡目标、动作、上下文和写入范围展示。
- 活动流展示扩展申请与实际读取。
- 切换编辑器章节不改变活动 Run。
- 重复标题澄清与目标修正流程。

## 18. 完整交付要求

本需求按一个完整正确性修复交付，不能只上线以下任一局部补丁：

- 仅修改“最后一章”正则。
- 仅在选择“整本小说”时把当前章替换为末章。
- 仅清空 `anchorChapterId`。
- 仅在计划 UI 中显示另一个标题。
- 仅让模型在 Prompt 中自行判断目标。

完成标准是：目标、上下文、读取策略和写入范围在协议、Intent、Runtime、Planner、Toolchain、UI、持久化恢复和自动化测试中全部分离，并通过第 16 节全部验收场景。

建议内部实施顺序：

1. 公共类型、目标解析器和目录顺序协议。
2. Intent 数量/目标语法与互斥归一化。
3. Renderer 请求拆分和 Runtime 目标冻结。
4. ContextBuilder 初始装配及扩展读取协议。
5. Toolchain 新版本与旧 Run 兼容。
6. 计划卡、活动流和 Inspector。
7. 全链路集成测试、恢复测试和手动验收。

上述顺序只用于开发依赖管理，不表示允许以半完成状态发布。

## 19. 与现有文档关系

- 读取授权、全局章节顺序、自适应读取和 evidence gate 继续遵循 [Agent 章节读取范围与委托需求](./chapter-read-scope-delegation-requirements.md)。本文件进一步明确 `contextScope` 只是初始上下文，不是读取授权边界。
- 多章节装配、专家处理、DraftBatch 和批次提交继续遵循 [Agent 多章节处理 V1 需求](./multi-chapter-processing-requirements.md)。
- Operation、SemanticProposal、IntentDecision 和风险边界继续遵循 [Agent IntentService 需求](./intent-service-requirements.md)。
- Toolchain 版本与 checkpoint 兼容继续遵循 [Agent Toolchain 需求](./toolchain-requirements.md)。
- 结构化澄清和用户决策继续遵循 [Agent 结构化问答与用户决策需求](./structured-user-input-requirements.md)。
- 异步草稿和未知副作用继续遵循 [Agent 异步草稿 Operation 持久化需求](./durable-draft-operation-requirements.md)。

发生冲突时，本文件对“小说级会话、章节操作目标、`contextScope` 非边界语义、上下文扩展、续写/新增/改写动作区分和目标冻结”的定义优先。
