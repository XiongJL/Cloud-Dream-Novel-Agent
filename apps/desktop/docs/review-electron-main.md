# Electron Main Process (`electron/main.ts`) 代码审查报告

## 一、总体印象

该文件约 2870 行，是 Electron 主进程的唯一入口，承载了窗口管理、所有 IPC handler、数据库操作、AI 服务、搜索索引、同步、备份、自动化服务等全部职责。文件严重违反了单一职责原则（SRP），是本次审查中最核心的架构问题。

---

## 二、严重问题（Critical）

### 2.1 路径遍历安全漏洞（local-resource 协议）

**位置**: 第 2725-2729 行

```typescript
protocol.handle('local-resource', (request) => {
    const relativePath = decodeURIComponent(request.url.replace('local-resource://', ''));
    const fullPath = path.join(app.getPath('userData'), relativePath);
    return net.fetch('file:///' + fullPath.replace(/\\/g, '/'));
});
```

**问题**: `relativePath` 未经任何校验，攻击者可通过 `local-resource://../../etc/passwd` 或 `local-resource://../../../Windows/system.ini` 等路径遍历到 userData 目录之外的任意文件。虽然 `path.join` 在某些情况下会规范化路径，但 `..` 序列仍然有效。

**建议**: 添加路径白名单校验，确保解析后的绝对路径仍位于 `userData` 目录之下：

```typescript
const fullPath = path.resolve(path.join(app.getPath('userData'), relativePath));
if (!fullPath.startsWith(path.resolve(app.getPath('userData')))) {
    return new Response('Forbidden', { status: 403 });
}
```

### 2.2 文件删除操作中的路径遍历风险

**位置**: 第 1965-1989 行（`db:delete-character-image`）

```typescript
ipcMain.handle('db:delete-character-image', async (_, { characterId, imagePath, type }) => {
    const fullPath = path.join(app.getPath('userData'), imagePath);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
```

**问题**: `imagePath` 直接来自渲染进程，未经校验。恶意或被篡改的渲染进程可传入 `../../important-file.db` 删除 userData 目录外的文件。

**建议**: 对所有来自渲染进程的文件路径参数进行规范化后，校验是否位于允许的子目录内。

### 2.3 `--accept-data-loss` 标志的使用

**位置**: 第 2795 行

```typescript
const command = `"${prismaPath}" db push --schema="${schemaPath}" --accept-data-loss`;
```

**问题**: 开发模式下每次启动都执行 `--accept-data-loss` 的数据库迁移。虽然仅限开发环境（`!app.isPackaged`），但仍可能导致开发者意外丢失数据。建议至少添加确认提示或限制条件。

### 2.4 `execSync` 执行命令注入风险

**位置**: 第 2798 行

```typescript
const output = execSync(command, { ... });
```

**问题**: 虽然 `prismaPath` 和 `schemaPath` 均来自内部路径拼接，当前场景下注入风险较低，但 `execSync` 接受拼接字符串的模式本身是危险的。如果未来这些路径的来源发生变化，可能引入命令注入漏洞。

**建议**: 使用 `execFileSync` 替代，以数组形式传递参数，避免 shell 解析。

---

## 三、高优先级问题（High）

### 3.1 文件体积过大，违反单一职责原则

整个文件 2870 行，包含了：
- 窗口管理
- 60+ 个 IPC handler（数据库 CRUD、AI、搜索、同步、备份、自动化）
- 数据库迁移逻辑
- MCP 桥接逻辑
- AI 诊断命令解析
- 代理配置
- 文件操作工具函数

**建议**: 至少按以下维度拆分：
- `ipc/database.ts` — 所有数据库相关 IPC handler
- `ipc/ai.ts` — AI 相关 IPC handler
- `ipc/sync.ts` — 同步相关 IPC handler
- `ipc/maps.ts` — 地图系统 IPC handler
- `ipc/characters.ts` — 角色系统 IPC handler
- `lifecycle.ts` — 应用生命周期管理
- `migrations.ts` — 数据库迁移逻辑

### 3.2 大量 `any` 类型使用

**位置**: 全文多处，尤其是第 1760-2510 行的 Story Structure、Character、Item、World Settings、Map 系统

```typescript
return await (db as any).plotLine.findMany({ ... });
return await (db as any).character.findMany({ ... });
return await (db as any).mapCanvas.findMany({ ... });
```

