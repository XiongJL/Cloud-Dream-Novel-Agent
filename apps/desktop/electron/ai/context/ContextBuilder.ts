import { createHash, randomUUID } from 'node:crypto';
import { db } from '@novel-editor/core';
import type { ContinueWritingPayload, CreativeAssetsGeneratePayload } from '../types';
import type {
    AgentChapterScopeBuildPayload,
    AgentChapterScopeKind,
    ChapterScopeBundle,
    ChapterScopeContextItem,
    ContinuationContextPolicy,
    ContinuationContextSnapshot,
    NarrativeStateLedger,
} from '../../../shared/agentChapterScope';
import { extractReadableText } from '../../../shared/lexicalDocument';
import { novelChapterLength, resolveWritingLength } from '../../../shared/writingPolicy';
import { chapterMemoryExcerpt, distinctNarrativeMemories, isSemanticChapterSummary } from '../../../shared/chapterGenerationQuality';
import { prepareChapterWritingPayload } from '../../../shared/chapterWritingPrompt';

export interface ContinueWritingContext {
    generationPolicyVersion?: 2;
    currentContentSource: string;
    hardContext: {
        worldSettings: Array<Record<string, unknown>>;
        plotLines: Array<Record<string, unknown>>;
        characters: Array<Record<string, unknown>>;
        items: Array<Record<string, unknown>>;
        maps: Array<Record<string, unknown>>;
    };
    dynamicContext: {
        recentChapters: Array<{
            chapterId: string;
            title: string;
            excerpt: string;
            contentMode: 'full' | 'truncated' | 'summary' | 'excerpt';
        }>;
        selectedIdeas: Array<{ ideaId: string; content: string; quote?: string; tags: string[] }>;
        selectedIdeaEntities: Array<{ name: string; kind: 'character' | 'item' | 'worldSetting' }>;
        currentChapterBeforeCursor: string;
        currentLocation?: string;
        narrativeSummaries: Array<{ level: 'volume' | 'novel'; title: string; summaryText: string; keyFacts: string[] }>;
    };
    params: {
        mode: 'new_chapter' | 'continue_chapter' | 'rewrite_chapter';
        contextChapterCount: number;
        targetLength: number;
        novelChapterLength?: number;
        style: string;
        tone: string;
        pace: string;
    };
    policy: ContinuationContextPolicy;
    snapshot: ContinuationContextSnapshot;
    usedContext: string[];
    warnings: string[];
}

export interface CreativeAssetsContext {
    existingEntities: {
        characters: Array<{ name: string; role?: string; description?: string }>;
        items: Array<{ name: string; type?: string; description?: string }>;
        plotLines: Array<{ name: string; description?: string; points: Array<{ title: string; status: string }> }>;
        worldSettings: Array<{ name: string; content: string; type: string }>;
    };
    recentSummaries: Array<{ chapterId: string; title: string; summary: string }>;
    narrativeSummaries: Array<{ level: 'volume' | 'novel'; title: string; summaryText: string; keyFacts: string[] }>;
    usedContext: string[];
    warnings: string[];
    estimatedTokens: number;
}

function uniqueArray(values: string[]): string[] {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const raw of values) {
        const item = String(raw || '').trim();
        if (!item) continue;
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(item);
    }
    return output;
}

export function extractPlainTextFromLexical(content: string): string {
    return extractReadableText(content);
}

function estimateTokenCount(text: string): number {
    // 中文约 1.5 token/字, 英文约 0.4 token/char
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars * 1.5 + otherChars * 0.4);
}

function contentHash(content: string): string {
    return createHash('sha256').update(content || '', 'utf8').digest('hex');
}

function parseJsonArray(value: unknown, limit = 50): unknown[] {
    if (Array.isArray(value)) return value.slice(0, limit);
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.slice(0, limit) : [];
    } catch {
        return [];
    }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function boundedExcerpt(text: string, limit = 1600): string {
    if (text.length <= limit) return text;
    const half = Math.floor((limit - 5) / 2);
    return `${text.slice(0, half)}\n...\n${text.slice(-half)}`;
}

export class ContextBuilder {
    private async findNearestPreviousChapterWithContent(
        orderedChapters: Array<Record<string, unknown>>,
        anchorIndex: number,
    ): Promise<Record<string, unknown> | null> {
        const previousChapters = orderedChapters.slice(0, Math.max(0, anchorIndex));
        const batchSize = 25;
        for (let end = previousChapters.length; end > 0; end -= batchSize) {
            const batch = previousChapters.slice(Math.max(0, end - batchSize), end);
            const ids = batch.map((chapter) => String(chapter.id || '')).filter(Boolean);
            if (!ids.length) continue;
            const rows = await (db as any).chapter.findMany({
                where: { id: { in: ids }, deleted: false },
                select: { id: true, content: true },
            });
            const contentById = new Map<string, string>(
                rows.map((chapter: any) => [String(chapter.id), String(chapter.content || '')]),
            );
            for (let index = batch.length - 1; index >= 0; index -= 1) {
                const chapter = batch[index];
                const rawContent = contentById.get(String(chapter.id || '')) || '';
                if (extractPlainTextFromLexical(rawContent).trim()) {
                    return chapter;
                }
            }
        }
        return null;
    }

