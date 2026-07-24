import { createHash } from 'node:crypto';
import { db } from '@novel-editor/core';
import type { RagEvidenceItem, RagEvidenceSourceType } from './types';
import type { AiEmbeddingSettings } from '../types';
import { EmbeddingClient } from './embeddingClient';

const VECTOR_DIM = 384;
const MAX_CHUNK_CHARS = 900;
const CHUNK_OVERLAP_CHARS = 120;
const MIN_SIMILARITY = 0.08;

export type VectorChunkInput = {
    novelId: string;
    sourceType: RagEvidenceSourceType;
    sourceId: string;
    title: string;
    content: string;
};

type StoredVectorChunk = {
    id: string;
    novel_id: string;
    source_type: string;
    source_id: string;
    title: string;
    content: string;
    embedding_json?: string | null;
    embedding_blob?: Buffer | Uint8Array | null;
    embedding_dim?: number | null;
};

type RagVectorIndexResult = {
    chunks: number;
    sources: number;
    provider: string;
    model: string;
    dimensions: number;
    fallbackUsed: boolean;
    fallbackError?: string;
};

function hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

function extractPlainTextFromLexical(content: string): string {
    if (!content?.trim()) return '';
    try {
        const parsed = JSON.parse(content);
        const texts: string[] = [];
        const walk = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (typeof node.text === 'string') texts.push(node.text);
            if (Array.isArray(node.children)) node.children.forEach(walk);
        };
        walk(parsed?.root || parsed);
        return texts.join(' ').replace(/\s+/g, ' ').trim();
    } catch {
        return content.replace(/\s+/g, ' ').trim();
    }
}

function parseJsonArray(value: unknown): string[] {
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

function parseProfile(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim() === '{}') return '';
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') return '';
        return Object.entries(parsed)
            .map(([key, val]) => `${key}: ${String(val || '')}`)
            .filter((line) => !line.endsWith(': '))
            .join('; ');
    } catch {
        return value;
    }
}

function tokenize(text: string): string[] {
    const normalized = text.toLowerCase();
    const latin = Array.from(normalized.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)).map((match) => match[0]);
    const cjkRuns = Array.from(normalized.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)).map((match) => match[0]);
    const cjkTokens: string[] = [];
    for (const run of cjkRuns) {
        if (run.length === 1) {
            cjkTokens.push(run);
            continue;
        }
        for (let i = 0; i < run.length - 1; i += 1) {
            cjkTokens.push(run.slice(i, i + 2));
        }
        if (run.length <= 4) cjkTokens.push(run);
    }
    return [...latin, ...cjkTokens].filter(Boolean);
}

function hashToken(token: string): { index: number; sign: number } {
    const digest = createHash('sha1').update(token).digest();
    const value = digest.readUInt32BE(0);
    return {
        index: value % VECTOR_DIM,
        sign: (digest[4] & 1) === 1 ? 1 : -1,
    };
}

function embedText(text: string): number[] {
    const vector = new Array<number>(VECTOR_DIM).fill(0);
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) {
        counts.set(token, (counts.get(token) || 0) + 1);
    }
    for (const [token, count] of counts) {
        const { index, sign } = hashToken(token);
        vector[index] += sign * Math.log1p(count);
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm <= 0) return vector;
    return vector.map((value) => Number((value / norm).toFixed(6)));
}

function vectorToBlob(vector: number[]): Buffer {
    const buffer = Buffer.alloc(vector.length * 4);
    for (let i = 0; i < vector.length; i += 1) {
        buffer.writeFloatLE(Number.isFinite(vector[i]) ? vector[i] : 0, i * 4);
    }
    return buffer;
}

function blobToVector(blob: Buffer | Uint8Array | null | undefined, dim?: number | null): number[] {
    if (!blob) return [];
    const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    const count = Math.floor(buffer.length / 4);
    const limit = dim && dim > 0 ? Math.min(dim, count) : count;
    const vector: number[] = [];
    for (let i = 0; i < limit; i += 1) {
        vector.push(buffer.readFloatLE(i * 4));
    }
    return vector;
}

function cosine(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += a[i] * b[i];
    return sum;
}

