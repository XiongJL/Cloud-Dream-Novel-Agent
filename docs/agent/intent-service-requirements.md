# Agent IntentService 需求

版本：v0.2  
日期：2026-07-15  
状态：IS-0 / IS-1 / IS-2 首版已完成  
适用范围：CloudDream Novel Agent 内置 Python Agent Runtime、Electron AiService、Planner、Toolchain 路由和 Agent UI 会话状态。

## 1. 背景

本需求提出前，项目已经能够判断 `shouldPlan`、`needsClarification`、只读工具调用和计划产物类型，也能通过关键词将部分报告任务路由到稳定 Toolchain，但这些判断分布在 Electron AiService、共享 TypeScript helper、Python Planner 和 Runtime 中。

随着后续增加领域 Toolchain、规则模块、语义模块、上下文指代、工具匹配和风险控制，分散判断容易产生以下问题：

- 同一句用户输入在聊天、Planner 和 Runtime 中得到不同解释。
- 新增 Toolchain 时需要同时修改多个路由点。
- “分析”“修改”“生成草稿”等副作用边界依赖 Prompt 自觉遵守。
- 会话追问、审批回答和新任务难以稳定区分。
- 规则命中、模型语义建议、上下文和能力可用性缺少统一优先级。

因此新增轻量 `IntentService`，作为用户目标结构化理解和执行路径建议的唯一入口。第一阶段只统一现有判断，不引入复杂分类系统，也不额外增加一次模型调用。为复用当前探索循环中的模型调用，IntentService 分为调用前 `preflight` 和探索完成后 `finalize` 两个阶段。

## 2. 核心定位

IntentService 负责回答：

> 用户现在想完成什么，系统建议进入哪条产品路径？

IntentService 不负责回答：

> 当前请求最终是否有权限执行？

职责链固定为：

```text
IntentService：理解用户想做什么
Planner：把明确任务拆成什么步骤
Runtime Policy：当前允许做什么
Toolchain / Tool：如何稳定完成步骤
```

IntentService 的输出是路由建议和结构化语义，不是权限凭证。

## 3. 建设目标

1. 为聊天回复、必要澄清和计划生成提供统一最终路由，并把只读探索作为形成最终决策的中间过程。
2. 支持一个用户请求包含多个有顺序的操作，而不是限制为单标签分类。
3. 将规则、模型语义、会话上下文、能力匹配和风险提示组合为稳定决策。
4. 直接复用 Toolchain Registry、Tool Manifest 和 AgentRole Registry，不维护第二份能力列表。
5. 保持 Electron AiService 为模型 Provider 和 AI 设置的唯一数据源。
6. 保持 Runtime 为权限、审批、工具白名单和副作用控制的最终边界。
7. 第一版尽量复用现有 `agent.generate_chat` 语义结果，避免增加延迟和 Token 消耗。

## 4. 非目标

第一阶段不包含：

- 不建立覆盖所有自然语言表达的大型意图库。
- 不训练或部署独立分类模型。
- 不让 IntentService 直接执行 Tool、Toolchain 或数据写入。
- 不让 IntentService 直接访问 Prisma 或小说业务 SQLite。
- 不用置信度、`safe=true` 或模型判断替代 Runtime 权限校验。
- 不自动执行识别出的任务；现有计划审核和 interrupt 边界保持不变。
- 不把角色选择、Planner、上下文装配和安全策略全部塞入一个万能 Service。
- 不持久化或展示模型隐藏思维链。

## 5. 总体架构

普通聊天输入采用两阶段 IntentService：

