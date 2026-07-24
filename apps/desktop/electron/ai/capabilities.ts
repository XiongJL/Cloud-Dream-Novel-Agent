import { db } from '@novel-editor/core';
import * as searchIndex from '../search/searchIndex';
import { AiActionError, normalizeAiError } from './errors';
import { scheduleChapterSummaryRebuild } from './summary/chapterSummary';
import type { AgentChapterScopeBuildPayload, ChapterScopeBundle } from '../../shared/agentChapterScope';
import type { ContinueWritingContext } from './context/ContextBuilder';
import type { ContinueWritingPayload } from './types';

export type CapabilityPermission = 'read' | 'write' | 'destructive';
export type CapabilityHandler = (payload?: unknown) => Promise<unknown>;

export interface CapabilityDefinition {
    actionId: string;
    title: string;
    description: string;
    permission: CapabilityPermission;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    handler: CapabilityHandler;
}

export interface CapabilityDeps {
    buildChapterScopeContext: (payload: AgentChapterScopeBuildPayload) => Promise<ChapterScopeBundle>;
    buildContinuationContext: (payload: ContinueWritingPayload) => Promise<ContinueWritingContext>;
    continueWriting: (payload: {
        locale?: string;
        mode?: 'new_chapter' | 'continue_chapter';
        novelId: string;
        chapterId: string;
        currentContent: string;
        ideaIds?: string[];
        contextChapterCount?: number;
        recentRawChapterCount?: number;
        targetLength?: number;
        style?: string;
        tone?: string;
        pace?: string;
        temperature?: number;
        userIntent?: string;
        currentLocation?: string;
        overrideUserPrompt?: string;
    }) => Promise<{ text: string; usedContext: string[]; consistency: { ok: boolean; issues: string[] } }>;
    askNovel: (payload: {
        novelId: string;
        question: string;
        chapterId?: string;
        currentContent?: string;
        selectedText?: string;
        currentLocation?: string;
        locale?: string;
        maxEvidenceItems?: number;
        overrideUserPrompt?: string;
    }) => Promise<unknown>;
    rebuildRagIndex: (novelId: string) => Promise<unknown>;
}