**问题**: 大量 `(db as any)` 表明 Prisma Client 生成的类型未包含这些模型。这意味着：
1. 编译期无法捕获字段名拼写错误
2. 重构时无法安全地重命名字段
3. 开发者无法通过 IDE 自动补全了解可用字段

**建议**: 运行 `pnpm db:generate` 重新生成 Prisma Client 以包含所有模型类型，消除 `as any`。

### 3.3 IPC handler 参数缺乏输入校验

几乎所有 IPC handler 直接信任渲染进程传入的参数，例如：

```typescript
// 第 652 行
ipcMain.handle('db:update-novel', async (_, { id, data }) => {
    return await db.novel.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
});
```

**问题**:
- `id` 未校验是否为合法 UUID
- `data` 未校验字段类型和长度
- `title` 等字符串未做长度限制或 XSS 过滤
- `content` 字段可能包含任意大小的数据

**建议**: 使用 zod 或 joi 等库对所有 IPC 入参做 schema 校验。

### 3.4 `uncaughtException` 和 `unhandledRejection` 处理过于激进

**位置**: 第 30-42 行

```typescript
process.on('uncaughtException', (error) => {
    devLogError('Main.uncaughtException', error);
    console.error('[Main] Uncaught Exception:', error);
    app.quit();
    process.exit(1);
});
```

**问题**: `app.quit()` 后立即 `process.exit(1)` 可能导致：
1. 正在进行的数据库写入事务被中断，造成数据损坏
2. 搜索索引处于不一致状态
3. 未完成的 IPC 响应导致渲染进程挂起

**建议**: 在 `app.quit()` 前执行优雅关闭逻辑（断开数据库连接、停止自动化服务器等），并让 `will-quit` 事件处理最终退出。

### 3.5 `win!` 非空断言可能导致运行时崩溃

**位置**: 第 697、1911、2302 行

```typescript
const result = await dialog.showOpenDialog(win!, { ... });
```

**问题**: 如果在窗口已关闭但 app 仍在运行时调用这些 handler（macOS 的 `window-all-closed` 不退出 app），`win` 为 `null`，`win!` 会抛出异常。

**建议**: 在 handler 开头检查 `if (!win) throw new Error('Window not available')`，或使用可选链 `win?.`。

---

## 四、中优先级问题（Medium）

### 4.1 错误处理模式不一致

大部分 IPC handler 使用 `throw e` 将错误传播到渲染进程，但少数 handler 使用不同的模式：

- 第 1507 行 `ai:generate-map-image` 返回 `{ ok: false, code: 'UNKNOWN', detail: message }` 而非 throw
- 第 1552 行 `ai:openclaw-invoke` 返回 `{ ok: false, code, error }` 而非 throw
- 第 1676 行 `backup:import` 返回 `{ success: false, code, filePath }` 而非 throw
- 第 2007 行 `db:get-character-map-locations` 返回空数组 `[]` 而非 throw

**建议**: 统一错误处理策略，建议所有 handler 使用相同的错误包装格式。

### 4.2 数据库查询效率问题 — `db:get-novels`

**位置**: 第 620-650 行

```typescript
const novels = await db.novel.findMany({
    include: {
        volumes: {
            select: {
                chapters: { select: { content: true } }
            }
        }
    },
    orderBy: { updatedAt: 'desc' }
});
```

**问题**: 为了计算字数，查询加载了所有小说的所有章节的完整 `content` 字段。对于大型小说库（数十部小说、数千章节），这会消耗大量内存并导致显著延迟。

**建议**:
1. 将 `wordCount` 维护在章节级别（已在做），然后在数据库层面通过 `SUM` 聚合计算小说总字数
2. 或使用 Prisma 的 `_sum` 聚合功能

### 4.3 `db:save-chapter` 中搜索索引更新与事务不一致

**位置**: 第 1038-1092 行

```typescript
const [, updatedChapter] = await db.$transaction([...]);
// 事务提交后更新搜索索引
const chapterData = await db.chapter.findUnique({ where: { id: chapterId }, ... });
if (chapterData) {
    await searchIndex.indexChapter({ ...chapterData, novelId });
}
```

**问题**: 搜索索引更新在事务之外执行。如果索引更新失败，数据库中的内容已更新但搜索索引是旧的，导致数据不一致。

**建议**: 将搜索索引更新纳入事务范围，或实现补偿机制（失败时重试或记录待同步队列）。

### 4.4 `db:delete-chapter` 逻辑过于复杂

**位置**: 第 856-1002 行（约 150 行）