```text
Renderer Agent Workspace
  -> Electron IPC
  -> Python Agent Runtime.chat
      -> IntentService.preflight
          -> 解析产品入口、工作模式、当前选择和会话状态
          -> 生成 IntentPreflight 约束
      -> LangGraph Exploration
          -> agent.generate_chat（沿用当前唯一一次模型调用）
          -> SemanticProposal
          -> 有只读 toolCalls：tools -> agent.generate_chat -> ...
          -> 无 toolCalls：结束探索
      -> IntentService.finalize
          -> Rules / Context / Semantic / Capability / Risk 融合
          -> 最终 IntentDecision
              -> respond：返回模型回复
              -> clarify：返回一个必要澄清问题
              -> plan：调用 Planner 生成计划草稿
      -> Runtime Policy / Approval
      -> Toolchain 或原子 Tool
  -> AgentRunEvent / AgentArtifact / DraftSession
```

调用时序要求：

1. `preflight` 不调用模型，只形成确定性约束，不能执行 Tool。
2. 当前 `agent.generate_chat` 的首次结果被解析为 `SemanticProposal`，同时保留回复正文和只读 `toolCalls`。
3. 需要项目事实时，`SemanticProposal.toolCalls` 驱动现有探索图；探索完成前不生成最终 IntentDecision。
4. 最后一轮没有 `toolCalls` 的 SemanticProposal 交给 `finalize`，形成唯一最终 IntentDecision。
5. `finalize` 不再调用模型，因此第一版不会增加额外模型请求。

架构边界：

- IntentService 归属 Python Agent Runtime，因为 Runtime 是 Agent 编排的统一入口。
- 模型语义推断和用户可见回复仍由 Electron AiService 调用当前用户配置的 Provider 生成。
- `explore` 是形成 IntentDecision 的中间过程，不是最终路由；探索后仍需落到 `respond`、`clarify` 或 `plan`。
- `agent.revise_plan`、`agent.execute_plan` 和 `agent.submit_approval` 继续使用现有结构化 API，不经过普通聊天 IntentService。
- 用户在普通输入框中对审批卡作自由文本回答时，第一阶段只提示其使用当前审批卡，不自动转换或提交审批。
- 后续确有必要时可增加 `agent.classify_intent` Automation 能力，但不能形成第二套决策标准或额外的最终决策者。
- IntentService 只读取会话、当前选择、角色和工作模式等已传入上下文；小说事实由探索阶段的只读 Tool 获取。

## 6. 模块划分

建议目录保持在现有 Python Runtime 内：

```text
agent_runtime/
  novel_agent_runtime/
    intent/
      __init__.py
      service.py
      schemas.py
      rules.py
      context.py
      semantic.py
      operations.py
      capabilities.py
      risk.py
  tests/
    test_intent_service.py
    test_intent_rules.py
    test_intent_operations.py
    test_intent_capabilities.py
    test_intent_risk.py
```

| 模块 | 职责 | 明确禁止 |
| --- | --- | --- |
| `service.py` | 编排各模块并按优先级生成 IntentPreflight 和唯一最终 IntentDecision | 不执行 Tool 或写数据库 |
| `schemas.py` | 定义 IntentRequest、IntentPreflight、SemanticProposal、IntentOperation、IntentDecision 等契约 | 不包含业务路由逻辑 |
| `rules.py` | 处理审批提示、快捷入口、预置任务、工作模式等高确定性规则 | 不根据关键词直接授权执行 |
| `context.py` | 解析当前会话轮次、选择对象、待澄清问题和待审批状态 | 不读取完整小说业务库 |
| `semantic.py` | 归一化模型返回的语义建议，识别复合操作和歧义 | 不把模型输出视为可信权限 |
| `operations.py` | 注册稳定 Operation ID、产物类型和默认风险 | 不维护 Toolchain 的执行实现 |
| `capabilities.py` | 将操作匹配到现有 Toolchain、Tool 和角色能力 | 不调用被匹配能力 |
| `risk.py` | 标记只读、草稿、副作用和外部操作风险 | 不替代 Runtime Policy |

如果第一版实现较小，可以先合并为 `service.py`、`schemas.py`、`rules.py`、`operations.py` 和 `capabilities.py` 五个文件；模块职责和测试边界保持不变，需求增长后再拆分。

## 7. 输入契约

第一版不得使用无约束的 `dict[str, Any]` 承载核心状态。输入至少拆成以下模型：

