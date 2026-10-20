import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrismaClientType } from '@novel-editor/core';
import { extractChapterParagraphs } from '../../shared/lexicalDocument';
import { formatNumber } from '../../src/utils/format';
import type { NovelExportFormat, NovelExportProgress, NovelExportRequest, NovelExportResult, NovelExportSnapshot } from '../../shared/novelExport';
import { planExportParts, validateExportSelection } from '../../shared/novelExportScope';
import type { ExporterSummary } from '../agent/DocumentExporterClient';

type Dependencies = {
    database: Pick<PrismaClientType, 'novel' | '$transaction'>;
    choosePath(name: string, format: NovelExportFormat): Promise<string | null>;
    chooseDirectory(): Promise<string | null>;
    confirmOverwrite(file: string): Promise<boolean>;
    flush(novelId: string): Promise<void>;
    freeze(value: boolean): void;
    read<T>(operation: () => Promise<T>): Promise<T>;
    datasetId(): string;
    generate(directory: string, format: NovelExportFormat, jobId: string, progress: (completed: number) => void): Promise<ExporterSummary>;
};
type SourceNovel = {
    title: string;
    formatting?: string | null;
    description?: string | null;
    volumes: { id: string; title: string; order: number; chapters: { id: string; title: string; order: number; content: string }[] }[];
};

export function exportFilename(title: string): string {
    let name = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '');
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return name || '未命名作品';
}

function heading(template: string, order: number, title: string): string {
    const prefix = formatNumber(template, order);
    if (!title) return prefix;
    if (title === prefix || title.startsWith(`${prefix} `)) return title;
    return `${prefix} ${title}`;
}

export function prepareExportSnapshot(novel: SourceNovel): NovelExportSnapshot {
    let formatting: Record<string, unknown> = {};
    try { const parsed = JSON.parse(novel.formatting || '{}'); if (parsed && typeof parsed === 'object') formatting = parsed; } catch { /* Legacy invalid settings use defaults. */ }
    const template = (key: string, fallback: string) => {
        const value = formatting[key];
        return typeof value === 'string' && value ? value : fallback;
    };
    return {
        title: novel.title,
        author: typeof formatting.author === 'string' ? formatting.author : '',
        description: novel.description || '',
        volumes: novel.volumes.map(volume => ({
            id: volume.id, title: heading(template('volume', '第 {n} 卷'), volume.order, volume.title),
            chapters: volume.chapters.map(chapter => {
                try {
                    return { id: chapter.id, title: heading(template('chapter', '第 {n} 章'), chapter.order, chapter.title), paragraphs: extractChapterParagraphs(chapter.content) };
                } catch (error) {
                    throw new Error(`${volume.title || `第 ${volume.order} 卷`} / ${chapter.title || `第 ${chapter.order} 章`}：${(error as Error).message}`);
                }
            }),
        })),
    };
}

async function fingerprint(file: string): Promise<string | null> {
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) throw new Error('所选目标不是普通文件。');
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

export class NovelExportService {
    private busy = false;
    private completed = new Map<string, { path: string; directory: boolean }>();
    constructor(private deps: Dependencies) {}
    completedTarget(requestId: string): { path: string; directory: boolean } | undefined { return this.completed.get(requestId); }

    async describe(novelId: string): Promise<{ chapterCount: number }> {
        const novel = await this.deps.read(() => this.deps.database.novel.findFirst({
            where: { id: novelId, deleted: false },
            select: { volumes: { where: { deleted: false }, select: { _count: { select: { chapters: { where: { deleted: false } } } } } } },
        }));
        if (!novel) throw new Error('作品不存在或已删除。');
        return { chapterCount: novel.volumes.reduce((sum, volume) => sum + volume._count.chapters, 0) };
    }