该 handler 包含了：查找章节、查找同小说所有章节、判断是否为唯一章节、事务内删除/重置、重排序兄弟章节、更新搜索索引等大量逻辑。

**建议**: 将业务逻辑提取到独立的 service 层，IPC handler 只负责参数校验和调用 service。

### 4.5 `console.log` 调试日志残留

全文件有大量 `console.log('[Main] ...')` 调试日志（约 40+ 处），例如：

```typescript
console.log('[Main] Received db:get-novels');
console.log('[Main] Updating novel:', id, data);
console.log('[Main] Saving chapter:', chapterId);
```

**问题**: 这些日志在生产环境中仍然输出，可能泄露敏感数据（小说内容、用户路径等），并影响性能。

**建议**: 使用统一的 `devLog` 系统（已有 `devLogger.ts`），在生产环境中自动禁用。

### 4.6 `SyncManager` 在模块顶层实例化

**位置**: 第 1251 行

```typescript
const syncManager = new SyncManager();
```

**问题**: `SyncManager` 在模块加载时就实例化，但此时数据库尚未初始化。如果构造函数中有数据库依赖，会导致运行时错误。

**建议**: 延迟到 `app.whenReady()` 中、数据库初始化完成后再实例化。

### 4.7 `aiService` 使用非空断言声明

**位置**: 第 1252 行

```typescript
let aiService!: AiService;
```

**问题**: 使用 `!` 断言告诉编译器该变量一定会被赋值，但实际上 `aiService` 在 `app.whenReady()` 的异步流程中才被初始化。如果在 ready 之前有 IPC handler 被调用（理论上不应该，但防御性编程应考虑），会访问到 `undefined`。

---

## 五、低优先级问题（Low）

### 5.1 代码重复 — AI IPC handler 的 try-catch 模式

从第 1257 行到第 1588 行，有约 30 个 AI 相关 IPC handler，每个都遵循完全相同的模式：

```typescript
ipcMain.handle('ai:xxx', async (_, payload) => {
    try {
        return await aiService.xxx(payload);
    } catch (e) {
        logAiIpcError('ai:xxx', payload, e);
        console.error('[Main] ai:xxx failed:', e);
        throw e;
    }
});
```

**建议**: 编写一个高阶函数来统一处理。

### 5.2 `db:get-all-tags` 中的 `@ts-ignore`

**位置**: 第 1743 行

```typescript
// @ts-ignore
const tags = await db.tag.findMany({ ... });
```

### 5.3 导入语句分散

`SyncManager`、`backupService` 的 import 分别在第 1250 行和第 1652 行，穿插在 IPC handler 之间，而非集中在文件顶部。

### 5.4 `extractTextFromLexical` 函数的健壮性

**位置**: 第 2566-2590 行

**问题**:
1. 对于极大或嵌套极深的 Lexical JSON，递归遍历可能导致栈溢出
2. 解析失败时直接返回原始 JSON 字符串，可能导致字数统计严重不准

### 5.5 硬编码的中文应用名称

**位置**: 第 46 行

```typescript
const PACKAGED_APP_NAME = '云梦小说编辑器';
```

---

## 六、安全检查清单

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `nodeIntegration` | 安全 | 未显式启用，默认为 `false` |
| `contextIsolation` | 安全 | 未显式禁用，默认为 `true` |
| `preload` 脚本 | 安全 | 使用 `contextBridge.exposeInMainWorld`，正确做法 |
| `sandbox` | 待确认 | 未显式设置，Electron 20+ 默认启用 |
| `devTools` | 安全 | 生产环境禁用（第 544 行 `devTools: isDevMode`） |
| 路径遍历 | **有漏洞** | `local-resource` 协议和文件删除操作存在路径遍历风险 |
| IPC 输入校验 | **缺失** | 所有 IPC handler 均未校验输入参数 |
| 敏感信息泄露 | **有风险** | 生产环境仍输出 `console.log` |

---

## 七、优先修复建议

1. **立即修复**: `local-resource` 协议的路径遍历漏洞（第 2725 行）和文件删除的路径校验（第 1966 行）
2. **短期优化**: 拆分文件、统一错误处理、替换 `execSync` 为 `execFileSync`
3. **中期改进**: 添加 IPC 输入校验、重新生成 Prisma Client 消除 `as any`、优化 `db:get-novels` 查询
4. **长期重构**: 提取业务逻辑到 service 层、实现搜索索引与事务的一致性保障
