# Agent 领域 Toolchain 需求

版本：v0.2  
日期：2026-07-15  
状态：TC-0 / TC-1 已完成，已接入 IntentService 能力路由  
适用范围：CloudDream Novel Agent 内置 Python Agent Runtime、LangGraph 执行图、FastMCP 工具适配层、Electron Automation 边界与 Agent UI 活动流。

## 1. 背景

当前内置 Agent 已具备完整的原子工具调用基础设施：

```text
模型 / Planner
  -> LangGraph 主动探索图或 Executor graph
  -> 工具白名单、计划审批与 interrupt 校验
  -> FastMCP Tool Adapter
  -> Electron Automation HTTP
  -> CloudDream Novel Agent 数据与 AI 能力
  -> tool_result 返回 Runtime 和模型
```

现有能力包括：

- 统一 Agent 工具 manifest、JSON Schema 参数校验和只读/副作用分类。
- 模型在受限循环内主动调用只读工具。
- Planner 生成计划并由 Executor 按批准步骤执行工具。
- LangGraph checkpoint、interrupt/resume、取消、错误透传和 HTTP 回退。
- `tool_call` / `tool_result`、步骤状态、审批与产物事件的持久化和重放。
- DraftSession 审核边界；未经用户确认不写回小说正文或业务数据。

目前稳定、重复的领域任务仍主要由模型每次重新选择工具并组织顺序，尚未形成可命名、可复用、可独立测试和版本化的领域执行链。本需求在现有工具层之上增加 Toolchain 层，不替换 LangGraph、FastMCP、AutomationService 或现有原子工具。用户目标的结构化理解与路由统一由 [IntentService 需求](./intent-service-requirements.md) 定义；创作方法和提示标准由 [Agent Skill 需求](./agent-skill-requirements.md) 定义；Toolchain 只负责执行已经选定并通过校验的领域流程。

## 2. 术语

### 2.1 Tool

由 `agent_runtime/novel_agent_runtime/tool_manifest.py` 注册的原子能力，例如 `chapter.get`、`rag.ask` 和 `chapter.generate_draft`。Tool 只完成边界清晰的单项操作。

### 2.2 Toolchain

围绕一个稳定领域目标，将多个原子 Tool、确定性处理节点、条件分支和审批断点封装成可复用执行单元。每条 Toolchain 必须具有：

- 稳定 ID 与版本。
- 明确的输入和结构化输出 Schema。
- 固定的权限声明、调用预算和副作用级别。
- 可预测的错误、取消、重试、暂停与恢复语义。
- 独立自动化测试和验收标准。

Toolchain 可以实现为 LangGraph 子图，不要求再次注册成 FastMCP Tool。是否向模型暴露为高层能力由路由策略决定。

### 2.3 动态工具探索

模型根据开放式问题动态决定调用哪些只读 Tool。该能力继续用于普通问答、临时搜索和无法预先确定资料范围的研究任务，不由 Toolchain 全面替代。

## 3. 建设目标

1. 将高频、重复、步骤稳定的小说创作任务固化为领域 Toolchain。
2. 减少模型重复规划底层工具、漏读关键上下文和无效重复调用。
3. 让相同任务在不同 AgentRole 下复用一致的资料读取、证据组织和产物契约。
4. 复用现有权限、审批、checkpoint、SSE、Artifact 和 DraftSession 机制。
5. 保留模型在链内处理创作判断的能力，但将数据边界、执行顺序、预算和副作用控制交给 Runtime。
6. 支持按版本演进、灰度启用、独立测试和运行审计。

## 4. 非目标

第一阶段不包含：

- 不把所有原子 Tool 强制包装为 Toolchain。
- 不取消模型的动态只读探索能力。
- 不让 Python Runtime 直接访问 Prisma 或小说业务 SQLite。
- 不绕过 Electron Main、AutomationService 或 DraftSession 写回边界。
- 不将模型生成接口注册为 MCP Tool。
- 不实现第三方 Toolchain 市场、热加载或用户脚本执行。
- 不实现多个 Agent 无人值守、自动互评后直接写回的闭环。
- 不自动重放结果未知的副作用工具；幂等调用日志落地前继续 fail closed。

## 5. 适用性判断

只有同时满足以下大部分条件的任务才应封装为 Toolchain：

- 用户目标和最终产物明确。
- 至少复用两个原子 Tool 或一个 Tool 加多个确定性处理节点。
- 关键步骤在多数执行中保持稳定。
- 输入、输出和失败状态可以结构化描述。
- 对资料范围、调用成本或副作用需要统一治理。
- 可以编写不依赖具体模型自由发挥的流程测试。

