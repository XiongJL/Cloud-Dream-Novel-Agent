# Agent Skill 与用户自定义 Skill 需求

版本：v0.4
日期：2026-08-04
状态：AS-0 实现契约基线；AS-1 及后续仍为需求草案
适用范围：CloudDream Novel Agent 内置 Agent、Python Agent Runtime、Electron Main、Agent Workspace、IntentService、Planner、Toolchain、AgentContextAssembler 与 DraftSession。

## 1. 背景

当前 `AgentRole` 已展示“正文续写”“节奏诊断”“一致性检查”等 Skill 文案，但这些内容只是角色能力标签，尚未形成可注册、可加载、可版本化和可执行审计的 Agent Skill。

同时，小说业务中已经存在“技能、招式、能力、功法”等创作资产。为避免混淆，本需求中的 Skill 统一称为 **Agent Skill** 或 **创作技能**：

- 小说技能：小说角色拥有的能力、招式和功法，属于创作资产。
- Agent Skill：指导 Agent 采用某种方法完成创作任务的声明式能力包。

典型用户需求：

> 用户有一套固定的角色生成提示词流程，希望保存为自己的创作技能，在生成角色时重复使用，并自动读取当前小说已有角色和世界观，最终生成可审核草稿。

这类需求不适合硬编码进角色 Prompt，也不应让用户编写任意执行脚本。系统需要提供声明式、版本化、可预览、受权限边界约束的用户自定义 Agent Skill。

## 2. 核心定位

Agent Skill 回答：

> 这个任务应该采用什么方法、检查标准、提示步骤和输出格式？

它不回答：

> 当前请求是否有权限执行，底层工具应以什么顺序运行？

各层职责固定为：

```text
AgentRole：谁来做，以及角色允许的能力边界
IntentService：用户想做什么
Agent Skill：采用什么方法和标准
Planner：拆成哪些正式步骤
Toolchain：步骤如何稳定执行
Tool：执行哪个原子操作
Runtime Policy：当前是否允许执行
```

Agent Skill 是方法论层，不是 Tool、Toolchain、权限策略或任意代码插件。

### 2.1 概念分类与命名边界

实现前必须先按下表分类，禁止继续把任务名称、编排职责和方法能力混放在 `skills` 字符串数组中：

| 概念 | 产品问题 | 合法示例 | 不应归入 Agent Skill 的示例 |
| --- | --- | --- | --- |
| AgentRole | 谁来做、允许做什么 | 作者、编辑、读者、世界观 | 正文续写、项目全局审计 |
| Intent Operation | 用户要完成什么 | `chapter.continuation`、`chapter.consistency_review` | 文风保持、读者盲测方法 |
| Preset Task | 帮用户快速填写什么任务 | 续写当前章节、项目全局审计 | 可加载的 Prompt 方法正文 |
| Agent Skill / 创作技能 | 采用什么方法、标准和输出格式 | 连续性审查法、读者盲测法、矛盾驱动角色生成 | 任务拆解、专家协调、结果汇总 |
| Toolchain | 已选步骤如何确定性执行 | `chapter.consistency_review@1.0.0` | 用户可编辑的方法说明 |
| Tool | 执行哪个原子能力 | `chapter.get`、`rag.ask` | 审查量表、写作风格 |

规则：

- “正文续写”“新增角色”等目标首先建模为 Operation，不作为 Skill 名称重复注册。
- “任务拆解”“专家协调”“结果汇总”属于 Supervisor、Planner 或 Toolchain 的编排职责，不注册为 Agent Skill。
- Preset 可以绑定 Skill，但 Preset 本身不是 Skill。
- 产品 UI 统一使用“创作技能”或“Agent Skill”；小说角色拥有的能力继续称为“角色技能”。
- 正式 Skill 页面接入前，现有只读入口称为“角色能力说明”，不得称为“角色与 Skill 设置”。

## 3. 建设目标

1. 将高频创作方法、提示流程、审查标准和输出格式保存为可复用 Agent Skill。
2. 支持内置、用户全局和当前小说三种 Skill 作用域。
3. 支持用户通过自然语言、`/` 快捷入口、结构化编辑器或导入文件创建和更新声明式 Skill。
4. 提供内置 Skill Creator，将自然语言、当前对话、当前小说、本地文档或在全局外部研究能力启用时获得的 Web Search 资料转换为可审核的 Skill Draft。
5. 支持一个 Creator 请求生成多个 Skill，并可选生成按 Operation 绑定这些 Skill 的 Skill Pack。
6. 允许 IntentService、AgentRole、预置任务、Skill Pack 和用户显式选择共同参与 Skill 解析。
7. 将完整 Skill 内容按需加载，避免所有角色 Skill 常驻模型上下文。
8. 复用现有 Planner、Toolchain、FastMCP、Runtime Policy 和 DraftSession 边界。
9. 对每次执行使用的 Skill ID、版本和内容哈希进行审计，保证历史结果可解释。
10. 支持 Skill 预览、试运行、版本更新、启停、导入和导出。
11. 用户自定义 Skill 不得扩大 Tool 权限或绕过计划审批。
12. Skill Creator 必须帮助用户定义触发边界、指导自由度和可验证样例，并通过渐进加载控制上下文成本。

## 4. 非目标

第一阶段不包含：

- 不允许 Skill 包含 Python、JavaScript、Shell、PowerShell 或其他可执行代码。
- 不允许 Skill 注册新的 MCP Tool 或直接调用 Tool。
- 不允许 Skill 修改角色工具白名单、Runtime Policy 或审批规则。
- 不实现在线 Skill 市场、评分、付费和自动下载。
- 不执行 Skill 中引用的远程 URL、附件或外部资源。
- 不因用户只提供作品名称就自动下载盗版、付费墙后或来源不明的完整正文；Web Search 只由 Skill Creator Toolchain 在全局外部研究能力和 Runtime Policy 均启用时执行。
- 不实现运行中热替换；活跃 Run 使用启动时锁定的 Skill Revision。
- 不允许一个 Skill 自动触发另一个 Skill 的无限递归调用。
- 不把普通 Prompt 收藏夹全部升级为 Skill；只有具备稳定用途、输入、方法或输出约束的内容才适合成为 Skill。
- 不将用户 Skill 内容提升到系统提示同级或更高优先级。

## 5. 术语

### 5.1 Agent Skill

由元数据、方法说明、约束、示例、输入 Schema、输出约定和能力声明组成的声明式能力包。

### 5.2 Skill Definition

Skill 的稳定身份和元数据，例如 ID、名称、作用域、适用 Operation 和允许角色。

### 5.3 Skill Revision

Skill 某一不可变版本的完整内容。已被 Run 使用的 Revision 不得原地修改。

### 5.4 Skill Binding

Skill 与用户默认、小说默认、角色、预置任务或 Operation 之间的启用和默认关系。

### 5.5 Resolved Skill Set

SkillResolver 根据显式选择、作用域、角色和 Operation 得出的本次执行 Skill 集合，通常包含一个主 Skill 和最多一个辅助 Skill。

### 5.6 Skill Snapshot

Run 开始时锁定的 Skill ID、Revision、内容哈希、解析来源和必要正文快照，用于恢复和审计。

### 5.7 Skill Creator

系统内置的元能力，负责把用户的自然语言创建意图和允许读取的来源材料转换为一个或多个 AgentSkillDraft。Skill Creator 只定义创建方法；资料读取、模型调用、校验、试运行和保存由受控 Authoring Toolchain 执行。

### 5.8 AgentSkillDraft

尚未成为正式 Revision 的可编辑、可预览、可试运行草稿。自然语言创建、自动提炼和导入冲突处理都必须先形成 Draft；用户确认后才能提交为 Skill Definition 与不可变 Revision。

### 5.9 Skill Pack

一组 Skill 与 Operation/Role 的绑定集合。Pack 不把全部 Skill 正文拼接为一个 Prompt；每次 Operation 仍只解析一个主 Skill和最多一个辅助 Skill。

### 5.10 Derivation Report

Skill Creator 对来源、覆盖范围、证据等级、置信度、专有内容污染和降级原因的结构化说明。完整正文不进入报告或 Skill Revision。

## 6. 适用性判断

适合做 Agent Skill：

- 固定角色生成、场景扩写或大纲设计方法。
- 章节审校清单、节奏诊断维度和评分标准。
- 用户长期使用的文风要求和输出格式。
- 读者盲测、事实核查、世界观一致性检查方法。
- 某一类型小说的创作约束，例如悬疑伏笔设计规则。
- 当前小说专属的术语、人物塑造或设定生成规范。

不适合只做 Skill：

- 单次临时要求，例如“这个角色叫林夜”。
- 只需要一个简单 Prompt 且不会复用的请求。
- 必须确定性调用多个 Tool、支持分支、暂停和恢复的流程；这应由 Toolchain 承担。
- 新的数据读取或写入能力；这应由 Tool 和 AutomationService 承担。
- 权限、审批和安全规则；这应由 Runtime Policy 承担。

判断原则：

```text
方法、标准和提示方式稳定 -> Skill
执行步骤、工具顺序和状态转换稳定 -> Toolchain
单项外部或业务能力 -> Tool
```

## 7. 总体架构

```text
Renderer Agent Workspace
  -> IntentService
      -> IntentDecision.operations
      -> 用户显式 Skill 引用
      -> Skill 创建、更新、拆分或组合意图
  -> AgentSkillAuthoring（创建类请求）
      -> 内置 Skill Creator / Creator Profile
      -> Source Resolver
          -> 当前对话 / 当前小说 / 附件 / 本地文档
          -> 全局外部研究能力启用时的 Web Search
          -> 标记为低置信度的模型已有知识
      -> AgentSkillDraft / SkillPackDraft
      -> 预览 / 试运行 / 用户确认
      -> Electron Main 保存 Revision
  -> AgentSkillResolver
      -> Built-in Skill Registry
      -> User Skill Store
      -> Novel Skill Store
      -> Role / Preset / Operation Binding
      -> ResolvedSkillSet
  -> Planner
      -> 计划步骤携带 SkillRef
  -> Runtime Policy
      -> 校验角色、Operation、Toolchain 和 Tool 权限
  -> Dynamic Agent 或 Domain Toolchain
      -> AgentSkillCompiler
      -> AgentContextAssembler
      -> 模型节点
  -> AgentArtifact / DraftSession
```

核心边界：

