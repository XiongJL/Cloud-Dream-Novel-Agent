import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '@novel-editor/core';
import { createCapabilityDefinitions, type CapabilityDefinition, type CapabilityHandler } from './capabilities';
import { AiActionError, formatAiErrorForDisplay, normalizeAiError } from './errors';
import { HttpProvider } from './providers/HttpProvider';
import { McpCliProvider } from './providers/McpCliProvider';
import {
    AiCapabilityCoverageResult,
    AiActionExecutePayload,
    ConfirmCreativeAssetsResult,
    CreativeAssetsDraftIssue,
    CreativeAssetsDraftValidationResult,
    AiHealthCheckResult,
    AiMapImagePayload,
    AiMapImageResult,
    AiMapImageStats,
    OpenClawSmokePayload,
    OpenClawSmokeResult,
    AiProvider,
    AiSettings,
    CreativeAssetsGeneratePayload,
    ContinueWritingPayload,
    ContinueWritingResult,
    CreativeAssetsDraft,
    PromptPreviewLoreItem,
    PromptPreviewResult,
    TitleCandidate,
    TitleGenerationPayload,
} from './types';
import { ContextBuilder } from './context/ContextBuilder';
import { NovelRagService } from './rag/NovelRagService';
import type { RagAskPayload, RagAskResult } from './rag/types';
import { rebuildRagVectorIndex } from './rag/vectorIndex';
import { devLog, devLogError, redactForLog } from '../debug/devLogger';

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const DRAFT_MAX_FIELD_LENGTH = 2000;
const VALID_PLOT_POINT_TYPES = new Set(['foreshadowing', 'mystery', 'promise', 'event']);
const VALID_PLOT_POINT_STATUS = new Set(['active', 'resolved']);
const VALID_ITEM_TYPES = new Set(['item', 'skill', 'location']);
const VALID_MAP_TYPES = new Set(['world', 'region', 'scene']);
const CREATIVE_ASSET_SECTIONS = ['plotLines', 'plotPoints', 'characters', 'items', 'skills', 'maps'] as const;
type CreativeAssetSection = (typeof CREATIVE_ASSET_SECTIONS)[number];
const CREATIVE_SECTION_KEYWORDS: Record<CreativeAssetSection, string[]> = {
    plotLines: ['主线', '支线', '故事线', '剧情线', 'plot line', 'story line'],
    plotPoints: ['要点', '情节点', '剧情点', '事件', '桥段', '转折', '冲突', 'plot point', 'scene beat'],
    characters: ['角色', '龙套', '配角', '人物', '反派', '主角', 'npc', 'character'],
    items: ['物品', '道具', '装备', '宝物', '武器', '法宝', 'artifact', 'item'],
    skills: ['技能', '招式', '能力', '法术', '功法', '绝招', 'spell', 'skill'],
    maps: ['地图', '场景', '地点', '区域', '城市', '宗门地图', 'world map', 'map', 'location'],
};
const OPENCLAW_REQUIRED_ACTIONS = [
    'novel.list',
    'volume.list',
    'chapter.list',
    'chapter.create',
    'chapter.save',
    'chapter.generate',
] as const;
const CAPABILITY_COVERAGE_BASELINE: Array<{
    moduleId: string;
    title: string;
    requiredActions: string[];
}> = [
        {
            moduleId: 'novel_volume_chapter',
            title: '小说/卷章管理',
            requiredActions: [
                'novel.list',
                'novel.create',
                'volume.list',
                'chapter.list',
                'chapter.get',
                'chapter.create',
                'chapter.save',
            ],
        },
        {
            moduleId: 'editor_ops',
            title: '编辑器操作（标题/续写/总结）',
            requiredActions: [
                'chapter.generate',
            ],
        },
        {
            moduleId: 'global_search',
            title: '全局搜索与跳转',
            requiredActions: [
                'search.query',
            ],
        },
        {
            moduleId: 'outline_storyline_anchor',
            title: '大纲/故事线/锚点',
            requiredActions: [
                'plotline.list',
            ],
        },
        {
            moduleId: 'world_item_map',
            title: '角色/物品/世界观/地图',
            requiredActions: [
                'character.list',
                'item.list',
                'worldsetting.list',
                'map.list',
            ],
        },
        {
            moduleId: 'backup_restore',
            title: '备份恢复',
            requiredActions: [],
        },
    ];

const DEFAULT_AI_SETTINGS: AiSettings = {
    providerType: 'http',
    http: {
        baseUrl: '',
        apiKey: '',
        model: 'gpt-4.1-mini',
        imageModel: 'doubao-seedream-5-0-260128',
        imageSize: '2K',
        imageOutputFormat: 'png',
        imageWatermark: false,
        timeoutMs: 60000,
        maxTokens: 4096,
        temperature: 0.7,
    },
    mcpCli: {
        cliPath: '',
        argsTemplate: '',
        workingDir: '',
        envJson: '{}',
        startupTimeoutMs: 60000,
    },
    proxy: {
        mode: 'system',
        httpProxy: '',
        httpsProxy: '',
        allProxy: '',
        noProxy: '',
    },
    summary: {
        summaryMode: 'local',
        summaryTriggerPolicy: 'manual',
        summaryDebounceMs: 30000,
        summaryMinIntervalMs: 180000,
        summaryMinWordDelta: 120,
        summaryFinalizeStableMs: 600000,
        summaryFinalizeMinWords: 1200,
        recentChapterRawCount: 2,
    },
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

function toProfileJson(profile?: Record<string, string>): string {
    return JSON.stringify(profile ?? {});
}

function mimeToExt(mimeType?: string): string {
    const mime = (mimeType || '').toLowerCase();
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('bmp')) return 'bmp';
    return 'png';
}

function sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

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

function resolveMapStylePrompt(style?: 'realistic' | 'fantasy' | 'ancient' | 'scifi'): string {
    switch (style) {
        case 'realistic':
            return 'Style: realistic cartography, natural terrain textures, high geographic plausibility.';
        case 'fantasy':
            return 'Style: epic fantasy world map, dramatic terrain, mystical landmarks, rich parchment aesthetics.';
        case 'ancient':
            return 'Style: ancient oriental ink-and-parchment map, hand-drawn strokes, classical motifs.';
        case 'scifi':
            return 'Style: sci-fi strategic map, futuristic terrain overlays, advanced civilization markers.';
        default:
            return '';
    }
}

function buildRawPromptPreview(systemPrompt: string | undefined, userPrompt: string): string {
    const sections: string[] = [];
    if (systemPrompt?.trim()) {
        sections.push(`[System Prompt]\n${systemPrompt.trim()}`);
    }
    sections.push(`[User Prompt]\n${userPrompt.trim()}`);
    return sections.join('\n\n');
}

function trimText(value: unknown, maxLen: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function dedupeStrings(values: string[], maxCount: number): string[] {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(text);
        if (output.length >= maxCount) break;
    }
    return output;
}

export class AiService {
    private readonly userDataPath: string;
    private readonly settingsFilePath: string;
    private readonly mapImageStatsPath: string;
    private settingsCache: AiSettings;
    private mapImageStatsCache: AiMapImageStats;
    private readonly capabilityDefinitions: CapabilityDefinition[];
    private readonly capabilityRegistry: Map<string, CapabilityHandler>;
    private readonly contextBuilder: ContextBuilder;
    private readonly novelRagService: NovelRagService;

    constructor(userDataPathGetter: () => string) {
        this.userDataPath = userDataPathGetter();
        this.settingsFilePath = path.join(this.userDataPath, 'ai-settings.json');
        this.mapImageStatsPath = path.join(this.userDataPath, 'ai-map-image-stats.json');
        this.settingsCache = this.loadSettings();
        this.mapImageStatsCache = this.loadMapImageStats();
        this.contextBuilder = new ContextBuilder();
        this.novelRagService = new NovelRagService();
        this.capabilityDefinitions = createCapabilityDefinitions({
            continueWriting: (payload) => this.continueWriting(payload),
            askNovel: (payload) => this.askNovel(payload),
            rebuildRagIndex: (novelId) => this.rebuildRagIndex(novelId),
        });
        this.capabilityRegistry = new Map(
            this.capabilityDefinitions.map((definition) => [definition.actionId, definition.handler]),
        );
    }

    listActions(): Array<{
        actionId: string;
        title: string;
        description: string;
        permission: string;
        inputSchema: Record<string, unknown>;
        outputSchema: Record<string, unknown>;
    }> {
        return this.capabilityDefinitions.map((definition) => ({
            actionId: definition.actionId,
            title: definition.title,
            description: definition.description,
            permission: definition.permission,
            inputSchema: definition.inputSchema,
            outputSchema: definition.outputSchema,
        }));
    }

    getCapabilityCoverage(): AiCapabilityCoverageResult {
        const supportedActionSet = new Set(this.capabilityDefinitions.map((definition) => definition.actionId));
        const modules = CAPABILITY_COVERAGE_BASELINE.map((module) => {
            const missingActions = module.requiredActions.filter((actionId) => !supportedActionSet.has(actionId));
            const supportedActions = module.requiredActions.filter((actionId) => supportedActionSet.has(actionId));
            const coverage = module.requiredActions.length === 0
                ? 0
                : Math.round((supportedActions.length / module.requiredActions.length) * 100);
            return {
                moduleId: module.moduleId,
                title: module.title,
                requiredActions: [...module.requiredActions],
                supportedActions,
                missingActions,
                coverage,
            };
        });

        const totalRequired = modules.reduce((acc, item) => acc + item.requiredActions.length, 0);
        const totalSupported = modules.reduce((acc, item) => acc + item.supportedActions.length, 0);
        const overallCoverage = totalRequired === 0 ? 0 : Math.round((totalSupported / totalRequired) * 100);

        return {
            overallCoverage,
            totalRequired,
            totalSupported,
            modules,
        };
    }

    getMcpToolsManifest(): {
        tools: Array<{
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
        }>;
    } {
        const tools = this.capabilityDefinitions.map((definition) => ({
            name: definition.actionId,
            description: `${definition.title}. ${definition.description}`,
            inputSchema: definition.inputSchema,
        }));
        return { tools };
    }