以下任务继续使用动态工具探索：

- 普通小说内容问答。
- 临时查找名字、句子、章节或设定。
- 用户尚未明确分析范围的开放式研究。
- 只需要调用一个原子 Tool 的简单操作。
- 关键步骤高度依赖中途发现、无法形成稳定流程的任务。

## 6. 总体架构要求

Toolchain 位于 LangGraph Agent 编排与 FastMCP 原子工具之间：

```text
Renderer Agent Workspace
  -> Electron PythonRuntimeClient
  -> Python Agent Runtime
      -> IntentService.preflight
      -> 动态只读探索图（按需，中间过程）
      -> IntentService.finalize
          -> respond / clarify / plan
      -> Planner / Runtime Policy
          -> Domain Toolchain 子图
              -> Runtime 权限、审批和调用预算校验
              -> FastMCP Agent Tool Adapter
              -> Automation HTTP /invoke
              -> Electron AutomationService
      -> AgentRunEvent / AgentArtifact
  -> SSE 活动流与 Inspector
```

边界要求：

- LangGraph 负责 Toolchain 的状态、节点、分支、interrupt 和 checkpoint。
- `tool_manifest.py` 继续作为内置原子 Tool 的规范来源。
- `tool_adapter.py` 继续只负责工具协议、Schema 校验、调用和取消，不承载领域流程。
- Electron Main 继续作为数据库、AI 设置、业务副作用和草稿写回的唯一边界。
- Toolchain 的每次原子调用仍需经过 Runtime 白名单校验；链 ID 不能作为权限凭证。
- Toolchain 产物写入现有 `AgentArtifact`；章节和创作资产变更进入 DraftSession。

## 7. 目录与模块要求

需求文档继续归档在现有 `docs/agent/` 目录。实现阶段在现有 Python Runtime 内新增领域子目录，不改变 `apps/desktop`、`packages/core` 和 `agent_runtime` 的顶层结构：

```text
agent_runtime/
  novel_agent_runtime/
    tool_manifest.py
    tool_adapter.py
    exploration_graph.py
    execution_graph.py
    toolchains/
      __init__.py
      registry.py
      schemas.py
      chapter_context.py
      chapter_consistency_review.py
      chapter_continuation.py
      creative_asset_draft.py
      plotline_analysis.py
  tests/
    test_toolchain_registry.py
    test_chapter_context_toolchain.py
    test_chapter_consistency_toolchain.py
    test_chapter_continuation_toolchain.py
```

模块职责：

| 模块 | 职责 |
| --- | --- |
| `toolchains/registry.py` | Toolchain 定义、版本、角色、权限、输入输出模型与启用状态注册 |
| `toolchains/schemas.py` | 跨 Toolchain 复用的 ContextBundle、Evidence、Issue、Result 等 Pydantic 模型 |
| 各领域模块 | 构建对应 LangGraph 子图，不直接访问 Electron 数据库 |
| `runtime.py` | 根据计划和运行模式选择 Toolchain 或动态执行路径 |
| `execution_graph.py` | 承接 Run 原子推进、interrupt/resume 和 Toolchain 子图调度 |
| `events.py` | 将链、节点和底层 Tool 生命周期映射为规范化活动事件 |

若首期实现规模较小，可先将注册表和共享 Schema 保留为少量文件；当存在三条以上正式 Toolchain 时必须按上述子目录拆分，避免继续扩张 `runtime.py`。

## 8. Toolchain 统一定义

每条 Toolchain 至少声明以下元数据：

```python
class ToolchainDefinition(BaseModel):
    id: str
    version: str
    title: str
    description: str
    input_model: type[BaseModel]
    output_model: type[BaseModel]
    allowed_roles: tuple[str, ...]
    required_tools: tuple[str, ...]
    supported_operations: tuple[str, ...]
    intent_hints: tuple[str, ...] = ()
    accepts_agent_skills: bool = True
    max_agent_skills: int = 2
    side_effect: Literal["read_only", "draft_write"]
    max_tool_calls: int
    timeout_seconds: int
```

注册要求：

