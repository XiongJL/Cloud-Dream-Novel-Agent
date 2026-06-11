# WorldWorkbench 代码审查报告

## 审查范围

`src/components/WorldWorkbench/` 目录，共 10 个文件：
- `WorldWorkbench.tsx` — 主容器，Tab 切换，数据加载，CRUD 编排
- `CharacterList.tsx` / `CharacterEditor.tsx` — 角色列表 + 编辑器
- `ItemLibrary.tsx` / `ItemEditor.tsx` — 物品库 + 编辑器
- `WorldSettingList.tsx` — 世界观设定列表 + 内嵌编辑弹窗
- `CharacterPreviewCard.tsx` — 角色/物品悬浮预览卡
- `CharacterTimeline.tsx` — 角色出场时间线
- `RelationManager.tsx` — 人际关系管理
- `InventoryManager.tsx` — 角色持有物品管理

---

## 一、状态管理

### 1. 编辑器状态耦合

`WorldWorkbench.tsx` 中 `isEditorOpen` 和 `editingCharacter` 总是同步变化，可以用一个状态替代。同样的问题存在于 `editingItem` / `isItemEditorOpen`。

### 2. `as any` 类型断言

`CharacterEditor.tsx:77` 和 `ItemEditor.tsx:56` 中 `onSave` 调用使用了 `as any` 断言，绕过了 TypeScript 类型检查。

---

## 二、CRUD 操作

### 3. save 后立即 close 不等待异步结果

`CharacterEditor.tsx`、`ItemEditor.tsx`、`WorldSettingList.tsx` 中，`handleSave` 调用 `onSave` 后立即调用 `onClose()`。如果保存失败，弹窗已经关闭，用户无法得知错误。

### 4. 乐观更新无回滚

所有 CRUD 操作都采用乐观更新，但 catch 块只做 `console.error`，不做状态回滚。如果后端操作失败，UI 状态与数据库不一致。

---

## 三、性能问题

5. **`getIconForType` 每次渲染返回新组件引用** — React 会触发卸载/重新挂载
6. **`ItemRow` 未使用 `memo`** — CharacterList 中的 CharacterCard 用了 memo，但 ItemRow 没有
7. **`InventoryManager` 中 `availableItems` 未 memoize**
8. **内联函数作为 props** — `onToggleStar` 每次渲染创建新引用
9. **`CharacterEditor` 中未使用的 ref** — `roleRef` 和 `descRef` 声明但未绑定

---

## 四、错误处理

### 10. 仅 console.error，无用户反馈

整个模块 10+ 处 catch 块均只做 `console.error`，用户看不到任何提示。

### 11. `CharacterPreviewCard` 中 `JSON.parse` 缺少 try-catch

第 102 行没有 try-catch 保护，而同文件第 189 行有 try-catch，处理方式不一致。

---

## 五、i18n 国际化

### 12. `en.json` 缺失大量 world 翻译键（严重）

`zh.json` 中 `world` 命名空间有约 50+ 个键，但 `en.json` 中仅有 3 个键。英文用户看到的大部分文本会 fallback 到中文。

### 13. `CharacterPreviewCard.tsx` 大量硬编码中文（严重）

`'角色'`, `'技能'`, `'地点'`, `'物品'`, `'属性'`, `'持有物品'`, `'编辑详情'` 等未使用 i18n。

### 14. `RelationManager.tsx` 硬编码中文

第 83 行：`'未知'` 未使用 i18n。

---

## 六、主题支持

### 15. 硬编码背景色

多处使用 `bg-[#1a1a20]`、`bg-[#0F0F13]` 等硬编码深色背景色。

### 16. `CharacterPreviewCard` 混用 `isDark` 和 Tailwind `dark:` 前缀

会导致不一致的行为。

---

## 七、其他 Bug

17. **`avatar` 路径不一致** — `CharacterList.tsx` 使用 `local-resource://` 前缀，`RelationManager.tsx` 直接使用 `c.avatar`
18. **滚动定位使用 `setTimeout` 硬编码延时** — 建议使用 `requestAnimationFrame` 或 `useLayoutEffect`
19. **`useEffect` 空依赖数组中引用 `t` 函数** — 语言切换后不会重新执行
20. **`CharacterTimeline` 使用 `Clock` 图标做 loading spinner** — 语义不明确，应使用 `Loader2`

---

## 八、总结与优先级建议

| 优先级 | 问题 | 影响 |
|---|---|---|
| **P0** | `en.json` 缺失大量翻译键 | 英文用户界面大面积显示中文 |
| **P0** | `CharacterPreviewCard` 硬编码中文 | 英文用户看到中文 |
| **P1** | save 后立即 close 不等待异步结果 | 数据丢失风险 |
| **P1** | 乐观更新无回滚 | UI 与数据库不一致 |
| **P1** | `JSON.parse` 无 try-catch | 组件崩溃 |
| **P1** | `RelationManager` avatar 路径缺少 `local-resource://` | 图片无法显示 |
| **P2** | 所有 catch 块无用户反馈 | 用户操作失败不知情 |
| **P2** | 未使用 BaseModal | 违反项目规范 |
| **P2** | 混用 `isDark` 和 `dark:` 前缀 | 主题行为不一致 |
| **P3** | `ItemRow` 未 memo、`availableItems` 未 useMemo | 列表性能 |
| **P3** | 内联函数作为 props | 不必要重渲染 |
