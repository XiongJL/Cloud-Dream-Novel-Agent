# RAG Development Plan

**Last Updated**: 2026-06-04

This document describes a practical RAG implementation plan for Novel Editor. The goal is to let AI and authors ask evidence-grounded questions about the current novel, such as character state, future outline direction, unresolved plot threads, and whether a character has planned follow-up scenes.

## 1. Goal

Add a novel-aware question-answering feature that can:

- Answer author questions using existing novel data.
- Provide evidence references instead of unsupported guesses.
- Distinguish written facts, outline plans, and AI suggestions.
- Reuse current AI settings, provider infrastructure, chapter summaries, narrative summaries, and search index.
- Start with a lightweight local-first RAG path before adding embeddings.

## 2. Non-Goals For MVP

- Do not add a new external vector database.
- Do not require cloud embeddings for basic use.
- Do not build a general chatbot with unlimited memory.
- Do not let AI silently invent missing story facts.
- Do not expose developer diagnostics as user-facing RAG controls.

## 3. Existing Project Foundations

Relevant existing infrastructure:

- `apps/desktop/electron/search/searchIndex.ts`
  - SQLite FTS5 search index.
  - Indexes chapters and ideas.
  - Provides `search(novelId, keyword, limit, offset)`.
  - Current query implementation uses `LIKE` against the FTS virtual table content/title fields, not FTS `MATCH`/BM25 ranking yet.

- `packages/core/prisma/schema.prisma`
  - `Character`, `Item`, `Relationship`, `PlotLine`, `PlotPoint`, `PlotPointAnchor`.
  - `ChapterSummary` for chapter-level memory.
  - `NarrativeSummary` for volume/novel-level memory.

- `apps/desktop/electron/ai/context/ContextBuilder.ts`
  - Existing context assembly for continue writing and creative asset generation.
  - Already prefers summaries before raw chapter text.

- `apps/desktop/electron/ai/AiService.ts`
  - Central AI service and provider dispatch.
  - Existing IPC-facing AI methods.

- `apps/desktop/electron/main.ts` and `apps/desktop/electron/preload.ts`
  - IPC bridge for AI features.

- `apps/desktop/src/components/AIWorkbench`
  - Natural first UI area for the author-facing RAG entry point.
  - Current `AIWorkbenchPanel.tsx` is a creative-assets generation panel, so RAG should be added as a sibling panel/mode rather than mixed into the existing form.

## 4. MVP Architecture

Use structured retrieval plus full-text search:

1. Normalize the author question.
2. Detect likely intent and mentioned entities.
3. Retrieve structured story facts from the database.
4. Retrieve relevant chapter/idea hits through the existing search service.
5. Retrieve latest chapter and narrative summaries.
6. Build an evidence packet.
7. Ask the configured AI provider to answer only from that packet.
8. Return answer, confidence, citations, and warnings.

No embedding index is required for MVP.

## 5. Question Intents

Initial supported intents:

- `character_state`
  - Example: "林岚现在是什么状态？"
  - Uses character profile, relationships, item ownership, map markers, recent summaries, and search hits.

- `future_plot_for_entity`
  - Example: "林岚后面还有剧情吗？"
  - Uses active plot points, plot point anchors, unresolved threads, future chapter/order hints, and summaries.

- `outline_next`
  - Example: "后续写作按大纲应该怎么写？"
  - Uses active plot lines, unresolved plot points, current chapter position, narrative summaries, and recent chapter summaries.

- `unresolved_threads`
  - Example: "还有哪些伏笔没回收？"
  - Uses active plot points, `NarrativeSummary.unresolvedThreads`, `ChapterSummary.openQuestions`, and FTS hits.

- `consistency_check`
  - Example: "这段剧情和前文冲突吗？"
  - Uses retrieved facts plus optional user-provided draft text.

- `general_qa`
  - Fallback for other questions.

Intent detection can start as keyword/rule based. AI-based routing can be added later if needed.

## 6. Evidence Sources

### Structured Data

- `Character`
  - `name`, `role`, `description`, `profile`, `isStarred`.

- `Relationship`
  - Source/target character relation and description.

- `Item` and `ItemOwnership`
  - Current item/skill/location ownership and notes.

- `CharacterMapMarker` and `MapCanvas`
  - Current known map/location hints.

- `PlotLine` and `PlotPoint`
  - Active/resolved story plan.
  - Important for future plot and outline questions.

- `PlotPointAnchor`
  - Links setup/payoff points to chapters.

### Memory Data

- `ChapterSummary`
  - Prefer `compressedMemory`.
  - Fallback to `summaryText`.
  - Use `keyFacts`, `timelineHints`, and `openQuestions` when available.