- `id` 使用稳定的小写点分命名，例如 `chapter.context`。
- Toolchain 版本与应用版本解耦；破坏输入输出契约时升级主版本。
- `required_tools` 必须全部存在于 `AGENT_TOOL_MANIFEST`。
- `allowed_roles` 必须来自现有 `AgentRole` 注册表。
- `supported_operations` 必须全部存在于 IntentService 的 `IntentOperationRegistry`；它是 Capability Matcher 的稳定映射来源。
- `intent_hints` 只提供少量用户表达别名和语义提示，不作为权限、审批或执行依据。
- `accepts_agent_skills` 和 `max_agent_skills` 只声明兼容性；Toolchain 使用计划步骤中锁定的 Skill Snapshot，不能按名称重新读取 latest。
- 注册时发现重复 ID、未知 Tool、未知角色或无效预算必须启动失败。
- Planner 和 Runtime 使用同一个 Toolchain 注册表，不能维护两份合法链列表。

## 9. 首批 Toolchain 需求

### 9.1 Chapter Context Toolchain

稳定 ID：`chapter.context`  
优先级：P0  
副作用：只读

目标：为续写、章节质检和编辑报告装配统一的章节上下文，避免各流程重复读取和裁剪资料。

输入至少包含：

- `novelId`
- `chapterId`
- `goal`
- `locale`
- 可选资料范围和 Token 预算

建议流程：

```text
读取目标章节
  -> 定位所属卷与相邻章节
  -> 读取活跃情节线
  -> 读取相关人物、世界观、物品/技能
  -> 按目标执行 RAG 补充
  -> 去重、相关性排序和预算裁剪
  -> 输出 ContextBundle
```

输出必须为结构化 `ContextBundle`，至少包含：

- 当前章节与相邻章节摘要或引用。
- 相关人物、情节线、世界规则和物品。
- RAG 证据、来源引用、置信度和警告。
- 被省略的资料类型及原因。
- 工具调用次数和估算上下文 Token。

约束：

- 与后续 `AgentContextAssembler` 共用预算和裁剪策略，不建立第二套 Token 预算实现。
- RAG 无索引或证据为空时返回警告，不自动调用 `rag.rebuild_index`。
- 单个资料源失败时可形成部分结果；缺少目标章节时整体失败。

### 9.2 Chapter Consistency Review Toolchain

稳定 ID：`chapter.consistency_review`  
优先级：P0  
副作用：只读

目标：基于章节内容和项目资料生成可审计、带证据的一致性检查报告。

建议流程：

```text
调用 chapter.context
  -> 检查人物行为与状态
  -> 检查情节线和时间顺序
  -> 检查世界规则、地点、物品与技能
  -> 合并和去重问题
  -> 生成结构化 ReviewArtifact
```

报告至少包含：

- 总分与各维度评分。
- 问题类型、严重度、章节位置或引用。
- 支持判断的项目证据。
- 修改建议及不确定性说明。
- 无法检查的维度及原因。

验收约束：

- 无证据时不得把推测表述为确定事实。
- 同一问题不能因多个资料源重复出现而重复计数。
- 只生成报告 Artifact，不创建 DraftSession。

### 9.3 Chapter Continuation Toolchain

稳定 ID：`chapter.continuation`  
优先级：P1  
副作用：草稿写入

目标：根据用户意图和项目上下文生成可审核的章节续写草稿。

建议流程：

```text
调用 chapter.context
  -> 检查上下文和用户目标是否充分
  -> 必要时触发证据质量或创作方向 interrupt
  -> 组装生成 brief
  -> chapter.generate_draft
  -> 校验 DraftSession 和 Artifact
  -> 返回待审核草稿
```

约束：

- 调用 `chapter.generate_draft` 前必须存在已批准计划和批准步骤。
- 创作方向互斥或资料不足时必须暂停，不能自行选择高影响方向。
- 最终结果只能是 DraftSession 引用和报告，不直接保存正文。
- Runtime 恢复时不得重复执行结果未知的草稿生成调用。

#### 9.3.1 多章节连续续写扩展（待实现）

多章节能力的统一范围、分层上下文、专家报告、三层审批、批次草稿和验收要求以 [Agent 多章节处理 V1 需求](./multi-chapter-processing-requirements.md) 为准。本节只保留 `chapter.sequence_continuation` 与现有单章链之间的 Toolchain 边界。

当前 `chapter.continuation@1.0.0` 的稳定边界仍是单目标章节、单个 DraftSession 和单章审核。Agent 可以跨章节读取资料和做只读分析，但不能把一次单章续写请求静默扩大为多章写入。多章节续写作为独立 P1 能力设计，候选稳定 ID 为 `chapter.sequence_continuation@1.0.0`，不修改现有单章链的输入语义。

产品范围选择必须显式区分：

- `current_chapter`：当前编辑器章节，默认用于“这篇文章”“本章”“当前章”。
- `selected_chapters`：用户在章节树或上下文选择器中明确勾选的有序章节集合。
- `current_volume`：只读分析可直接使用；生成草稿时仍需确认具体数量和顺序。
- `novel`：首期只允许只读分析，不允许一次请求批量改写整本小说。

