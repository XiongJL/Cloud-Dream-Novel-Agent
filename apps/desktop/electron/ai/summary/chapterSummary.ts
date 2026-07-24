import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import { db } from '@novel-editor/core';
import { HttpProvider } from '../providers/HttpProvider';
import type { AiSettings, AiSummarySettings } from '../types';

const LOG_PREFIX = '[Summary]';

const DEFAULT_SUMMARY_SETTINGS: AiSummarySettings = {
    summaryMode: 'local',
    summaryTriggerPolicy: 'manual',
    summaryDebounceMs: 30000,
    summaryMinIntervalMs: 180000,
    summaryMinWordDelta: 120,
    summaryFinalizeStableMs: 600000,
    summaryFinalizeMinWords: 1200,
    recentChapterRawCount: 2,
};

const DEFAULT_AI_SETTINGS: AiSettings = {
    providerType: 'http',
    http: {
        apiMode: 'chat-completions',
        baseUrl: '',
        apiKey: '',
        model: 'gpt-4.1-mini',
        imageModel: 'doubao-seedream-5-0-260128',
        imageSize: '2K',
        imageOutputFormat: 'png',
        imageWatermark: false,
        timeoutMs: 60000,
        maxTokens: 4096,
        contextWindowTokens: 0,
        temperature: 0.7,
    },
    mcpCli: {
        cliPath: '',
        argsTemplate: '',
        workingDir: '',
        envJson: '{}',
        startupTimeoutMs: 60000,
        contextWindowTokens: 0,
    },
    proxy: {
        mode: 'system',
        httpProxy: '',
        httpsProxy: '',
        allProxy: '',
        noProxy: '',
    },
    summary: DEFAULT_SUMMARY_SETTINGS,
    embedding: {
        enabled: false,
        baseUrl: '',
        apiKey: '',
        model: 'bge-large-zh-v1.5',
        dimensions: 1024,
        batchSize: 8,
        timeoutMs: 60000,
        fallbackToHash: true,
    },
};

const pendingTimers = new Map<string, NodeJS.Timeout>();
const aiPendingCounters = new Map<string, number>();
const finalizeTimers = new Map<string, NodeJS.Timeout>();
const narrativeTimers = new Map<string, NodeJS.Timeout>();
let dbPathLogged = false;

type RagSummaryIndexRefresh = (sourceType: 'chapterSummary' | 'narrativeSummary', sourceId: string, reason: string) => void;
let ragSummaryIndexRefresh: RagSummaryIndexRefresh | null = null;

export function registerRagSummaryIndexRefresh(callback: RagSummaryIndexRefresh): void {
    ragSummaryIndexRefresh = callback;
}

function notifyRagSummaryIndexRefresh(sourceType: 'chapterSummary' | 'narrativeSummary', sourceId: string, reason: string): void {
    try {
        ragSummaryIndexRefresh?.(sourceType, sourceId, reason);
    } catch (error) {
        console.warn(`${LOG_PREFIX} failed to notify RAG summary index refresh:`, error);
    }
}

type SummaryResult = {
    summaryText: string;
    keyFacts: string[];
    openQuestions: string[];
    timelineHints: string[];
    provider: string;
    model: string;
    promptVersion: string;
    temperature: number;
    maxTokens: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    errorCode?: string;
    errorDetail?: string;
};

type NarrativeSummaryPayload = {
    title?: string | null;
    summaryText: string;
    keyFacts: string[];
    unresolvedThreads: string[];
    styleGuide: string[];
    hardConstraints: string[];
    coverageChapterIds: string[];
    chapterRangeStart: number | null;
    chapterRangeEnd: number | null;
    sourceFingerprint: string;
};