- Electron Main 是用户和小说级 Skill 持久化的唯一写入边界。
- Python Runtime 负责合并 Skill 来源、解析 Skill、编译 Prompt 片段和记录执行快照。
- Renderer 不直接读取 Skill 文件或数据库表。
- SkillResolver 只选择 Skill，不决定 Tool 权限。
- SkillCompiler 只生成受限 Prompt 片段，不执行 Tool。
- Skill Creator 不能直接访问网络、文件或数据库；Authoring Toolchain 根据 Runtime Policy 和用户选择调用受控来源能力。
- 所有自然语言创建和更新先生成 AgentSkillDraft，不直接覆盖或创建正式 Revision。
- Skill Pack 只保存解析绑定，不授予工具权限，也不突破单 Operation 的主/辅助 Skill 数量限制。
- Planner 和 Toolchain 可以消费 Skill，但必须继续经过 Runtime Policy。
- 任何生成内容继续进入 DraftSession，未经用户确认不写回小说数据。

## 8. Skill 与其他模块的关系

### 8.1 与 AgentRole

Role 定义默认 Skill 和能力边界：

```python
defaultSkillIds = (
    "builtin.chapter-quality-review",
    "builtin.pacing-diagnosis",
)
```

现有 `roles.py` 中用于展示的自由文本 `skills` 应逐步迁移为稳定 `defaultSkillIds`。Renderer 通过 AgentSkill Registry 获取本地化标题和说明，不再维护第二份 Skill 文案。

Role 默认 Skill 只是选择建议，不能扩大 Role 的 Tool 白名单。

### 8.2 与 IntentService

IntentService 负责识别：

- 用户显式提到的 Skill 名称或 ID。
- 当前 Operation，例如现行注册表中的 `creative_asset.draft`。角色生成通过该 Operation 的 `targetSections=["characters"]` 收窄目标，首期不另造尚未注册的 Operation ID。
- 用户是否在请求中明确要求覆盖默认 Skill。

IntentDecision 只携带用户请求的 Skill 引用，不负责解析最终版本。SkillResolver 在 IntentDecision 后执行。

### 8.3 与 Planner

Planner 接收：

- 有序 Operations。
- ResolvedSkillSet 摘要。
- Skill 支持的产物类型、约束和推荐 Toolchain。

Planner 输出的每个相关步骤必须记录实际 SkillRef。模型不能返回 Registry 中不存在的 Skill ID 或 Revision。

### 8.4 与 Toolchain

Toolchain 负责读取上下文、调用工具、暂停恢复和生成 Artifact；Skill 负责模型节点使用的方法和输出标准。

示例：

```text
creative_asset.draft Toolchain
  -> 读取已有角色、世界观和情节线
  -> 加载 user.character-generator.deep-conflict Skill
  -> 组装角色生成 Prompt
  -> 生成角色草稿
  -> 检查同名与设定冲突
  -> 创建 DraftSession
```

Toolchain 不直接按 Skill 文本新增底层工具调用。其允许 Tool 集合仍由 Toolchain Definition 和 Runtime Policy 决定。

### 8.5 与 AgentContextAssembler

- Skill 摘要可以进入 Planner 上下文。
- 只有最终选中的 Skill Revision 正文进入模型调用上下文。
- `contextNeeds` 转换为上下文请求，由 AgentContextAssembler 按预算装配实际资料。
- Skill 正文与项目资料分区放置，禁止把整份项目上下文直接插值进 Skill 模板。
- 长 Skill 必须按预算裁剪示例和低优先级说明，核心约束不得静默丢失。

### 8.6 与 Skill Creator 和来源解析

通用 Creator 使用 `builtin.skill-creator` 方法，第一阶段提供以下 Creator Profile：

- `blank`：从零创建。
- `from_conversation`：把当前对话中的稳定要求保存为 Skill。
- `style_from_work`：根据作品名称和可用来源提炼语言风格、叙事方法，并可选生成 Skill Pack。
- `style_from_own_writing`：从当前小说、选中章节或本地作者文稿提炼个人风格。
- `rubric_from_document`：从编辑规范、投稿要求或检查清单生成审校 Skill。
- `character_voice`：从角色设定和样本文本生成角色声音 Skill。
- `split_skill`：把职责过宽的 Skill 拆分。
- `compose_pack`：组合已有 Skill 并按 Operation 建立绑定。

来源优先级：

```text
用户明确指定的本地材料
  > 当前小说、当前选择或附件
  > 全局外部研究能力启用时的 Web Search 和公开资料
  > 模型已有知识
```

规则：

- 只使用模型已有知识时可以生成候选 Draft，但必须标记来源覆盖不足和低置信度，不能声称读取过原文。
- 书评、简介和作者访谈可支持叙事机制分析；没有正文样本时，语言风格结论必须降级或要求用户提供本地文档。
- 来源正文、网页全文和本地路径不写入正式 Revision；Revision 只保存抽象方法、约束和经校验的短示例。
- 自动检查并移除不必要的人物名、地名、专有名词、剧情事件、标志性原句和过长连续文本。
- 同一次请求可以提出多个 Skill Draft，例如语言风格、悬念与信息释放、群像人物推进，并可选生成一个 Pack Draft。

### 8.7 与内置创作方案

“新建小说”固定为内置 `builtin.novel-bootstrap` 创作方案，通过 `/novel new` 或自然语言进入。它不是可编辑 Skill，而是可以在各阶段消费内置、用户或当前小说 Skill Pack 的受控创建流程。

新建小说遵循递进式创作流程，而不是固定表单：

```text
核心定位：题材与创意 -> 主角设定 -> 核心冲突
  -> 自适应深度定制：模型读取全部已答信息，只追问仍会改变蓝图的缺口
  -> 蓝图确认：故事线、人物关系、世界规则、分卷路线、章节节拍与质量标准
  -> 项目初始化：novel.project_initialize -> 可审核的情节线/情节点/角色/物品/技能/设定/地点草稿
  -> 章节草稿与质量审核：通过既有续写、改写、连续性与读者审核工具链推进
```

- 核心定位必须从题材开始，且题材与创意是用户事实，后续模型不得改写或忽略。
- 深度定制不是预设的“世界、视角、规模”问卷。模型应结合所有轮次的原始答案、有效答案和跳过后的推荐回退，按需提出 1 至 3 个互不重复的高影响问题；最多两轮，信息足够即进入蓝图。
- 深度定制的模型调用或结构化输出失败时不得静默跳过并生成蓝图；保留该输入会话以供重试，避免用户误以为系统已经完成理解。
- 蓝图和项目素材均为可审核草稿。模型不能自行直接写入正式项目记录，也不能声称已经完成当前产品未提供的全书并行直写。

### 8.8 Creator 质量流程

Creator 不应在收到一句描述后直接生成最终 Revision。创建和大幅更新统一经过：

```text
理解用途与具体例子
  -> 明确应该触发和不应触发的边界
  -> 选择指导自由度
  -> 识别真正可复用、非通用常识的方法
  -> 生成 Draft
  -> Schema 与内容质量校验
  -> 独立试运行
  -> 用户确认提交
  -> 基于真实使用反馈生成下一 Revision Draft
```

规则：

- Creator 优先从用户已有描述和来源中推断答案，只询问会实质改变结果的最少问题；不得把完整表单当作创建前置条件。
- 至少形成一个“应该使用”的具体请求样例；启用语义选择时还必须形成一个“不应使用”的反例。用户未提供时，Creator 可以提出候选并让用户修改。
- 方法正文只保留模型难以仅靠通用能力稳定重现的流程、约束、领域知识和输出契约；空泛建议、重复说明和创建过程说明不进入正式 Revision。
- 指令使用直接、可执行的表达；示例优先短小并覆盖边界，不通过堆叠大量范文控制模型。
- 第一阶段的“可复用内容规划”只允许声明式 instructions、constraints、examples、输入输出契约和 `contextNeeds`，不得借机生成脚本或授予新工具。

## 9. Skill 作用域与优先级

支持三种作用域：

| Scope | 来源 | 可见范围 | 是否可编辑 |
| --- | --- | --- | --- |
| `builtin` | 应用内置 | 所有用户和小说 | 否 |
| `user` | 用户创建或导入 | 当前用户的所有小说 | 是 |
| `novel` | 当前小说创建或绑定 | 单本小说 | 是 |

同一 Operation 的解析优先级：

```text
本次用户显式选择
  > 当前预置任务绑定
  > 当前小说默认 Skill
  > 用户全局默认 Skill
  > 当前 Role 默认 Skill
  > 系统内置 Operation 默认 Skill
  > 不加载 Skill
```

规则：

- 显式选择必须最高优先，但仍要通过 Operation、Role 和状态校验。
- `novel` Scope 不得在其他小说中使用。
- 被禁用或归档的 Skill 不参与新 Run 解析。
- 同一优先级出现多个默认主 Skill 时标记配置冲突，不能随机选择。
- 默认每个 Operation 最多解析一个主 Skill 和一个辅助 Skill。
- 用户可以明确选择“本次不使用 Skill”。

## 10. Skill 类型

第一阶段统一使用声明式 `prompt_method` 类型：

```text
metadata
+ inputs
+ instructions
+ constraints
+ examples
+ output contract
+ context needs
```

后续可扩展但暂不实施：

- `rubric`：纯评分或审查量表。
- `style_profile`：文风与语言规范。
- `composite`：组合多个已注册 Skill，但不允许递归。
- `workflow`：有限 DSL；只有真实需求证明普通 Toolchain 无法覆盖时再评估。

用户自定义 Skill 第一阶段只能创建 `prompt_method`，不能创建可执行 Workflow。

## 11. 数据模型

### 11.1 Runtime Definition

```python
class AgentSkillDefinition(BaseModel):
    id: str
    title: str
    description: str
    scope: Literal["builtin", "user", "novel"]
    ownerNovelId: str | None = None
    skillType: Literal["prompt_method"] = "prompt_method"
    category: Literal["style", "narrative_method", "generation", "review", "character_voice", "novel_rules", "other"] = "other"
    origin: Literal["builtin", "authored", "derived", "imported"]
    guidanceMode: Literal["adaptive", "guided", "strict"] = "guided"
    semanticSelection: Literal["off", "suggest", "auto"] = "suggest"
    triggerHints: tuple[str, ...] = ()
    antiTriggerHints: tuple[str, ...] = ()
    allowedRoles: tuple[str, ...] = ()
    supportedOperations: tuple[str, ...]
    recommendedToolchains: tuple[str, ...] = ()
    requiredCapabilities: tuple[str, ...] = ()
    contextNeeds: tuple[str, ...] = ()
    inputModel: type[BaseModel] | None = None
    outputType: Literal[
        "none",
        "report",
        "chapter_draft",
        "creative_assets_draft",
    ] = "none"
    enabled: bool = True
```

