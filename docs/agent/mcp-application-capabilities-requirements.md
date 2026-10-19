# MCP 应用能力开放与传输改造需求

版本：v0.3（Streamable HTTP 主入口与总开关）
日期：2026-10-19
状态：实施中，M0 首批已落地；本文件的全部目标尚未完成。
适用范围：外部 MCP 客户端、Python MCP 网关、现有 Node bridge 迁移、Electron Automation、写作应用服务、Agent 应用服务、Python Agent Runtime、工具契约、打包与验收。

实施进展：2026-10-19 已接入 Streamable HTTP 主入口和总开关，详见 [HTTP 验收记录](./acceptance-mcp-http-2026-10-19.md)。M0 首批已加入 Python FastMCP stdio、现有工具迁移、共享契约、外部路由校验、启动与打包配置。验证与剩余范围见 [实施记录](./acceptance-mcp-python-stdio-2026-10-19.md)。M0 的最新协议矩阵及 M1/M2 业务扩展尚未全部完成，不以本次迁移宣称全量能力已经开放。

## 1. 用户目标

让外部 Agent 通过一个本地 MCP 入口调用软件现有写作侧的大部分业务功能，并调用软件内置 Agent 的聊天、计划、执行、恢复、状态与产物能力。

外部 Agent 应能选择两种工作方式：

1. 自己编排创作：读取作品资料，创建或修改章节、人物、世界观等，调用 AI 工坊并处理草稿。
2. 委托内置 Agent：在指定小说和会话中提出任务，获取计划，按现有规则执行，处理待补充信息或审批，读取报告和草稿。

能力开放以业务操作覆盖率、端到端可用性和软件内可见性验收，不能只增加 tools/list 中的工具数量。

## 2. MCP Server 含义与 Python 入口选型

此前“官方 SDK MCP Server”指本项目使用 MCP 官方协议库实现的本地服务程序，Server 是协议角色，不表示部署在云端。v0.1 选择 TypeScript SDK 主要考虑保留现有 Node launcher 的短期改动成本；按统一 Python 入口和长期维护目标，v0.2 统一到 Python，v0.3 采用 **Streamable HTTP 主入口、stdio 兼容入口**。

入口语言、协议框架、执行进程分别决策：Python 负责统一 MCP 注册与适配；首期优先复用现有 FastMCP；外部 stdio 网关与桌面管理的 Agent Runtime 使用独立进程和生命周期，共享代码而不重复拥有执行状态。

| 名称 | 本项目中的含义 |
| --- | --- |
| MCP Host / Client | 外部 Agent 所在应用及其 MCP 客户端，负责连接 HTTP 服务或启动 stdio 服务并调用工具 |
| 官方 MCP SDK | Model Context Protocol 官方维护的协议库，同时有 Python、TypeScript 等实现；Python 官方包名为 mcp |
| FastMCP | 本项目已使用的独立 Python MCP 框架，支持 Streamable HTTP 与 stdio；与官方 mcp 包不是同一个分发包 |
| 本项目 MCP Server | 随软件发布的 Python FastMCP 网关；HTTP 由桌面管理，stdio 由客户端启动 |
| Electron 能力网关 | 运行中的桌面应用提供的本地接口，负责校验、业务路由和应用状态一致性 |
| Python Agent Runtime | 软件内置 Agent 的编排与执行进程，通过 Electron 管理的客户端接入 |

该服务不需要新增云端部署。是否调用模型以及模型请求去向，沿用应用配置与具体工具行为。

首期复用 FastMCP 的入口形态如下，具体依赖版本须在实施时固定并验证：

```python
from novel_mcp.server import build_mcp_server

def main():
    server = build_mcp_server()
    server.run(transport="http", host="127.0.0.1", port=18765, path="/mcp")

if __name__ == "__main__":
    main()
```

`novel_mcp` 包及 build_mcp_server 为项目需要实现的组件，上述代码是架构示意。工厂从共享契约按 profile 注册工具，并注入调用上下文和桌面客户端。框架不会自动识别软件全部功能，也不会自动完成业务取消、审核或持久化。

