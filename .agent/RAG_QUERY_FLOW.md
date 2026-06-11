# RAG 提问流程图

本文档描述当前实现中，作者在「小说问答」里点击「提问」后，系统如何得到答案。

相关入口：

- 前端面板：`apps/desktop/src/components/AIWorkbench/NovelAskPanel.tsx`
- IPC：`apps/desktop/electron/preload.ts`、`apps/desktop/electron/main.ts`
- AI 服务：`apps/desktop/electron/ai/AiService.ts`
- RAG 编排：`apps/desktop/electron/ai/rag/NovelRagService.ts`
- 证据收集：`apps/desktop/electron/ai/rag/evidence.ts`
- 向量检索：`apps/desktop/electron/ai/rag/vectorIndex.ts`
- Embedding API：`apps/desktop/electron/ai/rag/embeddingClient.ts`

## 总览流程图

```mermaid
flowchart TD
    A[作者输入问题并点击提问] --> B[NovelAskPanel.buildPayload]
    B --> C[window.ai.askNovel]
    C --> D[Electron IPC: ai:ask-novel]
    D --> E[AiService.askNovel]
    E --> F[NovelRagService.ask]

    F --> G[buildPromptBundle]
    G --> H[读取已知实体名: 角色/物品/世界设定]
    H --> I[detectRagQuestion: 判断意图、实体、关键词]
    I --> J[collectRagEvidence 收集证据]

    J --> K[当前上下文证据: 选中文本/当前章节/当前位置]
    J --> L[向量检索 queryRagVectorIndex]
    J --> M[结构化数据库证据: 角色/关系/物品/地图/大纲/摘要]
    J --> N[关键词全文搜索 searchIndex]

    L --> O{rag_vector_chunks 是否已有索引}
    O -- 否 --> P[自动 rebuildRagVectorIndex]
    O -- 是 --> Q[读取 SQLite 向量片段]
    P --> Q
    Q --> R[调用 Embedding API 生成问题向量]
    R --> S[应用层余弦相似度计算]
    S --> T[过滤/排序/取 TopK 向量证据]

    K --> U[合并所有证据]
    T --> U
    M --> U
    N --> U
    U --> V[去重、按 score 排序、截断 maxEvidenceItems]
    V --> W[重新编号 E1/E2/E3...]
    W --> X[组装 systemPrompt + userPrompt]

    X --> Y[当前 AI Provider generate]
    Y --> Z[LLM 基于 Evidence 生成回答]
    Z --> AA[解析引用 E 标签]
    AA --> AB[计算 confidence]
    AB --> AC[返回 RagAskResult]
    AC --> AD[前端渲染回答、置信度、证据列表]
```

## 序列图

```mermaid
sequenceDiagram
    participant User as 作者
    participant UI as NovelAskPanel
    participant Preload as window.ai
    participant Main as Electron main IPC
    participant Ai as AiService
    participant Rag as NovelRagService
    participant Evidence as collectRagEvidence
    participant Vec as queryRagVectorIndex
    participant Emb as Ollama /v1/embeddings
    participant DB as SQLite/Prisma
    participant LLM as 当前文本模型 Provider

    User->>UI: 输入问题，点击「提问」
    UI->>UI: buildPayload(novelId, question, currentContext?)
    UI->>Preload: askNovel(payload)
    Preload->>Main: ipcRenderer.invoke("ai:ask-novel", payload)
    Main->>Ai: aiService.askNovel(payload)
    Ai->>Rag: ragService.ask(payload, provider, settings)

    Rag->>DB: 读取角色/物品/世界设定名称
    DB-->>Rag: knownEntityNames
    Rag->>Rag: detectRagQuestion(question, knownEntityNames)
    Note over Rag: 得到 intent/entityNames/keywords

    Rag->>Evidence: collectRagEvidence(...)
    Evidence->>DB: 并发读取角色、物品、世界设定、大纲、章节摘要、叙事摘要、当前章节元数据
    DB-->>Evidence: 结构化资料

    Evidence->>Vec: queryRagVectorIndex(novelId, question, settings)
    Vec->>DB: 检查 rag_vector_chunks 数量
    alt 没有索引
        Vec->>DB: 读取小说资料并切片
        Vec->>Emb: 批量生成片段向量
        Emb-->>Vec: 1024 维 embedding
        Vec->>DB: 写入 embedding_blob
    end
    Vec->>DB: 读取 rag_vector_chunks
    Vec->>Emb: 为问题生成 query embedding
    Emb-->>Vec: 1024 维 query vector
    Vec->>Vec: 余弦相似度排序，过滤低分片段
    Vec-->>Evidence: vectorEvidence

    Evidence->>Evidence: 添加当前上下文证据
    Evidence->>Evidence: 添加角色/关系/物品/地图/大纲/摘要证据
    Evidence->>DB: searchIndex 关键词搜索
    DB-->>Evidence: search hits
    Evidence->>Evidence: 去重、排序、截断、重编号 E1...
    Evidence-->>Rag: evidence + warnings + usedContext

    Rag->>Rag: 组装 Evidence block
    Rag->>Rag: 组装 systemPrompt + effectiveUserPrompt
    Rag->>LLM: provider.generate(systemPrompt, prompt)
    LLM-->>Rag: answer text
    Rag->>Rag: extractCitations(answer, E ids)
    Rag->>Rag: parseConfidence(answer, evidenceCount)
    Rag-->>Ai: RagAskResult
    Ai-->>Main: RagAskResult
    Main-->>Preload: RagAskResult
    Preload-->>UI: RagAskResult
    UI-->>User: 显示回答、置信度、证据
```

## 当前实现的关键规则

1. 「预览提示词」和「提问」都会执行证据检索与提示词组装；区别是预览不会调用最终文本模型。
2. 向量索引表是 `rag_vector_chunks`。你当前重建成功后，片段向量以 1024 维 Float32 BLOB 存储。
3. 一次提问时，如果索引表里已有当前小说的片段，就直接读取并计算相似度；如果没有片段，会自动触发一次索引构建。
4. 当前没有使用 `sqlite-vec`。检索方式是从 SQLite 读出片段向量后，在应用层做余弦相似度计算。
5. 最终证据不是只有向量检索结果，还会混合角色卡、关系、物品、地图标记、大纲情节点、章节摘要、叙事摘要、关键词搜索结果和当前章节上下文。
6. 证据会先去重，再按分数排序，最后重新编号为 `[E1]`、`[E2]`。
7. “高置信度”当前主要由回答内容和证据数量推断：如果回答没有表示资料不足，且证据数量达到阈值，就可能显示高置信度。

## 当前提问示例的路径

问题：`顾野现在是什么状态？`

大致会被识别为：

- `intent`: `character_state`
- `entityNames`: 如果角色库存在「顾野」，会命中「顾野」
- `keywords`: 可能包含「顾野」等有效词

证据收集时会优先提高这些资料的分数：

- 顾野的角色卡
- 顾野相关关系
- 顾野持有或相关物品
- 顾野地图位置
- 向量检索命中的章节正文/摘要/情节点片段
- 关键词搜索命中的章节片段

然后 LLM 只拿最终 Evidence block 作答，并被 systemPrompt 要求引用 `[E1]` 这类证据标签。
