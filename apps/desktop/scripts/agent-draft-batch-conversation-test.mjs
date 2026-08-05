import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentDraftBatchConversation.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { projectDraftBatchConversationState } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const beat = (title, childIndex = 0) => ({
    beatId: `beat-${childIndex}`,
    childIndex,
    title,
    chapterGoal: `${title}目标`,
    coreConflict: `${title}冲突`,
    keyEvents: [],
    reveals: [],
    endingHook: `${title}钩子`,
    targetWordCount: 2000,
});
const approval = (revision, active, response) => ({
    kind: 'checkpoint',
    key: `checkpoint-${revision}`,
    active,
    event: { createdAt: `2026-07-30T00:00:0${revision}.000Z` },
    approval: {
        checkpointId: `checkpoint-${revision}`,
        checkpointType: 'chapter_beats',
        title: '确认章节拍',
        question: '确认后生成',
        options: [{ id: 'approve_beats', label: '确认并生成' }],
        allowFreeText: true,
        draftBatchId: 'batch-1',
        outlineRevision: revision,
        beats: [beat(`第${revision}版`) ],
    },
    response,
});
const run = (overrides = {}) => ({
    runId: 'run-1',
    status: 'running',
    draftBatchId: 'batch-1',
    artifacts: [],
    pendingApproval: null,
    ...overrides,
});
const batch = (status, children = [{ childIndex: 0, status: 'pending' }]) => ({
    draftBatchId: 'batch-1',
    status,
    children,
    outline: { revision: 1, status: 'draft', beats: [beat('第一章')] },
});
const project = ({ runOverrides, batchRecord, timeline = [] }) => projectDraftBatchConversationState({
    run: run(runOverrides),
    batch: batchRecord,
    chapterBeatTimeline: timeline,
});

const pending = approval(2, true);
const adjusted = approval(1, false, { selectedOptionIds: [], freeText: '加快节奏' });
const awaiting = project({
    runOverrides: { status: 'waiting_approval', pendingApproval: pending.approval },
    batchRecord: batch('outline_draft'),
    timeline: [adjusted, pending],
});
assert.equal(awaiting.stage, 'awaiting_outline');
assert.equal(awaiting.primaryView, 'chapter_beat_snapshot');
assert.equal(awaiting.activeCheckpoint.outlineRevision, 2);
assert.equal(awaiting.beatHistory[0].status, 'adjustment_submitted');
assert.equal(awaiting.stableKey, 'draft-batch:run-1:batch-1');

for (const status of ['queued', 'retry_wait']) {
    const starting = project({
        runOverrides: { status: 'failed', draftOperationStatus: status },
        batchRecord: batch('ready_to_generate'),
        timeline: [approval(1, false, { selectedOptionIds: ['approve_beats'], freeText: '' })],
    });
    assert.equal(starting.stage, 'starting_generation', `${status} must not look interrupted`);
}
const queuedWithStalePendingApproval = project({
    runOverrides: {
        status: 'waiting_approval',
        draftOperationStatus: 'queued',
        pendingApproval: pending.approval,
    },
    batchRecord: batch('ready_to_generate'),
    timeline: [pending],
});
assert.equal(queuedWithStalePendingApproval.stage, 'starting_generation');
assert.equal(queuedWithStalePendingApproval.primaryView, 'draft_batch_progress');
assert.equal(queuedWithStalePendingApproval.activeCheckpoint, null);
assert.equal(queuedWithStalePendingApproval.beatHistory[0].status, 'confirmed');
for (const status of ['running_generation', 'running_postprocess', 'committing']) {
    assert.equal(project({
        runOverrides: { draftOperationStatus: status },
        batchRecord: batch('generating'),
    }).stage, 'generating');
}

const partiallyGenerated = project({
    runOverrides: { draftOperationStatus: 'running_generation' },
    batchRecord: batch('generating', [
        { childIndex: 0, status: 'draft', draftSessionId: 'draft-1' },
        { childIndex: 1, status: 'pending' },
    ]),
});
assert.equal(partiallyGenerated.generatedCount, 1);
assert.equal(partiallyGenerated.totalCount, 2);

