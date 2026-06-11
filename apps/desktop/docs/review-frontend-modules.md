# 前端模块代码审查报告

## 审查范围

涵盖 `src/` 下的 hooks、i18n、utils、UI 组件、Settings、SearchWorkbench 等 14 个模块/文件。

---

## 一、各模块审查结果

### 1. `hooks/useEditorPreferences.tsx` — 编辑器偏好设置

**优点：** Context + Provider 模式正确，localStorage 持久化逻辑清晰

**问题：**
- (中) 导入了未使用的 `React`
- (低) 缺少跨标签页同步

### 2. `hooks/usePlotSystem.ts` — 情节系统

**优点：** 依赖数组正确，乐观更新 + 回滚策略

**问题：**
- (中) `err: any` 应改为 `unknown`
- (低) `removeAnchor` 缺少 `dispatchUpdate()` 调用

### 3. `hooks/useShortcuts.ts` — 快捷键

**问题：**
- **(高) 硬编码中文**：第 27 行 `formatShortcut` 中 `return '无'`
- (中) `isMatch` 中有死代码（`action === 'redo'` 分支）

### 4. `hooks/useHistory.ts` — 撤销/重做历史

**评价：** 质量较高的 hook，"按暂停分组"策略设计巧妙。无问题。

### 5. `hooks/useDebounce.ts` — 防抖

**评价：** 标准实现，简洁正确。无问题。

---

### 6. `i18n/` — 国际化

**优点：** 结构清晰，中英文 key 结构完全一致，覆盖率约 780+ key

**问题：**
- (中) zh.json / en.json 末尾有空行
- (低) `fallbackLng: 'en'` 但默认语言为 `'zh'`

**评价：** i18n 做得很好，覆盖率很高。

---

### 7. `utils/` — 工具函数

- **`aiError.ts`** — **(高) `formatAiError` 全部错误消息硬编码中文**，未使用 i18n
- **`avatarUtils.ts`** — 简洁正确，无问题
- **`format.ts`** — 实现完整，无问题

---

### 8. `components/ui/` — 共享 UI 组件

- **BaseModal.tsx** — 设计良好，ESC 关闭逻辑正确
- **ConfirmModal.tsx** — (中) Enter 键确认可能导致误操作
- **Button.tsx** — 标准实现，无问题
- **Combobox.tsx** — (中) `'Nothing found.'` 硬编码英文
- **IconPicker.tsx** — 质量良好

---

### 9. `components/Settings/AISettingsPanel.tsx`

**问题：**
- **(高) 硬编码中文**：测试 prompt `'请用一句话生成一个玄幻小说章节标题'`
- (中) 组件过大（627 行），应拆分
- (中) `useEffect` 依赖 `[t]`，语言切换时会重新加载设置

### 10. `components/Settings/BackupRestorePanel.tsx`

**问题：**
- **(高) 使用 `confirm()` 而非 `ConfirmModal`** — 违反项目规范

---

### 11. `components/SettingsModal.tsx`

**问题：**
- **(高) 未使用 `BaseModal`** — 自行实现了 overlay 和动画
- (中) `@ts-ignore` 使用
- (中) `tabs.splice` 变异 const 数组

---

### 12. `components/SearchWorkbench/`

#### SearchSidebar.tsx (908 行)
- **(高) 组件过大**，建议拆分
- (中) 大量 `any` 类型
- (中) `JSON.parse` 在渲染中调用
- (中) 硬编码中文 fallback

#### UnifiedSearchWorkbench.tsx
- (中) 空结果过滤不完整
- (低) `@ts-ignore` 使用

#### SearchResultsList.tsx
- (低) CSS-in-JS 注入 `<style>` 标签
- (低) `'Star'`/`'Unstar'` 硬编码英文

---

### 13. `components/ActivityBar.tsx`

- (中) 硬编码中文 fallback：`'AI 工坊'`

### 14. `components/Sidebar.tsx`

**优点：** memo 优化正确，使用 ConfirmModal 删除章节，`contentVisibility: 'auto'` 性能优化

**问题：**
- (中) `JSON.parse` 在渲染路径中

### 15. `components/FlowModeButton.tsx`

- **(高) 硬编码中文**：`'心流'`

### 16. `components/ProjectCard.tsx`

- (中) `Novel` 类型未显式导入
- (低) `cn` 函数应提取到 utils

### 17. `components/RecentFilesDropdown.tsx`

- (低) i18n fallback 为中文

### 18. `components/GlobalIdeaModal.tsx`

**评价：** 质量良好，使用 BaseModal，符合规范。

### 19. `components/AIPromptPreview/PromptInlinePanel.tsx`

**优点：** 结构化视图 + 原始视图切换，语义 diff 功能设计精巧

**问题：** (低) 组件较大（525 行），可将 diff 逻辑提取为 hook

---

## 二、问题汇总（按优先级排序）

### 高优先级

| # | 文件 | 问题 |
|---|------|------|
| 1 | `utils/aiError.ts` | `formatAiError` 全部错误消息硬编码中文 |
| 2 | `SettingsModal.tsx` | 未继承 `BaseModal` |
| 3 | `BackupRestorePanel.tsx` | 使用原生 `confirm()` 而非 `ConfirmModal` |
| 4 | `useShortcuts.ts` | `formatShortcut` 中 `'无'` 硬编码中文 |
| 5 | `FlowModeButton.tsx` | `'心流'` 硬编码中文 |
| 6 | `AISettingsPanel.tsx` | 测试 prompt 硬编码中文 |

### 中优先级

| # | 文件 | 问题 |
|---|------|------|
| 7 | `SettingsModal.tsx` | `@ts-ignore` 使用；`tabs.splice` 变异 const 数组 |
| 8 | `SearchSidebar.tsx` | 大量 `any` 类型；渲染路径中 `JSON.parse` |
| 9 | `Sidebar.tsx` | 渲染路径中 `JSON.parse` |
| 10 | `usePlotSystem.ts` | `err: any` 应改为 `unknown` |
| 11 | `AISettingsPanel.tsx` | 组件 627 行过大 |
| 12 | `ProjectCard.tsx` | `Novel` 类型未显式导入 |
| 13 | `Combobox.tsx` | `'Nothing found.'` 硬编码英文 |

### 低优先级

| # | 文件 | 问题 |
|---|------|------|
| 14 | `usePlotSystem.ts` | `removeAnchor` 缺少 `dispatchUpdate()` |
| 15 | `SearchResultsList.tsx` | `'Star'`/`'Unstar'` 硬编码英文 |
| 16 | `ProjectCard.tsx` | `cn` 函数应提取到 utils |
| 17 | `RecentFilesDropdown.tsx` | i18n fallback 为中文 |
| 18 | `SearchSidebar.tsx` | 组件 908 行过大 |

---

## 三、总体评价

**做得好的方面：**
1. i18n 覆盖率高，中英文 JSON 结构一致
2. 主题支持完整，通过 `isDark` 条件渲染
3. UI 基础库（BaseModal/ConfirmModal/Button/Combobox/IconPicker）设计良好
4. Hooks 设计合理（useHistory、useDebounce、usePlotSystem）

**需要改进的方面：**
1. 仍有 6 处高优先级硬编码中文
2. 大组件需拆分（SearchSidebar 908 行、AISettingsPanel 627 行）
3. SearchSidebar 中大量 `any` 类型
4. SettingsModal 未使用 BaseModal，BackupRestorePanel 使用原生 confirm()