    async buildForChapterScope(payload: AgentChapterScopeBuildPayload): Promise<ChapterScopeBundle> {
        const novelId = String(payload.novelId || '').trim();
        if (!novelId) throw new Error('novelId is required');

        if (payload.representation === 'expert_context') {
            const catalog = await this.buildForChapterScope({ ...payload, representation: 'catalog' });
            const support = await this.readScopeProjectContext(novelId, uniqueArray(catalog.chapters.map(chapter => chapter.volumeId)));
            const result = { ...catalog, ...support };
            return { ...result, estimatedTokens: estimateTokenCount(JSON.stringify(result)) };
        }

        const requestedKind = payload.kind || 'current_chapter';
        const kind: AgentChapterScopeKind = requestedKind;
        const batchSize = Math.max(1, Math.min(10, Math.floor(payload.batchSize ?? 4)));
        const maxDetailedChapters = Math.max(1, Math.min(20, Math.floor(payload.maxDetailedChapters ?? 20)));
        const maxEstimatedTokens = Math.max(4000, Math.min(200000, Math.floor(payload.maxEstimatedTokens ?? 60000)));

        const volumes = await (db as any).volume.findMany({
            where: { novelId },
            select: {
                id: true,
                order: true,
                chapters: {
                    where: { deleted: false },
                    select: { id: true, volumeId: true, title: true, order: true },
                    orderBy: { order: 'asc' },
                },
            },
            orderBy: { order: 'asc' },
        });
        const orderedMetadata = volumes.flatMap((volume: any) =>
            (volume.chapters || []).map((chapter: any) => ({
                ...chapter,
                volumeOrder: Number(volume.order || 0),
            })),
        );
        if (orderedMetadata.length === 0) throw new Error('No chapters found for novel');

        const requestedIds = uniqueArray([
            ...(Array.isArray(payload.chapterIds) ? payload.chapterIds : []),
            ...(kind === 'current_chapter' && payload.chapterId ? [payload.chapterId] : []),
        ]);
        const anchorChapterId = String(
            payload.anchorChapterId
            || (kind === 'current_chapter' ? payload.chapterId : undefined)
            || requestedIds.at(-1)
            || '',
        ).trim() || undefined;
        const knownIds = new Set(orderedMetadata.map((chapter: any) => String(chapter.id)));
        const unknownIds = requestedIds.filter((chapterId) => !knownIds.has(chapterId));
        if (unknownIds.length > 0) throw new Error(`Chapters do not belong to novel: ${unknownIds.join(', ')}`);
        if (anchorChapterId && !knownIds.has(anchorChapterId)) {
            throw new Error(`Anchor chapter does not belong to novel: ${anchorChapterId}`);
        }

        let targetMetadata: any[] = [];
        if (kind === 'current_chapter') {
            if (!anchorChapterId || !knownIds.has(anchorChapterId)) throw new Error('anchorChapterId is required');
            targetMetadata = orderedMetadata.filter((chapter: any) => chapter.id === anchorChapterId);
        } else if (kind === 'selected_chapters') {
            if (requestedIds.length === 0) throw new Error('chapterIds is required for selected_chapters');
            const selected = new Set(requestedIds);
            targetMetadata = orderedMetadata.filter((chapter: any) => selected.has(chapter.id));
        } else if (kind === 'chapter_range') {
            if (requestedIds.length < 2) throw new Error('chapter_range requires at least two chapterIds');
            const indexes = requestedIds.map((chapterId) => orderedMetadata.findIndex((chapter: any) => chapter.id === chapterId));
            targetMetadata = orderedMetadata.slice(Math.min(...indexes), Math.max(...indexes) + 1);
        } else if (kind === 'current_volume') {
            const volumeId = String(payload.volumeId || '').trim();
            if (!volumeId) throw new Error('volumeId is required for current_volume');
            targetMetadata = orderedMetadata.filter((chapter: any) => chapter.volumeId === volumeId);
        } else {
            targetMetadata = orderedMetadata;
        }
        if (targetMetadata.length === 0) throw new Error('Resolved chapter scope is empty');

        const targetChapterIds = targetMetadata.map((chapter: any) => String(chapter.id));
        const targetIdSet = new Set(targetChapterIds);
        let contextMetadata = targetMetadata;
        if (kind === 'selected_chapters' && targetMetadata.length > 1) {
            const indexes = targetMetadata.map((chapter: any) =>
                orderedMetadata.findIndex((candidate: any) => candidate.id === chapter.id),
            );
            contextMetadata = orderedMetadata.slice(Math.min(...indexes), Math.max(...indexes) + 1);
        }
        const contextChapterIds = contextMetadata.map((chapter: any) => String(chapter.id));
        // Catalogs resolve approved targets without loading prose or project assets.
        // Fingerprints identify the saved version, not a claim that prose was read.
        if (payload.representation === 'catalog') {
            const rows = await (db as any).chapter.findMany({
                where: { id: { in: targetChapterIds }, deleted: false },
                select: { id: true, volumeId: true, title: true, order: true, version: true, updatedAt: true },
            });
            const byId = new Map<string, any>(rows.map((row: any) => [String(row.id), row]));
            const chapters = targetMetadata.map((metadata: any) => {
                const row = byId.get(String(metadata.id));
                if (!row) throw new Error(`Approved chapter disappeared: ${metadata.id}`);
                const updatedAt = new Date(row.updatedAt).toISOString();
                return {
                    chapterId: String(row.id), volumeId: String(row.volumeId), title: String(row.title || ''),
                    order: Number(row.order || 0), volumeOrder: Number(metadata.volumeOrder || 0),
                    version: Number(row.version || 1), updatedAt,
                    contentHash: contentHash(JSON.stringify([row.id, row.version, updatedAt])),
                    contentMode: 'catalog' as const, content: '', summaryFresh: false, target: true,
                };
            });
            const snapshot = chapters.map((chapter) => ({
                chapterId: chapter.chapterId, version: chapter.version, contentHash: chapter.contentHash,
                updatedAt: chapter.updatedAt, source: 'database' as const,
            }));
            const batches = Array.from({ length: Math.ceil(targetChapterIds.length / batchSize) }, (_, index) => ({
                index, chapterIds: targetChapterIds.slice(index * batchSize, (index + 1) * batchSize),
            }));
            const bundle = {
                scope: { scopeId: String(payload.scopeId || randomUUID()), novelId, kind,
                    ...(payload.volumeId ? { volumeId: payload.volumeId } : {}),
                    ...(anchorChapterId ? { anchorChapterId } : {}), chapterIds: targetChapterIds,
                    processingMode: 'batched' as const, snapshot },
                chapters, narrativeSummaries: [],
                entityContext: { characters: [], items: [], worldSettings: [], maps: [] },
                plotContext: { plotlines: [] }, evidence: [],
                stateLedger: { entities: {}, timelineHints: [], openQuestions: [], unresolvedThreads: [] },
                coverage: { totalChapterCount: chapters.length, contextChapterCount: chapters.length,
                    readonlyChapterCount: 0, detailedChapterCount: 0, summarizedChapterCount: 0,
                    excerptChapterCount: 0, omittedChapterCount: 0, batchSize, batchCount: batches.length, batches },
                sourceSnapshot: snapshot, warnings: ['仅解析获准章节目录与版本，正文由执行工作单元补读。'],
            };
            return { ...bundle, estimatedTokens: estimateTokenCount(JSON.stringify(bundle)) };
        }
        if (payload.representation === 'verbatim' && targetChapterIds.length !== 1) {
            throw new Error('Verbatim work-unit reads require exactly one approved chapter');
        }
        const processingMode = contextChapterIds.length > maxDetailedChapters
            ? 'batched'
            : (payload.processingMode || 'detailed');
        const chapters = await (db as any).chapter.findMany({
            where: { id: { in: contextChapterIds }, deleted: false },
            select: {
                id: true,
                volumeId: true,
                title: true,
                order: true,
                content: true,
                wordCount: true,
                version: true,
                updatedAt: true,
            },
        });
        const chapterById = new Map<string, any>(chapters.map((chapter: any) => [String(chapter.id), chapter]));
        const summaries = await (db as any).chapterSummary.findMany({
            where: { chapterId: { in: contextChapterIds }, isLatest: true, status: 'active' },
            orderBy: { updatedAt: 'desc' },
        });
        const summaryByChapterId = new Map<string, any>();
        for (const summary of summaries) {
            if (!summaryByChapterId.has(String(summary.chapterId))) {
                summaryByChapterId.set(String(summary.chapterId), summary);
            }
        }

        const warnings: string[] = [];
        const snapshot = [] as ChapterScopeBundle['sourceSnapshot'];
        const contextChapters: ChapterScopeContextItem[] = [];
        let staleSummaryCount = 0;
        let missingSummaryCount = 0;
        for (const metadata of contextMetadata) {
            const chapter = chapterById.get(String(metadata.id));
            if (!chapter) {
                warnings.push(`章节 ${metadata.title || metadata.id} 无法读取，已从上下文省略。`);
                continue;
            }
            const editorOverride = chapter.id === anchorChapterId && typeof payload.currentContent === 'string' && payload.currentContent.length > 0;
            const rawContent = editorOverride ? payload.currentContent! : String(chapter.content || '');
            const plainText = extractPlainTextFromLexical(rawContent);
            const hash = contentHash(rawContent);
            const summary = summaryByChapterId.get(String(chapter.id));
            const summaryFresh = isSemanticChapterSummary(summary) && String(summary.sourceContentHash || '') === hash;
            let contentMode: ChapterScopeContextItem['contentMode'];
            let content: string;
            if (payload.representation === 'verbatim') {
                contentMode = 'full';
                content = plainText;
            } else if (processingMode === 'detailed') {
                contentMode = plainText.length > 30000 ? 'truncated' : 'full';
                content = plainText.slice(0, 30000);
            } else if (summaryFresh) {
                contentMode = 'summary';
                content = String(summary.compressedMemory || summary.summaryText || '').slice(0, 2400);
            } else {
                contentMode = 'excerpt';
                content = boundedExcerpt(plainText);
                if (summary) staleSummaryCount += 1;
                else missingSummaryCount += 1;
            }
            const updatedAt = chapter.updatedAt instanceof Date
                ? chapter.updatedAt.toISOString()
                : new Date(chapter.updatedAt).toISOString();
            snapshot.push({
                chapterId: chapter.id,
                version: Number(chapter.version || 1),
                contentHash: hash,
                updatedAt,
                source: editorOverride ? 'editor_buffer' : 'database',
            });
            contextChapters.push({
                chapterId: chapter.id,
                volumeId: chapter.volumeId,
                title: String(chapter.title || ''),
                order: Number(chapter.order || 0),
                volumeOrder: Number(metadata.volumeOrder || 0),
                version: Number(chapter.version || 1),
                updatedAt,
                contentHash: hash,
                contentMode,
                content,
                ...(summary?.id ? { summaryId: String(summary.id) } : {}),
                ...(summaryFresh ? {
                    summaryContent: String(summary.compressedMemory || summary.summaryText || '').slice(0, 2400),
                } : {}),
                summaryFresh,
                target: targetIdSet.has(String(chapter.id)),
            });
        }
        if (staleSummaryCount > 0) warnings.push(`${staleSummaryCount} 个章节摘要已过期，已使用原文摘录。`);
        if (missingSummaryCount > 0) warnings.push(`${missingSummaryCount} 个章节缺少摘要，已使用原文摘录。`);
        if (contextChapterIds.length > maxDetailedChapters) {
            warnings.push(`范围上下文包含 ${contextChapterIds.length} 章，超过详细处理上限 ${maxDetailedChapters}，已切换分批摘要模式。`);
        }

        if (payload.representation === 'verbatim') {
            const bundle = {
                scope: { scopeId: String(payload.scopeId || randomUUID()), novelId, kind,
                    ...(payload.volumeId ? { volumeId: payload.volumeId } : {}),
                    chapterIds: targetChapterIds, anchorChapterId, processingMode: 'detailed' as const, snapshot },
                chapters: contextChapters, narrativeSummaries: [],
                entityContext: { characters: [], items: [], worldSettings: [], maps: [] },
                plotContext: { plotlines: [] }, evidence: [],
                stateLedger: { entities: {}, timelineHints: [], openQuestions: [], unresolvedThreads: [] },
                coverage: { totalChapterCount: 1, contextChapterCount: 1, readonlyChapterCount: 0,
                    detailedChapterCount: 1, summarizedChapterCount: 0, excerptChapterCount: 0,
                    omittedChapterCount: 0, batchSize: 1, batchCount: 1,
                    batches: [{ index: 0, chapterIds: targetChapterIds }] },
                sourceSnapshot: snapshot, warnings,
            };
            return { ...bundle, estimatedTokens: estimateTokenCount(JSON.stringify(bundle)) };
        }

        const volumeIds = uniqueArray(contextChapters.map((chapter) => chapter.volumeId));
        const { narrativeSummaries, entityContext, plotContext, stateLedger } = await this.readScopeProjectContext(novelId, volumeIds);
        const freshSummaryIds = new Set(
            contextChapters.filter((chapter) => chapter.summaryFresh && chapter.summaryId).map((chapter) => chapter.summaryId),
        );
        for (const summary of summaries) {
            if (!freshSummaryIds.has(String(summary.id))) continue;
            Object.assign(stateLedger.entities, parseJsonRecord(summary.entitiesSnapshot));
            stateLedger.timelineHints.push(...parseJsonArray(summary.timelineHints, 20));
            stateLedger.openQuestions.push(...parseJsonArray(summary.openQuestions, 20));
        }
        stateLedger.timelineHints = stateLedger.timelineHints.slice(0, 100);
        stateLedger.openQuestions = stateLedger.openQuestions.slice(0, 100);

        const batches = Array.from({ length: Math.ceil(targetChapterIds.length / batchSize) }, (_, index) => ({
            index, chapterIds: targetChapterIds.slice(index * batchSize, (index + 1) * batchSize),
        }));
        const coverage = {
            totalChapterCount: targetChapterIds.length, contextChapterCount: contextChapters.length,
            readonlyChapterCount: contextChapters.filter((chapter) => !chapter.target).length,
            detailedChapterCount: contextChapters.filter((chapter) => chapter.target && (chapter.contentMode === 'full' || chapter.contentMode === 'truncated')).length,
            summarizedChapterCount: contextChapters.filter((chapter) => chapter.target && chapter.contentMode === 'summary').length,
            excerptChapterCount: contextChapters.filter((chapter) => chapter.target && chapter.contentMode === 'excerpt').length,
            omittedChapterCount: Math.max(0, targetChapterIds.length - contextChapters.filter((chapter) => chapter.target).length),
            batchSize, batchCount: batches.length, batches,
        };
        const scope = {
            scopeId: String(payload.scopeId || randomUUID()), novelId, kind,
            ...(payload.volumeId ? { volumeId: payload.volumeId } : {}), chapterIds: targetChapterIds,
            ...(anchorChapterId ? { anchorChapterId } : {}), processingMode,
            snapshot: snapshot.filter((item) => targetIdSet.has(item.chapterId)),
        };
        const bundleWithoutEstimate = { scope, chapters: contextChapters, narrativeSummaries, entityContext, plotContext,
            evidence: [], stateLedger, coverage, sourceSnapshot: snapshot, warnings };
        const estimatedTokens = estimateTokenCount(JSON.stringify(bundleWithoutEstimate));
        if (estimatedTokens > maxEstimatedTokens) {
            warnings.push(`范围上下文估算 ${estimatedTokens} tokens，超过目标预算 ${maxEstimatedTokens}；下游必须按批次与角色投影继续裁剪。`);
        }
        return { ...bundleWithoutEstimate, estimatedTokens };
    }