export function createCapabilityDefinitions(deps: CapabilityDeps): CapabilityDefinition[] {
    return [
        {
            actionId: 'novel.list',
            title: 'List novels',
            description: 'Return novels sorted by update time.',
            permission: 'read',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'array' },
            handler: async () => db.novel.findMany({ orderBy: { updatedAt: 'desc' } }),
        },
        {
            actionId: 'volume.list',
            title: 'List volumes',
            description: 'Return all volumes and chapter summaries under a novel.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                },
                required: ['novelId'],
            },
            outputSchema: { type: 'array' },
            handler: async (payload) => {
                const input = payload as { novelId?: string };
                if (!input?.novelId) {
                    throw new AiActionError('INVALID_INPUT', 'novelId is required');
                }

                return db.volume.findMany({
                    where: { novelId: input.novelId },
                    include: {
                        chapters: {
                            select: { id: true, title: true, order: true, wordCount: true, updatedAt: true },
                            orderBy: { order: 'asc' },
                        },
                    },
                    orderBy: { order: 'asc' },
                });
            },
        },
        {
            actionId: 'novel.create',
            title: 'Create novel',
            description: 'Create a novel with default volume/chapter.',
            permission: 'write',
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                },
                required: [],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => {
                const input = payload as { title?: string };
                const title = input?.title?.trim() || `新作品 ${new Date().toLocaleTimeString()}`;

                return db.novel.create({
                    data: {
                        title,
                        wordCount: 0,
                        volumes: {
                            create: {
                                title: '',
                                order: 1,
                                chapters: {
                                    create: {
                                        title: '',
                                        content: '',
                                        order: 1,
                                        wordCount: 0,
                                    },
                                },
                            },
                        },
                    },
                });
            },
        },
        {
            actionId: 'chapter.list',
            title: 'List chapters',
            description: 'Return chapters under a volume in ascending order.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    volumeId: { type: 'string' },
                    offset: { type: 'number' },
                    limit: { type: 'number' },
                    includeContent: { type: 'boolean' },
                },
                required: ['volumeId'],
            },
            outputSchema: { type: 'array' },
            handler: async (payload) => {
                const input = payload as { volumeId?: string; offset?: number; limit?: number; includeContent?: boolean };
                if (!input?.volumeId) {
                    throw new AiActionError('INVALID_INPUT', 'volumeId is required');
                }
                const paginated = Number.isFinite(input.offset) || Number.isFinite(input.limit) || input.includeContent === false;
                if (!paginated) {
                    return db.chapter.findMany({
                        where: { volumeId: input.volumeId },
                        orderBy: { order: 'asc' },
                    });
                }
                const offset = Math.max(0, Math.floor(input.offset ?? 0));
                const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 20)));
                if (input.includeContent === false) {
                    return db.chapter.findMany({
                        where: { volumeId: input.volumeId },
                        select: {
                            id: true,
                            volumeId: true,
                            title: true,
                            order: true,
                            wordCount: true,
                            updatedAt: true,
                        },
                        orderBy: { order: 'asc' },
                        skip: offset,
                        take: limit,
                    });
                }
                return db.chapter.findMany({
                    where: { volumeId: input.volumeId },
                    orderBy: { order: 'asc' },
                    skip: offset,
                    take: limit,
                });
            },
        },
        {
            actionId: 'chapter.create',
            title: 'Create chapter',
            description: 'Create a chapter under volume with auto order fallback.',
            permission: 'write',
            inputSchema: {
                type: 'object',
                properties: {
                    volumeId: { type: 'string' },
                    title: { type: 'string' },
                    order: { type: 'number' },
                },
                required: ['volumeId'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => {
                const input = payload as { volumeId?: string; title?: string; order?: number };
                if (!input?.volumeId) {
                    throw new AiActionError('INVALID_INPUT', 'volumeId is required');
                }

                let finalOrder = input.order;
                if (!Number.isFinite(finalOrder)) {
                    const lastChapter = await db.chapter.findFirst({
                        where: { volumeId: input.volumeId },
                        orderBy: { order: 'desc' },
                    });
                    finalOrder = (lastChapter?.order || 0) + 1;
                }

                return db.chapter.create({
                    data: {
                        volumeId: input.volumeId,
                        title: input.title?.trim() || '',
                        order: finalOrder!,
                        content: '',
                        wordCount: 0,
                    },
                });
            },
        },
        {
            actionId: 'chapter.get',
            title: 'Get chapter',
            description: 'Return chapter content by chapter id.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    chapterId: { type: 'string' },
                },
                required: ['chapterId'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => {
                const input = payload as { chapterId?: string };
                if (!input?.chapterId) {
                    throw new AiActionError('INVALID_INPUT', 'chapterId is required');
                }

                return db.chapter.findUnique({
                    where: { id: input.chapterId },
                    include: { volume: { select: { novelId: true } } },
                });
            },
        },
        {
            actionId: 'chapter.scope_context.build',
            title: 'Build chapter scope context',
            description: 'Resolve an approved chapter scope and return an ordered, versioned context bundle.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    scopeId: { type: 'string' },
                    novelId: { type: 'string' },
                    kind: {
                        type: 'string',
                        enum: ['current_chapter', 'selected_chapters', 'chapter_range', 'current_volume', 'novel'],
                    },
                    volumeId: { type: 'string' },
                    chapterId: { type: 'string' },
                    chapterIds: { type: 'array', items: { type: 'string' } },
                    anchorChapterId: { type: 'string' },
                    processingMode: { type: 'string', enum: ['detailed', 'batched'] },
                    currentContent: { type: 'string' },
                    goal: { type: 'string' },
                    locale: { type: 'string' },
                    batchSize: { type: 'number', minimum: 1, maximum: 10 },
                    maxDetailedChapters: { type: 'number', minimum: 1, maximum: 20 },
                    maxEstimatedTokens: { type: 'number', minimum: 4000, maximum: 200000 },
                },
                required: ['novelId'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => deps.buildChapterScopeContext(payload as AgentChapterScopeBuildPayload),
        },
        {
            actionId: 'chapter.continuation_context.build',
            title: 'Build continuation context',
            description: 'Build the ordered, layered and versioned context used by chapter continuation.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                    chapterId: { type: 'string' },
                    currentContent: { type: 'string' },
                    ideaIds: { type: 'array', items: { type: 'string' } },
                    contextChapterCount: { type: 'number', minimum: 1, maximum: 20 },
                    recentRawChapterCount: { type: 'number', minimum: 1, maximum: 3 },
                    targetLength: { type: 'number', minimum: 100 },
                    style: { type: 'string' },
                    tone: { type: 'string' },
                    pace: { type: 'string' },
                    userIntent: { type: 'string' },
                    currentLocation: { type: 'string' },
                    locale: { type: 'string' },
                },
                required: ['novelId', 'chapterId'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => deps.buildContinuationContext(payload as ContinueWritingPayload),
        },
        {
            actionId: 'chapter.save',
            title: 'Save chapter content',
            description: 'Persist chapter content and keep novel word count in sync.',
            permission: 'write',
            inputSchema: {
                type: 'object',
                properties: {
                    chapterId: { type: 'string' },
                    content: { type: 'string' },
                    source: {
                        type: 'string',
                        enum: ['ai_agent', 'ai_ui'],
                    },
                },
                required: ['chapterId', 'content'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => {
                const input = payload as { chapterId?: string; content?: string; source?: 'ai_agent' | 'ai_ui' };
                if (!input?.chapterId) {
                    throw new AiActionError('INVALID_INPUT', 'chapterId is required');
                }
                if (typeof input.content !== 'string') {
                    throw new AiActionError('INVALID_INPUT', 'content is required');
                }
                const saveSource: 'ai_agent' | 'ai_ui' = input.source === 'ai_ui' ? 'ai_ui' : 'ai_agent';

                const chapter = await db.chapter.findUnique({
                    where: { id: input.chapterId },
                    select: { id: true, content: true, updatedAt: true, wordCount: true, volume: { select: { novelId: true } } },
                });
                if (!chapter || !chapter.volume) {
                    throw new AiActionError('NOT_FOUND', 'Chapter or volume not found');
                }

                const newWordCount = input.content.length;
                const delta = newWordCount - chapter.wordCount;

                try {
                    const [, updatedChapter] = await db.$transaction([
                        db.novel.update({
                            where: { id: chapter.volume.novelId },
                            data: { wordCount: { increment: delta }, updatedAt: new Date() },
                        }),
                        db.chapter.update({
                            where: { id: input.chapterId },
                            data: { content: input.content, wordCount: newWordCount, updatedAt: new Date() },
                        }),
                    ]);

                    scheduleChapterSummaryRebuild(input.chapterId);

                    return {
                        chapter: updatedChapter,
                        saveMeta: {
                            source: saveSource,
                            rollbackPoint: {
                                chapterId: chapter.id,
                                content: chapter.content,
                                updatedAt: chapter.updatedAt,
                            },
                        },
                    };
                } catch (error) {
                    const normalized = normalizeAiError(error);
                    throw new AiActionError('PERSISTENCE_ERROR', normalized.message);
                }
            },
        },
        {
            actionId: 'chapter.generate',
            title: 'Generate chapter draft',
            description: 'Generate chapter continuation with strict lore/outline context via configured model provider.',
            permission: 'write',
            inputSchema: {
                type: 'object',
                properties: {
                    locale: { type: 'string' },
                    mode: {
                        type: 'string',
                        enum: ['new_chapter', 'continue_chapter'],
                    },
                    novelId: { type: 'string' },
                    chapterId: { type: 'string' },
                    currentContent: { type: 'string' },
                    ideaIds: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                    contextChapterCount: { type: 'number' },
                    recentRawChapterCount: { type: 'number' },
                    targetLength: { type: 'number' },
                    style: { type: 'string' },
                    tone: { type: 'string' },
                    pace: { type: 'string' },
                    temperature: { type: 'number' },
                    userIntent: { type: 'string' },
                    currentLocation: { type: 'string' },
                    overrideUserPrompt: { type: 'string' },
                },
                required: ['novelId', 'chapterId', 'currentContent'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => {
                const input = payload as {
                    locale?: string;
                    mode?: 'new_chapter' | 'continue_chapter';
                    novelId?: string;
                    chapterId?: string;
                    currentContent?: string;
                    ideaIds?: string[];
                    contextChapterCount?: number;
                    recentRawChapterCount?: number;
                    targetLength?: number;
                    style?: string;
                    tone?: string;
                    pace?: string;
                    temperature?: number;
                    userIntent?: string;
                    currentLocation?: string;
                    overrideUserPrompt?: string;
                };
                if (!input?.novelId || !input.chapterId || typeof input.currentContent !== 'string') {
                    throw new AiActionError('INVALID_INPUT', 'novelId, chapterId, currentContent are required');
                }
                try {
                    return await deps.continueWriting({
                        locale: input.locale,
                        mode: input.mode,
                        novelId: input.novelId,
                        chapterId: input.chapterId,
                        currentContent: input.currentContent,
                        ideaIds: Array.isArray(input.ideaIds) ? input.ideaIds : undefined,
                        contextChapterCount: input.contextChapterCount,
                        recentRawChapterCount: input.recentRawChapterCount,
                        targetLength: input.targetLength,
                        style: input.style,
                        tone: input.tone,
                        pace: input.pace,
                        temperature: input.temperature,
                        userIntent: input.userIntent,
                        currentLocation: input.currentLocation,
                        overrideUserPrompt: input.overrideUserPrompt,
                    });
                } catch (error) {
                    throw normalizeAiError(error);
                }
            },
        },
        {
            actionId: 'plotline.list',
            title: 'List plot lines',
            description: 'Return all plot lines and points for a novel.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                },
                required: ['novelId'],
            },
            outputSchema: { type: 'array' },
            handler: async (payload) => {
                const input = payload as { novelId?: string };
                if (!input?.novelId) {
                    throw new AiActionError('INVALID_INPUT', 'novelId is required');
                }

                return (db as any).plotLine.findMany({
                    where: { novelId: input.novelId },
                    include: {
                        points: {
                            include: { anchors: true },
                            orderBy: { order: 'asc' },
                        },
                    },
                    orderBy: { sortOrder: 'asc' },
                });
            },
        },
        {
            actionId: 'worldsetting.list',
            title: 'List world settings',
            description: 'Return all world settings under a novel.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                },
                required: ['novelId'],
            },
            outputSchema: { type: 'array' },
            handler: async (payload) => {
                const input = payload as { novelId?: string };
                if (!input?.novelId) {
                    throw new AiActionError('INVALID_INPUT', 'novelId is required');
                }

                return (db as any).worldSetting.findMany({
                    where: { novelId: input.novelId },
                    orderBy: { sortOrder: 'asc' },
                });
            },
        },
        {
            actionId: 'worldsetting.create',
            title: 'Create world setting',
            description: 'Create a world setting under a novel.',
            permission: 'write',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                    name: { type: 'string' },
                    content: { type: 'string' },
                    type: { type: 'string' },
                    icon: { type: 'string' },
                    sortOrder: { type: 'number' },
                },
                required: ['novelId', 'name'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => {
                const input = payload as {
                    novelId?: string;
                    name?: string;
                    content?: string;
                    type?: string;
                    icon?: string;
                    sortOrder?: number;
                };
                const novelId = String(input?.novelId || '').trim();
                const name = String(input?.name || '').trim();
                if (!novelId) {
                    throw new AiActionError('INVALID_INPUT', 'novelId is required');
                }
                if (!name) {
                    throw new AiActionError('INVALID_INPUT', 'name is required');
                }

                let sortOrder = input?.sortOrder;
                if (typeof sortOrder !== 'number' || !Number.isFinite(sortOrder)) {
                    const last = await (db as any).worldSetting.findFirst({
                        where: { novelId },
                        orderBy: { sortOrder: 'desc' },
                    });
                    sortOrder = (last?.sortOrder || 0) + 1;
                }

                const content = typeof input?.content === 'string' ? input.content : '';
                const type = typeof input?.type === 'string' && input.type.trim() ? input.type.trim() : 'other';
                const icon = typeof input?.icon === 'string' && input.icon.trim() ? input.icon.trim() : null;

                return (db as any).worldSetting.create({
                    data: {
                        novelId,
                        name,
                        content,
                        type,
                        icon,
                        sortOrder,
                    },
                });
            },
        },
        {
            actionId: 'worldsetting.update',
            title: 'Update world setting',
            description: 'Update a world setting by id.',
            permission: 'write',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    content: { type: 'string' },
                    type: { type: 'string' },
                    icon: { type: 'string' },
                    sortOrder: { type: 'number' },
                },
                required: ['id'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => {
                const input = payload as {
                    id?: string;
                    name?: string;
                    content?: string;
                    type?: string;
                    icon?: string | null;
                    sortOrder?: number;
                };
                const id = String(input?.id || '').trim();
                if (!id) {
                    throw new AiActionError('INVALID_INPUT', 'id is required');
                }

                const data: Record<string, unknown> = {};
                if (Object.prototype.hasOwnProperty.call(input, 'name')) {
                    const nextName = String(input?.name || '').trim();
                    if (!nextName) {
                        throw new AiActionError('INVALID_INPUT', 'name cannot be empty');
                    }
                    data.name = nextName;
                }
                if (Object.prototype.hasOwnProperty.call(input, 'content')) {
                    data.content = typeof input?.content === 'string' ? input.content : '';
                }
                if (Object.prototype.hasOwnProperty.call(input, 'type')) {
                    data.type = typeof input?.type === 'string' && input.type.trim() ? input.type.trim() : 'other';
                }
                if (Object.prototype.hasOwnProperty.call(input, 'icon')) {
                    if (input?.icon === null) {
                        data.icon = null;
                    } else {
                        data.icon = typeof input?.icon === 'string' && input.icon.trim() ? input.icon.trim() : null;
                    }
                }
                if (Object.prototype.hasOwnProperty.call(input, 'sortOrder')) {
                    if (typeof input?.sortOrder !== 'number' || !Number.isFinite(input.sortOrder)) {
                        throw new AiActionError('INVALID_INPUT', 'sortOrder must be a finite number');
                    }
                    data.sortOrder = input.sortOrder;
                }
                if (Object.keys(data).length === 0) {
                    throw new AiActionError('INVALID_INPUT', 'At least one updatable field is required');
                }

                return (db as any).worldSetting.update({
                    where: { id },
                    data,
                });
            },
        },
        {
            actionId: 'character.list',
            title: 'List characters',
            description: 'Return all characters under a novel.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                },
                required: ['novelId'],
            },
            outputSchema: { type: 'array' },
            handler: async (payload) => {
                const input = payload as { novelId?: string };
                if (!input?.novelId) {
                    throw new AiActionError('INVALID_INPUT', 'novelId is required');
                }

                return (db as any).character.findMany({
                    where: { novelId: input.novelId },
                    orderBy: { sortOrder: 'asc' },
                });
            },
        },
        {
            actionId: 'item.list',
            title: 'List items',
            description: 'Return all items and skills under a novel.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                },
                required: ['novelId'],
            },
            outputSchema: { type: 'array' },
            handler: async (payload) => {
                const input = payload as { novelId?: string };
                if (!input?.novelId) {
                    throw new AiActionError('INVALID_INPUT', 'novelId is required');
                }

                return (db as any).item.findMany({
                    where: { novelId: input.novelId },
                    orderBy: { sortOrder: 'asc' },
                });
            },
        },
        {
            actionId: 'map.list',
            title: 'List maps',
            description: 'Return all maps under a novel.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                },
                required: ['novelId'],
            },
            outputSchema: { type: 'array' },
            handler: async (payload) => {
                const input = payload as { novelId?: string };
                if (!input?.novelId) {
                    throw new Error('novelId is required');
                }

                return (db as any).mapCanvas.findMany({
                    where: { novelId: input.novelId },
                    orderBy: { sortOrder: 'asc' },
                });
            },
        },
        {
            actionId: 'search.query',
            title: 'Search novel content',
            description: 'Run global search against chapter and idea index.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                    keyword: { type: 'string' },
                    limit: { type: 'number' },
                    offset: { type: 'number' },
                },
                required: ['novelId', 'keyword'],
            },
            outputSchema: { type: 'array' },
            handler: async (payload) => {
                const input = payload as { novelId?: string; keyword?: string; limit?: number; offset?: number };
                if (!input?.novelId || !input?.keyword) {
                    throw new AiActionError('INVALID_INPUT', 'novelId and keyword are required');
                }

                return searchIndex.search(input.novelId, input.keyword, input.limit ?? 20, input.offset ?? 0);
            },
        },
        {
            actionId: 'rag.ask',
            title: 'Ask novel RAG',
            description: 'Answer a novel-aware question using structured story data, summaries, and search evidence.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                    question: { type: 'string' },
                    chapterId: { type: 'string' },
                    currentContent: { type: 'string' },
                    selectedText: { type: 'string' },
                    currentLocation: { type: 'string' },
                    locale: { type: 'string' },
                    maxEvidenceItems: { type: 'number' },
                    overrideUserPrompt: { type: 'string' },
                },
                required: ['novelId', 'question'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => {
                const input = payload as {
                    novelId?: string;
                    question?: string;
                    chapterId?: string;
                    currentContent?: string;
                    selectedText?: string;
                    currentLocation?: string;
                    locale?: string;
                    maxEvidenceItems?: number;
                    overrideUserPrompt?: string;
                };
                if (!input?.novelId || !input.question?.trim()) {
                    throw new AiActionError('INVALID_INPUT', 'novelId and question are required');
                }
                try {
                    return await deps.askNovel({
                        novelId: input.novelId,
                        question: input.question,
                        chapterId: input.chapterId,
                        currentContent: input.currentContent,
                        selectedText: input.selectedText,
                        currentLocation: input.currentLocation,
                        locale: input.locale,
                        maxEvidenceItems: input.maxEvidenceItems,
                        overrideUserPrompt: input.overrideUserPrompt,
                    });
                } catch (error) {
                    throw normalizeAiError(error);
                }
            },
        },
        {
            actionId: 'rag.rebuild_index',
            title: 'Rebuild RAG vector index',
            description: 'Rebuild the local vector chunk index for a novel.',
            permission: 'read',
            inputSchema: {
                type: 'object',
                properties: {
                    novelId: { type: 'string' },
                },
                required: ['novelId'],
            },
            outputSchema: { type: 'object' },
            handler: async (payload) => {
                const input = payload as { novelId?: string };
                if (!input?.novelId) {
                    throw new AiActionError('INVALID_INPUT', 'novelId is required');
                }
                return deps.rebuildRagIndex(input.novelId);
            },
        },
    ];
}
