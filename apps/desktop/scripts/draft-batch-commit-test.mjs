import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

const source = await readFile(new URL('../electron/automation/DraftBatchCommitter.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { commitDraftBatchChapters, undoDraftBatchWriteback } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-draft-batch-commit-'));
const dbPath = path.join(tempRoot, 'batch-commit.db').replaceAll('\\', '/');
const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
const hash = (content) => createHash('sha256').update(content, 'utf8').digest('hex');
const now = '2026-07-17T00:00:00.000Z';
const batch = (contentHash) => ({
    draftBatchId: 'batch-1',
    novelId: 'novel-1',
    volumeId: 'volume-1',
    anchorChapterId: 'chapter-anchor',
    mode: 'sequence_continuation',
    status: 'ready_for_review',
    outline: { revision: 1, status: 'approved', beats: [] },
    children: [
        { childIndex: 0, title: '新章一', status: 'draft', generationRevision: 1 },
        { childIndex: 1, title: '新章二', status: 'draft', generationRevision: 1 },
    ],
    stateLedger: {
        characterLocations: {}, relationshipChanges: [], knowledgeState: {}, foreshadowing: [],
        timeline: [], itemStates: {}, unresolvedConflicts: [],
    },
    sourceSnapshot: [{ chapterId: 'chapter-anchor', version: 1, contentHash }],
    linkedRunIds: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
});
const drafts = [
    { childIndex: 0, title: '新章一', content: '{"root":{"children":[]}}', wordCount: 120 },
    { childIndex: 1, title: '新章二', content: '{"root":{"children":[]}}', wordCount: 180 },
];

