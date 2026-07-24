import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../electron/automation/ReviewCommentStore.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ReviewCommentStore } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-review-comments-'));

const input = (reviewVersionId, childIndex, body) => ({
    novelId: 'novel-1',
    sourceConversationId: 'conversation-1',
    sourceRunId: 'run-1',
    sourceArtifactId: 'artifact-1',
    reviewVersionId,
    draftSessionId: reviewVersionId,
    draftBatchId: 'batch-1',
    childIndex,
    anchor: {
        kind: 'paragraph',
        targetId: `${reviewVersionId}:paragraph:0`,
        paragraphIndex: 0,
        quote: `第 ${childIndex + 1} 章首段`,
        contentHash: `hash-${childIndex}`,
    },
    body,
});

try {
    const store = new ReviewCommentStore(() => tempRoot);
    const first = await store.save(input('draft-1', 0, '加强开场冲突。'));
    const second = await store.save(input('draft-2', 1, '收紧这一段的节奏。'));

    assert.equal((await store.list({ reviewVersionId: 'draft-1' })).length, 1);
    assert.deepEqual(
        (await store.list({ reviewVersionIds: ['draft-1', 'draft-2'] })).map((comment) => comment.commentId),
        [first.commentId, second.commentId],
    );

    const edited = await store.save({
        ...input('draft-1', 0, '加强开场冲突，并提前人物目标。'),
        commentId: first.commentId,
    });
    assert.equal(edited.commentId, first.commentId);
    assert.equal(edited.body, '加强开场冲突，并提前人物目标。');

    await assert.rejects(
        () => store.save({ ...input('draft-other', 0, '错误版本。'), commentId: first.commentId }),
        (error) => error?.code === 'VERSION_CONFLICT',
    );

    const reloaded = new ReviewCommentStore(() => tempRoot);
    assert.equal((await reloaded.list({ sourceConversationId: 'conversation-1' })).length, 2);

    const sent = await reloaded.markSent({
        commentIds: [first.commentId, second.commentId],
        mode: 'regenerate',
    });
    assert.equal(sent.length, 2);
    assert.ok(sent.every((comment) => comment.status === 'sent' && comment.sentMode === 'regenerate'));

    await reloaded.delete(second.commentId);
    assert.deepEqual(
        (await reloaded.list({ sourceConversationId: 'conversation-1' })).map((comment) => comment.commentId),
        [first.commentId],
    );

    const persisted = JSON.parse(await fs.readFile(path.join(tempRoot, 'automation', 'review-comments.json'), 'utf8'));
    assert.equal(persisted.comments.length, 1);
    console.log('Review comment persistence, version isolation, and batch submission tests passed.');
} finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
}