function extractPlainTextFromLexical(content: string): string {
    if (!content?.trim()) return '';
    try {
        const parsed = JSON.parse(content);
        const texts: string[] = [];
        const walk = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (typeof node.text === 'string') {
                texts.push(node.text);
            }
            if (Array.isArray(node.children)) {
                node.children.forEach(walk);
            }
        };
        walk(parsed?.root || parsed);
        return texts.join(' ').replace(/\s+/g, ' ').trim();
    } catch {
        return content.replace(/\s+/g, ' ').trim();
    }
}

function buildKeyFacts(plainText: string): string[] {
    if (!plainText) return [];
    const sentences = plainText
        .split(/[。！？!?]/)
        .map((item) => item.trim())
        .filter(Boolean);
    return sentences.slice(0, 5).map((item, index) => `fact_${index + 1}: ${item.slice(0, 80)}`);
}

function buildOpenQuestions(plainText: string): string[] {
    if (!plainText) return [];
    return plainText
        .split(/[。！？!?]/)
        .map((item) => item.trim())
        .filter((item) => item.includes('？') || item.includes('?'))
        .slice(0, 5);
}

function buildCompressedMemory(title: string, chapterOrder: number | null, summaryText: string, keyFacts: string[]): string {
    const orderPart = Number.isFinite(chapterOrder) ? `第${chapterOrder}章` : '章节';
    const factPart = keyFacts.length > 0 ? keyFacts.join(' | ') : '无明显关键事实';
    return `${orderPart}《${title || '未命名章节'}》摘要：${summaryText}\n关键事实：${factPart}`;
}

function safeParseJsonArray(value: unknown): string[] {
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch {
        return [];
    }
}

function computeNarrativeFingerprint(parts: string[]): string {
    return createHash('sha256').update(parts.join('|')).digest('hex');
}

function buildNarrativeSummaryText(scope: 'volume' | 'novel', itemCount: number, summarySnippets: string[]): string {
    const header = scope === 'volume'
        ? `卷级摘要（覆盖${itemCount}章）`
        : `全书摘要（覆盖${itemCount}章）`;
    const merged = summarySnippets
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n');
    return `${header}\n${merged}`.slice(0, 2400);
}

function getAiSettingsFilePath(): string {
    return path.join(app.getPath('userData'), 'ai-settings.json');
}

function loadAiSettings(): AiSettings {
    try {
        const filePath = getAiSettingsFilePath();
        if (!fs.existsSync(filePath)) return DEFAULT_AI_SETTINGS;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<AiSettings>;
        return {
            ...DEFAULT_AI_SETTINGS,
            ...parsed,
            http: { ...DEFAULT_AI_SETTINGS.http, ...(parsed.http ?? {}) },
            mcpCli: { ...DEFAULT_AI_SETTINGS.mcpCli, ...(parsed.mcpCli ?? {}) },
            proxy: { ...DEFAULT_AI_SETTINGS.proxy, ...(parsed.proxy ?? {}) },
            summary: { ...DEFAULT_SUMMARY_SETTINGS, ...(parsed.summary ?? {}) },
        };
    } catch (error) {
        console.warn(`${LOG_PREFIX} failed to load ai-settings.json, fallback to defaults:`, error);
        return DEFAULT_AI_SETTINGS;
    }
}

async function buildLocalSummary(plainText: string, chapterOrder: number | null): Promise<SummaryResult> {
    const summaryText = plainText.slice(0, 220) || '章节内容为空，暂无可提炼摘要。';
    return {
        summaryText,
        keyFacts: buildKeyFacts(plainText),
        openQuestions: buildOpenQuestions(plainText),
        timelineHints: [`chapter_order:${chapterOrder ?? 'unknown'}`],
        provider: 'local',
        model: 'heuristic-v1',
        promptVersion: 'chapter-summary-v1',
        temperature: 0,
        maxTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
    };
}