### 11.2 Revision

```python
class AgentSkillRevision(BaseModel):
    skillId: str
    revisionId: str
    version: str
    instructions: str
    constraints: tuple[str, ...] = ()
    examples: tuple[AgentSkillExample, ...] = ()
    manifest: dict[str, Any]
    contentHash: str
    createdAt: str
```

要求：

- `description` 必须同时说明“该 Skill 做什么”和“在什么请求或场景下使用”，不能只写宣传性文案。
- `triggerHints` 是正向触发样例，`antiTriggerHints` 是易混淆但不应触发的反例；两者只参与语义匹配和验证，不高于用户显式选择与 Operation 兼容性规则。
- `semanticSelection=off` 仅允许显式选择或默认 Binding；`suggest` 只向用户建议可用 Skill；`auto` 才允许 IntentService 在唯一且高置信匹配时形成 semantic request。User/Novel Skill 默认 `suggest`。
- `semanticSelection=auto` 必须同时具备正反触发样例且最近一次 triggerStatus 为 passed；重名、低置信度或反例边界命中时必须退回建议或澄清。
- `guidanceMode=adaptive` 适合文风、构思等开放任务；`guided` 适合有推荐步骤但允许调整的叙事方法；`strict` 适合一致性检查、格式转换等脆弱流程。它调整方法约束强度，不改变 Runtime Policy。
- 持久化记录 `id` 必须全局唯一；`stableId` 是用户可读稳定标识，在对应 Scope 内唯一，使用小写点分或连字符命名，规范化后不超过 64 个 ASCII 字符。
- stableId 由 Creator 根据用途生成，标题更新不自动改名；冲突时要求创建副本、选择已有 Skill 或确认新的 stableId，不静默覆盖。
- AgentSkillRef 始终引用全局唯一记录 ID；标题和 stableId 只用于展示和导入匹配。
- Revision 不可变；编辑操作创建新 Revision。
- `contentHash` 使用规范化内容计算，不包含本地文件路径。
- Built-in Skill 使用语义化版本。
- 用户 Skill 默认自动递增补丁版本，也允许用户填写更高版本。
- Run 必须锁定具体 `revisionId + contentHash`，不能只记录 latest。

### 11.3 Binding

```python
class AgentSkillBinding(BaseModel):
    skillId: str
    novelId: str | None = None
    roleId: str | None = None
    operationId: str | None = None
    presetId: str | None = None
    bindingType: Literal[
        "novel_default",
        "user_default",
        "role_default",
        "preset",
    ]
    priority: int = 0
    enabled: bool = True
```

Binding 只影响选择优先级，不改变 Skill 或工具权限。

### 11.4 执行引用

```python
class AgentSkillRef(BaseModel):
    skillId: str
    revisionId: str
    version: str
    contentHash: str
    selectionSource: Literal[
        "explicit",
        "preset",
        "novel_default",
        "user_default",
        "role_default",
        "builtin_default",
    ]
    operationId: str
```

### 11.5 来源、创建请求与草稿

```python
class AgentSkillSourceRef(BaseModel):
    kind: Literal[
        "conversation",
        "current_novel",
        "chapter_selection",
        "attachment",
        "local_document",
        "web",
        "model_prior",
    ]
    sourceId: str | None = None
    title: str
    uri: str | None = None
    contentHash: str | None = None
    coverage: str | None = None
    evidenceLevel: Literal["primary_text", "public_analysis", "model_prior"]


class AgentSkillAuthoringRequest(BaseModel):
    action: Literal["create", "update", "split", "compose_pack"]
    creatorProfile: Literal[
        "blank",
        "from_conversation",
        "style_from_work",
        "style_from_own_writing",
        "rubric_from_document",
        "character_voice",
        "split_skill",
        "compose_pack",
    ]
    userRequest: str
    targetSkillId: str | None = None
    sourceHints: list[AgentSkillSourceRef] = Field(default_factory=list)
    requestedOutputs: list[str] = Field(default_factory=list)


class AgentSkillDerivationReport(BaseModel):
    sources: list[AgentSkillSourceRef]
    coverageSummary: str
    confidence: Literal["low", "medium", "high"]
    warnings: list[str] = Field(default_factory=list)
    contaminationWarnings: list[str] = Field(default_factory=list)


class AgentSkillValidationCaseRef(BaseModel):
    kind: Literal["synthetic", "source_holdout", "run_artifact"]
    refId: str | None = None
    contentHash: str | None = None


class AgentSkillValidationReport(BaseModel):
    schemaStatus: Literal["passed", "failed"]
    qualityStatus: Literal["passed", "warning", "failed"]
    triggerStatus: Literal["not_run", "passed", "failed"] = "not_run"
    generalizationStatus: Literal["not_run", "passed", "failed", "unavailable"] = "not_run"
    testCaseRefs: list[AgentSkillValidationCaseRef] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    testedAt: str | None = None


class AgentSkillDraft(BaseModel):
    draftId: str
    status: Literal["editing", "ready_for_review", "committed", "discarded"]
    action: Literal["create", "update"]
    targetSkillId: str | None = None
    proposedDefinition: AgentSkillDefinition
    proposedRevision: AgentSkillRevision
    derivationReport: AgentSkillDerivationReport | None = None
    validationReport: AgentSkillValidationReport | None = None
    expectedCurrentRevisionId: str | None = None
    createdAt: str
    updatedAt: str
```

规则：

- Creator 输出必须先通过固定 Schema 解析，模型不能直接构造数据库写入参数。
- User/Novel Scope 的新 Skill 至少包含一个 `triggerHints`；`semanticSelection=auto` 时还必须包含一个有效 `antiTriggerHints`，并通过正反触发验证。
- `ready_for_review` 要求 Schema 通过且内容质量没有 failed；独立泛化验证不可用时可以带明确 warning 进入审核，但不能显示为已通过。
- `expectedCurrentRevisionId` 用于更新时的乐观并发校验。
- Draft 可以保存和恢复；`committed` 后仍保留来源摘要与正式 Revision 引用，但不保留完整来源正文。
- Web URL 只作为来源引用；打开、读取和搜索由受控 Toolchain 完成。

### 11.6 Skill Pack

```python
class AgentSkillPackBinding(BaseModel):
    operationId: str
    roleId: str | None = None
    primarySkillId: str
    primaryRevisionId: str
    auxiliarySkillId: str | None = None
    auxiliaryRevisionId: str | None = None


class AgentSkillPackRevision(BaseModel):
    packId: str
    revisionId: str
    version: str
    bindings: list[AgentSkillPackBinding]
    contentHash: str


class AgentSkillPackDraft(BaseModel):
    draftId: str
    title: str
    description: str
    proposedSkillDraftIds: list[str]
    proposedRevision: AgentSkillPackRevision
    status: Literal["editing", "ready_for_review", "committed", "discarded"]
```

Pack 解析时按当前 Operation 和 Role 选择对应 Binding，再将锁定的主、辅助 Revision 分别交给普通 SkillResolver 校验。`auxiliarySkillId` 与 `auxiliaryRevisionId` 必须同时为空或同时存在。Pack 不是 `composite` Skill，不允许把所有成员正文无条件拼接；成员 Skill 后续更新不会改变旧 Pack Revision 的行为。

## 12. 持久化设计

### 12.1 Canonical Source

- Built-in Skill：随 Python Runtime 打包，内容不可变。
- User/Novel Skill：保存在 Electron Main 管理的 SQLite/Prisma 数据库中。
- Python AgentSkill Registry：运行时合并视图，不是用户 Skill 的持久化源。
- 导入导出的 Markdown 文件只是交换格式，不是运行时唯一数据源。

### 12.2 建议表

```text
AgentSkill
  id
  stableId
  scope
  ownerNovelId?
  title
  description
  skillType
  enabled
  archivedAt?
  currentRevisionId
  createdAt
  updatedAt

AgentSkillRevision
  id
  skillId
  version
  manifestJson
  instructions
  contentHash
  createdAt

AgentSkillBinding
  id
  skillId
  novelId?
  roleId?
  operationId?
  presetId?
  bindingType
  priority
  enabled
  createdAt
  updatedAt

AgentSkillDraft
  id
  status
  action
  targetSkillId?
  draftJson
  derivationReportJson?
  expectedCurrentRevisionId?
  committedRevisionId?
  createdAt
  updatedAt

AgentSkillPack
  id
  stableId
  scope
  ownerNovelId?
  title
  description
  enabled
  archivedAt?
  currentRevisionId
  createdAt
  updatedAt

AgentSkillPackRevision
  id
  packId
  version
  bindingsJson
  contentHash
  createdAt
```

要求：

- Python Runtime 不直接访问这些表，通过 Electron Automation/IPC 获取。
- 删除采用归档；被历史 Run 引用的 Revision 不物理删除。
- Skill 更新使用乐观并发版本，避免多窗口覆盖。
- 备份恢复应包含 User/Novel Skill、Revision 和 Binding。
- Skill 内容不得包含或导出 AI API Key、访问令牌和 Provider 私密设置。
- Draft 和 Derivation Report 只保存来源摘要、引用、哈希、覆盖度和警告；不得复制完整本地小说、网页正文或附件正文。
- Pack Revision 与 Skill Revision 一样不可变；成员 Skill 更新不会静默改变旧 Pack Revision。

## 13. 目录结构

实现阶段保持现有顶层结构：

```text
agent_runtime/
  novel_agent_runtime/
    agent_skills/
      __init__.py
      schemas.py
      registry.py
      resolver.py
      loader.py
      compiler.py
      validation.py
      authoring.py
      source_resolver.py
      pack_resolver.py
      builtin/
        character_generation.md
        continuity_review.md
        pacing_diagnosis.md
        reader_blind_test.md
  tests/
    test_agent_skill_registry.py
    test_agent_skill_resolver.py
    test_agent_skill_compiler.py
    test_agent_skill_validation.py

apps/desktop/
  electron/
    agentSkills/
      AgentSkillStore.ts
      AgentSkillDraftStore.ts
      AgentSkillPackStore.ts
      agentSkillIpc.ts
      agentSkillImport.ts
  src/components/AgentWorkspace/
    AgentSkillPanel.tsx
    AgentSkillEditor.tsx
    AgentSkillPicker.tsx
    AgentSkillCreator.tsx
    AgentSkillDraftReview.tsx
    AgentSlashCommandMenu.tsx
```

使用 `agent_skills` 而不是 `skills` 作为代码目录，避免与小说业务中的技能资产混淆。

## 14. Skill 文件格式

