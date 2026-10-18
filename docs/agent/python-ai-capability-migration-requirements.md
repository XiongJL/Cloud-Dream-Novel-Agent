# Agent AI 能力渐进迁移至 Python / LangGraph 需求

状态：v0.2 审阅修订稿，基于已确认 v0.1；待实施

日期：2026-09-10
适用范围：Python Agent Runtime、LangGraph、Electron AiService、AutomationService、HTTP Provider、MCP CLI Provider、Agent Toolchain、SSE、模型结果持久化与 Agent Renderer。

## 1. 背景

当前 Agent 主编排已经运行在 Python Runtime 和 LangGraph 中，但模型调用仍主要由 Electron 执行：

```text
Python LangGraph
  -> Automation Tool Adapter（HTTP / FastMCP）
  -> Electron AutomationService
  -> TypeScript AiService
  -> HttpProvider / McpCliProvider
  -> 模型
```

Python Runtime 目前通过 Electron 调用约二十个 Agent 模型方法，包括聊天探索、计划生成与修订、章节节拍、创作方向识别、Writer/Editor/Reader/Worldbuilding/Research 审查、报告生成和 Skill 文档生成。该结构保留了既有 Electron AI 能力，但产生了以下问题：

- LangGraph 节点与真实模型请求分属两个进程，超时、取消、重试和调用次数难以统一。
- Python Pydantic 领域模型、Electron JSON Schema 和 Prompt 字段说明存在跨语言漂移风险。
- 结构化输出当前主要依赖 Prompt、JSON 修复和调用后的校验，Provider 原生 Structured Output 未形成统一能力层。
- 模型完整返回后，仍可能在跨进程传输、解析、契约转换或 Artifact 发布阶段失败。
- Python 的 LangGraph RetryPolicy 与 Electron Provider 重试容易形成多层重试责任。
- Agent 的模型调用日志、Token、Provider response ID、图节点和恢复记录不能天然形成同一条链路。
- 为兼容 Chat Completions 和 Responses API，Electron 已有一套协议适配；若继续在各 Agent 方法中分别处理，后续 Provider 扩展成本较高。

本需求采用渐进迁移，不要求将全部桌面 AI 能力迁入 Python，也不要求删除 Electron AiService。目标是优先迁移 Agent 流程中的模型推理能力，使 Python 成为 Agent AI 控制面，同时保留 Electron 的本地业务执行面和旧 AI 路径。

### 1.1 真实失败基线与迁移收益边界

依据 [2026-09-09 章节验收记录](./chapter-writing-product-defaults-2026-09-09.md)：

| 已观察事实 | 对迁移需求的约束 |
| --- | --- |
| 正文请求额度 18432，首次成功生成 2123 汉字；输出 10662 Token，其中思考 8902 | 章节字数、思考用量、可见输出与请求额度必须分开；18K 不是正文应写出的字数 |
| 审校 8K 截断，16K 恢复因剩余约 107 秒而超时 | 需要任务级额度与时间共同分配，不能只改进程或加一层 RetryPolicy |
| 外层忽略下层 `retryable=false`，重试叠加后达到 Run 截止时间 | 迁移期也必须有单一预算账本，已耗尽恢复额度不能被外层重新解释为可重试 |
| 审校共享时限改为 5 分钟后，独立 16K 恢复仍明确耗尽输出额度 | 迁移不承诺解决模型本身的截断；必须评估审校思考设置、报告复杂度及模型专属策略 |
| 草稿保留，但真实 Run 在总截止时间处失败，`recovery=null` | 不能把独立审校重测或单元测试当作原 Run 恢复成功；需覆盖总时限处的阶段恢复 |

因此，本需求首先解决调用责任、持久化、契约和恢复边界。模型内容质量、篇幅遵循、输出截断分别验收；不能宣称迁移或 Structured Output 可以保证整章创作成功。已有修复作为迁移前必须保留的基线，不作为待迁移后才解决的问题。

## 2. 架构决策（沿用 v0.1 方向，v0.2 澄清边界）

1. Python Runtime 逐步承接 Agent 模型调用、结构化输出、Prompt/上下文编排、模型级错误标准化和观测能力。
2. LangGraph 只负责有状态、多步骤、需要重试、审批、暂停或恢复的工作流；单次模型能力实现为普通 Python Service，不为使用 LangGraph 而强行包装成单节点图。
3. Electron Main 继续拥有 AI 设置、小说业务数据库、文件、RAG 业务索引、工具权限、DraftSession、DraftBatch、正式写回和原子事务边界。
4. 现有 Electron AiService、HTTP Provider、MCP CLI Provider 和传统写作入口首期保持可用，不实施一次性切换。
5. Chat Completions 与 Responses API 是协议模式，不是 LangGraph 模式。两种协议必须由 Python ModelGateway 适配为统一模型接口，同一张 Graph 不感知底层协议。
6. `ChatDeepSeek` 只是 Provider 专用适配器之一，不能作为所有 OpenAI-compatible 或 Responses 服务的总适配器。
7. 迁移按 `sourceMethod` 独立开关；Run 固定按方法展开的 `modelRoutingSnapshot`。一次模型调用只有一个 owner，同一 Run 可以混用 Electron 正文与 Python 审校，不允许执行中途静默改路由。
8. 回退只允许在路由冻结前、能证明请求尚未发出且已配置兼容旧路径时决定。请求已发出或结果未知时不得自动换 owner 重发；同 owner 的有限恢复另按第 13 节执行。
9. Python 请求执行器统一拥有已迁移调用的重试与额度恢复；LangGraph 负责调度和持久化决策，不能与 Service、SDK 同时各重试一轮。保留路径仍由原执行方拥有内部策略，外层必须尊重其停止标记。
10. Provider 原生 Structured Output 是前置约束，Pydantic 契约校验、领域校验、原始结果持久化和有限修复仍是最终边界。
11. 写工具和正式数据写回不因模型迁移而进入 Python 直写；仍通过受控 Automation Tool、审批、稳定幂等键和持久化 Operation 完成。
12. 第一批只迁移无小说业务写副作用、结构化输出明确的 Agent 方法；模型调用仍有费用与本地结果存储。长正文生成、RAG/Embedding、图片生成和传统编辑器 AI 后续单独评估。

## 3. 目标

- 减少 Agent 模型调用中的 JSON 格式、字段类型、工具参数和跨进程契约错误。
- 让模型调用、LangGraph 节点、重试、取消、Checkpoint 和观测形成统一链路。
- 同时支持现有设置中的 Chat Completions 兼容模式和 Responses API 模式。
- 使用 Pydantic 作为已迁移 Agent 方法的权威结构化输出定义，并派生 Provider Schema 和跨语言契约。
- 在模型结果完整返回后先持久化，再进行解析、领域转换和 Artifact 发布。
- 保证重试次数、总 Deadline、取消和流式状态在 Python 侧可观察、可测试，包括混合 owner 的调用汇总。
- 保持 Electron 的数据库、RAG、文件、草稿和事务能力不变。
- 支持按方法灰度、快速关闭 Python 路径，并且不影响旧 Run 和传统写作入口。
- 用真实失败样本和分阶段指标证明迁移是否降低错误，而不是以完成代码搬运作为成功标准。

