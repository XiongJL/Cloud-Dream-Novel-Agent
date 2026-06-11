# Electron IPC / 同步 / 搜索模块代码审查报告

## 审查范围

- `electron/preload.ts` — Context Bridge API
- `electron/services/` — IPC 服务处理
- `electron/sync/` — 云同步逻辑
- `electron/search/` — 全局搜索引擎

---

## 一、IPC Handler 安全性（输入验证与类型安全）

### 1. 严重 — 缺少输入验证

几乎所有 IPC handler 直接将渲染进程传入的参数透传给 Prisma，没有任何输入验证：

- `db:create-novel` 接收 `title: string`，但未校验长度、是否为空字符串、是否含特殊字符
- `db:save-chapter` 接收 `{ chapterId, content }`，未校验 `chapterId` 格式（应为 CUID/UUID）
- `db:create-character` / `db:update-character` 接收 `data: any`，任意字段可被注入
- `db:create-idea` / `db:update-idea` 同样是 `data: any`

**建议**：对所有 IPC 入口使用 zod 或 io-ts 做 schema 验证，至少校验 ID 格式和字段长度上限。

### 2. 严重 — `(db as any)` 类型逃逸泛滥

`main.ts` 中大量使用 `(db as any).xxx` 来绕过 Prisma 类型检查（约 50+ 处）。这意味着：
- 字段名拼写错误不会在编译期捕获
- 传入错误的数据结构不会报类型错误
- Prisma schema 变更后，这些调用不会同步报错

### 3. 中等 — 搜索关键词注入风险

`searchIndex.ts` 第 229 行：
```ts
const escapedKeyword = keyword.replace(/[%_]/g, '\\$&');
const likePattern = `%${escapedKeyword}%`;
```
虽然转义了 `%` 和 `_`，但使用的是 `LIKE` 而非 FTS5 的 `MATCH` 语法。如果将来切换到 FTS5 MATCH 查询，当前的转义逻辑不够。此外，`keyword` 没有长度上限，超长关键词可能导致性能问题。

### 4. 中等 — 路径遍历风险

`BackupService.restoreAutoBackup` 第 261 行：
```ts
const filePath = path.join(this.getAutoBackupDir(), filename);
```
`filename` 来自渲染进程，虽然在自动备份目录下拼接，但如果 `filename` 包含 `../`，`path.join` 不会阻止路径遍历。

### 5. 低 — `local-resource` 协议路径遍历

`main.ts` 第 2726-2729 行的 `protocol.handle` 中，如果渲染进程构造 `local-resource://../../Windows/System32/config/SAM`，理论上可以读取 userData 目录外的文件。应校验 `fullPath` 确实以 `userData` 路径开头。

---

## 二、同步冲突解决

### 6. 严重 — 无冲突解决机制

`SyncManager.ts` 的 pull/push 实现存在根本性设计问题：

- **Pull**：使用 `upsert` 直接覆盖本地数据（第 42-69 行），服务端数据永远优先，本地未同步的修改会被静默覆盖
- **Push**：使用 `updatedAt > cursor` 筛选变更（第 100-103 行），但 cursor 在 pull 成功后立即更新（第 75 行），这意味着 pull 之后立即 push 会遗漏 pull 刚写入的数据
- **无版本向量/向量时钟**：无法检测同一记录在两端同时被修改的情况
- **无合并策略**：章节内容是整体覆盖，不存在字段级合并

### 7. 高 — 同步竞态条件

- Pull 和 Push 没有互斥锁。如果用户快速触发 pull + push，可能出现：pull 写入数据 → push 读取到 pull 的数据 → push 将服务端数据再推回去（形成回环）
- 第 86 行注释承认了这个问题："Ideally should track separate push cursor, but simple sync uses same time base"
- 没有乐观锁/ETag 机制，并发修改无法检测

### 8. 中等 — 同步范围不完整

Push 只同步 `novels`、`volumes`、`chapters`（第 99-103 行），Pull 也只同步这三张表。Characters、Ideas、Tags、WorldSettings、PlotLines 等数据完全不在同步范围内，用户可能误以为所有数据都已同步。

---

## 三、搜索索引与性能

### 9. 中等 — 搜索未使用 FTS5 的 MATCH 语法

