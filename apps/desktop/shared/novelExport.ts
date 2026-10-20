export type NovelExportFormat = 'txt' | 'docx';
export type NovelExportSelection =
    | { mode: 'all' }
    | { mode: 'range'; start: number; end: number }
    | { mode: 'split'; chaptersPerFile: number };
export type NovelExportRequest = { requestId: string; novelId: string; format: NovelExportFormat; selection?: NovelExportSelection };
export type NovelExportPhase = 'saving' | 'snapshot' | 'generating' | 'writing';
export type NovelExportProgress = {
    requestId: string;
    phase: NovelExportPhase;
    completed?: number;
    total?: number;
    part?: number;
    parts?: number;
};
export type NovelExportSnapshot = {
    title: string;
    author: string;
    description: string;
    volumes: { id: string; title: string; chapters: { id: string; title: string; paragraphs: string[] }[] }[];
};
export type NovelExportResult =
    | { status: 'success'; requestId: string; path: string; title: string; chapters: number; volumes: number; empty: boolean; files: string[]; directory: boolean }
    | { status: 'cancelled'; requestId: string }
    | { status: 'failed'; requestId: string; code: string; message: string };
export interface NovelExportAPI {
    start(payload: NovelExportRequest): Promise<NovelExportResult>;
    describe(novelId: string): Promise<{ chapterCount: number }>;
    onProgress(callback: (progress: NovelExportProgress) => void): () => void;
    onFreeze(callback: (frozen: boolean) => void): () => void;
    onFlush(novelId: string, callback: (novelId: string) => Promise<void>): () => void;
    openDirectory(requestId: string): Promise<void>;
}