    getOpenClawManifest(): {
        schemaVersion: string;
        tools: Array<{
            name: string;
            description: string;
            parameters: Record<string, unknown>;
        }>;
    } {
        const tools = this.capabilityDefinitions.map((definition) => ({
            name: definition.actionId,
            description: `${definition.title}. ${definition.description}`,
            parameters: definition.inputSchema,
        }));

        return {
            schemaVersion: 'openclaw.tool.v1',
            tools,
        };
    }

    getOpenClawSkillManifest(): {
        schemaVersion: string;
        skills: Array<{
            name: string;
            title: string;
            description: string;
            inputSchema: Record<string, unknown>;
        }>;
    } {
        const skills = this.capabilityDefinitions.map((definition) => ({
            name: definition.actionId,
            title: definition.title,
            description: definition.description,
            inputSchema: definition.inputSchema,
        }));

        return {
            schemaVersion: 'openclaw.skill.v1',
            skills,
        };
    }

    getSettings(): AiSettings {
        return this.settingsCache;
    }

    getMapImageStats(): AiMapImageStats {
        return this.mapImageStatsCache;
    }

    updateSettings(partial: Partial<AiSettings>): AiSettings {
        this.settingsCache = {
            ...this.settingsCache,
            ...partial,
            http: { ...this.settingsCache.http, ...(partial.http ?? {}) },
            mcpCli: { ...this.settingsCache.mcpCli, ...(partial.mcpCli ?? {}) },
            proxy: { ...this.settingsCache.proxy, ...(partial.proxy ?? {}) },
            summary: { ...this.settingsCache.summary, ...(partial.summary ?? {}) },
            embedding: { ...this.settingsCache.embedding, ...(partial.embedding ?? {}) },
        };

        this.persistSettings();
        return this.settingsCache;
    }

    async testConnection(): Promise<AiHealthCheckResult> {
        return this.getProvider().healthCheck();
    }

    async testMcp(): Promise<AiHealthCheckResult> {
        const provider = new McpCliProvider(this.settingsCache);
        return provider.healthCheck();
    }

    async testOpenClawMcp(): Promise<AiHealthCheckResult> {
        const result = await this.testOpenClawSmoke({ kind: 'mcp' });
        return { ok: result.ok, detail: result.detail };
    }

    async testOpenClawSkill(): Promise<AiHealthCheckResult> {
        const result = await this.testOpenClawSmoke({ kind: 'skill' });
        return { ok: result.ok, detail: result.detail };
    }

    async testOpenClawSmoke(payload: OpenClawSmokePayload): Promise<OpenClawSmokeResult> {
        const kind = payload.kind === 'skill' ? 'skill' : 'mcp';
        const actionNames = kind === 'mcp'
            ? this.getOpenClawManifest().tools.map((tool) => tool.name)
            : this.getOpenClawSkillManifest().skills.map((skill) => skill.name);

        if (!actionNames.length) {
            return {
                ok: false,
                kind,
                detail: kind === 'mcp' ? 'No OpenClaw MCP tools available' : 'No OpenClaw skills available',
                missingActions: [...OPENCLAW_REQUIRED_ACTIONS],
                checks: [],
            };
        }

        const missingActions = OPENCLAW_REQUIRED_ACTIONS.filter((actionId) => !actionNames.includes(actionId));
        const checks: OpenClawSmokeResult['checks'] = [];
        const pushCheck = (actionId: string, ok: boolean, detail: string, skipped?: boolean) => {
            checks.push({ actionId, ok, detail, ...(skipped ? { skipped: true } : {}) });
        };

        if (missingActions.length) {
            pushCheck('manifest.coverage', false, `Missing required actions: ${missingActions.join(', ')}`);
        } else {
            pushCheck('manifest.coverage', true, `All required actions are covered (${OPENCLAW_REQUIRED_ACTIONS.length})`);
        }

        const invoke = (actionId: string, input?: unknown) => (
            kind === 'mcp'
                ? this.invokeOpenClawTool({ name: actionId, arguments: input })
                : this.invokeOpenClawSkill({ name: actionId, input })
        );

        const novelResult = await invoke('novel.list');
        if (!novelResult.ok) {
            pushCheck('novel.list', false, novelResult.error || 'invoke failed');
            return {
                ok: false,
                kind,
                detail: `OpenClaw ${kind.toUpperCase()} smoke failed at novel.list: ${novelResult.error || 'unknown error'}`,
                missingActions,
                checks,
            };
        }

        pushCheck('novel.list', true, 'invoke ok');
        const novels = Array.isArray(novelResult.data) ? novelResult.data as Array<{ id?: string }> : [];
        const firstNovelId = novels.find((item) => typeof item?.id === 'string')?.id;
        if (!firstNovelId) {
            pushCheck('volume.list', true, 'no novels in database; skipped', true);
            pushCheck('chapter.list', true, 'no novels in database; skipped', true);
            const ok = missingActions.length === 0;
            return {
                ok,
                kind,
                detail: ok
                    ? `OpenClaw ${kind.toUpperCase()} smoke passed (manifest coverage ok, invoke ok, nested checks skipped due to empty data)`
                    : `OpenClaw ${kind.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${missingActions.join(', ')})`,
                missingActions,
                checks,
            };
        }

        const volumeResult = await invoke('volume.list', { novelId: firstNovelId });
        if (!volumeResult.ok) {
            pushCheck('volume.list', false, volumeResult.error || 'invoke failed');
            return {
                ok: false,
                kind,
                detail: `OpenClaw ${kind.toUpperCase()} smoke failed at volume.list: ${volumeResult.error || 'unknown error'}`,
                missingActions,
                checks,
            };
        }

        pushCheck('volume.list', true, 'invoke ok');
        const volumes = Array.isArray(volumeResult.data) ? volumeResult.data as Array<{ id?: string }> : [];
        const firstVolumeId = volumes.find((item) => typeof item?.id === 'string')?.id;
        if (!firstVolumeId) {
            pushCheck('chapter.list', true, 'no volumes under first novel; skipped', true);
            const ok = missingActions.length === 0;
            return {
                ok,
                kind,
                detail: ok
                    ? `OpenClaw ${kind.toUpperCase()} smoke passed (manifest coverage ok, read-chain invoke ok)`
                    : `OpenClaw ${kind.toUpperCase()} smoke partial pass (read-chain ok, but manifest missing required actions: ${missingActions.join(', ')})`,
                missingActions,
                checks,
            };
        }

        const chapterResult = await invoke('chapter.list', { volumeId: firstVolumeId });
        if (!chapterResult.ok) {
            pushCheck('chapter.list', false, chapterResult.error || 'invoke failed');
            return {
                ok: false,
                kind,
                detail: `OpenClaw ${kind.toUpperCase()} smoke failed at chapter.list: ${chapterResult.error || 'unknown error'}`,
                missingActions,
                checks,
            };
        }

        pushCheck('chapter.list', true, 'invoke ok');
        const ok = missingActions.length === 0;
        return {
            ok,
            kind,
            detail: ok
                ? `OpenClaw ${kind.toUpperCase()} smoke passed (manifest coverage + read-chain invoke all ok)`
                : `OpenClaw ${kind.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${missingActions.join(', ')})`,
            missingActions,
            checks,
        };
    }

    async testProxy(): Promise<AiHealthCheckResult> {
        const proxy = this.settingsCache.proxy;
        if (proxy.mode !== 'custom') {
            return { ok: true, detail: `Proxy mode is ${proxy.mode}` };
        }

        const hasAnyProxy = Boolean(proxy.httpProxy || proxy.httpsProxy || proxy.allProxy);
        if (!hasAnyProxy) {
            return { ok: false, detail: 'Custom proxy mode requires at least one proxy value' };
        }

        return { ok: true, detail: 'Custom proxy configuration looks valid' };
    }

    async testGenerate(prompt?: string): Promise<{ ok: boolean; text?: string; detail?: string }> {
        try {
            const provider = this.getProvider();
            const result = await provider.generate({
                systemPrompt: 'You are a concise assistant.',
                prompt: (prompt || '请用一句话回复：AI 生成测试成功').trim(),
                maxTokens: 128,
                temperature: 0.2,
            });
            return { ok: true, text: result.text?.slice(0, 500) || '' };
        } catch (error: any) {
            return { ok: false, detail: error?.message || 'test generate failed' };
        }
    }

