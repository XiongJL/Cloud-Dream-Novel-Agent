import type { PrismaClientType } from '@novel-editor/core';
import type {
    AgentAttachmentBlock,
    AgentAttachmentContent,
    AgentAttachmentOutline,
    AgentAttachmentReadResult,
    AgentAttachmentReadSelector,
    AgentAttachmentRecord,
    AgentAttachmentSearchResult,
    AgentAttachmentWindow,
    ExtractedDocument,
} from '../../shared/agentAttachment';

const MAX_READ_CHARACTERS = 12_000;
const LONG_READ_CHUNK_CHARACTERS = 8_000;
const MAX_SEARCH_RESULTS = 20;
const DEFAULT_SEARCH_RESULTS = 10;
const SEARCH_SNIPPET_CONTEXT = 120;

type AttachmentRow = {
    id: string;
    novelId: string;
    conversationId: string;
    messageId: string | null;
    originalFileName: string;
    extension: string;
    mimeType: string | null;
    sizeBytes: number;
    characterCount: number;
    contentHash: string;
    plainText: string;
    extractedContentJson: string;
    extractionMetaJson: string;
    extractorVersion: string;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
};

export type AgentAttachmentCreateInput = {
    id: string;
    novelId: string;
    conversationId: string;
    originalFileName: string;
    extension: string;
    mimeType?: string | null;
    sizeBytes: number;
    contentHash: string;
    extractorVersion: string;
    document: ExtractedDocument;
};

export class AgentAttachmentStoreError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'AgentAttachmentStoreError';
        this.code = code;
    }
}

function parseJson<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function metadataOf(row: AttachmentRow): ExtractedDocument['metadata'] & { title?: string } {
    return parseJson(row.extractionMetaJson, { warnings: [] });
}

