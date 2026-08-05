import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/draftOperation.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { transitionDraftOperation, isDraftOperationTerminal } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const now = '2026-07-29T00:00:00.000Z';
const later = '2026-07-29T00:01:00.000Z';
const base = {
    operationId: 'op_1',
    operationKey: 'key_1',
    operationType: 'chapter_draft',
    paramsHash: 'hash_1',
    requestJson: '{}',
    novelId: 'novel_1',
    chapterId: 'chapter_1',
    generationRevision: 1,
    sourceChapterVersion: 1,
    sourceContentHash: 'content_1',
    status: 'queued',
    phase: 'accepted',
    version: 1,
    attemptCount: 0,
    maxAttempts: 4,
    operationDeadlineAt: '2026-07-29T00:10:00.000Z',
    warningJson: '[]',
    createdAt: now,
    updatedAt: now,
};

function apply(current, event) {
    const transition = transitionDraftOperation(current, event);
    return {
        ...current,
        ...transition.patch,
        status: transition.nextStatus,
        version: transition.changed ? current.version + 1 : current.version,
    };
}

let operation = apply(base, {
    type: 'CLAIM',
    now,
    workerId: 'worker_1',
    leaseExpiresAt: later,
});
assert.equal(operation.status, 'running_generation');
assert.equal(operation.attemptCount, 1);
assert.equal(operation.leaseOwner, 'worker_1');

assert.throws(
    () => transitionDraftOperation(operation, {
        type: 'HEARTBEAT',
        now,
        workerId: 'worker_2',
        leaseExpiresAt: later,
    }),
    (error) => error?.code === 'INVALID_OPERATION_TRANSITION',
);

operation = apply(operation, {
    type: 'GENERATION_SUCCEEDED',
    now,
    generatedPayloadJson: '{"text":"draft"}',
});
assert.equal(operation.status, 'running_postprocess');

operation = apply(operation, {
    type: 'POSTPROCESS_COMPLETED',
    now,
    warningJson: '[]',
});
assert.equal(operation.status, 'committing');

const completed = transitionDraftOperation(operation, {
    type: 'COMMIT_SUCCEEDED',
    now,
    draftSessionId: 'draft_1',
    resultJson: '{"draftSessionId":"draft_1"}',
});
assert.equal(completed.nextStatus, 'succeeded');
assert.equal(completed.emitCompletion, true);
operation = { ...operation, ...completed.patch, status: completed.nextStatus };
assert.equal(isDraftOperationTerminal(operation.status), true);

const duplicateCompletion = transitionDraftOperation(operation, {
    type: 'COMMIT_SUCCEEDED',
    now,
    draftSessionId: 'draft_1',
    resultJson: '{"draftSessionId":"draft_1"}',
});
assert.equal(duplicateCompletion.changed, false);
assert.equal(duplicateCompletion.emitCompletion, false);

let retrying = apply(base, {
    type: 'CLAIM',
    now,
    workerId: 'worker_1',
    leaseExpiresAt: later,
});
retrying = apply(retrying, {
    type: 'RETRYABLE_FAILURE',
    now,
    retryAt: later,
    errorCode: 'PROVIDER_TIMEOUT',
    errorJson: '{}',
});
assert.equal(retrying.status, 'retry_wait');
retrying = apply(retrying, {
    type: 'RETRY_DUE',
    now: later,
    workerId: 'worker_1',
    leaseExpiresAt: '2026-07-29T00:02:00.000Z',
});
assert.equal(retrying.status, 'running_generation');
assert.equal(retrying.attemptCount, 2);

const queuedCancelled = transitionDraftOperation(base, { type: 'CANCEL_REQUEST', now });
assert.equal(queuedCancelled.nextStatus, 'cancelled');
assert.equal(queuedCancelled.emitCompletion, true);

let cancelRace = apply(base, {
    type: 'CLAIM',
    now,
    workerId: 'worker_1',
    leaseExpiresAt: later,
});
cancelRace = apply(cancelRace, { type: 'CANCEL_REQUEST', now });
assert.equal(cancelRace.status, 'cancel_requested');
const cancelled = transitionDraftOperation(cancelRace, { type: 'ABORT_CONFIRMED', now: later });
assert.equal(cancelled.nextStatus, 'cancelled');
assert.equal(cancelled.emitCompletion, true);

cancelRace = apply(cancelRace, { type: 'RESULT_WON_RACE', now: later });
assert.equal(cancelRace.status, 'committing');
cancelRace = apply(cancelRace, {
    type: 'COMMIT_SUCCEEDED',
    now: later,
    draftSessionId: 'draft_race',
    resultJson: '{"draftSessionId":"draft_race"}',
});
assert.equal(cancelRace.status, 'succeeded');

let manuallyRetried = apply(base, {
    type: 'TERMINAL_FAILURE',
    now,
    errorCode: 'PROVIDER_REJECTED',
    errorJson: '{}',
});
manuallyRetried = apply(manuallyRetried, { type: 'RETRY_REQUESTED', now: later });
assert.equal(manuallyRetried.status, 'queued');

assert.throws(
    () => transitionDraftOperation(base, {
        type: 'COMMIT_SUCCEEDED',
        now,
        draftSessionId: 'draft_invalid',
        resultJson: '{}',
    }),
    (error) => error?.code === 'INVALID_OPERATION_TRANSITION',
);

console.log('Draft operation state machine tests passed.');
