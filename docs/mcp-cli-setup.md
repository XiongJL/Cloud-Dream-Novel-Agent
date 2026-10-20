# MCP 接入说明

Streamable HTTP 是主要入口，stdio 作为兼容入口保留；两种方式共用 Python FastMCP、同一份外部工具契约和桌面业务服务。

## 设置与连接

1. 打开桌面应用，进入 **设置 → AI → MCP CLI**。
2. 打开 **启用 MCP**，等待“Streamable HTTP 可连接”。
3. 点击 **复制接入指令**，粘贴给同一台电脑上支持 Streamable HTTP 的 Agent。也可以复制 HTTP JSON 并转换为客户端要求的格式。
4. 配置后让客户端列出工具。当前开放 31 个工具，更多写作与 Agent 高层委托功能仍按需求分阶段接入。

默认地址是 `http://127.0.0.1:18765/mcp`。以设置页实际地址为准，端口可在“端口与 stdio 兼容配置”中修改。接入指令包含本机随机令牌，请求必须携带：

```text
Authorization: Bearer <设置页生成的本机令牌>
```

用于支持 `mcpServers` / `url` / `headers` 的客户端的配置示意（其他客户端需适配其配置格式）：

```json
{
  "mcpServers": {
    "novel_editor": {
      "url": "http://127.0.0.1:18765/mcp",
      "headers": { "Authorization": "Bearer <本机令牌>" }
    }
  }
}
```

这是同机接入地址，桌面应用必须保持运行。内网其他机器和云端 Agent 无法直接通过自己的 `127.0.0.1` 访问此服务。端口冲突会显示失败，可换端口或释放占用后重试；更改端口后需更新客户端配置。

## 总开关

- 开关立即生效并自动保存，不需要点击模型配置的“保存”。
- 关闭后停止 HTTP 监听，已有 stdio 连接的新工具调用返回 `MCP_DISABLED`。
- 活跃外部请求会收到取消信号；已受理的持久化章节任务不会自动撤销，也不保证撤销已经发生的写入。
- 内置 Agent 和内部 Automation 服务继续可用；切换 AI 提供方式或离开设置页不会改变开关。
- 开关、端口与令牌保存在 `userData/mcp/settings.json`，重启保持不变。外部令牌与内部 Automation 令牌不同。
- 沿用原有外部 MCP 默认开启的行为。配置损坏时关闭接入，可重新开启生成有效配置。

## 测试 MCP

设置页的“测试 MCP”使用官方 Python MCP SDK 客户端连接真实 HTTP 地址，完成 initialize、tools/list 和 `novel.list` 只读调用，不调用模型或修改小说。

开发环境先执行 `uv sync --frozen --project agent_runtime --extra dev`。发布包直接使用随应用附带的 Runtime，不要求安装系统 Python 或 Node。

## stdio 兼容入口

仅支持 stdio 的客户端可展开“端口与 stdio 兼容配置”，复制兼容 JSON。Windows 启动器为随应用发布的 `mcp/novel-editor-mcp.cmd`，macOS/Linux 为 `mcp/novel-editor-mcp.sh`；设置页按本机安装路径生成，不应复制开发者的固定目录。

从仓库根目录输出开发环境 stdio 兼容配置：

```powershell
pnpm mcp:config
```

验证 stdio 协议和工具发现（无需桌面运行）：

```powershell
& .\apps\desktop\scripts\novel-editor-mcp.cmd --smoke --list-only
```

验证 stdio 只读调用（需桌面运行且 MCP 已开启）：

```powershell
& .\apps\desktop\scripts\novel-editor-mcp.cmd --smoke --tool novel.list
```

stdio 自动发现桌面的 `automation/runtime.json`，其中是每次桌面启动产生的内部端口和令牌。它不是 MCP HTTP 接入地址；外部客户端应使用设置页 `/mcp` URL。需要指定应用实例时，stdio 支持 `NOVEL_EDITOR_RUNTIME_FILE` 或 `--runtime-file`。

## 实现边界

- HTTP 与 stdio 共用 Python FastMCP 3.4.3 / mcp 1.28.1，不引入第二套 TypeScript MCP 协议实现。
- 桌面仍是唯一业务数据源；网关不直接访问小说 SQLite，也不为每个客户端启动 LangGraph。
- 已验证协商协议为 2025-11-25，不宣称支持所有未来协议版本。
- 详细范围见 [需求文档](agent/mcp-application-capabilities-requirements.md) 和 [HTTP 验收记录](agent/acceptance-mcp-http-2026-10-19.md)。
