# Agent Skill 与用户自定义 Skill 需求

版本：v0.1  
日期：2026-07-16  
状态：需求草案  
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

## 3. 建设目标

1. 将高频创作方法、提示流程、审查标准和输出格式保存为可复用 Agent Skill。
2. 支持内置、用户全局和当前小说三种 Skill 作用域。
3. 支持用户创建“固定角色生成流程”等声明式自定义 Skill。
4. 允许 IntentService、AgentRole、预置任务和用户显式选择共同参与 Skill 解析。
5. 将完整 Skill 内容按需加载，避免所有角色 Skill 常驻模型上下文。
6. 复用现有 Planner、Toolchain、FastMCP、Runtime Policy 和 DraftSession 边界。
7. 对每次执行使用的 Skill ID、版本和内容哈希进行审计，保证历史结果可解释。
8. 支持 Skill 预览、试运行、版本更新、启停、导入和导出。
9. 用户自定义 Skill 不得扩大 Tool 权限或绕过计划审批。

## 4. 非目标

第一阶段不包含：

- 不允许 Skill 包含 Python、JavaScript、Shell、PowerShell 或其他可执行代码。
- 不允许 Skill 注册新的 MCP Tool 或直接调用 Tool。
- 不允许 Skill 修改角色工具白名单、Runtime Policy 或审批规则。
- 不实现在线 Skill 市场、评分、付费和自动下载。
- 不执行 Skill 中引用的远程 URL、附件或外部资源。
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
- 当前 Operation，例如 `creative_asset.character_draft`。
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

- 持久化记录 `id` 必须全局唯一；`stableId` 是用户可读稳定标识，在对应 Scope 内唯一，使用小写点分或连字符命名。
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
```

要求：

- Python Runtime 不直接访问这些表，通过 Electron Automation/IPC 获取。
- 删除采用归档；被历史 Run 引用的 Revision 不物理删除。
- Skill 更新使用乐观并发版本，避免多窗口覆盖。
- 备份恢复应包含 User/Novel Skill、Revision 和 Binding。
- Skill 内容不得包含或导出 AI API Key、访问令牌和 Provider 私密设置。

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
      agentSkillIpc.ts
      agentSkillImport.ts
  src/components/AgentWorkspace/
    AgentSkillPanel.tsx
    AgentSkillEditor.tsx
    AgentSkillPicker.tsx
```

使用 `agent_skills` 而不是 `skills` 作为代码目录，避免与小说业务中的技能资产混淆。

## 14. Skill 文件格式

导入导出采用单文件 `SKILL.md`。第一阶段不支持脚本、二进制附件和自动加载远程引用。

示例：

```markdown
---
schemaVersion: novel-editor.agent-skill.v1
id: user.character-generator.deep-conflict
version: 1.0.0
name: 矛盾驱动角色生成
description: 通过欲望、恐惧和性格矛盾生成角色
scope: user
skillType: prompt_method
supportedOperations:
  - creative_asset.character_draft
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

Agent 右侧 Inspector 增加“Agent Skill”页：

- 内置、我的、当前小说三个分组。
- 搜索、角色、Operation、启用状态过滤。
- 显示名称、说明、版本、Scope、默认绑定和最近更新时间。
- 清楚区分 Agent Skill 与小说设定中的“技能”。

### 19.2 Skill 编辑器

用户可编辑：

- 名称和说明。
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

输入框附近提供当前 Skill 选择：

- 自动。
- 不使用 Skill。
- 最近使用。
- 当前 Role 可用 Skill。
- 搜索所有兼容 Skill。

显式选择后，输入区显示 Skill 名称和版本；发送前用户可以移除。

### 19.4 试运行

- 默认使用模拟或当前已选上下文。
- 明确展示将读取哪些项目资料。
- 副作用 Skill 试运行只生成预览或 DraftSession，不直接写回。
- 显示最终编译 Prompt 的结构化区段，但脱敏敏感配置。
- 试运行结果可以保存为新 Skill Revision 的验证记录，第一阶段不要求持久化完整模型输出。

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
| `db:import-agent-skill` | 校验并导入 SKILL.md |
| `db:export-agent-skill` | 导出指定 Revision |

建议 Runtime API：

| API | 用途 |
| --- | --- |
| `agent.skills` | 返回合并后的可见 Skill 摘要 |
| `agent.skill.resolve` | 调试或 UI 预览解析结果；正常 Run 内部直接调用 Resolver |
| `agent.skill.preview` | 编译 Skill Prompt 区段并返回诊断 |

Runtime 获取用户 Skill 时通过 Electron Automation 只读能力：

- `agent_skill.list`
- `agent_skill.get`

这些能力不得暴露为模型可自由调用的普通创作 Tool。

## 21. IntentService 契约调整

IntentDecision 增加用户请求的 Skill 引用：

```python
class IntentSkillRequest(BaseModel):
    skillId: str
    requestedVersion: str | None = None
    selectionSource: Literal["explicit", "shortcut", "preset", "semantic"]


class IntentDecision(BaseModel):
    # existing fields...
    requestedSkills: list[IntentSkillRequest] = Field(default_factory=list)
