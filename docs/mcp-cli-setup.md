# CloudDream Novel Agent MCP CLI 接入说明

本文档说明当前已经验证可用的本地 MCP 接入方式，适用于：

- Codex
- Claude Code
- 兼容标准 MCP 的其他本地 CLI

整体设计是：

- 桌面应用仍然是唯一真实数据源
- 外部 CLI 不直接连接 SQLite
- 本地 stdio MCP bridge 负责把工具调用转发给正在运行的桌面应用

## 工作原理

桌面应用启动后，会在本地 `userData` 目录下写出一个 runtime 文件。

开发环境默认路径：

`C:\Users\<你的用户名>\AppData\Roaming\@novel-editor\desktop-dev\automation\runtime.json`

这个文件里包含：

- 本次桌面应用的本地 automation 端口
- 临时 bearer token
- 当前桌面应用进程 id

MCP bridge 会自动读取这个文件，所以通常不需要把端口和 token 手动写进 CLI 配置。

## 正确启动顺序

1. 先启动桌面应用：

```bash
pnpm dev
```

如果你只想启动桌面端，也可以：

```bash
pnpm dev:desktop
```

2. 确认 runtime 文件已经生成：

```powershell
Get-Content "$env:APPDATA\@novel-editor\desktop-dev\automation\runtime.json"
```

3. 再启动你的 MCP 客户端。

## Runtime 说明

- runtime 里的端口和 token 每次启动都会变化
- MCP bridge 会自动读取最新 runtime
- 如果你重启了桌面应用，也建议重启一次 CLI

## 软件内设置页（MCP CLI 模式）

在软件 `设置 -> AI -> MCP CLI` 模式下，当前行为是：

- 不再展示旧的“CLI 可执行路径 / 工作目录 / 启动参数模板 / 环境变量 JSON”手填项
- 改为直接展示三段可复制配置：
  - Codex `config.toml` 片段
  - Claude Code 注册命令
  - 通用 `mcpServers` JSON 片段
- `测试 MCP` 会走本地 bridge 就绪性检查（launcher + runtime + automation invoke），不再依赖旧的 MCP CLI 启动参数

在 `HTTP API` 模式下：

- 预设按钮仅在该模式显示
- “其他高级配置 / 章节摘要策略 / 代理配置”默认折叠展示
- `连接测试 / 代理测试 / 生成测试` 仅在该模式显示

## Codex 配置

先在仓库根目录执行下面命令，自动输出当前机器可直接复制的 MCP 配置（避免手填绝对路径）：

```bash
pnpm mcp:config
```

推荐在 `~/.codex/config.toml` 中这样配置：

```toml
[mcp_servers.novel_editor]
command = "cmd"
args = ["/c", "D:\\aiproject\\novalEditor\\apps\\desktop\\scripts\\novel-editor-mcp.cmd"]
startup_timeout_sec = 60
```

在启动 `codex` 之前，先在同一个终端里设置 Node 路径：

```powershell
$env:NOVEL_EDITOR_NODE_EXE = "D:\all_install\node.js\node.exe"
codex
```

为什么推荐走 `.cmd` wrapper：

- Windows 下有些 MCP 客户端对 `node + .mjs` 的启动兼容性不稳定
- wrapper 会自动定位 `node.exe`
- wrapper 会自动写 MCP 日志，便于排查问题

## Claude Code 配置

Windows 下推荐这样注册：

```powershell
claude mcp remove novel-editor
claude mcp add novel-editor --scope local -- cmd /c D:\aiproject\novalEditor\apps\desktop\scripts\novel-editor-mcp.cmd
```

也可以直接用自动生成命令（推荐）：

```bash
pnpm mcp:config -- --format claude
```

可以这样验证：

```bash
claude mcp list
claude mcp get novel-editor
```

## 通用 MCP JSON 配置

如果某个客户端支持 `mcpServers` 这种 JSON 配置，可以直接用：

```json
{
  "mcpServers": {
    "novel-editor": {
      "command": "cmd",
      "args": [
        "/c",
        "D:\\aiproject\\novalEditor\\apps\\desktop\\scripts\\novel-editor-mcp.cmd"
      ],
      "env": {
        "NOVEL_EDITOR_NODE_EXE": "D:\\all_install\\node.js\\node.exe"
      }
    }
  }
}
```

也可以直接输出 JSON 片段：

```bash
pnpm mcp:config -- --format json
```

