# Desktop 代码审查总览报告

## 审查范围

共审查 `apps/desktop/` 下 11 个模块，产出 10 份详细报告。

| 模块 | 报告文件 | 主要文件数 | 代码行数 |
|------|----------|-----------|---------|
| Electron Main Process | review-electron-main.md | 1 | ~2870 |
| AI Service Layer | review-ai-service.md | 8 | ~4750 |
| IPC / Sync / Search | review-ipc-sync-search.md | 4 | ~2000 |
| Editor Component | review-editor.md | 20+ | ~5000 |
| Lexical Editor | review-lexical-editor.md | 14 | ~3500 |
| AIWorkbench | review-ai-workbench.md | 4 | ~1230 |
| StoryWorkbench | review-story-workbench.md | 11 | ~3500 |
| WorldWorkbench | review-world-workbench.md | 10 | ~2800 |
| MapWorkbench | review-map-workbench.md | 2 | ~1220 |
| Frontend Modules (hooks/i18n/utils/ui/settings/search) | review-frontend-modules.md | 20+ | ~6000 |

---

## 全局共性问题

### 1. 安全漏洞（P0）

| 问题 | 位置 | 影响 |
|------|------|------|
| `local-resource` 协议路径遍历 | electron/main.ts:2725 | 可读取 userData 外任意文件 |
| 文件删除路径遍历 | electron/main.ts:1965 | 可删除 userData 外任意文件 |
| API Key 明文存储 | electron/ai/AiService.ts:250 | 安全风险 |
| IPC 输入校验完全缺失 | electron/main.ts 全文 | 任意参数透传到 Prisma |

### 2. 类型安全（P1）

| 问题 | 出现次数 | 涉及模块 |
|------|---------|---------|
| `(db as any)` 类型逃逸 | 50+ 处 | main.ts, AiService, capabilities, ContextBuilder |
| `any` 类型参数 | 30+ 处 | preload.ts, SearchSidebar, NarrativeMatrix, 各 hooks |
| `@ts-ignore` | 3 处 | main.ts, SettingsModal, UnifiedSearchWorkbench |

### 3. i18n 问题（P0-P1）

| 问题 | 涉及文件数 | 说明 |
|------|-----------|------|
| 硬编码中文 | 15+ 处 | aiError.ts, FlowModeButton, useShortcuts, AISettingsPanel, EditorToolbar, MentionNode 等 |
| 乱码 fallback | 4 处 | EditorWorkspace, MapCanvas — GBK 编码被当 UTF-8 解码 |
| en.json 缺失翻译键 | 大量 | world 命名空间仅 3 个键，map 命名空间缺 18 个键 |
| i18n key 不存在 | 10+ 处 | AIWorkbench, StoryWorkbench 多个键在 locale 文件中不存在 |

### 4. 架构问题（P1）

| 问题 | 位置 | 建议 |
|------|------|------|
| main.ts 2870 行 | electron/main.ts | 按职责拆分为 ipc/database.ts, ipc/ai.ts, lifecycle.ts 等 |
| EditorWorkspace 1345 行 | pages/editor/EditorWorkspace.tsx | 拆分 JSX 为子组件 |
| MapCanvas 902 行 | MapWorkbench/MapCanvas.tsx | 提取 AI 逻辑为 hook，拆分工具栏/角色面板 |
| SearchSidebar 908 行 | SearchWorkbench/SearchSidebar.tsx | 拆分为独立的分组渲染组件 |
| AISettingsPanel 627 行 | Settings/AISettingsPanel.tsx | 拆分为 HTTP/MCP/代理/测试子面板 |

### 5. 代码重复（P2）

| 问题 | 位置 |
|------|------|
| `extractPlainTextFromLexical` 定义 3 次 | AiService.ts, ContextBuilder.ts, chapterSummary.ts |
| `DEFAULT_AI_SETTINGS` 定义 2 次 | AiService.ts, chapterSummary.ts |
| `loadAiSettings` 逻辑重复 2 次 | AiService.ts, chapterSummary.ts |
| `getTypeIcon` 定义 2 次 | PlotPointItem.tsx, NarrativeMatrix.tsx |
| AI IPC handler try-catch 模式重复 30 次 | main.ts |
| DraftDock 6 个 section 渲染逻辑重复 | AIWorkbenchDraftDock.tsx |