导出使用单文件 `SKILL.md` 作为可读交换格式；导入同时支持单文件 `SKILL.md` 和用户授权选择的本地 Skill 目录。目录导入不是把原始目录直接注册为运行时 Skill，而是先形成受控的目录快照，再由模型转换为本产品的声明式 Draft。第一阶段不执行脚本、不读取二进制附件、不自动加载远程引用。

### 14.1 单文件交换格式

示例：

```markdown
---
schemaVersion: novel-editor.agent-skill.v1
id: user.character-generator.deep-conflict
version: 1.0.0
name: 矛盾驱动角色生成
description: 在需要创建或深化故事角色时，通过欲望、恐惧和性格矛盾生成可推动剧情的人物草稿
scope: user
skillType: prompt_method
guidanceMode: guided
semanticSelection: suggest
triggerHints:
  - 为故事创建一个具有内在矛盾的新角色
antiTriggerHints:
  - 检查已有角色在多个章节中的设定是否一致
supportedOperations:
  - creative_asset.draft
allowedRoles:
  - writer
  - worldbuilding
recommendedToolchains:
  - creative_asset.draft
outputType: creative_assets_draft
contextNeeds:
  - existing_characters
  - worldsettings
  - active_plotlines
inputs:
  - id: role_function
    label: 角色在故事中的功能
    type: text
    required: true
  - id: genre
    label: 作品类型
    type: text
    required: false
---

## 生成流程

1. 根据角色功能确定该角色对主线的作用。
2. 分别设计一个核心欲望和一个核心恐惧。
3. 欲望与恐惧必须形成可推动剧情的冲突。
4. 设计表层目标和角色不愿承认的隐藏目标。
5. 至少建立一条与现有角色的有效关系。
6. 检查能力、背景和行为是否违反当前世界规则。
7. 不得复制已有角色的核心动机。

## 输出要求

- 姓名
- 故事功能
- 核心欲望
- 核心恐惧
- 表层目标
- 隐藏目标
- 性格矛盾
- 人物关系
- 成长弧线
- 与现有设定的冲突检查
```

解析要求：

- Frontmatter 必须通过固定 Schema 校验。
- Markdown 正文作为低于系统约束的 Skill instructions。
- 未知关键安全字段拒绝导入；普通扩展字段可以保留但不执行。
- Skill ID 冲突时必须让用户选择创建副本或新 Revision，不静默覆盖。
- 导入时重新计算 contentHash，不能信任文件内提供的哈希。

### 14.2 本地 Skill 目录导入与模型转换

目录导入用于兼容遵循 `SKILL.md` 约定、但附带 `references/`、`agents/` 或其他产品无直接 Schema 映射的本地 Skill。用户从 UI 选择目录；Renderer 不得将任意本地路径、目录内容或文件读取权限交给模型。Electron Main 负责规范化并扫描经用户授权的目录根，根目录必须存在 `SKILL.md`。

目录来源的 `SKILL.md` 不要求预先符合本产品的 `schemaVersion` 或完整 Frontmatter Schema：扫描阶段只要求它是可读取的受限文本，Frontmatter 解析失败应记为来源警告并交由转换模型理解。固定 Schema 校验只针对模型输出的 `AgentSkillDraft`；无法形成合法 Draft 时才以转换失败返回，不能把外部 Skill 的格式差异误判为不安全输入。

扫描器只读取下列受限文本资源，形成 `ImportedSkillDirectorySnapshot`：

| 路径 | 用途 | 导入行为 |
| --- | --- | --- |
| `SKILL.md` | 必需的主说明与 Frontmatter | 读取并作为转换主输入 |
| `references/**/*.md` | 按需参考资料 | 读取至目录与总量预算，保留相对路径 |
| `agents/openai.yaml`、`agents/openai.yml` | 可选 UI 元数据 | 读取为转换提示，不能直接覆盖产品字段 |
| `scripts/**`、其他可执行文件 | 外部 Skill 的确定性辅助逻辑 | 仅记录清单和“未执行”原因，不读取、不执行、不转换为权限 |
| 图片、二进制、未知文件 | 资产或非受支持内容 | 仅记录为跳过，不传递内容给模型 |

目录读取规则：

- 目录根、每个候选文件和符号链接的最终路径都必须位于用户选定根目录内；路径穿越、链接逃逸、循环链接或无法解析的路径必须拒绝导入。
- 只读取 UTF-8/可判定文本的允许文件；读取前检查类型、单文件大小、总字节数、文件数量和估算 Token，超限时停止并给出可操作错误，不以截断后仍完整转换的方式掩盖遗漏。
- Snapshot 必须包含根目录显示名、相对路径、SHA-256、大小、读取/跳过状态及原因；不得把绝对本地路径、未读取文件内容或目录读取能力暴露给模型。
- 本地目录内容被视为不可信来源：其中的提示、工具声明、代码片段和外部链接不得改变系统策略、可用 Tool、文件权限、审批规则或 Draft 提交边界。
- 原始内容只在本次转换及用户可见审核所需范围内暂存；持久化来源记录默认只保存 Manifest、哈希、转换报告、遗漏项和用户确认的 Draft，不保存任意完整本地目录副本。

扫描完成后，Runtime 以 `agent.convert_imported_skill` 运行受控转换：向模型提供 Snapshot、当前产品 Capability Catalog、允许的 Operation/Role/Toolchain/输出 Schema，以及声明式 Skill 的固定 Schema。模型负责判断来源 Skill 应转换为一个或多个 `AgentSkillDraft`、是否建议一个 `AgentSkillPackDraft`，并将来源中的工作流、触发边界、约束和参考资料映射到产品的原生能力。

模型转换规则：

- 优先保留来源的任务意图、分步方法、适应性追问方式和显式不适用边界；不能将外部 Skill 的静态问卷、工具调用或执行脚本机械复制为 Prompt。
- 仅可推荐 Capability Catalog 中存在的 Operation、Role 和 Toolchain；缺失能力、可执行代码、外部依赖和无法安全映射的行为必须在 `conversionReport.omissions` 中说明，并给出手动迁移建议。
- 模型可根据来源结构决定拆分/合并，不得把目录中的任意文本自动变成已启用 Skill，也不得直接创建 Revision、Binding 或访问本地文件。转换结果必须先通过现有 Schema、预算、触发边界、权限和污染校验。
- UI 必须展示来源 Manifest、模型的映射理由、生成的 Draft/Pack Draft、跳过文件和遗漏能力；用户可编辑、删除或合并 Draft，只有明确“保存创作技能”后才创建 Revision 和绑定。

建议目录导入预算：最多 40 个可读取文件、总计 256 KiB、单文件 64 KiB、进入模型的目录快照不超过 24,000 估算 Token。实现可以进一步收紧，但不得静默放宽；超预算目录可由用户缩减后重试。

## 15. 输入变量与模板

第一阶段只允许无表达式的标量变量：

```text
{{input.role_function}}
{{input.genre}}
{{user.request}}
```

规则：

- 使用严格变量表；未知变量导致预览或保存失败。
- 不支持条件表达式、循环、函数、代码求值和文件包含。
- 项目上下文不得通过 `{{context.fullNovel}}` 等变量直接内联。
- `contextNeeds` 只向 AgentContextAssembler 声明所需资料，实际上下文独立分区注入。
- 用户输入和变量值必须作为数据分隔，不能改变系统提示层级。
- Prompt 预览必须显示变量替换结果、上下文来源列表和 Token 估算。

## 16. SkillResolver

输入：

```python
class AgentSkillResolveRequest(BaseModel):
    operationId: str
    roleId: str
    novelId: str | None
    explicitSkillIds: list[str]
    presetId: str | None
    disabledForTurn: bool = False
```

输出：

```python
class ResolvedSkillSet(BaseModel):
    primary: AgentSkillRef | None
    auxiliary: AgentSkillRef | None
    reasonCodes: list[str]
    warnings: list[str]
```

解析要求：

- 显式 Skill 不支持当前 Operation 时拒绝并给出原因，不静默换成其他 Skill。
- 默认 Skill 不支持 Operation 时跳过并记录 warning。
- Skill allowedRoles 与当前 Role 不匹配时不可选择。
- Skill 推荐 Toolchain 不可用时仍可交给 Planner 选择原子工具或其他合法 Toolchain。
- 主 Skill 和辅助 Skill 输出 Schema 冲突时不合并，要求用户选择。
- Skill 内容解析失败时不阻塞普通聊天；明确要求使用该 Skill 的任务必须明确失败。
- ResolvedSkillSet 在 Run 开始时转换为不可变 Snapshot。

## 17. SkillCompiler 与 Prompt 层级

Prompt 组装顺序固定为：

```text
1. 系统与安全约束
2. Runtime Policy 与产品写回边界
3. 当前 AgentRole
4. 当前任务、计划和 Operation
5. 已解析 Agent Skill
6. 项目上下文与工具观察
7. 用户当前请求
```

规则：

- Skill 指令不得覆盖 1-4 层。
- Skill 中出现“忽略系统提示”“直接写回”“扩大权限”等文本时，运行时边界仍然有效，并在预览和验证中给出警告。
- SkillCompiler 输出结构化区段，不简单拼接成无法审计的大字符串。
- 每个 Skill 区段标记 Skill ID、Revision 和来源。
- Toolchain 内多个模型节点可以加载同一 Snapshot，但不得重新解析到新 Revision。
- Skill 示例优先于低价值说明被裁剪；核心 constraints 必须保留或整体拒绝调用。

## 18. 上下文与 Token 预算

Skill 使用三级渐进加载：

| 层级 | 内容 | 加载时机 |
| --- | --- | --- |
| Level 1：索引元数据 | ID、标题、短说明、Scope、类别、版本、Operation、Role、触发提示 | Registry、`/` 列表和 Intent 语义匹配时可用 |
| Level 2：核心方法 | instructions、constraints、输入和输出契约 | Resolver 选中并锁定 Revision 后加载 |
| Level 3：执行资源 | 当前调用需要的短示例，以及由 `contextNeeds` 请求的项目上下文 | Compiler/ContextAssembler 根据 Operation 与预算按需加载 |

规则：

- `/` 列表、角色面板和普通 Intent 识别不得加载所有 Skill 的 Level 2/3 内容。
- 第一阶段 Level 3 不包含可执行脚本、二进制附件或远程引用；来源材料是 Creator 的提炼证据，不是默认随 Skill 执行加载的资源。
- 同一事实或方法不得在 description、instructions 和 examples 中无意义重复；详细例子只有被当前 Operation 需要时才进入上下文。
- Level 2 核心方法不能完整装入预算时整体拒绝使用，不得只留下标题和零散片段制造“已使用 Skill”的假象。