```python
class IntentSelectionContext(BaseModel):
    novelId: str | None = None
    volumeId: str | None = None
    chapterId: str | None = None
    selectedText: str | None = None


class PendingClarificationRef(BaseModel):
    questionId: str
    question: str
    originatingMessageId: str | None = None


class IntentConversationState(BaseModel):
    activePlanId: str | None = None
    activeRunId: str | None = None
    pendingClarification: PendingClarificationRef | None = None
    hasPendingApproval: bool = False


class SemanticToolCall(BaseModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class SemanticProposal(BaseModel):
    responseContent: str
    shouldPlan: bool = False
    needsClarification: bool = False
    requestedOperations: list[str] = Field(default_factory=list)
    deliverable: str | None = None
    suggestedRole: str | None = None
    toolCalls: list[SemanticToolCall] = Field(default_factory=list)


class IntentEntryHint(BaseModel):
    actionId: str
    operationIds: list[str] = Field(default_factory=list)
    skillIds: list[str] = Field(default_factory=list)
    deliverable: str | None = None
    suggestedToolchainId: str | None = None


class IntentRequest(BaseModel):
    message: str
    conversationId: str
    locale: str
    role: str
    approvalMode: str
    source: Literal["chat", "shortcut", "preset"]
    entryHint: IntentEntryHint | None = None
    currentSelection: IntentSelectionContext
    conversationState: IntentConversationState
```

字段要求：

- `currentSelection` 只保存 UI 已知的真实 novelId、volumeId、chapterId 和选区信息。
- 不得生成 `ALL`、`CURRENT` 等伪造 ID 并传给底层 Tool；“当前章节”等语义使用独立 target reference 表达。
- `conversationState` 使用稳定字段表达当前计划、Run、待澄清问题和是否存在待审批卡。
- `source` 由产品入口确定，优先级高于模型猜测。
- `shortcut` 和 `preset` 应携带类型化 `entryHint`；其中 Operation 和 Toolchain 候选仍需注册表校验。
- `SemanticProposal` 由探索图中每次 `agent.generate_chat` 的结果构建，不直接由 Renderer 提交。
- `SemanticProposal.responseContent` 是当前模型调用生成的用户可见回复候选；IntentService 只校验和透传，不再次创作回复。
- `SemanticProposal` 是不可信建议，必须经过 Schema、Operation、能力和策略校验。
- Renderer 显式传入的当前小说、卷、章节和选中文本属于高优先级 `currentSelection`。当章节 ID 已存在时，“这篇文章”“本章”“当前章”等指代直接绑定该章节；模型不得为定位目标重复调用项目列表工具或要求用户再次选择。若只读章节 Operation 的唯一缺口已由当前选择满足，IntentService 必须覆盖模型的重复目标澄清并进入计划路由。
- 当前编辑器正文与当前章节身份必须分开传递：章节身份用于确定目标和工具参数，编辑器正文用于反映尚未保存的可见内容，并在本轮判断中优先于数据库旧正文。
- `agent.revise_plan`、`agent.execute_plan` 和 `agent.submit_approval` 的结构化输入继续由各自 API Schema 管理，不塞入 IntentRequest。

## 8. 输出契约

IntentService 使用两个结果契约：调用模型前的 `IntentPreflight` 和探索完成后的 `IntentDecision`。

```python
class IntentPreflight(BaseModel):
    source: Literal["chat", "shortcut", "preset"]
    forceChatOnly: bool
    pendingClarification: PendingClarificationRef | None = None
    pendingApprovalNotice: bool = False
    reasonCodes: list[str] = Field(default_factory=list)


class IntentSkillRequest(BaseModel):
    skillId: str
    requestedVersion: str | None = None
    selectionSource: Literal["explicit", "shortcut", "preset", "semantic"]


class IntentDecision(BaseModel):
    interaction: Literal[
        "conversation",
        "task",
        "clarification_response",
    ]
    route: Literal["respond", "clarify", "plan"]
    operations: list[IntentOperation]
    deliverable: Literal[
        "none",
        "report",
        "chapter_draft",
        "creative_assets_draft",
    ]
    contextNeeds: list[str]
    missingUserDecisions: list[str]
    suggestedRole: str | None
    requestedEffect: Literal["unknown", "none", "read_only", "draft_write", "data_write", "external"]
    needsClarification: bool
    confidence: float
    reasonCodes: list[str]
    responseContent: str
    explorationPerformed: bool = False
    requestedSkills: list[IntentSkillRequest] = Field(default_factory=list)
```