建议输入契约：

```json
{
  "novelId": "novel-id",
  "anchorChapterId": "chapter-id",
  "targetMode": "append_new",
  "targetChapterIds": [],
  "newChapterCount": 3,
  "goal": "连续续写三章",
  "perChapterTargetLength": 3000,
  "continuityPolicy": "strict",
  "locale": "zh-CN"
}
```

其中 `targetMode` 只接受 `append_new` 或 `rewrite_existing`。`append_new` 必须提供锚点章节和 `newChapterCount`；`rewrite_existing` 必须提供用户显式选择且有顺序的 `targetChapterIds`。首期建议单批 1 到 5 章，默认 2 章，超过上限必须拆成多个任务，不能由模型无限循环。

建议执行流程：

```text
确认范围、章节数量、顺序和写作目标
  -> 一次性装配跨章上下文与连续性约束
  -> 生成整批章节节拍和每章交付目标
  -> 用户批准批次计划
  -> 按顺序逐章生成草稿
  -> 将前一章已生成草稿作为后一章的临时上下文
  -> 每章独立校验并保存子 DraftSession / Artifact
  -> 生成批次级连续性审核
  -> 在审核中心逐章接受、丢弃或要求重生成
```

安全与恢复约束：

- 一个父批次引用 N 个有序子 DraftSession；每章拥有独立 invocation key、状态、错误和重试边界。
- 任一章失败不能把已成功章节标记为已提交；批次状态必须显示部分完成和失败位置。
- 未经审核不得创建正式章节、覆盖已有正文或调用 `draft.commit`；批量提交必须再次结构化确认并按顺序执行。
- 后一章只能引用前一章已确定生成成功的草稿版本；重生成前章后，依赖它的后续草稿必须标记为过期并重新审核。
- UI 在输入框旁显示当前范围；多选时显示“已选 3 章”并可展开查看顺序。计划卡、活动流和审核中心都必须显示批次与单章层级。
- “续写几章”但未提供数量时，只澄清数量、目标篇幅等真实创作决策；当前锚点章节已存在时不得再次询问从哪一章开始。

### 9.4 Creative Asset Draft Toolchain

稳定 ID：`creative_asset.draft`  
优先级：P1  
副作用：草稿写入

目标：根据 brief 和现有小说资料生成角色、地点、世界设定、物品或技能草稿，并在生成前后检查冲突。

建议流程：

```text
读取人物、世界观、物品、地图和情节线
  -> 检查同名与明显设定冲突
  -> 必要时请求用户确认创作方向
  -> creative_assets.generate_draft
  -> 校验草稿结构与冲突
  -> 返回 DraftSession / Artifact
```

约束与章节续写一致：必须审批、不得直接入库、未知副作用结果不得自动重放。

### 9.5 Plotline Analysis Toolchain

稳定 ID：`plotline.analysis`  
优先级：P2  
副作用：只读

目标：按用户批准的卷、章节或整本小说范围，分析主支线推进、伏笔回收和长期停滞问题。

约束：

- 大范围分析必须分批读取章节并遵守上下文预算。
- 整本分析前需要明确范围；范围不清时触发 `analysis_scope` interrupt。
- 输出结构化报告 Artifact，不生成正文草稿。

### 9.6 Novel Audit Toolchain

稳定 ID：`novel.audit`  
优先级：P3  
副作用：只读

目标：组合情节、人物、世界观、节奏和读者体验子链，生成小说全局体检报告。

该链属于 Toolchain 组合能力，待前三条链稳定后再实施。第一阶段不得通过并行子链突破全局工具调用预算。

## 10. 路由与 Planner 要求

- 用户输入先经过 [IntentService](./intent-service-requirements.md) 的 `preflight`，按需完成只读探索，再由 `finalize` 形成操作列表、产物建议和初始 Toolchain 候选。
- Planner 应优先选择与目标精确匹配的稳定 Toolchain，而不是展开其全部底层 Tool。
- 开放式问答和临时检索继续走 `exploration_graph.py`。
- 一个计划步骤只能声明 Toolchain 或原子 Tool 执行意图之一，避免相同操作重复执行。
- Toolchain 不匹配、被禁用或输入不完整时，可以回退为动态规划，但必须记录回退原因。
- 用户修改计划后，Runtime 必须重新校验链 ID、版本、角色、输入、权限和预算。
- Toolchain 内部可调用模型做判断或综合，但模型不能增加注册表外的 Tool。

