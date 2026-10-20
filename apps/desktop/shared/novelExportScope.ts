import type { NovelExportSelection } from './novelExport';

type ChapterTree = { volumes: { chapters: unknown[] }[] };
export type ExportPart<T> = { source: T; start: number; end: number };

export function validateExportSelection(selection: NovelExportSelection): void {
    if (!selection || !['all', 'range', 'split'].includes(selection.mode)) throw new Error('导出范围无效。');
    if (selection.mode === 'range' && (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)
        || selection.start < 1 || selection.end < selection.start)) throw new Error('请输入有效的起止章节序号。');
    if (selection.mode === 'split' && (!Number.isSafeInteger(selection.chaptersPerFile) || selection.chaptersPerFile < 1)) {
        throw new Error('每份章节数必须是正整数。');
    }
}

/** Positions are one-based in directory order across volumes, independent of displayed chapter labels. */
export function planExportParts<T extends ChapterTree>(source: T, selection: NovelExportSelection = { mode: 'all' }): ExportPart<T>[] {
    validateExportSelection(selection);
    const total = source.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0);
    if (selection.mode === 'all') return [{ source, start: total ? 1 : 0, end: total }];
    if (!total) throw new Error('作品没有章节，请选择整本单文件导出。');
    if (selection.mode === 'range' && selection.end > total) throw new Error(`作品当前只有 ${total} 章，请调整结束序号。`);
    const select = (start: number, end: number): ExportPart<T> => {
        let position = 0;
        const volumes = source.volumes.flatMap(volume => {
            const offset = position;
            position += volume.chapters.length;
            const chapters = volume.chapters.slice(Math.max(0, start - offset - 1), Math.max(0, end - offset));
            return chapters.length ? [{ ...volume, chapters }] : [];
        });
        return { source: { ...source, volumes }, start, end };
    };
    if (selection.mode === 'range') return [select(selection.start, selection.end)];
    const parts: ExportPart<T>[] = [];
    for (let start = 1; start <= total; start += selection.chaptersPerFile) {
        parts.push(select(start, Math.min(total, start + selection.chaptersPerFile - 1)));
    }
    return parts;
}