## 4. 非目标

- 本需求不将 Prisma/SQLite 小说业务库迁到 Python。
- 本需求不允许 Python 直接修改正式章节、角色、世界观或其他小说数据。
- 本需求不一次性迁移全部 AiService。
- 本需求不立即迁移 RAG 索引构建、Embedding、图片生成和文件保存。
- 本需求不要求将所有单次模型调用包装成 LangGraph。
- 本需求不使用通用 `create_agent()` 替换当前 `StateGraph`、Toolchain、审批和 Operation 设计。
- 本需求不以 Provider 的会话 ID 或 `previous_response_id` 取代本地 Conversation、Run 和 LangGraph Checkpoint。
- 本需求不默认启用自动 Provider/模型切换。
- 本需求不删除 Electron 旧 Provider，除非所有调用方完成迁移并经过单独清理评审。

## 5. 术语

### 5.1 ModelGateway

Python 侧统一模型访问层，对上提供文本、结构化输出、工具调用和流式生成接口，对下适配不同 Provider 与协议。

### 5.2 Model Adapter

连接某个 Provider/协议的实现，例如：

- DeepSeek Chat Completions Adapter；
- OpenAI Chat Completions Adapter；
- OpenAI Responses Adapter；
- Custom OpenAI-compatible Adapter；
- Custom Responses-compatible Adapter。

### 5.3 modelOwner

一次模型调用的执行方，不是整个 Run 的单值属性：

- `python`：由 Python ModelGateway 调用；
- `electron`：由既有 Electron AiService 调用。

Run 使用 `sourceMethod -> route` 的冻结快照；调用保存所选 route ID。`modelOwner` 也决定模型结果引用的解析方，不改变业务数据的所有权。

### 5.4 sourceMethod

现有 Agent Automation 方法标识，例如 `agent.generate_plan`。迁移开关、契约、指标和回滚均以该稳定标识组织。

### 5.5 Provider 请求已发出

指请求字节已经交给网络客户端、CLI 子进程已经接收请求，或无法证明请求未离开本地调用方。进入该状态后，不允许因为适配失败或响应未知而静默切换旧实现重发。

## 6. 当前边界与目标边界

### 6.1 当前边界

```text
Renderer
  -> Electron IPC
  -> Python Runtime / LangGraph
  -> Electron Automation
  -> AiService
  -> Provider
```

### 6.2 目标边界

```text
Renderer
  -> Electron IPC / Python Runtime Client
  -> Python Agent Runtime
       |- LangGraph workflows
       |- Python AI services
       |- ModelGateway
       |- Pydantic contracts
       |- model result persistence
       `- retry / timeout / telemetry
  -> Electron Automation Tools
       |- Prisma / SQLite
       |- RAG query and index
       |- files and attachments
       |- Draft Operation
       `- atomic commit / version checks
```

Python 负责 Agent AI 控制面；Electron 负责本地业务执行面。两者通过已有认证的 localhost Automation 协议通信。

## 7. 迁移范围

### 7.1 优先迁移到 Python

- Agent 文本模型 Provider 调用。
- Agent Structured Output。
- Agent Prompt 模板和与图节点紧密相关的上下文编排。
- 模型消息标准化。
- Tool Call 结构解析和参数校验。
- Token/输出预算。
- 首字节、流空闲和总 Deadline。
- 模型调用取消。
- Provider 错误标准化。
- 模型调用结果、Token、耗时和响应 ID 记录。
- Writer、Editor、Reader、Worldbuilding、Research 等模型型 Toolchain 节点。
- Agent 对话探索中的模型决策。

### 7.2 保留在 Electron

- AI 设置 UI 与当前设置持久化。
- 小说、卷、章节、角色、物品、世界观等业务数据。
- Prisma/SQLite 访问。
- RAG 索引与检索服务首期实现。
- 文件与附件读取。
- DraftSession、DraftBatch、DraftGenerationOperation。
- 乐观锁、唯一约束、CAS、Outbox 和原子提交。
- 工具权限、用户审批和正式写回边界。
- 传统写作模式现有 AI 调用。
- Electron AiService 旧模型路径和现有兼容 Provider。

### 7.3 延后评估

- 普通标题生成。
- 传统章节续写入口。
- 非 Agent 小说问答。
- RAG 文档切片、Embedding、向量检索和 Rerank。
- 图片生成和图片资产保存。
- MCP CLI Provider 的 Python 原生重写。

## 8. Python ModelGateway 需求

### 8.1 目录建议

```text
agent_runtime/novel_agent_runtime/
  models/
    settings.py
    capabilities.py
    gateway.py
    errors.py
    result.py
    adapters/
      chat_completions.py
      responses.py
      deepseek.py
      custom_openai.py
  contracts/
    chat.py
    planning.py
    chapter.py
    review.py
    research.py
  prompts/
  model_result_store.py
```

具体目录可在实现评审时调整，但模型适配、业务 Prompt、输出契约和 LangGraph 节点不得重新耦合在单个大型文件中。

### 8.2 统一接口

ModelGateway 至少提供：

```python
class ModelGateway:
    async def invoke_text(self, request: TextModelRequest) -> ModelResult: ...
    async def invoke_structured(self, request: StructuredModelRequest[T]) -> StructuredModelResult[T]: ...
    async def invoke_tools(self, request: ToolModelRequest) -> ToolModelResult: ...
    async def stream_text(self, request: TextModelRequest): ...
```

LangGraph 节点只依赖 ModelGateway 或更窄的业务 AI Service，不直接实例化 `ChatDeepSeek`、`ChatOpenAI` 等 Provider 类。

### 8.3 统一请求

请求至少包含：

- `operationId`；
- `requestId`；
- `runId`、`stepId`、`nodeId`（存在时）；
- `sourceMethod`；
- messages；
- 输出类型或 Pydantic Schema；
- 输出 Token 预算；
- temperature；
- deadline；
- cancellation signal；
- model config version；
- route ID、能力档案版本、Prompt/上下文策略版本；
- 逻辑请求键、attempt ID、重试原因及共享预算账本引用；
- 经过能力校验的 thinking/reasoning 参数（可选）；
- tool definitions（仅工具调用请求）；
- prompt/context diagnostics 引用。

### 8.4 统一结果

结果至少包含：

- `modelResultRef`（完整结果必须已保存；`raw` 仅作受控读取，不代替引用）；
- `parsed`；
- `parsingError`；
- Provider；
- protocol；
- model；
- Provider response ID；
- finish reason；
- input/output/total Token；
- reasoning Token、可见输出统计（Provider 提供时）、usage 来源及是否为估算；缺失不能记为零；
- elapsed time；
- attempt number；
- schema ID 和版本；
- result hash。

大型正文不进入 LangGraph Checkpoint，只保存结果引用和摘要。

### 8.5 任务预算与现有写作策略兼容

