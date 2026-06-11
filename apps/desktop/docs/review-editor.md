# Editor 组件代码审查报告

## 审查范围

- `src/components/Editor/` — Editor 主组件及 hooks
- `src/pages/editor/` — Editor 页面级组件

---

## 一、组件结构与组织

**总体评价：良好，已做合理拆分**

主入口 `pages/Editor.tsx` 导出 `EditorWorkspace`，后者是一个 ~1345 行的大型组件。逻辑已通过自定义 hooks 做了较好的拆分：

- `useChapterLifecycle` -- 章节生命周期与持久化
- `useContinueWriting` -- AI 续写逻辑
- `useFlowModeController` -- 心流模式
- `useTitleGeneration` -- AI 标题生成
- `useEditorKeyboard` -- 全局键盘快捷键
- `useIdeaInteractions` -- 灵感交互
- `usePlotInteractions` -- 情节锚点交互
- `useCreativeDraftSync` -- 创意草稿同步

**问题：**

1. **`EditorWorkspace.tsx` 仍然过长（~1345 行）**。虽然 hooks 已经抽出，但 JSX 部分（约 800 行）包含了大量模板代码（header、sidebar 各 tab、modal 等），建议将 header 区域、sidebar 各 tab 面板、续写预览 modal 等抽成独立子组件。

2. **`EditorToolbar.tsx` 和 `LexicalEditor/plugins/ToolbarPlugin.tsx` 功能高度重叠**。存在两套工具栏，容易造成维护不一致。建议只保留一套（`ToolbarPlugin` 已在 LexicalEditor 内部使用，`EditorToolbar` 似乎未被引用，可能已是死代码）。

3. **`pages/Editor.tsx` 仅有 3 行，只做 re-export**。这层间接没有实际价值。

---

## 二、状态管理复杂度

**问题：**

1. **`EditorWorkspace` 中 state 变量过多**。直接 `useState` 声明的状态超过 15 个，加上 hooks 返回的状态，组件可访问的状态变量超过 40 个。这导致 `useCallback` / `useMemo` 的依赖列表很长，容易遗漏。

2. **`useChapterLifecycle` 暴露了过多 setter**。返回了 `setNovel`, `setVolumes`, `setCurrentChapter`, `setTitle`, `setContent` 等大量 setter，调用方可以直接修改内部状态，破坏了封装性。建议只暴露 action 方法，不暴露原始 setter。

3. **`useContinueWriting` 返回了 21 个值**。建议拆分为更小的子 hook（如 `useContinuePromptPreview`, `useContinueConfig`）。

---

## 三、Lexical 编辑器集成

**总体评价：良好**

- `InitialStatePlugin` 正确处理了 JSON 和纯文本两种格式的初始内容
- `EditorRefPlugin` 正确管理了 editor 实例引用的生命周期
- 自定义 nodes（IdeaMarkNode, PlotAnchorNode）正确扩展了 MarkNode
- MentionNode 作为 DecoratorNode 实现正确

**问题：**

1. **`LexicalChapterEditor` 中 `initialConfig` 对象每次渲染都重新创建**（第 173-179 行），这会导致 LexicalComposer 在每次父组件 re-render 时重新初始化。应该用 `useMemo` 包裹。

2. **`MentionNode` 未注册到 `LexicalChapterEditor` 的 `nodes` 数组中**（第 178 行只注册了 `IdeaMarkNode` 和 `PlotAnchorNode`），但 `MentionsPlugin` 和 `MentionInteractionPlugin` 都在使用它。

3. **`PlotAnchorInteractionPlugin` 中有 `console.log` 调试代码未清理**（第 25 行）。

4. **`LexicalChapterEditor` 第 275-276 行有 `console.log` 调试代码**在 JSX 中直接调用。

5. **`AutoFormatPlugin` 第 150 行有 `console.log`**。

---

## 四、性能问题

1. **`EditorWorkspace` 的 `useEffect` 中 automation 监听器依赖了 `t` 函数**，`t` 在语言切换时会变化，导致整个监听器重新注册。

2. **`useCreativeDraftSync` 每 2.5 秒轮询一次**（第 60-63 行），即使没有草稿 session 也在轮询。建议在没有活跃 session 时停止轮询。

3. **`getEditorContentClass` 函数每次渲染都重新计算**，但没有使用 `useMemo`。

4. **`FloatingTextFormatToolbarPlugin` 的 `useCallback` 依赖列表中没有 `isDark`**，主题切换后 caret 样式不会立即更新。

---

## 五、事件处理

**问题：**

1. **`useEditorKeyboard` 注册了两个独立的 `window.addEventListener('keydown')`**，可能与 Lexical 的 `ShortcutsPlugin` 冲突。

2. **`PlotContextMenuPlugin` 将 `contextmenu` 事件监听器附加到 `document`**，建议改为附加到编辑器 root 元素。

3. **`FloatingTextFormatToolbarPlugin` 中通过 `window.dispatchEvent(new CustomEvent(...))` 与父组件通信**，不够优雅且没有类型安全。

4. **`MentionInteractionPlugin` 中有一个空的 `editor.update()` 调用**（第 40-60 行）。

---

## 六、可访问性（Accessibility）

**问题：**

