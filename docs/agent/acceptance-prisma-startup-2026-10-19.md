# Worktree 启动失败修复

日期：2026-10-19。

## 根因

`DraftOperationStore.listRecoverable()` 调用 `db.draftGenerationOperation.findMany()` 时，当前 worktree 的生成客户端仍为 Prisma 5.10.2，且没有 `DraftGenerationOperation`、`DraftGenerationAttempt`、`DraftOperationOutbox` 等新增模型；项目依赖及 schema 已更新到 6.19.2。

桌面包此前只在 `predev` 中调用 Core 构建。当前 pnpm 8.15.9 的运行实现默认 `enablePrePostScripts: false`，未配置自动执行该钩子，因此 `pnpm dev` 可绕过生成步骤，直接加载过期客户端。错误发生于客户端模型解析，尚未执行该模型的查询。

## 修复

- `apps/desktop/package.json` 的 `dev`、`dev:local`、`dev:8080` 显式先执行 `pnpm run prepare:core`，成功后再启动 Vite/Electron。
- 移除重复的 `predev`，避免开启 pnpm 钩子的环境重复生成。
- 在报错 worktree 重新构建 Core，生成 Prisma 6.19.2 客户端及 schema-init.sql，并完成 Core TypeScript 编译。
- README 更新开发启动说明。

## 验证

- 实际加载的客户端版本为 6.19.2，草稿 Operation、Attempt、Outbox 等模型的 `findMany` 均为函数。
- `draft-operation-store-test.mjs`、`draft-operation-coordinator-test.mjs`、`database-lifecycle-test.mjs` 通过，使用临时 SQLite 数据库。
- 通过修改后的真实 `pnpm run dev` 启动 Electron，使用独立 `NOVEL_EDITOR_USER_DATA_DIR`。确认启动日志包含 Core 重新生成和搜索索引初始化，Automation 健康接口可用，越过原先 `AutomationService.initialize()` 失败位置后持续运行，未出现同类异常。
- 验证结束后停止测试进程。未对用户真实小说数据库执行 db push、重置或数据修改。

## 主工程同步与 Windows 引擎占用修复

上述启动脚本修复和文档已同步到 `D:\aiproject\novalEditor`。同步复验时发现已有 Electron 进程加载了主工程的引擎 DLL，重复运行 Prisma generate 会触发 Windows `EPERM`。

生成脚本现会检查 schema（忽略格式化对齐，保留字符串和标识符边界）、生成客户端/SDK 版本、完整入口文件、运行时代码和引擎 SHA-256。一致时复用现有客户端，仍重新生成建库 SQL 并编译 Core；任一项不一致则必须重新生成，失败时明确提示关闭占用引擎的进程后重试，不使用过期模型继续启动。

`prisma-client-readiness-test.mjs` 验证格式化差异可复用，字符串默认值/模型/标识符变化、旧 SDK/运行时/引擎及缺失文件必须重新生成。主工程在引擎 DLL 已被现有 Electron 加载的状态下完成 Core 构建，未中断原有应用。
