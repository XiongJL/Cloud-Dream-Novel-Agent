# DEVELOPMENT.md

项目开发与 AI 协作规范（开发者向）。

## 1. 基本原则
- 架构：Electron + React + TypeScript（ESM）。
- 包管理器基线：`pnpm 8.15.9`。
- i18n：用户可见文案必须走国际化键，不直接硬编码。
- 分层：`packages/core` 保持纯逻辑/数据层，不引入 UI 依赖。

## 2. 数据库与模型变更流程
开发阶段修改 `packages/core/prisma/schema.prisma` 后，不再手工依赖运行时 `@prisma/client` 目录结构。当前流程是：

终端管理员运行打包：
pnpm --filter novel-editor-desktop run build
```bash 
pnpm --filter @novel-editor/core run build
```

该命令会同时完成：
- Prisma Client 生成到 `packages/core/generated/client`
- 生成首启建库 SQL：`packages/core/generated/client/schema-init.sql`
- TypeScript 编译到 `packages/core/dist`

说明：
- Desktop 的 `predev` / `prebuild` 已自动执行 `prepare:core`，正常情况下无需额外手工运行。
- 开发环境需要同步本地数据库结构时，仍可使用 `pnpm db:push`，但打包版不依赖运行时 `prisma db push`。
- 打包版首次启动发现数据库缺表时，会执行内置的 `schema-init.sql` 自动建表。
- 仓库初始化命令使用 `pnpm run setup`，不要使用 `pnpm setup`（后者会命中 pnpm 自带命令）。

## 3. Electron IPC 约定
- Main：`ipcMain.handle('namespace:action')`
- Preload：`contextBridge.exposeInMainWorld`
- Renderer：仅通过 `window.xxx` 调用，不直连 Node API

## 4. 调试方式
- 前端问题：Electron DevTools Console。
- 主进程问题：`pnpm dev` 终端输出。
- 类型问题：`pnpm --filter @novel-editor/desktop exec tsc --noEmit --pretty false`。

### 开发模式 Debug 日志
开发模式会额外写本地调试日志：

- 文件位置：Electron `userData/debug-dev.log`
- 生效范围：仅开发模式（不在打包用户环境启用）
- 文件策略：单文件上限 `15MB`，超出后直接覆盖重写

记录内容：
- 主进程错误：`console.error` / `console.warn` / `uncaughtException` / `unhandledRejection`
- AI 请求链路：HTTP Provider / MCP CLI Provider 的请求体、响应体、状态码、耗时、异常
- AI 业务入口摘要：标题生成、续写、AI 工坊、地图生成、提示词预览、确认入库

脱敏规则：
- 自动脱敏 `Authorization` / `apiKey` / `token` / `access_token` / `refresh_token`
- Prompt 和模型返回正文在开发模式下允许记录

### Desktop Dev Server 可选启动配置
默认开发命令不变：

```bash
pnpm --filter @novel-editor/desktop run dev
```

如需固定到本机 `localhost:8080` 供 Cloudflare Tunnel 转发，使用：

```bash
pnpm --filter @novel-editor/desktop run dev:8080
```

说明：
- `dev`：保持默认端口（当前由 Vite 默认或环境变量决定）。
- `dev:8080`：固定绑定 `127.0.0.1:8080`，仅本机监听，不直接对外暴露。
- `dev:local`：固定绑定 `127.0.0.1`，端口仍走默认值。

也可手动通过环境变量覆盖：

```bash
VITE_DEV_HOST=127.0.0.1
VITE_DEV_PORT=8080
pnpm --filter @novel-editor/desktop run dev
```

## 5. Dev Diagnostics（Terminal Only）
开发诊断不在用户界面暴露，只通过终端命令执行。

```bash
pnpm --filter @novel-editor/desktop run ai:diag -- smoke mcp
pnpm --filter @novel-editor/desktop run ai:diag -- smoke skill --json
pnpm --filter @novel-editor/desktop run ai:diag -- coverage
```

可选参数：
- `--json`: JSON 输出
- `--db <path>`: 指定 SQLite 文件
- `--user-data <path>`: 按 `<path>/novel_editor.db` 推导数据库

退出码：
- `0`: 成功
- `1`: 运行失败
- `2`: 参数错误

## 6. 打包与发布注意事项
- 诊断脚本放在 `apps/desktop/scripts`，不作为用户可见功能入口。
- 打包前确认 `packages/core` 已可用，避免 Prisma Client 缺失。
- 平台化打包命令：
  - Windows：`pnpm --filter novel-editor-desktop run build:win`
  - macOS DMG（当前机器架构）：`pnpm --filter novel-editor-desktop run build:mac`
- Windows 图标链路：
  - `build:win` 会先生成 `release/win-unpacked`
  - 再执行 `apps/desktop/scripts/fix-win-exe-icon.ps1` 修正主程序 `.exe` 图标
  - 最后基于 `--prepackaged release/win-unpacked` 生成安装版与便携版，确保资源管理器中的 `.exe` 图标与窗口/任务栏图标一致
- `build:mac` 需要在 macOS 环境执行；当前 Windows 开发机不作为生成正式 mac 安装包的目标环境。
- GitHub 自动发布：
  - 工作流：`.github/workflows/release.yml`
  - 触发方式：推送版本标签，例如 `git tag v0.1.3 && git push origin v0.1.3`
  - CI 中的 pnpm 版本与仓库声明保持一致，当前为 `8.15.9`
  - 行为：自动构建 Windows / macOS 产物，并上传到 GitHub Releases
- 打包体积控制：
  - `apps/desktop/package.json` 中仅保留主进程/预加载真正需要的运行时依赖在 `dependencies`
  - React、Lexical、UI 组件库等渲染层依赖应放在 `devDependencies`
  - `electron-builder.yml` 采用白名单 `files`，避免把 workspace 包源码、缓存和无关 `node_modules` 整包打入安装包
- 开发诊断参数（如 `--ai-diag`）仅开发环境可用，打包环境应拒绝。
- Prisma 打包策略已切换为：
  - 构建期生成 `packages/core/generated/client`
  - 打包时直接携带生成产物
  - 打包版首次启动通过 `ensureDbSchema()` 执行 `schema-init.sql`
- 当前不再把“运行时调用 Prisma CLI 做 `db push`”作为打包版初始化依赖。
- 后续版本升级建议走“版本化 migration runner”，而不是在用户机器上执行 `prisma db push`。

## 7. 文档更新原则
- 用户文档（`README.md` / `USER_GUIDE*.md`）仅描述用户可见能力。
- 开发诊断、覆盖矩阵、smoke 细节仅保留在开发文档。
- 每次阶段更新需同步 `.agent/*` 与用户文档，避免状态不一致。

## 8. AI 设置存储说明
- AI 设置持久化文件位于 Electron `userData` 目录下的 `ai-settings.json`。
- `http.apiKey` / `apiToken` 类敏感字段仅本地保存，不写入 `novel_editor.db`。
- 备份恢复流程不应导出或恢复 `ai-settings.json`；恢复后需要用户重新填写密钥。

## 9. 参考路径
- 桌面端：`apps/desktop`
- AI 主进程：`apps/desktop/electron/ai`
- 开发日志：`apps/desktop/electron/debug/devLogger.ts`
- AI 工坊 UI：`apps/desktop/src/components/AIWorkbench`
- 诊断脚本：`apps/desktop/scripts/ai-dev-diagnostics.mjs`
- Core Prisma 生成脚本：`packages/core/scripts/generate-prisma-client.mjs`
- 生成产物：`packages/core/generated/client`
