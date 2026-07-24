import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClientType } from '@novel-editor/core';
import type {
    DraftBatchCommittedChapter,
    DraftBatchInsertionMode,
    DraftBatchRecord,
} from '../../shared/draftBatch';
import type { DraftWritebackRecord } from '../../shared/draftWriteback';

type DraftChapterWrite = {
    childIndex: number;
    targetChapterId?: string;
    title: string;
    content: string;
    wordCount: number;
};

export type DraftBatchChapterCommitInput = {
    batch: DraftBatchRecord;
    committedPrefixLength: number;
    prefixLength: number;
    insertionMode?: DraftBatchInsertionMode;
    drafts: DraftChapterWrite[];
};

export type DraftBatchChapterCommitResult = {
    chapters: DraftBatchCommittedChapter[];
    insertionMode: DraftBatchInsertionMode;
    reorderedChapterIds: string[];
    writeback?: DraftWritebackRecord;
};

function commitError(code: string, message: string, details?: unknown): Error & { code: string; details?: unknown } {
    return Object.assign(new Error(message), { code, details });
}

function hashContent(content: string): string {
    return createHash('sha256').update(content || '', 'utf8').digest('hex');
}

function assertDraftAlignment(input: DraftBatchChapterCommitInput): void {
    const expectedIndexes = Array.from(
        { length: input.prefixLength - input.committedPrefixLength },
        (_, offset) => input.committedPrefixLength + offset,
    );
    if (
        expectedIndexes.length < 1
        || input.drafts.length !== expectedIndexes.length
        || input.drafts.some((draft, index) => draft.childIndex !== expectedIndexes[index])
    ) {
        throw commitError('INVALID_INPUT', 'Draft chapter writes do not match the requested prefix');
    }
}