统一到 Python 不要求同时把 FastMCP 替换成官方 mcp。当前锁定 FastMCP 3.4.3、mcp 1.28.1，不能据此宣称支持 2026-07-28；M0 须验证目标协议矩阵并固定满足要求的发布版本。若需改用官方 mcp v2，必须处理内置适配器 API、依赖约束、错误/取消语义和打包回归，不能只修改 import 或盲目升级传递依赖。官方 Python SDK 迁移是单独的技术决策，不引入第二套 TypeScript MCP 注册代码。

### 2.1 选型比较

| 维度 | 保留 TypeScript 入口 | Python 统一入口 |
| --- | --- | --- |
| 迁移成本 | 现有 launcher 和 runtime 发现可直接保留 | 需迁移发现逻辑并调整启动、打包与配置 |
| MCP 代码 | 外部 TS SDK 与内部 Python adapter 两套注册适配 | 可共享 Python 工厂、契约加载和适配组件 |
| 用户运行环境 | 当前安装方式依赖可用 Node | 使用随应用打包的程序，不要求系统 Python/Node |
| 启动代价 | 当前 Node bridge 依赖少 | 须实测 frozen 进程启动，避免加载 LangGraph、模型和文档提取库 |
| 业务调用链 | 经 Electron 网关 | 同样经 Electron 网关；换语言不自动减少业务调用或提升性能 |

以统一入口和维护为优先时采用 Python。共享契约和 Electron 业务服务仍必需，不能因两端都使用 Python 就直接访问业务库或绕开会话服务。

## 3. 当前实现基线与缺口

以下为本轮仓库分析与隔离 mock 验证所得基线，不能视作真实桌面端完整验收：

| 位置 | 已有能力 | 缺口 |
| --- | --- | --- |
| `apps/desktop/scripts/novel-editor-mcp.mjs` | 31 个外部工具；runtime 发现；HTTP 转发；手写 JSON-RPC 与多种 framing | 工具集合独立维护；缺少注册表约束、统一 schema 校验、取消映射和可靠协议错误处理 |
| `apps/desktop/electron/ai/capabilities.ts` | 写作 action、输入输出 schema、权限分类、handler | 仅覆盖部分写作功能，与 Automation 和 Python manifest 不统一 |
| `apps/desktop/electron/automation/AutomationService.ts` | 草稿、批次、审核、Skill 工作区及模型方法 | 存在独立 switch/default 路由，不能直接作为外部无限制转发器 |
| `apps/desktop/electron/agent/PythonRuntimeClient.ts` | Runtime 启动、调用、进度、取消、Run 事件订阅 | 需要供公共 Agent 应用服务复用 |
| `agent_runtime/novel_agent_runtime/main.py` | 聊天、计划、执行、恢复、审批、用户输入、状态、事件 | 尚未组成统一外部 MCP 工具集合 |
| `agent_runtime/novel_agent_runtime/tool_manifest.py` | 内置 Agent 原子工具 schema、分类、超时 | 与 Node 及 Electron 定义有重复 |
| `AgentWorkspace.tsx` / `AgentConversationStore.ts` | 会话保存、Run/Artifact 展示和存储 | 部分保存与编排依赖 Renderer，外部调用需要脱离页面生命周期 |

实测官方 Python SDK 1.28.1 可完成当前 bridge 的旧协议握手、工具发现与 mock 调用；同时确认虚构协议版本被回显、未注册工具及错误类型参数被转发、取消通知未进入上游 /cancel、畸形 JSON 可阻塞后续请求。Python 工具适配器专项测试 12 项通过，仅说明该专项基线。

## 4. 架构决策与边界