## 11. 权限与审批要求

- `read_only` Toolchain 只能包含 manifest 中标记为只读的原子 Tool。
- `draft_write` Toolchain 可以包含草稿生成 Tool，但必须经过现有计划审批和 Runtime interrupt 校验。
- Toolchain 元数据、MCP annotations、Planner 输出和模型文本都不是权限凭证。
- 每次底层 Tool 调用前都要重新校验当前角色、批准步骤和允许工具集合。
- Toolchain 不得调用 `draft.commit`、章节直接保存或其他未经设计批准的最终写回能力。
- 用户取消后必须停止后续节点，并将活动 requestId 传递到现有取消链路。

## 12. 状态、恢复与幂等要求

- 每个 checkpoint 最多跨越一个 Toolchain 节点或一个原子 Tool 调用边界。
- checkpoint 至少记录 Toolchain ID、版本、当前节点、输入摘要、已完成调用、预算消耗、审批状态和 Artifact 引用。
- `waiting_approval` 可依赖现有 LangGraph SQLite Checkpointer 跨 Runtime 重启恢复。
- 纯读取节点可在明确未完成时安全重试，但不得造成无限循环。
- 草稿生成等副作用节点在结果未知时不得自动重放；Run 应明确失败并提示用户重新确认。
- 同一 Run 恢复时必须锁定最初选择的 Toolchain 主版本；版本不可用时 fail closed。

## 13. 预算与性能要求

每条 Toolchain 必须配置：

- 最大原子 Tool 调用数。
- 最大模型调用数。
- 单次和总超时时间。
- 输入上下文 Token 预算。
- 单个 Tool 结果的最大持久化与回灌长度。

默认原则：

- 优先批量读取和按需检索，避免全量章节遍历。
- 相同参数的只读调用可在单个 Run 内复用结果。
- Toolchain 调用子链时共享全局预算，不重新获得完整预算。
- 超出预算时返回部分结构化结果或触发用户范围确认，不静默截断关键约束。

## 14. 事件、审计与 UI 要求

Toolchain 必须复用现有 `AgentRunEvent` 和折叠活动流，不展示隐藏思维链。

建议新增或扩展规范化事件：

| 事件 | 用途 |
| --- | --- |
| `toolchain_started` | 记录链 ID、版本、标题和输入摘要 |
| `toolchain_node_started` | 记录当前用户可读节点 |
| `toolchain_node_completed` | 原位完成节点并记录耗时和结果摘要 |
| `toolchain_completed` | 记录最终 Artifact、预算使用和完成状态 |
| `toolchain_failed` | 记录失败节点、规范化错误和是否可重试 |

兼容要求：

- 底层调用继续发送并持久化 `tool_call` / `tool_result`。
- UI 折叠态以一条 Toolchain 活动显示，展开后展示节点和底层 Tool 明细。
- 参数和输出持久化前继续执行脱敏和长度限制。
- SSE 断线重放必须保持 Toolchain、节点和 Tool 的父子关系与原始顺序。
- 若暂不升级事件协议，可先使用现有步骤事件并在 payload 中增加 `toolchainId`、`toolchainVersion` 和 `nodeId`，但字段语义必须稳定。

## 15. Artifact 要求

- `chapter.context` 生成上下文包或内部可引用结果，不直接显示为正文草稿。
- 一致性审查、情节分析和全局体检生成报告型 `AgentArtifact`。
- 章节续写和创作资产链生成 DraftSession 引用型 `AgentArtifact`。
- Artifact 必须记录生成它的 Toolchain ID、版本、Run ID、证据引用和创建时间。
- 长正文、完整工具结果和证据包通过 Artifact 引用进入模型上下文，不在普通消息中反复复制。

## 16. 错误处理要求

错误至少区分：

- `TOOLCHAIN_NOT_FOUND`
- `VERSION_UNAVAILABLE`
- `INPUT_INVALID`
- `ROLE_NOT_ALLOWED`
- `TOOL_NOT_ALLOWED`
- `BUDGET_EXCEEDED`
- `CONTEXT_INSUFFICIENT`
- `NODE_FAILED`
- `SIDE_EFFECT_UNKNOWN`
- `CANCELLED`

错误必须包含用户可理解的摘要、内部错误码、失败节点和可执行的下一步；不得把未经清理的模型响应、密钥或完整敏感参数直接写入事件。

## 17. 测试要求

### 17.1 注册表测试

- 拒绝重复 ID 和无效版本。
- 拒绝未知角色和未知原子 Tool。
- 拒绝只读链声明副作用 Tool。
- Planner 与 Runtime 读取同一注册表。