单个 `IntentOperation` 至少包含：

```python
class IntentTargetRef(BaseModel):
    kind: Literal["novel", "volume", "chapter", "selection", "conversation"]
    source: Literal["explicit_id", "current_selection", "conversation_reference"]
    id: str | None = None


class IntentOperation(BaseModel):
    type: str  # 必须存在于 IntentOperationRegistry
    target: IntentTargetRef
    suggestedToolchainId: str | None
    suggestedToolchainVersion: str | None
    requestedEffect: Literal["unknown", "none", "read_only", "draft_write", "data_write", "external"]
    confidence: float
```

约束：

- `operations` 是有序列表，支持“先检查一致性，再根据结果续写”等复合任务。
- `route` 不提供 `explore` 或 `execute`；探索是决策中间过程，意图识别不能直接触发副作用执行。
- `reasonCodes` 使用可审计短码，例如 `EXPLICIT_TASK_VERB`、`PENDING_APPROVAL`、`MATCHED_TOOLCHAIN`，不保存隐藏思维链。
- `confidence` 仅用于决定是否降级或澄清，不参与授权。
- `responseContent` 来自最后一轮 SemanticProposal；`respond` 时作为普通回复，`clarify` 时必须是单个聚焦问题，`plan` 时作为计划生成前的用户可见说明。
- `requestedEffect` 描述用户请求的最高副作用，不表示当前模式允许执行；`chat_only` 不得把一个草稿请求伪装成 `none`。
- `requestedSkills` 只记录用户显式选择或文本中明确引用的 Skill；默认 Skill 由 [Agent Skill 需求](./agent-skill-requirements.md) 中的 SkillResolver 解析。
- Toolchain 只是建议；Planner 和 Runtime 必须重新解析版本、角色、输入和权限。

示例：

```json
{
  "interaction": "task",
  "route": "plan",
  "operations": [
    {
      "type": "chapter.consistency_review",
      "target": { "kind": "chapter", "source": "current_selection" },
      "suggestedToolchainId": "chapter.consistency_review",
      "suggestedToolchainVersion": "1.0.0",
      "requestedEffect": "read_only",
      "confidence": 0.96
    },
    {
      "type": "chapter.continuation",
      "target": { "kind": "chapter", "source": "current_selection" },
      "suggestedToolchainId": "chapter.continuation",
      "suggestedToolchainVersion": "1.0.0",
      "requestedEffect": "draft_write",
      "confidence": 0.89
    }
  ],
  "deliverable": "chapter_draft",
  "contextNeeds": ["current_chapter", "plotlines", "characters", "worldsettings"],
  "missingUserDecisions": [],
  "suggestedRole": "writer",
  "requestedEffect": "draft_write",
  "needsClarification": false,
  "confidence": 0.91,
  "reasonCodes": ["EXPLICIT_TASK_VERB", "MULTI_OPERATION", "MATCHED_TOOLCHAIN"],
  "responseContent": "我会先检查当前章节的一致性，再基于检查结果生成一份可审核的续写计划。",
  "explorationPerformed": true
}
```

## 9. 决策优先级

`preflight` 必须按以下顺序形成模型调用约束：

1. **结构化产品入口**：快捷桥和预置任务携带的目标优先于文本猜测。
2. **工作模式**：`chat_only` 禁止向模型暴露项目 Tool，并禁止最终进入 `plan`。
3. **待处理状态**：存在待澄清问题时，把当前输入标记为可能的 `clarification_response`。
4. **待审批提示**：存在审批卡且用户从普通输入框回答时，只提示使用审批卡，不自动提交。
5. **当前选择**：把真实 novelId、volumeId、chapterId 和选区作为模型上下文，不生成伪造 ID。

