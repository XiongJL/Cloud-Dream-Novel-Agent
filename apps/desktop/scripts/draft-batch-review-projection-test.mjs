import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/draftBatchReview.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { projectDraftBatchReview } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const createBatch = (statuses, errors = {}) => ({
    status: 'ready_for_review',
    children: statuses.map((status, childIndex) => ({
        childIndex,
        status,
        error: errors[childIndex],
    })),
});

assert.deepEqual(projectDraftBatchReview(createBatch(['draft', 'draft', 'pending'])), {
    committedPrefixLength: 0,
    reviewablePrefixLength: 2,
    firstPendingChildIndex: 2,
    regenerationChildIndex: 2,
    sideEffectUnknownChildIndex: null,
    canCommit: true,
    canDiscard: true,
});

assert.deepEqual(projectDraftBatchReview(createBatch(['committed', 'draft', 'stale'])), {
    committedPrefixLength: 1,
    reviewablePrefixLength: 2,
    firstPendingChildIndex: 2,
    regenerationChildIndex: 2,
    sideEffectUnknownChildIndex: null,
    canCommit: true,
    canDiscard: true,
});

const unknown = projectDraftBatchReview(createBatch(
    ['draft', 'failed', 'pending'],
    { 1: { code: 'SIDE_EFFECT_UNKNOWN', message: 'unknown', sideEffectUnknown: true } },
));
assert.equal(unknown.reviewablePrefixLength, 1);
assert.equal(unknown.regenerationChildIndex, null);
assert.equal(unknown.sideEffectUnknownChildIndex, 1);

const committed = projectDraftBatchReview({ ...createBatch(['committed', 'committed']), status: 'committed' });
assert.equal(committed.canCommit, false);
assert.equal(committed.canDiscard, false);

console.log('draft batch review projection tests passed');
