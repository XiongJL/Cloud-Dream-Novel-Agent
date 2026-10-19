# 本轮 MCP 改动同步到主工程

日期：2026-10-19。目标目录：`D:\aiproject\novalEditor`。

## 同步范围

主工程已具备本轮 Python FastMCP、共享工具契约、Streamable HTTP 主入口、stdio 兼容入口、外部 MCP 总开关、MCP CLI 页签设置、中英文接入说明、打包配置及对应测试。本次按文件清单核对保留现有实现，并补齐 worktree 中的开发启动修复与验收文档；未使用旧 worktree 的文件整批覆盖主工程。

补充的修复包括所有开发启动方式显式准备 Core、Prisma 6.19.2 客户端一致性检查、Windows 下已加载引擎 DLL 的安全复用。schema、SDK、运行时、引擎或必要文件不一致时仍要求重新生成。详见 [Prisma 启动修复](./acceptance-prisma-startup-2026-10-19.md)。

现有其他未提交改动保留。这是工程目录中的工作区同步，未执行 Git 提交或分支合并。

## 主工程复验

- Python MCP/内部适配器/调用账本/章节作用域相关回归：43 passed，1 skipped；跳过项为需要显式指定 frozen Runtime 的可选测试。
- HTTP 进程管理和 Automation 外部开关测试通过。
- 草稿 Operation 存储、协调器和数据库生命周期测试通过。
- Prisma 客户端准备测试通过：格式化差异可复用，模型、字符串默认值、标识符、SDK、运行时、引擎变化及缺失文件均不能复用。
- 应用和 Vite Node 配置的类型检查通过；Renderer、Electron Main、Preload 构建通过。
- 从主工程执行真实 `pnpm dev --port <空闲端口>`，使用独立 `NOVEL_EDITOR_USER_DATA_DIR` 和 MCP 测试端口。确认 Core 准备成功、Automation 健康、Streamable HTTP 健康。
- 官方 Python MCP SDK 连接实际桌面 HTTP 网关：协商协议 `2025-11-25`、发现 31 个工具、`novel.list` 返回临时数据库的空列表，无协议或业务错误。
- 测试进程已停止；没有对用户真实小说库执行写入、重置或 db push，也没有停止原有开发实例。

本次没有重新制作或发布安装器。此前 frozen Runtime 的协议、中文路径启动器和打包验证记录见 [HTTP 验收](./acceptance-mcp-http-2026-10-19.md)。更多写作及高层 Agent 委托仍以 [需求文档](./mcp-application-capabilities-requirements.md) 的分阶段范围为准。