1. 外部 stdio 入口迁移到 Python，首期优先复用 FastMCP，共享契约加载与按 profile 注册的 server factory；Node 不再拥有 MCP 协议实现。
2. Electron Main 继续拥有小说业务数据、受控文件、写回、索引和界面通知边界。
3. 外部写作工具和软件界面调用同一套应用服务，不为 MCP 再实现一份业务逻辑。
4. Agent 高层调用经 Electron Agent 应用服务进入 PythonRuntimeClient，不暴露 Python 端口/token 给外部客户端。
5. 内置 Python FastMCP 保留进程内原子工具适配形式，与外部入口共用注册基础组件、分别注入上下文和业务调用器；原有 ContextVar 私有错误包装不能直接作为外部契约。更换官方 Python mcp 包不是前置条件，协议版本达标是 M0 发布条件。
6. 共享工具契约是唯一定义来源，外部与内部按 profile 使用各自工具子集。
7. 本需求不新增一套逐次人工确认门禁。现有直接写作工具的调用语义与内置 Agent 的计划审批、用户输入、草稿审核边界分别保留；不得靠 caller 填写 approved/origin 绕过现有执行规则。
8. 外部写作工具可按显式参数创建或选择作品；委托内置 Agent 的单次会话和 Run 仍绑定指定 novelId，不因此放开内置 Agent 跨作品读写。
9. 模型执行位置沿用现状，并兼容 [Agent AI 渐进迁移需求](./python-ai-capability-migration-requirements.md)；模型迁移不阻塞本需求。

```text
外部 MCP Client
  -> Python FastMCP 网关（Streamable HTTP 主入口 / stdio 兼容入口）（独立轻量进程，共享 Python 工具代码）
  -> Electron 能力网关（本地 HTTP）
      -> 写作 / 草稿应用服务 -> 业务库、文件、索引、通知
      -> Agent 应用服务 -> PythonRuntimeClient -> Python Runtime
                                              -> 原子工具 -> Electron Automation

Renderer -> IPC -> 相同应用服务
```

Agent 等待期间不能持有其回调写作工具也需要的全局串行锁；串行化应限制在实际会话写入或业务事务范围，防止 Python 回调 Electron 时死锁。

## 5. 写作侧能力范围

首期必须建立“现有 UI 业务操作 -> 应用服务 -> 契约 -> 外部工具 -> 验收案例”的覆盖清单。每项标记已开放、待提取服务、受既有策略限制、或不适用，并说明原因。

| 功能域 | 目标覆盖 | 实施约束 |
| --- | --- | --- |
| 小说、卷、章节 | 列表、详情、创建、修改、排序等已有操作 | 显式作用域；结构和统计一致 |
| 正文 | 读取、保存、范围修改 | 明确文本格式、目标版本、冲突与未保存编辑处理 |
| 人物、物品、技能、世界观 | 查询、创建、修改及已有关系维护 | 复用业务校验与关联后处理 |
| 故事线、剧情点、大纲 | 查询、编辑、结构调整、草稿写回 | 沿用现有数据模型 |
| 地图、灵感等写作资料 | 现有业务功能 | 逐项提取服务，不能仅凭工具名宣称已覆盖 |
| 搜索与上下文 | 全文检索、RAG、章节范围与续写上下文 | 大结果分页；只读检索不隐式重建全量索引 |
| AI 工坊 | 提示预览、生成、修订、校验、结果读取 | 长生成任务化；产物进入现有草稿体系 |
| 草稿与审核 | 列表、详情、更新、提交、丢弃、批次及现有恢复操作 | 保留版本校验、幂等账本和原子写回 |
| 文件与导入导出 | 已有附件读取和业务级导入导出 | 复用受控文件接口；不以任意 shell/文件系统入口代替业务接口 |

删除和不可逆操作逐项沿用现有产品能力与策略，明确是否对外开放；不能由通用转发器隐式获得。纯视觉交互、主题与窗口布局不属于本次业务能力覆盖分母。

正文新增接口须声明 plain_text 或明确的结构格式；外部 Agent 不必理解 Lexical 内部 JSON。既有 chapter.save 的旧格式通过显式兼容映射保留，不可静默改变 content 的含义。并发修改使用 revision/hash 等前置条件；UI 存在未保存编辑时返回可处理的冲突，不覆盖用户缓冲区。

## 6. Agent 高层能力

下表表示目标工具分组；已有 Runtime 方法优先保留名称，新增工具的最终名称和 schema 在契约阶段固定。

