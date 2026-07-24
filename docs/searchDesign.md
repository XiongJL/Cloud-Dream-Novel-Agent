# 搜索与工作台系统设计 (Search & Workbench System Design)

## 概述

本文档描述了CloudDream Novel Agent的**统一搜索与灵感工作台系统**设计。该系统通过一个集成的界面，同时满足**灵感管理**与**全局内容搜索**两大核心需求，旨在为小说创作提供高效的信息组织与检索体验。

---

## 1. 统一搜索与工作台系统

### 1.1 核心设计理念
将“灵感过滤”与“全局搜索”功能整合至统一的**搜索工作台**（侧边栏或弹出面板）。用户通过单一入口即可根据搜索范围筛选，无缝切换于“检索全站内容”和“管理创作灵感”之间。

### 1.2 数据模型 (`Idea` 接口优化)
在原有基础上，增加 `tags` 字段以支持多维、灵活的分类与过滤。
```typescript
interface Idea {
    id: string;
    novelId: string;           // 必须：绑定到小说
    chapterId?: string;        // 可选：关联章节（选中文字创建时）
    content: string;           // 灵感内容
    quote?: string;            // 引用原文（选中文字）
    cursor?: string;           // 光标位置（用于跳转，格式：`lexicalKey|offset`）
    isStarred: boolean;        // 是否收藏
    tags: string[];            // 新增：标签系统，如 ["角色塑造", "#伏笔", "待核实"]
    createdAt: Date;
    updatedAt: Date;
}
```

### 1.3 UI 组件布局：统一搜索工作台
工作台提供**一个搜索框**和**两级过滤器**（搜索范围、内容属性）。

```
┌─────────────────────────────────────────────────────────┐
│ 🔍 搜索工作台                                    [×]   │  ← 标题栏与关闭按钮
├─────────────────────────────────────────────────────────┤
│ [搜索小说、章节或灵感...]    [Aa] [.*] [⚙]          │  ← 主搜索框与高级选项
├─────────────────────────────────────────────────────────┤
│ 搜索范围: [全部 ▼]   │  内容类型: [全部 ▼]             │  ← 一级过滤器（并排）
│                                                    │
│ ┌─ 范围筛选器 (当范围=“灵感”时展开) ───────────────┐ │
│ │ 📑 所属小说: [当前小说 ▼]                         │ │
│ │ 📖 所属卷:   [全部卷 ▼]                           │ │  ← 二级过滤器（情景化）
│ │ 📄 所属章节: [全部章节 ▼]                         │ │
│ │ 🏷️  标签:    [选择标签...]                        │ │
│ │ ⭐ 仅收藏    [ ]      📅 时间范围: [选择...]       │ │
│ └──────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│ 📁 小说 & 章节 (23)                                   │  ← 结果分组：来自全局搜索
│   └─ 《我的第一部小说》                               │
│       └─ 第一章 开始 (L12, L45)                      │
│ 📌 灵感与批注 (8)                                     │  ← 结果分组：来自灵感工作台
│   └─ ★ “关于主角的性格矛盾” （关联自：第一章）      │
│   └─ “一个雨夜的场景设想” #场景                      │
└─────────────────────────────────────────────────────────┘
```

### 1.4 过滤器与交互逻辑

#### **一级过滤器**
| 过滤器       | 选项                             | 描述                                                           |
| :----------- | :------------------------------- | :------------------------------------------------------------- |
| **搜索范围** | `全部`、`灵感`、`章节`、`小说`   | 限定搜索的实体类型。选择`灵感`后，下方显示**灵感专属过滤器**。 |
| **内容类型** | `全部`、`纯文本`、`批注`、`大纲` | 未来可扩展，用于区分不同创作内容。                             |

#### **二级过滤器（情景化，当范围=“灵感”时显示）**
| 过滤器       | 类型         | 描述                                                                     |
| :----------- | :----------- | :----------------------------------------------------------------------- |
| **所属小说** | 下拉菜单     | `当前小说`、`全部`、`[选择特定小说]`                                     |
| **所属卷**   | 下拉菜单     | `全部卷`、`[选择特定卷]`。其选项动态依赖“所属小说”的选择。               |
| **所属章节** | 下拉菜单     | `全部章节`、`当前章节`、`[选择特定章节]`。其选项动态依赖“所属卷”的选择。 |
| **标签**     | 多选下拉输入 | 从已有标签库中选择或创建新标签。                                         |
| **仅收藏**   | 复选框       | 仅显示标星的灵感。                                                       |
| **时间范围** | 日期选择器   | 按创建或更新时间筛选。                                                   |

