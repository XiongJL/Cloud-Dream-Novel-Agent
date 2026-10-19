# 工具、Automation 与 MCP 分层

## 演进需求与实施进展

外部 MCP 的下一阶段目标见 [MCP 应用能力开放与 stdio 改造需求](./mcp-application-capabilities-requirements.md)。v0.2 将 Node 协议层迁入 Python 独立 stdio 模式，首期优先复用 FastMCP，通过共享工厂和契约开放写作业务与内置 Agent 委托能力；后台 Agent Runtime 仍由桌面管理，会话保存与事件归档整理到公共应用服务。以下段落描述现状与历史阶段边界，不能视为新需求已经实现。

标准 MCP stdio 使用 UTF-8、换行分隔的 JSON-RPC。现有 bridge 的 Content-Length、bare JSON 等额外格式属于自定义兼容处理，不是 MCP 标准 framing；SDK 改造以标准 stdio 和明确的协议兼容矩阵验收。

2026-10-19 首批实现已将外部协议层迁入 `agent_runtime/novel_mcp`，旧 `.mjs` 只保留 Python 启动兼容。共享目录为 `contracts/tools/catalog.json`，内置 manifest 和 Electron 外部路由均从中读取；下文外部 Node 手写协议层和 Python 独立 manifest 的描述作为历史背景保留。详见 [Python stdio 实施记录](./acceptance-mcp-python-stdio-2026-10-19.md)。

## 当前可复用能力

2026-10-19 后续交付以 Streamable HTTP 作为主要外部入口，stdio 为兼容入口。所有外部设置集中在“设置 → AI → MCP CLI”，提供持久化总开关、实际 HTTP 地址、令牌接入指令和端口调整。关闭时停止 HTTP 并在 Automation 网关拒绝外部 stdio 调用，内置 Agent 通道继续工作。详见 [HTTP 与开关验收](./acceptance-mcp-http-2026-10-19.md)。

现有 RAG、AI 工作台、Automation/MCP 已能支撑 Agent MVP：

- RAG：`rag.ask`、`rag.rebuild_index`、结构化证据、章节摘要、叙事摘要、全文搜索、向量 chunk。
- AI 工作台：创作素材生成、提示词预览、草稿校验、原子入库。
- AutomationService：`chapter.generate_draft`、`creative_assets.generate_draft`、`draft.*`。
- 外部 MCP bridge：通过 runtime 文件转发到 Automation HTTP。

## HTTP AI Provider 接口格式

软件后台 AI 的 `HTTP API` 模式支持两种文本生成接口格式：

| 格式 | Endpoint | 请求形状 | 适用场景 |
| --- | --- | --- | --- |
| Chat Completions 兼容 | `/chat/completions` | `messages` + `max_tokens` | OpenAI-compatible、火山方舟、Gemini OpenAI-compatible 等 |
| Responses API | `/responses` | `instructions` + `input` + `max_output_tokens` | OpenAI Responses 或兼容 Responses 的自建服务 |

`baseUrl` 可填写 API 根地址，也可填写完整端点地址：

- `https://api.openai.com/v1`
- `https://api.openai.com/v1/responses`
- `https://api.openai.com/v1/chat/completions`

图片生成与 Embedding 仍走各自原有配置，不随文本接口格式自动切换。

## 第一阶段工具映射

| Agent 需要的能力 | 现有能力映射 | 用途 |
| --- | --- | --- |
| 读取章节 | `chapter.get` | 分析、续写、质检 |
| 生成章节草稿 | `chapter.generate_draft` | Writer Agent 输出草稿 |
| 生成素材草稿 | `creative_assets.generate_draft` | 角色、大纲、世界资料 |
| 草稿列表 | `draft.list` | 审核中心 |
| 草稿提交 | `draft.commit` | 用户确认入库 |
| 草稿丢弃 | `draft.discard` | 用户拒绝 |
| 搜索 | `search.query` | 证据检索 |
| RAG 问答 | `rag.ask` | 一致性与上下文判断 |
| 角色/故事线/世界观 | `character.list` / `plotline.list` / `worldsetting.list` | 上下文判断 |

## RAG 查询与索引边界

Agent 执行中的 `rag.ask` 应优先消费 SQLite 中已经落库的 RAG/vector 数据，不在查询链路里自动触发全量 embedding 或重建索引。

第一阶段约束：

- 内容新增、章节保存、素材更新或用户手动点击重建时，才执行 `upsert` / `rebuild_index`。
- `rag.ask` 查询路径只保证表结构存在，然后读取 `rag_vector_chunks` 中已有 chunk。
- 如果当前小说没有已落库 chunk，查询返回空证据，由 Agent/UI 提示“暂无可用 RAG 证据”，而不是阻塞等待 embedding。
- 查询时不调用外部 embedding 服务；当已存向量维度无法与本地 hash 查询向量比较时，使用轻量 lexical fallback 做兜底排序。
- `rag.rebuild_index` 属于 maintenance/cache_write 工具，不应被普通 Agent 计划默认调用。

## 外部 MCP 与内置 Agent 分层

外部 MCP bridge：

- 文件：`apps/desktop/scripts/novel-editor-mcp.mjs`
- 使用者：Codex、Claude Code、OpenClaw 或其他 MCP 客户端。
- 通道：stdio JSON-RPC / MCP -> Automation HTTP。
- 第一阶段不增加权限审批门禁。

内置 Agent 工具通道：

- 使用者：CloudDream Novel Agent 自己的 Agent 产品 UI。
- 通道：Renderer -> Electron -> Python Runtime -> AutomationService。
- 第一阶段必须保留 DraftSession 审核边界。
- 后续按 `agentPolicy` 做工具过滤和审批断点。

## FastMCP 使用边界

FastMCP 优先用于内置 Python Agent Runtime，不立即替换外部 `novel-editor-mcp.mjs`。

原因：

- 外部 Node bridge 已处理 Windows 启动、runtime 发现、bare JSON / NDJSON / Content-Length framing 兼容。
- 直接替换会影响 Codex/Claude 联调链路。
- 当前更紧急的问题是统一工具 manifest，而不是统一 MCP framework。

当前实现：

- `agent_runtime/novel_agent_runtime/tool_manifest.py` 是内置 Agent 工具的规范来源，定义工具名、参数 schema 和只读/副作用分类。
- Runtime 默认使用 FastMCP in-memory client/server adapter；每个 MCP tool 代理现有 Automation HTTP `/invoke`，不绕过 Electron 数据边界。
- 模型生成接口不作为 MCP tool 暴露，仍直接走 Automation HTTP。
- Runtime 在调用 adapter 前执行白名单、计划审批与 interrupt 检查；MCP annotations 只描述能力，不授予权限。
- requestId 穿透 FastMCP proxy，运行中取消会转发到当前活动 transport。
- 启动参数 `--tool-transport http` 或环境变量 `NOVEL_AGENT_TOOL_TRANSPORT=http` 可切回直接 HTTP adapter。
- Run 的 `tool_call` / `tool_result` 事件记录 `transport`，Inspector 展开明细后可查看实际链路。

## 需要修正的问题

1. 继续让外部 Node MCP bridge 与内置 Python manifest 生成自同一份跨语言规范；当前内置 Agent 已完成统一 Python manifest，Node bridge 仍保留独立定义。
2. 外部 MCP 暂不加权限，内置 Agent 必须加权限。
3. `chapter.save` / `draft.commit` 需要统一后处理路径。
4. `rag.rebuild_index` 应标记为 maintenance/cache_write，不是普通 read。
5. 关系、地图等 RAG 覆盖面后续需要补强。