| 分组 | 目标接口与来源 |
| --- | --- |
| 会话 | 新增会话创建、列表、读取与消息分页，接入 Electron 会话存储 |
| 交流与计划 | agent.chat、agent.plan、agent.revise_plan；复用 Runtime 现有实现 |
| 执行 | agent.execute_plan；复用现有后台 Run |
| 状态、事件、产物 | agent.run_status；新增有界事件分页和产物列表/内容读取 |
| 恢复与取消 | agent.cancel、agent.retry_run；按现有失败状态和修订前置条件执行 |
| 交互断点 | agent.submit_approval、agent.submit_user_input，以及现有 dismiss 行为 |
| 草稿修订 | agent.revise_draft、agent.regenerate_batch 等已有任务 |
| Skill | 已有查询、预览、编写、修订、草稿和发布能力；按作品范围和发布规则接入 |

公共 API 不要求调用方构造内部数据库记录、伪造完整 conversation 快照或理解图节点实现。需要审批或补充信息时，返回真实 checkpoint/request 引用、可选项和当前 revision，由调用方按现有规则处理。

计划工具不默认开启执行；批准计划和提交草稿是不同业务动作。已经被用户明确授权的工作按现有策略执行，不强制新增桌面弹窗作为外部调用前提。

### 6.1 AgentApplicationService

将 IPC 中的 Runtime 调用，以及 Renderer 中与业务连续性有关的持久化和事件归档，整理为主进程 AgentApplicationService：

1. 校验 novelId、conversationId、planId、runId、artifactId 的归属关系。
2. 创建或读取会话，保存消息和请求关联；origin 由入口确定，不作为授权凭证。
3. 调用 PythonRuntimeClient，并复用其启动、健康检查、请求取消与恢复策略。
4. 保存回复、计划及 Run/Artifact 引用，绑定 Electron 会话 ID 和 Runtime thread/conversation ID。
5. 订阅和增量保存后台 Run 事件；页面关闭或 bridge 退出不导致归档中断。
6. 按 eventId/sequence 去重并支持缺口补读，通知 UI 重载必要数据。
7. 防止旧 Renderer 全量快照把外部新消息或事件覆盖掉；使用 revision 或按对象增量写入。

Python Run/checkpoint 存储继续是执行状态权威来源；Electron 保存业务会话及展示投影，不建立第二套互相竞争的执行状态机。启动恢复时按持久化游标补齐投影，产物和事件可重复投递但不能重复显示或重复写回。

## 7. 共享工具契约

### 7.1 存放与消费

建议新增以下目录，路径为实施方案，不表示当前已存在：

```text
contracts/tools/
  writing.json
  drafts.json
  agent.json
  skills.json
scripts/generate-tool-contracts.*
```

契约采用可跨语言消费的 JSON Schema 与元数据。生成 Electron 使用的注册描述及类型、Python 外部/内部 profile 使用的工具 manifest。Python 共用工厂和适配基础组件，不维护第二份外部注册表。运行时使用构建产物，安装环境不要求执行生成脚本。

### 7.2 每项必须声明

| 字段 | 要求 |
| --- | --- |
| name、version、description | 稳定名称、契约版本、面向模型的业务说明 |
| inputSchema、outputSchema | 明确可校验的输入与公开输出；对列表包装方式一致 |
| handler | 服务端固定处理器键，不能由调用参数指定后端方法 |
| exposeTo | external_mcp、internal_agent、desktop_ui 等适用 profile |
| effect | read、draft_write、data_write、maintenance 等业务效果 |
| annotations | 准确声明只读、破坏性、幂等与外部交互；不是权限凭证 |
| execution | request / operation / run 模式、逐工具超时、取消与重试责任 |
| idempotency | 是否支持业务幂等键、作用域、冲突及结果查询方式 |
| scope、concurrency | 作品/会话范围和版本/hash 前置条件等 |

新增公开对象默认明确 additionalProperties；嵌套 payload、数组元素不能长期仅用无约束 object 代替契约。旧调用需要的兼容字段逐项声明，不能通过全局关闭校验解决。