    private async readScopeProjectContext(novelId: string, volumeIds: string[]) {
        const [narrativeRows, characters, items, worldSettings, maps, plotlines] = await Promise.all([
            (db as any).narrativeSummary.findMany({
                where: {
                    novelId,
                    isLatest: true,
                    status: 'active',
                    OR: [
                        { level: 'novel', volumeId: null },
                        ...(volumeIds.length > 0 ? [{ level: 'volume', volumeId: { in: volumeIds } }] : []),
                    ],
                },
                orderBy: { updatedAt: 'desc' },
                take: Math.max(2, volumeIds.length + 1),
            }),
            (db as any).character.findMany({ where: { novelId }, orderBy: { updatedAt: 'desc' }, take: 100 }),
            (db as any).item.findMany({ where: { novelId }, orderBy: { updatedAt: 'desc' }, take: 100 }),
            (db as any).worldSetting.findMany({ where: { novelId }, orderBy: { sortOrder: 'asc' } }),
            (db as any).mapCanvas.findMany({ where: { novelId }, orderBy: { updatedAt: 'desc' }, take: 50 }),
            (db as any).plotLine.findMany({
                where: { novelId },
                include: { points: { include: { anchors: true }, orderBy: { order: 'asc' } } },
                orderBy: { sortOrder: 'asc' },
            }),
        ]);

        const narrativeSummaries = narrativeRows.map((item: any) => ({
            id: String(item.id),
            level: (item.level === 'volume' ? 'volume' : 'novel') as 'volume' | 'novel',
            ...(item.volumeId ? { volumeId: String(item.volumeId) } : {}),
            title: String(item.title || ''),
            summaryText: (isSemanticChapterSummary(item) ? '' : '[本地拼接摘录，非完整情节摘要]\n') + String(item.summaryText || '').slice(0, 4000),
            keyFacts: isSemanticChapterSummary(item) ? parseJsonArray(item.keyFacts, 20).map(String) : [],
            unresolvedThreads: isSemanticChapterSummary(item) ? parseJsonArray(item.unresolvedThreads, 20).map(String) : [],
            sourceFingerprint: String(item.sourceFingerprint || ''),
        }));
        const stateLedger: NarrativeStateLedger = {
            entities: {},
            timelineHints: [],
            openQuestions: [],
            unresolvedThreads: narrativeSummaries.flatMap((item: any) => item.unresolvedThreads).slice(0, 100),
        };
        return { narrativeSummaries, entityContext: { characters, items, worldSettings, maps },
            plotContext: { plotlines }, stateLedger };
    }