export async function commitDraftBatchChapters(
    database: PrismaClientType,
    input: DraftBatchChapterCommitInput,
): Promise<DraftBatchChapterCommitResult> {
    assertDraftAlignment(input);
    const { batch } = input;

    return database.$transaction(async (tx) => {
        const volume = await tx.volume.findUnique({
            where: { id: batch.volumeId },
            select: { id: true, novelId: true },
        });
        if (!volume || volume.novelId !== batch.novelId) {
            throw commitError('NOT_FOUND', 'Draft batch volume does not belong to the expected novel');
        }

        const anchor = await tx.chapter.findUnique({
            where: { id: batch.anchorChapterId },
            select: { id: true, volumeId: true, order: true, deleted: true },
        });
        if (!anchor || anchor.deleted || anchor.volumeId !== batch.volumeId) {
            throw commitError('VERSION_CONFLICT', 'Draft batch anchor chapter changed or was removed');
        }

        const alreadyCommittedTargetIds = new Set(
            batch.children
                .slice(0, input.committedPrefixLength)
                .map((child) => child.targetChapterId)
                .filter((chapterId): chapterId is string => Boolean(chapterId)),
        );
        const snapshotsToValidate = batch.sourceSnapshot.filter(
            (snapshot) => !alreadyCommittedTargetIds.has(snapshot.chapterId),
        );
        if (snapshotsToValidate.length > 0) {
            const sourceRows = await tx.chapter.findMany({
                where: { id: { in: snapshotsToValidate.map((snapshot) => snapshot.chapterId) } },
                select: { id: true, version: true, content: true, deleted: true },
            });
            const sourceById = new Map(sourceRows.map((chapter) => [chapter.id, chapter]));
            const conflicts = snapshotsToValidate.flatMap((snapshot) => {
                const current = sourceById.get(snapshot.chapterId);
                if (
                    !current
                    || current.deleted
                    || current.version !== snapshot.version
                    || hashContent(current.content) !== snapshot.contentHash
                ) {
                    return [{
                        chapterId: snapshot.chapterId,
                        expectedVersion: snapshot.version,
                        actualVersion: current?.version,
                    }];
                }
                return [];
            });
            if (conflicts.length > 0) {
                throw commitError(
                    'VERSION_CONFLICT',
                    'One or more source chapters changed after draft generation',
                    { conflicts },
                );
            }
        }

        if (batch.mode === 'batch_rewrite') {
            const missingSnapshots = input.drafts
                .map((draft) => draft.targetChapterId)
                .filter((chapterId): chapterId is string => Boolean(chapterId))
                .filter((chapterId) => !batch.sourceSnapshot.some((snapshot) => snapshot.chapterId === chapterId));
            if (missingSnapshots.length > 0 || input.drafts.some((draft) => !draft.targetChapterId)) {
                throw commitError(
                    'INVALID_STATE',
                    'Rewrite targets require versioned source snapshots',
                    { chapterIds: missingSnapshots },
                );
            }

            const targetIds = input.drafts.map((draft) => draft.targetChapterId as string);
            const targetRows = await tx.chapter.findMany({
                where: { id: { in: targetIds } },
                select: { id: true, title: true, content: true, volumeId: true, order: true, wordCount: true, version: true, deleted: true },
            });
            const targetById = new Map(targetRows.map((chapter) => [chapter.id, chapter]));
            if (targetRows.length !== targetIds.length || targetRows.some((chapter) => chapter.deleted || chapter.volumeId !== batch.volumeId)) {
                throw commitError('VERSION_CONFLICT', 'One or more rewrite targets changed or were removed');
            }

            let wordCountDelta = 0;
            const chapters: DraftBatchCommittedChapter[] = [];
            const writebackChapters: DraftWritebackRecord['chapters'] = [];
            for (const draft of input.drafts) {
                const targetId = draft.targetChapterId as string;
                const current = targetById.get(targetId);
                if (!current) throw commitError('VERSION_CONFLICT', `Rewrite target ${targetId} is unavailable`);
                const updated = await tx.chapter.update({
                    where: { id: targetId },
                    data: {
                        content: draft.content,
                        wordCount: draft.wordCount,
                        version: { increment: 1 },
                        updatedAt: new Date(),
                    },
                });
                wordCountDelta += draft.wordCount - current.wordCount;
                writebackChapters.push({
                    childIndex: draft.childIndex,
                    chapterId: updated.id,
                    volumeId: updated.volumeId,
                    title: updated.title,
                    order: updated.order,
                    beforeContent: current.content,
                    beforeWordCount: current.wordCount,
                    beforeVersion: current.version,
                    afterContentHash: hashContent(updated.content),
                    afterVersion: updated.version,
                });
                chapters.push({
                    childIndex: draft.childIndex,
                    chapterId: updated.id,
                    volumeId: updated.volumeId,
                    title: updated.title,
                    order: updated.order,
                    version: updated.version,
                    content: updated.content,
                });
            }
            if (wordCountDelta !== 0) {
                await tx.novel.update({
                    where: { id: batch.novelId },
                    data: { wordCount: { increment: wordCountDelta }, updatedAt: new Date() },
                });
            }
            return {
                chapters,
                insertionMode: batch.insertionMode ?? input.insertionMode ?? 'after_anchor',
                reorderedChapterIds: [],
                writeback: {
                    writebackId: randomUUID(),
                    mode: 'batch_rewrite',
                    status: 'committed',
                    chapters: writebackChapters,
                    committedAt: new Date().toISOString(),
                },
            };
        }

        const volumeChapters = await tx.chapter.findMany({
            where: { volumeId: batch.volumeId, deleted: false },
            select: { id: true, order: true },
            orderBy: { order: 'asc' },
        });
        const maxOrder = volumeChapters.reduce((maximum, chapter) => Math.max(maximum, chapter.order), 0);
        if (input.committedPrefixLength === 0 && anchor.order < maxOrder && !input.insertionMode) {
            throw commitError(
                'INSERTION_MODE_REQUIRED',
                'The anchor is not the final chapter; choose after_anchor or volume_end before committing',
                { anchorChapterId: anchor.id, anchorOrder: anchor.order, finalOrder: maxOrder },
            );
        }

        let insertionMode: DraftBatchInsertionMode;
        let insertionOrder: number;
        if (input.committedPrefixLength > 0) {
            if (!batch.insertionMode) {
                throw commitError('INVALID_STATE', 'Partially committed batch has no fixed insertion mode');
            }
            if (input.insertionMode && input.insertionMode !== batch.insertionMode) {
                throw commitError('VERSION_CONFLICT', 'Insertion mode cannot change after the first prefix commit');
            }
            const previousChild = batch.children[input.committedPrefixLength - 1];
            const previousChapter = previousChild?.targetChapterId
                ? await tx.chapter.findUnique({
                    where: { id: previousChild.targetChapterId },
                    select: { id: true, volumeId: true, order: true, deleted: true },
                })
                : null;
            if (!previousChapter || previousChapter.deleted || previousChapter.volumeId !== batch.volumeId) {
                throw commitError('VERSION_CONFLICT', 'The previously committed prefix chapter changed or was removed');
            }
            insertionMode = batch.insertionMode;
            insertionOrder = previousChapter.order;
        } else {
            insertionMode = input.insertionMode ?? batch.insertionMode ?? 'volume_end';
            insertionOrder = insertionMode === 'after_anchor' ? anchor.order : maxOrder;
        }

        await tx.chapter.updateMany({
            where: { volumeId: batch.volumeId, deleted: false, order: { gt: insertionOrder } },
            data: { order: { increment: input.drafts.length }, version: { increment: 1 }, updatedAt: new Date() },
        });
        const reorderedChapterIds = volumeChapters
            .filter((chapter) => chapter.order > insertionOrder)
            .map((chapter) => chapter.id);

        const chapters: DraftBatchCommittedChapter[] = [];
        let addedWordCount = 0;
        for (const [offset, draft] of input.drafts.entries()) {
            const created = await tx.chapter.create({
                data: {
                    volumeId: batch.volumeId,
                    title: draft.title,
                    order: insertionOrder + offset + 1,
                    content: draft.content,
                    wordCount: draft.wordCount,
                },
            });
            addedWordCount += draft.wordCount;
            chapters.push({
                childIndex: draft.childIndex,
                chapterId: created.id,
                volumeId: created.volumeId,
                title: created.title,
                order: created.order,
                version: created.version,
                content: created.content,
            });
        }
        await tx.novel.update({
            where: { id: batch.novelId },
            data: { wordCount: { increment: addedWordCount }, updatedAt: new Date() },
        });
        await tx.volume.update({
            where: { id: batch.volumeId },
            data: { version: { increment: 1 }, updatedAt: new Date() },
        });
        return { chapters, insertionMode, reorderedChapterIds };
    });
}

