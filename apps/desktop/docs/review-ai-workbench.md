# AIWorkbench 组件代码审查报告

## 审查范围

`src/components/AIWorkbench/` 目录，包含 4 个文件：
- `types.ts` (107行) — 类型定义
- `AIWorkbenchPanel.tsx` (759行) — 主面板，生成/确认流程
- `AIWorkbenchDraftDock.tsx` (332行) — 右侧草稿编辑区
- `AssetDraftList.tsx` (34行) — 通用列表容器

---

## 一、严重问题 (Bugs / 高风险)

### 1. i18n 缺失键 + 硬编码中文回退

`AIWorkbenchPanel.tsx` 第 530-583 行有 6 个 `t()` 调用使用了硬编码中文作为第二参数回退值，这些 key 在 `zh.json` 和 `en.json` 中均不存在：

```
t('aiWorkbench.contextSettings', '上下文配置')
t('aiWorkbench.includeExistingEntities', '包含已有角色/物品/情节线')
t('aiWorkbench.filterCompletedPlotLines', '过滤已完成的情节点')
t('aiWorkbench.contextChapterCount', '参考章节摘要数')
t('aiWorkbench.contextChapterNone', '不参考')
t('aiWorkbench.estimatedContextTokens', '预估上下文 Token')
```

在英文 locale 下这些文本会显示中文，严重影响国际化体验。

### 2. useEffect 缺少依赖 / stale closure 风险

第 312-316 行 `refreshPromptPreview` 未列入依赖数组。它是一个普通函数（非 `useCallback`），每次渲染都会重新创建。effect 内部捕获的 `refreshPromptPreview` 可能引用过期的闭包变量。

### 3. `as unknown as` 不安全类型断言

第 301 行 `setPromptPreview(preview as unknown as PromptPreviewData)` 和第 303 行 `(preview as any)` 双重类型断言绕过了类型系统。

### 4. `firstIssueSummary` 的 useMemo 缺少依赖

第 202-207 行 `formatIssueCode` 依赖 `t()` 函数，语言切换时 `t` 变化但 `errors` 不变，会导致显示旧语言的错误码文本。

---

## 二、中等问题

### 5. 状态管理过于碎片化 — 16 个 useState

其中许多高度相关（如 `isGenerating` / `flowStage` / `statusLevel` / `statusText` 构成一个状态机），建议合并为 useReducer 或自定义 hook。

建议分组：
- **流程状态组**: `flowStage` + `statusLevel` + `statusText` + `isGenerating` + `isConfirming` -> 一个 reducer
- **结果组**: `warnings` + `errors` + `created` + `showIssueDetails` -> 一个 reducer
- **配置组**: `generationMode` + `targetSections` + `contextChapterCount` + `includeExistingEntities` + `filterCompletedPlotLines` -> 一个对象 state

### 6. AIWorkbenchDraftDock 大量重复代码

6 个 section 的渲染逻辑高度雷同，约 250 行可压缩到 50 行以内。建议抽取通用 `DraftSectionEditor` 组件。

### 7. `removeAt` 使用 `(nextDraft as any)[category]`

`as any` 绕过了类型检查。`CreativeSection` 已经是 `keyof CreativeAssetsDraft` 的子集，无需 `as any`。

### 8. 每次输入变更都创建完整新对象

每个按键都会浅拷贝整个 draft + 对应数组 + 被修改的元素。可考虑使用 Immer 或对 textarea 使用 onBlur 而非 onChange。

### 9. 列表 key 使用数组 index

如果列表发生排序、插入、删除操作，index-based key 会导致不必要的 DOM 销毁重建和 checkbox 状态错乱。

---

## 三、低等问题

### 10. 无错误边界 (Error Boundary)

整个 AIWorkbench 没有 ErrorBoundary 包裹。AI 返回异常数据会导致面板白屏。

### 11. 可访问性问题

- textarea 没有 `<label>` 或 `aria-label`
- 删除按钮只有图标没有文字，应添加 `aria-label`
- 进度条缺少 `role="progressbar"` 和 `aria-valuenow`/`aria-valuemax`

### 12. 自定义事件通信模式脆弱

使用 `window.dispatchEvent(new CustomEvent(...))` 进行跨组件通信，没有类型安全保障。

### 13. `handleConfirm` 中验证失败的错误提示不匹配

第 337-339 行显示"请至少勾选一项再入库"，但实际问题是 `draftSession` 无效。

---

## 四、总结与优先级建议

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P0 | i18n 缺失键（6个硬编码中文回退） | 补充到 zh.json 和 en.json |
| P0 | `firstIssueSummary` 缺少 `t` 依赖 | 将 `formatIssueCode` 改为 `useCallback` |
| P1 | useEffect 依赖不完整 | 将 `refreshPromptPreview` 包装为 `useCallback` |
| P1 | `as unknown as` / `as any` 类型断言 | 修正后端返回类型或使用运行时校验 |
| P1 | 16 个 useState 碎片化 | 合并为 useReducer 或自定义 hook |
| P2 | DraftDock 250 行重复代码 | 抽取通用 `DraftSectionEditor` |
| P2 | 无错误边界 | 包裹 ErrorBoundary |
| P2 | 可访问性缺失 | 添加 label、aria 属性 |
| P3 | 自定义事件通信 | 迁移到 Context 或状态管理库 |