默认限制：

- 单个 Skill 导入文件最大 64 KiB。
- instructions 最大 32,000 字符。
- 输入字段最多 20 个。
- 示例最多 10 个。
- 单个 Operation 最多加载 1 个主 Skill 和 1 个辅助 Skill。
- 编译后的 Skill 上下文最多占本次输入预算的 15%，且不超过 12,000 估算 Token。

预算不足时裁剪顺序：

```text
低优先级示例
  -> 冗余解释
  -> 辅助 Skill
  -> 主 Skill 非核心说明
```

以下内容不得静默裁剪：

- 主 Skill 的核心 instructions。
- 安全和写回约束。
- 必填输入定义。
- 输出契约。

仍无法满足预算时，调用前返回 `AGENT_SKILL_BUDGET_EXCEEDED`。

## 19. 用户界面需求

### 19.1 Skill 列表

Agent 右侧 Inspector 增加“创作技能”页。正式页面接入前，现有只读面板使用“角色能力说明”名称：

- 内置、我的、当前小说三个分组。
- 搜索、角色、Operation、启用状态过滤。
- 显示名称、说明、版本、Scope、默认绑定和最近更新时间。
- 清楚区分 Agent Skill 与小说设定中的“技能”。
- 列表标题和说明必须来自 AgentSkill Registry，不在 Renderer 维护第二份 Skill 文案。

### 19.2 Skill 编辑器

用户可编辑：

- 名称和说明。
- 应触发与不应触发的示例。
- 指导自由度：自适应、引导式、严格。
- 语义选择：关闭、仅建议、自动；用户 Skill 默认“仅建议”，自动选择需要正反触发验证通过。
- User/Novel Scope。
- 适用 Operation。
- 允许角色。
- 输入字段。
- 方法步骤和约束。
- 示例。
- 需要的上下文类型。
- 输出类型。
- 推荐 Toolchain。
- 默认绑定。

编辑器必须提供：

- Schema 校验错误。
- Prompt 预览。
- Token 估算。
- 权限说明。
- 保存为新 Revision。
- 使用测试输入试运行。

### 19.3 Skill Picker

输入框附近提供当前 Skill 选择，`/` 是首要快捷入口：

- 自动。
- 不使用 Skill。
- 最近使用。
- 当前 Role 可用 Skill。
- 搜索所有兼容 Skill。

显式选择后，输入区显示 Skill 名称和版本；发送前用户可以移除。

### 19.4 `/` 快捷面板

用户在输入框开头或空白字符后输入 `/` 时打开统一命令面板。URL、路径和普通句子中间的 `/` 不触发。面板支持继续输入关键词搜索、方向键移动、Enter 选择、Esc 关闭。

面板固定分组：

```text
系统动作
  创建创作技能
  更新已选创作技能
  管理创作技能
  本次不使用创作技能
  新建小说

内置创作技能
  ...来自 Built-in Registry

我的创作技能
  ...User Scope 且 enabled 的 Skill / Pack

当前小说创作技能
  ...当前 novelId 的 Novel Scope 且 enabled 的 Skill / Pack
```

展示规则：

- 每项显示类型图标、本地化标题、单行说明、Scope、版本；Pack 使用独立类型标识并显示成员数量，用户和小说条目可显示最近更新时间。
- 默认先显示最近使用与当前 Role 可用项，再显示其余可见 Skill；搜索匹配标题、说明和 stableId。
- 当前 Operation 尚未确定时不按 Operation 隐藏 Skill；发送后仍由 SkillResolver 做最终兼容性校验。
- 已禁用或归档 Skill 不进入默认列表；通过管理页可查看。
- Built-in、User、Novel 数据都来自合并 Registry，不在 Renderer 写死第二份列表。
- 数量较多时使用虚拟列表和分组计数，不因 Skill 数量阻塞输入。

首期稳定命令语义：

```text
/skill list
/skill create
/skill update <stableId>
/skill use <stableId>
/skill pack use <stableId>
/skill none
/novel new
```

这些字符串只用于键盘输入、粘贴和自动化兼容。用户从面板选择后，Renderer 必须立即转换为结构化 Composer Entry Hint，并在输入区显示可移除芯片，不把命令字符串留给模型自行解释：

```ts
type SkillComposerEntryHint =
  | { kind: 'skill.use'; skillId: string; requestedRevisionId?: string; source: 'slash' }
  | { kind: 'skill.pack.use'; packId: string; requestedRevisionId?: string; source: 'slash' }
  | { kind: 'skill.author'; action: 'create' | 'update'; targetSkillId?: string; creatorProfile?: string; source: 'slash' }
  | { kind: 'skill.none'; source: 'slash' }
  | { kind: 'skill.manager'; source: 'slash' }
  | { kind: 'novel.bootstrap'; source: 'slash' }
```

`/skill list` 打开同一个面板或创作技能管理页；不得把完整 Skill 正文插入输入框。自然语言“帮我创建一个文风 Skill”和 `/skill create` 进入同一个 Authoring 流程，后者只是减少 IntentService 歧义。

### 19.5 Skill Creator 与 Draft 审核

Skill Creator 首屏允许：

- 直接描述要创建或修改的能力。
- 选择 Creator Profile。
- 添加当前对话、当前小说、章节范围、附件或本地文档作为来源。
- 显示全局外部研究能力与 provider 的可用状态；能力启用后，Creator 自动使用 Web Search，不要求用户逐条选择结果或逐次确认。

Creator 先以对话方式确认用途、至少一个正向使用样例、容易混淆的不适用场景和期望产物。信息已经能从请求或来源可靠推断时直接填入 Draft，不重复追问；需要追问时一次只提出最影响结果的问题。Creator 同时推荐指导自由度，并用“自适应 / 引导式 / 严格”的产品语言解释影响。

一次生成多个 Draft 时先展示拆分建议，用户可以删除、合并、改名或调整适用 Operation，再进入逐项预览。Skill Pack Draft 单独展示各 Operation 的主/辅助绑定，不展示为一段合并 Prompt。

Draft 审核至少展示：名称、用途、正向/反向触发样例、指导自由度、来源覆盖、置信度、适用 Role/Operation、方法步骤、约束、禁止事项、输出要求、Token 估算、污染警告和试运行结果。只有“保存创作技能”动作可以提交正式 Revision。

### 19.6 试运行

- 默认使用模拟或当前已选上下文。
- 明确展示将读取哪些项目资料。
- 副作用 Skill 试运行只生成预览或 DraftSession，不直接写回。
- 显示最终编译 Prompt 的结构化区段，但脱敏敏感配置。
- 试运行结果可以保存为新 Skill Revision 的验证记录，第一阶段不要求持久化完整模型输出。
- 来源提炼型 Skill 优先使用未参与提炼的留出样本或中性任务；不得仅用提炼时的相同段落证明 Skill 有效。
- A/B 或人工盲测只向评审者展示完成判断所需的原始请求和输出，不泄露 Creator 的预期结论、诊断或标准答案。
- 正向样例应验证能触发并产生预期方法，反向样例应验证不会被语义选择误触发。
- 无法取得独立样本时明确标记“仅完成结构验证，尚未验证泛化”，不伪造通过状态。

## 20. API 与通信要求

Renderer 不直接访问数据库或本地 Skill 文件。

建议 Electron IPC：

| API | 用途 |
| --- | --- |
| `db:get-agent-skills` | 读取 User/Novel Skill 摘要与绑定 |
| `db:get-agent-skill` | 读取指定 Revision |
| `db:create-agent-skill` | 创建用户 Skill |
| `db:update-agent-skill` | 创建新 Revision |
| `db:set-agent-skill-enabled` | 启停 Skill |
| `db:archive-agent-skill` | 归档 Skill |
| `db:import-agent-skill` | 由用户授权选择单文件或本地目录；Main 校验、扫描并创建可审核的导入 Draft |
| `db:export-agent-skill` | 导出指定 Revision |
| `db:get-agent-skill-drafts` | 读取可恢复的创建/更新草稿 |
| `db:upsert-agent-skill-draft` | 保存 Draft 和 Derivation Report，不创建正式 Revision |
| `db:commit-agent-skill-draft` | 乐观并发校验后创建 Definition/Revision |
| `db:discard-agent-skill-draft` | 丢弃或归档 Draft |
| `db:get-agent-skill-packs` | 读取可见 Pack 摘要和当前 Revision |
| `db:commit-agent-skill-pack-draft` | 提交 Pack Revision 与 Operation 绑定 |

建议 Runtime API：

| API | 用途 |
| --- | --- |
| `agent.skills` | 返回合并后的可见 Skill 摘要 |
| `agent.skill.resolve` | 调试或 UI 预览解析结果；正常 Run 内部直接调用 Resolver |
| `agent.skill.preview` | 编译 Skill Prompt 区段并返回诊断 |
| `agent.skill.author` | 启动或继续自然语言 Authoring 流程，返回 Skill Draft/Pack Draft |
| `agent.convert_imported_skill` | 将受控本地目录 Snapshot 和产品能力目录转换为一个或多个可审核 Skill Draft/Pack Draft |
| `agent.skill.validate_draft` | 运行 Schema、预算、安全、污染、触发边界、内容精简和可执行性检查 |
| `agent.skill.test_draft` | 使用模拟或选定上下文试运行，不提交 Revision |
| `agent.skill.pack.resolve` | 调试或预览 Pack 在当前 Operation 下的主/辅助 Skill |

Runtime 获取用户 Skill 时通过 Electron Automation 只读能力：

- `agent_skill.list`
- `agent_skill.get`
- `agent_skill.draft.get`
- `agent_skill.draft.upsert`
- `agent_skill.draft.commit`
- `agent_skill.pack.list`
- `agent_skill.pack.get`

这些能力不得暴露为模型可自由调用的普通创作 Tool。写能力只允许 Authoring Toolchain 在用户确认、draftId 和乐观并发版本校验后调用。

## 21. IntentService 契约调整

IntentDecision 增加用户请求的 Skill 引用：

```python
class IntentSkillRequest(BaseModel):
    skillId: str
    requestedVersion: str | None = None
    selectionSource: Literal["explicit", "shortcut", "preset", "semantic"]


class IntentSkillPackRequest(BaseModel):
    packId: str
    requestedRevisionId: str | None = None
    selectionSource: Literal["explicit", "shortcut", "preset", "semantic"]


class IntentDecision(BaseModel):
    # existing fields...
    requestedSkills: list[IntentSkillRequest] = Field(default_factory=list)
    requestedSkillPack: IntentSkillPackRequest | None = None
    skillAuthoring: AgentSkillAuthoringRequest | None = None
```

