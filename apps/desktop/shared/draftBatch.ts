export type DraftBatchMode = 'sequence_continuation' | 'batch_rewrite';

export type DraftBatchInsertionMode = 'after_anchor' | 'volume_end';

export type DraftBatchStatus =
    | 'outline_draft'
    | 'ready_to_generate'
    | 'generating'
    | 'ready_for_review'
    | 'partially_failed'
    | 'stale'
    | 'committed'
    | 'discarded'
    | 'failed';

export type DraftBatchChildStatus =
    | 'pending'
    | 'generating'
    | 'draft'
    | 'stale'
    | 'failed'
    | 'committed'
    | 'discarded';

export interface ChapterBeatInput {
    title: string;
    chapterGoal: string;
    coreConflict: string;
    keyEvents: string[];
    reveals: string[];
    endingHook: string;
    targetWordCount: number;
}

export interface ChapterBeat extends ChapterBeatInput {
    beatId: string;
    childIndex: number;
}

export interface DraftBatchOutline {
    revision: number;
    status: 'draft' | 'approved';
    beats: ChapterBeat[];
    approvedAt?: string;
    approvedBy?: string;
}

export interface DraftBatchSourceSnapshot {
    chapterId: string;
    version: number;
    contentHash: string;
}

export interface DraftBatchChildRecord {
    childIndex: number;
    title: string;
    status: DraftBatchChildStatus;
    generationRevision: number;
    draftSessionId?: string;
    targetChapterId?: string;
    dependsOnChildIndex?: number;
    sourceSnapshot?: DraftBatchSourceSnapshot;
    error?: {
        code: string;
        message: string;
        sideEffectUnknown?: boolean;
        invocationKey?: string;
        requestId?: string;
        method?: string;
    };
    reconciliation?: DraftBatchReconciliationRecord;
}

export type DraftBatchReconciliationResolution = 'reconciled_succeeded' | 'reconciled_absent';

export interface DraftBatchReconciliationRecord {
    resolution: DraftBatchReconciliationResolution | 'pending';
    invocationKey: string;
    requestId?: string;
    method: string;
    candidateDraftSessionId?: string;
    note?: string;
    reconciledAt?: string;
}

export interface DraftBatchReconciliationCandidate {
    draftSessionId: string;
    draftBatchId: string;
    childIndex: number;
    generationRevision: number;
    status: string;
    previewSummary: string;
    createdAt: string;
    updatedAt: string;
}

export interface DraftBatchInspectReconciliationInput {
    draftBatchId: string;
    childIndex: number;
    generationRevision: number;
}

export interface DraftBatchReconciliationInspection {
    batch: DraftBatchRecord;
    child: DraftBatchChildRecord;
    candidates: DraftBatchReconciliationCandidate[];
}

export interface DraftBatchReconcileUnknownInput extends DraftBatchInspectReconciliationInput {
    version: number;
    invocationKey: string;
    resolution: DraftBatchReconciliationResolution;
    confirmation: boolean;
    candidateDraftSessionId?: string;
    note?: string;
}

export interface NarrativeStateLedger {
    characterLocations: Record<string, string>;
    relationshipChanges: Array<Record<string, unknown>>;
    knowledgeState: Record<string, string[]>;
    foreshadowing: Array<Record<string, unknown>>;
    timeline: Array<Record<string, unknown>>;
    itemStates: Record<string, string>;
    unresolvedConflicts: string[];
    stateDeltas: NarrativeStateDeltaRecord[];
}

export interface NarrativeStateDelta {
    characterLocations: Array<{
        characterKey: string;
        location: string;
        evidenceExcerpt: string;
    }>;
    relationshipChanges: Array<{
        sourceCharacterKey: string;
        targetCharacterKey: string;
        change: string;
        evidenceExcerpt: string;
    }>;
    knowledgeChanges: Array<{
        characterKey: string;
        learned: string[];
        forgotten: string[];
        evidenceExcerpt: string;
    }>;
    itemStates: Array<{
        itemKey: string;
        state: string;
        holderKey?: string;
        location?: string;
        evidenceExcerpt: string;
    }>;
    resolvedConflicts: Array<{ conflict: string; evidenceExcerpt: string }>;
    openedConflicts: Array<{ conflict: string; evidenceExcerpt: string }>;
    warnings: string[];
}

export interface NarrativeStateDeltaRecord extends NarrativeStateDelta {
    childIndex: number;
    generationRevision: number;
    draftSessionId: string;
}

export interface DraftBatchRecord {
    draftBatchId: string;
    novelId: string;
    volumeId: string;
    anchorChapterId: string;
    mode: DraftBatchMode;
    insertionMode?: DraftBatchInsertionMode;
    status: DraftBatchStatus;
    outline: DraftBatchOutline;
    children: DraftBatchChildRecord[];
    stateLedger: NarrativeStateLedger;
    sourceSnapshot: DraftBatchSourceSnapshot[];
    runId?: string;
    linkedRunIds: string[];
    writebacks?: import('./draftWriteback').DraftWritebackRecord[];
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface DraftBatchCreateInput {
    novelId: string;
    volumeId: string;
    anchorChapterId: string;
    mode: DraftBatchMode;
    insertionMode?: DraftBatchInsertionMode;
    beats: ChapterBeatInput[];
    targetChapterIds?: string[];
    sourceSnapshot?: DraftBatchSourceSnapshot[];
    runId?: string;
}

export interface DraftBatchListFilters {
    novelId?: string;
    volumeId?: string;
    status?: DraftBatchStatus;
    includeInactive?: boolean;
}

export interface DraftBatchCommitPrefixInput {
    draftBatchId: string;
    version: number;
    prefixLength: number;
    insertionMode?: DraftBatchInsertionMode;
}

export interface DraftBatchUndoInput {
    draftBatchId: string;
    version: number;
    writebackId: string;
}

export interface DraftBatchCommittedChapter {
    childIndex: number;
    chapterId: string;
    volumeId: string;
    title: string;
    order: number;
    version: number;
    content: string;
}

export interface DraftBatchPrepareRegenerationInput {
    draftBatchId: string;
    version: number;
    fromChildIndex?: number;
    runId: string;
}

export interface DraftBatchMarkFailedInput {
    draftBatchId: string;
    version: number;
    childIndex: number;
    generationRevision: number;
    error: {
        code: string;
        message: string;
        sideEffectUnknown?: boolean;
        invocationKey?: string;
        requestId?: string;
        method?: string;
    };
}

export function createEmptyNarrativeStateLedger(): NarrativeStateLedger {
    return {
        characterLocations: {},
        relationshipChanges: [],
        knowledgeState: {},
        foreshadowing: [],
        timeline: [],
        itemStates: {},
        unresolvedConflicts: [],
        stateDeltas: [],
    };
}
