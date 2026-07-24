/**
 * FTS5 Full-Text Search Index Manager
 * 
 * 使用 SQLite FTS5 实现全文搜索，支持章节、灵感等内容的统一索引。
 */

import { db } from '@novel-editor/core';

const SEARCH_INDEX_REQUIRED_COLUMNS = [
    'content',
    'entity_type',
    'entity_id',
    'novel_id',
    'chapter_id',
    'title',
    'volume_title',
    'chapter_order',
    'volume_order',
    'volume_id',
];

async function createSearchIndexTable(): Promise<void> {
    await db.$executeRaw`
        CREATE VIRTUAL TABLE search_index USING fts5(
            content,
            entity_type,
            entity_id UNINDEXED,
            novel_id UNINDEXED,
            chapter_id UNINDEXED,
            title,
            volume_title,
            chapter_order UNINDEXED,
            volume_order UNINDEXED,
            volume_id UNINDEXED,
            tokenize='unicode61'
        );
    `;
}

async function getSearchIndexColumns(): Promise<string[]> {
    const rows = await db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(search_index);');
    return rows.map((row) => row.name);
}

async function rebuildAllIndexes(): Promise<void> {
    const novels = await db.novel.findMany({
        where: { deleted: false },
        select: { id: true },
    });

    for (const novel of novels) {
        await rebuildIndex(novel.id);
    }
}

// Initialize FTS5 table if not exists
export async function initSearchIndex(): Promise<void> {
    try {
        // Check if table exists
        const tableExists = await db.$queryRaw<{ name: string }[]>`
            SELECT name FROM sqlite_master WHERE type='table' AND name='search_index';
        `;

        if (tableExists.length === 0) {
            await createSearchIndexTable();
            console.log('[SearchIndex] FTS5 table created successfully');
            await rebuildAllIndexes();
            console.log('[SearchIndex] FTS5 index rebuilt from source data');
        } else {
            const existingColumns = await getSearchIndexColumns();
            const missingColumns = SEARCH_INDEX_REQUIRED_COLUMNS.filter((column) => !existingColumns.includes(column));

            if (missingColumns.length > 0) {
                console.warn(`[SearchIndex] Schema mismatch detected. Rebuilding FTS5 table. Missing columns: ${missingColumns.join(', ')}`);
                await db.$executeRawUnsafe('DROP TABLE IF EXISTS search_index;');
                await createSearchIndexTable();
                await rebuildAllIndexes();
                console.log('[SearchIndex] FTS5 table rebuilt successfully');
            }
        }
    } catch (error) {
        console.error('[SearchIndex] Failed to initialize FTS5 table:', error);
    }
}

// Extract plain text from Lexical JSON
export function extractPlainText(lexicalJson: string): string {
    if (!lexicalJson) return '';
    try {
        const state = JSON.parse(lexicalJson);
        const textParts: string[] = [];

        const traverse = (node: any) => {
            if (node.type === 'text' && node.text) {
                textParts.push(node.text);
            }

            if (node.children && Array.isArray(node.children)) {
                node.children.forEach(traverse);

                // Add a space between blocks
                if (node.type !== 'root' && node.type !== 'list' && node.type !== 'listitem') {
                    textParts.push(' ');
                }
            }
        };

        if (state.root) {
            traverse(state.root);
        }

        return textParts.join('').trim();
    } catch {
        return lexicalJson;
    }
}

// Index a chapter
export async function indexChapter(chapter: {
    id: string;
    title: string;
    content: string;
    volumeId: string;
    novelId?: string;
    volumeTitle?: string;
    order?: number;
    volumeOrder?: number;
}): Promise<void> {
    const plainText = extractPlainText(chapter.content);

    let novelId = chapter.novelId;
    let volumeTitle = chapter.volumeTitle;
    let order = chapter.order;
    let volumeOrder = chapter.volumeOrder;

    if (!novelId || !volumeTitle || order === undefined || volumeOrder === undefined) {
        const chapterWithVol = await db.chapter.findUnique({
            where: { id: chapter.id },
            select: {
                order: true,
                volume: { select: { id: true, novelId: true, title: true, order: true } }
            }
        });
        if (chapterWithVol) {
            if (order === undefined) order = chapterWithVol.order;
            if (chapterWithVol.volume) {
                if (!novelId) novelId = chapterWithVol.volume.novelId;
                if (!volumeTitle) volumeTitle = chapterWithVol.volume.title;
                if (volumeOrder === undefined) volumeOrder = chapterWithVol.volume.order;
            }
        }
    }

    if (!novelId) return;

    try {
        await db.$executeRaw`
            DELETE FROM search_index WHERE entity_type = 'chapter' AND entity_id = ${chapter.id};
        `;
        await db.$executeRaw`
            INSERT INTO search_index (content, entity_type, entity_id, novel_id, chapter_id, title, volume_title, chapter_order, volume_order, volume_id)
            VALUES (${plainText}, 'chapter', ${chapter.id}, ${novelId}, ${chapter.id}, ${chapter.title}, ${volumeTitle || ''}, ${order || 0}, ${volumeOrder || 0}, ${chapter.volumeId});
        `;
    } catch (error) {
        console.error('[SearchIndex] Failed to index chapter:', error);
    }
}

