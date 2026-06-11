# AI 服务层 (`electron/ai/`) 代码审查报告

## 审查范围

目录 `electron/ai/` 下共 8 个文件：

- `AiService.ts` (2077 行) — 主服务类
- `types.ts` (300 行) — 类型定义
- `errors.ts` (78 行) — 错误处理
- `capabilities.ts` (649 行) — 能力注册与 CRUD handler
- `providers/HttpProvider.ts` (267 行) — HTTP API 提供者
- `providers/McpCliProvider.ts` (173 行) — CLI 子进程提供者
- `context/ContextBuilder.ts` (508 行) — 上下文构建器
- `summary/chapterSummary.ts` (693 行) — 章节摘要管理

---

## 一、提供者抽象与可扩展性

**评价：良好，有改进空间**

`AiProvider` 接口设计合理（`types.ts:84-89`），定义了 `healthCheck`、`generate`、可选的 `generateImage` 三个方法。目前有两个实现：`HttpProvider` 和 `McpCliProvider`。

**问题 1：提供者每次调用都重新实例化**
`AiService.getProvider()`（`AiService.ts:1926-1930`）每次调用都 `new HttpProvider()` 或 `new McpCliProvider()`。虽然当前实现是无状态的，但如果未来需要维护连接池或会话状态，这种模式会造成问题。建议缓存 provider 实例，仅在 settings 变更时重建。

**问题 2：McpCliProvider 不支持 `generateImage`**
`McpCliProvider` 没有实现 `generateImage` 方法，但调用方（如 `confirmCreativeAssets`、`generateMapImage`）只是做了简单检查后抛错。建议在接口层面或文档中明确标注不同 provider 的能力矩阵。

**问题 3：Provider 缺乏流式响应支持**
当前 `generate` 方法返回完整文本后再处理，对于长文本续写场景（4096 tokens）用户等待体验不佳。建议后续增加 `generateStream` 接口。

---

## 二、API Key 安全与存储

**评价：有安全隐患**

**严重问题：API Key 明文存储在 JSON 文件中**
`AiService.ts:250` 将 API Key 存储在 `userData/ai-settings.json` 中，且 `loadSettings` 和 `persistSettings` 没有任何加密措施。虽然 CLAUDE.md 中提到"AI keys stored in `userData/ai-settings.json`, never in the novel DB, excluded from backup/restore"，但明文存储仍存在风险：

- 任何能访问用户目录的程序/脚本都可以读取 API Key
- `persistSettings` 写入时使用 `JSON.stringify(this.settingsCache, null, 2)`，API Key 直接以明文出现

**建议**：使用 Electron 的 `safeStorage` API 对 API Key 进行加密存储，或至少提供加密选项。

**问题：日志中 API Key 泄露风险**
`HttpProvider.ts:72-75` 的 `devLog` 记录了 `headers: { Authorization: \`Bearer ${apiKey}\` }`，尽管 devLog 内部会调用 `redactForLog`，但此处传入的 `extra` 对象中 headers 是直接以字面量构造的字符串，`redactForLog` 的敏感字段检测依赖于 key 名称匹配（`authorization` 在 SENSITIVE_KEYS 中），所以这里实际上会被脱敏。但代码可读性差，容易在维护时引入新的泄露点。

**问题：HttpProvider 的日志记录了完整响应体**
`HttpProvider.ts:157-162` 在 devLog 中直接记录了 `text`（完整的 API 响应体），在生产环境中如果意外开启 devLog，可能泄露用户的小说内容。虽然 `isDevDebugEnabled()` 检查了 `NODE_ENV`，但作为防御性编程，建议对响应体也做截断处理。

---

## 三、错误处理与重试逻辑

**评价：有明显不足**

**严重问题：完全缺乏重试机制**
整个 AI 服务层没有任何重试逻辑。对于网络波动、429 限流等临时性错误，直接抛出异常给用户。在 `recordMapImageCall` 中虽然统计了 `rateLimitFailures`，但并没有利用这些数据进行退避重试。

**建议**：在 `HttpProvider.generate` 和 `HttpProvider.generateImage` 中增加指数退避重试逻辑，至少对 429、503、网络超时做 2-3 次重试。

**问题：错误分类基于字符串匹配，易误判**
`errors.ts:26-42` 的 `fromMessage` 函数通过 `text.includes('model')` 来判断 `PROVIDER_UNAVAILABLE`，这意味着任何包含 "model" 字样的错误消息都会被归类为不可用，例如 "Invalid model name" 这类配置错误也会被误判。