探索完成后，`finalize` 按以下顺序融合最终决策：

1. **Preflight 约束**：产品入口、`chat_only` 和待处理状态不可被模型覆盖。
2. **确定性规则**：处理寒暄、能力咨询、显式任务动词和明确对象。
3. **会话上下文**：解析“这一章”“按刚才的方案”等指代。
4. **最终 SemanticProposal**：处理复合目标、回复内容、隐含产物和歧义。
5. **Operation 校验**：丢弃未注册 Operation ID，并保留有序合法操作。
6. **能力匹配**：匹配已启用 Toolchain、原子 Tool 和角色范围。
7. **风险标记**：按操作计算 requestedEffect，并聚合最高请求副作用。
8. **降级与澄清**：能力不可用或缺少关键用户决策时安全降级。

低优先级模块不得覆盖高优先级的明确状态。例如存在审批卡时，普通输入框中的“选第二个”不能被自动转换为 `submit_approval`；系统应提示用户在审批卡中确认。

## 10. 路由规则

### 10.1 `respond`

适用于寒暄、能力咨询、轻量讨论和项目事实回答。它可以在最终决策形成前经过受限只读探索，但不得生成计划或调用副作用 Tool。

### 10.2 `clarify`

仅在缺少无法通过项目 Tool 获得、且会实质改变任务结果的用户偏好时使用。每次只提出一个聚焦问题。

小说、章节、人物、设定和情节线等项目已有信息应通过工具发现，不应要求用户重复提供。

### 探索中间过程（非最终路由）

`explore` 不再作为最终路由。需要项目事实时，在 `preflight` 与 `finalize` 之间进入现有 `exploration_graph.py`；探索仍受只读白名单、调用上限和工作模式约束。探索结束后必须形成 `respond`、`clarify` 或 `plan`。

### 10.3 `plan`

适用于明确任务、复合任务、报告产物、草稿产物或数据修改请求。IntentDecision 作为 Planner 提示，但 Planner 必须输出正式步骤，用户批准后 Runtime 才能执行。

## 11. 规则模块要求

第一版只维护少量高价值规则：

- 寒暄和能力咨询。
- 写作模式快捷桥和专家预置任务。
- 明确的质检、续写、改写、生成素材、分析和检索动作。
- 普通聊天中的澄清回答识别。
- 存在审批卡时引导用户使用结构化审批入口。
- `chat_only` 工作模式。
- 当前 Toolchain 已禁用或角色不匹配时的回退。

规则必须返回结构化 reason code，并有独立测试。不得持续堆叠难以解释的大型关键词表；规则无法稳定判断时交给语义模块。

## 12. 语义模块要求

- 支持多操作、有序操作和产物识别。
- 区分“分析问题”和“修改正文”。
- 区分项目内可查询信息与必须由用户决定的创作偏好。
- 将当前 `agent.generate_chat` 的 `content`、`shouldPlan`、`needsClarification` 和 `toolCalls` 归一化为 SemanticProposal；`content` 映射为 `responseContent`。
- 输出必须经过 Pydantic Schema 校验。
- 模型返回未知操作、未知 Toolchain、未知角色或伪造 ID 时丢弃对应建议。
- IS-0 允许 `requestedOperations`、`deliverable` 和 `suggestedRole` 为空，由现有布尔决策和确定性规则形成兼容结果；IS-1 起再要求模型提供完整结构化语义建议。
- 第一版复用探索图中的当前聊天模型调用，不额外增加语义分类请求，也不在 `finalize` 中调用模型。
- 后续拆出 `agent.classify_intent` 时，必须通过 Electron AiService 调用当前 Provider，并保留规则优先和 Runtime 复核。

## 13. 上下文模块要求

上下文模块只处理理解用户输入所需的轻量状态：

