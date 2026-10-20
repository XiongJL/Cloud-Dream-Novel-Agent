# Python FastMCP stdio 首批实施记录

日期：2026-10-19
范围：M0 首批，现有外部工具迁移与共享契约；后续业务开放和最新协议兼容尚未全部完成。

## 已实现

- `agent_runtime/novel_mcp` 提供独立 Python stdio 入口，复用 FastMCP 3.4.3，不加载 LangGraph 主 Runtime。
- frozen Runtime 在导入旧 Agent 启动入口前分发 `--mode mcp-stdio`；避免启动进度污染 stdout，不创建第二套 Agent 状态。
- `contracts/tools/catalog.json` 统一 50 个名称，按 profile 保留原有 31 个外部工具和 36 个内置原子工具。历史 schema 差异采用显式覆盖，未自动把内部工具全部暴露。
- 内置 manifest 和 FastMCP 注册工厂使用共享目录；Electron 从同一目录校验外部调用。
- 新增 `/mcp/invoke` 固定外部工具范围，不根据调用方填写的 origin 扩大权限；旧内部 `/invoke` 路径保留。
- 外部结果同时提供完整 JSON 文本和 structuredContent，保留列表 `{items: [...]}` 形状，业务失败保留错误码和详情。
- 输入类型错误和隐藏工具在进入 Electron 业务处理前被拒绝；Electron 再执行独立校验。
- 每次调用重新发现桌面 runtime，单次调用及取消固定同一实例；MCP wire cancellation 传递到对应 `/cancel`。
- Windows `.cmd` 和 POSIX `.sh` 启动 Python/打包程序；旧 `.mjs` 仅保留启动兼容。安装版不需要系统 Python/Node。
- `mcp-smoke` 改用官方 Python SDK 客户端，设置页测试改为真实 stdio 初始化、发现及 novel.list 只读调用。
- PyInstaller 包含共享契约，构建脚本增加冻结版 MCP 发现 smoke。stdio 使用自有标准流副本，避免 SDK 1.x 关闭包装流后 frozen 程序退出时出现 closed-file 异常。

## 验证

- Python：工具适配器、调用账本、章节 Toolchain 和首批 stdio 专项组合执行为 39 passed；随后新增畸形帧用例、修复标准流和编码后，stdio 专项复验为 8 passed、1 个冻结版测试按环境条件跳过。冻结版测试再单独配置产物路径执行并通过。不同阶段的重复用例不累加为总测试数。
- stdio 专项包括 schema、profile 隔离、中文、畸形帧后恢复、拆包、未知版本协商、完整结果、错误透传、并发 ID、真实 wire cancellation、runtime 更新、Windows launcher 和旧 Node launcher。
- Electron：runtime descriptor 生命周期及外部路由拒绝隐藏方法、拒绝错误参数、允许正常读取的专项通过。
- Desktop TypeScript 类型检查与 Vite Renderer/Main/Preload 三段生产构建通过。
- 实际冻结程序与无系统 Python/Node PATH 下的打包 launcher 验证通过（1 passed）：将完整产物复制到含中文/空格的临时安装布局，以真实 `.cmd` 启动，完成 stdio 发现和隔离桌面 mock 的 novel.list，中文 JSON 正确，stderr 无 Traceback。测试入口为 `NOVEL_MCP_PACKAGED_EXE` 指向已构建程序后执行 `test_packaged_launcher_without_system_python_or_node`。

本轮没有启动真实模型任务或提交草稿，不将 mock 成功作为真实写作质量或软件界面完整验收证据。

## 兼容和剩余范围

1. 依赖维持 FastMCP 3.4.3 / mcp 1.28.1，已验证协商版本为 2025-11-25。2026-07-28 支持仍需独立依赖兼容工作，不宣称 M0 全部完成。
2. 当前仍是原有 31 个外部工具；更多写作 CRUD、Agent 高层委托、AgentApplicationService 与无页面持久化属于后续 M1/M2。
3. 当前会话、Run、草稿既有业务状态机未被另建实现替代；关闭客户端不撤销已受理的章节后台 Operation。
4. 此批契约保留旧嵌套 object 与宽输出 schema，后续按工具细化。外部和内部使用不同参数的历史接口仍有显式 profile 覆盖。
5. 新网关需要更新后的 Electron `/mcp/invoke`，旧版桌面不支持该路由；源码升级后应重启桌面和 MCP 客户端。
6. macOS/Linux 的 launcher 和资源布局已接入，平台实机发布验证仍需在对应系统执行。

需求来源：[MCP 应用能力开放与 stdio 改造需求](./mcp-application-capabilities-requirements.md)。
