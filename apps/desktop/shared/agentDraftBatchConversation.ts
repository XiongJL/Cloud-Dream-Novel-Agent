import type { DraftBatchRecord } from './draftBatch';
import type { DraftOperationStatus } from './draftOperation';
import type {
    ProjectedChapterBeat,
    ProjectedChapterBeatTimelineItem,
    ProjectedRun,
} from './agentRunProjection';

export type DraftBatchConversationStage =
    | 'preparing_outline'
    | 'awaiting_outline'
    | 'starting_generation'
    | 'generating'
    | 'interrupted'
    | 'ready_for_review'
    | 'committed'
    | 'discarded'
    | 'stale';

export type DraftBatchPrimaryView =
    | 'none'
    | 'chapter_beat_snapshot'
    | 'draft_batch_progress'
    | 'draft_batch_interrupted'
    | 'draft_batch_review';

export type ChapterBeatCheckpointSnapshot = {
    checkpointId: string;
    draftBatchId: string;
    outlineRevision: number;
    beats: ProjectedChapterBeat[];
    status: 'pending' | 'confirmed' | 'adjustment_submitted' | 'replaced';
    statusLabel: string;
    createdAt: string;
    approval: Extract<ProjectedChapterBeatTimelineItem, { kind: 'checkpoint' }>['approval'];
};

export type DraftBatchConversationState = {
    stableKey: string;
    draftBatchId: string;
    stage: DraftBatchConversationStage;
    generatedCount: number;
    totalCount: number;
    activeCheckpoint: ChapterBeatCheckpointSnapshot | null;
    beatHistory: ChapterBeatCheckpointSnapshot[];
    primaryView: DraftBatchPrimaryView;
};

export type DraftBatchConversationProjectionInput = {
    run: Pick<ProjectedRun, 'runId' | 'status' | 'artifacts' | 'draftBatchId' | 'draftOperationStatus' | 'pendingApproval'>;
    batch?: DraftBatchRecord | null;
    chapterBeatTimeline: ProjectedChapterBeatTimelineItem[];
};

export type DraftInspectorSelection =
    | {
        kind: 'chapter_beat_snapshot';
        runId: string;
        checkpointId: string;
        draftBatchId: string;
        outlineRevision: number;
        beats: ProjectedChapterBeat[];
        historical: boolean;
        statusLabel: string;
    }
    | {
        kind: 'draft_batch_progress' | 'draft_batch_interrupted' | 'draft_batch_review';
        runId: string;
        draftBatchId: string;
    };

const ACTIVE_OPERATION_STATUSES = new Set<DraftOperationStatus>([
    'queued',
    'running_generation',
    'retry_wait',
    'running_postprocess',
    'committing',
    'cancel_requested',
]);

const INTERRUPTED_OPERATION_STATUSES = new Set<DraftOperationStatus>([
    'definitive_failed',
    'cancelled',
    'reconcile_required',
]);

function checkpointSnapshot(
    item: Extract<ProjectedChapterBeatTimelineItem, { kind: 'checkpoint' }>,
    fallbackDraftBatchId: string,
    active: boolean,
): ChapterBeatCheckpointSnapshot | null {
    const revision = item.approval.outlineRevision;
    const beats = item.approval.beats;
    if (!revision || !beats?.length) return null;
    const approved = item.response?.selectedOptionIds.includes('approve_beats') === true;
    const adjusted = Boolean(item.response?.freeText);
    const status = active
        ? 'pending'
        : approved
            ? 'confirmed'
            : adjusted
                ? 'adjustment_submitted'
                : 'replaced';
    const statusLabel = status === 'pending'
        ? '待确认'
        : status === 'confirmed'
            ? '已确认'
            : status === 'adjustment_submitted'
                ? '调整已提交'
                : '已替代';
    return {
        checkpointId: item.approval.checkpointId,
        draftBatchId: item.approval.draftBatchId || fallbackDraftBatchId,
        outlineRevision: revision,
        beats,
        status,
        statusLabel,
        createdAt: item.event.createdAt,
        approval: item.approval,
    };
}

function primaryViewForStage(stage: DraftBatchConversationStage): DraftBatchPrimaryView {
    if (stage === 'awaiting_outline') return 'chapter_beat_snapshot';
    if (stage === 'starting_generation' || stage === 'generating') return 'draft_batch_progress';
    if (stage === 'interrupted') return 'draft_batch_interrupted';
    if (stage === 'ready_for_review' || stage === 'committed' || stage === 'discarded' || stage === 'stale') {
        return 'draft_batch_review';
    }
    return 'none';
}