async function buildAiSummary(chapterId: string, plainText: string, settings: AiSettings, chapterOrder: number | null): Promise<SummaryResult> {
    const canUseHttp = settings.providerType === 'http'
        && Boolean(settings.http.baseUrl?.trim())
        && Boolean(settings.http.apiKey?.trim());
    if (!canUseHttp) {
        throw new Error('AI summary mode requires HTTP provider with baseUrl and apiKey');
    }

    console.log(`${LOG_PREFIX} [${chapterId}] AI summary start (model=${settings.http.model})`);
    const provider = new HttpProvider(settings);
    const startedAt = Date.now();
    const response = await provider.generate({
        systemPrompt: [
            'You summarize novel chapters for continuity memory.',
            'Return strict JSON only.',
            'Schema: {"summaryText":"...","keyFacts":["..."],"openQuestions":["..."],"timelineHints":["..."]}',
        ].join(' '),
        prompt: JSON.stringify({
            task: 'chapter_memory_summary',
            chapterOrder,
            content: plainText.slice(0, 8000),
            constraints: [
                'summaryText should be concise and neutral',
                'keyFacts at most 6 items',
                'openQuestions at most 4 items',
            ],
        }),
        maxTokens: Math.min(1024, settings.http.maxTokens),
        temperature: Math.min(0.3, settings.http.temperature),
    });

    const parsed = JSON.parse(response.text || '{}') as {
        summaryText?: string;
        keyFacts?: string[];
        openQuestions?: string[];
        timelineHints?: string[];
    };

    const summaryText = String(parsed.summaryText || '').trim();
    if (!summaryText) {
        throw new Error('AI summary returned empty summaryText');
    }

    const latencyMs = Date.now() - startedAt;
    console.log(`${LOG_PREFIX} [${chapterId}] AI summary success (${latencyMs}ms)`);

    return {
        summaryText: summaryText.slice(0, 400),
        keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts.map((item) => String(item).trim()).filter(Boolean).slice(0, 6) : [],
        openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.map((item) => String(item).trim()).filter(Boolean).slice(0, 4) : [],
        timelineHints: Array.isArray(parsed.timelineHints) ? parsed.timelineHints.map((item) => String(item).trim()).filter(Boolean).slice(0, 6) : [`chapter_order:${chapterOrder ?? 'unknown'}`],
        provider: 'http',
        model: settings.http.model,
        promptVersion: 'chapter-summary-ai-v1',
        temperature: Math.min(0.3, settings.http.temperature),
        maxTokens: Math.min(1024, settings.http.maxTokens),
        inputTokens: 0,
        outputTokens: 0,
        latencyMs,
    };
}

async function collectNarrativePayload(
    scope: 'volume' | 'novel',
    novelId: string,
    volumeId?: string | null,
): Promise<NarrativeSummaryPayload | null> {
    const where = scope === 'volume'
        ? { novelId, volumeId: volumeId || '', isLatest: true, status: 'active' }
        : { novelId, isLatest: true, status: 'active' };

    const chapterSummaries = await (db as any).chapterSummary.findMany({
        where,
        select: {
            id: true,
            chapterId: true,
            chapterOrder: true,
            updatedAt: true,
            summaryText: true,
            keyFacts: true,
            openQuestions: true,
        },
        orderBy: [
            { chapterOrder: 'asc' },
            { updatedAt: 'asc' },
        ],
        take: scope === 'volume' ? 120 : 300,
    });

    if (chapterSummaries.length === 0) {
        return null;
    }

    const coverageChapterIds = chapterSummaries.map((item: any) => item.chapterId);
    const chapterOrders = chapterSummaries
        .map((item: any) => Number(item.chapterOrder))
        .filter((item: number) => Number.isFinite(item));
    const chapterRangeStart = chapterOrders.length > 0 ? Math.min(...chapterOrders) : null;
    const chapterRangeEnd = chapterOrders.length > 0 ? Math.max(...chapterOrders) : null;

    const summarySnippets = chapterSummaries
        .map((item: any) => String(item.summaryText || '').trim())
        .filter(Boolean)
        .slice(-10);
    const keyFacts: string[] = [...new Set(
        chapterSummaries.flatMap((item: any) => safeParseJsonArray(item.keyFacts)),
    )]
        .map((item) => String(item || '').slice(0, 120))
        .filter(Boolean)
        .slice(0, 24);
    const unresolvedThreads: string[] = [...new Set(
        chapterSummaries.flatMap((item: any) => safeParseJsonArray(item.openQuestions)),
    )]
        .map((item) => String(item || '').slice(0, 120))
        .filter(Boolean)
        .slice(0, 20);

    const styleGuide = [
        scope === 'volume' ? '保持本卷叙事风格一致' : '保持全书叙事风格一致',
        '优先遵循现有大纲与关键事实',
    ];
    const hardConstraints = [
        '不得与已确认关键事实冲突',
        '保持角色动机与关系连续',
    ];

    const sourceFingerprint = computeNarrativeFingerprint(
        chapterSummaries.map((item: any) => `${item.id}:${new Date(item.updatedAt).toISOString()}`),
    );

    let title: string | null = null;
    if (scope === 'volume' && volumeId) {
        const volume = await db.volume.findUnique({
            where: { id: volumeId },
            select: { title: true },
        });
        title = volume?.title || null;
    }

    return {
        title,
        summaryText: buildNarrativeSummaryText(scope, coverageChapterIds.length, summarySnippets),
        keyFacts,
        unresolvedThreads,
        styleGuide,
        hardConstraints,
        coverageChapterIds,
        chapterRangeStart,
        chapterRangeEnd,
        sourceFingerprint,
    };
}