### 17.2 单链测试

每条 Toolchain 至少覆盖：

- 正常路径和结构化输出校验。
- 必填输入缺失。
- 单个只读 Tool 失败和部分结果策略。
- 空 RAG 证据、低置信度和资料冲突。
- 调用次数与 Token 预算耗尽。
- 用户取消。
- interrupt、提交审批和恢复。
- Runtime 重启后的 checkpoint 恢复。
- 未批准副作用工具被拒绝。
- 结果未知的副作用节点不自动重放。

### 17.3 集成测试

- Toolchain 经 FastMCP adapter 调用真实 Automation 测试替身。
- `--tool-transport http` 回退产生相同任务结果契约。
- `tool_call` / `tool_result` 与 Toolchain 节点事件顺序正确。
- Artifact、DraftSession 和终态事件可持久化、断线重放和刷新恢复。
- 角色切换后权限立即按当前 Run 的批准状态重新校验。

## 18. 分阶段交付

### Phase TC-0：基础协议

- 建立 Toolchain 注册表、共享 Schema 和统一错误码。
- 接入 Runtime 路由、预算、事件关联和测试基架。
- 不引入副作用链。

### Phase TC-1：只读领域链

- 实现 `chapter.context`。
- 实现 `chapter.consistency_review`。
- 接入报告 Artifact 和 Inspector。
- 完成 FastMCP/HTTP 双 transport、取消和恢复测试。

### Phase TC-2：草稿领域链

- 实现 `chapter.continuation`。
- 实现 `creative_asset.draft`。
- 复用计划审批、方向 interrupt 和 DraftSession。
- 完成副作用未知状态的 fail-closed 验收。

### Phase TC-3：长范围分析与组合

- 实现 `plotline.analysis`。
- 实现多章节专家组合 `novel.scope_audit`。（后端已完成）
- 评估并实现 `novel.audit`。
- 接入分批读取、共享预算和子链组合。

## 19. 首期验收标准

首期以 TC-0 和 TC-1 为完成范围，必须满足：

1. Runtime 能通过稳定 ID 和版本解析并执行 `chapter.context` 与 `chapter.consistency_review`。
2. 两条链只使用注册白名单内的只读 Tool，不能越权调用草稿或写回能力。
3. 相同输入下执行节点顺序、预算上限和输出 Schema 可预测。
4. RAG 空证据、低质量证据和单个资料源失败均有明确、可测试的降级结果。
5. 取消、interrupt/resume、Runtime 重启和 SSE 断线后状态可正确恢复或明确失败。
6. 活动流折叠显示链摘要，展开后可查看节点、底层 Tool、耗时、脱敏参数和结果摘要。
7. 一致性报告保存为结构化 AgentArtifact，并可在 Inspector 中恢复查看。
8. Python `pytest`、TypeScript 类型检查和 Renderer 构建不回归。

## 20. 待确认事项

实施前需要结合首个原型确认：

1. Toolchain 是否进入 Planner 的结构化输出 Schema，还是由 Runtime 根据计划步骤二次路由。
2. 首期使用独立 `toolchain_*` 事件，还是在现有 step 事件 payload 中增加链字段。
3. `ContextBundle` 作为持久化 Artifact，还是仅在 Run checkpoint 中保存摘要和引用。
4. Toolchain 版本是否写入现有 `AgentRun` / `AgentArtifact` 字段，或先保存在 JSON metadata。
5. `chapter.context` 与 `AgentContextAssembler` 的共享接口和落地顺序。

默认建议：Planner 输出稳定 Toolchain ID；Runtime 做最终路由和权限校验；首期复用现有步骤事件并增加关联字段；版本与 ContextBundle 元数据先保存在现有 JSON 字段，契约稳定后再评估数据库专用字段。

## 21. 实施状态（2026-07-16）

TC-0 与 TC-1 首版已经落地：

- Planner 结构化步骤支持与 `tools` 互斥的 `{id, version, input}` Toolchain 调用；Runtime 根据经过校验的有序 Intent Operation 提供确定性二次路由。
- `ToolchainRegistry` 启动时校验稳定 ID、语义版本、角色、manifest 工具、只读边界和预算；统一错误码已进入链失败事件。
- `chapter.context@1.0.0` 与 `chapter.consistency_review@1.0.0` 按 LangGraph 原子推进，每个 context 节点最多调用一个 Tool，并把进度与预算保存在 checkpoint state。
- `context_bundle` 与 `consistency_review` 已进入现有 AgentArtifact；Inspector 支持审核总分、维度和问题列表。
- 链、节点和底层 Tool 事件均持久化；UI 折叠投影按 nodeId 合并发起/结果事件。
- 自动化覆盖注册失败、稳定路由、可选源降级、重复问题去重、HTTP/FastMCP、取消和现有 Runtime 回归。
- 两条 Toolchain 已声明 `supportedOperations` 与 `intentHints`，注册时校验 Operation ID；Capability Matcher 可按角色匹配或降级，不再读取用户文本关键词。
- Toolchain 定义支持 `enabled`；禁用链从 Planner 公共契约和自动能力匹配中排除，显式解析返回 `TOOLCHAIN_DISABLED`，不静默执行旧版本。