function projectStage({
    run,
    batch,
    activeCheckpoint,
    generatedCount,
    draftBatchId,
}: {
    run: DraftBatchConversationProjectionInput['run'];
    batch: DraftBatchRecord | null;
    activeCheckpoint: ChapterBeatCheckpointSnapshot | null;
    generatedCount: number;
    draftBatchId: string;
}): DraftBatchConversationStage {
    const batchArtifact = [...(run.artifacts ?? [])].reverse().find((artifact) => (
        artifact.type === 'chapter_draft_batch'
        && (!draftBatchId || artifact.reference?.draftBatchId === draftBatchId)
    ));
    if (batchArtifact?.status === 'committed') return 'committed';
    if (batchArtifact?.status === 'discarded') return 'discarded';
    if (batchArtifact?.status === 'failed') return 'interrupted';
    if (batchArtifact?.status === 'ready') return 'ready_for_review';

    if (batch?.status === 'committed') return 'committed';
    if (batch?.status === 'discarded') return 'discarded';
    if (batch?.status === 'stale') return 'stale';
    if (batch?.status === 'ready_for_review') return 'ready_for_review';
    if (batch?.status === 'partially_failed' || batch?.status === 'failed') return 'interrupted';

    const operationStatus = run.draftOperationStatus as DraftOperationStatus | undefined;
    if (operationStatus && INTERRUPTED_OPERATION_STATUSES.has(operationStatus)) return 'interrupted';
    if (batch?.status === 'ready_to_generate' || operationStatus === 'queued' || operationStatus === 'retry_wait') {
        return generatedCount > 0 ? 'generating' : 'starting_generation';
    }
    if (
        batch?.status === 'generating'
        || operationStatus === 'succeeded'
        || (operationStatus && ACTIVE_OPERATION_STATUSES.has(operationStatus))
    ) {
        return 'generating';
    }
    if (activeCheckpoint) return 'awaiting_outline';
    if (batch?.status === 'outline_draft') return 'preparing_outline';

    return 'preparing_outline';
}

export function projectDraftBatchConversationState({
    run,
    batch = null,
    chapterBeatTimeline,
}: DraftBatchConversationProjectionInput): DraftBatchConversationState | null {
    const checkpointItems = chapterBeatTimeline.filter(
        (item): item is Extract<ProjectedChapterBeatTimelineItem, { kind: 'checkpoint' }> => item.kind === 'checkpoint',
    );
    const uniqueCheckpointItems = new Map<string, Extract<ProjectedChapterBeatTimelineItem, { kind: 'checkpoint' }>>();
    checkpointItems.forEach((item) => {
        const key = `${item.approval.checkpointId}:${item.approval.outlineRevision ?? 0}`;
        uniqueCheckpointItems.delete(key);
        uniqueCheckpointItems.set(key, item);
    });
    const deduplicatedCheckpoints = [...uniqueCheckpointItems.values()];
    const latestCheckpoint = deduplicatedCheckpoints[deduplicatedCheckpoints.length - 1];
    const effectiveDraftBatchId = batch?.draftBatchId
        || run.draftBatchId
        || run.pendingApproval?.draftBatchId
        || latestCheckpoint?.approval.draftBatchId
        || '';
    if (!effectiveDraftBatchId && checkpointItems.length === 0) return null;

    const pendingApproval = run.pendingApproval?.checkpointType === 'chapter_beats'
        ? run.pendingApproval
        : null;
    const activeCheckpointItem = [...deduplicatedCheckpoints].reverse().find((item) => (
        pendingApproval?.checkpointId === item.approval.checkpointId
        && (pendingApproval.outlineRevision === undefined || pendingApproval.outlineRevision === item.approval.outlineRevision)
        && (pendingApproval.draftBatchId === undefined || pendingApproval.draftBatchId === item.approval.draftBatchId)
    ));
    const snapshots = deduplicatedCheckpoints
        .map((item) => checkpointSnapshot(
            activeCheckpointItem === item && pendingApproval?.beats?.length
                ? { ...item, approval: pendingApproval }
                : item,
            effectiveDraftBatchId,
            activeCheckpointItem === item,
        ))
        .filter((item): item is ChapterBeatCheckpointSnapshot => item !== null);
    const checkpointCandidate = [...snapshots].reverse().find((snapshot) => snapshot.status === 'pending') ?? null;
    const fallbackBeatCount = checkpointCandidate?.beats.length ?? snapshots[snapshots.length - 1]?.beats.length ?? 0;
    const totalCount = batch?.children.length ?? fallbackBeatCount;
    const generatedCount = batch
        ? new Set(batch.children.flatMap((child) => (
            child.draftSessionId && ['draft', 'stale', 'committed'].includes(child.status)
                ? [child.childIndex]
                : []
        ))).size
        : 0;
    const stage = projectStage({
        run,
        batch,
        activeCheckpoint: checkpointCandidate,
        generatedCount,
        draftBatchId: effectiveDraftBatchId,
    });
    const activeCheckpoint = stage === 'awaiting_outline' ? checkpointCandidate : null;
    const beatHistory = snapshots
        .filter((snapshot) => snapshot !== activeCheckpoint)
        .map((snapshot) => snapshot.status === 'pending'
            ? { ...snapshot, status: 'confirmed' as const, statusLabel: '已确认' }
            : snapshot)
        .sort((left, right) => right.outlineRevision - left.outlineRevision || right.createdAt.localeCompare(left.createdAt));
    return {
        stableKey: `draft-batch:${run.runId}:${effectiveDraftBatchId || 'pending'}`,
        draftBatchId: effectiveDraftBatchId,
        stage,
        generatedCount,
        totalCount,
        activeCheckpoint,
        beatHistory,
        primaryView: primaryViewForStage(stage),
    };
}