规则：

- IntentService 只提取显式或语义 Skill 引用，不决定最终 Revision。
- 用户在 UI 选择的 Skill 以结构化 entryHint 传入，优先于文本识别。
- 文本名称匹配多个 Skill 时必须澄清，不按标题随机选择。
- Skill 名称不存在时明确提示，不把它当作普通自然语言要求静默忽略。
- 默认 Skill 不进入 requestedSkills，由 SkillResolver 根据 Binding 解析。
- 自然语言中的“创建、保存为、提炼、拆分、组合、更新 Skill”解析为 `skillAuthoring`，不伪装成普通 Skill 使用请求。
- `/` 面板产生的结构化 Entry Hint 优先于文本语义；选择 `skill.use` 时产生 requestedSkills，选择 `skill.pack.use` 时产生 requestedSkillPack，选择 `skill.author` 时产生 skillAuthoring。
- 单次请求最多显式选择一个 Pack；PackResolver 将其展开为锁定的主、辅助 Revision 后再与 requestedSkills、默认 Binding 一起执行普通冲突与兼容性校验。
- `/skill list` 和 `skill.manager` 是 Renderer 导航动作，不调用模型、不生成 Plan。
- `skill.none` 只设置本轮 `disabledForTurn=true`，不改变默认 Binding。
- `novel.bootstrap` 路由到内置新建小说方案，不进入 Skill Authoring。
- 创建和更新请求可以先执行受控只读来源发现；保存 Definition/Revision 始终需要用户确认 Draft。

## 22. Planner 与计划契约调整

计划步骤增加 Skill 引用：

```python
class AgentPlanStep(BaseModel):
    # existing fields...
    skills: list[AgentSkillRef] = Field(default_factory=list)
```

要求：

- Planner 只能引用 ResolvedSkillSet 中的 SkillRef。
- Planner 不能修改 Revision、contentHash 或 selectionSource。
- 一个步骤最多携带主 Skill 和辅助 Skill 各一个。
- 用户修改计划时可以移除或替换 Skill，但必须重新经过 SkillResolver。
- 计划卡展示 Skill 名称、版本、来源和作用，不展示整段 Skill 正文。
- 批准计划锁定 Skill Snapshot；批准后修改 Skill 不影响当前 Run。

## 23. Toolchain 契约调整

Toolchain Definition 可声明 Skill 支持策略：

```python
class ToolchainDefinition(BaseModel):
    # existing fields...
    acceptsAgentSkills: bool = True
    maxAgentSkills: int = 2
```

要求：

- Toolchain 通过步骤的 Skill Snapshot 获取内容，不按名称重新查询 latest。
- `acceptsAgentSkills=false` 时 Planner 不得为该步骤绑定 Skill。
- Toolchain 可以校验 Skill outputType 与自身产物是否兼容。
- Skill recommendedToolchains 只是路由提示，不能强制 Runtime 执行。
- Skill requiredCapabilities 不满足时，Toolchain 启动前失败并返回结构化原因。

## 24. 权限与安全

用户自定义 Skill 被视为不可信 Prompt 数据：

- 不能授予 Tool、Toolchain、MCP、网络或文件权限。
- 不能修改 `approvalMode`。
- 不能直接提交 DraftSession。
- 不能要求 Python Runtime 或 Electron 执行代码。
- 不能读取未由 AgentContextAssembler 提供的数据。
- 不能访问 AI Settings、API Key、Token 或本地敏感路径。
- 不能将 Tool 输出自动发送到外部服务。
- 导入内容不得自动下载图片、链接或依赖包。
- Skill Creator 读取的网页、本地文档、附件和小说正文均按不可信数据隔离；其中出现的工具或系统指令只作为被分析文本。
- Web Search 必须记录查询、公开来源 URL、覆盖范围和证据等级；不得自动绕过付费墙或下载来源不明的完整作品。
- 模型已有知识只能形成 `model_prior` 来源和低置信度候选，不能伪造引用或声称读取过正文。
- Skill Draft 和 Pack Draft 不能授予其成员 Skill 新权限；Creator Toolchain 的临时读取能力不继承到创建结果。
- 保存前运行专有内容污染检查，发现人物名、地名、标志性原句、剧情复制或过长连续文本时要求修订或明确阻止提交。

静态验证只用于发现明显越界指令，不能作为唯一安全机制。即使 Skill 正文包含恶意或冲突指令，Runtime Policy、Tool 白名单、Toolchain Definition 和 DraftSession 审批仍必须独立生效。

## 25. 生命周期与版本

### 创建

- 用户可以通过自然语言、`/skill create`、快捷面板、结构化编辑器或导入文件发起创建。
- Creator 先生成持久化 AgentSkillDraft；保存前完成 Schema、变量、预算、安全、来源覆盖和污染检查。
- 用户确认 Draft 后才创建 Skill Definition 和第一个 Revision。

### 编辑

- 自然语言或 `/skill update` 先生成指向目标 Skill 的更新 Draft，不修改旧 Revision。
- 保存时创建新 Revision 并更新 currentRevisionId。
- 如果内容未变化，不创建重复 Revision。

### 使用反馈与迭代

- 用户可以从使用该 Skill 的 Run 或 Artifact 发起“改进此创作技能”，系统携带原 SkillRef、用户明确反馈和经授权选择的输入/输出样本进入更新 Draft。
- 反馈只用于提出新 Draft，不原地修改旧 Revision，不改变正在运行或历史 Run 的 Snapshot。
- 默认不把完整小说内容、模型输出或用户行为自动收集为训练/改进材料；纳入 Draft 来源前必须由用户选择范围。
- Creator 应区分 Skill 方法问题、输入资料不足、模型随机性和 Toolchain 故障，不能把所有失败都归因于 Skill 正文。
- 更新后重复独立试运行；仅在看过预期答案或原始诊断时才能通过的 Skill 视为验证失败。

### 拆分与组合

- 拆分产生多个独立 Skill Draft，用户可以逐项确认；原 Skill 不自动归档。
- 组合默认产生 Skill Pack Draft，而不是把所有成员正文合并为 composite Skill。
- Pack 提交时锁定成员 Skill ID 与所选 Revision；后续成员更新不改变旧 Pack Revision。

### 启停

- 停用只影响新解析。
- 活跃 Run 继续使用锁定 Snapshot。

### 归档

- 归档后不参与新解析。
- 历史 Run 和 Artifact 仍可读取引用摘要。
- 解除所有默认 Binding，但不删除 Revision。

### 恢复

- 可恢复归档 Skill并选择是否恢复原 Binding。
- 恢复不会改变旧 Revision。

### 导入

- 校验 Schema、变量、大小和 ID 冲突。
- 用户确认 Scope 和绑定后才写入数据库。

### 导出

- 导出指定 Revision，不默认导出全部历史。
- 不包含 API Key、模型配置、运行历史或小说正文。

## 26. 运行、恢复与审计

每次 Skill 解析和加载至少记录：

- Skill ID。
- Revision ID 和版本。
- contentHash。
- Scope。
- selectionSource。
- Operation ID。
- 主 Skill 或辅助 Skill。
- 编译后的 Token 估算。
- warning 和降级原因。

建议事件：

| 事件 | 用途 |
| --- | --- |
| `skill_resolved` | 记录本次选择结果和来源 |
| `skill_loaded` | 记录具体 Revision 和内容哈希 |
| `skill_skipped` | 记录禁用、不兼容、预算或冲突原因 |

事件中不持久化完整 Skill 正文。完整 Snapshot 保存于 Run checkpoint 或受控 metadata，Artifact 记录 SkillRef。

恢复要求：

- Run 恢复使用原 Snapshot，不重新解析 default/latest。
- 原 Skill 被停用或归档不影响已批准 Run。
- Snapshot 缺失或哈希不一致时 fail closed，不静默换成最新版。
- 修改计划并重新批准时生成新的 Skill Snapshot。

## 27. 错误码

至少定义：

- `AGENT_SKILL_NOT_FOUND`
- `AGENT_SKILL_REVISION_NOT_FOUND`
- `AGENT_SKILL_INVALID_MANIFEST`
- `AGENT_SKILL_INVALID_VARIABLE`
- `AGENT_SKILL_ID_CONFLICT`
- `AGENT_SKILL_SCOPE_MISMATCH`
- `AGENT_SKILL_ROLE_NOT_ALLOWED`
- `AGENT_SKILL_OPERATION_NOT_SUPPORTED`
- `AGENT_SKILL_CAPABILITY_MISSING`
- `AGENT_SKILL_OUTPUT_INCOMPATIBLE`
- `AGENT_SKILL_CONFLICT`
- `AGENT_SKILL_BUDGET_EXCEEDED`
- `AGENT_SKILL_CONTENT_HASH_MISMATCH`
- `AGENT_SKILL_ARCHIVED`
- `AGENT_SKILL_IMPORT_REJECTED`
- `AGENT_SKILL_IMPORT_ROOT_SKILL_MISSING`
- `AGENT_SKILL_IMPORT_UNSAFE_PATH`
- `AGENT_SKILL_IMPORT_UNSUPPORTED_FILE`
- `AGENT_SKILL_IMPORT_READ_BUDGET_EXCEEDED`
- `AGENT_SKILL_IMPORT_CONVERSION_INVALID`
- `AGENT_SKILL_DRAFT_NOT_FOUND`
- `AGENT_SKILL_DRAFT_STALE`
- `AGENT_SKILL_SOURCE_UNAVAILABLE`
- `AGENT_SKILL_SOURCE_PERMISSION_REQUIRED`
- `AGENT_SKILL_SOURCE_COVERAGE_INSUFFICIENT`
- `AGENT_SKILL_SOURCE_CONTAMINATION`
- `AGENT_SKILL_PACK_CONFLICT`
- `AGENT_SKILL_PACK_MEMBER_UNAVAILABLE`

错误必须包含用户可读说明、Skill ID、失败阶段和可执行的修复建议，不回显密钥或完整敏感上下文。

## 28. 测试要求

### Registry 与持久化

- Built-in、User 和 Novel Skill 正确合并。
- Scope 隔离和同名不同 ID 正确处理。
- Revision 不可变和乐观并发更新。
- 归档、恢复、启停和 Binding 清理。
- 应用重启后 User/Novel Skill 可恢复。

### 导入与验证