- 当前 novelId、volumeId、chapterId 和编辑器选区。
- 当前 AgentRole 和工作模式。
- 当前会话最近任务及结构化摘要。
- 当前计划和计划修改状态。
- 待回答澄清问题。
- 是否存在待处理 Runtime interrupt / approval；具体审批选项和提交仍由 `agent.submit_approval` 管理。
- 已确认但尚未消费的创作方向。

它不负责组装完整模型上下文；长会话压缩和 Token 预算继续由 `AgentContextAssembler` 负责。它也不负责构建章节资料包；章节项目资料继续由 `chapter.context` Toolchain 或动态只读探索获取。

## 14. 能力匹配要求

- `IntentOperationRegistry` 定义稳定 Operation ID、默认 deliverable 和默认 requestedEffect；语义模型不得自由创造 Operation ID。
- Toolchain 匹配读取现有 `TOOLCHAIN_REGISTRY`。
- 原子 Tool 匹配读取现有 `AGENT_TOOL_MANIFEST`。
- 角色匹配读取现有 AgentRole 注册表。
- 每条可被 IntentService 自动匹配的 Toolchain 必须在注册元数据中声明 `supportedOperations`；可选 `intentHints` 只用于语义提示和少量别名，不作为授权依据。
- 匹配只返回建议 ID、版本和需要的输入，不执行能力。
- 一个计划步骤不能同时声明 Toolchain 和原子 Tool。
- 没有稳定 Toolchain 时允许回退到 Planner 的原子 Tool 步骤或动态探索。
- 新增 Toolchain 后不应修改 IntentService 核心融合代码；新增 Operation 或映射时只更新 Operation Registry 和 Toolchain 注册元数据。

## 15. 风险与权限边界

风险模块仅计算用户请求效果 `requestedEffect`：

| requestedEffect | 含义 | 产品路径 |
| --- | --- | --- |
| `unknown` | 首期语义信息不足，尚不能可靠分类 | 计划阶段按 `read_only` 上限 fail closed，不得创建草稿或执行写入 |
| `none` | 无项目操作 | 可直接回复 |
| `read_only` | 读取项目资料或生成只读报告 | 可探索或形成报告计划 |
| `draft_write` | 创建可审核 DraftSession | 必须批准计划 |
| `data_write` | 修改业务数据或提交草稿 | 第一阶段不自动路由 |
| `external` | 外部系统写入或开放网络副作用 | 第一阶段不支持 |

最终安全要求：

- IntentService 不输出 `allowed=true`、`safe=true` 等授权字段。
- `requestedEffect` 保留用户原始请求的最高副作用；即使 `chat_only` 最终只能 `respond`，也不能把草稿请求降写为 `none`。
- 规则与 SemanticProposal 只产生候选 Operation；模型候选高于显式任务效果时必须丢弃，并记录 `SEMANTIC_EFFECT_ESCALATION_DROPPED`。
- “需要补充说明之处”“润色建议”“续写准备度”“生成角色列表”等结果描述或只读产物不得触发 `draft_write`；否定动作和“只讨论”约束不得被关键词覆盖。
- AI 工作视角只参与分析方法、能力匹配和默认负责人选择，不得提高 Operation、deliverable 或 `requestedEffect`。
- `requestedEffect` 同时作为计划扩展上限；Planner、计划注册、修订和执行前必须验证步骤 Tool/Toolchain 的 sideEffect 不高于该上限。它仍不构成执行权限，现有计划审批和写回确认继续生效。
- Runtime 在每次底层调用前重新校验角色、工作模式、批准步骤和工具白名单。
- Toolchain ID、模型建议、风险等级和置信度都不是权限凭证。
- 草稿生成继续进入 DraftSession；正文和业务数据写回继续由用户确认。

## 16. 与现有实现的迁移

第一阶段采用行为保持式迁移：