TC-2/P1 首版已经落地：

- `chapter.continuation@1.0.0` 在 ContextBundle 后检查证据质量和创作方向，组装 brief，只调用一次 `chapter.generate_draft`，并返回章节 DraftSession 引用与 `chapter_draft` Artifact。
- `creative_asset.draft@1.0.0` 读取五类项目资料，执行同名冲突预检、方向判断、一次素材生成和一次 `creative_assets.validate_draft`，返回同一 DraftSession 的校验结果与 `creative_assets_draft` Artifact。
- 草稿 Toolchain 是计划中的唯一草稿生产者；链步骤与原子 tools 继续互斥，批准步骤会覆盖链注册的底层工具，但每次调用仍由 Runtime 重验白名单。
- SQLite `tool_invocations` 账本以 Run、步骤、方法和参数哈希形成稳定调用键，并持久化 requestId、状态和有界结果。成功结果可复用；发送后异常或重启中的 `in_flight` 变为 `unknown`，Run 返回 `SIDE_EFFECT_UNKNOWN`，不得自动重放。
- 自动化覆盖方向审批前零写入、报告模式跳过、DraftSession/Artifact 契约、素材二次校验、超时不重放和 Runtime 重启 fail-closed。

TC-3/P2 `plotline.analysis` 首版已经落地：

- `plotline.analysis@1.0.0` 通过稳定 Intent Operation 路由，支持当前章、当前卷和整本小说三种范围；目标未明确时在任何读取前触发 `analysis_scope` interrupt，整本范围必须由用户显式选择或在任务中明确声明。
- `chapter.list` 新增兼容旧调用的 `offset`、`limit` 与 `includeContent` 参数；分析链按卷内 offset 分批读取，正文先从 Lexical JSON 投影为文本，再生成有界首尾摘录。
- Planner 提供的 `scope` 不视为用户授权；只有目标原话中的明确范围或 `analysis_scope` 审批结果可以解锁读取，避免模型自行扩大到整本小说。
- `maxChapters`、Tool 调用数和估算 Token 三层预算会显式截断剩余批次并记录覆盖/省略章数；大范围执行只进行一次补充 RAG 和一次结构化模型综合。
- 输出为独立 `plotline_analysis` Artifact，包含主支线推进度、伏笔/停滞问题、证据、不确定性、建议和确定性 coverage；不创建 DraftSession，也不调用任何写入工具。
- Inspector 提供覆盖范围、情节线健康度、主支线列表和风险清单；SSE、SQLite 会话投影与刷新恢复已接受该 Artifact 类型。
- 自动化覆盖 HTTP/FastMCP 双传输、卷内分页 offset、范围 interrupt 后 Runtime 重启恢复、章节/Token 预算截断、重复问题去重和伪造证据 ID 过滤。

多章节 P1 `editor.range_review` 首版已经落地（2026-07-18）：

- `editor.range_review@1.0.0` 复用统一 `ChapterScopeBundle`，只调用 `chapter.scope_context.build` 与 `rag.ask`，共享读取后执行一次编辑综合。
- 输出 `chapter_range_review` 专家 Artifact，包含范围、覆盖率、版本快照、维度评分和可审批 finding，并与独立报告审批/修订任务契约对接。
- Runtime 会过滤不属于批准目标范围的章节引用，以及不在章节、项目实体、情节线、叙事摘要或实际检索结果中的证据 ID。
- Intent Target 已支持 `chapter_scope`；显式多章节编辑审核可稳定路由到该链，普通单章一致性检查继续使用 `chapter.consistency_review`。

多章节 P1 `reader.journey_review` 首版已经落地（2026-07-18）：