- 合法单文件 `SKILL.md` 导入。
- 含根目录 `SKILL.md` 和 `references/**/*.md` 的合法本地目录能生成可审核 Draft；模型能根据来源结构产生多个 Draft 和可选 Pack Draft。
- 缺少根目录 `SKILL.md`、路径穿越、符号链接逃逸/循环、非文本或不受支持文件、未知 schemaVersion、非法 Frontmatter 和超预算目录拒绝，并返回对应结构化错误。
- `scripts/**` 不读取、不执行，且在 Manifest 与转换报告中明确为跳过；目录中的 Prompt 注入、工具声明和远程依赖不能扩大权限或直接写入 Revision。
- Snapshot 不含绝对路径，Manifest 的哈希、大小、读取状态和跳过原因可供审核与审计；导入后重新计算 Draft/Revision 的 contentHash。
- 未知变量、代码字段、远程依赖和 ID 冲突处理；模型无法映射的能力必须产生可见 omissions，而非伪装为已支持功能。

### Creator 与来源

- 自然语言创建、更新、拆分和组合正确生成 AuthoringRequest。
- `/skill create` 与等价自然语言进入同一 Authoring Toolchain。
- 当前对话、当前小说、附件、本地文档、Web 和 model_prior 来源优先级正确。
- 没有正文样本时语言风格结论降级，公开评论仍可用于叙事机制候选。
- 来源正文中的 Prompt 注入不能改变权限、Toolchain 或 Draft 提交边界。
- 专有名词、标志性原句、剧情复制和过长连续文本污染检查。
- Draft 保存、应用重启恢复、乐观并发提交和丢弃。
- 一次请求生成多个 Skill Draft 和可选 Pack Draft。
- 已有描述足够时不重复追问；信息不足时以最少问题获得用途、正向样例、反向边界和期望产物。
- Creator 能正确建议 adaptive、guided、strict，并验证该字段不改变权限与审批。
- semanticSelection 的 off/suggest/auto 行为正确；User/Novel 默认 suggest，auto 缺少反例或 triggerStatus 未通过时拒绝保存该配置。
- 通用常识、重复段落、创建过程说明和无执行价值内容被质量检查发现。
- stableId 规范化、64 字符限制、标题更新不改 stableId 和冲突处理。

### `/` 快捷入口

- 仅在输入框开头或空白边界触发，不误触 URL 和路径。
- 分组列出系统动作、Built-in、User 和当前 Novel Skill；同 Scope 的 Pack 以独立类型标识列在对应分组。
- 搜索、键盘导航、Esc、虚拟列表和最近使用排序。
- 选择 Skill 或 Pack 后生成对应的结构化 Entry Hint 与可移除芯片，不把命令正文交给模型解释。
- `/skill list` 不调用模型，`/skill none` 只影响本轮。
- 禁用、归档、Scope 不可见和重名 Skill 的展示与错误处理。

### Resolver

- 显式、Preset、Novel、User、Role、Built-in 优先级。
- 当前小说 Scope 隔离。
- Operation、Role、输出类型和 Toolchain 兼容性。
- 主/辅助 Skill 冲突。
- “本次不使用 Skill”。

### Compiler 与上下文

- 变量严格替换和未知变量失败。
- Skill Prompt 层级低于系统和 Runtime Policy。
- contextNeeds 通过 AgentContextAssembler 装配。
- Token 预算、裁剪顺序和核心约束保留。
- Prompt 注入文本不能改变工具权限或写回边界。
- Registry 与 `/` 列表只加载 Level 1；Resolver 后才加载 Level 2；Level 3 示例和项目上下文按当前调用需要装配。
- description、instructions 和 examples 的重复内容不会被无意义地多次注入。

### 独立验证与迭代

- 正向触发样例、反向触发样例和 Operation 兼容性分别验证。
- 来源提炼使用留出样本或中性请求验证，不复用相同来源段落自证。
- 盲测输入不携带预期答案、Creator 诊断或意图修复说明。
- 无独立样本时只报告结构验证，不能标记泛化通过。
- 从 Run/Artifact 发起改进只创建更新 Draft；旧 Run、旧 Revision 和来源授权边界保持不变。

### Run 集成

- Planner 步骤携带合法 SkillRef。
- Toolchain 使用锁定 Snapshot，不重新读取 latest。
- DraftSession 和 Artifact 记录 SkillRef。
- 暂停、恢复、Runtime 重启后仍使用相同 Revision。
- Skill 更新、停用或归档不改变活跃 Run。
- 缺失 Snapshot 和哈希不匹配时明确失败。

## 29. 分阶段交付

### 29.0 当前实现快照（2026-08-04）

- 已完成 AS-0 基础纵切，并新增 `builtin.novel-bootstrap@1.0.0` 与 `builtin.style-skill-extractor@1.0.0`。新建小说复用现有推荐式问答卡；文风提炼固定拆分语言风格、悬念与信息释放，以及证据充分时的群像推进。
- 已建立 `AgentSkill`、不可变 `AgentSkillRevision`、`AgentSkillBinding`、`AgentSkillDraft`、`AgentSkillPack` 与不可变 `AgentSkillPackRevision` 持久化。Draft 更新使用版本乐观锁，提交要求显式 `confirmed=true`，内容生成 SHA-256 哈希。
- 已实现 `agent.skill.author`：`/` 面板的“创建 Skill”接受自然语言描述，模型返回结构化候选后只保存 `ready_for_review` Draft，不直接创建 Revision。
- “文风 Skill 提炼”完成后会同时生成可阅读 Artifact 与可恢复 Pack Draft；产物面板提供“确认发布 / 放弃草稿”。确认发布在单一事务中创建 2–3 个成员 Skill Revision、Pack Revision 和 Operation/Role 主辅助绑定，任一步失败均不留下部分结果。
- `agent.skills` 已合并 Built-in、User 与当前 Novel Skill；已发布 Pack Binding 参与 Resolver，并在 Plan/Run 中锁定成员 Revision 与 contentHash。
- 尚未完成：通用 Draft 字段编辑器、Prompt 预览与 A/B 试运行、更新既有 Skill 的完整 UI、附件/本地 TXT/Web Search Source Resolver、SKILL.md 导入导出。

### Phase AS-0：内置 Skill 基础

AS-0 按纵切交付，不并行铺开完整用户编辑器。

#### AS-0a：契约清理

- 删除旧 OpenClaw Skill manifest、invoke、IPC、preload 和诊断分支；OpenClaw MCP 兼容路径继续保留。
- 冻结 Role、Operation、Preset、Agent Skill、Toolchain 和 Tool 的分类边界。
- Skill 兼容性只引用 `INTENT_OPERATION_REGISTRY` 中真实存在的 Operation ID。
- UI 统一“创作技能”命名，现有未接入执行链的面板称为“角色能力说明”。

#### AS-0b：首个可执行纵切

- 首个内置 Skill 固定为 `builtin.continuity-review@1.0.0`。
- 首期只支持 `chapter.consistency_review` Operation，并接入现有 `chapter.consistency_review@1.0.0` Toolchain。
- 建立最小 AgentSkill Schema、Built-in Registry、Resolver、Compiler 和验证器。
- 将编辑角色相关展示字符串迁移为稳定 `defaultSkillIds`，Renderer 从 Registry 读取标题和说明。
- `IntentDecision -> SkillResolver -> AgentPlanStep.skills -> Run Snapshot -> Toolchain 模型节点 -> Artifact` 使用同一个 SkillRef。
- 输入区通过 `/` 面板提供“自动 / 不使用创作技能 / 显式选择连续性审查”状态；面板从 Registry 列出内置 Skill，计划卡展示版本和选择来源。
- 实现按需 Prompt 注入、Token 预算、contentHash 和恢复时哈希校验。

AS-0b 完成标准：相同章节一致性任务在选用和禁用 Skill 时可观察到明确、可测试的 Prompt 区段差异；Run 恢复仍使用原 Revision；Skill 不改变工具和审批权限。

#### AS-0c：扩充内置 Skill

- 在首个纵切稳定后再增加角色生成、节奏诊断和读者盲测。
- 新 Skill 必须绑定现有 Operation；若语义确实无法复用，再单独扩展 Operation Registry。

### Phase AS-1：用户自定义 Skill

- 建立 AgentSkill、Revision、Binding 持久化。
- 建立 AgentSkillDraft、Derivation Report、Skill Pack 与 Pack Revision 持久化。
- 实现通用 `builtin.skill-creator` 和受控 `agent_skill.authoring@1.0.0` Toolchain。
- 先支持从自然语言、当前对话创建和更新 User Scope Skill，再支持当前小说、附件与本地文档来源。
- 实现 `/` 快捷面板，分组列出 Built-in、User 和当前 Novel Skill，并支持 Creator/Manager/New Novel 系统动作。
- 实现 Skill Picker、Creator、Draft 审核、编辑器、Prompt 预览和试运行。
- 实现触发正反例、指导自由度、三级渐进加载、内容精简检查和独立试运行状态。
- 支持单文件 `SKILL.md` 交换格式的导入导出，以及由 Main 受控读取本地 Skill 目录、模型转换为审核 Draft 的导入流程。
- 完成“把当前要求保存为 Skill”和“根据本地作品提炼多个 Skill 并创建 Pack”的端到端验收。

#### AS-1b：外部来源提炼

- **状态：延期。** 当前实现不提供真实互联网检索；`search.query` 继续只检索当前小说，所有现有考据链保持 `externalSearchAvailable=false`。
- 恢复时接入独立 `web.search` / `web.fetch`，不复用项目内 `search.query`。
- 首版 provider 固定为桌面端直连 `ddgs`：无需 API Key、Docker、本地服务、自托管 SearXNG 或自建 Gateway。`ddgs` 是 DuckDuckGo 公开搜索结果的非官方封装，必须按不稳定的 best-effort 搜索处理，不能称为官方 API 或承诺召回率。
- 外部研究能力启用后，模型自行生成 2-4 条查询、每条最多 5 个搜索结果，并自行选择公开 URL 进入 `web.fetch`；不要求用户逐条选择搜索结果或逐次确认。全局能力关闭时，Toolchain 直接跳过外部研究并说明资料不足。
- `web.fetch` 只读取公开、无需登录的页面，先执行 URL/重定向安全校验和正文清洗；不得绕过付费墙、验证码或站点限流，不得下载来源不明的完整作品。
- 搜索或抓取遇到限流、超时、空结果或来源不足时，保留已有真实证据并降级为低置信度或 `model_prior`，不得伪造来源；首期不做代理轮换或其他规避限制的行为。
- 作品名称只有模型先验时输出低置信度候选；只有公开分析而无正文样本时不生成高置信度语言风格结论。
- 保存 Web 来源、查询、覆盖度和降级原因，不保存网页或作品全文。