    async start(payload: NovelExportRequest, progress: (event: NovelExportProgress) => void): Promise<NovelExportResult> {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
        const fail = (code: string, message: string): NovelExportResult => ({ status: 'failed', requestId, code, message });
        if (!requestId || requestId.length > 100 || !payload?.novelId || !['txt', 'docx'].includes(payload.format)) return fail('INVALID_REQUEST', '导出请求无效。');
        const selection = payload.selection ?? { mode: 'all' };
        try { validateExportSelection(selection); } catch (error) { return fail('INVALID_RANGE', (error as Error).message); }
        if (this.busy) return fail('BUSY', '已有导出任务正在进行，请稍候。');
        this.busy = true;
        let directory: string | undefined;
        let frozen = false;
        let phase: NovelExportProgress['phase'] = 'saving';
        const update = (value: NovelExportProgress['phase'], counts?: Pick<NovelExportProgress, 'completed' | 'total' | 'part' | 'parts'>) => {
            phase = value; progress({ requestId, phase, ...counts });
        };
        try {
            const dataset = this.deps.datasetId();
            const novel = await this.deps.read(() => this.deps.database.novel.findFirst({ where: { id: payload.novelId, deleted: false }, select: { title: true } }));
            if (!novel) return fail('NOT_FOUND', '作品不存在或已删除。');
            const batch = selection.mode === 'split';
            const suffix = selection.mode === 'range' ? `_第${selection.start}-${selection.end}章` : '';
            const chosen = batch ? await this.deps.chooseDirectory()
                : await this.deps.choosePath(`${exportFilename(novel.title)}${suffix}.${payload.format}`, payload.format);
            if (!chosen) return { status: 'cancelled', requestId };
            const extension = `.${payload.format}`;
            // Each batch is committed as a new folder, so failure cannot leave partial books or overwrite another export.
            const target = batch ? path.join(chosen, `${exportFilename(novel.title)}_分批_${randomUUID().slice(0, 8)}`)
                : path.extname(chosen).toLowerCase() === extension ? chosen
                    : path.join(path.dirname(chosen), `${path.basename(chosen, path.extname(chosen))}${extension}`);
            const original = batch ? null : await fingerprint(target);
            if (!batch && target !== chosen && original !== null && !await this.deps.confirmOverwrite(target)) return { status: 'cancelled', requestId };
            this.deps.freeze(true); frozen = true;
            update('saving');
            await this.deps.flush(payload.novelId);
            if (dataset !== this.deps.datasetId()) throw new Error('作品资料已切换，请重新导出。');
            update('snapshot');
            const record = await this.deps.read(() => this.deps.database.$transaction(tx => tx.novel.findFirst({
                where: { id: payload.novelId, deleted: false },
                include: { volumes: {
                    where: { deleted: false }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
                    include: { chapters: { where: { deleted: false }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] } },
                } },
            })));
            if (!record) return fail('NOT_FOUND', '作品不存在或已删除。');
            const parts = planExportParts(record, selection);
            this.deps.freeze(false); frozen = false;
            const total = parts.reduce((sum, part) => sum + part.source.volumes.reduce((n, volume) => n + volume.chapters.length, 0), 0);
            update('generating', { completed: 0, total });
            directory = await fs.mkdtemp(path.join(path.dirname(target), '.novel-export-'));
            const staged = path.join(directory, 'files');
            await fs.mkdir(staged);
            const names: string[] = [];
            const volumes = new Set<string>();
            let processed = 0;
            let empty = true;
            for (const [index, part] of parts.entries()) {
                // Only the current part is converted and sent to a fresh Python worker.
                const snapshot = prepareExportSnapshot(part.source);
                const partTotal = snapshot.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0);
                update('generating', { completed: processed, total, part: index + 1, parts: parts.length });
                await fs.writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(snapshot), 'utf8');
                const summary = await this.deps.generate(directory, payload.format, `${requestId}:${index}`, completed => {
                    if (completed > partTotal) throw new Error('导出进度超出章节数量。');
                    update('generating', { completed: processed + completed, total, part: index + 1, parts: parts.length });
                });
                if (summary.chapters !== partTotal || summary.volumes !== snapshot.volumes.length) throw new Error('生成结果与作品快照不一致。');
                const output = path.join(directory, `output.${payload.format}`);
                const stat = await fs.stat(output);
                if (!stat.isFile() || stat.size === 0) throw new Error('未生成有效的导出文件。');
                const handle = await fs.open(output, 'r+');
                try { await handle.sync(); } finally { await handle.close(); }
                const width = String(total).length;
                const name = batch ? `${exportFilename(record.title)}_第${String(part.start).padStart(width, '0')}-${String(part.end).padStart(width, '0')}章${extension}` : `output${extension}`;
                await fs.rename(output, path.join(staged, name));
                names.push(name);
                processed += partTotal;
                empty &&= summary.empty;
                for (const volume of snapshot.volumes) volumes.add(volume.id);
            }
            update('writing');
            await this.deps.read(async () => {
                if (dataset !== this.deps.datasetId()) throw new Error('作品资料已切换，请重新导出。');
                if (await fingerprint(target) !== original) throw new Error('目标文件在导出期间发生变化，请重新选择保存位置。');
                await fs.rename(batch ? staged : path.join(staged, names[0]), target);
            });
            this.completed.set(requestId, { path: target, directory: batch });
            if (this.completed.size > 20) this.completed.delete(this.completed.keys().next().value!);
            return { status: 'success', requestId, path: target, title: record.title, chapters: processed, volumes: volumes.size, empty,
                directory: batch, files: batch ? names.map(name => path.join(target, name)) : [target] };
        } catch (error) {
            const detail = (error as Error).message || '请重试。';
            const stage = { saving: '保存编辑内容失败，未生成导出文件', snapshot: '读取或转换作品失败', generating: '生成文件失败', writing: '写入文件失败' }[phase];
            return fail(`EXPORT_${phase.toUpperCase()}_FAILED`, `${stage}：${detail}`);
        } finally {
            if (frozen) this.deps.freeze(false);
            if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
            this.busy = false;
        }
    }
}
