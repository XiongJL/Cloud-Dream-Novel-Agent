export type AgentChapterScopeKind =
    | 'current_chapter'
    | 'selected_chapters'
    | 'chapter_range'
    | 'current_volume'
    | 'novel';

export type AgentChapterProcessingMode = 'detailed' | 'batched';

export type AgentScopeRole = 'team' | 'writer' | 'editor' | 'reader' | 'worldbuilding' | 'research_rag';

export interface AgentChapterScopeBuildPayload {
    scopeId?: string;
    novelId: string;
    kind?: AgentChapterScopeKind;
    volumeId?: string;
    chapterId?: string;
    chapterIds?: string[];
    anchorChapterId?: string;
    processingMode?: AgentChapterProcessingMode;
    currentContent?: string;
    goal?: string;
    locale?: string;
    batchSize?: number;
    maxDetailedChapters?: number;
    maxEstimatedTokens?: number;
}

export interface AgentChapterSnapshot {
    chapterId: string;
    version: number;
    contentHash: string;
    updatedAt: string;
    source: 'database' | 'editor_buffer';
}

export interface AgentChapterScope {
    scopeId: string;
    novelId: string;
    kind: AgentChapterScopeKind;
    volumeId?: string;
    chapterIds: string[];
    anchorChapterId?: string;
    processingMode: AgentChapterProcessingMode;
    snapshot: AgentChapterSnapshot[];
}

export interface ChapterScopeContextItem {
    chapterId: string;
    volumeId: string;
    title: string;
    order: number;
    volumeOrder: number;
    version: number;
    updatedAt: string;
    contentHash: string;
    contentMode: 'full' | 'truncated' | 'summary' | 'excerpt';
    content: string;
    summaryId?: string;
    summaryContent?: string;
    summaryFresh: boolean;
    target: boolean;
}

export interface ContinuationContextPolicy {
    version: 'continuation-context-v1';
    summaryChapterCount: number;
    fullTextChapterCount: number;
    maxFullTextChars: number;
    maxSummaryChars: number;
    maxCurrentContentChars: number;
}

export interface ContinuationContextChapterSource extends AgentChapterSnapshot {
    volumeId: string;
    title: string;
    order: number;
    volumeOrder: number;
    contentMode: 'full' | 'truncated' | 'summary' | 'excerpt';
    summaryId?: string;
    summaryFresh: boolean;
}

export interface ContinuationContextSnapshot {
    policy: ContinuationContextPolicy;
    scopeId: string;
    novelId: string;
    anchorChapterId: string;
    chapterSources: ContinuationContextChapterSource[];
    narrativeSummaryIds: string[];
    estimatedTokens: number;
    createdAt: string;
}

export interface ChapterScopeEvidence {
    sourceType: string;
    sourceId?: string;
    title?: string;
    excerpt: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
}

export interface ChapterScopeCoverage {
    totalChapterCount: number;
    contextChapterCount: number;
    readonlyChapterCount: number;
    detailedChapterCount: number;
    summarizedChapterCount: number;
    excerptChapterCount: number;
    omittedChapterCount: number;
    batchSize: number;
    batchCount: number;
    batches: Array<{
        index: number;
        chapterIds: string[];
    }>;
}

export interface NarrativeStateLedger {
    entities: Record<string, unknown>;
    timelineHints: unknown[];
    openQuestions: unknown[];
    unresolvedThreads: unknown[];
}

export interface ChapterScopeBundle {
    scope: AgentChapterScope;
    chapters: ChapterScopeContextItem[];
    narrativeSummaries: Array<{
        id: string;
        level: 'volume' | 'novel';
        volumeId?: string;
        title: string;
        summaryText: string;
        keyFacts: string[];
        unresolvedThreads: string[];
        sourceFingerprint: string;
    }>;
    entityContext: {
        characters: Array<Record<string, unknown>>;
        items: Array<Record<string, unknown>>;
        worldSettings: Array<Record<string, unknown>>;
        maps: Array<Record<string, unknown>>;
    };
    plotContext: {
        plotlines: Array<Record<string, unknown>>;
    };
    evidence: ChapterScopeEvidence[];
    stateLedger: NarrativeStateLedger;
    coverage: ChapterScopeCoverage;
    sourceSnapshot: AgentChapterSnapshot[];
    warnings: string[];
    estimatedTokens: number;
}