    async generateTitle(payload: TitleGenerationPayload): Promise<{ candidates: TitleCandidate[] }> {
        devLog('INFO', 'AiService.generateTitle.start', 'Generate title start', {
            chapterId: payload.chapterId,
            novelId: payload.novelId,
            providerType: this.settingsCache.providerType,
        });
        const provider = this.getProvider();
        const count = Math.max(5, Math.min(10, payload.count ?? 6));
        const currentPlain = extractPlainTextFromLexical(payload.content);
        const currentChapterFullText = currentPlain.slice(0, 4000);

        const novel = await db.novel.findUnique({
            where: { id: payload.novelId },
            select: { title: true, description: true },
        });
        const chapter = await db.chapter.findUnique({
            where: { id: payload.chapterId },
            select: {
                id: true,
                title: true,
                order: true,
                volumeId: true,
                volume: {
                    select: {
                        id: true,
                        title: true,
                        order: true,
                    },
                },
            },
        });

        const recentChapters = await db.chapter.findMany({
            where: {
                volume: { novelId: payload.novelId },
                id: { not: payload.chapterId },
            },
            select: {
                title: true,
                order: true,
                volume: {
                    select: {
                        title: true,
                        order: true,
                    },
                },
            },
            orderBy: [
                { volume: { order: 'desc' } },
                { order: 'desc' },
            ],
            take: 30,
        });
        const recentChapterTitles = recentChapters.map((item, index) => {
            return {
                index: index + 1,
                volumeTitle: item.volume?.title || '',
                volumeOrder: item.volume?.order || 0,
                chapterOrder: item.order || 0,
                title: item.title || `Chapter-${index + 1}`,
            };
        });

        const systemPrompt = [
            'You are a Chinese novel title assistant.',
            'Generate concise chapter title candidates based on provided context.',
            'Return STRICT JSON only. No markdown.',
            'JSON shape: {"candidates":[{"title":"...","styleTag":"..."}]}',
            'Each styleTag must be short Chinese phrase like: 稳健推进, 悬念强化, 意象抒情.',
        ].join(' ');

        const response = await provider.generate({
            systemPrompt,
            prompt: JSON.stringify({
                task: 'chapter_title_generation',
                count,
                novel: {
                    title: novel?.title || '',
                    description: novel?.description || '',
                },
                chapter: {
                    title: chapter?.title || '',
                    order: chapter?.order || 0,
                    volumeTitle: chapter?.volume?.title || '',
                    volumeOrder: chapter?.volume?.order || 0,
                },
                recentChapterTitles,
                currentChapterFullText,
                constraints: [
                    'title length <= 16 Chinese characters preferred',
                    'avoid spoilers and proper nouns overuse',
                    'output 5-10 candidates',
                ],
            }),
            maxTokens: this.settingsCache.http.maxTokens,
            temperature: this.settingsCache.http.temperature,
        });

        const parsed = (() => {
            try {
                return JSON.parse(response.text);
            } catch {
                return null;
            }
        })();

        const normalizedFromJson: TitleCandidate[] = Array.isArray(parsed?.candidates)
            ? parsed.candidates
                .map((item: any) => ({
                    title: String(item?.title || '').trim(),
                    styleTag: String(item?.styleTag || '').trim() || '稳健推进',
                }))
                .filter((item: TitleCandidate) => Boolean(item.title))
                .slice(0, count)
            : [];

        if (normalizedFromJson.length > 0) {
            devLog('INFO', 'AiService.generateTitle.success', 'Generate title success', {
                chapterId: payload.chapterId,
                candidateCount: normalizedFromJson.length,
            });
            return { candidates: normalizedFromJson };
        }

        const normalizedFromLines: TitleCandidate[] = response.text
            .split('\n')
            .map((line) => line.replace(/^[-\d.\s]+/, '').trim())
            .filter(Boolean)
            .slice(0, count)
            .map((title) => ({ title, styleTag: '稳健推进' }));

        if (normalizedFromLines.length > 0) {
            devLog('INFO', 'AiService.generateTitle.success', 'Generate title success', {
                chapterId: payload.chapterId,
                candidateCount: normalizedFromLines.length,
            });
            return { candidates: normalizedFromLines };
        }

        const fallbackBase = (chapter?.title || currentChapterFullText.slice(0, 12) || '新章节').trim();
        devLog('INFO', 'AiService.generateTitle.success', 'Generate title success', {
            chapterId: payload.chapterId,
            candidateCount: count,
        });
        return {
            candidates: Array.from({ length: count }, (_, i) => ({
                title: `${fallbackBase} · ${i + 1}`,
                styleTag: '稳健推进',
            })),
        };
    }

    async previewContinuePrompt(payload: ContinueWritingPayload): Promise<PromptPreviewResult> {
        devLog('INFO', 'AiService.previewContinuePrompt.start', 'Preview continue prompt start', {
            chapterId: payload.chapterId,
            novelId: payload.novelId,
            contextChapterCount: payload.contextChapterCount,
        });
        const bundle = await this.buildContinuePromptBundle(payload);
        devLog('INFO', 'AiService.previewContinuePrompt.success', 'Preview continue prompt success', {
            chapterId: payload.chapterId,
        });
        return {
            structured: bundle.structured,
            rawPrompt: buildRawPromptPreview(bundle.systemPrompt, bundle.effectiveUserPrompt),
            editableUserPrompt: bundle.defaultUserPrompt,
            usedContext: bundle.usedContext,
            warnings: bundle.warnings,
        };
    }

    async continueWriting(payload: ContinueWritingPayload): Promise<ContinueWritingResult> {
        devLog('INFO', 'AiService.continueWriting.start', 'Continue writing start', {
            chapterId: payload.chapterId,
            novelId: payload.novelId,
            providerType: this.settingsCache.providerType,
            targetLength: payload.targetLength,
            contextChapterCount: payload.contextChapterCount,
        });
        const provider = this.getProvider();
        const bundle = await this.buildContinuePromptBundle(payload);
        const generationTemperature = Number.isFinite(payload.temperature)
            ? Math.max(0, Math.min(2, Number(payload.temperature)))
            : this.settingsCache.http.temperature;

        const response = await provider.generate({
            systemPrompt: bundle.systemPrompt,
            prompt: bundle.effectiveUserPrompt,
            maxTokens: this.settingsCache.http.maxTokens,
            temperature: generationTemperature,
        });

        const consistency = await this.checkConsistency({
            novelId: payload.novelId,
            text: response.text,
        });

        const result = {
            text: response.text,
            usedContext: bundle.usedContext,
            warnings: bundle.warnings,
            consistency,
        };
        devLog('INFO', 'AiService.continueWriting.success', 'Continue writing success', {
            chapterId: payload.chapterId,
            warningCount: bundle.warnings.length,
            generatedLength: result.text.length,
        });
        return result;
    }

    async checkConsistency(payload: { novelId: string; text: string }): Promise<{ ok: boolean; issues: string[] }> {
        const issues: string[] = [];

        const worldSettings = await (db as any).worldSetting.findMany({ where: { novelId: payload.novelId } });
        if (worldSettings.length === 0) {
            issues.push('No world settings found for consistency baseline.');
        }

        if (payload.text.length < 20) {
            issues.push('Generated text is too short.');
        }

        return { ok: issues.length === 0, issues };
    }

    async previewNovelAskPrompt(payload: RagAskPayload): Promise<RagAskResult> {
        devLog('INFO', 'AiService.previewNovelAskPrompt.start', 'Preview novel RAG prompt start', {
            novelId: payload.novelId,
            questionLength: payload.question?.length ?? 0,
        });
        const result = await this.novelRagService.preview(payload, this.settingsCache.embedding);
        devLog('INFO', 'AiService.previewNovelAskPrompt.success', 'Preview novel RAG prompt success', {
            novelId: payload.novelId,
            intent: result.intent,
            evidenceCount: result.evidence.length,
        });
        return result;
    }

    async askNovel(payload: RagAskPayload): Promise<RagAskResult> {
        devLog('INFO', 'AiService.askNovel.start', 'Novel RAG ask start', {
            novelId: payload.novelId,
            questionLength: payload.question?.length ?? 0,
            providerType: this.settingsCache.providerType,
        });
        const provider = this.getProvider();
        const result = await this.novelRagService.ask(payload, provider, {
            maxTokens: Math.min(2048, this.settingsCache.http.maxTokens || 2048),
            temperature: 0.2,
            embeddingSettings: this.settingsCache.embedding,
        });
        devLog('INFO', 'AiService.askNovel.success', 'Novel RAG ask success', {
            novelId: payload.novelId,
            intent: result.intent,
            confidence: result.confidence,
            evidenceCount: result.evidence.length,
        });
        return result;
    }

    async rebuildRagIndex(novelId: string): Promise<{ chunks: number; sources: number; provider: string; model: string; dimensions: number; fallbackUsed: boolean; fallbackError?: string }> {
        return rebuildRagVectorIndex(novelId, this.settingsCache.embedding);
    }

    async previewCreativeAssetsPrompt(payload: CreativeAssetsGeneratePayload): Promise<PromptPreviewResult> {
        devLog('INFO', 'AiService.previewCreativeAssetsPrompt.start', 'Preview creative assets prompt start', {
            novelId: payload.novelId,
            briefLength: payload.brief?.length ?? 0,
            targetSections: payload.targetSections,
        });
        const bundle = await this.buildCreativeAssetsPromptBundle(payload);
        devLog('INFO', 'AiService.previewCreativeAssetsPrompt.success', 'Preview creative assets prompt success', {
            novelId: payload.novelId,
        });
        return {
            structured: bundle.structured,
            rawPrompt: buildRawPromptPreview(bundle.systemPrompt, bundle.effectiveUserPrompt),
            editableUserPrompt: bundle.defaultUserPrompt,
            usedContext: bundle.usedContext,
        };
    }

    private inferCreativeTargetSections(brief: string): CreativeAssetSection[] {
        const normalized = String(brief || '').trim().toLowerCase();
        if (!normalized) return [...CREATIVE_ASSET_SECTIONS];

        const picked: CreativeAssetSection[] = [];
        for (const section of CREATIVE_ASSET_SECTIONS) {
            const keywords = CREATIVE_SECTION_KEYWORDS[section];
            if (keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
                picked.push(section);
            }
        }

        return picked.length > 0 ? picked : [...CREATIVE_ASSET_SECTIONS];
    }

    private resolveCreativeTargetSections(payload: CreativeAssetsGeneratePayload): CreativeAssetSection[] {
        const requested = Array.isArray(payload.targetSections) ? payload.targetSections : [];
        const picked = requested
            .filter((value): value is CreativeAssetSection => CREATIVE_ASSET_SECTIONS.includes(value as CreativeAssetSection));
        return picked.length > 0 ? picked : this.inferCreativeTargetSections(payload.brief);
    }

    private buildEmptyCreativeDraft(targetSections: CreativeAssetSection[]): CreativeAssetsDraft {
        const output: CreativeAssetsDraft = {};
        for (const key of targetSections) {
            (output as any)[key] = [];
        }
        return output;
    }

    async generateCreativeAssets(payload: CreativeAssetsGeneratePayload): Promise<{ draft: CreativeAssetsDraft }> {
        devLog('INFO', 'AiService.generateCreativeAssets.start', 'Generate creative assets start', {
            novelId: payload.novelId,
            briefLength: payload.brief?.length ?? 0,
            providerType: this.settingsCache.providerType,
            targetSections: payload.targetSections,
        });
        const provider = this.getProvider();
        const bundle = await this.buildCreativeAssetsPromptBundle(payload);
        const targetSections = this.resolveCreativeTargetSections(payload);
        const response = await provider.generate({
            systemPrompt: bundle.systemPrompt,
            prompt: bundle.effectiveUserPrompt,
            maxTokens: this.settingsCache.http.maxTokens,
            temperature: this.settingsCache.http.temperature,
            // 创作工坊需要生成多个板块的结构化 JSON，内容量大，使用更宽裕的超时
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 180000),
        });