1. 建立类型化 IntentRequest、IntentPreflight、SemanticProposal、IntentOperation 和 IntentDecision Schema。
2. `Runtime.chat` 在探索图前调用 `IntentService.preflight()`，形成工作模式、入口和会话约束。
3. 将现有 `agent.generate_chat` 的 `content`、`shouldPlan`、`needsClarification` 和 `toolCalls` 适配为 SemanticProposal。
4. 保持现有探索图工具循环；最后一轮无 `toolCalls` 时调用 `IntentService.finalize()`，不重复调用模型。
5. Runtime 使用最终 IntentDecision 决定 `respond`、`clarify` 或 `plan`。
6. 将 `route_plan_to_stable_toolchain()` 的路由判断迁入 Operation Registry 和 Capability Matcher；原函数临时保留兼容回退。
7. Planner 接收 operations、deliverable 和 Toolchain 建议，但仍独立生成并校验正式计划。
8. `agent.revise_plan`、`agent.execute_plan` 和 `agent.submit_approval` 保持现有结构化调用链。
9. 迁移稳定后删除 TypeScript、Planner 和 Runtime 中重复的意图规则。

迁移期间必须保证同一输入只存在一个最终 IntentDecision，日志中记录规则、语义和最终结果，但不记录隐藏推理。

## 17. 测试要求

自动化至少覆盖：

- 寒暄、能力咨询和轻量讨论进入 `respond`。
- 项目事实问答执行受限只读探索，最终进入 `respond`。
- 明确质检和续写任务进入 `plan`。
- “先检查再续写”产生两个有序 operations。
- 待审批状态下在普通输入框发送“选第二个”不会自动提交审批，并提示使用审批卡。
- “按刚才那个方案继续”正确解析会话指代。
- 项目内可获取信息不会触发无效澄清。
- 缺少关键创作偏好时进入 `clarify`。
- `chat_only` 不得暴露项目 Tool 或进入 `plan`，但 IntentDecision 仍保留用户请求的 requestedEffect。
- 未知 Toolchain、角色不匹配和能力禁用时安全回退。
- 模型建议副作用操作时不会绕过计划审批。
- 明确只读请求即使在世界观或作者视角下被模型建议草稿 Operation，也保持只读 Operation、报告交付物和 `read_only` 效果。
- “续写准备度”“润色建议”“是否需要重写”“先讨论怎么续写”等提及动作但未请求执行的表达不会生成草稿计划。
- “先检查再续写”“先审核再起草设定”等明确复合任务保留有序只读与草稿 Operation。
- Planner 返回高于 `requestedEffect` 的 Tool、Toolchain 或 deliverable 时安全失败，计划修订与直接注册入口执行同样校验。
- 使用固定 SemanticProposal 时，相同输入和相同结构化上下文产生完全一致的 IntentDecision。
- 真实模型集成测试只要求输出通过 Schema、权限边界不变且路由属于预期集合，不要求逐次文本或置信度完全一致。

## 18. 分阶段交付

### Phase IS-0：统一契约

- 建立类型化 Schema、两阶段 Service 和基础规则。
- 包装现有聊天决策与回复正文，不新增模型调用。
- 只读探索保持为 `preflight` 与 `finalize` 之间的中间过程。
- Runtime 开始消费唯一 IntentDecision。

### Phase IS-1：能力路由

- 接入 Toolchain、Tool 和 Role 注册表。
- 建立 Operation Registry，支持复合 operations 和 Planner 提示。
- 迁移关键词 Toolchain 路由。

### Phase IS-2：上下文与风险

- 支持审批、澄清、计划修改和会话指代。
- 接入 requestedEffect 风险标记与可观测 reason codes。
- 清理旧的重复规则。

## 19. 首期验收标准

首期验收范围已经扩展为 IS-0 与 IS-1：