1. **`EditorToolbar.tsx` 中的按钮没有 `aria-label` 或 `aria-pressed`**。
2. **`ContinueWritingModal` 没有使用 `BaseModal`**，缺少 focus trap、escape 键关闭等无障碍特性。
3. **续写预览 modal 同样没有使用 `BaseModal`**，且没有 `role="dialog"` 和 `aria-modal`。

---

## 七、i18n 使用

**总体评价：大部分良好，但有硬编码字符串**

**问题：**

1. **`EditorToolbar.tsx` 中有多处硬编码中文字符串**：`'宋体'`, `'黑体'`, `'楷体'`, `'电脑模式'`, `'手机预览'`, `'智能缩进'`, `'一键排版'`, `'撤销'`, `'重做'`

2. **`MentionsPlugin.tsx` 中有硬编码中文**：`'全部'`, `'角色'`, `'物品'`, `'世界观'`, `'地图'`, `'无匹配结果'`

3. **`MentionNode.tsx` 中 `decorate()` 方法有硬编码中文**：`'角色'`, `'物品'`, `'世界观'`, `'地图'`

4. **`LexicalChapterEditor` 中 placeholder 硬编码**：`'开始写作...'`

5. **`EditorWorkspace.tsx` 中部分 `t()` 调用的 fallback 存在乱码字符**：
   - `t('editor.continueWriting', 'AI 续写')` -- fallback: `'AI 缁啓'`
   - `t('editor.aiTitle', 'AI 生成标题')` -- fallback: `'AI 鐢熸垚鏍囬'`
   - `t('editor.confirmInsert', '确认插入')` -- fallback: `'纭鎻掑叆'`

   这些乱码 fallback 值说明可能是文件编码问题或错误的字符转义。

6. **`EditorToolbar.tsx` 中的设备名称硬编码**：`'iPhone SE'`, `'iPhone 14'`, `'14 Pro Max'`

---

## 八、主题支持（Light/Dark Mode）

**总体评价：良好，但有不一致**

1. **`EditorWorkspace` 中大量使用 `preferences.theme === 'dark'` 三元表达式**，样式选择分散在各处。建议提取主题相关的 CSS 变量或使用 Tailwind 的 `dark:` 前缀统一处理。

2. **`EditorToolbar.tsx` 背景色硬编码为 `bg-[#0a0a0f]/90`**（第 40 行），没有根据主题切换。在 light 模式下会显示深色背景。

3. **`ToolbarPlugin.tsx` 和 `EditorSearchToolbar` 正确使用了 `isDark` 变量切换主题**。

---

## 九、Bug 与反模式

1. **死代码：`if (false && method === 'chapter.generate_draft')`（第 364 行）**。包含约 25 行死代码，应该删除。

2. **`stripRepeatedPrefixFromGeneration` 函数中的 O(n^2) 滑动窗口**（第 78-83 行）。`maxOverlap` 可达 2400，最坏情况下执行约 288 万次字符比较。建议使用 KMP 或 Rabin-Karp 算法优化。

3. **`handleSelectChapter` 中的 `isSwitchingChapterRef` 延迟重置**（第 355-357 行）使用固定 300ms 延迟来防止竞态条件，这是脆弱的。

4. **`useContinueWriting` 中 `refreshContinuePromptPreview` 的依赖列表很长**，`continueConfig` 对象每次 `setContinueConfig` 都会创建新引用，导致 debounce timer 频繁重建。

5. **`useIdeaInteractions` 和 `usePlotInteractions` 中遍历所有文本节点**来查找并删除 IdeaMarkNode/PlotAnchorNode。对于大文档性能差，应通过 node key 直接查找。

6. **`handleConfirmContinueInsert` 依赖了 `continuePreviewText`**，但调用时该值可能已变化。应该使用 ref 来获取最新值。

7. **`EditorWorkspace` 第 1190 行的 `blocked` 条件逻辑有误**：`!plotLines.some(...)` 和 `plotLines.length === 0` 是冗余的。

---

## 十、总结与优先级建议

**高优先级（应尽快修复）：**
1. 删除死代码（第 364-389 行的 `if (false && ...)` 分支）
2. 清理所有 `console.log` 调试代码
3. 修复乱码的 i18n fallback 值
4. MentionNode 未注册到 LexicalComposer 的 nodes 数组中
5. `EditorToolbar.tsx` 硬编码中文字符串改为 i18n key
6. `ContinueWritingModal` 和续写预览 modal 应使用 `BaseModal`

**中优先级（建议改进）：**
1. 将 `initialConfig` 用 `useMemo` 包裹
2. 修复 `EditorToolbar.tsx` 的 light mode 背景色问题
3. 减少 `useChapterLifecycle` 暴露的 setter 数量
4. 优化 `stripRepeatedPrefixFromGeneration` 的算法复杂度
5. `MentionsPlugin.tsx` 和 `MentionNode.tsx` 中的硬编码中文改为 i18n
6. `PlotContextMenuPlugin` 的事件监听器改为附加到编辑器 root 元素

**低优先级（长期优化）：**
1. 拆分 `EditorWorkspace` 的 JSX 为更小的子组件
2. 统一或删除重复的 `EditorToolbar.tsx`
3. 使用 CSS 变量或 Tailwind `dark:` 前缀替代大量三元表达式
4. 优化文本节点遍历逻辑（使用 node key 直接查找）