`searchIndex.ts` 第 243-248 行使用 `LIKE` 查询，但表是 FTS5 虚拟表。应该使用 `WHERE search_index MATCH 'keyword'`。当前的 `LIKE '%keyword%'` 无法利用 FTS5 的倒排索引，对于大文档会退化为全表扫描。

### 10. 中等 — 搜索结果爆炸

第 310-311 行限制了最多 200 个匹配位置，但没有限制最终结果总数。如果一个长章节包含大量匹配，单个章节可能产生上百条结果。应增加 `allResults.length` 上限检查。

### 11. 低 — 索引更新非批量

`rebuildIndex` 中逐条 `indexChapter` / `indexIdea`，每条都先 DELETE 再 INSERT。对于大项目，应使用事务包裹批量操作。

### 12. 低 — FTS5 表初始化吞异常

`initSearchIndex` 第 81-83 行在 catch 中仅 `console.error`，不抛出异常。如果 FTS5 初始化失败，后续搜索会静默失败。

---

## 四、错误处理模式

### 13. 中等 — 错误信息泄露

多数 IPC handler 的 catch 块直接 `throw e`，原始错误（包含数据库结构、文件路径等）会通过 IPC 传回渲染进程。如果渲染进程被 XSS 攻击，这些信息可被利用。

### 14. 低 — 不一致的错误返回模式

- `backup:import` 返回 `{ success: false, code }` 而非抛出异常
- `ai:openclaw-invoke` 返回 `{ ok: false, error }` 而非抛出异常
- 其他大多数 handler 直接 throw

---

## 五、Preload API 暴露面

### 15. 高 — API 暴露面过大

`preload.ts` 暴露了约 80+ 个 IPC 方法到渲染进程，分为 6 个命名空间（`db`、`electron`、`sync`、`backup`、`ai`、`automation`）。其中：

- `automation.invoke` 允许渲染进程调用任意 automation method，包括 `chapter.create`、`story_patch.apply` 等数据修改操作
- `ai.*` 命名空间暴露了大量 AI 操作，包括 `updateSettings`（可修改 AI 配置）
- `backup.export` / `backup.import` 可读写文件系统

### 16. 中等 — `any` 类型参数过多

preload 中大量使用 `data: any`、`payload: any`、`partial: any` 等类型，丧失了 TypeScript 的类型安全优势。

### 17. 低 — 缺少 `contextIsolation` 显式确认

`main.ts` 创建 BrowserWindow 时没有显式设置 `contextIsolation: true`（虽然默认为 true）。应在 webPreferences 中显式声明所有安全相关选项。

---

## 六、同步竞态条件（补充）

### 18. 高 — 保存章节与搜索索引更新非原子

`db:save-chapter` handler：先在事务中更新章节内容和字数，事务提交后再更新搜索索引。如果步骤 2 失败，数据库中的章节内容已更新但搜索索引是旧的。

### 19. 中等 — 删除章节与搜索索引更新非原子

类似地，`db:delete-chapter` 在事务中删除章节，但事务提交后才更新搜索索引。如果应用在两者之间崩溃，搜索索引会残留已删除章节的条目。

---

## 七、其他安全问题

### 20. 中等 — 备份密码强度未校验

`BackupService.encryptData` 接受任意长度密码，包括空字符串。应强制最小密码长度。

### 21. 低 — `execSync` 使用

`main.ts` 第 2798 行使用 `execSync` 执行 Prisma CLI。虽然参数来自硬编码路径，但 `execSync` 本身是阻塞操作，会阻塞主进程。应添加超时参数。

---

## 优先修复建议

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P0 | 路径遍历（`local-resource` 协议、`restoreAutoBackup`） | 校验路径前缀 |
| P0 | 同步无冲突解决 | 引入版本号/向量时钟，至少增加冲突检测 |
| P1 | IPC 输入验证 | 使用 zod schema 验证所有入参 |
| P1 | `(db as any)` 类型逃逸 | 更新 Prisma Client 并移除 as any |
| P1 | 搜索未用 FTS5 MATCH | 改用 FTS5 查询语法 |
| P2 | API 暴露面 | 按最小权限原则裁剪 preload API |
| P2 | 错误信息泄露 | 捕获并清理错误后返回通用消息 |
| P3 | 安全选项显式声明 | 在 BrowserWindow 中显式设置安全选项 |