// Index an idea
export async function indexIdea(idea: {
    id: string;
    content: string;
    quote?: string | null;
    novelId: string;
    chapterId?: string | null;
}): Promise<void> {
    const searchContent = [idea.content, idea.quote].filter(Boolean).join(' ');

    try {
        await db.$executeRaw`
            DELETE FROM search_index WHERE entity_type = 'idea' AND entity_id = ${idea.id};
        `;
        await db.$executeRaw`
            INSERT INTO search_index (content, entity_type, entity_id, novel_id, chapter_id, title, volume_title, chapter_order, volume_order, volume_id)
            VALUES (${searchContent}, 'idea', ${idea.id}, ${idea.novelId}, ${idea.chapterId || ''}, ${idea.content.substring(0, 50)}, '', 0, 0, '');
        `;
    } catch (error) {
        console.error('[SearchIndex] Failed to index idea:', error);
    }
}

// Remove from index
export async function removeFromIndex(entityType: string, entityId: string): Promise<void> {
    try {
        await db.$executeRaw`
            DELETE FROM search_index WHERE entity_type = ${entityType} AND entity_id = ${entityId};
        `;
    } catch (error) {
        console.error('[SearchIndex] Failed to remove from index:', error);
    }
}

export interface SearchResult {
    entityType: 'chapter' | 'idea';
    entityId: string;
    chapterId: string;
    novelId: string;
    title: string;
    snippet: string;
    preview?: string;
    keyword: string;
    matchType: 'content' | 'title' | 'volume';
    chapterOrder?: number;
    volumeTitle?: string;
    volumeOrder?: number;
    volumeId?: string;
}

// Search function
export async function search(
    novelId: string,
    keyword: string,
    limit: number = 20,
    offset: number = 0
): Promise<SearchResult[]> {
    if (!keyword.trim()) return [];

    try {
        const escapedKeyword = keyword.replace(/[%_]/g, '\\$&');
        const likePattern = `%${escapedKeyword}%`;

        const results = await db.$queryRaw<{
            entity_type: string;
            entity_id: string;
            chapter_id: string;
            novel_id: string;
            title: string;
            volume_title: string;
            content: string;
            chapter_order: number;
            volume_order: number;
            volume_id: string;
        }[]>`
            SELECT entity_type, entity_id, chapter_id, novel_id, title, volume_title, content, chapter_order, volume_order, volume_id
            FROM search_index
            WHERE novel_id = ${novelId}
            AND (content LIKE ${likePattern} OR title LIKE ${likePattern} OR volume_title LIKE ${likePattern})
            ORDER BY volume_order ASC, chapter_order ASC
            LIMIT ${limit} OFFSET ${offset};
        `;

        const allResults: SearchResult[] = [];
        const lowerKeyword = keyword.toLowerCase();
        const matchedVolumes = new Set<string>();

        for (const r of results) {
            const docContent = r.content || '';
            const title = r.title || '';
            const volumeTitle = r.volume_title || '';
            const chapterOrder = Number(r.chapter_order || 0);
            const volumeOrder = Number(r.volume_order || 0);

            // 1. Check Volume Title Match
            if (r.entity_type === 'chapter' && volumeTitle && volumeTitle.toLowerCase().includes(lowerKeyword)) {
                if (!matchedVolumes.has(volumeTitle)) {
                    allResults.push({
                        entityType: 'chapter',
                        entityId: r.entity_id,
                        chapterId: r.chapter_id,
                        novelId: r.novel_id,
                        title: r.title,
                        snippet: `Volume match: <mark>${volumeTitle}</mark>`,
                        preview: `Found in Volume: ${volumeTitle}`,
                        keyword: keyword,
                        matchType: 'volume',
                        chapterOrder: chapterOrder,
                        volumeTitle: volumeTitle,
                        volumeOrder: volumeOrder,
                        volumeId: r.volume_id
                    });
                    matchedVolumes.add(volumeTitle);
                }
            }

            // 2. Check Title Match
            if (r.entity_type === 'chapter' && title.toLowerCase().includes(lowerKeyword)) {
                allResults.push({
                    entityType: 'chapter',
                    entityId: r.entity_id,
                    chapterId: r.chapter_id,
                    novelId: r.novel_id,
                    title: r.title,
                    snippet: `Title match: <mark>${title}</mark>`,
                    preview: `Found in Title: ${title}`,
                    keyword: keyword,
                    matchType: 'title',
                    chapterOrder: chapterOrder,
                    volumeTitle: volumeTitle,
                    volumeOrder: volumeOrder,
                    volumeId: r.volume_id
                });
            }

            // 3. Check Content Matches — deduplicated by snippet window
            // Find all match positions, then merge nearby ones so
            // the same passage only produces one result.
            const lowerContent = docContent.toLowerCase();
            const indices: number[] = [];
            let pos = 0;

            while (pos < lowerContent.length && indices.length < 200) {
                const idx = lowerContent.indexOf(lowerKeyword, pos);
                if (idx === -1) break;
                indices.push(idx);
                pos = idx + lowerKeyword.length;
            }

            // Merge indices that fall within the same snippet window (60 chars)
            const SNIPPET_WINDOW = 60;
            const mergedIndices: number[] = [];
            for (const index of indices) {
                if (mergedIndices.length === 0 || index - mergedIndices[mergedIndices.length - 1] > SNIPPET_WINDOW) {
                    mergedIndices.push(index);
                }
                // else: skip — this match is close to a previous one
            }

            for (const index of mergedIndices) {
                allResults.push({
                    entityType: r.entity_type as 'chapter' | 'idea',
                    entityId: r.entity_id,
                    chapterId: r.chapter_id,
                    novelId: r.novel_id,
                    title: r.title,
                    snippet: generateSnippetAtIndex(docContent, keyword, index, 10, true),
                    preview: generateSnippetAtIndex(docContent, keyword, index, 25, false),
                    keyword: keyword,
                    matchType: 'content',
                    chapterOrder: chapterOrder,
                    volumeTitle: volumeTitle,
                    volumeOrder: volumeOrder,
                    volumeId: r.volume_id
                });
            }
        }

        return allResults;
    } catch (error) {
        console.error('[SearchIndex] Search failed:', error);
        return [];
    }
}