export async function undoDraftBatchWriteback(
    database: PrismaClientType,
    batch: DraftBatchRecord,
    writeback: DraftWritebackRecord,
): Promise<DraftBatchCommittedChapter[]> {
    if (batch.mode !== 'batch_rewrite' || writeback.mode !== 'batch_rewrite' || writeback.status !== 'committed') {
        throw commitError('INVALID_STATE', 'Only an active batch rewrite can be undone');
    }
    if (writeback.chapters.length < 1 || writeback.chapters.some((chapter) => !Number.isInteger(chapter.childIndex))) {
        throw commitError('INVALID_STATE', 'The writeback record has no restorable chapters');
    }

    return database.$transaction(async (tx) => {
        const currentRows = await tx.chapter.findMany({
            where: { id: { in: writeback.chapters.map((chapter) => chapter.chapterId) } },
            select: { id: true, title: true, content: true, volumeId: true, order: true, wordCount: true, version: true, deleted: true },
        });
        const currentById = new Map(currentRows.map((chapter) => [chapter.id, chapter]));
        const conflicts = writeback.chapters.flatMap((snapshot) => {
            const current = currentById.get(snapshot.chapterId);
            if (
                !current
                || current.deleted
                || current.volumeId !== snapshot.volumeId
                || current.version !== snapshot.afterVersion
                || hashContent(current.content) !== snapshot.afterContentHash
            ) {
                return [{
                    chapterId: snapshot.chapterId,
                    expectedVersion: snapshot.afterVersion,
                    actualVersion: current?.version,
                }];
            }
            return [];
        });
        if (conflicts.length > 0) {
            throw commitError(
                'VERSION_CONFLICT',
                '正文已在写回后再次修改，无法安全撤销',
                { conflicts },
            );
        }

        let wordCountDelta = 0;
        const restored: DraftBatchCommittedChapter[] = [];
        for (const snapshot of writeback.chapters) {
            const current = currentById.get(snapshot.chapterId)!;
            const updated = await tx.chapter.update({
                where: { id: snapshot.chapterId },
                data: {
                    content: snapshot.beforeContent,
                    wordCount: snapshot.beforeWordCount,
                    version: { increment: 1 },
                    updatedAt: new Date(),
                },
            });
            wordCountDelta += snapshot.beforeWordCount - current.wordCount;
            restored.push({
                childIndex: snapshot.childIndex as number,
                chapterId: updated.id,
                volumeId: updated.volumeId,
                title: updated.title,
                order: updated.order,
                version: updated.version,
                content: updated.content,
            });
        }
        if (wordCountDelta !== 0) {
            await tx.novel.update({
                where: { id: batch.novelId },
                data: { wordCount: { increment: wordCountDelta }, updatedAt: new Date() },
            });
        }
        return restored;
    });
}
