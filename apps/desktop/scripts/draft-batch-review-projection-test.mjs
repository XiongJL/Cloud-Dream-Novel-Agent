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

const chapterLabelSource = await readFile(new URL('../shared/draftBatchChapterLabel.ts', import.meta.url), 'utf8');
const chapterLabelOutput = ts.transpileModule(chapterLabelSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { resolveDraftBatchChapterDisplay } = await import(
    `data:text/javascript;base64,${Buffer.from(chapterLabelOutput).toString('base64')}`
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

const catalog = [{
    id: 'volume-1',
    order: 1,
    chapters: [
        { id: 'chapter-1', order: 1 },
        { id: 'chapter-2', order: 2 },
        { id: 'chapter-3', order: 3 },
    ],
}];
const rewriteBatch = {
    mode: 'batch_rewrite',
    children: [
        { childIndex: 0, targetChapterId: 'chapter-2' },
        { childIndex: 1, targetChapterId: 'chapter-3' },
    ],
};
assert.deepEqual(resolveDraftBatchChapterDisplay(rewriteBatch, 0, catalog), {
    shortLabel: '第 2 章',
    fullLabel: '第 1 卷 · 第 2 章',
    source: 'catalog',
});
assert.equal(resolveDraftBatchChapterDisplay(rewriteBatch, 1, catalog).shortLabel, '第 3 章');
assert.equal(
    resolveDraftBatchChapterDisplay({ mode: 'batch_rewrite', children: [{ childIndex: 0 }] }, 0, catalog).shortLabel,
    '批次第 1 项',
);
assert.equal(
    resolveDraftBatchChapterDisplay({ mode: 'sequence_continuation', children: [{ childIndex: 1 }] }, 1, catalog).shortLabel,
    '新增第 2 章',
);

console.log('draft batch review projection tests passed');