function generateSnippetAtIndex(content: string, keyword: string, index: number, contextLength: number = 30, useMark: boolean = true): string {
    if (!content) return '';
    const start = Math.max(0, index - contextLength);
    const end = Math.min(content.length, index + keyword.length + contextLength * 2);

    let snippet = '';
    if (start > 0) snippet += '...';

    const before = content.substring(start, index);
    const match = content.substring(index, index + keyword.length);
    const after = content.substring(index + keyword.length, end);

    if (useMark) {
        snippet += before + '<mark>' + match + '</mark>' + after;
    } else {
        snippet += before + match + after;
    }

    if (end < content.length) snippet += '...';
    return snippet;
}

export async function rebuildIndex(novelId: string): Promise<{ chapters: number; ideas: number }> {
    let chaptersIndexed = 0;
    let ideasIndexed = 0;

    try {
        await db.$executeRaw`DELETE FROM search_index WHERE novel_id = ${novelId};`;

        const chapters = await db.chapter.findMany({
            where: { volume: { novelId } },
            select: {
                id: true,
                title: true,
                content: true,
                volumeId: true,
                order: true,
                volume: { select: { title: true, order: true } }
            }
        });

        for (const chapter of chapters) {
            await indexChapter({
                ...chapter,
                novelId,
                volumeTitle: chapter.volume?.title,
                volumeOrder: chapter.volume?.order
            });
            chaptersIndexed++;
        }

        const ideas = await db.idea.findMany({
            where: { novelId },
            select: { id: true, content: true, quote: true, novelId: true, chapterId: true }
        });

        for (const idea of ideas) {
            await indexIdea(idea);
            ideasIndexed++;
        }
    } catch (error) {
        console.error('[SearchIndex] Rebuild failed:', error);
    }
    return { chapters: chaptersIndexed, ideas: ideasIndexed };
}

export async function getIndexStats(novelId: string): Promise<{ chapters: number; ideas: number }> {
    try {
        const result = await db.$queryRaw<{ entity_type: string; count: bigint }[]>`
            SELECT entity_type, COUNT(*) as count FROM search_index WHERE novel_id = ${novelId} GROUP BY entity_type;
        `;
        let chapters = 0;
        let ideas = 0;
        result.forEach(r => {
            if (r.entity_type === 'chapter') chapters = Number(r.count);
            if (r.entity_type === 'idea') ideas = Number(r.count);
        });
        return { chapters, ideas };
    } catch (error) {
        console.error('[SearchIndex] Failed to get stats:', error);
        return { chapters: 0, ideas: 0 };
    }
}