for (const operationStatus of ['definitive_failed', 'cancelled', 'reconcile_required']) {
    assert.equal(project({
        runOverrides: { draftOperationStatus: operationStatus },
        batchRecord: batch('generating'),
    }).stage, 'interrupted');
}
assert.equal(project({ batchRecord: batch('partially_failed') }).stage, 'interrupted');
assert.equal(project({ batchRecord: batch('ready_for_review') }).stage, 'ready_for_review');
assert.equal(project({ batchRecord: batch('committed') }).stage, 'committed');
assert.equal(project({ batchRecord: batch('discarded') }).stage, 'discarded');
assert.equal(project({ batchRecord: batch('stale') }).stage, 'stale');

const artifactReady = project({
    runOverrides: {
        artifacts: [{ type: 'chapter_draft_batch', status: 'ready', reference: { draftBatchId: 'batch-1' } }],
    },
    batchRecord: batch('generating'),
});
assert.equal(artifactReady.stage, 'ready_for_review');
for (const [artifactStatus, stage] of [['committed', 'committed'], ['discarded', 'discarded'], ['failed', 'interrupted']]) {
    assert.equal(project({
        runOverrides: {
            artifacts: [{ type: 'chapter_draft_batch', status: artifactStatus, reference: { draftBatchId: 'batch-1' } }],
        },
        batchRecord: null,
    }).stage, stage);
}

const duplicateEventsDoNotCount = project({
    runOverrides: {},
    batchRecord: batch('generating', [{ childIndex: 0, status: 'pending' }]),
});
assert.equal(duplicateEventsDoNotCount.generatedCount, 0);

const duplicateChildrenCountOnce = project({
    batchRecord: batch('generating', [
        { childIndex: 0, status: 'draft', draftSessionId: 'draft-1' },
        { childIndex: 0, status: 'draft', draftSessionId: 'draft-1-replayed' },
        { childIndex: 1, status: 'draft' },
    ]),
});
assert.equal(duplicateChildrenCountOnce.generatedCount, 1);

const duplicateCheckpoint = { ...pending, key: 'checkpoint-2-replayed', event: { createdAt: '2026-07-30T00:00:09.000Z' } };
const deduplicatedHistory = project({
    runOverrides: { status: 'waiting_approval', pendingApproval: pending.approval },
    batchRecord: batch('outline_draft'),
    timeline: [adjusted, pending, duplicateCheckpoint],
});
assert.equal(deduplicatedHistory.activeCheckpoint.outlineRevision, 2);
assert.equal(deduplicatedHistory.beatHistory.length, 1);
assert.equal(deduplicatedHistory.beatHistory[0].outlineRevision, 1);

const mismatchedRevisionIsNotSubmittable = project({
    runOverrides: {
        status: 'waiting_approval',
        pendingApproval: { ...pending.approval, outlineRevision: 3 },
    },
    batchRecord: batch('outline_draft'),
    timeline: [pending],
});
assert.equal(mismatchedRevisionIsNotSubmittable.activeCheckpoint, null);
assert.equal(mismatchedRevisionIsNotSubmittable.beatHistory.length, 1);

const failedRunWithoutPersistentFailure = project({
    runOverrides: { status: 'failed' },
    batchRecord: null,
});
assert.equal(failedRunWithoutPersistentFailure.stage, 'preparing_outline');

const stableAcrossStages = project({
    runOverrides: { draftOperationStatus: 'running_generation' },
    batchRecord: batch('generating'),
});
assert.equal(stableAcrossStages.stableKey, awaiting.stableKey);

const approvalReferenceRecovery = projectDraftBatchConversationState({
    run: run({ draftBatchId: undefined, status: 'waiting_approval', pendingApproval: pending.approval }),
    batch: null,
    chapterBeatTimeline: [pending],
});
assert.equal(approvalReferenceRecovery.draftBatchId, 'batch-1');
assert.equal(approvalReferenceRecovery.stage, 'awaiting_outline');

console.log('Agent draft batch conversation projection tests passed.');