function lexicalScore(query: string, text: string): number {
    const queryTokens = Array.from(new Set(tokenize(query)));
    if (queryTokens.length === 0) return 0;
    const haystack = text.toLowerCase();
    let hits = 0;
    for (const token of queryTokens) {
        if (haystack.includes(token)) hits += 1;
    }
    return hits / queryTokens.length;
}

function chunkText(text: string): string[] {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    if (normalized.length <= MAX_CHUNK_CHARS) return [normalized];
    const chunks: string[] = [];
    let start = 0;
    while (start < normalized.length) {
        const end = Math.min(normalized.length, start + MAX_CHUNK_CHARS);
        chunks.push(normalized.slice(start, end));
        if (end >= normalized.length) break;
        start = Math.max(0, end - CHUNK_OVERLAP_CHARS);
    }
    return chunks;
}

export async function ensureRagVectorIndex(): Promise<void> {
    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS rag_vector_chunks (
            id TEXT PRIMARY KEY,
            novel_id TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            embedding_json TEXT NOT NULL,
            embedding_blob BLOB,
            embedding_dim INTEGER,
            embedding_provider TEXT NOT NULL DEFAULT 'hash',
            embedding_model TEXT NOT NULL DEFAULT 'local-hash-v1',
            content_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);
    const columns = await db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(rag_vector_chunks);');
    const columnNames = new Set(columns.map((column) => column.name));
    const migrations = [
        ['embedding_blob', 'ALTER TABLE rag_vector_chunks ADD COLUMN embedding_blob BLOB;'],
        ['embedding_dim', 'ALTER TABLE rag_vector_chunks ADD COLUMN embedding_dim INTEGER;'],
        ['embedding_provider', "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_provider TEXT NOT NULL DEFAULT 'hash';"],
        ['embedding_model', "ALTER TABLE rag_vector_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'local-hash-v1';"],
    ] as const;
    for (const [name, sql] of migrations) {
        if (!columnNames.has(name)) {
            await db.$executeRawUnsafe(sql);
        }
    }
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_novel ON rag_vector_chunks(novel_id);');
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_rag_vector_chunks_source ON rag_vector_chunks(source_type, source_id);');
}