输出为数组的现有业务 handler 可继续内部返回数组，公开适配层显式包装为 items 等对象，并与 outputSchema 一致。既有外部工具保留结构兼容，必要的破坏性变更新增版本/工具，不能借 SDK 化偷偷改变结果。

readOnlyHint=false 不等于 destructiveHint=true；创建草稿、覆盖正文、丢弃数据和索引维护分别标注。rag.rebuild_index 应归为 maintenance/cache_write，不冒充普通读取。

### 7.3 单一来源和 profile

- Node TOOL_DEFS 和手写协议层退役，Python MCP 网关使用生成的 external_mcp 契约。
- capabilities.ts 与 Automation handler 保留实现，描述和 schema 引用共享契约。
- Python tool_manifest.py 使用生成结果或加载打包资源，不再手写同名 schema；现有常量和业务映射可保留。
- 模型内部方法如 agent.generate_chat 不因名称包含 agent 就自动对外开放；公共 agent.chat 与底层模型调用明确区分。
- internal_agent 不包含高层 Agent 委托入口，避免递归委托；确需未来开放时单独设计调用链和预算。
- CI 检查重名、缺失 handler、无效 schema、未生成变更和 profile 漂移；同名不同接口必须有显式映射，不能靠注册顺序覆盖。

## 8. Electron 能力网关

保留现有本地 runtime 发现与认证方式，/invoke 内新增显式注册分发：

```text
查找公开工具 -> 校验 profile、作用域、参数及既有策略
  -> 写作/草稿应用服务
  -> AgentApplicationService
规范化公开结果 -> 业务变更通知
```

不允许通过未命中注册表后的 default 分支调用任意内部 action。bridge 和网关都应校验输入，网关不信任 bridge 已经校验；内部 Python 原子工具仍按内部 profile 和 Runtime 策略调用。

网关负责写作变更后的字数、版本、搜索索引、RAG 派生更新和 UI 通知。耗时派生更新沿用业务后台机制，不能为等待通知扩大数据库事务。失败保留原有错误码及可恢复状态。

传递 requestId、parentRequestId、deadlineAt 和业务 operationKey，明确它们各自含义。日志不得输出 token、模型密钥或整段正文；结果未知的副作用沿用现有核对机制，不自动重发。

## 9. Python stdio 迁移与框架化

### 9.1 保留与替换

将运行时发现、显式 runtime 路径覆盖、本地 HTTP client 和按需诊断迁入 Python 公共连接模块。Windows launcher 可以保留原路径作为迁移壳，转而启动打包程序的 mcp-stdio 模式，不再定位 Node。旧 .mjs 不作为长期依赖 Node 的兼容前提；旧配置须有明确迁移路径。

删除手写 pumpBuffer、framing 猜测、初始化/版本回显、JSON-RPC 消息分发与发送函数。协议由 Python MCP 框架承担，外部与内部通过同一工厂按 profile 构建，不能直接暴露当前依赖内部 ContextVar 的 _AutomationProxyTool。

框架负责标准 UTF-8 NDJSON、协议版本与能力处理、请求/通知区分、基础错误与连接生命周期；业务代码负责工具注册、HTTP 调用、业务取消和结果映射。

标准 MCP stdio 是按换行分隔的 JSON-RPC。Content-Length 与 UTF-16 framing 不作为标准或新实现必需能力；只有存在可复现的必要客户端依赖时才保留隔离的兼容入口，不能在主路径持续猜测格式。

按实施时固定的框架/底层 SDK 版本验证 2026-07-28 路径及明确支持的旧版本回退；当前锁版本不视为已经达标。不能回显任意协议版本，也不能仅因为依赖升级便宣称新旧协议都已支持。

### 9.2 发现、就绪与结果

