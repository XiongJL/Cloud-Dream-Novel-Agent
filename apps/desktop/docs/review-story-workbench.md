# StoryWorkbench 代码审查报告

## 审查范围

`src/components/StoryWorkbench/` 目录，共 11 个文件：
- **主视图**: `NarrativeMatrix.tsx`（叙事矩阵）、`PlotSidebar.tsx`（侧边栏）
- **编辑模态框**: `PlotPointModal.tsx`、`PlotAnchorModal.tsx`、`PlotPointEditor.tsx`
- **子组件**: `PlotLineItem.tsx`、`PlotPointItem.tsx`、`PlotContextMenu.tsx`、`PlotPointDescriptionRenderer.tsx`、`EntityInfoCard.tsx`、`SearchableSelect.tsx`

---

## 一、严重 Bug

### 1. EntityInfoCard.tsx — 违反 React Hooks 规则（第 22-23 行）

`useRef` 和 `useState` 在条件 `return null` 之后调用，违反了 React Hooks 不可条件调用的规则。当 `entity` 从有值变为空时会导致 hooks 数量不一致，引发运行时崩溃。必须将所有 hooks 移到条件 return 之前。

### 2. PlotPointModal.tsx — 残留 `console.log`（第 356 行）

生产代码中不应保留调试日志。

### 3. PlotPointItem.tsx — 硬编码英文字符串（第 132 行）

`title="Resolved"` 应使用 `t('plot.statuses.resolved')` 替代。

---

## 二、Modal 使用规范

| 组件 | 是否使用 BaseModal | 状态 |
|---|---|---|
| PlotPointModal | 使用了 BaseModal | 合规 |
| PlotAnchorModal | 自己实现整套 overlay | **不合规** |
| ConfirmModal | 各处使用 | 合规 |

**PlotAnchorModal.tsx** 完全自行实现了 `fixed inset-0` 背景遮罩、定位、关闭逻辑和 ESC 监听，应重构为继承 BaseModal。

---

## 三、i18n 问题

### 缺失的翻译键

| 文件 | 缺失的键 |
|---|---|
| PlotContextMenu.tsx | `plot.viewDetails`, `plot.removeAnchor`, `plot.linkExisting`, `plot.createNew`, `common.noSelection` |
| PlotPointItem.tsx | `plot.jumpToText` |
| SearchableSelect.tsx | `common.select`, `search.noResults` |
| PlotPointModal.tsx | `common.noResults` |

### 硬编码字符串

- `SearchableSelect.tsx` 第 237 行：`'Loading more...'`
- `PlotPointEditor.tsx` 第 103 行：`'Enter description...'`

---

## 四、类型安全问题

1. **NarrativeMatrix.tsx** — `ChapterRow` 组件所有 props 都用 `any` 定义（第 618 行）
2. **PlotSidebar.tsx** — `activeItem` 使用 `any`（第 73 行），应定义联合类型
3. **EntityInfoCard.tsx** — `entity` 使用 `any`（第 7 行），应使用 `Character | Item`
4. **PlotLineItem.tsx / PlotSidebar.tsx** — 缺少类型导入，依赖全局类型声明

---

## 五、性能问题

1. **`handleMentionClick` 每次点击全量加载数据**（第 113-136 行）— 两次全量数据库查询后在内存中按 name 查找。应缓存数据或提供按名称查询的专用 API。
2. **`getTypeIcon` 函数重复定义** — 在 PlotPointItem.tsx 和 NarrativeMatrix.tsx 中完全重复
3. **PlotPointModal.tsx 镜像 div 计算 Mention 坐标** — 每次按键都创建临时 DOM 元素，建议 debounce
4. **SearchableSelect.tsx "虚拟化"名不副实** — 实际是 Load More 分页，命名有误导性

---

## 六、状态管理

1. **全局 CustomEvent 通信** — 隐式的全局事件耦合，数据流难以追踪
2. **usePlotSystem 通过事件同步状态** — 多组件同时挂载时产生重复请求

---

## 七、主题支持

整体良好，但有不一致：
- PlotAnchorModal.tsx 边框始终使用 `border-white/10`，浅色模式下不明显
- Cell 组件使用 `dark:` 前缀而非 `isDark` 条件

---

## 八、代码卫生

1. **setTimeout 内存泄漏风险**（PlotPointItem.tsx 第 93-96 行）— 组件卸载后 setTimeout 仍会触发 setState
2. **handleSave 缺少 try-catch**（PlotPointModal.tsx 第 416-460 行）— 多个 await 调用无错误处理
3. **PlotPointDescriptionRenderer.tsx 仅支持 paragraph 类型** — 标题、列表等内容会丢失

---

## 九、总结评级

| 维度 | 评级 | 说明 |
|---|---|---|
| 组件结构 | 良好 | 职责清晰，文件大小合理 |
| 状态管理 | 中等 | CustomEvent 通信是隐式耦合 |
| CRUD 操作 | 良好 | usePlotSystem 封装完善 |
| 性能 | 中等 | Mention 点击全量查询 |
| 错误处理 | 较差 | handleSave 无 try-catch |
| i18n | 中等 | 7+ 个缺失键和 3 处硬编码 |
| 主题支持 | 良好 | 2-3 处不一致 |
| Modal 规范 | 中等 | PlotAnchorModal 未继承 BaseModal |
| 类型安全 | 较差 | 多处 any 类型 |
| Bug | 严重 | EntityInfoCard hooks 规则违反会导致崩溃 |

**最优先修复项**：
1. EntityInfoCard 的 hooks 规则违反（会导致崩溃）
2. PlotPointModal 的 handleSave 添加 try-catch
3. 补全缺失的 i18n 翻译键
