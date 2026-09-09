import type {
    ConfirmCreativeAssetsResult,
    AiGenerationMetadata,
    CreativeAssetsDraft,
    CreativeAssetsDraftValidationResult,
    PromptPreviewResult,
} from '../ai/types';
import type {
    DraftBatchChildRecord,
    DraftBatchCommittedChapter,
    DraftBatchCommitPrefixInput,
    DraftBatchCreateInput,
    DraftBatchInspectReconciliationInput,
    DraftBatchListFilters,
    DraftBatchMarkFailedInput,
    DraftBatchPrepareRegenerationInput,
    DraftBatchReconcileUnknownInput,
    DraftBatchReconciliationInspection,
    DraftBatchRecord,
    DraftBatchUndoInput,
} from '../../shared/draftBatch';
import type { DraftWritebackRecord } from '../../shared/draftWriteback';
import type {
    AgentArtifactReviewRecord,
    AgentRevisionTask,
    ArtifactReviewSubmitInput,
    ArtifactReviewSubmitResult,
    ExpertReportPayload,
    RevisionTaskCreatePlanInput,
    RevisionTaskCreatePlanResult,
    RevisionTaskListFilters,
    RevisionTaskUpdateStatusInput,
} from '../../shared/expertReport';

export type {
    DraftBatchChildRecord,
    DraftBatchCommittedChapter,
    DraftBatchCommitPrefixInput,
    DraftBatchCreateInput,
    DraftBatchInspectReconciliationInput,
    DraftBatchListFilters,
    DraftBatchMarkFailedInput,
    DraftBatchPrepareRegenerationInput,
    DraftBatchReconcileUnknownInput,
    DraftBatchReconciliationInspection,
    DraftBatchRecord,
    DraftBatchUndoInput,
    DraftWritebackRecord,
    AgentArtifactReviewRecord,
    AgentRevisionTask,
    ArtifactReviewSubmitInput,
    ArtifactReviewSubmitResult,
    ExpertReportPayload,
    RevisionTaskCreatePlanInput,
    RevisionTaskCreatePlanResult,
    RevisionTaskListFilters,
    RevisionTaskUpdateStatusInput,
};

export type AutomationWorkspace = 'ai-workbench' | 'chapter-editor';
export type AutomationDraftType = 'creative-assets' | 'chapter-draft' | 'outline-draft';
export type AutomationDraftSource = 'internal-ai' | 'external-cli';
export type AutomationDraftOrigin = 'codex' | 'claude-code' | 'openclaw' | 'desktop-ui' | 'mcp-bridge' | 'unknown';
export type AutomationDraftStatus = 'draft' | 'stale' | 'committed' | 'discarded' | 'failed';

export interface CreativeDraftSelection {
    plotLines: boolean[];
    plotPoints: boolean[];
    characters: boolean[];
    items: boolean[];
    skills: boolean[];
    worldSettings: boolean[];
    maps: boolean[];
}

export interface ChapterDraftPayload {
    chapterId: string;
    baseContent: string;
    generatedText: string;
    content: string;
    presentation?: 'silent' | 'toast' | 'modal';
    usedContext: string[];
    consistency: {
        ok: boolean;
        issues: string[];
    };
    warnings?: string[];
    narrativeStateDelta?: import('../../shared/draftBatch').NarrativeStateDelta;
    contextPolicy?: import('../../shared/agentChapterScope').ContinuationContextPolicy;
    contextSnapshot?: import('../../shared/agentChapterScope').ContinuationContextSnapshot;
    sourceSnapshot?: import('../../shared/draftBatch').DraftBatchSourceSnapshot;
    generation?: AiGenerationMetadata;
}

export interface DraftSessionRecord {
    draftSessionId: string;
    workspace: AutomationWorkspace;
    type: AutomationDraftType;
    source: AutomationDraftSource;
    origin: AutomationDraftOrigin;
    novelId: string;
    chapterId?: string;
    sourceOperationId?: string;
    draftBatchId?: string;
    childIndex?: number;
    generationRevision?: number;
    dependsOnDraftSessionId?: string;
    revisionOfDraftSessionId?: string;
    reviewRequestId?: string;
    status: AutomationDraftStatus;
    payload: CreativeAssetsDraft | ChapterDraftPayload;
    selection?: CreativeDraftSelection;
    validation?: CreativeAssetsDraftValidationResult | null;
    previewSummary: string;
    generation?: AiGenerationMetadata;
    version: number;
    createdAt: string;
    updatedAt: string;
    writebacks?: DraftWritebackRecord[];
}

export interface AutomationInvokeContext {
    source: 'renderer' | 'http';
    origin?: AutomationDraftOrigin;
    requestId?: string;
    parentRequestId?: string;
    deadlineAt?: string;
    onProviderActivity?: (kind: 'first_byte' | 'chunk') => void;
    signal?: AbortSignal;
}

export interface AutomationErrorShape {
    code: string;
    message: string;
    details?: unknown;
}

export interface AutomationEnvelope<T = unknown> {
    ok: boolean;
    code: string;
    message: string;
    data?: T;
}

export interface DraftListFilters {
    novelId?: string;
    sourceOperationId?: string;
    draftBatchId?: string;
    includeBatchChildren?: boolean;
    workspace?: AutomationWorkspace;
    type?: AutomationDraftType;
    status?: AutomationDraftStatus;
    includeInactive?: boolean;
}

export interface PromptPreviewResponse {
    kind: 'creative_assets' | 'chapter';
    preview: PromptPreviewResult;
}

export interface DraftCommitResponse {
    session: DraftSessionRecord;
    validation?: CreativeAssetsDraftValidationResult;
    confirmResult?: ConfirmCreativeAssetsResult;
    saveResult?: unknown;
}

export interface DraftBatchCommitPrefixResponse {
    batch: DraftBatchRecord;
    sessions: DraftSessionRecord[];
    chapters: DraftBatchCommittedChapter[];
    committedPrefixLength: number;
    insertionMode: import('../../shared/draftBatch').DraftBatchInsertionMode;
    writeback?: DraftWritebackRecord;
}

export interface DraftUndoResponse {
    session?: DraftSessionRecord;
    batch?: DraftBatchRecord;
    writeback: DraftWritebackRecord;
}

export interface DraftBatchPrepareRegenerationResponse {
    batch: DraftBatchRecord;
    fromChildIndex: number;
    preservedDrafts: DraftSessionRecord[];
}