- 从随安装包发布的契约注册工具，握手不等待后台 Agent Runtime 或模型服务启动；独立 Python MCP 网关自身仍需启动并加载 MCP 框架。
- 真正调用时再确认桌面端和所需 Runtime 就绪；Agent 未就绪不阻断纯写作工具。
- 桌面端未运行时返回 APP_NOT_RUNNING 等明确错误，不伪造空列表作为业务成功。
- bridge/桌面版本或契约不匹配时给出明确诊断，不隐藏新工具或自动改用语义不同的方法。
- 未注册工具和请求结构错误按协议处理；业务错误返回 isError=true 并保留业务码与可恢复详情。
- 成功返回符合 outputSchema 的 structuredContent，同时提供对应 JSON TextContent；大内容通过分页/产物引用读取。
- stdout 只允许 MCP 消息，启动进度和日志进入 stderr 或日志文件。

### 9.3 启动模式和进程所有权

建议在现有 frozen 可执行程序增加显式 --mode mcp-stdio，原有 Agent 服务启动参数保留兼容；开发环境提供 python -m novel_mcp 的独立入口。

- 在 runtime_entry.py 的最早阶段完成模式分发，先判断 mcp-stdio 再决定是否导入 novel_agent_runtime.__main__。
- 当前 __main__.py 在 import 时打印 @@NOVEL_AGENT_PROGRESS@@ 并加载 FastAPI、LangGraph；stdio 模式不得经过该路径。仅在现有 main() 内新增参数分支已经太晚。
- stdio 模式只加载契约、MCP 框架、轻量 HTTP/连接模块；避免间接 import 主 Runtime、模型、SQLite checkpointer 或文档提取库。
- 每个外部客户端可启动自己的 stdio 网关；所有网关经 Electron 应用服务调用由桌面统一管理的后台 Agent Runtime。
- 网关不创建新的 NovelAgentRuntime、不打开其执行状态目录、不启动第二个 LangGraph Runtime；共享可执行文件不代表共享一个进程。
- 网关 EOF 只关闭自身连接和短请求，不停止桌面或已受理的 Run；任务生命周期遵循第 10 节。

## 10. 长任务、幂等与取消

### 10.1 三种执行模式

| 模式 | 适用操作 | 返回 |
| --- | --- | --- |
| request | 有界读取、确定性短写入、状态查询 | 本次结果 |
| operation | 长聊天/规划/生成及需要找回结果的受理请求 | 持久化 operationId，后续查询状态和结果 |
| run | 现有 Agent 计划执行及恢复 | 现有 runId、状态和产物引用 |

沿用已有 chapter.draft.start/get_status/cancel/retry；agent.execute_plan 已创建后台 Run，不重复建立一套执行状态。尚无持久化受理的长调用才增加 operation 包装。具体新增 operation 工具名在契约阶段固定。

### 10.2 生命周期要求

1. 在启动工作前持久化受理与业务幂等键，按既有存储边界实现；不得只在 bridge 内存创建 Promise。
2. 相同 key 和相同参数返回同一任务；相同 key 不同参数返回冲突。MCP JSON-RPC id 不作为业务幂等键。
3. 受理响应丢失后可以按 key 找回状态，不能因客户端超时重复执行或计费。
4. bridge 退出或 stdio 断开不取消已经受理的后台任务；重连后按 operationId/runId 查询。
5. 普通请求取消通过 Python 框架任务取消/请求上下文传到 Electron /cancel，并由应用服务继续传递到实际执行方；客户端离开后不发送迟到协议消息。
6. 已受理任务必须通过业务 cancel 接口停止；停止状态以实际执行方为准，不把发送取消请求等同于任务已撤销。
7. 取消和 deadline 不保证撤销已完成写入；副作用未知时保留可核对引用，禁止静默重试。
8. 移除外部 bridge 统一 95 秒业务上限，按契约分别设置短请求、任务受理、查询及实际任务预算；不能用无限增大客户端超时代替任务化。
9. 事件查询使用 afterSequence/cursor 和 limit；报告/正文分段读取。进度通知可作为增强，但不能成为找回状态的唯一途径。

## 11. 构建与发布