- `reader.journey_review@1.0.0` 使用 `chapter_scope` 目标和 `expert_report` 产物，普通单章 `reader.feedback` 不受影响。
- 范围层仅执行一次 `chapter.scope_context.build`；该链的 requiredTools 不包含 `rag.ask`，也不使用世界观、人物卡、情节线或其他专家结果。
- 子模型按作品顺序逐章执行，输入固定为当前章节与前序 `readerStateSummary`；聚合由 Runtime 确定性完成，不增加一次能看到完整正文的综合模型调用。
- 输出 `reader_journey` Artifact，包含逐章理解、情绪、悬念、沉浸、弃读风险、追更动力、趋势和可审批 finding；越权章节及证据引用在发布前移除。
- 自动化以未来章节专属关键词和后台规则标记验证前序请求隔离，并覆盖无 RAG、无 DraftSession、无正文写入和完整来源快照。

多章节 P1 `worldbuilding.range_consistency` 首版已经落地（2026-07-18）：

- `worldbuilding.range_consistency@1.0.0` 使用 `chapter_scope` 目标与 `expert_report` 产物，复用一次 `ChapterScopeBundle` 读取和一次 RAG 补充。
- 模型只负责结构化综合规则、术语、能力、地点、物品、时间关系与状态漂移；提示词要求区分明确冲突、尚未解释和资料不足。
- 输出 `worldbuilding_consistency` Artifact，包含维度评分、逐实体状态、可审批 finding、覆盖率和来源快照，不创建 DraftSession 或修改任何项目设定。
- Runtime 只接受批准目标章节、已登记项目实体和实际范围/RAG 来源；越权章节、伪造 subject ID 与证据 ID 在发布前移除，重复冲突按严重度归并。
- 自动化覆盖稳定 Intent 路由、完整只读调用、实体/证据核验、Artifact 审批契约和零写入。

多章节 P1 `research.range_fact_check` 首版已经落地（2026-07-18）：

- `research.range_fact_check@1.0.0` 使用 `chapter_scope` 目标与 `expert_report` 产物，按“抽取声明、项目检索、综合报告”三个可恢复阶段执行。
- 默认最多提取 8 条声明、执行 5 次 `search.query`；总预算为 7 次只读工具和 2 次模型调用，范围读取与 RAG 证据只装配一次。
- 输出 `research_fact_check` Artifact，包含逐条声明、verdict、confidence、可追溯 evidence、未核验原因、搜索统计、覆盖率和来源快照，不创建 DraftSession 或修改正文。
- Runtime 只接受真实 claim、目标章节以及范围/RAG/项目搜索实际返回的来源 ID；无证据的肯定结论强制降级为 `unverified`，confidence 不高于 0.3。
- `search.query` 明确定义为项目全文检索。当前链向模型传递 `externalSearchAvailable=false`，需要外部证据但 RAG 不足的声明保持未核验；真实互联网检索必须以后以独立 Tool 和计划审批开关接入。
- 自动化覆盖稳定 Intent 路由、检索队列预算、来源过滤、外部能力边界、Artifact 审批契约和零写入。

多章节 P1 `novel.scope_audit` 首版已经落地（2026-07-18）：

- `novel.scope_audit@1.0.0` 使用 `chapter_scope` 目标与 `expert_report` 产物，只允许团队/Supervisor 调用；默认专家为编辑、读者和世界观，考据可由计划显式加入。
- 范围层只执行一次 `chapter.scope_context.build + rag.ask`。编辑与世界观按最大并发 2 执行；读者继续使用逐章顺序盲测投影；考据复用同一 Bundle，再按预算执行项目全文搜索。
- 每位成功专家发布独立 `chapter_range_review`、`reader_journey`、`worldbuilding_consistency` 或 `research_fact_check` 子 Artifact。部分专家失败不会伪造报告，也不会阻止其余专家完成；全部失败才以 `CONTEXT_INSUFFICIENT` 结束。
- Supervisor 只接收结构化子报告，不接收完整正文。最终 `scope_audit` 保存真实子 Artifact、执行/失败专家、综合 finding 与冲突；所有结论必须关联真实 `sourceFindingIds`，未执行专家和伪造来源会被清理并写入 warning。
- 同一 Run 的模型与工具请求使用集合跟踪，团队并发批次取消时会撤销全部在途请求；已发布子 Artifact 可按范围和专家引用在恢复时复用。
- 自动化覆盖共享读取、真实双并发、读者未来信息隔离、显式考据搜索、综合来源校验、子报告审批状态与零写入。

仍不支持运行中 Python 进程重启后的自动续跑。明确停在 interrupt 的 `waiting_approval` 可恢复；只读运行中节点按 `RUNTIME_INTERRUPTED` 失败，未知副作用结果按 `SIDE_EFFECT_UNKNOWN` 失败。该行为是当前安全边界，不计划通过盲重试放宽。