    async buildForCreativeAssets(payload: CreativeAssetsGeneratePayload): Promise<CreativeAssetsContext> {
        const includeEntities = payload.includeExistingEntities !== false;
        const contextChapterCount = Math.max(0, Math.min(8, payload.contextChapterCount ?? 0));
        const filterCompleted = payload.filterCompletedPlotLines !== false;
        const warnings: string[] = [];

        const [characters, items, plotLines, worldSettings, recentChapters, narrativeSummariesRaw] = await Promise.all([
            includeEntities
                ? (db as any).character.findMany({
                    where: { novelId: payload.novelId },
                    select: { name: true, role: true, description: true },
                    orderBy: { updatedAt: 'desc' },
                    take: 30,
                })
                : [],
            includeEntities
                ? (db as any).item.findMany({
                    where: { novelId: payload.novelId },
                    select: { name: true, type: true, description: true },
                    orderBy: { updatedAt: 'desc' },
                    take: 30,
                })
                : [],
            includeEntities
                ? (db as any).plotLine.findMany({
                    where: { novelId: payload.novelId },
                    include: {
                        points: {
                            select: { title: true, status: true, description: true },
                            orderBy: { order: 'asc' },
                        },
                    },
                    orderBy: { sortOrder: 'asc' },
                })
                : [],
            // 世界观始终全量传递
            (db as any).worldSetting.findMany({
                where: { novelId: payload.novelId },
                select: { name: true, content: true, type: true },
                orderBy: { sortOrder: 'asc' },
            }),
            contextChapterCount > 0
                ? db.chapter.findMany({
                    where: { volume: { novelId: payload.novelId } },
                    select: { id: true, title: true, content: true, updatedAt: true },
                    orderBy: { updatedAt: 'desc' },
                    take: contextChapterCount,
                })
                : [],
            (db as any).narrativeSummary.findMany({
                where: {
                    novelId: payload.novelId,
                    isLatest: true,
                    status: 'active',
                    level: 'novel',
                },
                orderBy: { updatedAt: 'desc' },
                take: 1,
            }),
        ]);

        // 处理情节线：可选过滤已完成的情节点
        const processedPlotLines = plotLines.map((pl: any) => {
            const points = Array.isArray(pl.points) ? pl.points : [];
            const filteredPoints = filterCompleted
                ? points.filter((p: any) => p.status !== 'resolved')
                : points;
            return {
                name: String(pl.name || ''),
                description: pl.description ? String(pl.description) : undefined,
                points: filteredPoints.map((p: any) => ({
                    title: String(p.title || ''),
                    status: String(p.status || 'active'),
                })),
            };
        });

        // 获取章节摘要
        const recentChapterIds = recentChapters.map((ch: any) => ch.id);
        const chapterSummaries = recentChapterIds.length > 0
            ? await (db as any).chapterSummary.findMany({
                where: {
                    chapterId: { in: recentChapterIds },
                    isLatest: true,
                    status: 'active',
                },
                orderBy: { updatedAt: 'desc' },
            })
            : [];
        const summaryByChapterId = new Map<string, any>();
        for (const s of chapterSummaries) {
            if (!summaryByChapterId.has(s.chapterId)) {
                summaryByChapterId.set(s.chapterId, s);
            }
        }

        let fallbackCount = 0;
        const recentSummaries = recentChapters.map((ch: any) => {
            const summary = summaryByChapterId.get(ch.id);
            const summaryText = summary?.compressedMemory || summary?.summaryText;
            if (typeof summaryText === 'string' && summaryText.trim()) {
                return { chapterId: ch.id, title: ch.title || '', summary: summaryText.slice(0, 800) };
            }
            fallbackCount++;
            return {
                chapterId: ch.id,
                title: ch.title || '',
                summary: extractPlainTextFromLexical(ch.content || '').slice(0, 600),
            };
        });
        if (fallbackCount > 0) {
            warnings.push(`${fallbackCount} 个章节缺少摘要，已使用原文摘录替代。`);
        }

        // 叙事摘要
        const narrativeSummaries = narrativeSummariesRaw.map((item: any) => {
            let keyFacts: string[] = [];
            if (typeof item.keyFacts === 'string' && item.keyFacts.trim()) {
                try {
                    const parsed = JSON.parse(item.keyFacts);
                    if (Array.isArray(parsed)) {
                        keyFacts = uniqueArray(
                            parsed.map((f: any) => String(f || '').trim()).filter(Boolean).slice(0, 12),
                        ).slice(0, 8);
                    }
                } catch { /* ignore */ }
            }
            return {
                level: (item.level === 'volume' ? 'volume' : 'novel') as 'volume' | 'novel',
                title: String(item.title || ''),
                summaryText: String(item.summaryText || '').slice(0, 1500),
                keyFacts,
            };
        });

        const existingEntities = {
            characters: characters.map((c: any) => ({
                name: String(c.name || ''),
                role: c.role ? String(c.role) : undefined,
                description: c.description ? String(c.description).slice(0, 200) : undefined,
            })),
            items: items.map((i: any) => ({
                name: String(i.name || ''),
                type: i.type ? String(i.type) : undefined,
                description: i.description ? String(i.description).slice(0, 200) : undefined,
            })),
            plotLines: processedPlotLines,
            worldSettings: worldSettings.map((w: any) => ({
                name: String(w.name || ''),
                content: String(w.content || ''),
                type: String(w.type || 'other'),
            })),
        };

        // 估算 Token 总量
        const contextJson = JSON.stringify({ existingEntities, recentSummaries, narrativeSummaries });
        const estimatedTokens = estimateTokenCount(contextJson);

        const usedContext: string[] = [];
        if (existingEntities.characters.length > 0) usedContext.push(`characters_${existingEntities.characters.length}`);
        if (existingEntities.items.length > 0) usedContext.push(`items_${existingEntities.items.length}`);
        if (existingEntities.plotLines.length > 0) usedContext.push(`plotLines_${existingEntities.plotLines.length}`);
        usedContext.push(`worldSettings_${existingEntities.worldSettings.length}`);
        if (recentSummaries.length > 0) usedContext.push(`recentChapterSummaries_${recentSummaries.length}`);
        if (narrativeSummaries.length > 0) usedContext.push(`narrativeSummaries_${narrativeSummaries.length}`);
        usedContext.push(`estimatedTokens_${estimatedTokens}`);

        return {
            existingEntities,
            recentSummaries,
            narrativeSummaries,
            usedContext,
            warnings,
            estimatedTokens,
        };
    }