- 固定 Python MCP 框架、底层 SDK 和 schema 校验依赖，记录平台兼容矩阵；不依赖用户系统安装 Python、Node 或全局 MCP CLI。
- 首选在现有 PyInstaller onedir 产物增加 mcp-stdio 启动模式，明确加入动态模块和契约资源，再由 electron-builder extraResources 发布；是否拆出小型专用二进制由冷启动和包体实测决定，不预设更快。
- 保留现有 .cmd launcher 路径或提供明确迁移，改为定位随软件发布的程序；开发配置使用项目 Python 环境和独立模块，发布配置使用打包程序加 --mode mcp-stdio。
- 系统无 Node、无 Python、无开发 node_modules/.venv 的干净安装环境仍能握手、发现并调用；打包资源缺失时返回明确诊断。
- 新安装、升级、含空格/中文路径、多个客户端、后台 Agent 尚未启动、应用重启后 runtime 更新均需验证；记录网关冷启动耗时和内存，不能只测热进程。
- 修改 mcp-smoke 为 SDK 客户端测试；软件内“测试 MCP”验证实际 Streamable HTTP 握手、发现和只读调用，stdio 保留独立协议回归，不只检查 launcher/runtime/HTTP。
- CLI 接入文档纠正 Content-Length 为标准的历史描述，明确支持协议和日志开关。

### 11.1 设置页通用 Agent 接入说明

- 所有外部 MCP 设置放在“设置 → AI → MCP CLI”切换页下，Streamable HTTP 为主入口，stdio 只在高级兼容配置中展示。
- MCP 能力独立于 AI provider 选择；切换页签、保存模型设置不能隐式开启或关闭 MCP。
- 提供“启用 MCP”总开关，立即生效、自动保存到本机 `userData/mcp/settings.json`，应用重启保持选择。沿用原来对外接入默认开启的行为；配置损坏时关闭接入，用户可重新开启修复。
- 开启时由 Electron 管理独立 FastMCP HTTP 进程，只监听 `127.0.0.1`，默认端口 18765，可修改。后台 Agent Runtime 不重复启动。
- 关闭时停止 HTTP 进程，并由 Electron 在 `/mcp/invoke` 拒绝调用（MCP_DISABLED），已有 stdio 连接同样不能执行新工具；尽力中止活跃外部请求。内置 Agent 通道不受影响，已受理的持久化任务不会被自动撤销。
- URL、端口和随机访问令牌跨重启保持稳定。外部 Bearer token 与内部 Automation token 分离；HTTP 的工具、会话与健康接口均需认证，校验 Host/Origin。
- “一句话接入指令”包含实际 HTTP URL、Authorization 请求头及服务名，不写入模型密钥；提示仅供同机支持 Streamable HTTP 的客户端使用并保持桌面运行。
- 复制 HTTP JSON 供兼容客户端使用，具体配置格式由客户端决定；不承诺任何 Agent 都能自动修改自身配置。
- 停用或启动失败时不展示可用接入指令；显示启动中、运行中、已关闭、错误状态。端口冲突须明确报错，可重试或修改端口，不能偷偷更换已复制的地址。
- 应用退出或桌面进程异常结束时结束子进程；设置开关只改变接入生命周期，不关闭数据库和内部服务。

## 12. 分阶段交付

| 阶段 | 交付物 | 完成条件 |
| --- | --- | --- |
| M0 契约与协议 | 共享契约、生成与 CI、Python 注册工厂、HTTP 主入口、总开关、stdio 兼容模式、launcher/打包、错误/取消 | 现有 31 个工具正常输入和结果兼容；协议矩阵达标；无 Node/Python 系统依赖；不重复启动 Agent Runtime |
| M1 写作覆盖 | UI 业务操作覆盖清单、共享应用服务、写作工具扩充 | 约定核心业务操作均有契约、处理器及验收；未覆盖项逐项说明，不能以“大部分”跳过核心流程 |
| M2 Agent 委托 | AgentApplicationService、会话与消息、Run/事件/产物、断点和恢复、必要的 operation | 页面关闭仍可工作；外部及 UI 使用相同服务；外部任务在软件中可见 |
| M3 完整验收 | 端到端场景、兼容矩阵、故障恢复、覆盖报告和发布说明 | 写作直调与 Agent 委托两条真实流程完成；重连和重复请求不重复写入 |

每阶段可以独立落地，但只完成 M0 不能宣称已经支持大部分写作及 Agent 功能。

