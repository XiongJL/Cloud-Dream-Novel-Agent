# Streamable HTTP 主入口与 MCP 开关验收

日期：2026-10-19。范围：现有外部 MCP 能力的传输、生命周期、设置与连接体验；不代表 M1/M2 写作能力扩展和内置 Agent 高层委托已全部完成。

## 交付结果

- 沿用 Python FastMCP 3.4.3 / mcp 1.28.1，HTTP 和 stdio 使用同一个 `build_mcp_server` 和共享契约，现有 31 个外部工具不变。
- Streamable HTTP 作为主要入口，默认 `http://127.0.0.1:18765/mcp`，支持修改端口。HTTP 网关由 Electron 单独管理，不启动另一套 LangGraph Agent。
- HTTP 使用独立随机 Bearer 令牌，所有 HTTP 请求包括健康检查均认证，启用 Host/Origin 防护，仅监听 IPv4 回环地址。内部 Automation 的临时令牌不对 HTTP 客户端公开。
- `userData/mcp/settings.json` 保存开启状态、端口和令牌；保留原来默认对外启用的行为。配置损坏时关闭接入，用户可重新启用修复。
- 关闭开关停止 HTTP 进程，Automation `/mcp/invoke` 返回 `MCP_DISABLED`，已有 stdio 连接也无法执行新工具，并向活跃外部请求发送取消信号。内部 `/invoke` 和内置 Agent 不受影响。
- 已受理的持久化任务不随断开连接自动撤销，不承诺回滚已发生的副作用。
- 应用退出主动停止进程；桌面异常结束时 Python 通过父进程 stdin 管道 EOF 退出，避免遗留监听器。

## 设置位置与交互

用户明确要求所有相关设置放在 **设置 → AI → MCP CLI** 切换页下。HTTP API 页签不显示 MCP 区块；切换页签不隐式改变总开关。

该页提供：启用 MCP、运行状态、实际 HTTP 地址、一句话接入指令、HTTP JSON 复制、HTTP 协议测试，以及折叠的端口/stdio 兼容配置。开关和端口立即保存，不依赖模型设置的“保存”按钮。复制内容包含同机地址和 Authorization 请求头，并说明需要保持应用运行以及客户端支持该传输。

`测试 MCP` 改为官方 Python SDK 连接实际 HTTP 端点，完成初始化、工具发现、只读 `novel.list` 调用。stdio 诊断和兼容启动器仍保留。

## 验证

1. Python 源码相关回归：43 passed，1 skipped。覆盖 stdio、HTTP、内部 adapter、invocation ledger、章节作用域。唯一跳过项为需要显式 frozen 路径的安装包测试。
2. HTTP SDK 验证：真实子进程监听、Bearer 认证、拒绝非法 Origin、会话初始化、31 个工具发现、中文结构化结果、输入 schema、隐藏工具拒绝、上游错误、取消通知向桌面传播，以及父进程管道断开退出。
3. PyInstaller onedir 构建成功。设置 `NOVEL_MCP_PACKAGED_EXE` 后，HTTP 两个测试与不依赖系统 Python/Node 的中文路径 launcher 测试共 3 passed。
4. `mcp-server-manager-test.mjs` 使用真实 Python HTTP 进程验证关闭释放端口、端口冲突可见报错、启用状态与令牌持久化、端口修改、重复开启/关闭及启动期间关闭。源码与 frozen Runtime 均通过；新增端口变更用例在源码通过。
5. `automation-runtime-descriptor-test.mjs` 验证总开关拒绝外部调用、允许内部调用、只取消活跃外部请求、重新启用恢复，并保留 runtime 描述文件归属与修复验证。
6. 发布构建脚本新增 packaged HTTP smoke，真实启动 frozen HTTP 服务后用 frozen 官方 SDK 客户端完成握手和工具发现；该 smoke 已单独执行通过。
7. TypeScript 检查、Vite Renderer/Main/Preload 构建通过。
8. Playwright 使用真实 `AISettingsPanel` 的隔离夹具检查页签归属、开关、刷新后状态、接入指令复制、默认折叠和布局。界面夹具模拟 IPC，不是生产数据上的端到端业务写入测试。截图：`output/playwright/mcp-http-settings.png`。

以上测试没有调用真实模型、修改真实小说或重启用户正在运行的桌面。运行中的旧 Electron 主进程需要重启以加载新增 IPC、preload 和 HTTP 管理器。安装包构建配置已更新，本次未制作或发布新安装器。

## 入口文件

- `agent_runtime/novel_mcp/http_transport.py`：HTTP 认证、回环监听、父进程退出检测。
- `apps/desktop/electron/automation/McpServerManager.ts`：本机配置与 HTTP 进程生命周期。
- `apps/desktop/electron/automation/AutomationServer.ts`：外部能力总闸门。
- `apps/desktop/src/components/Settings/McpServerSettings.tsx`：HTTP 主入口与设置交互。
- [使用说明](../mcp-cli-setup.md)、[需求 v0.3](./mcp-application-capabilities-requirements.md)。