    private async buildForOutlineRewrite(payload: ContinueWritingPayload): Promise<ContinueWritingContext> {
        // Validate ownership without reading prose. Draft commit keeps its own source-version snapshot.
        const chapter = await db.chapter.findUnique({where: {id: payload.chapterId},
            select: {id: true, deleted: true, volume: {select: {novelId: true}}}});
        if (!chapter || chapter.deleted || chapter.volume.novelId !== payload.novelId) {
            throw new Error('Current chapter does not belong to novel');
        }
        const novel = await db.novel.findUnique({where: {id: payload.novelId}, select: {formatting: true}});
        const novelDefault = novelChapterLength(novel?.formatting);
        const lengthTarget = resolveWritingLength({...payload, novelDefault});
        const excluded = uniqueArray(payload.excludedWorldSettingIds || []);
        const [worldSettings, plotLines, characters, items, maps] = await Promise.all([
            db.worldSetting.findMany({where: {novelId: payload.novelId, ...(excluded.length ? {id: {notIn: excluded}} : {})},
                select: {id: true, name: true, type: true, content: true}, orderBy: {sortOrder: 'asc'}}),
            db.plotLine.findMany({where: {novelId: payload.novelId}, select: {id: true, name: true, description: true,
                points: {select: {title: true, description: true, type: true}, orderBy: {order: 'asc'}}}, orderBy: {sortOrder: 'asc'}}),
            db.character.findMany({where: {novelId: payload.novelId}, select: {id: true, name: true, role: true, description: true},
                orderBy: {updatedAt: 'desc'}, take: 100}),
            db.item.findMany({where: {novelId: payload.novelId}, select: {id: true, name: true, type: true, description: true},
                orderBy: {updatedAt: 'desc'}, take: 100}),
            db.mapCanvas.findMany({where: {novelId: payload.novelId}, select: {id: true, name: true, type: true, description: true},
                orderBy: {updatedAt: 'desc'}, take: 50}),
        ]);
        const hardContext = {worldSettings, characters, items, maps,
            plotLines: plotLines.map(line => ({...line, points: line.points.map(point => ({...point, status: 'planned'}))}))};
        const policy: ContinuationContextPolicy = {version: 'continuation-context-v1', sourcePolicy: 'outline_only',
            summaryChapterCount: 0, fullTextChapterCount: 0, maxFullTextChars: 0, maxSummaryChars: 0, maxCurrentContentChars: 0};
        return {generationPolicyVersion: 2, currentContentSource: '', hardContext,
            dynamicContext: {recentChapters: [], selectedIdeas: [], selectedIdeaEntities: [],
                currentChapterBeforeCursor: '', narrativeSummaries: []},
            params: {mode: 'rewrite_chapter', contextChapterCount: 0, targetLength: lengthTarget.target,
                novelChapterLength: novelDefault, style: payload.style || 'default', tone: payload.tone || 'balanced', pace: payload.pace || 'medium'},
            policy, snapshot: {policy, scopeId: randomUUID(), novelId: payload.novelId, anchorChapterId: payload.chapterId,
                chapterSources: [], narrativeSummaryIds: [], estimatedTokens: estimateTokenCount(JSON.stringify(hardContext)),
                createdAt: new Date().toISOString()},
            usedContext: ['outline_only', 'plot_outline_as_plan', 'characters_items_maps_snapshot',
                ...worldSettings.map(setting => `world_setting_${setting.id}`)],
            warnings: ['仅按大纲和设定重新创作：未加载任何旧章正文、章节摘要、卷/全书摘要、旧节拍或会话背景。',
                ...(excluded.length ? [`本次排除世界设定：${excluded.join(', ')}`] : [])],
        };
    }