async function upsertNarrativeSummary(
    scope: 'volume' | 'novel',
    novelId: string,
    payload: NarrativeSummaryPayload,
    volumeId?: string | null,
): Promise<string | null> {
    return db.$transaction(async (tx) => {
        await (tx as any).narrativeSummary.updateMany({
            where: {
                novelId,
                level: scope,
                volumeId: scope === 'volume' ? (volumeId || null) : null,
                isLatest: true,
            },
            data: {
                isLatest: false,
                status: 'stale',
            },
        });

        const existing = await (tx as any).narrativeSummary.findFirst({
            where: {
                novelId,
                level: scope,
                volumeId: scope === 'volume' ? (volumeId || null) : null,
                sourceFingerprint: payload.sourceFingerprint,
            },
        });

        const data = {
            novelId,
            volumeId: scope === 'volume' ? (volumeId || null) : null,
            level: scope,
            title: payload.title || null,
            summaryText: payload.summaryText,
            keyFacts: JSON.stringify(payload.keyFacts),
            unresolvedThreads: JSON.stringify(payload.unresolvedThreads),
            styleGuide: JSON.stringify(payload.styleGuide),
            hardConstraints: JSON.stringify(payload.hardConstraints),
            coverageChapterIds: JSON.stringify(payload.coverageChapterIds),
            chapterRangeStart: payload.chapterRangeStart,
            chapterRangeEnd: payload.chapterRangeEnd,
            sourceFingerprint: payload.sourceFingerprint,
            provider: 'local',
            model: 'heuristic-v1',
            promptVersion: 'narrative-summary-v1',
            temperature: 0,
            maxTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            qualityScore: null,
            status: 'active',
            errorCode: null,
            errorDetail: null,
            isLatest: true,
        };

        if (existing?.id) {
            const updated = await (tx as any).narrativeSummary.update({
                where: { id: existing.id },
                data,
            });
            return updated.id;
        } else {
            const created = await (tx as any).narrativeSummary.create({ data });
            return created.id;
        }
    });
}