export async function getRagVectorChunkCount(novelId: string): Promise<number> {
    await ensureRagVectorIndex();
    const existing = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM rag_vector_chunks WHERE novel_id = ${novelId};
    `;
    return Number(existing[0]?.count || 0);
}

async function buildVectorDocuments(novelId: string): Promise<VectorChunkInput[]> {
    const [characters, items, worldSettings, plotLines, chapters, chapterSummaries, narrativeSummaries] = await Promise.all([
        (db as any).character.findMany({
            where: { novelId },
            include: { items: { include: { item: true } } },
            orderBy: { sortOrder: 'asc' },
        }),
        (db as any).item.findMany({ where: { novelId }, orderBy: { sortOrder: 'asc' } }),
        (db as any).worldSetting.findMany({ where: { novelId }, orderBy: { sortOrder: 'asc' } }),
        (db as any).plotLine.findMany({
            where: { novelId },
            include: { points: { orderBy: { order: 'asc' } } },
            orderBy: { sortOrder: 'asc' },
        }),
        db.chapter.findMany({
            where: { volume: { novelId } },
            select: { id: true, title: true, content: true, order: true, volume: { select: { title: true, order: true } } },
            orderBy: [{ volume: { order: 'asc' } }, { order: 'asc' }],
        }),
        (db as any).chapterSummary.findMany({
            where: { novelId, isLatest: true, status: 'active' },
            orderBy: { updatedAt: 'desc' },
        }),
        (db as any).narrativeSummary.findMany({
            where: { novelId, isLatest: true, status: 'active' },
            orderBy: { updatedAt: 'desc' },
        }),
    ]);

    const docs: VectorChunkInput[] = [];
    for (const character of characters) {
        const profile = parseProfile(character.profile);
        const ownedItems = Array.isArray(character.items)
            ? character.items.map((owner: any) => `${owner.item?.name || ''}${owner.note ? ` ${owner.note}` : ''}`).filter(Boolean).join('; ')
            : '';
        docs.push({
            novelId,
            sourceType: 'character',
            sourceId: character.id,
            title: `Character: ${character.name}`,
            content: [
                character.name,
                character.role,
                character.description,
                profile,
                ownedItems ? `Owned items: ${ownedItems}` : '',
                character.isStarred ? 'starred important' : '',
            ].filter(Boolean).join('\n'),
        });
    }

    for (const item of items) {
        docs.push({
            novelId,
            sourceType: 'item',
            sourceId: item.id,
            title: `${item.type || 'Item'}: ${item.name}`,
            content: [item.name, item.type, item.description, parseProfile(item.profile)].filter(Boolean).join('\n'),
        });
    }

    for (const world of worldSettings) {
        docs.push({
            novelId,
            sourceType: 'worldSetting',
            sourceId: world.id,
            title: `World: ${world.name}`,
            content: [world.name, world.type, world.content].filter(Boolean).join('\n'),
        });
    }

    for (const line of plotLines) {
        docs.push({
            novelId,
            sourceType: 'plotLine',
            sourceId: line.id,
            title: `Plot line: ${line.name}`,
            content: [line.name, line.description].filter(Boolean).join('\n'),
        });
        for (const point of line.points || []) {
            docs.push({
                novelId,
                sourceType: 'plotPoint',
                sourceId: point.id,
                title: `Plot point: ${point.title}`,
                content: [line.name, point.title, point.type, point.status, point.description].filter(Boolean).join('\n'),
            });
        }
    }

    for (const chapter of chapters) {
        const plain = extractPlainTextFromLexical(chapter.content || '');
        if (!plain) continue;
        docs.push({
            novelId,
            sourceType: 'chapter',
            sourceId: chapter.id,
            title: `${chapter.volume?.title || ''} ${chapter.title || ''}`.trim() || 'Chapter',
            content: plain,
        });
    }

    for (const summary of chapterSummaries) {
        docs.push({
            novelId,
            sourceType: 'chapterSummary',
            sourceId: summary.id,
            title: `Chapter summary: ${summary.chapterId}`,
            content: [
                summary.compressedMemory || summary.summaryText,
                ...parseJsonArray(summary.keyFacts),
                ...parseJsonArray(summary.timelineHints),
                ...parseJsonArray(summary.openQuestions),
            ].filter(Boolean).join('\n'),
        });
    }

    for (const summary of narrativeSummaries) {
        docs.push({
            novelId,
            sourceType: 'narrativeSummary',
            sourceId: summary.id,
            title: `${summary.level || 'novel'} summary: ${summary.title || 'latest'}`,
            content: [
                summary.summaryText,
                ...parseJsonArray(summary.keyFacts),
                ...parseJsonArray(summary.unresolvedThreads),
                ...parseJsonArray(summary.hardConstraints),
            ].filter(Boolean).join('\n'),
        });
    }

    return docs;
}

async function buildChapterVectorDocument(chapterId: string): Promise<VectorChunkInput | null> {
    const chapter = await db.chapter.findUnique({
        where: { id: chapterId },
        select: {
            id: true,
            title: true,
            content: true,
            volume: { select: { novelId: true, title: true } },
        },
    });
    if (!chapter?.volume) return null;
    const plain = extractPlainTextFromLexical(chapter.content || '');
    if (!plain) {
        return {
            novelId: chapter.volume.novelId,
            sourceType: 'chapter',
            sourceId: chapter.id,
            title: `${chapter.volume.title || ''} ${chapter.title || ''}`.trim() || 'Chapter',
            content: '',
        };
    }
    return {
        novelId: chapter.volume.novelId,
        sourceType: 'chapter',
        sourceId: chapter.id,
        title: `${chapter.volume.title || ''} ${chapter.title || ''}`.trim() || 'Chapter',
        content: plain,
    };
}

export async function buildVectorDocumentForSource(sourceType: RagEvidenceSourceType, sourceId: string): Promise<VectorChunkInput | null> {
    switch (sourceType) {
        case 'chapter':
            return buildChapterVectorDocument(sourceId);
        case 'character': {
            const character = await (db as any).character.findUnique({
                where: { id: sourceId },
                include: { items: { include: { item: true } } },
            });
            if (!character) return null;
            const profile = parseProfile(character.profile);
            const ownedItems = Array.isArray(character.items)
                ? character.items.map((owner: any) => `${owner.item?.name || ''}${owner.note ? ` ${owner.note}` : ''}`).filter(Boolean).join('; ')
                : '';
            return {
                novelId: character.novelId,
                sourceType: 'character',
                sourceId: character.id,
                title: `Character: ${character.name}`,
                content: [
                    character.name,
                    character.role,
                    character.description,
                    profile,
                    ownedItems ? `Owned items: ${ownedItems}` : '',
                    character.isStarred ? 'starred important' : '',
                ].filter(Boolean).join('\n'),
            };
        }
        case 'item': {
            const item = await (db as any).item.findUnique({ where: { id: sourceId } });
            if (!item) return null;
            return {
                novelId: item.novelId,
                sourceType: 'item',
                sourceId: item.id,
                title: `${item.type || 'Item'}: ${item.name}`,
                content: [item.name, item.type, item.description, parseProfile(item.profile)].filter(Boolean).join('\n'),
            };
        }
        case 'worldSetting': {
            const world = await (db as any).worldSetting.findUnique({ where: { id: sourceId } });
            if (!world) return null;
            return {
                novelId: world.novelId,
                sourceType: 'worldSetting',
                sourceId: world.id,
                title: `World: ${world.name}`,
                content: [world.name, world.type, world.content].filter(Boolean).join('\n'),
            };
        }
        case 'plotLine': {
            const line = await (db as any).plotLine.findUnique({ where: { id: sourceId } });
            if (!line) return null;
            return {
                novelId: line.novelId,
                sourceType: 'plotLine',
                sourceId: line.id,
                title: `Plot line: ${line.name}`,
                content: [line.name, line.description].filter(Boolean).join('\n'),
            };
        }
        case 'plotPoint': {
            const point = await (db as any).plotPoint.findUnique({
                where: { id: sourceId },
                include: { plotLine: { select: { name: true } } },
            });
            if (!point) return null;
            return {
                novelId: point.novelId,
                sourceType: 'plotPoint',
                sourceId: point.id,
                title: `Plot point: ${point.title}`,
                content: [point.plotLine?.name, point.title, point.type, point.status, point.description].filter(Boolean).join('\n'),
            };
        }
        case 'chapterSummary': {
            const summary = await (db as any).chapterSummary.findUnique({ where: { id: sourceId } });
            if (!summary || summary.status !== 'active') return null;
            return {
                novelId: summary.novelId,
                sourceType: 'chapterSummary',
                sourceId: summary.id,
                title: `Chapter summary: ${summary.chapterId}`,
                content: [
                    summary.compressedMemory || summary.summaryText,
                    ...parseJsonArray(summary.keyFacts),
                    ...parseJsonArray(summary.timelineHints),
                    ...parseJsonArray(summary.openQuestions),
                ].filter(Boolean).join('\n'),
            };
        }
        case 'narrativeSummary': {
            const summary = await (db as any).narrativeSummary.findUnique({ where: { id: sourceId } });
            if (!summary || summary.status !== 'active') return null;
            return {
                novelId: summary.novelId,
                sourceType: 'narrativeSummary',
                sourceId: summary.id,
                title: `${summary.level || 'novel'} summary: ${summary.title || 'latest'}`,
                content: [
                    summary.summaryText,
                    ...parseJsonArray(summary.keyFacts),
                    ...parseJsonArray(summary.unresolvedThreads),
                    ...parseJsonArray(summary.hardConstraints),
                ].filter(Boolean).join('\n'),
            };
        }
        default:
            return null;
    }
}

async function embedChunks(input: {
    texts: string[];
    settings?: AiEmbeddingSettings;
}): Promise<{ vectors: number[][]; provider: string; model: string; dimensions: number; fallbackUsed: boolean; fallbackError?: string }> {
    const settings = input.settings;
    if (settings?.enabled && settings.baseUrl.trim()) {
        try {
            const client = new EmbeddingClient(settings);
            const batchSize = Math.max(1, Math.min(64, settings.batchSize || 8));
            const vectors: number[][] = [];
            let model = settings.model;
            let dimensions = settings.dimensions || 0;
            for (let start = 0; start < input.texts.length; start += batchSize) {
                const batch = input.texts.slice(start, start + batchSize);
                const result = await client.embed(batch);
                vectors.push(...result.embeddings);
                model = result.model;
                dimensions = result.dimensions;
            }
            return { vectors, provider: 'openai-compatible', model, dimensions, fallbackUsed: false };
        } catch (error) {
            if (!settings.fallbackToHash) throw error;
            console.warn('[RAG] Embedding API failed; falling back to local hash vectors:', error);
            const fallbackError = error instanceof Error ? error.message : String(error);
            const vectors = input.texts.map((text) => embedText(text));
            return { vectors, provider: 'hash', model: 'local-hash-v1', dimensions: VECTOR_DIM, fallbackUsed: true, fallbackError };
        }
    }
    const vectors = input.texts.map((text) => embedText(text));
    return { vectors, provider: 'hash', model: 'local-hash-v1', dimensions: VECTOR_DIM, fallbackUsed: Boolean(settings?.enabled) };
}

async function writeVectorDocuments(docs: VectorChunkInput[], settings?: AiEmbeddingSettings): Promise<RagVectorIndexResult> {
    const chunkRows: Array<{ doc: VectorChunkInput; index: number; content: string }> = [];
    for (const doc of docs) {
        const parts = chunkText(doc.content);
        for (let index = 0; index < parts.length; index += 1) {
            chunkRows.push({ doc, index, content: parts[index] });
        }
    }
    const embedded = await embedChunks({
        texts: chunkRows.map((row) => `${row.doc.title}\n${row.content}`),
        settings,
    });

    const now = new Date().toISOString();
    for (let rowIndex = 0; rowIndex < chunkRows.length; rowIndex += 1) {
        const row = chunkRows[rowIndex];
        const vector = embedded.vectors[rowIndex] || embedText(`${row.doc.title}\n${row.content}`);
        const contentHash = hashText(`${row.doc.sourceType}:${row.doc.sourceId}:${row.index}:${row.content}`);
        const id = hashText(`${row.doc.novelId}:${row.doc.sourceType}:${row.doc.sourceId}:${row.index}`);
        const embeddingJson = embedded.provider === 'hash' ? JSON.stringify(vector) : '[]';
        const embeddingBlob = vectorToBlob(vector);
        const dim = vector.length;
        await db.$executeRaw`
            INSERT INTO rag_vector_chunks (id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim, embedding_provider, embedding_model, content_hash, updated_at)
            VALUES (${id}, ${row.doc.novelId}, ${row.doc.sourceType}, ${row.doc.sourceId}, ${row.doc.title}, ${row.content}, ${embeddingJson}, ${embeddingBlob}, ${dim}, ${embedded.provider}, ${embedded.model}, ${contentHash}, ${now});
        `;
    }

    return { chunks: chunkRows.length, sources: docs.length, provider: embedded.provider, model: embedded.model, dimensions: embedded.dimensions, fallbackUsed: embedded.fallbackUsed, fallbackError: embedded.fallbackError };
}

export async function rebuildRagVectorIndex(novelId: string, settings?: AiEmbeddingSettings): Promise<RagVectorIndexResult> {
    await ensureRagVectorIndex();
    const docs = await buildVectorDocuments(novelId);
    await db.$executeRaw`DELETE FROM rag_vector_chunks WHERE novel_id = ${novelId};`;
    return writeVectorDocuments(docs, settings);
}

export async function deleteRagVectorSource(input: {
    novelId?: string;
    sourceType: RagEvidenceSourceType;
    sourceId: string;
}): Promise<{ deleted: number }> {
    await ensureRagVectorIndex();
    if (input.novelId) {
        const result = await db.$executeRaw`
            DELETE FROM rag_vector_chunks
            WHERE novel_id = ${input.novelId}
              AND source_type = ${input.sourceType}
              AND source_id = ${input.sourceId};
        `;
        return { deleted: Number(result || 0) };
    }
    const result = await db.$executeRaw`
        DELETE FROM rag_vector_chunks
        WHERE source_type = ${input.sourceType}
          AND source_id = ${input.sourceId};
    `;
    return { deleted: Number(result || 0) };
}

export async function upsertRagVectorSource(doc: VectorChunkInput, settings?: AiEmbeddingSettings): Promise<RagVectorIndexResult> {
    await ensureRagVectorIndex();
    await deleteRagVectorSource({
        novelId: doc.novelId,
        sourceType: doc.sourceType,
        sourceId: doc.sourceId,
    });
    if (!doc.content.trim()) {
        return {
            chunks: 0,
            sources: 1,
            provider: 'none',
            model: 'empty-source',
            dimensions: 0,
            fallbackUsed: false,
        };
    }
    return writeVectorDocuments([doc], settings);
}

export async function upsertRagSourceIndex(sourceType: RagEvidenceSourceType, sourceId: string, settings?: AiEmbeddingSettings): Promise<RagVectorIndexResult & { novelId?: string; sourceType: RagEvidenceSourceType; sourceId: string }> {
    const doc = await buildVectorDocumentForSource(sourceType, sourceId);
    if (!doc) {
        return {
            chunks: 0,
            sources: 0,
            provider: 'none',
            model: 'missing-source',
            dimensions: 0,
            fallbackUsed: false,
            sourceType,
            sourceId,
        };
    }
    const result = await upsertRagVectorSource(doc, settings);
    return { ...result, novelId: doc.novelId, sourceType: doc.sourceType, sourceId: doc.sourceId };
}

export async function upsertRagChapterIndex(chapterId: string, settings?: AiEmbeddingSettings): Promise<RagVectorIndexResult & { novelId?: string; sourceId: string }> {
    const result = await upsertRagSourceIndex('chapter', chapterId, settings);
    return { ...result, sourceId: result.sourceId };
}

export async function ensureRagVectorIndexForNovel(novelId: string, settings?: AiEmbeddingSettings): Promise<{ rebuilt: boolean; chunks: number; sources?: number }> {
    const count = await getRagVectorChunkCount(novelId);
    if (count > 0) return { rebuilt: false, chunks: count };
    const result = await rebuildRagVectorIndex(novelId, settings);
    return { rebuilt: true, chunks: result.chunks, sources: result.sources };
}

export async function queryRagVectorIndex(input: {
    novelId: string;
    query: string;
    limit?: number;
    settings?: AiEmbeddingSettings;
}): Promise<RagEvidenceItem[]> {
    await ensureRagVectorIndex();
    const rows = await db.$queryRaw<StoredVectorChunk[]>`
        SELECT id, novel_id, source_type, source_id, title, content, embedding_json, embedding_blob, embedding_dim
        FROM rag_vector_chunks
        WHERE novel_id = ${input.novelId};
    `;
    if (rows.length === 0) return [];

    const queryVector = embedText(input.query);
    const firstDim = rows.find((row) => Number(row.embedding_dim || 0) > 0)?.embedding_dim || 0;
    const canUseLocalVector = firstDim === 0 || firstDim === VECTOR_DIM;

    return rows
        .map((row) => {
            let similarity = lexicalScore(input.query, `${row.title}\n${row.content}`);
            let retrieval = 'local_vector_lexical';
            if (canUseLocalVector) {
                let vector = blobToVector(row.embedding_blob, row.embedding_dim);
                if (vector.length === 0 && row.embedding_json) {
                    try {
                        const parsed = JSON.parse(row.embedding_json);
                        vector = Array.isArray(parsed) ? parsed.map((value) => Number(value) || 0) : [];
                    } catch {
                        vector = [];
                    }
                }
                if (vector.length > 0) {
                    similarity = Math.max(similarity, cosine(queryVector, vector));
                    retrieval = 'local_vector_hash';
                }
            }
            return {
                id: row.id,
                sourceType: row.source_type as RagEvidenceSourceType,
                sourceId: row.source_id,
                title: row.title,
                excerpt: row.content,
                metadata: { vectorSimilarity: Number(similarity.toFixed(4)), retrieval },
                score: Math.round(similarity * 100),
            } satisfies RagEvidenceItem;
        })
        .filter((item) => Number(item.metadata?.vectorSimilarity || 0) >= MIN_SIMILARITY)
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, Math.max(1, Math.min(16, input.limit ?? 8)));
}
