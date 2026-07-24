export type RagIntent =
    | 'character_state'
    | 'future_plot_for_entity'
    | 'outline_next'
    | 'unresolved_threads'
    | 'consistency_check'
    | 'general_qa';

export interface RagAskPayload {
    novelId: string;
    question: string;
    chapterId?: string;
    currentContent?: string;
    selectedText?: string;
    currentLocation?: string;
    locale?: string;
    maxEvidenceItems?: number;
    analysisScope?: 'current_chapter' | 'nearby_chapters' | 'volume_structure' | 'compare_two_paths';
    overrideUserPrompt?: string;
}

export type RagEvidenceSourceType =
    | 'character'
    | 'relationship'
    | 'item'
    | 'map'
    | 'plotPoint'
    | 'plotLine'
    | 'worldSetting'
    | 'chapter'
    | 'chapterSummary'
    | 'narrativeSummary'
    | 'searchHit'
    | 'idea'
    | 'currentContext';

export interface RagEvidenceItem {
    id: string;
    sourceType: RagEvidenceSourceType;
    sourceId: string;
    title: string;
    excerpt: string;
    metadata?: Record<string, unknown>;
    score?: number;
}

export interface RagCitation {
    evidenceId: string;
    label: string;
}

export interface RagAskResult {
    ok: boolean;
    question: string;
    intent: RagIntent;
    answer: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: RagEvidenceItem[];
    citations: RagCitation[];
    warnings: string[];
    usedContext: string[];
    rawPrompt?: string;
    editableUserPrompt?: string;
    error?: string;
}

export interface RagPromptBundle {
    systemPrompt: string;
    defaultUserPrompt: string;
    effectiveUserPrompt: string;
    intent: RagIntent;
    evidence: RagEvidenceItem[];
    citations: RagCitation[];
    warnings: string[];
    usedContext: string[];
}

export interface RagDetectionResult {
    intent: RagIntent;
    entityNames: string[];
    keywords: string[];
}