async function rebuildNarrativeSummaries(novelId: string, volumeId: string): Promise<void> {
    try {
        const [volumePayload, novelPayload] = await Promise.all([
            collectNarrativePayload('volume', novelId, volumeId),
            collectNarrativePayload('novel', novelId, null),
        ]);

        if (volumePayload) {
            const summaryId = await upsertNarrativeSummary('volume', novelId, volumePayload, volumeId);
            console.log(`${LOG_PREFIX} [novel=${novelId}] narrative summary updated (level=volume, volume=${volumeId})`);
            if (summaryId) notifyRagSummaryIndexRefresh('narrativeSummary', summaryId, 'narrative-summary-volume');
        }
        if (novelPayload) {
            const summaryId = await upsertNarrativeSummary('novel', novelId, novelPayload, null);
            console.log(`${LOG_PREFIX} [novel=${novelId}] narrative summary updated (level=novel)`);
            if (summaryId) notifyRagSummaryIndexRefresh('narrativeSummary', summaryId, 'narrative-summary-novel');
        }
    } catch (error) {
        console.error(`${LOG_PREFIX} [novel=${novelId}] narrative summary rebuild failed:`, error);
    }
}

function scheduleNarrativeSummaryRebuild(novelId: string, volumeId: string): void {
    const key = `${novelId}:${volumeId}`;
    const existing = narrativeTimers.get(key);
    if (existing) {
        clearTimeout(existing);
    }
    const timer = setTimeout(() => {
        narrativeTimers.delete(key);
        void rebuildNarrativeSummaries(novelId, volumeId);
    }, 15000);
    narrativeTimers.set(key, timer);
}

