# MapWorkbench 代码审查报告

## 审查范围

`src/components/MapWorkbench/` 目录：
- `MapCanvas.tsx` (902行) — 地图画布（Konva）、AI 生成底图、角色标记管理、工具栏
- `MapSidebar.tsx` (321行) — 地图列表、新建/删除/重命名、类型/描述编辑面板

---

## 一、组件结构

**MapCanvas.tsx 严重臃肿。** 单文件 902 行，承担了至少 5 个独立职责。建议拆分为：
- `MapToolbar.tsx` — 顶部工具栏
- `AiGenerateModal.tsx` — AI 生成底图的模态框及进度逻辑
- `CharacterDock.tsx` — 右侧角色列表面板
- `MapCanvasView.tsx` — 仅保留画布核心

**`_novelId` 命名误导。** 第 40 行将 prop 解构为 `_novelId`（下划线前缀通常表示"未使用"），但实际上在 AI 调用中使用了。应改回 `novelId`。

---

## 二、状态管理

**MapCanvas.tsx 有 20+ 个 `useState`**，AI 相关状态占了一半以上。建议用 `useReducer` 或将 AI 逻辑提取为 `useAiMapGeneration` hook。

**定时器管理分散**。`aiProgressTimerRef` 和 `aiStageTimerRef` 的创建和清理分散在多处，容易遗漏。

---

## 三、性能问题

1. **`handleWheel` 回调依赖 `scale` 和 `position`** — 每次缩放都会重建回调，建议用 `useRef` 持有最新值
2. **`focusCharacter` 依赖多个值** — 重建频繁，作为 prop 传递会导致不必要的重渲染
3. **MapSidebar IIFE** — 第 251-304 行 `(() => { ... })()` 直接写在 JSX 中

---

## 四、错误处理

- 大部分异步操作都有 `try/catch` + `console.error`，一致性良好
- **用户反馈不足**：`loadMap`、`handleUploadBg`、`handleDrop`、`handleMarkerDragEnd`、`handleDeleteMarker` 失败时仅 `console.error`

---

## 五、i18n 使用（严重问题）

### 乱码 fallback 字符串（BUG）

- 第 810 行：`t('map.removeMarker', '绉婚櫎鏍囪')` — "移除标记"的 GBK 编码被当作 UTF-8 解码后的乱码
- 第 837 行：`t('common.search', '鎼滅储')` — 同样是乱码

虽然 zh.json 中 key 存在且正确，但如果 key 被删除或翻译缺失，用户会看到乱码。

### 硬编码中文字符串

- 第 639 行：AI 统计信息完全硬编码中文
- 第 33-38 行 `MAP_STYLE_OPTIONS` 的 `label`：`'奇幻'`、`'写实'`、`'古风'`、`'科幻'`

### 18 个 i18n key 缺失于 locale 文件

`map.aiDisabled.noMap`, `map.aiDisabled.running`, `map.aiGenerateFailed`, `map.aiGenerateSuccess`, `map.aiPrompt`, `map.aiPromptLabel`, `map.aiPromptRequired`, `map.aiRateLimited`, `map.aiSize`, `map.aiStage.downloading`, `map.aiStage.generating`, `map.aiStage.requesting`, `map.aiStage.saving`, `map.aiStyle`, `map.descPlaceholder`, `map.generateBgAI`, `map.hasBackground`, `map.mapType`

---

## 六、主题支持

- 两个文件都通过 `isDark` + `clsx` 实现了完整的亮/暗色适配 — 做得很好
- **Konva 画布内元素不随主题变化**：marker 颜色、文字颜色、阴影全部硬编码

---

## 七、其他 Bug

| 严重度 | 位置 | 问题 |
|--------|------|------|
| **高** | MapCanvas:810,837 | 乱码 fallback 字符串 |
| **高** | MapCanvas:639 | AI 统计信息硬编码中文 |
| **中** | MapCanvas:33-38 | 风格选项 label 硬编码中文 |
| **中** | MapCanvas:202 | `handleWheel` 参数类型为 `any` |
| **中** | MapCanvas:199 | `eslint-disable react-hooks/exhaustive-deps` |
| **中** | MapCanvas:40 | `_novelId` 命名暗示未使用但实际使用 |
| **低** | MapCanvas:773 | marker 文字颜色不随主题变化 |
| **低** | MapCanvas:76 | `mapId` 变化时未清理定时器 |

---

## 八、优先级建议

1. **P0**：修复乱码 fallback 字符串
2. **P0**：将硬编码中文改为 i18n key，补全 18 个缺失的 locale key
3. **P1**：将 MapCanvas.tsx 拆分为 4-5 个子组件，AI 逻辑提取为 hook
4. **P1**：`handleWheel` 使用 ref 持有 scale/position
5. **P2**：Konva marker 颜色适配主题
6. **P2**：补充用户可见的错误提示
7. **P2**：修复命名、类型、eslint-disable 等代码规范问题