1. 所有普通 Agent 聊天输入在模型调用前形成 IntentPreflight，在进入 Planner 前形成唯一、可校验的最终 IntentDecision。
2. 当前寒暄、咨询、明确任务和澄清行为不发生产品回归。
3. 第一版不增加额外模型请求。
4. `chat_only`、待审批和快捷入口优先级由确定性规则保证。
5. IntentService 不执行 Tool、不授予权限、不直接访问业务数据库。
6. 决策日志只包含输入摘要、reason codes 和结构化结果，不包含密钥或隐藏思维链。
7. Python 单元测试覆盖路由优先级和主要降级路径。
8. `agent.revise_plan`、`agent.execute_plan` 和 `agent.submit_approval` 的现有结构化行为不回归。

## 20. 实施状态（2026-07-15）

IS-0、IS-1 与 IS-2 首版已落地：

- Python Runtime 新增类型化 `IntentRequest`、`IntentPreflight`、`SemanticProposal`、`IntentOperation` 与唯一 `IntentDecision`；`preflight -> exploration -> finalize` 沿用现有模型调用，不增加分类请求。
- `Runtime.chat` 只消费最终 `IntentDecision.route`，并持久化待澄清引用与最后决策；`chat_only`、普通输入框待审批提示和待澄清回答优先于模型建议。
- Electron AiService 输出有序 `requestedOperations`、deliverable、suggestedRole 与 confidence；未知 Operation 在 Electron 和 Python 两层均被丢弃。
- `IntentOperationRegistry` 已注册项目查询、章节上下文、一致性审核、续写、改写、创作素材、读者反馈和考据操作，并统一默认产物、requestedEffect、角色与上下文需求。
- Capability Matcher 复用 Toolchain Registry、Tool Manifest 与 AgentRole 范围，只返回 Toolchain/Tool/角色建议，不执行能力。
- Toolchain 元数据新增 `supportedOperations` 与 `intentHints`；Planner 接收完整 IntentDecision，Runtime 再次解析版本、角色、章节目标和正式计划步骤。
- 原 `route_plan_to_stable_toolchain()` 关键词判断已停止参与路由，只保留无行为兼容壳；稳定链路由改为 `route_plan_from_intent()`。
- 会话状态保存上一轮有序 Operation、deliverable 与建议角色；“按刚才那个方案继续”等明确指代优先继承结构化 Intent，不使用历史自然语言重新猜测。
- 独立 `risk.py` 聚合 `unknown / none / read_only / draft_write / data_write / external`。直接写回要求结构化审核确认，外部发布在普通会话中明确拒绝；requestedEffect 始终保留原请求风险。
- Toolchain 新增 `enabled` 元数据；禁用链不会暴露给 Planner 或自动匹配，Capability Matcher 记录 `TOOLCHAIN_DISABLED` 并降级到原子工具或动态 Planner。
- Electron AiService 已停止调用旧 TypeScript `normalizeAgentChatDecision` 改写最终路由；旧 helper 与测试入口已删除，规则覆盖迁入 Python IntentService。

后续增强不再阻塞 IS-2 首版：跨多个历史 Run 的命名引用、运行时配置中心动态开关 Toolchain，以及更细的数据写入 Operation。当前会话最近 Intent、静态启停元数据和副作用降级已经形成稳定边界。

## 21. 默认设计决策

- 使用独立 IntentService，但保持轻量，不引入独立分类模型。
- Python Runtime 持有 IntentPreflight 和最终 IntentDecision；Electron AiService 提供 SemanticProposal 和用户可见回复候选。
- IntentService 支持多操作，不采用单一 intent enum 表达完整任务。
- 第一版采用 `preflight -> 现有探索循环 -> finalize`，不额外增加一次分类请求。
- `explore` 是决策中间过程，最终路由只有 `respond`、`clarify` 和 `plan`。
- 审批、计划修改和执行继续走现有结构化 API，不由普通聊天意图自动提交。
- Context 模块只处理会话和选择状态，不替代 AgentContextAssembler 或章节上下文 Toolchain。
- Operation Registry 提供稳定操作语义，Toolchain Registry 声明支持的 Operation。
- Capability Matcher 只匹配能力，不执行能力。
- Risk Assessment 只标记副作用，不授予权限。
- 所有副作用继续经过 Planner、用户批准和 Runtime 最终校验。