export async function rebuildChapterSummary(chapterId: string, options?: { force?: boolean; reason?: 'save' | 'manual' | 'finalized' }): Promise<void> {
    const settings = loadAiSettings();
    const force = Boolean(options?.force);
    const reason = options?.reason || 'save';
    const isAiMode = settings.summary.summaryMode === 'ai';
    const effectiveMinIntervalMs = isAiMode
        ? Math.max(1800000, settings.summary.summaryMinIntervalMs) // AI: at least 30 minutes
        : settings.summary.summaryMinIntervalMs;
    const effectiveMinWordDelta = isAiMode
        ? Math.max(800, settings.summary.summaryMinWordDelta) // AI: at least +800 chars
        : settings.summary.summaryMinWordDelta;
    const chapter = await db.chapter.findUnique({
        where: { id: chapterId },
        select: {
            id: true,
            title: true,
            content: true,
            wordCount: true,
            order: true,
            updatedAt: true,
            volumeId: true,
            volume: { select: { novelId: true } },
        },
    });

    if (!chapter?.volume?.novelId) {
        console.log(`${LOG_PREFIX} [${chapterId}] skip: chapter or novel relation missing`);
        return;
    }

    if (!dbPathLogged) {
        try {
            const rows = await (db as any).$queryRawUnsafe('PRAGMA database_list;');
            const mainDb = Array.isArray(rows) ? rows.find((row: any) => row?.name === 'main') : null;
            console.log(`${LOG_PREFIX} sqlite main db path: ${mainDb?.file || 'unknown'}`);
        } catch (e) {
            console.warn(`${LOG_PREFIX} failed to read sqlite db path via PRAGMA database_list`);
        } finally {
            dbPathLogged = true;
        }
    }

    const sourceContent = chapter.content || '';
    const sourceContentHash = createHash('sha256').update(sourceContent).digest('hex');
    const now = Date.now();

    const latest = await (db as any).chapterSummary.findFirst({
        where: {
            chapterId: chapter.id,
            isLatest: true,
            status: 'active',
            summaryType: 'standard',
        },
        orderBy: { updatedAt: 'desc' },
    });

    if (!force && latest?.sourceContentHash === sourceContentHash) {
        console.log(`${LOG_PREFIX} [${chapterId}] skip: same content hash`);
        return;
    }

    const wordDelta = Math.abs((chapter.wordCount || 0) - Number(latest?.sourceWordCount || 0));
    const latestTime = latest?.updatedAt ? new Date(latest.updatedAt).getTime() : 0;
    const sinceLastMs = latestTime > 0 ? now - latestTime : Number.MAX_SAFE_INTEGER;
    if (!force && latestTime > 0 && sinceLastMs < effectiveMinIntervalMs && wordDelta < effectiveMinWordDelta) {
        console.log(
            `${LOG_PREFIX} [${chapterId}] skip: throttled (deltaWords=${wordDelta}, sinceLastMs=${sinceLastMs}, minIntervalMs=${effectiveMinIntervalMs}, minWordDelta=${effectiveMinWordDelta})`,
        );
        return;
    }

    const plainText = extractPlainTextFromLexical(sourceContent);
    console.log(
        `${LOG_PREFIX} [${chapterId}] start rebuild (reason=${reason}, mode=${settings.summary.summaryMode}, words=${chapter.wordCount || plainText.length}, deltaWords=${wordDelta}, force=${force})`,
    );

    let summary = await buildLocalSummary(plainText, chapter.order ?? null);
    if (settings.summary.summaryMode === 'ai') {
        try {
            summary = await buildAiSummary(chapterId, plainText, settings, chapter.order ?? null);
        } catch (error: any) {
            console.warn(`${LOG_PREFIX} [${chapterId}] AI summary failed, fallback to local: ${error?.message || 'unknown error'}`);
            const fallback = await buildLocalSummary(plainText, chapter.order ?? null);
            summary = {
                ...fallback,
                errorCode: 'AI_SUMMARY_FALLBACK',
                errorDetail: error?.message || 'unknown ai summary error',
            };
        }
    }

    const summaryId = await db.$transaction(async (tx) => {
        await (tx as any).chapterSummary.updateMany({
            where: { chapterId: chapter.id, isLatest: true },
            data: { isLatest: false, status: 'stale' },
        });

        const existing = await (tx as any).chapterSummary.findFirst({
            where: {
                chapterId: chapter.id,
                sourceContentHash,
                summaryType: 'standard',
            },
        });

        const payload = {
            novelId: chapter.volume.novelId,
            volumeId: chapter.volumeId,
            chapterId: chapter.id,
            summaryType: 'standard',
            summaryText: summary.summaryText,
            compressedMemory: buildCompressedMemory(chapter.title || '', chapter.order ?? null, summary.summaryText, summary.keyFacts),
            keyFacts: JSON.stringify(summary.keyFacts),
            entitiesSnapshot: JSON.stringify({}),
            timelineHints: JSON.stringify(summary.timelineHints),
            openQuestions: JSON.stringify(summary.openQuestions),
            sourceContentHash,
            sourceWordCount: chapter.wordCount || plainText.length,
            sourceUpdatedAt: chapter.updatedAt,
            chapterOrder: chapter.order ?? null,
            provider: summary.provider,
            model: summary.model,
            promptVersion: summary.promptVersion,
            temperature: summary.temperature,
            maxTokens: summary.maxTokens,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            latencyMs: summary.latencyMs,
            qualityScore: null,
            status: 'active',
            errorCode: summary.errorCode || null,
            errorDetail: summary.errorDetail || null,
            isLatest: true,
        };

        if (existing?.id) {
            const updated = await (tx as any).chapterSummary.update({
                where: { id: existing.id },
                data: payload,
            });
            console.log(`${LOG_PREFIX} [${chapterId}] done: updated existing summary`);
            return updated.id;
        }

        const created = await (tx as any).chapterSummary.create({
            data: payload,
        });
        console.log(`${LOG_PREFIX} [${chapterId}] done: created new summary`);
        return created.id;
    });
    if (summaryId) {
        notifyRagSummaryIndexRefresh('chapterSummary', summaryId, 'chapter-summary');
    }

    scheduleNarrativeSummaryRebuild(chapter.volume.novelId, chapter.volumeId);
}