try {
    await client.$executeRawUnsafe(`
        CREATE TABLE Novel (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, coverUrl TEXT,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
            wordCount INTEGER NOT NULL DEFAULT 0, formatting TEXT NOT NULL DEFAULT '{}'
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE Volume (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, "order" INTEGER NOT NULL, novelId TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE Chapter (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, wordCount INTEGER NOT NULL DEFAULT 0,
            "order" INTEGER NOT NULL, volumeId TEXT NOT NULL,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0
        )
    `);
    await client.novel.create({ data: { id: 'novel-1', title: '测试小说' } });
    await client.volume.create({ data: { id: 'volume-1', novelId: 'novel-1', title: '第一卷', order: 1 } });
    const anchorContent = '锚点正文。';
    await client.chapter.create({
        data: { id: 'chapter-anchor', volumeId: 'volume-1', title: '锚点章', order: 1, content: anchorContent },
    });
    await client.chapter.create({
        data: { id: 'chapter-existing', volumeId: 'volume-1', title: '已有后章', order: 2, content: '已有正文。' },
    });

    await assert.rejects(
        () => commitDraftBatchChapters(client, {
            batch: batch(hash(anchorContent)), committedPrefixLength: 0, prefixLength: 2, drafts,
        }),
        (error) => error?.code === 'INSERTION_MODE_REQUIRED',
    );
    assert.equal(await client.chapter.count(), 2);
    assert.equal((await client.chapter.findUnique({ where: { id: 'chapter-existing' } })).order, 2);

    const firstCommitted = await commitDraftBatchChapters(client, {
        batch: batch(hash(anchorContent)),
        committedPrefixLength: 0,
        prefixLength: 1,
        insertionMode: 'after_anchor',
        drafts: drafts.slice(0, 1),
    });
    assert.equal(firstCommitted.insertionMode, 'after_anchor');
    assert.deepEqual(firstCommitted.chapters.map((chapter) => chapter.order), [2]);
    assert.deepEqual(firstCommitted.reorderedChapterIds, ['chapter-existing']);
    assert.equal((await client.chapter.findUnique({ where: { id: 'chapter-existing' } })).order, 3);

    const partiallyCommittedBatch = {
        ...batch(hash(anchorContent)),
        insertionMode: 'after_anchor',
        children: [
            {
                childIndex: 0,
                title: '新章一',
                status: 'committed',
                generationRevision: 1,
                targetChapterId: firstCommitted.chapters[0].chapterId,
            },
            { childIndex: 1, title: '新章二', status: 'draft', generationRevision: 1 },
        ],
        version: 2,
    };
    const secondCommitted = await commitDraftBatchChapters(client, {
        batch: partiallyCommittedBatch,
        committedPrefixLength: 1,
        prefixLength: 2,
        drafts: drafts.slice(1),
    });
    assert.deepEqual(secondCommitted.chapters.map((chapter) => chapter.order), [3]);
    assert.deepEqual(secondCommitted.reorderedChapterIds, ['chapter-existing']);
    const existing = await client.chapter.findUnique({ where: { id: 'chapter-existing' } });
    assert.equal(existing.order, 4);
    assert.equal(existing.version, 3);
    assert.equal((await client.novel.findUnique({ where: { id: 'novel-1' } })).wordCount, 300);

    const staleBatch = { ...batch(hash(anchorContent)), draftBatchId: 'batch-stale' };
    await client.chapter.update({
        where: { id: 'chapter-anchor' },
        data: { content: '用户已修改锚点。', version: { increment: 1 } },
    });
    const beforeConflictCount = await client.chapter.count();
    await assert.rejects(
        () => commitDraftBatchChapters(client, {
            batch: staleBatch,
            committedPrefixLength: 0,
            prefixLength: 1,
            insertionMode: 'volume_end',
            drafts: drafts.slice(0, 1),
        }),
        (error) => error?.code === 'VERSION_CONFLICT',
    );
    assert.equal(await client.chapter.count(), beforeConflictCount);
    assert.equal((await client.novel.findUnique({ where: { id: 'novel-1' } })).wordCount, 300);

    const rewriteOriginal = '旧正文。';
    const rewriteDraft = '新正文，包含修订。';
    await client.novel.create({
        data: { id: 'novel-rewrite', title: '修订测试', wordCount: rewriteOriginal.length },
    });
    await client.volume.create({
        data: { id: 'volume-rewrite', novelId: 'novel-rewrite', title: '第一卷', order: 1 },
    });
    await client.chapter.create({
        data: {
            id: 'chapter-rewrite',
            volumeId: 'volume-rewrite',
            title: '待修订章',
            order: 1,
            content: rewriteOriginal,
            wordCount: rewriteOriginal.length,
        },
    });
    const rewriteBatch = {
        ...batch(hash(rewriteOriginal)),
        draftBatchId: 'batch-rewrite',
        novelId: 'novel-rewrite',
        volumeId: 'volume-rewrite',
        anchorChapterId: 'chapter-rewrite',
        mode: 'batch_rewrite',
        children: [{
            childIndex: 0,
            title: '待修订章',
            status: 'draft',
            generationRevision: 1,
            targetChapterId: 'chapter-rewrite',
        }],
        sourceSnapshot: [{ chapterId: 'chapter-rewrite', version: 1, contentHash: hash(rewriteOriginal) }],
    };
    const rewriteCommitted = await commitDraftBatchChapters(client, {
        batch: rewriteBatch,
        committedPrefixLength: 0,
        prefixLength: 1,
        drafts: [{
            childIndex: 0,
            targetChapterId: 'chapter-rewrite',
            title: '待修订章',
            content: rewriteDraft,
            wordCount: rewriteDraft.length,
        }],
    });
    assert.equal(rewriteCommitted.writeback?.mode, 'batch_rewrite');
    assert.equal(rewriteCommitted.writeback?.chapters[0].beforeContent, rewriteOriginal);
    assert.equal((await client.chapter.findUnique({ where: { id: 'chapter-rewrite' } })).version, 2);

    const restored = await undoDraftBatchWriteback(client, rewriteBatch, rewriteCommitted.writeback);
    assert.equal(restored[0].content, rewriteOriginal);
    assert.equal(restored[0].version, 3);
    assert.equal((await client.novel.findUnique({ where: { id: 'novel-rewrite' } })).wordCount, rewriteOriginal.length);

    const recommitBatch = {
        ...rewriteBatch,
        sourceSnapshot: [{ chapterId: 'chapter-rewrite', version: 3, contentHash: hash(rewriteOriginal) }],
    };
    const recommitted = await commitDraftBatchChapters(client, {
        batch: recommitBatch,
        committedPrefixLength: 0,
        prefixLength: 1,
        drafts: [{
            childIndex: 0,
            targetChapterId: 'chapter-rewrite',
            title: '待修订章',
            content: rewriteDraft,
            wordCount: rewriteDraft.length,
        }],
    });
    await client.chapter.update({
        where: { id: 'chapter-rewrite' },
        data: { content: '作者在写回后继续编辑。' },
    });
    await assert.rejects(
        () => undoDraftBatchWriteback(client, recommitBatch, recommitted.writeback),
        (error) => error?.code === 'VERSION_CONFLICT',
    );
    assert.equal((await client.chapter.findUnique({ where: { id: 'chapter-rewrite' } })).content, '作者在写回后继续编辑。');

    console.log('Draft batch SQLite prefix commit and conflict rollback tests passed.');
} finally {
    await client.$disconnect().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
}