    async buildForContinueWriting(payload: ContinueWritingPayload): Promise<ContinueWritingContext> {
        payload = prepareChapterWritingPayload(payload);
        if (payload.sourcePolicy === 'outline_only') return this.buildForOutlineRewrite(payload);
        const novel = await db.novel.findUnique({ where: { id: payload.novelId }, select: { formatting: true } });
        const novelDefault = novelChapterLength(novel?.formatting);
        const lengthTarget = resolveWritingLength({ ...payload, novelDefault });
        const summaryChapterCount = Math.max(1, Math.min(20, payload.contextChapterCount ?? 8));
        const recentRawChapterCount = Math.max(1, Math.min(3, payload.recentRawChapterCount ?? 2));
        const previousChapterCount = summaryChapterCount + recentRawChapterCount;
        const policy: ContinuationContextPolicy = {
            version: 'continuation-context-v1',
            summaryChapterCount,
            fullTextChapterCount: recentRawChapterCount,
            maxFullTextChars: 12000,
            maxSummaryChars: 2400,
            maxCurrentContentChars: 12000,
        };
        const volumes = await (db as any).volume.findMany({
            where: { novelId: payload.novelId, deleted: false },
            select: {
                id: true,
                order: true,
                chapters: {
                    where: { deleted: false },
                    select: { id: true, volumeId: true, title: true, order: true },
                    orderBy: { order: 'asc' },
                },
            },
            orderBy: { order: 'asc' },
        });
        const orderedChapters = volumes.flatMap((volume: any) =>
            (volume.chapters || []).map((chapter: any) => ({
                ...chapter,
                volumeOrder: Number(volume.order || 0),
            })),
        );
        const anchorIndex = orderedChapters.findIndex((chapter: any) => String(chapter.id) === payload.chapterId);
        if (anchorIndex < 0) throw new Error('Current chapter does not belong to novel');
        let previousMetadata = orderedChapters.slice(Math.max(0, anchorIndex - previousChapterCount), anchorIndex);
        const currentContentSource = payload.currentContent || String((await db.chapter.findUnique({
            where: { id: payload.chapterId },
            select: { content: true },
        }))?.content || '');
        const forcedPriorContextChapter = !extractPlainTextFromLexical(currentContentSource).trim()
            ? await this.findNearestPreviousChapterWithContent(orderedChapters, anchorIndex)
            : null;
        if (
            forcedPriorContextChapter
            && !previousMetadata.some((chapter: any) => String(chapter.id) === String(forcedPriorContextChapter.id))
        ) {
            previousMetadata = [forcedPriorContextChapter, ...previousMetadata];
        }
        const scopeChapterIds = uniqueArray([...previousMetadata.map((chapter: any) => String(chapter.id)), payload.chapterId]);
        const scopeBundle = await this.buildForChapterScope({
            novelId: payload.novelId,
            kind: 'selected_chapters',
            chapterIds: scopeChapterIds,
            anchorChapterId: payload.chapterId,
            processingMode: 'detailed',
            currentContent: payload.currentContent,
            maxDetailedChapters: 20,
            maxEstimatedTokens: 120000,
        });
        // The approved lookback is bounded. Keep the actual ending available for
        // excerpt fallback even when the scope view trimmed a long chapter.
        const rawChapterIds = previousMetadata.map((chapter: any) => String(chapter.id));
        const rawChapterRows = rawChapterIds.length > 0
            ? await db.chapter.findMany({
                where: { id: { in: rawChapterIds }, deleted: false },
                select: { id: true, content: true },
            })
            : [];
        const rawContentByChapterId = new Map(
            rawChapterRows.map((chapter: any) => [String(chapter.id), extractPlainTextFromLexical(String(chapter.content || ''))]),
        );
        const worldSettings = scopeBundle.entityContext.worldSettings;
        const plotLines = scopeBundle.plotContext.plotlines;
        const characters = scopeBundle.entityContext.characters;
        const items = scopeBundle.entityContext.items;
        const maps = scopeBundle.entityContext.maps;
        const requestedIdeaIds = Array.isArray(payload.ideaIds)
            ? payload.ideaIds.map((id) => String(id)).filter(Boolean)
            : [];
        const selectedIdeasRaw = requestedIdeaIds.length > 0
            ? await db.idea.findMany({
                where: {
                    novelId: payload.novelId,
                    id: { in: requestedIdeaIds },
                },
                include: { tags: true },
                orderBy: { updatedAt: 'desc' },
                take: 20,
            })
            : [];

        const narrativeEntries = distinctNarrativeMemories(scopeBundle.narrativeSummaries);
        const narrativeSummaries = narrativeEntries.map((item) => ({
            level: item.level,
            title: item.title,
            summaryText: item.summaryText.slice(0, 1200),
            keyFacts: item.keyFacts.slice(0, 5),
        }));
        const priorChapters = scopeBundle.chapters.filter((chapter) => chapter.chapterId !== payload.chapterId);
        const fullTextStart = Math.max(0, priorChapters.length - recentRawChapterCount);
        let fallbackCount = 0;
        const recentChapterItems = priorChapters.map((chapter, index) => {
            const useFullText = index >= fullTextStart;
            if (useFullText) {
                const rawContent = rawContentByChapterId.get(chapter.chapterId) || chapter.content;
                const isTruncated = rawContent.length > policy.maxFullTextChars;
                return {
                    chapterId: chapter.chapterId,
                    title: chapter.title,
                    excerpt: rawContent.slice(-policy.maxFullTextChars),
                    contentMode: (isTruncated ? 'truncated' : 'full') as 'truncated' | 'full',
                };
            }
            if (chapter.summaryFresh && chapter.summaryContent?.trim()) {
                return {
                    chapterId: chapter.chapterId,
                    title: chapter.title,
                    excerpt: chapter.summaryContent.slice(0, policy.maxSummaryChars),
                    contentMode: 'summary' as const,
                };
            }
            fallbackCount += 1;
            return {
                chapterId: chapter.chapterId,
                title: chapter.title,
                excerpt: chapterMemoryExcerpt(rawContentByChapterId.get(chapter.chapterId) || chapter.content, Math.min(policy.maxSummaryChars, 1200)),
                contentMode: 'excerpt' as const,
            };
        });

        const anchorChapter = scopeBundle.chapters.find((chapter) => chapter.chapterId === payload.chapterId);
        const currentChapterBeforeCursor = extractPlainTextFromLexical(currentContentSource || anchorChapter?.content || '')
            .slice(-policy.maxCurrentContentChars);
        const selectedIdeas = selectedIdeasRaw.map((idea: any) => ({
            ideaId: idea.id,
            content: (idea.content || '').slice(0, 800),
            quote: typeof idea.quote === 'string' ? idea.quote.slice(0, 300) : undefined,
            tags: Array.isArray(idea.tags) ? idea.tags.map((tag: any) => String(tag.name || '').trim()).filter(Boolean).slice(0, 12) : [],
        }));
        const entityIndex = {
            characters: new Set(
                characters
                    .map((item: any) => String(item?.name || '').trim())
                    .filter(Boolean),
            ),
            items: new Set(
                items
                    .map((item: any) => String(item?.name || '').trim())
                    .filter(Boolean),
            ),
            worldSettings: new Set(
                worldSettings
                    .map((item: any) => String(item?.name || '').trim())
                    .filter(Boolean),
            ),
        };
        const entityMatches: Array<{ name: string; kind: 'character' | 'item' | 'worldSetting' }> = [];
        const mentionRegex = /@([^\s@，。！？,!.;；:："'""''()\[\]{}<>]+)/g;
        for (const idea of selectedIdeas) {
            const text = `${idea.content || ''}\n${idea.quote || ''}`;
            const hits = Array.from(text.matchAll(mentionRegex));
            for (const hit of hits) {
                const name = String(hit[1] || '').trim();
                if (!name) continue;
                if (entityIndex.characters.has(name)) {
                    entityMatches.push({ name, kind: 'character' });
                } else if (entityIndex.items.has(name)) {
                    entityMatches.push({ name, kind: 'item' });
                } else if (entityIndex.worldSettings.has(name)) {
                    entityMatches.push({ name, kind: 'worldSetting' });
                }
            }
        }
        const selectedIdeaEntities = uniqueArray(entityMatches.map((item) => `${item.kind}:${item.name}`))
            .map((encoded) => {
                const [kind, ...nameRest] = encoded.split(':');
                const name = nameRest.join(':');
                return {
                    name,
                    kind: (kind === 'character' || kind === 'item' || kind === 'worldSetting')
                        ? kind
                        : 'character',
                } as { name: string; kind: 'character' | 'item' | 'worldSetting' };
            })
            .slice(0, 20);
        const currentLocation = String(payload.currentLocation || '').trim().slice(0, 120);
        const missingIdeaCount = Math.max(0, requestedIdeaIds.length - selectedIdeas.length);
        const warnings = [...scopeBundle.warnings];
        if (fallbackCount > 0) {
            warnings.push(`${fallbackCount} 章无可用语义摘要（缺失、过期或仅为本地摘录），已使用含末段的原文摘录；未验证完整情节状态。`);
        }
        if (missingIdeaCount > 0) {
            warnings.push(`${missingIdeaCount} selected ideas not found; ignored.`);
        }

        const sourceByChapterId = new Map(scopeBundle.sourceSnapshot.map((source) => [source.chapterId, source]));
        const chapterItemById = new Map(scopeBundle.chapters.map((chapter) => [chapter.chapterId, chapter]));
        const contextModeById = new Map(recentChapterItems.map((chapter) => [chapter.chapterId, chapter.contentMode]));
        const snapshot: ContinuationContextSnapshot = {
            policy,
            scopeId: scopeBundle.scope.scopeId,
            novelId: payload.novelId,
            anchorChapterId: payload.chapterId,
            chapterSources: scopeChapterIds.flatMap((chapterId) => {
                const source = sourceByChapterId.get(chapterId);
                const chapter = chapterItemById.get(chapterId);
                if (!source || !chapter || chapter.contentMode === 'catalog') return [];
                const isAnchor = chapterId === payload.chapterId;
                return [{
                    ...source,
                    volumeId: chapter.volumeId,
                    title: chapter.title,
                    order: chapter.order,
                    volumeOrder: chapter.volumeOrder,
                    contentMode: isAnchor ? chapter.contentMode : (contextModeById.get(chapterId) || 'excerpt'),
                    ...(chapter.summaryId ? { summaryId: chapter.summaryId } : {}),
                    summaryFresh: chapter.summaryFresh,
                }];
            }),
            narrativeSummaryIds: narrativeEntries.map((item) => item.id),
            estimatedTokens: estimateTokenCount(JSON.stringify({
                recentChapterItems,
                currentChapterBeforeCursor,
                narrativeSummaries,
                hardContext: { worldSettings, plotLines, characters, items, maps },
            })),
            createdAt: new Date().toISOString(),
        };
        return {
            currentContentSource,
            generationPolicyVersion: 2,
            hardContext: {
                worldSettings,
                plotLines,
                characters,
                items,
                maps,
            },
            dynamicContext: {
                recentChapters: recentChapterItems,
                selectedIdeas,
                selectedIdeaEntities,
                currentChapterBeforeCursor,
                ...(currentLocation ? { currentLocation } : {}),
                narrativeSummaries,
            },
            params: {
                mode: payload.mode === 'new_chapter' ? 'new_chapter' : 'continue_chapter',
                contextChapterCount: summaryChapterCount,
                style: payload.style || 'default',
                tone: payload.tone || 'balanced',
                pace: payload.pace || 'medium',
                targetLength: lengthTarget.target,
                novelChapterLength: novelDefault,
            },
            policy,
            snapshot,
            usedContext: [
                'world_settings_full',
                'plot_outline_full',
                'characters_items_maps_snapshot',
                `ordered_previous_chapters_${recentChapterItems.length}`,
                `previous_chapter_summaries_${recentChapterItems.filter((item) => item.contentMode === 'summary').length}`,
                `previous_chapter_full_text_${recentChapterItems.filter((item) => item.contentMode === 'full' || item.contentMode === 'truncated').length}`,
                ...(forcedPriorContextChapter ? [`nearest_written_prior_chapter_${String(forcedPriorContextChapter.id || '')}`] : []),
                narrativeSummaries.length > 0 ? `narrative_summaries_${narrativeSummaries.length}` : 'narrative_summaries_0',
                selectedIdeas.length > 0 ? `selected_ideas_${selectedIdeas.length}` : 'selected_ideas_0',
                selectedIdeaEntities.length > 0 ? `selected_idea_entities_${selectedIdeaEntities.length}` : 'selected_idea_entities_0',
                ...(currentLocation ? ['current_location'] : []),
                'current_chapter_before_cursor',
                policy.version,
            ],
            warnings,
        };
    }
}