export function scheduleChapterSummaryRebuild(chapterId: string, reason: 'save' | 'manual' | 'finalized' = 'save'): void {
    const settings = loadAiSettings();
    if (reason === 'manual') {
        console.log(`${LOG_PREFIX} [${chapterId}] manual trigger received`);
        void rebuildChapterSummary(chapterId, { force: true, reason: 'manual' }).catch((error) => {
            console.error(`${LOG_PREFIX} [${chapterId}] manual rebuild failed:`, error);
        });
        return;
    }

    if (settings.summary.summaryMode === 'ai' && settings.summary.summaryTriggerPolicy === 'manual') {
        console.log(`${LOG_PREFIX} [${chapterId}] skip scheduling: ai mode manual-only policy`);
        return;
    }

    if (settings.summary.summaryMode === 'ai' && settings.summary.summaryTriggerPolicy === 'finalized') {
        const stableDelay = Math.max(60000, settings.summary.summaryFinalizeStableMs);
        const existingFinalize = finalizeTimers.get(chapterId);
        if (existingFinalize) clearTimeout(existingFinalize);
        const timer = setTimeout(async () => {
            finalizeTimers.delete(chapterId);
            const chapter = await db.chapter.findUnique({
                where: { id: chapterId },
                select: { wordCount: true },
            });
            const wordCount = chapter?.wordCount || 0;
            if (wordCount < settings.summary.summaryFinalizeMinWords) {
                console.log(
                    `${LOG_PREFIX} [${chapterId}] finalized trigger skipped (wordCount=${wordCount}, min=${settings.summary.summaryFinalizeMinWords})`,
                );
                return;
            }
            console.log(`${LOG_PREFIX} [${chapterId}] finalized trigger fired after stable window ${stableDelay}ms`);
            void rebuildChapterSummary(chapterId, { force: true, reason: 'finalized' }).catch((error) => {
                console.error(`${LOG_PREFIX} [${chapterId}] finalized rebuild failed:`, error);
            });
        }, stableDelay);
        finalizeTimers.set(chapterId, timer);
        console.log(`${LOG_PREFIX} [${chapterId}] finalized trigger scheduled (${stableDelay}ms stable window)`);
        return;
    }

    const isAiMode = settings.summary.summaryMode === 'ai';
    const delay = isAiMode
        ? Math.max(300000, settings.summary.summaryDebounceMs) // AI: at least 5 minutes idle window
        : Math.max(1000, settings.summary.summaryDebounceMs);
    const existing = pendingTimers.get(chapterId);

    if (isAiMode) {
        // AI mode uses fixed-window coalescing: do not reset timer on each save.
        if (existing) {
            const count = (aiPendingCounters.get(chapterId) || 0) + 1;
            aiPendingCounters.set(chapterId, count);
            if (count % 10 === 0) {
                console.log(`${LOG_PREFIX} [${chapterId}] ai mode coalescing saves (${count} updates queued, timer unchanged)`);
            }
            return;
        }
        aiPendingCounters.set(chapterId, 1);
        console.log(`${LOG_PREFIX} [${chapterId}] ai mode scheduled (${delay}ms, fixed window)`);
    } else {
        if (existing) {
            clearTimeout(existing);
            console.log(`${LOG_PREFIX} [${chapterId}] debounce reset (${delay}ms)`);
        } else {
            console.log(`${LOG_PREFIX} [${chapterId}] debounce scheduled (${delay}ms)`);
        }
    }

    const timer = setTimeout(() => {
        pendingTimers.delete(chapterId);
        const queuedCount = aiPendingCounters.get(chapterId) || 0;
        aiPendingCounters.delete(chapterId);
        if (isAiMode) {
            console.log(`${LOG_PREFIX} [${chapterId}] ai mode fired after coalescing ${queuedCount} saves`);
        } else {
            console.log(`${LOG_PREFIX} [${chapterId}] debounce fired, evaluating rebuild`);
        }
        void rebuildChapterSummary(chapterId).catch((error) => {
            console.error(`${LOG_PREFIX} [${chapterId}] rebuild failed:`, error);
        });
    }, delay);
    pendingTimers.set(chapterId, timer);
}