- 保留完整章节默认 2300 汉字、范围 2070—2530，续写一段默认 500；明确范围与作品设置优先级、重写沿用原篇幅、一次篇幅调整及失败保留原稿，均按现有写作策略验收。
- 正文自动首次额度保持 18432；审校现有 8192→16384 仅作为待比较基线，不能直接称为已验证的稳定默认。先试验受支持的思考设置、精简报告或明确的分维度审校，再决定是否调整模型专属额度。
- 能力档案分别记录模型上下文上限、最大输出、思考参数与输出计量语义；产品 32768 单次安全上限、用户手动上限、上下文余量是独立约束。不得用上下文容量的比例猜测模型输出能力。
- 预算按 `sourceMethod + provider/protocol/model + reasoning profile` 解析，形成版本化有效策略；既有手动设置不静默提高。模型不支持的思考参数不得照搬其他 Provider 的枚举，也不能假定降低 temperature 会减少思考。
- 每个逻辑请求共用一个 Provider 尝试计数：网络重试、截断增额、模型结构修复和篇幅修正均计入，不是各自拥有一份总次数。迁移后初始总上限为 4 次（沿用现有 `MAX_ATTEMPTS` 数值，但要求统一计数，不代表当前跨层已经统一）；截断增额、结构模型修复、篇幅修正各最多一次，并受更小的任务上限约束。
- 阶段额度和整个 Run 额度分开，后者覆盖正文、审校、修订等模型请求；并发调用先原子预留额度，结束后结算。未知 usage 保留估算及来源，不能当作零消耗释放预算。
- Run 启动前按有效任务策略及允许的模型节点次数解析并保存有限的 `runMaxProviderAttempts`、`runMaxOutputTokens`；新增分支使用剩余额度，不自动扩容。这里的输出额度不等于上下文输入估算 `maxEstimatedTokens`；输入 Token 与费用另行汇总。Phase 0 固定各任务策略及计算 Fixture，不能只记录元数据却不执行限额。
- 审校策略有变更时，必须先对保存草稿试验，避免为验证审校而反复生成正文。字数达标不等同于内容审校通过。

### 8.6 网络与发行兼容

配置快照必须包含经脱敏描述的代理模式、超时策略、必要的自定义 Header/组织参数及其凭据引用。Python 出站行为需与 Electron 的直连、系统/手动代理及 TLS 配置逐项对照，不能无说明地改用 SDK 环境变量默认值。保持证书验证，不用关闭 TLS 验证解决兼容问题。

当前 Python 已有 `httpx`、Pydantic 与 LangGraph，尚未依赖 LangChain 模型集成包。SDK 选择应在 Adapter 验证后决定，允许直接使用异步 HTTP；如新增包，锁定验证过的版本并提前验证项目支持平台的 PyInstaller 打包、证书、离线启动及旧路径回归，不把这些工作留到清理阶段。

## 9. 双协议适配

### 9.1 协议枚举

Python 必须与现有设置保持一致：

```python
class ApiMode(StrEnum):
    CHAT_COMPLETIONS = "chat-completions"
    RESPONSES = "responses"
```

Graph State 不保存 Provider SDK 对象，只保存稳定、可序列化的协议和配置版本标识。

### 9.2 Chat Completions

- DeepSeek 官方 Chat 模式优先使用 `ChatDeepSeek` 或经过验证的专用 Adapter。
- 标准 OpenAI-compatible Chat 模式可使用 `ChatOpenAI(use_responses_api=False)` 或自定义 Adapter。
- 非标准 Provider 字段只有在专用 Adapter 明确支持时才进入统一结果。
- 模型是否支持 Tool Calling、Structured Output 不能仅根据协议推断。

### 9.3 Responses API

- OpenAI 官方 Responses 可使用 `ChatOpenAI(use_responses_api=True)`。
- 第三方 Responses-compatible 服务必须经过契约测试，不假定完全兼容。
- DeepSeek Responses 若 Provider 专用 LangChain 包未覆盖所需语义，使用独立 Adapter 或经契约测试的兼容客户端，不强行复用 Chat 模式实现。
- Adapter 必须处理流终态、失败终态、输出截断、usage、response ID 和 Provider 特有内容块。
- Responses 只有明确 `response.completed` 才是完整成功；`output_text.done`、`[DONE]`、已有文本后 EOF 均不能替代终态。`incomplete` 和 `failed` 保存证据但不发布为完整模型产物。Chat 模式按其终止原因单独验证，`length`、未完成工具参数和拒绝响应不能当作成功 JSON。
- Provider 的服务端会话状态只能作为优化，LangGraph Checkpoint 和本地 Conversation 仍是权威状态。