**问题：McpCliProvider 超时后进程可能未完全终止**
`McpCliProvider.ts:91-100` 中超时后调用 `child.kill('SIGTERM')`，但没有等待 `close` 事件确认进程已退出。在 Windows 上 `SIGTERM` 行为与 Unix 不同，可能需要额外处理。且在超时 reject 后，`close` 事件回调仍然可能触发（虽然 `done` flag 会阻止重复 resolve/reject）。

**问题：`checkConsistency` 功能过于简单**
`AiService.ts:767-780` 的一致性检查只检查了"是否存在世界观"和"文本是否过短"，没有真正的实体引用一致性、角色行为一致性等检查。作为小说写作工具的核心功能，这个实现过于简陋。

---

## 四、Token 管理与速率限制

**评价：不足**

**问题：缺乏 Token 预算管理**
`ContextBuilder` 估算了 token 数量（`estimateTokenCount`，`ContextBuilder.ts:81-86`），但这个估算值仅用于日志和上下文展示，没有用于实际的 token 预算裁剪。当上下文超出模型限制时，唯一的保护是 `HardContext` JSON 的 `.slice(0, 18000)` 和 `DynamicContext` 的 `.slice(0, 12000)` 硬截断（`AiService.ts:1679-1680`），这种做法会截断 JSON 结构导致解析问题。

**建议**：实现基于 token 估算的动态上下文裁剪，优先保留世界观设定和近期章节，逐步减少远期上下文。

**问题：缺乏请求频率限制**
没有任何请求队列或速率限制机制。用户可以快速连续触发多个 AI 请求（续写、标题生成、创作素材生成、地图生成），可能导致 API 限流。`chapterSummary.ts` 中的 debounce/节流机制仅适用于摘要重建。

**问题：`maxTokens` 使用全局配置，不区分场景**
续写（可能需要 4096 tokens）、标题生成（最多需要 256 tokens）、创作素材生成（可能需要 4096 tokens）都使用相同的 `this.settingsCache.http.maxTokens`。标题生成虽然覆盖了 `maxTokens: 128`，但创作素材生成没有做类似处理。

---

## 五、上下文构建与 Prompt 构造

**评价：设计合理，有改进空间**

**问题 1：`extractPlainTextFromLexical` 函数重复定义**
该函数在三个文件中分别定义：`AiService.ts:172-191`、`ContextBuilder.ts:60-79`、`chapterSummary.ts:89-108`。三份实现完全相同，属于明显的代码重复。应抽取到共享工具模块。

**问题 2：`DEFAULT_AI_SETTINGS` 重复定义**
在 `AiService.ts:115-153` 和 `chapterSummary.ts:22-51` 中各定义了一份。如果修改默认值需要同步两处，容易遗漏。

**问题 3：`loadAiSettings` 逻辑重复**
`AiService.loadSettings()`（`AiService.ts:1985-2003`）和 `chapterSummary.ts` 中的 `loadAiSettings()`（`chapterSummary.ts:163-181`）逻辑几乎相同，但路径来源不同（一个通过构造函数传入，一个通过 `app.getPath('userData')`）。如果两处路径不一致，会导致设置不同步。

**问题 4：硬编码的上下文截断长度**
`AiService.ts:1679-1680` 中 HardContext 截断 18000 字符、DynamicContext 截断 12000 字符是硬编码的魔法数字。这些值应根据目标模型的 context window 动态计算。

**问题 5：Prompt 中缺少系统角色的温度控制差异**
续写场景使用 `systemPrompt` + `userPrompt` 的标准格式，但系统提示过于简单（一行话）。对于小说续写这种需要精确控制的场景，应该有更丰富的系统指令，包括风格指南、禁止事项、输出格式要求等。

---

## 六、流式响应处理

**评价：未实现**

当前所有 AI 请求都是非流式的——等待完整响应后才返回。对于续写场景（4096 tokens，可能等待 10-30 秒），用户体验较差。建议优先在 `HttpProvider` 中实现 SSE 流式解析。

---

## 七、类型安全

**评价：有明显缺陷**

**严重问题：大量使用 `(db as any)` 类型断言**
在 `capabilities.ts` 和 `ContextBuilder.ts` 中，对 `plotLine`、`character`、`item`、`mapCanvas`、`worldSetting`、`narrativeSummary`、`chapterSummary` 等模型的查询全部使用 `(db as any)`。这意味着：
- 完全绕过了 Prisma 的类型检查
- 字段名拼写错误无法在编译期发现
- 查询参数类型错误只能在运行时暴露

**建议**：运行 `pnpm db:generate` 重新生成 Prisma Client 以包含这些新模型的类型定义，然后移除 `(db as any)` 断言。