```

规则：

- IntentService 只提取显式或语义 Skill 引用，不决定最终 Revision。
- 用户在 UI 选择的 Skill 以结构化 entryHint 传入，优先于文本识别。
- 文本名称匹配多个 Skill 时必须澄清，不按标题随机选择。
- Skill 名称不存在时明确提示，不把它当作普通自然语言要求静默忽略。
- 默认 Skill 不进入 requestedSkills，由 SkillResolver 根据 Binding 解析。

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

静态验证只用于发现明显越界指令，不能作为唯一安全机制。即使 Skill 正文包含恶意或冲突指令，Runtime Policy、Tool 白名单、Toolchain Definition 和 DraftSession 审批仍必须独立生效。

## 25. 生命周期与版本

### 创建

- 用户选择 Scope、适用 Operation 和模板。
- 保存前完成 Schema、变量、预算和安全警告检查。
- 创建 Skill Definition 和第一个 Revision。

### 编辑

- 不修改旧 Revision。
- 保存时创建新 Revision 并更新 currentRevisionId。
- 如果内容未变化，不创建重复 Revision。

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

错误必须包含用户可读说明、Skill ID、失败阶段和可执行的修复建议，不回显密钥或完整敏感上下文。

## 28. 测试要求

### Registry 与持久化

- Built-in、User 和 Novel Skill 正确合并。
- Scope 隔离和同名不同 ID 正确处理。
- Revision 不可变和乐观并发更新。
- 归档、恢复、启停和 Binding 清理。
- 应用重启后 User/Novel Skill 可恢复。

### 导入与验证

- 合法 SKILL.md 导入。
- 未知 schemaVersion、非法 Frontmatter 和超大文件拒绝。
- 未知变量、代码字段、远程依赖和 ID 冲突处理。
- 导入后重新计算 contentHash。

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

### Run 集成

- Planner 步骤携带合法 SkillRef。
- Toolchain 使用锁定 Snapshot，不重新读取 latest。
- DraftSession 和 Artifact 记录 SkillRef。
- 暂停、恢复、Runtime 重启后仍使用相同 Revision。
- Skill 更新、停用或归档不改变活跃 Run。
- 缺失 Snapshot 和哈希不匹配时明确失败。

## 29. 分阶段交付

### Phase AS-0：内置 Skill 基础

- 建立 AgentSkill Schema、Registry、Resolver、Compiler 和验证器。
- 将 Role 的展示字符串迁移为稳定 `defaultSkillIds`。
- 实现按需 Prompt 注入、Token 预算和 Run/Artifact SkillRef。
- 首批内置 Skill：角色生成、连续性检查、节奏诊断、读者盲测。

### Phase AS-1：用户自定义 Skill

- 建立 AgentSkill、Revision、Binding 持久化。
- 实现 User Scope Skill 创建、编辑、启停、归档和版本管理。
- 实现 Skill Picker、编辑器、Prompt 预览和试运行。
- 支持单文件 SKILL.md 导入导出。
- 完成固定角色生成流程端到端验收。

### Phase AS-2：小说级 Skill

- 支持 Novel Scope、小说默认绑定和备份恢复。
- 支持当前小说专属术语、世界观和创作方法。
- 增加作用域冲突、复制为 User Skill 和跨小说迁移。

### Phase AS-3：后续评估

- Skill 分享包和来源签名。
- 可选团队 Scope。
- 组合 Skill。
- 市场、评分和在线更新。

AS-3 不进入当前 Agent Phase 2 的交付承诺。

## 30. 用户自定义角色生成 Skill 验收场景

用户创建“矛盾驱动角色生成”Skill：

1. 在 Agent Skill 编辑器选择 User Scope。
2. 绑定 `creative_asset.character_draft` Operation。
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

## 31. 首期产品验收标准

AS-0 与 AS-1 完成时必须满足：

1. 用户能创建、预览、试运行和版本化一个声明式 Agent Skill。
2. Skill 可以绑定 Operation、Role 和 User 默认规则。
3. IntentService 能传递显式 Skill 请求，SkillResolver 能形成稳定 Snapshot。
4. Planner 和 Toolchain 使用相同 SkillRef，不存在 latest 漂移。
5. Skill 正文按需进入上下文，不随所有 Role 常驻加载。
6. 用户 Skill 不增加工具权限、不执行代码、不绕过审批。
7. 角色生成 Skill 能产生真实 DraftSession，并由用户确认写回。
8. Run、Artifact 和恢复链路保留 Revision 与 contentHash。
9. 导入非法或超预算 SKILL.md 时给出结构化错误。
10. Python 测试、TypeScript 类型检查、Renderer 构建和现有 Agent 回归测试通过。

## 32. 默认设计决策

- 产品名称使用“Agent Skill”或“创作技能”，避免与小说技能混淆。
- 第一阶段只支持声明式 `prompt_method`，不支持用户代码和可执行 Workflow。
- Built-in Skill 随 Python Runtime 打包；User/Novel Skill 由 Electron Main 持久化。
- Python Registry 是合并视图，不是用户 Skill 的唯一存储源。
- 导入导出使用单文件 SKILL.md，运行时仍以数据库 Revision 为准。
- Skill 选择发生在 IntentDecision 后、Planner 前。
- 用户显式选择优先于所有默认绑定。
- 默认每个 Operation 最多一个主 Skill 和一个辅助 Skill。
- Skill 只能声明推荐能力，不能授予能力。
- Prompt 正文低于系统、Runtime Policy、Role 和当前计划约束。
- Run 锁定具体 Revision 和 contentHash，不在恢复时重新解析 latest。
- 用户自定义角色生成流程作为 AS-1 的首个端到端验收用例。
