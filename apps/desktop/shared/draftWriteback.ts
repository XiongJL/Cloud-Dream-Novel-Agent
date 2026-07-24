export type DraftWritebackMode = 'single_chapter' | 'batch_rewrite' | 'creative_assets';

export type CreativeAssetWritebackEntityKind =
    | 'plotLine'
    | 'plotPoint'
    | 'character'
    | 'item'
    | 'mapCanvas';

export interface CreativeAssetWritebackEntitySnapshot {
    kind: CreativeAssetWritebackEntityKind;
    entityId: string;
    afterHash: string;
    backgroundPath?: string;
}

export interface CreativeAssetsWritebackSnapshot {
    entities: CreativeAssetWritebackEntitySnapshot[];
    created: Record<string, number>;
}

export interface DraftWritebackChapterSnapshot {
    childIndex?: number;
    chapterId: string;
    volumeId: string;
    title: string;
    order: number;
    beforeContent: string;
    beforeWordCount: number;
    beforeVersion: number;
    afterContentHash: string;
    afterVersion: number;
}

export interface DraftWritebackRecord {
    writebackId: string;
    mode: DraftWritebackMode;
    status: 'committed' | 'undone';
    chapters: DraftWritebackChapterSnapshot[];
    creativeAssets?: CreativeAssetsWritebackSnapshot;
    committedAt: string;
    undoneAt?: string;
}