截至本次审阅，DeepSeek Responses 文档明确不支持 `previous_response_id`、`conversation` 和 `store`；不能假定凭 response ID 一定能取回丢失响应。部分参数会被忽略，因此 HTTP 200 不代表参数生效。适配以实际端点与模型验证，不将测试中的模型名称自动替换为文档当前别名。[官方兼容说明](https://api-docs.deepseek.com/guides/responses_api/)

### 9.4 URL 兼容

当前 UI 允许用户填写根地址或完整端点地址。Python Adapter 必须兼容并规范化：

- 根地址；
- `/v1` 根地址；
- 完整 `/chat/completions`；
- 完整 `/responses`。

SDK 需要 Base URL 时必须移除已填写的具体端点后缀，禁止拼出重复路径。

### 9.5 能力矩阵

每个运行配置必须得到显式能力描述：

```python
CapabilityState = Literal["supported", "unsupported", "unknown"]

class ModelCapabilities(BaseModel):
    chat_completions: CapabilityState
    responses: CapabilityState
    streaming: CapabilityState
    structured_output: CapabilityState
    strict_schema: CapabilityState
    tool_calling: CapabilityState
    reasoning: CapabilityState
    previous_response_id: CapabilityState
    response_retrieval: CapabilityState
    context_window_tokens: int | None
    max_output_tokens: int | None
    reasoning_options: dict[str, object]
    schema_dialect: str | None
    source: str
    profile_version: str
    verified_at: str | None
```

能力证据包括：

1. Provider 专用 Adapter 的已知能力；
2. 项目维护的模型能力清单；
3. 设置中的显式兼容声明；
4. 受控连接测试结果。

不能把一次连接成功等同于 Structured Output 或 Tool Calling 可用。

能力必须绑定端点、模型和 Adapter 版本；以匹配范围、验证日期和实际契约测试解决冲突，而非机械地用列表顺序覆盖。用户兼容声明属于未验证输入，不得压过明确的不支持证据。`unknown` 必须选择可验证的保守路径或预检拒绝，不能自动当作支持。能力来源变化需产生新版本，不能静默影响旧 Run。

## 10. 配置和密钥边界

Electron 继续拥有 AI 设置页面和设置持久化。Python 在 Run 开始前通过认证的本地接口获取配置快照。

要求：

- API Key 不得作为 Python 命令行参数。
- API Key 不得写入 LangGraph State、Checkpoint、Run 事件或普通日志。
- Python 默认只在内存中持有解密后的 API Key。
- 非密钥配置快照由 Electron 持久化并可按版本读取；Python 重启后用 `credentialRef` 从 Electron 重新获取仍有效的凭据，不能只依赖丢失的内存快照。不得通过返回“最新配置”冒充旧配置版本。
- 日志、异常、请求预览和遥测统一脱敏 Authorization、API Key 与用户凭据。
- 每个 Run 保存不含密钥的 `modelConfigVersion`、Provider、protocol 和 model。
- 设置变更默认只影响新 Run；运行中的 Run 固定原配置快照。
- 若旧配置因撤销或失效无法继续，应产生明确配置错误，不静默切换模型。
- Electron 配置接口不可用时，只能使用已验证且未过期的内存快照；无快照则阻止新模型请求。
- 配置/凭据接口仅供受认证 Runtime 引导与恢复使用，不进入模型可调用工具清单；模型无权修改设置。凭据撤销立即生效，固定快照不能绕过撤销。旧配置不可用时给出“等待配置”恢复动作，由用户显式创建新 Recovery Run 选择新配置。

## 11. Structured Output

### 11.1 权威契约

已迁移 `sourceMethod` 的结构化输出以 Python Pydantic Model 为权威定义，并派生：

- Provider JSON Schema；
- 本地 Pydantic 校验器；
- Electron 兼容 JSON Schema Artifact；
- Prompt 中的必要格式说明；
- 测试 Fixture；
- 修复请求 Schema。

过渡期 Electron 旧实现继续使用原 Contract，但必须保持相同 `contractId/version`，并通过生成物或契约一致性测试防止漂移。

只有语义等价的契约才可以保留同一版本；必填字段、默认值、额外字段处理或领域含义改变时必须升级版本并保留兼容读取。发布成功还需使用 Electron 自己的实时数据和权限校验，不能因为 Python 已校验一次而绕过正式写回边界。

### 11.2 分级策略

下列层级用于**发出请求前选择一种支持的输出约束模式**，不是失败后依次重发模型请求的流水线：

```text
预检选择：json_schema / strict function / json_object / Prompt JSON
  -> 单次 Provider attempt
  -> 终态检查与原始结果持久化
  -> 解析（必要时一次确定性 JSON 修复）
  -> Pydantic 完整校验与领域语义校验
  -> 必要时一次定向模型修复，再持久化与校验
  -> 成功，或带结果引用的明确错误
```

- Provider 原生约束不取代本地校验。
- Schema 不支持可以在预检时选择低一级模式；请求发出后的不支持错误应更新能力证据并停止，不能在同一调用中偷偷换模式重试。显式新请求按新的能力版本执行。
- `MODEL_OUTPUT_TRUNCATED`、`STREAM_INCOMPLETE`、Provider refusal 和 `MODEL_OUTPUT_INVALID` 分开处理。截断响应不能通过补括号、填默认业务字段而伪装成完整任务结果；合法 JSON 同样必须先通过协议终态检查。
- 原始响应应在 SDK 自动解析/校验之前被可靠捕获。若 SDK 只有解析后结果或解析失败会丢弃原文，不能将其作为首批 Adapter；`include_raw` 之类选项本身不替代持久化验证。
- TypedDict 只适用于无需运行时约束的简单响应；正式 Agent 业务输出优先使用 Pydantic。
- Provider strict Schema 与业务完整 Schema 可以不同。Adapter 可以生成受限 Provider Schema，但返回后必须使用完整业务 Schema 再校验。
- 自动模型修复最多一次，且只允许修复结构和字段映射，不得重新执行原创作任务。
- 修复失败后必须保留原始响应、修复响应和全部校验问题。

### 11.3 语义校验

结构合法不代表业务合法。下列内容必须在模型返回后由代码检查：

- novelId、volumeId、chapterId 是否存在且归属正确；
- Evidence ID 是否可回查；
- Tool/Toolchain 是否在白名单；
- 章节范围是否超过授权；
- generation revision、expectedVersion 是否匹配；
- requested effect 和 deliverable 是否符合当前工作模式；
- 写操作目标是否仍为用户确认的目标。

### 11.4 Prompt 与上下文迁移

Phase 0 为每个方法列出当前 Prompt、Schema、上下文装配、Token 计数、RAG 查询及业务字段转换依赖。冻结 Prompt/上下文策略版本及输入来源引用，防止只是复制 AiService 方法体而遗漏保护规则。

迁移必须保留当前请求、审批决定、篇幅目标、章节顺序、原文/摘要新鲜度、Evidence 与草稿来源的语义；Python 获取 Electron 上下文时使用带版本与来源的 DTO，不通过模型消息传密钥或任意读取业务库。必要输入不能为通过预算校验而静默裁掉；无法装入时返回明确的上下文错误。

用相同固定输入分别比较两端有效 Prompt、引用范围、计数与参数。策略优化与语言迁移分别记录变更；先复现旧策略，再做思考/报告策略对照，避免把不同 Prompt 的效果混算成迁移收益。

## 12. LangGraph 接入要求

### 12.1 ModelGateway 与 Graph 解耦

单次能力以普通 Service 提供：

```python
class ChapterBeatService:
    async def generate(self, request: ChapterBeatRequest) -> ChapterBeatResult: ...
```

传统入口和 LangGraph 节点都可以复用该 Service。Graph 负责状态和路由，不承载 Provider 细节。

### 12.2 图节点粒度

至少隔离以下可恢复阶段；不要求机械地一阶段对应一个图节点：

- 上下文准备；
- 模型请求及接收端原始结果落盘（同一请求执行器的完成边界）；
- 结构解析与领域校验；
- Artifact/Draft 发布；
- 异步写 Operation 等待。

模型生成和业务写回不得放在同一个可自动重试节点中。

模型请求节点只有在完整结果及引用已持久化后才能返回成功。禁止“节点 A 返回整份响应、节点 B 才落盘”的设计：它既会让大响应进入 Checkpoint，也会留下 A 已执行但结果不可恢复的窗口。Graph 重放先用稳定逻辑请求键查本地调用账本和结果，不应直接再发模型请求；Graph Checkpoint 本身不能保证远端请求 exactly-once。

正文生成、正文发布、编辑审校、按意见修订必须有分别可恢复的执行位置。审校已成功而修订失败时，复用保存的审校报告；审校失败时复用草稿，不能将两者包在重试时会全部重做的单个阶段中。

### 12.3 探索图

探索图迁移后可以使用统一消息和 Tool Call，但首期不强制把 State 改造成 `MessagesState`。

- 只读工具可以绑定给模型。
- 模型生成的工具名和参数必须再次经过本地白名单与 Pydantic 校验。
- 写工具不得因 `bind_tools()` 而自动执行。
- 每个只读工具继续保持单独 Checkpoint 和重试粒度。

### 12.4 Checkpoint

Checkpoint 保存：

- 执行游标；
- 决策和必要中间状态；
- modelResultRef；
- draftOperationId；
- schema/config 版本；
- 可恢复的错误描述。

Checkpoint 不保存：

- API Key；
- 大型完整正文；
- Provider SDK 对象；
- 数据库连接；
- 不可序列化回调。

## 13. 重试、超时和取消

### 13.1 单一重试责任

- 已迁移请求通过统一 Python 请求执行器进入现有请求图/RetryPolicy；ModelGateway Adapter 的一次调用只执行一次 Provider attempt。普通 Python Service 同样复用该执行器，不另写重试循环，也无需为每个能力单独建立业务图。
- LangChain/Provider SDK 显式设置 `max_retries=0`，外层业务 Graph 不再次重试已由请求执行器管理的整个模型阶段。
- 下层明确 `retryable=false`、取消、恢复额度耗尽等停止条件优先于 `PROVIDER_TIMEOUT`、`NETWORK_ERROR` 等通常可重试的错误码。
- 截断增额和结构修复是带原因、带次数上限的恢复分支，不靠通用 RetryPolicy 重跑原节点实现。它们与网络重试共享第 8.5 节账本及剩余时间。
- 迁移期 Electron 内部仍可执行其已有有限恢复；Python 必须消费其实际 attempt 和结束原因，不给该方法叠加一套完整自动重试。每种路由在实施清单中标明责任方。
- SDK 如果不能禁用或精确观测实际重发，不满足首批 Adapter 验收条件；不能把多次出站请求算成同一个 attempt 来声称没有重试放大。

### 13.2 可重试范围

可自动重试：

- 明确发生在请求发送前的连接失败；
- 限流且允许重试；
- Provider 暂时不可用；
- 首字节超时必须先确定是否已经发送请求；没收到响应不等于服务端没有执行。已发送且结果未知时进入对账/显式新请求流程，不默认盲重发；
- 明确可重放的只读工具失败。

不可自动重试：

- 用户取消；
- 鉴权或配置错误；
- 业务 Schema/版本冲突；
- 已得到完整模型结果后的本地解析或发布失败；
- 写副作用结果未知；
- 无法证明安全重放的流式中断。

明确的输出额度截断是独立恢复情形：仅在同 owner、同模型/协议、未发布完整结果且操作不包含未经控制的写工具执行时，允许按预算增额一次。保留原 attempt 的片段、终态和用量；增额请求不是“原响应续传”，实际成本独立计入。能力不支持查询原响应时，不宣称可以凭 response ID 完成对账。

### 13.3 Deadline

- Run 有活动执行总时限；阶段 Deadline 不得晚于 Run Deadline。每次请求取阶段剩余时间、Run 剩余时间及当前阶段上限的最小值；重试不会重置原阶段时限。
- 连接、首字节、流空闲、模型修复和本地处理共享阶段预算；首字节、首个可见输出和 reasoning 活动分别计时，不能将有思考输出误判为完全无响应。
- Adapter 不得在每层重新创建完整超时预算。
- 自动修复只能使用剩余预算。
- 保留当前基线：正文默认共享 5 分钟；审校共享 5 分钟，Electron 审校 Automation 为 330 秒、Python 工具传输为 360 秒；Run 当前默认活动时限 10 分钟。这些是待测策略，不是三个可累加的执行时长。Python 直调路径只保留必要的传输余量。
- `waiting_approval` / `waiting_user_input` 不消耗模型活动预算；进入等待前持久化已耗用额度和剩余执行时间，恢复不赠送新的完整预算。后台模型或 Operation 仍在运行的等待状态不能借此暂停计费/超时。
- 进程重启后的运行时间口径必须明确；除已确认的用户等待外，离线间隔默认仍受持久化截止时间约束。已过期运行保留结果并给出恢复动作；用户发起 Recovery Run 才创建新的执行预算，历史用量不清零。

### 13.4 取消

- 用户取消必须传播到 LangGraph task、ModelGateway、SDK/HTTP stream 和必要的 Tool request。
- 取消期间收到的模型完整结果可以先安全落库，但不得自动继续发布业务产物。
- 已开始的持久化草稿 Operation 按既有 Operation 取消和对账语义处理。

## 14. 模型结果持久化和恢复

### 14.1 Python 所有的模型调用

Python 发起的调用必须在严格解析、领域转换和 Artifact 发布前保存完整原始结果。发出请求前先建立持久化调用记录，状态至少区分 `prepared`、`dispatch_started`、`receiving`、`result_saved`、`incomplete`、`outcome_unknown`、`cancelled`；进程重启不能把 `dispatch_started` 当成“尚未请求”。

建议记录：

- modelResultRef；
- sourceMethod；
- run/step/node/request/attempt ID；
- Provider、protocol、model；
- schema ID/version；
- raw content 或受控 Blob 引用；
- response ID；
- finish reason；
- usage；
- result hash；
- createdAt；
- processing status/revision；
- repair ancestry。
- 能力、Prompt、上下文策略及路由版本；
- 原始参数快照引用、输入哈希、完整性标志、错误证据和 attempt 预算结算状态。

Python 模型结果可以存入 Python Runtime 自有 SQLite。Electron 旧模型调用继续使用现有 ModelResultStore。每次调用只能有一个 owner，恢复器根据 `modelOwner` 和引用解析，不允许双写后互相猜测权威版本。

### 14.2 结果引用与崩溃窗口

- `modelResultRef` 至少包含 owner、ID、revision、hash、contract ID/version；不得直接依赖跨进程文件绝对路径或仅靠一个无命名空间的字符串。
- 稳定逻辑请求键包含 Run/步骤/节点及逻辑请求序号，attempt ID 独立生成；同一节点重放查同一逻辑键。并发恢复用 CAS/租约限制发布和模型请求的重复发起。
- 完整响应落盘及 `result_saved` 状态必须在接收端原子关联；落盘成功后、Graph Checkpoint 前崩溃，恢复只查结果而不重调模型。
- 远端已完成、本地尚未保存就崩溃的窗口无法仅靠 LangGraph 消除：用受控流式暂存尽量缩小，缺乏明确终态或可查询结果时保留 `outcome_unknown`，不能许诺自动恢复原响应。
- owner 提供受认证的结果读取/重新处理接口。已有 Electron `agent.reprocess_saved_structured_output` 等恢复入口要按 owner 分发；Python 结果不可交给旧 Electron Store 猜测读取。跨端发布只传经校验的业务产物及来源引用，发布失败仍由原 owner 重处理。
- 结果删除、备份、Schema 升级和清理策略必须保护活动 Run、待审核草稿及其恢复引用；原始私有内容只进入受控本地结果存储，不进入普通日志或默认外部追踪。

### 14.3 恢复原则

- 模型结果已完整保存、解析失败：复用保存结果重新处理，不重调原模型。
- 结构修复成功、发布失败：复用修复结果继续幂等发布。
- 请求结果未知：根据 Provider response ID、调用账本和状态能力对账；不能确认时失败关闭。
- Graph 恢复时必须核对 `sourceMethod`、schema version、config version 和 result hash。
- 旧 Electron Run 继续使用旧恢复路径，不因新版本上线强制改写历史 owner。
- 正文已保存而审校遇到 Provider 失败、格式失败、预算耗尽或 Run 总时限失败时，都应保留源草稿 ID/版本/hash，给出与实际故障匹配的“重试审校 / 修复结果 / 等待配置”动作。测试覆盖总截止时间在审校等待中发生，不能只测正常异常处理分支。
- 恢复必须重新核对草稿版本及正式章节 expectedVersion。旧版本已变更时停止自动续跑；新 Recovery Run 保留原 Run 的失败、部分成功和实际用量，不回写历史成功状态。

## 15. 兼容、灰度与回滚

### 15.1 方法级路由

至少支持：

```json
{
  "pythonModelRouting": {
    "agent.detect_creative_direction": true,
    "agent.summarize_user_input": true,
    "agent.generate_chapter_beats": false
  }
}
```

路由能力必须可按以下维度约束：

- sourceMethod；
- Provider；
- protocol；
- model；
- 应用版本或灰度组。

### 15.2 Run 固定路由与版本兼容

Run 创建时保存：

```json
{
  "modelRoutingSnapshotVersion": 1,
  "routes": {
    "chapter.generate_draft": {
      "owner": "electron", "configVersion": "cfg-7", "contractVersion": "chapter-v1"
    },
    "agent.generate_consistency_review": {
      "owner": "python", "configVersion": "cfg-7", "contractVersion": "review-v1"
    }
  }
}
```

示例版本名仅表示结构。每个 route 还必须引用 Provider、protocol、model、Adapter、能力及 Prompt/上下文策略版本；非 Run 调用保存相同的请求级快照。动态发现但快照未覆盖的方法不能采用“当前最新开关”偷偷决定 owner。

设置或 Feature Flag 变化只影响新 Run。旧 Run 恢复沿用原路由；缺少快照的历史 Run 明确解释为旧 Electron 路径。旧契约/Prompt 处理器无法再提供时，进入版本不兼容状态或经显式迁移建立 Recovery Run，不能只凭版本字符串宣称可恢复。支持的旧版本保留期与清理条件在切换前确定。

### 15.3 回退限制

路由冻结前，且该方法已配置兼容旧实现时，允许预检选择 Electron 的情况：

- Python Adapter 未安装；
- Python 专有依赖/能力预检失败，且旧路径能满足同一契约与授权；共享的鉴权、配置错误不能靠回退掩盖；
- 能力检测明确不支持且请求尚未发出；
- Schema 在 Provider 请求构造前被判定不兼容。

禁止自动回退的情况：

- 请求已经发送；
- 已收到任意响应字节；
- 流中断；
- Provider 返回未知终态；
- 模型完整返回但本地处理失败。

禁止把“Python 调用失败后 Electron 再试一次”作为通用容灾方案。

Python Runtime 同时承担 Agent 编排；Runtime 整体不可用时，不等于 Electron 能接管整张 Agent Graph。此时阻止新 Agent Run 并提示恢复 Runtime；传统写作入口可继续使用其既有 Electron 路径，但不是 Agent Run 的透明降级。

## 16. 分阶段实施

### Phase 0：基线和失败样本

工作量：2–3 人日。

- 统计当前各 `sourceMethod` 的成功、超时、取消、结构错误、修复和发布失败。
- 汇总脱敏后的真实失败模型结果和 Prompt Fixture。
- 建立 Chat Completions/Responses 双模式假 Provider。
- 固定迁移前错误率、延迟、Token 和尝试次数基线。
- 建立真实调用清单：`sourceMethod -> Python 调用点 -> Electron 方法 -> Schema/Prompt -> 上下文依赖 -> 内部重试 -> 结果 Store -> 发布方`。覆盖 HTTP 与 FastMCP，核对首批三种方法及其隐藏的模型调用。
- 将第 1.1 节的正文成功、审校 8K/16K 截断、截止时间丢失恢复入口与叠加重试作为固定故障场景；区分已观察故障和待实现目标。

交付物：指标基线、回归 Fixture、错误分类报告。

### Phase 1：Python ModelGateway 骨架

工作量：5–8 人日。

- 增加统一请求/结果/错误模型。
- 实现 Chat Completions 和 Responses Adapter。
- 支持 DeepSeek Chat、标准 OpenAI 和 Custom compatible 配置。
- 实现 URL 规范化、能力矩阵、Deadline、取消和基础流处理。
- 关闭 SDK 自动重试，接入现有 RetryPolicy。
- 不接生产方法。
- 验证拟选 SDK 的原始结果获取、重试关闭、流终态和本地发行打包；不满足边界时选直接异步 HTTP Adapter，不因文档示例使用某 SDK 就强制依赖它。

交付物：ModelGateway、Adapter 单元测试、双协议契约测试。

### Phase 2：配置桥、Structured Output 与结果存储

工作量：5–8 人日。

- 增加仅供 Runtime 使用的认证配置快照读取和凭据解析协议；设置修改仍由 Electron 既有授权入口负责。
- 实现密钥内存持有与日志脱敏。
- 建立 Python Pydantic 契约、Provider Schema 转换和契约导出。
- 实现原生 Structured Output、降级策略、本地校验和一次定向修复。
- 实现 Python model result 持久化和 reprocess。
- 实现跨 owner 的结果引用协议、调用账本、并发预留与发布幂等，以及旧 Run 配置/契约版本的恢复路径。

交付物：结构化调用闭环、契约一致性测试、结果恢复测试。

### Phase 3：首批无业务写副作用方法

工作量：5–8 人日。

首批：

1. `agent.detect_creative_direction`；
2. `agent.summarize_user_input`；
3. `agent.generate_chapter_beats`。

- 增加方法级 Feature Flag。
- 保留 Electron 旧路径。
- 新 Run 固定方法路由快照，先验证同一 Run 的混合 owner。
- 对比迁移前后结构成功率、耗时和 Token。

交付物：首个生产纵切、按方法关闭和回滚能力。

### Phase 3b：保存草稿审校试点

从 Phase 4 提前抽取 `agent.generate_consistency_review` 作为受控试点，工作量计入 Phase 4，不重复累加。不提前迁移正文或正式写回。

- 固定保存草稿、前文、模型和输入要求，对照旧实现与 Python 实现的有效策略；先使用本地 Fixture 验证边界，真实请求分组串行计量，不默认双端同时发模型作为“影子流量”。
- 分别记录思考用量、可见报告长度、完整终态、首次通过和恢复后通过；对 8K/16K 失败单独归因，不能用修复后的 JSON 成功掩盖原报告不完整。
- 验证 Electron 生成草稿 → Python 审校 → Electron 保存/按意见修订的混合链路。审校成功后修订失败、审校期间总截止时间到达、旧草稿版本已变更均需有正确恢复动作。
- 试点通过才扩大评审迁移；失败时保持方法开关关闭，并将模型策略问题与迁移实现问题分别记录。

### Phase 4：计划与评审方法

工作量：8–12 人日。

迁移：

- `agent.generate_plan`；
- `agent.revise_plan`；
- `agent.generate_report`；
- `agent.generate_consistency_review`；
- `agent.generate_editor_range_review`；
- `agent.generate_writer_range_revision_plan`；
- `agent.generate_reader_chapter_evaluation`；
- `agent.generate_worldbuilding_range_consistency`；
- `agent.extract_research_claims`；
- `agent.generate_research_fact_check`；
- `agent.generate_scope_audit`；
- `agent.generate_plotline_analysis`。

重点验证多专家部分成功、只重试失败节点、Evidence ID 可回查和 Supervisor 综合稳定性。

### Phase 5：探索图模型调用

工作量：6–10 人日。

- 将 `AgentExplorationGraph` 的 model call 改为 Python ModelGateway。
- 统一 AIMessage/Tool Call 或保留当前 State 并建立明确转换层。
- 只绑定只读工具。
- 保留工具白名单、参数校验、工具调用预算和单工具 Checkpoint。
- 两种协议共享同一张探索图。

交付物：不再通过 `agent.generate_chat` 让 Electron 代调模型的 Python 探索链路。

### Phase 6：长文本与写作生成（可选后续）

工作量：8–15 人日。

评估迁移：

- 章节正文；
- 小说初始化长内容；
- 长报告；
- Skill 文档；
- 多章续写。

必须先完成流中断、输出截断、长上下文、结果暂存、取消和持久化草稿 Operation 验收。模型生成与 Electron 草稿写入保持不同节点。

### Phase 7：稳定运行后清理

工作量：5–8 人日。

- 删除已无调用方的 Electron Agent 模型方法。
- 保留传统写作模式需要的 AiService 能力。
- 收敛重复 Prompt、Schema 和错误映射。
- 更新打包、诊断、开发文档和手动验收清单。
- 清理必须单独评审，不与首次切换同批执行。
- 删除条件必须同时覆盖无在线调用方、无受支持的待恢复旧 Run/草稿引用，以及旧配置/契约保留期结束；仅凭新流量已全部切换不足以删除旧处理器。

## 17. 测试要求

### 17.1 Adapter 契约测试

Chat Completions 和 Responses 分别覆盖：

- 非流式成功；
- 流式成功；
- usage；
- finish reason；
- Provider error；
- 401/403；
- 408/429/5xx；
- 首字节超时；
- 流空闲超时；
- 中途断线；
- 输出截断；
- Responses 文本 delta / `output_text.done` / `[DONE]` 后直接 EOF，不允许误报成功；
- reasoning-only 输出、缺少 usage、完整 JSON 但流终态失败、拒绝与不完整工具调用；
- 被忽略参数不能被误判为能力支持，能力未知及模型/端点变化必须重新预检；
- 用户取消；
- 根 URL 和完整端点 URL。

### 17.2 Structured Output

- Pydantic 嵌套对象、数组、enum、nullable；
- Provider strict Schema 降级；
- Markdown 包裹；
- 非法 JSON；
- 合法 JSON 但字段错误；
- 多余字段；
- 业务 ID 不存在；
- 原始结果保存后解析失败；
- 一次修复成功；
- 修复仍失败；
- 修复不得改写原任务内容。
- 截断不能用确定性 JSON 修复补成“完整报告”；Schema 模式降级不得隐式重发；
- SDK 解析异常时仍能获得并保存未经改写的完整原始响应；
- 契约导出对 nullable、default、extra 字段、枚举和数值边界的语义一致性及旧版本读取。

### 17.3 LangGraph 与恢复

- 只重试失败的模型节点；
- SDK 和 Graph 不发生乘法重试；
- 取消能打断退避和流；
- 模型完整返回、解析前崩溃后可复用结果；
- Artifact 发布失败不重调模型；
- waiting approval 重启恢复；
- waiting operation 重启恢复；
- 未知副作用不自动重放；
- Feature Flag 变化不影响既有 Run。
- provider 已发出但尚未本地落盘时崩溃，标记未知而不盲重发；落盘后 Checkpoint 前崩溃，复用同一结果；
- 下层超时同时携带 `retryable=false`，不启动外层重试；所有增额/修复计入同一总次数与预算；
- 并发节点、重启恢复与手动 Recovery Run 的预算结算不重置、不超额；
- 正文已保存、审校阶段 Run 总截止时间到达，重启后仍有正确恢复入口且不再生成正文；
- 审校已保存、修订失败，只重试修订；源草稿版本变更时停止；
- 审批等待跨天不吞掉用户可用执行预算，后台活动等待仍受时限约束。

### 17.4 兼容回归

- Electron 旧 Agent 方法在开关关闭时继续工作；
- 传统写作模式 AI 不受影响；
- Chat Completions 和 Responses UI 配置保持兼容；
- MCP CLI Provider 旧路径保持可用；
- Python Adapter 预检不可用时可在冻结前选兼容旧方法；Runtime 整体不可用时停止 Agent 启动，不能假装 Electron 已接管 Graph；
- Renderer 的 Run、活动、错误和恢复卡片不因 owner 改变而出现两套语义。
- 单 Run 混合 owner、Python 结果在 Electron 展示/发布、配置版本在双方重启后恢复；
- 旧 Run 缺少路由快照、旧契约仍有引用、方法开关撤回后的历史恢复；
- 代理/TLS/自定义 Header 与现有网络配置兼容；新增 SDK 在项目支持的打包平台中可运行。

## 18. 可观测性

每次模型 attempt 至少记录：

- operation/request/run/step/node ID；
- sourceMethod；
- modelOwner；
- Provider、protocol、model；
- config 和 contract 版本；
- attempt；
- startedAt、firstByteAt、completedAt；
- input/output Token；
- reasoning Token、usage 缺失标记、估算来源、阶段与 Run 预算预留/结算；
- response ID；
- finish reason；
- resultRef/hash；
- parsing/validation/repair 状态；
- error code；
- cancellation reason。
- recovery reason（网络重试 / 截断增额 / 结构修复 / 篇幅修正 / 用户恢复）、父调用及原失败 Run 引用。

禁止记录 API Key、完整 Authorization Header 和未经脱敏的敏感用户内容。

迁移看板至少按 sourceMethod 对比：

- 请求成功率；
- 首次结构化校验成功率；
- 修复后成功率；
- 模型完整返回后的本地失败率；
- 自动重试次数；
- 用户取消完成时间；
- P50/P95 首字节和总耗时；
- 平均 Token 与成本；
- Python/Electron owner 分布。
- 完整终态成功率、输出截断率、结果未知率、保存草稿后审校完成率和一次完整章节流程通过率。

比较时固定模型/协议、Prompt/上下文策略及样本类型；迁移与策略优化分别成组。没有配对样本、usage 或成本来源时标记不可比较，不用空值当作改进。首次运行、自动恢复、用户手动恢复分开统计；日志不得逐 Token 重复打印全文，避免观测本身拖慢桌面主进程。

## 19. 验收标准

### P0：首批上线前必须满足

1. Python ModelGateway 同时通过 Chat Completions 和 Responses 契约测试。
2. 三个首批方法可以按 Feature Flag 独立启停。
3. Run 固定按方法路由与配置/契约/Prompt 版本，同一 Run 混合 owner 可用，运行中不静默切换。
4. SDK 自动重试关闭，Graph 可精确报告实际 Provider attempt 数。
5. 模型完整结果在解析前持久化，解析失败可不重调模型而重新处理。
6. Provider 原生 Structured Output 不取代 Pydantic 和领域校验。
7. 请求发出后禁止自动回退 Electron 重发。
8. API Key 不进入命令行、Checkpoint、事件和普通日志。
9. 取消可以中断模型等待、流处理和重试退避。
10. Electron 旧路径、传统写作模式和草稿 Operation 回归通过。
11. 真实历史 Fixture 经适用的有限修复后得到完整且合法的结果，或明确的错误及匹配的处理动作；不可恢复错误不得伪装成可恢复。截断、流不完整、拒绝响应不能用 JSON 修复当作任务成功。
12. 故障注入下没有重复 Artifact、重复 DraftSession、重复 DraftBatch 或正式正文写回。
13. 模型接收端先保存再返回成功；落盘后 Checkpoint 前崩溃可复用结果，落盘前结果未知不自动重发。跨 owner 引用能稳定解析。
14. 下层 `retryable=false` 能阻止外层超时重试；网络重试、增额和修复共享总次数、Token 账本及剩余时间，并发和重启均不重置。
15. 旧 Run 的无密钥配置快照、凭据重新获取和旧契约恢复通过测试；凭据撤销及配置缺失有明确阻断状态。
16. 首批打包产物在项目支持平台上通过 SDK、代理/TLS、取消、启动及旧方法回归。

### P1：扩大迁移范围前应满足

1. 先在 Phase 0 约定观察窗口和样本分组；建议每个实际启用的 sourceMethod/Provider/协议组合至少 30 次受控调用，数量不足则标记“证据不足”。小样本不宣称统计显著性；结构失败、截断及恢复后成功分别与配对基线比较。
2. 预先约定延迟和 Token 回退阈值（初始建议 20%，经基线评审调整）；超过阈值暂停扩大灰度并解释原因，而非事后用“可解释”豁免。P50/P95 同时报样本量。
3. 两种协议的错误码、取消和 Renderer 用户体验一致。
4. 所有 Python Pydantic 契约均能生成稳定的 contract ID/version 和 Electron Artifact。
5. Python Runtime 重启、Electron 重启和网络断开恢复测试通过。
6. 模型能力不支持时能够在请求前明确拒绝或安全选择已配置路径。
7. 保存的 2123 汉字测试草稿在实际启用模型上完成受限审校，或保持该方法未上线并记录失败原因；不能仅以三个短请求方法通过来认定评审能力迁移成功。
8. 至少一次“生成完整章节 → 保存草稿 → 审校 → 必要修订 → 审核写回 → 重启核验”的真实链路通过；失败节点恢复单独记录，分段成功不得冒充单次自动运行成功。此门槛适用于扩大到评审/写作链路，不阻止独立短方法先灰度。

## 20. 预计工作量

| 范围 | 预计人日 |
| --- | ---: |
| Phase 0 基线 | 2–3 |
| Phase 1 ModelGateway | 5–8 |
| Phase 2 配置、Structured Output、结果存储 | 5–8 |
| Phase 3 首批方法 | 5–8 |
| Phase 4 计划与评审 | 8–12 |
| Phase 5 探索图 | 6–10 |
| 集成、打包、回归 | 5–8 |
| Phase 6 长文本（可选） | 8–15 |
| Phase 7 清理（后续） | 5–8 |

以上保留 v0.1 的分项粗估，新增预算账本、跨 owner 恢复与发行验证可能改变分项，应在 Phase 0 清单完成后重估，不作为交付承诺。

按表算术合计：Phase 0–3 为 **17–27 人日**；若计入集成、打包、回归，则首批纵切约 **22–35 人日**。按一人、每周 5 个有效工作日估算约 4.5–7 周，不能直接承诺 2–3 周；多人排期还取决于串行依赖。Phase 0–5 加集成合计 **36–57 人日**；Phase 3b 从 Phase 4 中提前安排，不重复计数。Phase 6、Phase 7 另计。长文本、传统 AI、RAG、Embedding 和图片不计入 Agent 核心迁移承诺。

## 21. 预期代码影响范围

Python：

- `agent_runtime/pyproject.toml`；
- `agent_runtime/novel_agent_runtime/runtime.py`；
- `agent_runtime/novel_agent_runtime/exploration_graph.py`；
- `agent_runtime/novel_agent_runtime/request_graph.py`；
- `agent_runtime/novel_agent_runtime/retry.py`；
- `agent_runtime/novel_agent_runtime/store.py`；
- `agent_runtime/novel_agent_runtime/automation.py`、`tool_adapter.py`、`invocations.py`、配置/调用账本与结果引用接口；
- 新增 `models/`、`contracts/`、`prompts/` 和结果存储模块；
- 对应 Python tests。

Electron：

- `apps/desktop/electron/agent/PythonRuntimeClient.ts`；
- `apps/desktop/electron/automation/AutomationService.ts`；
- `apps/desktop/electron/automation/AgentStructuredOutputContracts.ts`；
- `apps/desktop/electron/ai/AiService.ts`；
- `TaskOutputBudget.ts`、`shared/writingPolicy.ts`、上下文装配和模型能力档案的兼容契约；
- AI 设置同步与 Feature Flag；
- Renderer 仅在需要展示新诊断时做最小调整；
- 对应 contract/recovery tests。

## 22. 与现有文档的关系

- 本文扩展 [`architecture.md`](./architecture.md)：Python 仍不拥有小说数据主权，但逐步成为 Agent 模型推理和 AI 工作流控制面。
- 本文扩展 [`python-runtime.md`](./python-runtime.md)：在现有 LangGraph 主动探索图、执行图和重试图上增加 Python ModelGateway。
- 本文遵守 [`retry-failover-resilience-requirements.md`](./retry-failover-resilience-requirements.md)：只有一个自动重试责任人，模型结果先保存，副作用未知必须对账。
- 本文不改变 [`durable-draft-operation-requirements.md`](./durable-draft-operation-requirements.md)：Electron 继续拥有草稿 Operation、Worker、SQLite 事务和正式提交。
- 本文遵守 [`context-compression-requirements.md`](./context-compression-requirements.md)：当前请求、用户决策和领域事实的保护优先级不因模型调用迁移而改变。
- 本文落实 [`decisions.md`](./decisions.md) 中结构化输出单一权威契约、JSON/Schema 内部化和 Runtime 工具边界的既有决策。
- 本文以 [`chapter-writing-product-defaults-2026-09-09.md`](./chapter-writing-product-defaults-2026-09-09.md) 为真实失败基线，保留 2300 字/正文 18K、手动兼容、明确流终态及草稿不丢失的已有行为。

### v0.2 审阅修改摘要

- 明确迁移收益边界，补入审校 Token 耗尽、时间预算及叠加重试的实测证据。
- 用方法路由快照替代 Run 单一 owner；区分 Adapter 预检回退与 Runtime 整体不可用。
- 统一所有 Provider 尝试的预算和停止条件，补齐普通 Service 与混合 owner 的责任划分。
- 模型接收端先落盘再返回引用，明确远端结果未知窗口、跨 owner 结果协议与版本保留。
- Structured Output 在请求前选模式；补充协议终态、能力未知、思考参数和参数被忽略的处理。
- 增加保存草稿审校试点、总截止时间恢复、打包和网络兼容验收；修正工期算术及指标口径。

## 23. 参考

- [LangGraph Overview](https://docs.langchain.com/oss/python/langgraph/overview)
- [LangChain Models](https://docs.langchain.com/oss/python/langchain/models)
- [LangChain ChatOpenAI / Responses API](https://docs.langchain.com/oss/python/integrations/chat/openai)
- [LangChain ChatDeepSeek](https://docs.langchain.com/oss/python/integrations/chat/deepseek)
- [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)
- [DeepSeek Tool Calls / Strict Mode](https://api-docs.deepseek.com/guides/tool_calls/)
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

参考核验日期：2026-09-10。框架与 Provider 文档会变动，实施时锁定并验证实际依赖版本。LangChain 的通用功能表不能代替具体模型/端点的契约测试；`ChatOpenAI` 面向官方 API 规格，第三方扩展字段需专用 Adapter 保留。[ChatOpenAI 适配范围](https://docs.langchain.com/oss/python/integrations/chat/openai)