function blocksOf(row: AttachmentRow): AgentAttachmentBlock[] {
    const parsed = parseJson<{ blocks?: AgentAttachmentBlock[] }>(row.extractedContentJson, {});
    return Array.isArray(parsed.blocks) ? parsed.blocks : [];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedHeading(value: string): string {
    return value.trim().replace(/[\s　]+/g, '').replace(/[：:。．.、_-]+$/u, '').toLocaleLowerCase();
}

function sectionTitleMatches(candidate: string, requested: string): boolean {
    const actual = normalizedHeading(candidate);
    const target = normalizedHeading(requested);
    if (!actual || !target) return false;
    if (actual === target) return true;
    // Treat common split headings such as “第二章（上）/第二章 下” as one logical section.
    return actual.replace(/[（(]?([上中下前后])[）)]?$/u, '') === target;
}

function splitHeadingPart(value: string): string {
    return normalizedHeading(value).match(/[（(]?([上中下前后])[）)]?$/u)?.[1] || '';
}

function blockHeading(block: AgentAttachmentBlock): string {
    return block.headingPath?.at(-1) || (block.type === 'heading' ? block.text : '');
}

function standaloneHeadingCandidates(text: string, requestedTitle = ''): AgentAttachmentBlock[] {
    const result: AgentAttachmentBlock[] = [];
    const expression = /(^|\n)([^\n\r]{1,100})(?=\r?\n|$)/gu;
    let match = expression.exec(text);
    let index = 0;
    while (match) {
        const value = match[2].trim();
        if (sectionTitleMatches(value, requestedTitle) || /^(第.{1,24}[章节卷部篇回]|chapter\s+\S+)/iu.test(value)) {
            const leading = match[1] ? match[1].length : 0;
            const startOffset = match.index + leading;
            result.push({
                blockId: `fallback-heading-${index++}`,
                type: 'heading',
                text: value,
                startOffset,
                endOffset: startOffset + match[2].length,
            });
        }
        match = expression.exec(text);
    }
    return result;
}

function endAtBlockBoundary(blocks: AgentAttachmentBlock[], start: number, target: number, hardEnd: number): number {
    const candidates = blocks
        .filter((block) => block.endOffset > start && block.endOffset <= target)
        .map((block) => block.endOffset);
    const boundary = candidates.length ? Math.max(...candidates) : target;
    // Avoid returning a tiny heading-only chunk when the next paragraph is one large block.
    const minimumUsefulBoundary = start + Math.floor((target - start) * 0.6);
    return Math.min(hardEnd, boundary >= minimumUsefulBoundary ? boundary : target);
}

function snippetStart(text: string, offset: number): number {
    const bounded = Math.max(0, Math.min(offset, text.length));
    if (bounded > 0 && bounded < text.length) {
        const previous = text.charCodeAt(bounded - 1);
        const current = text.charCodeAt(bounded);
        if (previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF) return bounded - 1;
    }
    return bounded;
}

function snippetEnd(text: string, offset: number): number {
    const bounded = Math.max(0, Math.min(offset, text.length));
    if (bounded > 0 && bounded < text.length) {
        const previous = text.charCodeAt(bounded - 1);
        const current = text.charCodeAt(bounded);
        if (previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF) return bounded + 1;
    }
    return bounded;
}

function toRecord(row: AttachmentRow): AgentAttachmentRecord {
    const metadata = metadataOf(row);
    return {
        id: row.id,
        novelId: row.novelId,
        conversationId: row.conversationId,
        messageId: row.messageId,
        originalFileName: row.originalFileName,
        extension: row.extension,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
        characterCount: Number(row.characterCount),
        contentHash: row.contentHash,
        extractorVersion: row.extractorVersion,
        status: row.status === 'failed' ? 'failed' : 'ready',
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        title: metadata.title ?? null,
        pageCount: metadata.pageCount ?? null,
        warnings: Array.isArray(metadata.warnings) ? metadata.warnings : [],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export class AgentAttachmentStore {
    constructor(private readonly db: PrismaClientType) {}

    async ensureSchema(): Promise<void> {
        await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentAttachment (
                id TEXT PRIMARY KEY, novelId TEXT NOT NULL, conversationId TEXT NOT NULL,
                messageId TEXT, originalFileName TEXT NOT NULL, extension TEXT NOT NULL,
                mimeType TEXT, sizeBytes INTEGER NOT NULL, characterCount INTEGER NOT NULL,
                contentHash TEXT NOT NULL, plainText TEXT NOT NULL, extractedContentJson TEXT NOT NULL,
                extractionMetaJson TEXT NOT NULL DEFAULT '{}', extractorVersion TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'ready', errorCode TEXT, errorMessage TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE
            )
        `);
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_attachment_conversation_created ON AgentAttachment(conversationId, createdAt)');
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_attachment_novel_hash ON AgentAttachment(novelId, contentHash)');
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_attachment_message ON AgentAttachment(messageId)');
    }

    private async assertConversationScope(novelId: string, conversationId: string): Promise<void> {
        const rows = await this.db.$queryRawUnsafe<Array<{ novelId: string }>>(
            'SELECT novelId FROM AgentConversation WHERE id = ? LIMIT 1',
            conversationId,
        );
        if (!rows.length) throw new AgentAttachmentStoreError('CONVERSATION_NOT_FOUND', 'Agent conversation was not found');
        if (rows[0].novelId !== novelId) {
            throw new AgentAttachmentStoreError('ATTACHMENT_SCOPE_MISMATCH', 'Conversation does not belong to the current novel');
        }
    }

    private async findScoped(novelId: string, conversationId: string, attachmentId: string): Promise<AttachmentRow> {
        await this.ensureSchema();
        const rows = await this.db.$queryRawUnsafe<AttachmentRow[]>(
            'SELECT * FROM AgentAttachment WHERE id = ? LIMIT 1',
            attachmentId,
        );
        if (!rows.length) throw new AgentAttachmentStoreError('ATTACHMENT_NOT_FOUND', 'Attachment was not found');
        const row = rows[0];
        if (row.novelId !== novelId || row.conversationId !== conversationId) {
            throw new AgentAttachmentStoreError('ATTACHMENT_SCOPE_MISMATCH', 'Attachment does not belong to the current conversation');
        }
        if (row.status !== 'ready') throw new AgentAttachmentStoreError('ATTACHMENT_NOT_READY', 'Attachment is not ready');
        return row;
    }

    async create(input: AgentAttachmentCreateInput): Promise<AgentAttachmentRecord> {
        await this.ensureSchema();
        await this.assertConversationScope(input.novelId, input.conversationId);
        const now = new Date().toISOString();
        const metadata = { ...input.document.metadata, ...(input.document.title ? { title: input.document.title } : {}) };
        await this.db.$executeRawUnsafe(`
            INSERT INTO AgentAttachment (
                id, novelId, conversationId, messageId, originalFileName, extension, mimeType,
                sizeBytes, characterCount, contentHash, plainText, extractedContentJson,
                extractionMetaJson, extractorVersion, status, createdAt, updatedAt
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        `, input.id, input.novelId, input.conversationId, input.originalFileName, input.extension,
        input.mimeType ?? null, input.sizeBytes, input.document.plainText.length, input.contentHash,
        input.document.plainText, JSON.stringify({ blocks: input.document.blocks }), JSON.stringify(metadata),
        input.extractorVersion, now, now);
        return this.getMetadata(input.novelId, input.conversationId, input.id);
    }

    async list(novelId: string, conversationId: string): Promise<AgentAttachmentRecord[]> {
        await this.ensureSchema();
        try {
            await this.assertConversationScope(novelId, conversationId);
        } catch (error) {
            // Seed conversations exist in the renderer before their first persisted message.
            if (error instanceof AgentAttachmentStoreError && error.code === 'CONVERSATION_NOT_FOUND') return [];
            throw error;
        }
        const rows = await this.db.$queryRawUnsafe<AttachmentRow[]>(
            'SELECT * FROM AgentAttachment WHERE novelId = ? AND conversationId = ? ORDER BY datetime(createdAt) ASC',
            novelId,
            conversationId,
        );
        return rows.map(toRecord);
    }

    async getMetadata(novelId: string, conversationId: string, attachmentId: string): Promise<AgentAttachmentRecord> {
        return toRecord(await this.findScoped(novelId, conversationId, attachmentId));
    }

    async getContent(novelId: string, conversationId: string, attachmentId: string): Promise<AgentAttachmentContent> {
        const row = await this.findScoped(novelId, conversationId, attachmentId);
        return { ...toRecord(row), plainText: row.plainText, blocks: blocksOf(row) };
    }

    async readWindow(input: {
        novelId: string;
        conversationId: string;
        attachmentId: string;
        offset?: number;
        limit?: number;
    }): Promise<AgentAttachmentWindow> {
        const row = await this.findScoped(input.novelId, input.conversationId, input.attachmentId);
        const offset = Math.max(0, Math.min(Number(input.offset) || 0, row.plainText.length));
        const limit = Math.max(1, Math.min(Number(input.limit) || MAX_READ_CHARACTERS, MAX_READ_CHARACTERS));
        const end = Math.min(row.plainText.length, offset + limit);
        const blocks = blocksOf(row).filter((block) => block.endOffset > offset && block.startOffset < end);
        const metadata = metadataOf(row);
        return {
            attachmentId: row.id,
            originalFileName: row.originalFileName,
            offset,
            limit,
            totalCharacters: row.plainText.length,
            text: row.plainText.slice(offset, end),
            nextOffset: end < row.plainText.length ? end : null,
            blockIds: blocks.map((block) => block.blockId),
            warnings: Array.isArray(metadata.warnings) ? metadata.warnings : [],
        };
    }

    async read(input: {
        novelId: string;
        conversationId: string;
        attachmentId: string;
        selector: AgentAttachmentReadSelector;
    }): Promise<AgentAttachmentReadResult> {
        const row = await this.findScoped(input.novelId, input.conversationId, input.attachmentId);
        const blocks = blocksOf(row);
        const metadata = metadataOf(row);
        const selector = input.selector;
        let startOffset = 0;
        let endOffset = row.plainText.length;
        let status: AgentAttachmentReadResult['status'] = 'resolved';
        let candidates: AgentAttachmentReadResult['candidates'] = [];

        if (!selector || typeof selector !== 'object') {
            throw new AgentAttachmentStoreError('INVALID_INPUT', 'Attachment read selector is required');
        }
        if (selector.kind === 'offset_range') {
            startOffset = Number(selector.startOffset);
            endOffset = Number(selector.endOffset);
            if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || startOffset < 0 || endOffset < startOffset) {
                throw new AgentAttachmentStoreError('INVALID_INPUT', 'offset_range requires 0 <= startOffset <= endOffset');
            }
            startOffset = Math.min(startOffset, row.plainText.length);
            endOffset = Math.min(endOffset, row.plainText.length);
        } else if (selector.kind === 'page_range') {
            const startPage = Number(selector.startPage);
            const endPage = Number(selector.endPage);
            if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) {
                throw new AgentAttachmentStoreError('INVALID_INPUT', 'page_range requires 1 <= startPage <= endPage');
            }
            const selected = blocks.filter((block) => typeof block.page === 'number' && block.page >= startPage && block.page <= endPage);
            if (!selected.length) status = 'not_found';
            else {
                startOffset = Math.min(...selected.map((block) => block.startOffset));
                endOffset = Math.max(...selected.map((block) => block.endOffset));
            }
        } else if (selector.kind === 'block_range') {
            const firstIndex = blocks.findIndex((block) => block.blockId === selector.startBlockId);
            const lastIndex = selector.endBlockId
                ? blocks.findIndex((block) => block.blockId === selector.endBlockId)
                : firstIndex;
            if (firstIndex < 0 || lastIndex < firstIndex) status = 'not_found';
            else {
                startOffset = blocks[firstIndex].startOffset;
                endOffset = blocks[lastIndex].endOffset;
            }
        } else if (selector.kind === 'section') {
            const title = String(selector.title || '').trim();
            if (!title) throw new AgentAttachmentStoreError('INVALID_INPUT', 'section.title is required');
            let headings = blocks.filter((block) => block.type === 'heading');
            let matches = headings.filter((block) => sectionTitleMatches(block.text, title));
            if (!matches.length) {
                headings = standaloneHeadingCandidates(row.plainText, title);
                matches = headings.filter((block) => sectionTitleMatches(block.text, title));
            }
            const rawCandidates = matches.map((block) => {
                const headingIndex = headings.indexOf(block);
                const selectedDepth = block.headingPath?.length || 1;
                const next = headings.slice(headingIndex + 1).find((item) => (
                    !sectionTitleMatches(item.text, title)
                    && (selector.includeSubsections === false || (item.headingPath?.length || 1) <= selectedDepth)
                ));
                return {
                    title: block.text.trim(),
                    startOffset: block.startOffset,
                    endOffset: next?.startOffset ?? row.plainText.length,
                    blockId: blocks.find((item) => item.startOffset === block.startOffset)?.blockId,
                    ...(typeof block.page === 'number' ? { page: block.page } : {}),
                };
            });
            candidates = rawCandidates.filter((candidate, index) => {
                if (index === 0) return true;
                const previous = rawCandidates[index - 1];
                return !(
                    previous.endOffset === candidate.endOffset
                    && splitHeadingPart(previous.title)
                    && splitHeadingPart(candidate.title)
                    && splitHeadingPart(previous.title) !== splitHeadingPart(candidate.title)
                );
            });
            const occurrence = Number(selector.occurrence || 1);
            if (!Number.isInteger(occurrence) || occurrence < 1) {
                throw new AgentAttachmentStoreError('INVALID_INPUT', 'section.occurrence must be a positive integer');
            }
            const selected = candidates[occurrence - 1];
            if (!selected) status = 'not_found';
            else {
                status = candidates.length > 1 && selector.occurrence == null ? 'ambiguous' : 'resolved';
                startOffset = selected.startOffset;
                endOffset = selected.endOffset;
            }
        } else {
            throw new AgentAttachmentStoreError('INVALID_INPUT', `Unsupported attachment selector: ${(selector as { kind?: unknown }).kind || ''}`);
        }

        if (status === 'not_found') {
            return {
                attachmentId: row.id, originalFileName: row.originalFileName, status, selector,
                totalCharacters: row.plainText.length, text: '', truncated: false, nextSelector: null,
                blockIds: [], pages: [], headings: [], candidates, warnings: metadata.warnings || [],
            };
        }
        const totalRange = Math.max(0, endOffset - startOffset);
        const chunkLimit = totalRange > MAX_READ_CHARACTERS ? LONG_READ_CHUNK_CHARACTERS : MAX_READ_CHARACTERS;
        const desiredEnd = Math.min(endOffset, startOffset + chunkLimit);
        const chunkEnd = desiredEnd < endOffset ? endAtBlockBoundary(blocks, startOffset, desiredEnd, endOffset) : endOffset;
        const selectedBlocks = blocks.filter((block) => block.endOffset > startOffset && block.startOffset < chunkEnd);
        const truncated = chunkEnd < endOffset;
        return {
            attachmentId: row.id,
            originalFileName: row.originalFileName,
            status,
            selector,
            actualRange: { startOffset, endOffset: chunkEnd },
            totalCharacters: row.plainText.length,
            text: row.plainText.slice(startOffset, chunkEnd),
            truncated,
            nextSelector: truncated ? { kind: 'offset_range', startOffset: chunkEnd, endOffset } : null,
            blockIds: selectedBlocks.map((block) => block.blockId),
            pages: [...new Set(selectedBlocks.flatMap((block) => typeof block.page === 'number' ? [block.page] : []))],
            headings: [...new Set(selectedBlocks.map(blockHeading).filter(Boolean))],
            candidates,
            warnings: Array.isArray(metadata.warnings) ? metadata.warnings : [],
        };
    }

    async outline(novelId: string, conversationId: string, attachmentId: string): Promise<AgentAttachmentOutline> {
        const row = await this.findScoped(novelId, conversationId, attachmentId);
        const metadata = metadataOf(row);
        const blocks = blocksOf(row);
        const structural = blocks.filter((block) => block.type === 'heading' || typeof block.page === 'number');
        const entries = (structural.length ? structural : blocks.slice(0, 100)).map((block) => ({
            blockId: block.blockId,
            type: block.type,
            text: block.text.slice(0, 240),
            ...(block.page ? { page: block.page } : {}),
            ...(block.headingPath?.length ? { headingPath: block.headingPath } : {}),
            startOffset: block.startOffset,
            endOffset: block.endOffset,
        }));
        return {
            attachmentId: row.id,
            originalFileName: row.originalFileName,
            totalCharacters: row.plainText.length,
            pageCount: metadata.pageCount ?? null,
            entries,
            warnings: Array.isArray(metadata.warnings) ? metadata.warnings : [],
        };
    }

    async search(input: {
        novelId: string;
        conversationId: string;
        query: string;
        attachmentId?: string;
        limit?: number;
    }): Promise<AgentAttachmentSearchResult> {
        await this.ensureSchema();
        await this.assertConversationScope(input.novelId, input.conversationId);
        const query = String(input.query || '').trim();
        if (!query) throw new AgentAttachmentStoreError('INVALID_INPUT', 'Attachment search query is required');
        if (query.length > 200) throw new AgentAttachmentStoreError('INVALID_INPUT', 'Attachment search query is too long');
        const limit = Math.max(1, Math.min(Number(input.limit) || DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS));

        let rows: AttachmentRow[];
        if (input.attachmentId) {
            const row = await this.findScoped(input.novelId, input.conversationId, input.attachmentId);
            if (!row.messageId) {
                throw new AgentAttachmentStoreError('ATTACHMENT_NOT_SENT', 'Attachment has not been sent in this conversation');
            }
            rows = [row];
        } else {
            rows = await this.db.$queryRawUnsafe<AttachmentRow[]>(
                `SELECT * FROM AgentAttachment
                 WHERE novelId = ? AND conversationId = ? AND messageId IS NOT NULL
                 ORDER BY datetime(createdAt) ASC`,
                input.novelId,
                input.conversationId,
            );
        }

        const expression = new RegExp(escapeRegExp(query), 'giu');
        const matches: AgentAttachmentSearchResult['matches'] = [];
        for (const row of rows) {
            expression.lastIndex = 0;
            const blocks = blocksOf(row);
            let match = expression.exec(row.plainText);
            while (match) {
                const startOffset = match.index;
                const endOffset = startOffset + match[0].length;
                const block = blocks.find((item) => item.endOffset > startOffset && item.startOffset < endOffset);
                const snippetStartOffset = snippetStart(row.plainText, startOffset - SEARCH_SNIPPET_CONTEXT);
                const snippetEndOffset = snippetEnd(row.plainText, endOffset + SEARCH_SNIPPET_CONTEXT);
                matches.push({
                    attachmentId: row.id,
                    originalFileName: row.originalFileName,
                    ...(block ? { blockId: block.blockId } : {}),
                    ...(typeof block?.page === 'number' ? { page: block.page } : {}),
                    ...(block?.headingPath?.length ? { headingPath: block.headingPath } : {}),
                    startOffset,
                    endOffset,
                    snippetStartOffset,
                    snippetEndOffset,
                    snippet: row.plainText.slice(snippetStartOffset, snippetEndOffset),
                });
                if (matches.length > limit) {
                    return { query, searchedAttachmentCount: rows.length, hasMore: true, matches: matches.slice(0, limit) };
                }
                match = expression.exec(row.plainText);
            }
        }
        return { query, searchedAttachmentCount: rows.length, hasMore: false, matches };
    }

    async bindToMessage(novelId: string, conversationId: string, messageId: string, attachmentIds: string[]): Promise<AgentAttachmentRecord[]> {
        await this.assertConversationScope(novelId, conversationId);
        const uniqueIds = [...new Set(attachmentIds)];
        for (const attachmentId of uniqueIds) {
            const row = await this.findScoped(novelId, conversationId, attachmentId);
            if (row.messageId && row.messageId !== messageId) {
                throw new AgentAttachmentStoreError('ATTACHMENT_ALREADY_BOUND', 'Attachment is already bound to another message');
            }
        }
        if (uniqueIds.length) {
            const placeholders = uniqueIds.map(() => '?').join(', ');
            await this.db.$executeRawUnsafe(
                `UPDATE AgentAttachment SET messageId = ?, updatedAt = ? WHERE id IN (${placeholders})`,
                messageId,
                new Date().toISOString(),
                ...uniqueIds,
            );
        }
        return Promise.all(uniqueIds.map((id) => this.getMetadata(novelId, conversationId, id)));
    }

    async removePending(novelId: string, conversationId: string, attachmentId: string): Promise<{ ok: true }> {
        const row = await this.findScoped(novelId, conversationId, attachmentId);
        if (row.messageId) throw new AgentAttachmentStoreError('ATTACHMENT_ALREADY_BOUND', 'Sent attachments cannot be removed');
        await this.db.$executeRawUnsafe('DELETE FROM AgentAttachment WHERE id = ?', attachmentId);
        return { ok: true };
    }
}