        try {
            const parsed = JSON.parse(response.text) as CreativeAssetsDraft;
            if (parsed && typeof parsed === 'object') {
                const filtered: CreativeAssetsDraft = this.buildEmptyCreativeDraft(targetSections);
                for (const section of targetSections) {
                    const list = (parsed as any)?.[section];
                    (filtered as any)[section] = Array.isArray(list) ? list : [];
                }
                devLog('INFO', 'AiService.generateCreativeAssets.success', 'Generate creative assets success', {
                    novelId: payload.novelId,
                    counts: {
                        plotLines: filtered.plotLines?.length ?? 0,
                        plotPoints: filtered.plotPoints?.length ?? 0,
                        characters: filtered.characters?.length ?? 0,
                        items: filtered.items?.length ?? 0,
                        skills: filtered.skills?.length ?? 0,
                        maps: filtered.maps?.length ?? 0,
                    },
                });
                return { draft: filtered };
            }
        } catch {
            // fallback below
        }

        const suffix = randomUUID().slice(0, 6);
        const fallbackDraft: CreativeAssetsDraft = {
            plotLines: [{
                name: `主线-${suffix}`,
                description: 'AI 生成的主线草稿',
                color: '#6366f1',
                points: [{ title: '开端事件', description: '引发主线的关键事件', type: 'event', status: 'active' }],
            }],
            plotPoints: [{
                title: '中段转折',
                description: '推动章节冲突升级',
                type: 'event',
                status: 'active',
            }],
            characters: [{ name: `角色-${suffix}`, role: 'protagonist', description: 'AI 生成角色草稿', profile: { goal: '完成使命' } }],
            items: [{ name: `物品-${suffix}`, type: 'item', description: 'AI 生成物品草稿', profile: { rarity: 'rare' } }],
            skills: [{ name: `技能-${suffix}`, description: 'AI 生成技能草稿', profile: { rank: 'A' } }],
            maps: [{ name: `世界地图-${suffix}`, type: 'world', description: 'AI 生成地图草稿', imagePrompt: 'fantasy world map' }],
        };
        const filteredFallback: CreativeAssetsDraft = this.buildEmptyCreativeDraft(targetSections);
        for (const section of targetSections) {
            (filteredFallback as any)[section] = (fallbackDraft as any)[section] ?? [];
        }
        devLog('INFO', 'AiService.generateCreativeAssets.success', 'Generate creative assets success', {
            novelId: payload.novelId,
            counts: {
                plotLines: filteredFallback.plotLines?.length ?? 0,
                plotPoints: filteredFallback.plotPoints?.length ?? 0,
                characters: filteredFallback.characters?.length ?? 0,
                items: filteredFallback.items?.length ?? 0,
                skills: filteredFallback.skills?.length ?? 0,
                maps: filteredFallback.maps?.length ?? 0,
            },
        });
        return {
            draft: filteredFallback,
        };
    }

    async validateCreativeAssetsDraft(payload: { novelId: string; draft: CreativeAssetsDraft }): Promise<CreativeAssetsDraftValidationResult> {
        const errors: CreativeAssetsDraftIssue[] = [];
        const warnings: string[] = [];

        const pushError = (issue: CreativeAssetsDraftIssue) => errors.push(issue);
        const sanitizeText = (value: unknown, scope: string, maxLen = DRAFT_MAX_FIELD_LENGTH): string => {
            const text = typeof value === 'string' ? value.trim() : '';
            if (!text) return '';
            if (text.length <= maxLen) return text;
            warnings.push(`${scope} exceeds ${maxLen} chars and was truncated`);
            return text.slice(0, maxLen);
        };
        const sanitizeProfile = (value: unknown, scope: string): Record<string, string> => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
            const output: Record<string, string> = {};
            for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
                const safeKey = sanitizeText(key, `${scope}.key`, 64);
                const safeVal = sanitizeText(val, `${scope}.${key}`, 500);
                if (safeKey && safeVal) output[safeKey] = safeVal;
            }
            return output;
        };

        const normalized: CreativeAssetsDraft = {
            plotLines: (payload.draft.plotLines ?? []).map((line, index) => ({
                name: sanitizeText(line.name, `plotLines[${index}].name`, 120),
                description: sanitizeText(line.description, `plotLines[${index}].description`),
                color: sanitizeText(line.color, `plotLines[${index}].color`, 16) || '#6366f1',
                points: (line.points ?? []).map((point, pointIndex) => {
                    const type = sanitizeText(point.type, `plotLines[${index}].points[${pointIndex}].type`, 32) || 'event';
                    const status = sanitizeText(point.status, `plotLines[${index}].points[${pointIndex}].status`, 32) || 'active';
                    return {
                        title: sanitizeText(point.title, `plotLines[${index}].points[${pointIndex}].title`, 120),
                        description: sanitizeText(point.description, `plotLines[${index}].points[${pointIndex}].description`),
                        type: VALID_PLOT_POINT_TYPES.has(type) ? type : 'event',
                        status: VALID_PLOT_POINT_STATUS.has(status) ? status : 'active',
                    };
                }),
            })),
            plotPoints: (payload.draft.plotPoints ?? []).map((point, index) => {
                const type = sanitizeText(point.type, `plotPoints[${index}].type`, 32) || 'event';
                const status = sanitizeText(point.status, `plotPoints[${index}].status`, 32) || 'active';
                return {
                    title: sanitizeText(point.title, `plotPoints[${index}].title`, 120),
                    description: sanitizeText(point.description, `plotPoints[${index}].description`),
                    type: VALID_PLOT_POINT_TYPES.has(type) ? type : 'event',
                    status: VALID_PLOT_POINT_STATUS.has(status) ? status : 'active',
                    plotLineName: sanitizeText(point.plotLineName, `plotPoints[${index}].plotLineName`, 120),
                };
            }),
            characters: (payload.draft.characters ?? []).map((item, index) => ({
                name: sanitizeText(item.name, `characters[${index}].name`, 120),
                role: sanitizeText(item.role, `characters[${index}].role`, 64),
                description: sanitizeText(item.description, `characters[${index}].description`),
                profile: sanitizeProfile(item.profile, `characters[${index}].profile`),
            })),
            items: (payload.draft.items ?? []).map((item, index) => {
                const itemType = sanitizeText(item.type, `items[${index}].type`, 32) || 'item';
                return {
                    name: sanitizeText(item.name, `items[${index}].name`, 120),
                    type: VALID_ITEM_TYPES.has(itemType) ? itemType : 'item',
                    description: sanitizeText(item.description, `items[${index}].description`),
                    profile: sanitizeProfile(item.profile, `items[${index}].profile`),
                };
            }),
            skills: (payload.draft.skills ?? []).map((skill, index) => ({
                name: sanitizeText(skill.name, `skills[${index}].name`, 120),
                description: sanitizeText(skill.description, `skills[${index}].description`),
                profile: sanitizeProfile(skill.profile, `skills[${index}].profile`),
            })),
            maps: (payload.draft.maps ?? []).map((map, index) => {
                const mapType = sanitizeText(map.type, `maps[${index}].type`, 32) || 'world';
                return {
                    name: sanitizeText(map.name, `maps[${index}].name`, 120),
                    type: VALID_MAP_TYPES.has(mapType) ? (mapType as 'world' | 'region' | 'scene') : 'world',
                    description: sanitizeText(map.description, `maps[${index}].description`),
                    imagePrompt: sanitizeText(map.imagePrompt, `maps[${index}].imagePrompt`),
                    imageUrl: sanitizeText(map.imageUrl, `maps[${index}].imageUrl`, 2048),
                    imageBase64: sanitizeText(map.imageBase64, `maps[${index}].imageBase64`, 4 * 1024 * 1024),
                    mimeType: sanitizeText(map.mimeType, `maps[${index}].mimeType`, 64),
                };
            }),
        };

        for (const [index, line] of (normalized.plotLines ?? []).entries()) {
            if (!line.name) {
                pushError({ scope: `plotLines[${index}]`, code: 'INVALID_INPUT', detail: 'Plot line name is required' });
            }
            for (const [pointIndex, point] of (line.points ?? []).entries()) {
                if (!point.title) {
                    pushError({ scope: `plotLines[${index}].points[${pointIndex}]`, code: 'INVALID_INPUT', detail: 'Plot point title is required' });
                }
            }
        }

        for (const [index, point] of (normalized.plotPoints ?? []).entries()) {
            if (!point.title) {
                pushError({ scope: `plotPoints[${index}]`, code: 'INVALID_INPUT', detail: 'Plot point title is required' });
            }
        }
        for (const [index, character] of (normalized.characters ?? []).entries()) {
            if (!character.name) {
                pushError({ scope: `characters[${index}]`, code: 'INVALID_INPUT', detail: 'Character name is required' });
            }
        }
        for (const [index, item] of (normalized.items ?? []).entries()) {
            if (!item.name) {
                pushError({ scope: `items[${index}]`, code: 'INVALID_INPUT', detail: 'Item name is required' });
            }
        }
        for (const [index, skill] of (normalized.skills ?? []).entries()) {
            if (!skill.name) {
                pushError({ scope: `skills[${index}]`, code: 'INVALID_INPUT', detail: 'Skill name is required' });
            }
        }
        for (const [index, map] of (normalized.maps ?? []).entries()) {
            if (!map.name) {
                pushError({ scope: `maps[${index}]`, code: 'INVALID_INPUT', detail: 'Map name is required' });
            }
            const sourceCount = Number(Boolean(map.imageBase64)) + Number(Boolean(map.imageUrl)) + Number(Boolean(map.imagePrompt));
            if (sourceCount > 1) {
                pushError({
                    scope: `maps[${index}]`,
                    name: map.name,
                    code: 'INVALID_INPUT',
                    detail: 'Map image input must use only one source: imageBase64, imageUrl, or imagePrompt',
                });
            }
            if (map.imageUrl && !/^https?:\/\//i.test(map.imageUrl)) {
                pushError({
                    scope: `maps[${index}].imageUrl`,
                    name: map.name,
                    code: 'INVALID_INPUT',
                    detail: 'Map imageUrl must start with http:// or https://',
                });
            }
            if (map.imageBase64) {
                try {
                    const size = Buffer.from(map.imageBase64, 'base64').length;
                    if (size === 0) {
                        pushError({
                            scope: `maps[${index}].imageBase64`,
                            name: map.name,
                            code: 'INVALID_INPUT',
                            detail: 'Map imageBase64 is invalid',
                        });
                    }
                    if (size > MAX_IMAGE_SIZE_BYTES) {
                        pushError({
                            scope: `maps[${index}].imageBase64`,
                            name: map.name,
                            code: 'INVALID_INPUT',
                            detail: `Map imageBase64 exceeds ${MAX_IMAGE_SIZE_BYTES} bytes`,
                        });
                    }
                } catch {
                    pushError({
                        scope: `maps[${index}].imageBase64`,
                        name: map.name,
                        code: 'INVALID_INPUT',
                        detail: 'Map imageBase64 is invalid',
                    });
                }
            }
        }

        const checkDraftDuplicates = (items: Array<{ name?: string }>, scope: string) => {
            const seen = new Set<string>();
            for (const item of items) {
                const normalizedName = (item.name || '').trim().toLowerCase();
                if (!normalizedName) continue;
                if (seen.has(normalizedName)) {
                    pushError({
                        scope,
                        name: item.name,
                        code: 'CONFLICT',
                        detail: `Duplicate name in current draft: ${item.name}`,
                    });
                    continue;
                }
                seen.add(normalizedName);
            }
        };

        checkDraftDuplicates(normalized.plotLines ?? [], 'plotLines');
        checkDraftDuplicates(normalized.characters ?? [], 'characters');
        checkDraftDuplicates(normalized.items ?? [], 'items');
        checkDraftDuplicates(normalized.skills ?? [], 'skills');
        checkDraftDuplicates(normalized.maps ?? [], 'maps');

        const [existingPlotLines, existingCharacters, existingItems, existingMaps] = await Promise.all([
            (db as any).plotLine.findMany({ where: { novelId: payload.novelId }, select: { name: true } }),
            (db as any).character.findMany({ where: { novelId: payload.novelId }, select: { name: true } }),
            (db as any).item.findMany({ where: { novelId: payload.novelId }, select: { name: true } }),
            (db as any).mapCanvas.findMany({ where: { novelId: payload.novelId }, select: { name: true } }),
        ]);

        const existingNameSets = {
            plotLines: new Set(existingPlotLines.map((row: { name: string }) => row.name.trim().toLowerCase())),
            characters: new Set(existingCharacters.map((row: { name: string }) => row.name.trim().toLowerCase())),
            items: new Set(existingItems.map((row: { name: string }) => row.name.trim().toLowerCase())),
            maps: new Set(existingMaps.map((row: { name: string }) => row.name.trim().toLowerCase())),
        };

        const checkExistingConflicts = (items: Array<{ name?: string }>, category: keyof typeof existingNameSets, scope: string) => {
            for (const item of items) {
                const normalizedName = (item.name || '').trim().toLowerCase();
                if (!normalizedName) continue;
                if (existingNameSets[category].has(normalizedName)) {
                    pushError({
                        scope,
                        name: item.name,
                        code: 'CONFLICT',
                        detail: `Name already exists in novel: ${item.name}`,
                    });
                }
            }
        };

        checkExistingConflicts(normalized.plotLines ?? [], 'plotLines', 'plotLines');
        checkExistingConflicts(normalized.characters ?? [], 'characters', 'characters');
        checkExistingConflicts(normalized.items ?? [], 'items', 'items');
        checkExistingConflicts(normalized.skills ?? [], 'items', 'skills');
        checkExistingConflicts(normalized.maps ?? [], 'maps', 'maps');

        if ((normalized.plotPoints?.length ?? 0) > 0 && (normalized.plotLines?.length ?? 0) === 0) {
            warnings.push('Draft has plotPoints but no plotLines. System will create a default plot line when persisting.');
        }

        return {
            ok: errors.length === 0,
            errors,
            warnings,
            normalizedDraft: normalized,
        };
    }

    async confirmCreativeAssets(payload: { novelId: string; draft: CreativeAssetsDraft }): Promise<ConfirmCreativeAssetsResult> {
        devLog('INFO', 'AiService.confirmCreativeAssets.start', 'Confirm creative assets start', {
            novelId: payload.novelId,
            draftCounts: redactForLog({
                plotLines: payload.draft.plotLines?.length ?? 0,
                plotPoints: payload.draft.plotPoints?.length ?? 0,
                characters: payload.draft.characters?.length ?? 0,
                items: payload.draft.items?.length ?? 0,
                skills: payload.draft.skills?.length ?? 0,
                maps: payload.draft.maps?.length ?? 0,
            }),
        });
        const validation = await this.validateCreativeAssetsDraft(payload);
        const zeroCreated = {
            plotLines: 0,
            plotPoints: 0,
            characters: 0,
            items: 0,
            skills: 0,
            maps: 0,
            mapImages: 0,
        };

        if (!validation.ok) {
            devLog('WARN', 'AiService.confirmCreativeAssets.validationFailed', 'Confirm creative assets validation failed', {
                novelId: payload.novelId,
                errors: validation.errors,
                warnings: validation.warnings,
            });
            return {
                success: false,
                created: zeroCreated,
                warnings: validation.warnings,
                errors: validation.errors,
                transactionMode: 'atomic',
            };
        }

        const draft = validation.normalizedDraft;
        const provider = this.getProvider();
        const createdFiles: string[] = [];
        let committedCreated = { ...zeroCreated };

        try {
            await db.$transaction(async (tx) => {
                const localCreated = { ...zeroCreated };
                const plotLineIdByName = new Map<string, string>();

                for (const plotLine of draft.plotLines ?? []) {
                    const createdLine = await (tx as any).plotLine.create({
                        data: {
                            novelId: payload.novelId,
                            name: plotLine.name,
                            description: plotLine.description || null,
                            color: plotLine.color || '#6366f1',
                            sortOrder: Date.now() + localCreated.plotLines,
                        },
                    });
                    plotLineIdByName.set(plotLine.name.toLowerCase(), createdLine.id);
                    localCreated.plotLines += 1;

                    for (const point of plotLine.points ?? []) {
                        await (tx as any).plotPoint.create({
                            data: {
                                novelId: payload.novelId,
                                plotLineId: createdLine.id,
                                title: point.title,
                                description: point.description || null,
                                type: point.type || 'event',
                                status: point.status || 'active',
                                order: Date.now() + localCreated.plotPoints,
                            },
                        });
                        localCreated.plotPoints += 1;
                    }
                }

                const resolvePlotLineIdForLoosePoint = async (plotLineName?: string): Promise<string> => {
                    const lookupName = (plotLineName || '').trim().toLowerCase();
                    if (lookupName && plotLineIdByName.has(lookupName)) {
                        return plotLineIdByName.get(lookupName)!;
                    }
                    const firstLineId = plotLineIdByName.values().next().value as string | undefined;
                    if (firstLineId) return firstLineId;

                    const defaultName = 'AI 主线';
                    const autoLine = await (tx as any).plotLine.create({
                        data: {
                            novelId: payload.novelId,
                            name: defaultName,
                            description: 'Auto-created for loose plot points',
                            color: '#6366f1',
                            sortOrder: Date.now() + localCreated.plotLines,
                        },
                    });
                    plotLineIdByName.set(defaultName.toLowerCase(), autoLine.id);
                    localCreated.plotLines += 1;
                    return autoLine.id;
                };

                for (const point of draft.plotPoints ?? []) {
                    const lineId = await resolvePlotLineIdForLoosePoint(point.plotLineName);
                    await (tx as any).plotPoint.create({
                        data: {
                            novelId: payload.novelId,
                            plotLineId: lineId,
                            title: point.title,
                            description: point.description || null,
                            type: point.type || 'event',
                            status: point.status || 'active',
                            order: Date.now() + localCreated.plotPoints,
                        },
                    });
                    localCreated.plotPoints += 1;
                }

                for (const character of draft.characters ?? []) {
                    await (tx as any).character.create({
                        data: {
                            novelId: payload.novelId,
                            name: character.name,
                            role: character.role || null,
                            description: character.description || null,
                            profile: toProfileJson(character.profile),
                            sortOrder: Date.now() + localCreated.characters,
                        },
                    });
                    localCreated.characters += 1;
                }

                for (const item of draft.items ?? []) {
                    await (tx as any).item.create({
                        data: {
                            novelId: payload.novelId,
                            name: item.name,
                            type: item.type || 'item',
                            description: item.description || null,
                            profile: toProfileJson(item.profile),
                            sortOrder: Date.now() + localCreated.items,
                        },
                    });
                    localCreated.items += 1;
                }

                for (const skill of draft.skills ?? []) {
                    await (tx as any).item.create({
                        data: {
                            novelId: payload.novelId,
                            name: skill.name,
                            type: 'skill',
                            description: skill.description || null,
                            profile: toProfileJson(skill.profile),
                            sortOrder: Date.now() + localCreated.items + localCreated.skills,
                        },
                    });
                    localCreated.skills += 1;
                }

                for (const mapDraft of draft.maps ?? []) {
                    const map = await (tx as any).mapCanvas.create({
                        data: {
                            novelId: payload.novelId,
                            name: mapDraft.name,
                            type: mapDraft.type || 'world',
                            description: mapDraft.description || null,
                            sortOrder: Date.now() + localCreated.maps,
                        },
                    });
                    localCreated.maps += 1;

                    let imageInput: { imageBase64?: string; imageUrl?: string; mimeType?: string } | null = null;
                    if (mapDraft.imageBase64 || mapDraft.imageUrl) {
                        imageInput = {
                            imageBase64: mapDraft.imageBase64,
                            imageUrl: mapDraft.imageUrl,
                            mimeType: mapDraft.mimeType,
                        };
                    } else if (mapDraft.imagePrompt) {
                        if (!provider.generateImage) {
                            throw new AiActionError('INVALID_INPUT', `Provider ${provider.name} does not support image generation`);
                        }
                        const generated = await provider.generateImage({ prompt: mapDraft.imagePrompt });
                        if (!generated?.imageBase64 && !generated?.imageUrl) {
                            throw new AiActionError('PROVIDER_UNAVAILABLE', `Map image generation returned empty data for ${mapDraft.name}`);
                        }
                        imageInput = {
                            imageBase64: generated.imageBase64,
                            imageUrl: generated.imageUrl,
                            mimeType: generated.mimeType,
                        };
                    }

                    if (imageInput) {
                        const saved = await this.saveImageAsset(payload.novelId, map.id, imageInput);
                        createdFiles.push(saved.absolutePath);
                        await (tx as any).mapCanvas.update({
                            where: { id: map.id },
                            data: { background: saved.relativePath },
                        });
                        localCreated.mapImages += 1;
                    }
                }

                committedCreated = localCreated;
            });

            const result = {
                success: true,
                created: committedCreated,
                warnings: validation.warnings,
                transactionMode: 'atomic' as const,
            };
            devLog('INFO', 'AiService.confirmCreativeAssets.success', 'Confirm creative assets success', {
                novelId: payload.novelId,
                created: committedCreated,
                warningCount: validation.warnings.length,
            });
            return result;
        } catch (error) {
            devLogError('AiService.confirmCreativeAssets.error', error, {
                novelId: payload.novelId,
            });
            for (const file of createdFiles) {
                try {
                    if (fs.existsSync(file)) fs.unlinkSync(file);
                } catch {
                    // keep rollback best-effort to avoid masking original failure
                }
            }

            const normalized = normalizeAiError(error);
            const issueCode: CreativeAssetsDraftIssue['code'] = normalized.code === 'INVALID_INPUT'
                ? 'INVALID_INPUT'
                : normalized.code === 'CONFLICT'
                    ? 'CONFLICT'
                    : normalized.code === 'UNKNOWN'
                        ? 'UNKNOWN'
                        : 'PERSISTENCE_ERROR';

            return {
                success: false,
                created: zeroCreated,
                warnings: validation.warnings,
                errors: [
                    {
                        scope: 'confirmCreativeAssets',
                        code: issueCode,
                        detail: normalized.message || 'Creative assets persistence failed',
                    },
                ],
                transactionMode: 'atomic',
            };
        }
    }

    async previewMapPrompt(payload: AiMapImagePayload): Promise<PromptPreviewResult> {
        devLog('INFO', 'AiService.previewMapPrompt.start', 'Preview map prompt start', {
            novelId: payload.novelId,
            mapId: payload.mapId,
            promptLength: payload.prompt?.length ?? 0,
        });
        const bundle = await this.buildMapPromptBundle(payload);
        devLog('INFO', 'AiService.previewMapPrompt.success', 'Preview map prompt success', {
            novelId: payload.novelId,
            mapId: payload.mapId,
        });
        return {
            structured: bundle.structured,
            rawPrompt: bundle.effectiveUserPrompt,
            editableUserPrompt: bundle.defaultUserPrompt,
            usedWorldLore: bundle.usedWorldLore,
        };
    }

    async generateMapImage(payload: AiMapImagePayload): Promise<AiMapImageResult> {
        devLog('INFO', 'AiService.generateMapImage.start', 'Generate map image start', {
            novelId: payload.novelId,
            mapId: payload.mapId,
            promptLength: payload.prompt?.length ?? 0,
            providerType: this.settingsCache.providerType,
        });
        const startTime = Date.now();
        const finalize = (result: AiMapImageResult): AiMapImageResult => {
            this.recordMapImageCall({
                ok: result.ok,
                code: result.code,
                detail: result.detail,
                latencyMs: Date.now() - startTime,
            });
            return result;
        };

        try {
            const hasBasePrompt = Boolean(payload.prompt?.trim());
            const hasOverridePrompt = Boolean(payload.overrideUserPrompt?.trim());
            if (!hasBasePrompt && !hasOverridePrompt) {
                return finalize({ ok: false, code: 'INVALID_INPUT', detail: 'Map prompt is empty' });
            }

            const provider = this.getProvider();
            if (!provider.generateImage) {
                return finalize({ ok: false, code: 'INVALID_INPUT', detail: `Provider ${provider.name} does not support image generation` });
            }

            const bundle = await this.buildMapPromptBundle(payload);

            const generated = await provider.generateImage({
                prompt: bundle.effectiveUserPrompt,
                model: this.settingsCache.http.imageModel || undefined,
                size: payload.imageSize || this.settingsCache.http.imageSize || undefined,
                outputFormat: this.settingsCache.http.imageOutputFormat || undefined,
                watermark: this.settingsCache.http.imageWatermark,
            });
            if (!generated.imageBase64 && !generated.imageUrl) {
                return finalize({ ok: false, code: 'PROVIDER_UNAVAILABLE', detail: 'Provider did not return any image data' });
            }

            let mapId = payload.mapId;
            if (!mapId) {
                const createdMap = await (db as any).mapCanvas.create({
                    data: {
                        novelId: payload.novelId,
                        name: payload.mapName?.trim() || `AI 地图 ${new Date().toLocaleString()}`,
                        type: payload.mapType || 'world',
                        description: `Generated by AI with prompt: ${payload.prompt}`,
                        sortOrder: Date.now(),
                    },
                });
                mapId = createdMap.id;
            }

            if (!mapId) {
                throw new AiActionError('PERSISTENCE_ERROR', 'Map id is missing after map creation');
            }

            const saved = await this.saveImageAsset(payload.novelId, mapId, {
                imageBase64: generated.imageBase64,
                imageUrl: generated.imageUrl,
                mimeType: generated.mimeType,
            });

            await (db as any).mapCanvas.update({
                where: { id: mapId },
                data: { background: saved.relativePath },
            });

            const successResult = finalize({
                ok: true,
                detail: 'Map image generated and stored successfully',
                mapId,
                path: saved.relativePath,
            });
            devLog('INFO', 'AiService.generateMapImage.success', 'Generate map image success', {
                novelId: payload.novelId,
                mapId,
                imagePath: saved.relativePath,
            });
            return successResult;
        } catch (error) {
            devLogError('AiService.generateMapImage.error', error, {
                novelId: payload.novelId,
                mapId: payload.mapId,
            });
            const normalized = normalizeAiError(error);
            return finalize({
                ok: false,
                code: normalized.code,
                detail: normalized.message || 'Map generation failed',
            });
        }
    }

    async executeAction(input: AiActionExecutePayload): Promise<unknown> {
        const handler = this.capabilityRegistry.get(input.actionId);
        if (!handler) {
            throw new AiActionError('INVALID_INPUT', `Unknown actionId: ${input.actionId}`);
        }
        try {
            return await handler(input.payload);
        } catch (error) {
            throw normalizeAiError(error);
        }
    }

    async invokeOpenClawTool(input: { name: string; arguments?: unknown }): Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }> {
        try {
            const data = await this.executeAction({
                actionId: input.name,
                payload: input.arguments,
            });
            return { ok: true, data };
        } catch (error: any) {
            const normalized = normalizeAiError(error);
            return {
                ok: false,
                error: formatAiErrorForDisplay(normalized.code, normalized.message || 'OpenClaw invoke failed'),
                code: normalized.code,
            };
        }
    }

    async invokeOpenClawSkill(input: { name: string; input?: unknown }): Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }> {
        try {
            const data = await this.executeAction({
                actionId: input.name,
                payload: input.input,
            });
            return { ok: true, data };
        } catch (error: any) {
            const normalized = normalizeAiError(error);
            return {
                ok: false,
                error: formatAiErrorForDisplay(normalized.code, normalized.message || 'OpenClaw skill invoke failed'),
                code: normalized.code,
            };
        }
    }

    private compactContinueHardContext(input: Record<string, unknown>): Record<string, unknown> {
        const worldSettings = Array.isArray(input.worldSettings) ? input.worldSettings : [];
        const plotLines = Array.isArray(input.plotLines) ? input.plotLines : [];
        const characters = Array.isArray(input.characters) ? input.characters : [];
        const items = Array.isArray(input.items) ? input.items : [];
        const maps = Array.isArray(input.maps) ? input.maps : [];

        return {
            worldSettings: worldSettings.slice(0, 60).map((item: any) => ({
                name: trimText(item?.name, 80),
                type: trimText(item?.type, 32) || 'other',
                content: trimText(item?.content, 300) || trimText(item?.description, 300),
            })).filter((item: any) => item.content),
            plotLines: plotLines.slice(0, 40).map((line: any) => ({
                name: trimText(line?.name, 100),
                description: trimText(line?.description, 260),
                points: Array.isArray(line?.points)
                    ? line.points
                        .filter((point: any) => String(point?.status || '').trim().toLowerCase() !== 'resolved')
                        .slice(0, 12)
                        .map((point: any) => ({
                        title: trimText(point?.title, 100),
                        description: trimText(point?.description, 220),
                        type: trimText(point?.type, 24) || 'event',
                        status: trimText(point?.status, 24) || 'active',
                    })).filter((point: any) => point.title || point.description)
                    : [],
            })).filter((line: any) => line.name || (line.points?.length ?? 0) > 0),
            characters: characters.slice(0, 120).map((item: any) => ({
                name: trimText(item?.name, 80),
                role: trimText(item?.role, 32),
                description: trimText(item?.description, 220),
            })).filter((item: any) => item.name && (item.role || item.description)),
            items: items.slice(0, 120).map((item: any) => ({
                name: trimText(item?.name, 80),
                type: trimText(item?.type, 32) || 'item',
                description: trimText(item?.description, 220),
            })).filter((item: any) => item.name && item.description),
            maps: maps.slice(0, 60).map((item: any) => ({
                name: trimText(item?.name, 80),
                type: trimText(item?.type, 24) || 'world',
                description: trimText(item?.description, 220),
            })).filter((item: any) => item.name && item.description),
        };
    }

    private compactContinueDynamicContext(input: Record<string, unknown>): Record<string, unknown> {
        const recentChapters = Array.isArray(input.recentChapters) ? input.recentChapters : [];
        const selectedIdeas = Array.isArray(input.selectedIdeas) ? input.selectedIdeas : [];
        const selectedIdeaEntities = Array.isArray(input.selectedIdeaEntities) ? input.selectedIdeaEntities : [];
        const narrativeSummaries = Array.isArray(input.narrativeSummaries) ? input.narrativeSummaries : [];
        const currentLocation = trimText(input.currentLocation, 120);

        return {
            recentChapters: recentChapters.slice(0, 8).map((chapter: any) => ({
                title: trimText(chapter?.title, 120),
                excerpt: trimText(chapter?.excerpt, 1200),
            })).filter((chapter: any) => chapter.title || chapter.excerpt),
            selectedIdeas: selectedIdeas.slice(0, 20).map((idea: any) => ({
                content: trimText(idea?.content, 800),
                quote: trimText(idea?.quote, 300),
                tags: Array.isArray(idea?.tags) ? idea.tags.slice(0, 12).map((tag: any) => trimText(tag, 32)).filter(Boolean) : [],
            })).filter((idea: any) => idea.content || idea.quote),
            selectedIdeaEntities: selectedIdeaEntities.slice(0, 20).map((entity: any) => ({
                name: trimText(entity?.name, 80),
                kind: trimText(entity?.kind, 24),
            })).filter((entity: any) => entity.name && entity.kind),
            currentChapterBeforeCursor: trimText(input.currentChapterBeforeCursor, 2600),
            ...(currentLocation ? { currentLocation } : {}),
            narrativeSummaries: narrativeSummaries.slice(0, 4).map((item: any) => ({
                level: item?.level === 'volume' ? 'volume' : 'novel',
                title: trimText(item?.title, 100),
                summaryText: trimText(item?.summaryText, 1200),
                keyFacts: Array.isArray(item?.keyFacts)
                    ? dedupeStrings(item.keyFacts.map((fact: any) => trimText(fact, 160)).filter(Boolean), 5)
                    : [],
            })),
        };
    }

    private async buildContinuePromptBundle(payload: ContinueWritingPayload): Promise<{
        systemPrompt: string;
        defaultUserPrompt: string;
        effectiveUserPrompt: string;
        structured: PromptPreviewResult['structured'];
        usedContext: string[];
        warnings: string[];
    }> {
        const isZh = /^zh/i.test(String(payload.locale || '').trim());
        const writeMode: 'new_chapter' | 'continue_chapter' =
            payload.mode === 'new_chapter' ? 'new_chapter' : 'continue_chapter';
        const context = await this.contextBuilder.buildForContinueWriting({
            ...payload,
            mode: writeMode,
            recentRawChapterCount: payload.recentRawChapterCount ?? this.settingsCache.summary.recentChapterRawCount,
        });
        const compactHardContext = this.compactContinueHardContext(context.hardContext as Record<string, unknown>);
        const compactDynamicContext = this.compactContinueDynamicContext(context.dynamicContext as Record<string, unknown>);
        const normalizedUserIntent = trimText(payload.userIntent, 800);
        const normalizedCurrentLocation = trimText(payload.currentLocation, 120);
        const writeParamsForPrompt = {
            ...context.params,
            targetLength: isZh
                ? `约${Math.max(100, Math.min(4000, Number(context.params.targetLength || 500)))}汉字`
                : `about ${Math.max(100, Math.min(4000, Number(context.params.targetLength || 500)))} Chinese characters`,
        };
        const systemPrompt = isZh
            ? '你是中文小说续写助手。严格遵守世界观和大纲，不得破坏既有设定与人物行为逻辑。'
            : 'Continue writing with strict consistency to world settings and plot outline. Do not break established lore.';
        const promptSections = [
            `WriteMode=${writeMode}`,
            `HardContext=\n${JSON.stringify(compactHardContext, null, 2).slice(0, 18000)}`,
            `DynamicContext=\n${JSON.stringify(compactDynamicContext, null, 2).slice(0, 12000)}`,
            `WriteParams=\n${JSON.stringify(writeParamsForPrompt, null, 2)}`,
            ...(normalizedUserIntent ? [`UserIntent=${normalizedUserIntent}`] : []),
            ...(normalizedCurrentLocation ? [`CurrentLocation=${normalizedCurrentLocation}`] : []),
            writeMode === 'new_chapter'
                ? (isZh
                    ? 'Constraint=基于大纲与世界观写出新章节开场，不得复述已有段落。'
                    : 'Constraint=Start a fresh chapter opening based on outline and world context. Do not echo prior chapter paragraphs.')
                : (isZh
                    ? 'Constraint=仅输出新增续写内容，不得重复当前章节或上下文已出现段落。'
                    : 'Constraint=Output must be NEW continuation content only. Do not restate prior paragraphs from current chapter or context.'),
            isZh
                ? 'Constraint=@实体名 表示对上下文中同名角色/物品/地点/设定的引用，续写时应保持实体设定一致。'
                : 'Constraint=@EntityName means referencing the same named entity from context; keep entity traits consistent.',
            ...(normalizedUserIntent
                ? [isZh
                    ? 'Constraint=尽量满足用户意图，但不得违反世界观与主线大纲。'
                    : 'Constraint=Prioritize the user intent when possible, but never violate established world settings and plot outline.']
                : []),
            isZh
                ? 'Constraint=请严格遵守 HardContext 中的世界观、角色性格和物品设定；情节推进需与已有情节点保持一致。'
                : 'Constraint=Strictly follow HardContext lore, character traits, and item settings; keep progression aligned with existing plot points.',
            isZh
                ? 'Constraint=你的任务是续写光标后的新内容，不要重复 currentChapterBeforeCursor 里的任何句子。'
                : 'Constraint=Write only the continuation after cursor; do not repeat any sentence from currentChapterBeforeCursor.',
        ];
        const defaultUserPrompt = promptSections.join('\n\n');
        const effectiveUserPrompt = payload.overrideUserPrompt?.trim() ? payload.overrideUserPrompt.trim() : defaultUserPrompt;
        const structuredParams = {
            ...context.params,
            ...(normalizedUserIntent ? { userIntent: normalizedUserIntent } : {}),
            ...(normalizedCurrentLocation ? { currentLocation: normalizedCurrentLocation } : {}),
        };
        return {
            systemPrompt,
            defaultUserPrompt,
            effectiveUserPrompt,
            structured: {
                goal: writeMode === 'new_chapter'
                    ? (isZh ? '生成新章节开场内容。' : 'Generate opening content for a new chapter.')
                    : (isZh ? '仅生成续写新增内容。' : 'Generate continuation content only.'),
                contextRefs: context.usedContext,
                params: structuredParams,
                constraints: [
                    ...(isZh
                        ? ['严格遵守世界观与大纲一致性。']
                        : ['Keep strict consistency with world settings and outline.']),
                    ...(normalizedUserIntent
                        ? [isZh
                            ? '在不冲突时优先满足用户意图。'
                            : 'Respect user intent when it does not conflict with hard context.']
                        : []),
                    ...(isZh
                        ? ['不得重复已有段落。', '只输出生成的续写正文。']
                        : ['Do not repeat existing paragraphs.', 'Output only generated chapter text.']),
                ],
            },
            usedContext: context.usedContext,
            warnings: context.warnings,
        };
    }

    private async buildCreativeAssetsPromptBundle(payload: CreativeAssetsGeneratePayload): Promise<{
        systemPrompt: string;
        defaultUserPrompt: string;
        effectiveUserPrompt: string;
        structured: PromptPreviewResult['structured'];
        usedContext: string[];
        estimatedTokens: number;
    }> {
        const targetSections = this.resolveCreativeTargetSections(payload);
        const isZh = (payload.locale || 'zh').startsWith('zh');

        // 获取小说基本信息
        const novel = await db.novel.findUnique({
            where: { id: payload.novelId },
            select: { id: true, title: true, description: true },
        });

        // 通过 ContextBuilder 获取丰富上下文
        const context = await this.contextBuilder.buildForCreativeAssets(payload);

        const systemPrompt = isZh
            ? '你是一位小说创作助手，擅长根据用户的创意需求和已有小说内容生成结构化的创作素材。请严格以 JSON 格式输出，只输出 JSON，不要添加任何其他文字。所有生成的名称、描述等文本内容必须使用中文。生成的内容应与小说已有的角色、情节、世界观保持一致和关联。'
            : 'You are a novel creation assistant. Generate structured creative assets in strict JSON format based on existing novel content. Output only JSON, no extra text. Generated content should be consistent with existing characters, plot, and world settings.';

        const outputSchema = {
            plotLines: [{ name: 'string', description: 'string?' }],
            plotPoints: [{ title: 'string', description: 'string?', plotLineName: 'string?' }],
            characters: [{ name: 'string', role: 'string?', description: 'string?' }],
            items: [{ name: 'string', type: 'item|skill|location', description: 'string?' }],
            skills: [{ name: 'string', description: 'string?' }],
            maps: [{ name: 'string', type: 'world|region|scene', description: 'string?', imagePrompt: 'string?' }],
        };

        const constraints = isZh
            ? [
                '仅返回严格的 JSON，不要包含 markdown 代码块标记或其他文字',
                '必须为所有请求的 section 生成内容，不得遗漏任何一个板块',
                `请求的 section 列表: ${targetSections.join(', ')}`,
                '未请求的 section 必须设为空数组',
                '生成内容必须与已有小说内容（角色、情节、世界观）保持一致和关联',
                '避免与已存在的实体重名',
                '所有字段内容简洁、可直接使用',
                '所有名称和描述必须使用中文',
            ]
            : [
                'return strict JSON only, no markdown code fences or extra text',
                'generate content for ALL requested sections, do not leave any empty',
                `requested sections: ${targetSections.join(', ')}`,
                'all unrequested sections must be empty arrays',
                'generated content must be consistent and related to existing novel content',
                'avoid duplicate names against existing entities',
                'fields should be concise and directly usable',
            ];

        // 构建包含丰富上下文的提示词
        const promptData: Record<string, unknown> = {
            task: 'creative_assets_generation',
            language: isZh ? 'Chinese' : 'English',
            brief: payload.brief,
            novel: {
                title: novel?.title || '',
                description: novel?.description || '',
            },
            targetSections,
            outputShape: targetSections,
            outputSchema,
            constraints,
        };

        // 注入已有实体上下文
        if (context.existingEntities.characters.length > 0) {
            promptData.existingCharacters = context.existingEntities.characters;
        }
        if (context.existingEntities.items.length > 0) {
            promptData.existingItems = context.existingEntities.items;
        }
        if (context.existingEntities.plotLines.length > 0) {
            promptData.existingPlotLines = context.existingEntities.plotLines;
        }
        if (context.existingEntities.worldSettings.length > 0) {
            promptData.worldSettings = context.existingEntities.worldSettings;
        }

        // 注入章节摘要上下文
        if (context.recentSummaries.length > 0) {
            promptData.recentChapterSummaries = context.recentSummaries;
        }
        if (context.narrativeSummaries.length > 0) {
            promptData.narrativeSummary = context.narrativeSummaries[0];
        }

        const defaultUserPrompt = JSON.stringify(promptData);
        const effectiveUserPrompt = payload.overrideUserPrompt?.trim() ? payload.overrideUserPrompt.trim() : defaultUserPrompt;

        const usedContext = [
            `Novel: ${novel?.title || payload.novelId}`,
            ...context.usedContext,
        ];

        const goalText = isZh
            ? '根据用户创意简述和已有小说内容，生成可编辑的草稿素材。'
            : 'Generate editable draft assets based on user brief and existing novel content.';
        const constraintsSummary = isZh
            ? ['仅输出严格 JSON', '返回所有请求的板块', '与已有内容关联', '内容简洁可用', '避免重名', '使用中文']
            : ['Output strict JSON.', 'Return ALL selected sections.', 'Stay consistent with existing content.', 'Prefer concise fields.', 'Avoid name conflicts.'];

        return {
            systemPrompt,
            defaultUserPrompt,
            effectiveUserPrompt,
            structured: {
                goal: goalText,
                contextRefs: usedContext,
                params: {
                    briefLength: payload.brief.trim().length,
                    sections: targetSections,
                    locale: payload.locale || 'zh',
                    estimatedContextTokens: context.estimatedTokens,
                },
                constraints: constraintsSummary,
            },
            usedContext,
            estimatedTokens: context.estimatedTokens,
        };
    }

    private async buildMapPromptBundle(payload: AiMapImagePayload): Promise<{
        defaultUserPrompt: string;
        effectiveUserPrompt: string;
        structured: PromptPreviewResult['structured'];
        usedWorldLore: PromptPreviewLoreItem[];
    }> {
        const worldSettings = await (db as any).worldSetting.findMany({
            where: { novelId: payload.novelId },
            orderBy: { updatedAt: 'desc' },
            take: 8,
            select: { id: true, name: true, content: true },
        });
        const usedWorldLore: PromptPreviewLoreItem[] = worldSettings.map((item: any) => ({
            id: item.id,
            title: String(item.name || 'Untitled'),
            excerpt: String(item.content || '').slice(0, 180),
        }));
        const stylePrompt = resolveMapStylePrompt(payload.styleTemplate);
        const loreBlock = usedWorldLore.length > 0
            ? usedWorldLore.map((item, index) => `${index + 1}. ${item.title}: ${item.excerpt}`).join('\n')
            : 'No explicit world lore provided.';
        const defaultUserPrompt = [
            stylePrompt || 'Style: follow user requested style.',
            `ImageSize=${payload.imageSize || this.settingsCache.http.imageSize || '2K'}`,
            'Task: Generate a clean map background image.',
            `UserRequest=${payload.prompt}`,
            'WorldLore:',
            loreBlock,
            'Constraints:',
            '- avoid text labels or UI marks',
            '- keep high readability for map canvas editing',
            '- preserve coherence with world lore',
        ].join('\n');
        const effectiveUserPrompt = payload.overrideUserPrompt?.trim() ? payload.overrideUserPrompt.trim() : defaultUserPrompt;
        return {
            defaultUserPrompt,
            effectiveUserPrompt,
            structured: {
                goal: 'Generate map background image aligned with world lore.',
                contextRefs: [
                    `Map type: ${payload.mapType || 'world'}`,
                    `Map name: ${payload.mapName || '(new map)'}`,
                    `World lore refs: ${usedWorldLore.length}`,
                ],
                params: {
                    imageSize: payload.imageSize || this.settingsCache.http.imageSize || '2K',
                    styleTemplate: payload.styleTemplate || 'default',
                },
                constraints: [
                    'No labels or UI overlays in generated image.',
                    'Map should be readable for later annotation.',
                    'Use world lore when available.',
                ],
            },
            usedWorldLore,
        };
    }

    private getProvider(): AiProvider {
        return this.settingsCache.providerType === 'mcp-cli'
            ? new McpCliProvider(this.settingsCache)
            : new HttpProvider(this.settingsCache);
    }

    private async saveImageAsset(
        novelId: string,
        mapId: string,
        input: { imageBase64?: string; imageUrl?: string; mimeType?: string },
    ): Promise<{ relativePath: string; absolutePath: string }> {
        let mimeType = input.mimeType || 'image/png';
        let buffer: Buffer;

        if (input.imageBase64) {
            buffer = Buffer.from(input.imageBase64, 'base64');
        } else if (input.imageUrl) {
            const res = await fetch(input.imageUrl);
            if (!res.ok) {
                throw new Error(`Image download failed: ${res.status}`);
            }

            const headerMime = res.headers.get('content-type') || '';
            if (headerMime) mimeType = headerMime;

            const arrayBuffer = await res.arrayBuffer();
            buffer = Buffer.from(arrayBuffer);
        } else {
            throw new Error('No image data provided');
        }

        if (buffer.length === 0) {
            throw new Error('Image data is empty');
        }

        if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
            throw new Error('Image exceeds maximum size limit');
        }

        if (!mimeType.startsWith('image/')) {
            throw new Error(`Invalid mime type: ${mimeType}`);
        }

        const ext = mimeToExt(mimeType);
        const mapsDir = path.join(this.userDataPath, 'maps', novelId);
        if (!fs.existsSync(mapsDir)) {
            fs.mkdirSync(mapsDir, { recursive: true });
        }

        const filename = sanitizeFileName(`ai-${mapId}-${Date.now()}.${ext}`);
        const absolutePath = path.join(mapsDir, filename);
        fs.writeFileSync(absolutePath, buffer);

        return {
            relativePath: `maps/${novelId}/${filename}`,
            absolutePath,
        };
    }

    private loadSettings(): AiSettings {
        try {
            if (!fs.existsSync(this.settingsFilePath)) {
                return DEFAULT_AI_SETTINGS;
            }
            const raw = fs.readFileSync(this.settingsFilePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<AiSettings>;
            return {
                ...DEFAULT_AI_SETTINGS,
                ...parsed,
                http: { ...DEFAULT_AI_SETTINGS.http, ...(parsed.http ?? {}) },
                mcpCli: { ...DEFAULT_AI_SETTINGS.mcpCli, ...(parsed.mcpCli ?? {}) },
                proxy: { ...DEFAULT_AI_SETTINGS.proxy, ...(parsed.proxy ?? {}) },
                summary: { ...DEFAULT_AI_SETTINGS.summary, ...(parsed.summary ?? {}) },
                embedding: { ...DEFAULT_AI_SETTINGS.embedding, ...(parsed.embedding ?? {}) },
            };
        } catch (error) {
            console.error('[AI] Failed to load settings, fallback to defaults:', error);
            return DEFAULT_AI_SETTINGS;
        }
    }

    private persistSettings(): void {
        try {
            const dir = path.dirname(this.settingsFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.settingsFilePath, JSON.stringify(this.settingsCache, null, 2), 'utf8');
        } catch (error) {
            console.error('[AI] Failed to persist settings:', error);
        }
    }

    private loadMapImageStats(): AiMapImageStats {
        const fallback: AiMapImageStats = {
            totalCalls: 0,
            successCalls: 0,
            failedCalls: 0,
            rateLimitFailures: 0,
            updatedAt: new Date(0).toISOString(),
        };

        try {
            if (!fs.existsSync(this.mapImageStatsPath)) {
                return fallback;
            }
            const raw = fs.readFileSync(this.mapImageStatsPath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<AiMapImageStats>;
            return {
                totalCalls: parsed.totalCalls ?? 0,
                successCalls: parsed.successCalls ?? 0,
                failedCalls: parsed.failedCalls ?? 0,
                rateLimitFailures: parsed.rateLimitFailures ?? 0,
                lastFailureCode: parsed.lastFailureCode || undefined,
                lastFailureAt: parsed.lastFailureAt || undefined,
                updatedAt: parsed.updatedAt || fallback.updatedAt,
            };
        } catch (error) {
            console.warn('[AI] Failed to load map image stats, fallback to defaults:', error);
            return fallback;
        }
    }

    private persistMapImageStats(): void {
        try {
            const dir = path.dirname(this.mapImageStatsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.mapImageStatsPath, JSON.stringify(this.mapImageStatsCache, null, 2), 'utf8');
        } catch (error) {
            console.warn('[AI] Failed to persist map image stats:', error);
        }
    }

    private recordMapImageCall(input: { ok: boolean; code?: string; detail?: string; latencyMs: number }): void {
        const codeText = (input.code || '').toLowerCase();
        const detailText = (input.detail || '').toLowerCase();
        const isRateLimit = codeText.includes('rate') || codeText.includes('429') || detailText.includes('429') || detailText.includes('rate limit') || detailText.includes('quota');

        this.mapImageStatsCache = {
            ...this.mapImageStatsCache,
            totalCalls: this.mapImageStatsCache.totalCalls + 1,
            successCalls: this.mapImageStatsCache.successCalls + (input.ok ? 1 : 0),
            failedCalls: this.mapImageStatsCache.failedCalls + (input.ok ? 0 : 1),
            rateLimitFailures: this.mapImageStatsCache.rateLimitFailures + (!input.ok && isRateLimit ? 1 : 0),
            lastFailureCode: input.ok ? this.mapImageStatsCache.lastFailureCode : (input.code || 'UNKNOWN'),
            lastFailureAt: input.ok ? this.mapImageStatsCache.lastFailureAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        this.persistMapImageStats();
    }
}