## 13. 验收要求

### 13.1 协议与契约

- 官方 SDK 客户端完成 stdio 握手/发现/调用；旧版本回退与新版本路径分别验证并记录 SDK 版本。
- UTF-8 中文、拆包/合包、并发请求、错误 JSON、未知方法、未知工具、缺少参数和错误类型均有确定结果；错误帧后不永久卡死。
- notifications 不产生无 id 的错误响应；不支持的版本不被宣称支持。
- schema 和 annotations 与生成契约一致；未知工具与非法参数在进入 handler 前拒绝。
- 正常结果、业务错误、大列表、报告分页都能被客户端正确消费；stdout 无日志污染。
- 正常 EOF、请求取消和服务退出释放资源；HTTP /cancel 到实际执行方的传递可观察。
- frozen 程序最早阶段分派到 mcp-stdio，无旧启动进度污染；不加载 LangGraph 主入口，也不新建后台 Agent 状态库。多个网关调用同一桌面后台 Runtime。

### 13.2 写作与一致性

- 外部创建小说/卷/章节，读取并修改人物、世界观和故事线，软件中立即可见。
- 保存正文后字数、搜索及派生更新符合原业务语义；UI 未保存编辑和版本冲突能正确处理。
- 外部生成和修订草稿，可读取、审核并按现有规则提交；不重复创建或重复写回。
- 每一项核心写作操作具有工具契约、业务服务和验收证据；覆盖清单中不以未执行 mock 代替真实覆盖。

### 13.3 Agent 与恢复

- 外部创建会话并聊天/规划，执行现有续写或分析任务，读取报告和草稿引用；全过程显示于软件同一会话。
- 正确处理计划审批、范围选择、用户输入断点、失败修订和重试；没有额外的强制 MCP 确认层。
- Agent 页面未打开、页面切换、bridge 退出或客户端重连，已受理任务仍可查询，事件与产物投影不丢失或重复。
- Runtime/桌面进程异常恢复后按已有规则呈现 interrupted/failed/unknown 等真实状态；不能在无法证明时标为成功或自动重放副作用。
- 同 key 重复提交、受理响应丢失、取消竞争、过期 revision、旧 UI 快照写入、跨作品引用及内置递归入口均按契约处理。

### 13.4 发布与证据

至少用官方 SDK 客户端和实际使用的外部 Agent 客户端测试发布产物；Windows launcher 与其他声明支持的平台分别验收。记录应用版本、契约版本、SDK/协议版本、平台、工具覆盖与未完成项。单元测试、隔离 mock 和真实模型/桌面验收分开报告，不相互替代。

## 14. 与现有文档的关系

- [工具与 MCP 分层](./tooling-and-mcp.md)：记录现状；本文规定目标改造，尚未替换现有代码。
- [MCP CLI 接入](../mcp-cli-setup.md)：描述当前可用配置；实现后同步生成配置与安装路径。
- [Agent 工作区连续性](./agent-workspace-continuity-requirements.md)：复用后台执行与模式切换要求，扩展到外部入口。
- [持久化草稿 Operation](./durable-draft-operation-requirements.md)：复用章节草稿幂等与状态机，避免再建重复任务系统。
- [文件导入需求](./file-import-requirements.md)：内置 Agent 保持单小说与受控附件边界，外部写作接口不改变其限制。
- [Agent AI 渐进迁移](./python-ai-capability-migration-requirements.md)：模型调用 owner 可演进，本 MCP 入口和公开工具语义保持稳定。

## 15. 官方参考

以下链接于本轮需求整理时核对。实施时以固定发布版本的文档、源码和兼容测试为准，不把 main 分支示例直接当作已安装版本 API：

- [官方 Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- [官方 Python SDK v2 与迁移范围](https://py.sdk.modelcontextprotocol.io/whats-new/)
- [FastMCP Server 与 stdio](https://gofastmcp.com/servers/server)
- [FastMCP 运行与部署](https://gofastmcp.com/deployment/running-server)
- [MCP 2026-07-28 stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [MCP 版本与兼容性](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