## OpenClaw

如果你当前使用的 OpenClaw 版本支持标准 MCP 客户端配置，可以直接复用上面的 `mcpServers` 配置。

如果你当前的 OpenClaw 仍然依赖它原有的接入方式，那就继续使用现有接入方式即可。当前这个 MCP bridge 不会替代项目里已有的 OpenClaw 专用能力路径。

## 当前已支持的能力

当前 bridge 已经提供这些工具：

- 列出小说、卷、章节、主线、角色、物品、世界观、地图
- 读取章节内容
- 创建章节、保存章节
- 创建世界观、更新世界观（不开放 MCP 删除）
- 调用软件内置 AI 生成草稿
- 读取、更新、提交、丢弃草稿会话
- 把外部生成的大纲、角色、剧情补丁写回软件

## 推荐的第一次联调流程

MCP 接通后，建议按这个顺序试：

1. `novel_list`
2. `draft_list`
3. `creative_assets_generate_draft`

可以直接对 CLI 这样说：

- “调用 `novel_list`，列出当前所有小说”
- “调用 `draft_list`，查看当前活跃草稿”
- “对这本小说调用 `creative_assets_generate_draft`，生成 3 个角色和 1 条主线，但先不要提交入库，把 JSON 展示给我”

这样可以同时验证：

- MCP 握手成功
- 桌面应用正在运行
- bridge 能正确读取 runtime
- CLI 返回 JSON 和软件右侧草稿区能共用同一份草稿来源

## 本地诊断方法

### 1. 查看桌面应用 runtime

```powershell
Get-Content "$env:APPDATA\@novel-editor\desktop-dev\automation\runtime.json"
```

### 2. 运行 MCP smoke 测试

在仓库根目录执行：

```powershell
D:\all_install\node.js\node.exe apps\desktop\scripts\mcp-smoke.mjs --tool draft.list
```

如果这条成功，说明：

- 桌面应用 automation 服务是通的
- MCP bridge 本身也是通的

### 3. 查看 MCP bridge 日志

wrapper 默认会把日志写到：

```powershell
$env:TEMP\novel-editor-mcp.log
```

查看最近日志：

```powershell
Get-Content "$env:TEMP\novel-editor-mcp.log" -Tail 200
```

如果某个客户端提示 MCP 启动失败，这个日志最有用。

## 已知兼容性说明

- 当前 `Codex` 在 Windows 上启动 MCP 时，会使用 bare JSON / NDJSON，而不一定是标准 `Content-Length` 帧
- 本地 bridge 现在已经同时兼容：
  - `Content-Length` framed messages
  - bare JSON
  - 按行分隔的 NDJSON
- 某些客户端在启动后还会探测：
  - `resources/list`
  - `resources/templates/list`

当前 CloudDream Novel Agent 这条链路主要使用 tools，不依赖 resources。

## 故障排查

### 提示 `APP_NOT_RUNNING`

- 确认桌面应用还在运行
- 确认 runtime 文件存在
- 如果你刚重启过桌面应用，重启一次 CLI

### MCP 能连接，但没有数据

- 先调用 `novel_list`
- 再确认你当前看的数据库是否就是开发环境数据库：

`C:\Users\<你的用户名>\AppData\Roaming\@novel-editor\desktop-dev\novel_editor.db`

### Codex 或 Claude Code 启动超时

- 优先使用 `.cmd` wrapper，不要直接让客户端跑 `.mjs`
- 启动客户端前先设置 `NOVEL_EDITOR_NODE_EXE`
- 查看：

```powershell
Get-Content "$env:TEMP\novel-editor-mcp.log" -Tail 200
```

### `连接测试` 或 `生成测试` 出现 `fetch failed`

这类错误通常是 HTTP Provider 连接超时（例如 `UND_ERR_CONNECT_TIMEOUT`），常见原因：

- 当前网络无法直连你配置的 `baseUrl`
- 代理模式/代理地址配置不正确
- 服务端域名可解析但 443 端口不可达

建议按顺序检查：

1. 在 `HTTP API` 模式下确认 `baseUrl` 与 `apiKey` 正确
2. 检查代理模式（`system/off/custom`）是否符合当前网络环境
3. 用系统命令测试端口连通性（例如 PowerShell `Test-NetConnection <host> -Port 443`）
4. 在软件内重新点一次 `连接测试`，观察状态栏错误详情（已包含更具体网络错误）
