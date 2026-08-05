import type { DraftBatchRecord } from './draftBatch';

export type DraftBatchChapterCatalog = ReadonlyArray<{
    id: string;
    order: number;
    chapters: ReadonlyArray<{
        id: string;
        order: number;
    }>;
}>;

export type DraftBatchChapterDisplay = {
    shortLabel: string;
    fullLabel: string;
    source: 'catalog' | 'batch';
};

function positiveOrder(value: number): number | null {
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A draft-batch child index is an execution position, not necessarily a catalog
 * chapter number. Prefer the authoritative targetChapterId -> catalog mapping;
 * make any fallback explicitly batch-relative so it cannot be mistaken for a
 * persisted chapter identity.
 */
export function resolveDraftBatchChapterDisplay(
    batch: Pick<DraftBatchRecord, 'mode' | 'children'>,
    childIndex: number,
    volumes: DraftBatchChapterCatalog,
): DraftBatchChapterDisplay {
    const batchPosition = Math.max(0, childIndex) + 1;
    const child = batch.children.find((candidate) => candidate.childIndex === childIndex);
    const targetChapterId = child?.targetChapterId;

    if (targetChapterId) {
        for (const volume of volumes) {
            const chapter = volume.chapters.find((candidate) => candidate.id === targetChapterId);
            const chapterOrder = chapter ? positiveOrder(chapter.order) : null;
            if (!chapter || chapterOrder === null) continue;
            const shortLabel = `第 ${chapterOrder} 章`;
            const volumeOrder = positiveOrder(volume.order);
            return {
                shortLabel,
                fullLabel: volumeOrder === null ? shortLabel : `第 ${volumeOrder} 卷 · ${shortLabel}`,
                source: 'catalog',
            };
        }
    }

    if (batch.mode === 'sequence_continuation') {
        const shortLabel = `新增第 ${batchPosition} 章`;
        return {
            shortLabel,
            fullLabel: `批次${shortLabel}`,
            source: 'batch',
        };
    }

    const shortLabel = `批次第 ${batchPosition} 项`;
    return {
        shortLabel,
        fullLabel: shortLabel,
        source: 'batch',
    };
}