### 1.5 过滤与搜索逻辑伪代码
```typescript
// 统一过滤函数，支持全局搜索和灵感工作台两种情景
function unifiedSearch(
    items: (Idea | Chapter | Novel)[], 
    filters: SearchFilters
): SearchResult[] {

    let results = items;
    const { scope, contentType, advanced } = filters;

    // 1. 按“搜索范围”进行初筛
    if (scope !== '全部') {
        results = results.filter(item => item.entityType === scope);
    }

    // 2. 如果范围是“灵感”，应用灵感专属的高级过滤
    if (scope === '灵感') {
        results = results.filter(idea => {
            // 所属小说、卷、章节的级联过滤
            if (advanced.novelId && idea.novelId !== advanced.novelId) return false;
            if (advanced.volumeId && idea.volumeId !== advanced.volumeId) return false; // 需在模型中增加volumeId
            if (advanced.chapterId && idea.chapterId !== advanced.chapterId) return false;
            
            // 标签过滤（需匹配所有选中标签）
            if (advanced.tags.length > 0 && 
                !advanced.tags.every(tag => idea.tags.includes(tag))) return false;
            
            // 收藏过滤
            if (advanced.starredOnly && !idea.isStarred) return false;
            
            // 时间范围过滤
            if (advanced.dateRange) {
                const date = new Date(idea.updatedAt);
                if (date < advanced.dateRange.start || date > advanced.dateRange.end) return false;
            }
            return true;
        });
    }

    // 3. 应用主搜索框关键词的全文匹配（针对标题、内容、引用）
    if (filters.keyword) {
        const kw = filters.keyword.toLowerCase();
        results = results.filter(item => 
            item.title?.toLowerCase().includes(kw) ||
            item.content?.toLowerCase().includes(kw) ||
            (item.entityType === '灵感' && item.quote?.toLowerCase().includes(kw))
        );
    }

    // 4. 排序逻辑
    results.sort((a, b) => {
        // 灵感优先按收藏和时间排序
        if (a.entityType === '灵感' && b.entityType === '灵感') {
            if (a.isStarred !== b.isStarred) return a.isStarred ? -1 : 1;
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        }
        // 其他结果可按相关性或字母顺序排序
        return 0;
    });

    // 5. 结果分组（用于UI展示）
    return groupResultsByType(results);
}
```

---

## 2. 实现计划（更新版）

### Phase 1: 统一搜索工作台基础框架
- [ ] 创建统一搜索工作台UI组件（侧边栏/弹窗）。
- [ ] 实现一级过滤器（搜索范围、内容类型）。
- [ ] 实现主搜索框的防抖关键词搜索。
- [ ] **基础数据支持**：确保章节表有从Lexical JSON提取的`plain_text`字段，用于高效全文搜索。

### Phase 2: 灵感工作台深度功能
- [ ] 实现情景化二级过滤器（所属小说/卷/章节、标签、时间）。
- [ ] 完成灵感卡片UI，并**强化双向链接展示**：突出显示`quote`，提供显著的“跳转至原文”按钮。
- [ ] 实现标签的创建、管理与筛选。

### Phase 3: 全局搜索集成与优化
- [ ] 将小说、章节内容接入统一搜索。
- [ ] 实现搜索结果的分组（`小说 & 章节`， `灵感与批注`）与高亮显示。
- [ ] 支持从搜索结果一键跳转至原文（利用已实现的`cursor`定位功能）。

### Phase 4: 性能与体验优化
- [ ] 应用虚拟滚动处理大量结果。
- [ ] 持久化用户过滤偏好（localStorage）。
- [ ] 考虑引入客户端搜索索引（如FlexSearch）以应对极大数据量。

---

## 3. 技术实现细节更新

### 3.1 状态管理接口
```typescript
interface SearchFilters {
    keyword: string;
    scope: '全部' | '灵感' | '章节' | '小说';
    contentType: string;
    advanced: {
        // 当 scope === '灵感' 时使用
        novelId?: string;
        volumeId?: string; // 新增
        chapterId?: string;
        tags: string[];
        starredOnly: boolean;
        dateRange: { start: Date; end: Date } | null;
    };
}
```

### 3.2 组件拆分建议
- `UnifiedSearchWorkbench.tsx`: 统一搜索工作台主容器。
- `SearchScopeFilter.tsx`: 一级过滤器组件。
- `IdeaAdvancedFilter.tsx`: 灵感专属二级过滤器组件（条件渲染）。
- `SearchResultsGroup.tsx`: 负责结果的分组与渲染。

---

## 4. 设计决策记录（更新）

| 日期       | 决策                                         | 原因                                             |
| :--------- | :------------------------------------------- | :----------------------------------------------- |
|            | 灵感默认显示全部（小说级别），而非章节级别   | 用户需要跨章节查看灵感                           |
|            | **将灵感过滤与全局搜索整合至统一工作台**     | 避免功能割裂，提供一致的用户体验，降低学习成本   |
|            | **扩展章节过滤为“所属小说/卷/章节”级联选择** | 提供更精确、更符合创作目录结构的过滤维度         |
|            | **为灵感模型增加`tags`字段**                 | 支持多维度、自定义的灵活整理，超越简单的收藏分类 |
| 2026-02-04 | **强调并依赖已实现的`cursor`双向跳转功能**   | 确保灵感系统与编辑器的深度集成，形成创作闭环     |