### 6. Modal 规范违反（P2）

| 组件 | 问题 |
|------|------|
| SettingsModal | 未继承 BaseModal，自行实现 overlay |
| PlotAnchorModal | 未继承 BaseModal |
| ContinueWritingModal | 未使用 BaseModal |
| CharacterPreviewCard | 使用 createPortal 绕过 BaseModal |
| BackupRestorePanel | 使用原生 `confirm()` 而非 ConfirmModal |

### 7. console.log 残留（P2）

| 文件 | 位置 |
|------|------|
| electron/main.ts | 40+ 处 |
| LexicalEditor/index.tsx | :275 (JSX 中) |
| PlotAnchorInteractionPlugin.tsx | :25 |
| AutoFormatPlugin.tsx | :150 |
| PlotPointModal.tsx | :356 |

### 8. 同步模块设计缺陷（P1）

| 问题 | 严重度 |
|------|--------|
| 无冲突解决机制 | 严重 |
| Pull/Push 竞态条件 | 高 |
| 同步范围不完整（仅 novels/volumes/chapters） | 中 |
| 搜索未使用 FTS5 MATCH 语法 | 中 |

---

## 严重 Bug 汇总

| # | Bug | 位置 | 影响 |
|---|-----|------|------|
| 1 | 路径遍历漏洞 | main.ts:2725, 1965 | 安全 |
| 2 | EntityInfoCard hooks 规则违反 | StoryWorkbench/EntityInfoCard.tsx:22 | 运行时崩溃 |
| 3 | MentionNode 未注册到 LexicalComposer | LexicalEditor/index.tsx:178 | 反序列化失败 |
| 4 | MentionInteractionPlugin 是死代码 | LexicalEditor/plugins/ | 空 editor.update 调用 |
| 5 | 同步无冲突解决 | electron/sync/SyncManager.ts | 数据丢失 |
| 6 | API Key 明文存储 | electron/ai/AiService.ts:250 | 安全 |
| 7 | en.json world 命名空间大量缺失 | i18n/locales/en.json | 英文用户看到中文 |
| 8 | AutoFormatPlugin 全文遍历性能风险 | LexicalEditor/plugins/AutoFormatPlugin.tsx | 大文档卡顿 |

---

## 优先修复路线图

### Phase 1: 安全 & 崩溃修复（立即）

1. 修复 `local-resource` 协议路径遍历
2. 修复文件删除路径校验
3. 修复 EntityInfoCard hooks 规则违反
4. 注册 MentionNode 到 LexicalComposer
5. 删除 MentionInteractionPlugin 死代码

### Phase 2: i18n 补全（短期）

1. 补全 en.json 中 world、map 命名空间的缺失翻译键
2. 将所有硬编码中文替换为 i18n key
3. 修复乱码 fallback 字符串
4. 补全 AIWorkbench、StoryWorkbench 缺失的 i18n key

### Phase 3: 类型安全 & 代码质量（中期）

1. 运行 `pnpm db:generate` 重新生成 Prisma Client，消除 `(db as any)`
2. 对 IPC 入参添加 zod schema 校验
3. 清理所有 `console.log` 残留
4. 统一 Modal 使用 BaseModal
5. 将 `confirm()` 替换为 ConfirmModal

### Phase 4: 架构优化（长期）

1. 拆分 main.ts 为多个模块
2. 拆分大组件（EditorWorkspace, MapCanvas, SearchSidebar 等）
3. 消除代码重复（extractPlainTextFromLexical, DEFAULT_AI_SETTINGS 等）
4. 同步模块引入冲突解决机制
5. 搜索模块改用 FTS5 MATCH 语法
6. AI 服务添加重试机制和流式响应