- `NarrativeSummary`
  - Use `summaryText`, `keyFacts`, `unresolvedThreads`, `hardConstraints`, and `coverageChapterIds`.

### Full-Text Search

- Existing FTS5 `search_index`.
- MVP should call the existing `search()` helper first. Upgrading to `MATCH`, ranking, or BM25 can be a later search-quality task.
- MVP should search:
  - Mentioned entity names.
  - Important query terms.
  - User question keywords.

## 7. Proposed Files

Add:

- `apps/desktop/electron/ai/rag/NovelRagService.ts`
  - Main retrieval and answer orchestration.

- `apps/desktop/electron/ai/rag/types.ts`
  - RAG payload/result/evidence types.

- `apps/desktop/electron/ai/rag/intent.ts`
  - Lightweight intent and entity extraction.

- `apps/desktop/electron/ai/rag/evidence.ts`
  - Evidence retrieval helpers.

- `apps/desktop/src/components/AIWorkbench/NovelAskPanel.tsx`
  - Author-facing RAG question-answering UI.

- `apps/desktop/src/components/AIWorkbench/AIWorkbenchShell.tsx` or equivalent parent-level switcher
  - Switches between creative-assets generation and Novel Q&A.

Modify:

- `apps/desktop/electron/ai/AiService.ts`
  - Add `askNovel()` and `previewNovelAskPrompt()`.
  - Register the RAG service with the same provider/error handling path used by existing AI methods.

- `apps/desktop/electron/ai/capabilities.ts`
  - Add a read-only capability such as `rag.ask` or `novel.ask`.
  - This lets automation/OpenClaw/MCP callers use the same RAG feature, not only the desktop renderer.

- `apps/desktop/electron/main.ts`
  - Add IPC handlers:
    - `ai:ask-novel`
    - `ai:preview-novel-ask-prompt`

- `apps/desktop/electron/preload.ts`
  - Expose `window.ai.askNovel()` and `window.ai.previewNovelAskPrompt()`.

- `apps/desktop/src/vite-env.d.ts`
  - Add frontend type declarations.

- `apps/desktop/src/components/AIWorkbench`
  - Add `NovelAskPanel` and a parent switcher/tab entry.
  - Keep the existing creative-assets panel focused on asset generation.

- `apps/desktop/src/pages/editor/EditorWorkspace.tsx`
  - Render the AI Workbench shell/switcher instead of mounting only `AIWorkbenchPanel`.

- `apps/desktop/src/i18n/locales/zh.json`
- `apps/desktop/src/i18n/locales/en.json`
  - Add all visible UI strings.

## 8. API Shape

```ts
export interface RagAskPayload {
  novelId: string;
  question: string;
  chapterId?: string;
  currentContent?: string;
  selectedText?: string;
  currentLocation?: string;
  locale?: string;
  maxEvidenceItems?: number;
  previewOnly?: boolean;
}

export interface RagEvidenceItem {
  id: string;
  sourceType:
    | 'character'
    | 'relationship'
    | 'item'
    | 'map'
    | 'plotPoint'
    | 'plotLine'
    | 'worldSetting'
    | 'chapterSummary'
    | 'narrativeSummary'
    | 'searchHit'
    | 'idea';
  sourceId: string;
  title: string;
  excerpt: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

export interface RagAskResult {
  ok: boolean;
  question: string;
  intent: string;
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: RagEvidenceItem[];
  citations: Array<{
    evidenceId: string;
    label: string;
  }>;
  warnings: string[];
  usedContext: string[];
  rawPrompt?: string;
  editableUserPrompt?: string;
  error?: string;
}
```

## 9. Prompt Contract

The RAG answer prompt must enforce:

- Answer only from the provided evidence.
- If evidence is insufficient, say so clearly.
- Separate:
  - written facts
  - outline plans
  - inferred suggestions
- Cite evidence labels.
- Use deterministic evidence labels supplied by the app, for example `[E1]`, `[E2]`.
- Never rewrite large chapter passages.
- For writing advice, provide actionable next beats, not generic commentary.
- Prefer a structured JSON response internally when practical, then render it as text in the UI. If provider output is not valid JSON, fall back to plain text with low/medium confidence.

Chinese system prompt baseline:

```text
你是小说编辑器中的 RAG 问答助手。你只能基于 Evidence 中提供的资料回答。
如果资料不足，请明确说明不足以判断。请区分“已写事实”“大纲计划”“写作建议”。
涉及剧情判断时必须引用证据标签。不要编造未提供的设定、章节或人物状态。
```

## 10. Retrieval Rules

### Entity Extraction

Initial rule-based extraction:

- Exact match against character names.
- Exact match against item names.
- Exact match against world setting names.
- Recognize `@实体名` mentions.
- If no entity is matched, use top keywords from the question.