**问题：`capabilityHandler` 的 payload 类型为 `unknown`**
`capabilities.ts` 中所有 handler 的 payload 类型都是 `unknown`，内部通过 `as { ... }` 强制转换。虽然做了运行时校验（如检查 `novelId` 是否存在），但缺乏编译期保障。建议引入 zod 或 io-ts 等运行时校验库。

---

## 八、内存泄漏与资源管理

**评价：有潜在风险**

**问题 1：全局 Timer Map 未在应用退出时清理**
`chapterSummary.ts:53-56` 定义了四个全局 Map（`pendingTimers`、`aiPendingCounters`、`finalizeTimers`、`narrativeTimers`），其中存储的 `setTimeout` 回调在应用退出时没有清理机制。虽然 Electron 退出时进程会被终止，但在开发模式下的热重载场景中可能导致悬挂的 timer 引用已销毁的数据库连接。

**建议**：增加 `dispose()` 或 `shutdown()` 方法，在应用退出前清理所有 pending timer。

**问题 2：`saveImageAsset` 没有对下载的图片大小做流式限制**
`AiService.ts:1943-1955` 中通过 `fetch` 下载远程图片时，先将整个响应读入 `arrayBuffer`，再检查大小。如果远程 URL 返回一个超大文件（如 1GB），会先消耗大量内存再被拒绝。应该使用 `content-length` 头或流式读取进行限制。

---

## 九、其他值得注意的问题

**问题 1：`confirmCreativeAssets` 事务中包含文件 I/O**
`AiService.ts:1194-1354` 在 `db.$transaction` 内部调用了 `provider.generateImage()`（网络请求）和 `this.saveImageAsset()`（文件写入）。这意味着：
- 事务持续时间可能非常长（网络请求 + 图片生成可能需要几十秒）
- SQLite 事务期间会持有数据库锁，影响其他操作
- 如果 `saveImageAsset` 的文件写入成功但事务后续失败，需要回滚文件（虽然 catch 块中做了清理）

**建议**：将图片生成移到事务外部，事务内只做数据库操作。

**问题 2：`sortOrder` 使用 `Date.now()` 作为排序值**
`AiService.ts:1205-1206` 和多处使用 `Date.now() + localCreated.xxx` 作为 `sortOrder`。这种做法在并发创建时可能导致排序不一致。

**问题 3：`fromMessage` 中 `text.includes('503')` 和 `text.includes('model')` 共用 `PROVIDER_UNAVAILABLE`**
`errors.ts:36` 将 503 和 "model" 归为同一类错误，但 "model not found" 是配置错误（应为 `INVALID_INPUT`），"503 Service Unavailable" 是临时性错误。这种混同会导致错误的用户提示和重试策略。

**问题 4：`chapterSummary.ts` 中 `buildAiSummary` 的 JSON 解析没有容错**
`chapterSummary.ts:232` 直接 `JSON.parse(response.text || '{}')`，如果 AI 返回了非 JSON 格式的文本（如包含 markdown 代码块），会直接抛出异常。而 `AiService.generateTitle` 中有 try-catch 包裹和行级 fallback，此处应保持一致。

**问题 5：`updateSettings` 的浅合并可能导致嵌套对象丢失**
`AiService.ts:377-387` 的 `updateSettings` 只做了一层嵌套合并。如果 `partial.http` 存在，会完全替换 `http` 的子字段。

---

## 十、总结与优先级建议

| 优先级 | 问题 | 影响 |
|--------|------|------|
| **P0 (严重)** | API Key 明文存储 | 安全风险 |
| **P0 (严重)** | 大量 `(db as any)` 类型断言 | 运行时崩溃风险 |
| **P1 (高)** | 完全缺乏重试机制 | 用户体验差，频繁报错 |
| **P1 (高)** | 事务中包含网络/文件 I/O | 数据库锁竞争，性能问题 |
| **P1 (高)** | 流式图片下载无大小预限制 | 潜在内存溢出 |
| **P2 (中)** | `extractPlainTextFromLexical` 等函数重复 | 维护成本高 |
| **P2 (中)** | 缺乏 Token 预算管理 | 超长上下文被硬截断 |
| **P2 (中)** | 缺乏请求频率限制 | 易触发 API 限流 |
| **P2 (中)** | 全局 Timer 未清理 | 开发模式资源泄漏 |
| **P3 (低)** | 未实现流式响应 | 用户体验可优化 |
| **P3 (低)** | 错误分类字符串匹配粗糙 | 用户提示不准确 |
| **P3 (低)** | `checkConsistency` 过于简单 | 功能完整性不足 |
