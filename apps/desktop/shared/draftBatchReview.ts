import type { DraftBatchRecord } from './draftBatch';

export type DraftBatchReviewProjection = {
    committedPrefixLength: number;
    reviewablePrefixLength: number;
    firstPendingChildIndex: number | null;
    regenerationChildIndex: number | null;
    sideEffectUnknownChildIndex: number | null;
    canCommit: boolean;
    canDiscard: boolean;
};

export function projectDraftBatchReview(batch: DraftBatchRecord): DraftBatchReviewProjection {
    let committedPrefixLength = 0;
    while (batch.children[committedPrefixLength]?.status === 'committed') {
        committedPrefixLength += 1;
    }

    let reviewablePrefixLength = committedPrefixLength;
    while (batch.children[reviewablePrefixLength]?.status === 'draft') {
        reviewablePrefixLength += 1;
    }

    const firstPendingChild = batch.children.find((child) => (
        child.status === 'pending'
        || child.status === 'generating'
        || child.status === 'stale'
        || child.status === 'failed'
    ));
    const sideEffectUnknownChild = batch.children.find((child) => Boolean(child.error?.sideEffectUnknown));
    const regenerationChild = sideEffectUnknownChild
        ? null
        : batch.children.find((child) => (
            child.status === 'pending'
            || child.status === 'generating'
            || child.status === 'stale'
            || child.status === 'failed'
        ));
    const terminal = batch.status === 'committed' || batch.status === 'discarded' || batch.status === 'failed';

    return {
        committedPrefixLength,
        reviewablePrefixLength,
        firstPendingChildIndex: firstPendingChild?.childIndex ?? null,
        regenerationChildIndex: regenerationChild?.childIndex ?? null,
        sideEffectUnknownChildIndex: sideEffectUnknownChild?.childIndex ?? null,
        canCommit: !terminal && reviewablePrefixLength > committedPrefixLength,
        canDiscard: batch.status !== 'committed' && batch.status !== 'discarded',
    };
}