### Scoring

Start with deterministic scoring:

- Exact entity match: `+100`
- Active plot point match: `+80`
- Recent summary match: `+60`
- FTS hit title match: `+50`
- FTS hit content match: `+30`
- Starred character/item: `+10`
- Resolved plot point: `-20` unless the intent asks history.

Keep top `maxEvidenceItems`, default `12`.

### Ordering

For future plot questions:

1. Active plot points involving entity.
2. Plot anchors by chapter order.
3. Narrative unresolved threads.
4. Recent summaries.
5. Search hits.

For current state questions:

1. Character card.
2. Relationships and item ownership.
3. Map markers.
4. Recent summaries.
5. Search hits ordered by story order descending when possible.

For outline-next questions:

1. Current volume active plot points.
2. Novel-level unresolved threads.
3. Recent summaries.
4. Current chapter context.

## 11. UI MVP

Add a "Novel Q&A" sibling mode in the AI Workbench area. Do not overload the existing creative-assets form.

Controls:

- Question textarea.
- Ask button.
- Optional current chapter context toggle.
- Evidence visibility toggle.
- Prompt preview button.

Result display:

- Answer.
- Confidence badge.
- Evidence list with source labels.
- Warnings.
- Actions:
  - Copy answer.
  - Save as idea through the existing idea creation flow.
  - Insert suggestion into current chapter only when answer is explicitly a writing suggestion.

All visible strings must use `react-i18next`.

## 12. Implementation Phases

### Phase 1: Backend MVP

- Add RAG types.
- Add intent/entity extraction.
- Add evidence retrieval helpers.
- Add `NovelRagService.ask()`.
- Add `AiService.askNovel()`.
- Add prompt preview support.
- Add IPC and preload methods.
- Add read-only `rag.ask` or `novel.ask` capability for automation/OpenClaw/MCP routing.

Acceptance:

- Can ask a question from renderer and receive answer plus evidence.
- Works without embeddings.
- Handles missing AI settings with existing AI error formatting.

### Phase 2: Frontend MVP

- Add AI Workbench Q&A mode.
- Add parent switcher/shell if one does not already exist.
- Add ask form and result panel.
- Add evidence list.
- Add i18n keys.

Acceptance:

- Author can ask from editor UI.
- Answer shows evidence and confidence.
- No hardcoded UI text outside i18n files.

### Phase 3: Quality Pass

- Improve intent detection.
- Improve evidence scoring.
- Add tests for:
  - entity extraction
  - intent routing
  - evidence ranking
  - prompt assembly

Acceptance:

- Character-state and future-plot examples produce relevant evidence.
- Empty or weak evidence returns low-confidence answer instead of hallucination.

### Phase 4: Optional Embedding Upgrade

Only after MVP is useful:

- Add `RagDocument` / `RagChunk` models or local sidecar table.
- Store embeddings for summaries, plot points, character cards, and chapter chunks.
- Add embedding provider settings.
- Use application-level cosine similarity first.
- Avoid native SQLite vector extensions until packaging risk is evaluated.

## 13. Testing Plan

Backend:

- Unit test `detectRagIntent()`.
- Unit test entity extraction using character/item/world names.
- Unit test evidence scoring with mocked records.
- Unit test prompt builder to ensure evidence-only constraints exist.

Integration:

- Seed a small novel with:
  - one character
  - one active plot point
  - one resolved plot point
  - one chapter summary
  - one narrative unresolved thread
- Ask:
  - "这个角色现在是什么状态？"
  - "这个角色后面还有剧情吗？"
  - "后续按大纲怎么写？"

Frontend:

- Smoke test AI Workbench Q&A render.
- Verify no visible hardcoded text.
- Verify evidence list can expand/collapse.

## 14. Risks

- FTS5 keyword search may miss semantic matches.
  - Mitigation: start with exact entity matching and structured plot retrieval.

- AI may overstate weak evidence.
  - Mitigation: confidence field, strict prompt, and explicit insufficient-evidence behavior.

- Old chapters may lack summaries.
  - Mitigation: fallback to FTS snippets and limited raw excerpts.

- UI can become another generic chat panel.
  - Mitigation: evidence-first result design and save-as-idea workflow.

- Embedding/vector dependencies may complicate Electron packaging.
  - Mitigation: defer vector search and use app-level cosine if needed.

## 15. Definition Of Done For MVP

- `window.ai.askNovel()` works from renderer.
- AI Workbench exposes a Novel Q&A mode.
- Answers include evidence and confidence.
- RAG uses existing summaries/search/structured data.
- All visible text is i18n-backed.
- Basic tests cover intent, entity extraction, evidence ranking, and prompt constraints.
- No external vector database or native vector extension is required.