恢复实施顺序：

1. 在 Electron AI 设置中增加全局外部研究启用状态；启用后向 Runtime 宣告外部能力可用，具体默认状态随产品发布策略确定。
2. 在 Python manifest、白名单和 Runtime 参数归一化中登记只读 `web.search` / `web.fetch`；它们与 `search.query` 使用不同 schema、审计 source type 和错误码。
3. 在 Electron capability 层实现 `ddgs` 查询适配器，返回有界的标题、URL、摘要和排序位置；不把 provider 选择或网络凭据交给模型。
4. 在同一 capability 层实现公开 URL 的抓取、重定向/私网校验和 Readability 正文提取；只把有界、消毒后的证据片段回传 Toolchain。
5. 为 `style_from_work` 新增 `external_web` source mode：模型自动执行“查询 -> 筛选 -> 抓取 -> 证据包 -> Skill Draft”，最终 Draft 发布仍走现有确认流程。
6. 补充 provider 限流、超时、空结果、恶意 URL、提示注入、版权污染、来源审计和 `externalSearchAvailable` 开关的自动化测试；通过后再将该能力从延期项移入产品验收。

### Phase AS-2：小说级 Skill

- 支持 Novel Scope、小说默认绑定和备份恢复。
- 支持当前小说专属术语、世界观和创作方法。
- 增加作用域冲突、复制为 User Skill 和跨小说迁移。
- 接入内置 `builtin.novel-bootstrap` 创作方案，使 `/novel new` 可以选择 Skill Pack 创建草稿小说、人物、世界观、情节线和章节拍。

### Phase AS-3：后续评估

- Skill 分发包和来源签名；“分发包”是导入导出格式，不等同于运行时 Skill Pack。
- 可选团队 Scope。
- 可执行 composite Skill；普通 Skill Pack 已在 AS-1 交付。
- 市场、评分和在线更新。

AS-3 不进入当前 Agent Phase 2 的交付承诺。

## 30. 自然语言 Skill Creator 验收场景

用户输入 `/`，面板同时显示系统动作、内置 Skill 和用户已创建 Skill。用户选择“创建创作技能”，输入：

> 根据《示例作品》创建一套文风创作技能。

执行链：

1. Renderer 将 `/skill create` 转换为 `skill.author` Entry Hint，并保留后续自然语言为 userRequest。
2. IntentService 输出 `skillAuthoring.action=create`、`creatorProfile=style_from_work` 和作品名称 source hint。
3. Source Resolver 先查当前小说、附件和本地文档；没有正文样本且全局外部研究能力可用时，自动检索公开资料；能力不可用时仅基于已有知识生成低置信度候选，并说明资料不足。
4. 外部研究启用时，Toolchain 自动记录查询、公开 URL、资料类型和覆盖度；不得下载来源不明的完整作品。
5. Creator 根据证据提出三个 Draft：语言风格、悬念与信息释放、群像人物推进，并提出一个 Pack Draft。
6. 没有正文样本时，语言风格 Draft 标记低置信度；公开评论支持的叙事机制可以标记中等置信度。
7. 污染检查移除人物名、专有名词、剧情复制、标志性原句和过长连续文本。
8. 用户在 Draft 审核页修改名称、正反触发样例、指导自由度、规则、Operation 和 Pack 绑定，并使用未参与提炼的中性文本执行 A/B 试运行。
9. 用户确认后，Electron Main 创建三个 Skill Definition/Revision 和一个 Pack Revision。
10. 返回会话后再次输入 `/`，新建的 User Scope Skill 和 Pack 出现在“我的创作技能”分组；选择 Skill 或 Pack 后输入区显示对应的结构化芯片。

通过标准：

- 自然语言与 `/skill create` 复用同一 Authoring 流程。
- 资料不足时明确降级，不伪造正文访问和来源。
- Creator 的 Web/File 读取能力不继承到生成的 Skill。
- 未确认 Draft 不创建正式 Revision。
- Pack 按 Operation 解析成员，不突破单次主/辅助 Skill 限制。
- 应用重启后 Draft、正式 Skill、Pack 和来源摘要可恢复。
- `/` 列表只读取 Skill 索引元数据；未选中的 Skill 正文和示例不进入上下文。
- 试运行未泄露提炼结论或复用相同原文片段；没有独立样本时明确显示未完成泛化验证。

## 31. 用户自定义角色生成 Skill 验收场景

用户创建“矛盾驱动角色生成”Skill：

1. 在 Agent Skill 编辑器选择 User Scope。
2. 绑定 `creative_asset.draft` Operation，并将目标素材限定为 `targetSections=["characters"]`。
3. 填写角色生成步骤、必填输入和输出要求。
4. 保存为 `1.0.0` Revision。
5. 在 Agent 输入框显式选择该 Skill。
6. 输入“为主角创建一个前期盟友、后期对手”。
7. IntentService 识别角色草稿 Operation 和显式 SkillRef。
8. SkillResolver 锁定指定 Revision。
9. Planner 生成可审核计划。
10. 用户批准后，Toolchain 读取现有角色、世界观和情节线。
11. 模型按照 Skill 方法生成角色草稿。
12. Toolchain 检查同名和设定冲突。
13. 结果进入 DraftSession，用户确认后才入库。
14. AgentArtifact 记录 Skill ID、Revision、哈希和选择来源。

通过标准：

- 使用的是用户保存的具体 Revision。
- 未读取未声明的项目资料。
- Skill 无法扩大 Tool 权限。
- Skill 中即使包含“直接保存”文字也不会绕过 DraftSession。
- 修改 Skill 后新 Run 使用新 Revision，旧 Run 仍可解释。
- 应用重启后 Skill、Revision 和默认绑定保持一致。
- 禁用 Skill 后不再自动选择，但显式选择时给出明确不可用提示。

## 32. 首期产品验收标准

AS-0 与 AS-1 完成时必须满足：

1. 用户能通过自然语言、`/` 快捷入口和结构化编辑器创建、预览、试运行和版本化一个声明式 Agent Skill。
2. Skill 可以绑定 Operation、Role 和 User 默认规则。
3. IntentService 能传递显式 Skill 请求，SkillResolver 能形成稳定 Snapshot。
4. Planner 和 Toolchain 使用相同 SkillRef，不存在 latest 漂移。
5. Skill 正文按需进入上下文，不随所有 Role 常驻加载。
6. 用户 Skill 不增加工具权限、不执行代码、不绕过审批。
7. 所有创建和更新先形成可恢复 AgentSkillDraft，用户确认后才提交正式 Revision。
8. Creator 能从当前对话、本地文档和当前小说生成一个或多个 Skill Draft，并可选创建 Skill Pack。
9. `/` 面板从合并 Registry 分组列出 Built-in、User 和当前 Novel Skill，选择结果使用结构化 Entry Hint。
10. 来源不足、Web Search、model_prior 和内容污染都有明确诊断，不伪造证据。
11. 角色生成 Skill 能产生真实 DraftSession，并由用户确认写回。
12. Run、Artifact 和恢复链路保留 Revision 与 contentHash。
13. 导入非法、超预算或不安全的 `SKILL.md`/本地 Skill 目录时给出结构化错误；目录导入只能生成经过模型转换、用户审核的 Draft。
14. Python 测试、TypeScript 类型检查、Renderer 构建和现有 Agent 回归测试通过。
15. Skill 定义包含明确的触发边界、指导自由度和语义选择模式；Creator 能以最少追问生成并验证这些字段，User/Novel Skill 默认只建议而不自动套用。
16. Skill 使用三级渐进加载，真实使用反馈只能产生新的更新 Draft 和不可变 Revision。

## 33. 默认设计决策

- 产品名称使用“Agent Skill”或“创作技能”，避免与小说技能混淆。
- `/` 是会话输入框的统一快捷入口，面板必须列出系统动作、内置 Skill、用户 Skill 和当前小说 Skill；选择结果结构化，不依赖模型解析命令字符串。
- 自然语言创建、`/skill create` 和 Creator 快捷按钮复用同一个 `agent_skill.authoring` 流程。
- Creator 以具体使用样例和反例定义触发边界，并按任务脆弱度选择 adaptive、guided 或 strict；已有信息足够时不重复追问。User/Novel Skill 的语义选择默认 suggest，只有正反触发验证通过才允许 auto。
- Skill 上下文采用索引元数据、核心方法和执行资源三级渐进加载；目录导入可受控读取 `SKILL.md`、Markdown references 和可选 UI 元数据，但第一阶段不执行 Skill 脚本、不读取二进制附件或远程运行时引用。
- 来源提炼型 Skill 使用留出样本或中性任务独立验证；使用反馈只产生新 Draft/Revision，不修改历史行为。
- `builtin.skill-creator` 是创建方法；Source Resolver 和 Authoring Toolchain 才能按授权读取当前小说、附件、本地文档或 Web。
- 所有创建、更新、拆分和组合先生成 Draft，用户确认后才创建不可变 Revision。
- Skill Pack 是按 Operation/Role 的主辅助绑定集合，不是 composite Prompt，也不扩大单次 Skill 数量限制。
- `builtin.novel-bootstrap` 是内置创作方案，通过 `/novel new` 进入，可以消费 Skill Pack，但不作为用户可编辑 Skill。
- 旧 OpenClaw Skill 兼容层已删除，不参与本需求；OpenClaw 只保留 Tool/MCP 接入路径。
- 第一阶段只支持声明式 `prompt_method`，不支持用户代码和可执行 Workflow。
- Built-in Skill 随 Python Runtime 打包；User/Novel Skill 由 Electron Main 持久化。
- Python Registry 是合并视图，不是用户 Skill 的唯一存储源。
- 导出使用单文件 `SKILL.md`；导入兼容单文件和经用户授权的本地 Skill 目录。目录仅由 Main 受控读取，模型依据目录快照和产品能力目录生成审核 Draft，运行时仍以数据库 Revision 为准。
- Skill 选择发生在 IntentDecision 后、Planner 前。
- 用户显式选择优先于所有默认绑定。
- 默认每个 Operation 最多一个主 Skill 和一个辅助 Skill。
- Skill 只能声明推荐能力，不能授予能力。
- Prompt 正文低于系统、Runtime Policy、Role 和当前计划约束。
- Run 锁定具体 Revision 和 contentHash，不在恢复时重新解析 latest。
- 用户自定义角色生成流程作为 AS-1 的首个端到端验收用例。
- 架构实现前只先修订会影响代码形状的契约；首个实现纵切固定为 `builtin.continuity-review -> chapter.consistency_review -> chapter.consistency_review@1.0.0`。
