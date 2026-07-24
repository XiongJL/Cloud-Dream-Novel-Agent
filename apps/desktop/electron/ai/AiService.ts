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
    ChapterBeatGenerationPayload,
    ChapterBeatGenerationResult,
    NarrativeStateExtractionPayload,
    NarrativeStateExtractionResult,
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
import { parseFirstJsonObject as parseJsonObject } from '../../shared/agentJson';
import { createCreativeAssetEntitySnapshot } from '../automation/CreativeAssetsWriteback';
import type { CreativeAssetWritebackEntitySnapshot } from '../../shared/draftWriteback';
import { ContextBuilder } from './context/ContextBuilder';
import {
    AgentContextAssembler,
    type AgentContextAssembly,
    type AgentContextArtifact,
    type AgentContextDiagnostics,
    type AgentContextMessage,
    type AgentContextSection,
    type AgentConversationSummary,
} from './context/AgentContextAssembler';
import { NovelRagService } from './rag/NovelRagService';
import type { RagAskPayload, RagAskResult } from './rag/types';
import { buildVectorDocumentForSource, deleteRagVectorSource, getRagVectorChunkCount, rebuildRagVectorIndex, upsertRagChapterIndex, upsertRagSourceIndex } from './rag/vectorIndex';
import type { RagEvidenceSourceType } from './rag/types';
import { devLog, devLogError, redactForLog } from '../debug/devLogger';
import { filterNarrativeStateDeltaEvidence, normalizeNarrativeStateDelta } from '../../shared/narrativeState';

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

function collectAgentContextArtifacts(value: unknown): AgentContextArtifact[] {
    if (!value || typeof value !== 'object') return [];
    const context = value as Record<string, unknown>;
    const runs = [
        ...(context.activeRun && typeof context.activeRun === 'object' ? [context.activeRun] : []),
        ...(Array.isArray(context.priorRuns) ? context.priorRuns : []),
    ];
    const byId = new Map<string, AgentContextArtifact>();
    for (const runValue of runs) {
        if (!runValue || typeof runValue !== 'object') continue;
        const run = runValue as Record<string, unknown>;
        for (const artifactValue of Array.isArray(run.artifacts) ? run.artifacts : []) {
            if (!artifactValue || typeof artifactValue !== 'object') continue;
            const artifact = artifactValue as Record<string, unknown>;
            const artifactId = trimText(artifact.artifactId, 160);
            if (!artifactId) continue;
            byId.set(artifactId, {
                artifactId,
                ...(artifact.runId || run.runId ? { runId: trimText(artifact.runId || run.runId, 160) } : {}),
                ...(artifact.type ? { type: trimText(artifact.type, 80) } : {}),
                ...(artifact.title ? { title: trimText(artifact.title, 240) } : {}),
                ...(artifact.status ? { status: trimText(artifact.status, 80) } : {}),
                ...(artifact.summary ? { summary: trimText(artifact.summary, 4000) } : {}),
                ...(artifact.content ? { content: trimText(artifact.content, 40_000) } : {}),
                ...(artifact.reference && typeof artifact.reference === 'object'
                    ? { reference: artifact.reference as Record<string, unknown> }
                    : {}),
                ...(artifact.metadata && typeof artifact.metadata === 'object'
                    ? { metadata: artifact.metadata as Record<string, unknown> }
                    : {}),
                ...(artifact.createdAt ? { createdAt: trimText(artifact.createdAt, 80) } : {}),
            });
        }
    }
    return [...byId.values()];
}

function compactConversationArtifacts(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') return {};
    const context = value as Record<string, unknown>;
    const compactRun = (runValue: unknown): unknown => {
        if (!runValue || typeof runValue !== 'object') return runValue;
        const run = runValue as Record<string, unknown>;
        return {
            ...run,
            artifacts: (Array.isArray(run.artifacts) ? run.artifacts : []).flatMap((artifactValue) => {
                if (!artifactValue || typeof artifactValue !== 'object') return [];
                const artifact = artifactValue as Record<string, unknown>;
                return [{
                    artifactId: artifact.artifactId,
                    runId: artifact.runId || run.runId,
                    type: artifact.type,
                    title: artifact.title,
                    status: artifact.status,
                    summary: trimText(artifact.summary, 800),
                    reference: artifact.reference,
                    createdAt: artifact.createdAt,
                }];
            }),
        };
    };
    return {
        ...context,
        activeRun: compactRun(context.activeRun),
        priorRuns: Array.isArray(context.priorRuns) ? context.priorRuns.map(compactRun) : [],
    };
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
    private readonly agentContextAssembler: AgentContextAssembler;
    private readonly novelRagService: NovelRagService;

    constructor(userDataPathGetter: () => string) {
        this.userDataPath = userDataPathGetter();
        this.settingsFilePath = path.join(this.userDataPath, 'ai-settings.json');
        this.mapImageStatsPath = path.join(this.userDataPath, 'ai-map-image-stats.json');
        this.settingsCache = this.loadSettings();
        this.mapImageStatsCache = this.loadMapImageStats();
        this.contextBuilder = new ContextBuilder();
        this.agentContextAssembler = new AgentContextAssembler();
        this.novelRagService = new NovelRagService();
        this.capabilityDefinitions = createCapabilityDefinitions({
            buildChapterScopeContext: (payload) => this.contextBuilder.buildForChapterScope(payload),
            buildContinuationContext: (payload) => this.contextBuilder.buildForContinueWriting(payload),
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

    private assembleAgentContext(input: {
        operation: string;
        systemPrompt: string;
        outputTokens: number;
        currentRequest: unknown;
        history?: AgentContextMessage[];
        sections?: AgentContextSection[];
        persistentSummary?: AgentConversationSummary | Record<string, unknown> | null;
        artifacts?: AgentContextArtifact[];
    }): AgentContextAssembly {
        const providerType = this.settingsCache.providerType;
        const model = providerType === 'http' ? this.settingsCache.http.model : 'mcp-cli';
        const contextWindowTokens = providerType === 'http'
            ? this.settingsCache.http.contextWindowTokens
            : this.settingsCache.mcpCli.contextWindowTokens;
        const assembly = this.agentContextAssembler.assemble({
            providerType,
            model,
            contextWindowTokens,
            outputTokens: input.outputTokens,
            systemPrompt: input.systemPrompt,
            currentRequest: input.currentRequest,
            history: input.history,
            sections: input.sections,
            persistentSummary: input.persistentSummary,
            artifacts: input.artifacts,
        });
        devLog('INFO', 'AiService.agentContext.assembled', 'Agent model context assembled', {
            operation: input.operation,
            ...assembly.diagnostics,
        });
        return assembly;
    }

    private assembleAgentPrompt(input: {
        operation: string;
        systemPrompt: string;
        outputTokens: number;
        currentRequest: unknown;
        history?: AgentContextMessage[];
        sections?: AgentContextSection[];
    }): string {
        return this.assembleAgentContext(input).prompt;
    }

    private assembleDraftGenerationPrompt(input: {
        operation: string;
        systemPrompt: string;
        outputTokens: number;
        structured: PromptPreviewResult['structured'];
        effectiveUserPrompt: string;
        usedContext: string[];
    }): string {
        return this.assembleAgentPrompt({
            operation: input.operation,
            systemPrompt: input.systemPrompt,
            outputTokens: input.outputTokens,
            currentRequest: input.structured,
            sections: [
                {
                    id: 'draft-generation-context',
                    kind: 'artifact',
                    priority: 'required',
                    value: input.effectiveUserPrompt,
                    sourceRef: 'context-builder',
                },
                {
                    id: 'context-references',
                    kind: 'metadata',
                    priority: 'low',
                    value: input.usedContext,
                },
            ],
        });
    }

    async generateAgentChat(payload: {
        message: string;
        role: string;
        locale?: string;
        approvalMode?: string;
        history?: Array<{ role: 'user' | 'assistant'; content: string; createdAt?: string; messageId?: string }>;
        availableReadTools?: string[];
        availableReadToolDefinitions?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
        availableOperations?: Array<Record<string, unknown>>;
        intentPreflight?: Record<string, unknown>;
        selectionContext?: Record<string, unknown>;
        toolObservations?: Array<{ toolName?: string; args?: unknown; result?: unknown; error?: string; ok?: boolean }>;
        conversationContext?: Record<string, unknown>;
        persistentSummary?: AgentConversationSummary | Record<string, unknown> | null;
        explorationNotes?: string[];
        forceFinalization?: boolean;
    }, signal?: AbortSignal): Promise<{
        content: string;
        shouldPlan: boolean;
        needsClarification: boolean;
        requestedOperations: string[];
        deliverable?: string;
        suggestedRole?: string;
        confidence: number;
        toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
        contextDiagnostics: AgentContextDiagnostics;
        conversationSummary?: AgentConversationSummary;
        contextCompression?: {
            applied: true;
            model: string;
            contextWindowTokens: number;
            inputBudgetTokens: number;
            estimatedInputTokens: number;
            historyMessagesTotal: number;
            historyMessagesKept: number;
            historyMessagesSummarized: number;
            historyMessagesOmitted: number;
            historyMessagesCompacted: number;
            persistentSummaryRevision: number;
            persistentSummaryMessageCount: number;
            recalledMessageCount: number;
            recalledArtifactCount: number;
            compressedSectionIds: string[];
            omittedSectionIds: string[];
        };
    }> {
        const message = trimText(payload.message, 8000);
        if (!message) throw new AiActionError('INVALID_INPUT', 'message is required');
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const roleLabels: Record<string, string> = {
            team: isZh ? '创作团队统筹' : 'creative team supervisor',
            writer: isZh ? '小说作者' : 'novel writer',
            editor: isZh ? '小说编辑' : 'novel editor',
            reader: isZh ? '普通读者评审' : 'reader reviewer',
            worldbuilding: isZh ? '世界观编辑' : 'worldbuilding editor',
            research_rag: isZh ? '考据与证据整理员' : 'research assistant',
        };
        const role = roleLabels[payload.role] || roleLabels.team;
        const history = (payload.history || []).map((item) => ({
            role: item.role,
            content: String(item.content || '').trim(),
            ...(item.createdAt ? { createdAt: String(item.createdAt) } : {}),
            ...(item.messageId ? { messageId: String(item.messageId) } : {}),
        })).filter((item) => item.content);
        const availableReadTools = dedupeStrings(payload.availableReadTools || [], 20);
        const availableReadToolDefinitions = (payload.availableReadToolDefinitions || [])
            .filter((item) => item && availableReadTools.includes(String(item.name || '')))
            .slice(0, 20)
            .map((item) => ({
                name: trimText(item.name, 80),
                description: trimText(item.description, 800),
                inputSchema: item.inputSchema && typeof item.inputSchema === 'object' ? item.inputSchema : {},
            }));
        const explorationNotes = (payload.explorationNotes || []).map((item) => trimText(item, 3000)).filter(Boolean).slice(-8);
        const availableOperations = Array.isArray(payload.availableOperations) ? payload.availableOperations.slice(0, 30) : [];
        const availableOperationIds = new Set(availableOperations.flatMap((item) => (
            typeof item?.id === 'string' ? [item.id] : []
        )));
        const toolObservations = (payload.toolObservations || []).map((item) => ({
            toolName: trimText(item.toolName, 80),
            args: item.args,
            result: item.result ?? null,
            error: trimText(item.error, 1000),
            ok: item.ok !== false,
        }));
        const rawSelection = payload.selectionContext && typeof payload.selectionContext === 'object'
            ? payload.selectionContext
            : {};
        const rawChapterScope = rawSelection.chapterScope && typeof rawSelection.chapterScope === 'object'
            ? rawSelection.chapterScope as Record<string, unknown>
            : null;
        const selectionIdentity = {
            novelId: trimText(rawSelection.novelId, 160),
            novelTitle: trimText(rawSelection.novelTitle, 300),
            volumeId: trimText(rawSelection.volumeId, 160),
            chapterId: trimText(rawSelection.chapterId, 160),
            chapterTitle: trimText(rawSelection.chapterTitle, 300),
            ...(rawSelection.attachmentScope && typeof rawSelection.attachmentScope === 'object' ? {
                attachmentScope: rawSelection.attachmentScope,
            } : {}),
            ...(Array.isArray(rawSelection.attachments) ? {
                attachments: rawSelection.attachments.slice(0, 10).map((item: any) => ({
                    attachmentId: trimText(item?.attachmentId, 160),
                    fileName: trimText(item?.fileName, 300),
                    characterCount: Math.max(0, Number(item?.characterCount) || 0),
                })).filter((item: any) => item.attachmentId),
            } : {}),
            ...(rawChapterScope ? {
                chapterScope: {
                    kind: trimText(rawChapterScope.kind, 40),
                    volumeId: trimText(rawChapterScope.volumeId, 160),
                    chapterIds: dedupeStrings(Array.isArray(rawChapterScope.chapterIds) ? rawChapterScope.chapterIds : [], 20),
                    anchorChapterId: trimText(rawChapterScope.anchorChapterId, 160),
                    processingMode: trimText(rawChapterScope.processingMode, 20),
                    experts: dedupeStrings(Array.isArray(rawChapterScope.experts) ? rawChapterScope.experts : [], 4),
                },
            } : {}),
        };
        const currentEditorContent = trimText(rawSelection.currentContent, 120000);
        const systemPrompt = isZh
            ? [
                `你是云梦小说智能体中的${role}。`,
                '自然、具体地回答创作问题。只有 ToolObservations 或 CurrentEditorContent 中存在结果时，才能声称已经读取对应的项目内容。',
                'PersistentSummary 是带来源 ID 的会话压缩投影，RecalledMessages/RecalledArtifacts 是按引用召回的原来源摘录；优先采用召回原文与工具证据，不得把旧助手结论当成项目事实。',
                '判断用户是在普通讨论，还是提出了需要读取项目上下文、检索、生成草稿或修改数据的明确任务。',
                'SelectionContext 是当前编辑器显式选中的项目范围。存在 chapterId 时，“这篇文章”“本章”“当前章”等指代必须直接绑定该章节，不得再次询问用户选择章节，也不得为定位它调用 novel.list、volume.list 或 chapter.list。需要持久化章节资料时直接使用该 chapterId 调用 chapter.get；CurrentEditorContent 是用户当前可见正文，优先于数据库中的旧正文。',
                '你可以从 AvailableReadTools 主动选择只读工具。回答依赖项目事实且 ToolObservations 不足时，先返回 toolCalls；每轮最多 3 个，不得调用名单外工具。',
                'AvailableReadToolDefinitions 是工具的真实参数结构，必须严格按其中的 inputSchema 调用；读取附件标题、页码、块或字符范围时优先使用 attachment.read。',
                '附件范围较长且返回 nextSelector 时，在 content 中保留截至当前块、不超过约 800 tokens 的累计发现，再继续读取；ExplorationNotes 会在下一轮带回这些发现。',
                '仅当 SelectionContext 没有可用目标，或用户明确要求跨章节、当前卷或全书范围时，才用 `volume.list` 发现真实 volumeId/chapterId；`chapter.list` 需要真实 volumeId，`chapter.get` 需要一个真实 chapterId。禁止虚构 ALL、ALL_IF_SUPPORTED 等占位 ID。',
                '收到 ToolObservations 后先综合结果；信息仍不足可继续调用只读工具，否则给出回答并将 toolCalls 设为空数组。',
                ...(payload.forceFinalization ? ['当前是强制总结轮，不得调用任何工具；必须基于已读证据作答，并明确覆盖范围和可能遗漏。'] : []),
                '从 AvailableOperations 中选择有序的 requestedOperations；复合任务必须保留用户要求的先后顺序，不得创造 Operation ID。',
                'requestedOperations 只包含用户当前明确要求执行的动作。问题、缺口、建议和可能的后续步骤不是执行授权：“检查需要补充说明之处”只请求审核，不请求生成素材；“给出润色建议”不请求改写；“评估续写准备度”不请求续写。只有用户明确要求起草、生成、续写或改写时，才选择 draft_write Operation。',
                'Role 只决定分析视角、能力范围和默认负责人，不得改变用户请求的 Operation、deliverable 或副作用等级。世界观角色下的只读检查仍然只能建议 report，不得因为角色擅长设定而追加 creative_asset.draft。',
                '尊重否定和交互约束。用户说“不要生成”“先别改”“只讨论”时，不得选择对应草稿 Operation；如果用户明确说“先检查，再起草”，则保留两个有序 Operation。',
                '同时建议 deliverable（none、report、expert_report、chapter_draft、chapter_draft_batch、creative_assets_draft）和 suggestedRole；结构化专家审核使用 expert_report，多章连续续写使用 chapter_draft_batch。这些只是语义建议，Runtime 会重新校验。',
                '只返回严格 JSON：{"content":"回复或当前意图","shouldPlan":true或false,"needsClarification":true或false,"requestedOperations":["chapter.consistency_review"],"deliverable":"report","suggestedRole":"editor","confidence":0.9,"toolCalls":[{"name":"plotline.list","args":{}}]}。',
                '项目中已有的大纲、章节、角色、设定和当前进度属于执行阶段可通过工具读取的信息；不要要求用户重复提供，也不要为读取这些信息而澄清，直接设置 shouldPlan=true。',
                '只有缺少无法通过项目工具获得、且会实质改变目标的用户偏好或创作决策时，才提出一个聚焦的澄清问题，设置 needsClarification=true 且 shouldPlan=false。',
                '在用户回答澄清问题之前不得生成计划；信息足以形成计划时，设置 needsClarification=false。',
                '明确且信息充分的任务 shouldPlan=true；寒暄、能力咨询和无需项目数据的轻量讨论 shouldPlan=false。',
            ].join(' ')
            : [
                `You are the ${role} inside CloudDream Novel Agent.`,
                'Answer naturally and specifically. Claim to have read project data only when ToolObservations or CurrentEditorContent contain the corresponding material.',
                'PersistentSummary is a traceable conversation projection. Prefer RecalledMessages, RecalledArtifacts, and tool evidence over summarized assistant outcomes, which are not project facts.',
                'SelectionContext is the explicit editor selection. When it includes chapterId, references such as "this article", "this chapter", or "current chapter" bind to it. Do not ask the user to select the chapter again and do not call novel.list, volume.list, or chapter.list merely to locate it. Use chapter.get with that exact ID when persisted data is needed. CurrentEditorContent is the visible editor text and takes precedence over an older saved body.',
                'When an answer depends on project facts and observations are insufficient, choose up to three tools from AvailableReadTools. After observations arrive, continue reading or answer with an empty toolCalls array.',
                'AvailableReadToolDefinitions contains the authoritative input schemas. Follow them exactly and prefer attachment.read for title, page, block, or offset ranges. Preserve no more than about 800 tokens of cumulative findings in content before requesting the next long-document chunk; ExplorationNotes will carry them forward.',
                'Use `volume.list` to discover IDs only when SelectionContext has no usable target or the user explicitly requests a multi-chapter, volume, or novel scope. `chapter.list` requires a real volumeId and `chapter.get` requires one real chapterId. Never invent placeholder IDs such as ALL or ALL_IF_SUPPORTED.',
                'Select ordered requestedOperations only from AvailableOperations. Preserve the requested order for compound tasks and never invent operation IDs.',
                'Include only actions the user explicitly asks to perform now. Findings, gaps, advice, and plausible next steps are not authorization. A request to identify missing explanations is review-only; polishing advice is not a rewrite; continuation readiness is not continuation. Select a draft_write operation only when the user explicitly requests drafting, generation, continuation, or rewriting.',
                'Role affects perspective, capability scope, and default ownership only. It must not change the requested operations, deliverable, or effect level. A read-only review remains read-only in the worldbuilding role.',
                'Respect negation and interaction constraints such as "do not generate", "do not rewrite", and "just discuss". Preserve both operations only when the user explicitly requests an ordered compound task such as review first, then draft.',
                'Suggest deliverable, suggestedRole, and confidence. They are untrusted semantic hints that the Runtime validates.',
                'Return strict JSON only: {"content":"reply or current intent","shouldPlan":boolean,"needsClarification":boolean,"requestedOperations":["chapter.consistency_review"],"deliverable":"report","suggestedRole":"editor","confidence":0.9,"toolCalls":[{"name":"plotline.list","args":{}}]}.',
                'Existing outlines, chapters, characters, lore, and project progress are available to approved execution tools. Do not ask the user to repeat them; set shouldPlan=true so the plan can read them.',
                'Ask one focused clarification question only when a user preference or creative decision unavailable from project tools would materially change the goal.',
                'Do not propose a plan until the user answers. Set needsClarification=false once enough information is available.',
                'Set shouldPlan=true only for sufficiently specified tasks that require project context, retrieval, draft generation, or data changes.',
                ...(payload.forceFinalization ? ['This is a forced finalization turn. Call no tools; answer from the evidence already read and state coverage and possible omissions.'] : []),
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 1600);
        const sections: AgentContextSection[] = [
            {
                id: 'available-read-tools',
                kind: 'metadata',
                priority: 'low',
                value: availableReadToolDefinitions.length ? availableReadToolDefinitions : availableReadTools,
            },
            {
                id: 'available-operations',
                kind: 'metadata',
                priority: 'high',
                value: availableOperations,
            },
        ];
        if (payload.intentPreflight) {
            sections.push({
                id: 'intent-preflight',
                kind: 'decision',
                priority: 'required',
                value: payload.intentPreflight,
            });
        }
        if (selectionIdentity.novelId || selectionIdentity.volumeId || selectionIdentity.chapterId) {
            sections.push({
                id: 'current-selection',
                kind: 'metadata',
                priority: 'required',
                value: selectionIdentity,
                sourceRef: 'renderer-current-selection',
            });
        }
        if (currentEditorContent) {
            sections.push({
                id: 'current-editor-content',
                kind: 'retrieval',
                priority: 'high',
                value: currentEditorContent,
                sourceRef: selectionIdentity.chapterId
                    ? `chapter:${selectionIdentity.chapterId}:editor-buffer`
                    : 'renderer-editor-buffer',
                maxTokens: 12000,
            });
        }
        if (toolObservations.length) {
            sections.push({
                id: 'tool-observations',
                kind: 'tool',
                priority: 'high',
                value: toolObservations,
                sourceRef: 'current-exploration-turn',
            });
        }
        if (explorationNotes.length) {
            sections.push({
                id: 'exploration-notes',
                kind: 'tool',
                priority: 'high',
                value: explorationNotes,
                sourceRef: 'current-exploration-working-memory',
                maxTokens: 6000,
            });
        }
        const contextArtifacts = collectAgentContextArtifacts(payload.conversationContext);
        if (payload.conversationContext && Object.keys(payload.conversationContext).length) {
            sections.push({
                id: 'conversation-state',
                kind: 'plan',
                priority: 'high',
                value: compactConversationArtifacts(payload.conversationContext),
                sourceRef: 'persisted-agent-conversation',
            });
        }
        const contextAssembly = this.assembleAgentContext({
            operation: 'agent.generate_chat',
            systemPrompt,
            outputTokens,
            currentRequest: {
                message,
                role: payload.role || 'team',
                workMode: payload.approvalMode || 'review_required',
                selection: selectionIdentity,
            },
            history,
            sections,
            persistentSummary: payload.persistentSummary,
            artifacts: contextArtifacts,
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt: contextAssembly.prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.5),
            timeoutMs: payload.forceFinalization
                ? Math.min(Math.max(this.settingsCache.http.timeoutMs, 15000), 45000)
                : Math.max(this.settingsCache.http.timeoutMs, 120000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        const content = trimText(parsed?.content, 12000) || trimText(response.text, 12000);
        if (!content) throw new AiActionError('UNKNOWN', 'Agent chat returned empty content');
        const toolCalls = Array.isArray(parsed?.toolCalls)
            ? parsed.toolCalls.slice(0, 3).flatMap((item: unknown) => {
                if (!item || typeof item !== 'object') return [];
                const call = item as { name?: unknown; args?: unknown };
                const name = trimText(call.name, 80);
                if (!name || !availableReadTools.includes(name)) return [];
                return [{
                    name,
                    args: call.args && typeof call.args === 'object' && !Array.isArray(call.args)
                        ? call.args as Record<string, unknown>
                        : {},
                }];
            })
            : [];
        const requestedOperations = Array.isArray(parsed?.requestedOperations)
            ? parsed.requestedOperations.slice(0, 8).flatMap((item: unknown) => {
                const operationId = trimText(item, 120);
                return operationId && availableOperationIds.has(operationId) ? [operationId] : [];
            })
            : [];
        const deliverable = ['none', 'report', 'expert_report', 'chapter_draft', 'chapter_draft_batch', 'creative_assets_draft'].includes(trimText(parsed?.deliverable, 40))
            ? trimText(parsed?.deliverable, 40)
            : undefined;
        const suggestedRole = ['team', 'writer', 'editor', 'reader', 'worldbuilding', 'research_rag'].includes(trimText(parsed?.suggestedRole, 40))
            ? trimText(parsed?.suggestedRole, 40)
            : undefined;
        const rawConfidence = typeof parsed?.confidence === 'number' ? parsed.confidence : 0.5;
        const diagnostics = contextAssembly.diagnostics;
        return {
            content,
            shouldPlan: parsed?.shouldPlan === true,
            needsClarification: parsed?.needsClarification === true,
            requestedOperations,
            deliverable,
            suggestedRole,
            confidence: Math.max(0, Math.min(1, rawConfidence)),
            toolCalls,
            contextDiagnostics: diagnostics,
            ...(contextAssembly.summaryUpdate ? { conversationSummary: contextAssembly.summaryUpdate } : {}),
            ...(diagnostics.compressionApplied ? {
                contextCompression: {
                    applied: true as const,
                    model: diagnostics.model,
                    contextWindowTokens: diagnostics.contextWindowTokens,
                    inputBudgetTokens: diagnostics.inputBudgetTokens,
                    estimatedInputTokens: diagnostics.estimatedInputTokens,
                    historyMessagesTotal: diagnostics.historyMessagesTotal,
                    historyMessagesKept: diagnostics.historyMessagesKept,
                    historyMessagesSummarized: diagnostics.historyMessagesSummarized,
                    historyMessagesOmitted: diagnostics.historyMessagesOmitted,
                    historyMessagesCompacted: diagnostics.historyMessagesCompacted,
                    persistentSummaryRevision: diagnostics.persistentSummaryRevision,
                    persistentSummaryMessageCount: diagnostics.persistentSummaryMessageCount,
                    recalledMessageCount: diagnostics.recalledMessageIds.length,
                    recalledArtifactCount: diagnostics.recalledArtifactIds.length,
                    compressedSectionIds: diagnostics.compressedSectionIds,
                    omittedSectionIds: diagnostics.omittedSectionIds,
                },
            } : {}),
        };
    }

    async generateChapterBeats(payload: ChapterBeatGenerationPayload, signal?: AbortSignal): Promise<ChapterBeatGenerationResult> {
        const novelId = trimText(payload.novelId, 160);
        const chapterId = trimText(payload.chapterId, 160);
        const goal = trimText(payload.goal, 4000);
        const chapterCount = Math.max(1, Math.min(5, Math.trunc(Number(payload.chapterCount) || 0)));
        if (!novelId || !chapterId || !goal || !Number.isFinite(Number(payload.chapterCount))) {
            throw new AiActionError('INVALID_INPUT', 'novelId, chapterId, goal and chapterCount are required');
        }
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const isRewrite = payload.taskMode === 'batch_rewrite';
        const systemPrompt = isRewrite
            ? (isZh
                ? [
                    '你是小说多章节改写节拍设计师。根据每个目标章节原文、共享范围上下文和用户目标，为明确选择的已有章节设计逐章修订节拍。',
                    `必须返回严格 JSON，beats 必须恰好 ${chapterCount} 项，并与 TargetChapterIds 顺序一一对应。`,
                    '每项字段为 title、chapterGoal、coreConflict、keyEvents、reveals、endingHook、targetWordCount。',
                    '节拍必须说明该章要保留和强化的叙事功能，不得把改写任务变成新增后续章节，不得改变目标章节数量。',
                    '只输出 JSON，不要输出 Markdown。',
                ].join(' ')
                : [
                    'Design one rewrite beat for each explicitly selected existing chapter, in TargetChapterIds order.',
                    `Return strict JSON with exactly ${chapterCount} beats. Do not turn rewrites into new continuation chapters.`,
                    'Output JSON only.',
                ].join(' '))
            : isZh
            ? [
                '你是小说多章节节拍设计师。根据已有上下文和用户目标，为连续新增章节设计可执行节拍。',
                `必须返回严格 JSON，beats 必须恰好 ${chapterCount} 项。`,
                '每项字段为 title、chapterGoal、coreConflict、keyEvents、reveals、endingHook、targetWordCount。',
                'keyEvents 和 reveals 必须是字符串数组；targetWordCount 为 100 到 50000 的整数。',
                '各章节需要前后依赖、逐步推进，不得重复同一事件，不得虚构与上下文明显冲突的既有事实。',
                '只输出 JSON，不要输出 Markdown。',
            ].join(' ')
            : [
                'Design an ordered batch of executable chapter beats from the supplied novel context.',
                `Return strict JSON with exactly ${chapterCount} beats.`,
                'Each beat requires title, chapterGoal, coreConflict, keyEvents, reveals, endingHook, and targetWordCount.',
                'Output JSON only.',
            ].join(' ');
        const contextText = JSON.stringify(payload.context ?? {}).slice(0, 60000);
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt: `Goal=${goal}\n\nAnchorChapterId=${chapterId}\n\nTargetChapterIds=${JSON.stringify(payload.targetChapterIds || [])}\n\nContext=${contextText}`,
            maxTokens: Math.min(this.settingsCache.http.maxTokens, 3200),
            temperature: Math.min(this.settingsCache.http.temperature, 0.55),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 120000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        const rawBeats = Array.isArray(parsed?.beats) ? parsed.beats : [];
        if (rawBeats.length !== chapterCount) {
            throw new AiActionError('UNKNOWN', `Chapter beat generation returned ${rawBeats.length}/${chapterCount} beats`);
        }
        const beats = rawBeats.map((raw: any, index: number) => {
            const title = trimText(raw?.title, 120);
            const chapterGoal = trimText(raw?.chapterGoal, 800);
            const coreConflict = trimText(raw?.coreConflict, 800);
            const endingHook = trimText(raw?.endingHook, 800);
            if (!title || !chapterGoal || !coreConflict || !endingHook) {
                throw new AiActionError('UNKNOWN', `Chapter beat ${index + 1} is incomplete`);
            }
            const targetWordCount = Math.max(100, Math.min(50000, Math.trunc(Number(raw?.targetWordCount) || 2000)));
            return {
                title,
                chapterGoal,
                coreConflict,
                keyEvents: Array.isArray(raw?.keyEvents)
                    ? raw.keyEvents.map((item: unknown) => trimText(item, 500)).filter(Boolean).slice(0, 12)
                    : [],
                reveals: Array.isArray(raw?.reveals)
                    ? raw.reveals.map((item: unknown) => trimText(item, 500)).filter(Boolean).slice(0, 12)
                    : [],
                endingHook,
                targetWordCount,
            };
        });
        return { beats };
    }

    async extractNarrativeState(
        payload: NarrativeStateExtractionPayload,
        signal?: AbortSignal,
    ): Promise<NarrativeStateExtractionResult> {
        const generatedText = trimText(payload.generatedText, 80000);
        if (!generatedText) throw new AiActionError('INVALID_INPUT', 'generatedText is required');
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const characters = Array.isArray(payload.characters) ? payload.characters.slice(0, 100) : [];
        const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
        const systemPrompt = isZh
            ? [
                '你是小说章节状态增量提取器。只提取本章正文明确发生或明确揭示的变化，不做文学评价。',
                '所有 evidenceExcerpt 必须是本章正文中的连续原文短句；没有直接原文证据的变化必须省略。',
                'characterKey 和 itemKey 优先使用提供的实体 key；正文中新出现且没有登记 key 的实体使用正文中的明确名称。',
                'knowledgeChanges 只记录角色在本章实际得知或明确遗忘的信息，不得把读者知道的信息自动算作角色知道。',
                '关系变化必须是本章发生的信任、敌意、结盟、决裂等实际变化，普通对话不算变化。',
                'resolvedConflicts/openedConflicts 也必须有正文证据，不得仅根据节拍推断已经完成。',
                '只返回严格 JSON，不要 Markdown。',
                '格式：{"characterLocations":[{"characterKey":"角色key或名称","location":"章末位置","evidenceExcerpt":"正文原句"}],"relationshipChanges":[{"sourceCharacterKey":"角色","targetCharacterKey":"角色","change":"变化","evidenceExcerpt":"正文原句"}],"knowledgeChanges":[{"characterKey":"角色","learned":["得知事实"],"forgotten":[],"evidenceExcerpt":"正文原句"}],"itemStates":[{"itemKey":"物品","state":"章末状态","holderKey":"可选持有者","location":"可选位置","evidenceExcerpt":"正文原句"}],"resolvedConflicts":[{"conflict":"已解决冲突","evidenceExcerpt":"正文原句"}],"openedConflicts":[{"conflict":"新增冲突","evidenceExcerpt":"正文原句"}],"warnings":[]}。',
            ].join(' ')
            : [
                'Extract only explicit end-of-chapter narrative state changes from the supplied generated chapter.',
                'Every evidenceExcerpt must be an exact contiguous quote from the chapter. Omit unsupported inferences.',
                'Distinguish character knowledge from reader knowledge and report only actual relationship changes.',
                'Return strict JSON with characterLocations, relationshipChanges, knowledgeChanges, itemStates, resolvedConflicts, openedConflicts, and warnings.',
            ].join(' ');
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt: [
                `KnownCharacters=${JSON.stringify(characters)}`,
                `KnownItems=${JSON.stringify(items)}`,
                `CurrentBeat=${JSON.stringify(payload.currentBeat || {}).slice(0, 8000)}`,
                `PriorStateLedger=${JSON.stringify(payload.priorStateLedger || {}).slice(0, 16000)}`,
                `GeneratedChapter=${generatedText}`,
            ].join('\n\n'),
            maxTokens: Math.min(this.settingsCache.http.maxTokens, 3200),
            temperature: Math.min(this.settingsCache.http.temperature, 0.1),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 120000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed) throw new AiActionError('UNKNOWN', 'Narrative state extraction returned invalid JSON');
        const normalized = normalizeNarrativeStateDelta(parsed);
        const evidenced = filterNarrativeStateDeltaEvidence(normalized, generatedText);
        const allowedCharacterKeys = new Set(characters.flatMap((item) => [item.key, item.name]).filter(Boolean));
        const allowedItemKeys = new Set(items.flatMap((item) => [item.key, item.name]).filter(Boolean));
        const characterIsGrounded = (key: string): boolean => allowedCharacterKeys.has(key) || generatedText.includes(key);
        const itemIsGrounded = (key: string): boolean => allowedItemKeys.has(key) || generatedText.includes(key);
        const delta = {
            ...evidenced,
            characterLocations: evidenced.characterLocations.filter((item) => characterIsGrounded(item.characterKey)),
            relationshipChanges: evidenced.relationshipChanges.filter((item) => (
                characterIsGrounded(item.sourceCharacterKey) && characterIsGrounded(item.targetCharacterKey)
            )),
            knowledgeChanges: evidenced.knowledgeChanges.filter((item) => characterIsGrounded(item.characterKey)),
            itemStates: evidenced.itemStates.filter((item) => (
                itemIsGrounded(item.itemKey) && (!item.holderKey || characterIsGrounded(item.holderKey))
            )),
        };
        return { delta };
    }

    async generateAgentPlan(payload: {
        goal: string;
        role?: string;
        locale?: string;
        availableTools: string[];
        availableToolchains?: Array<Record<string, unknown>>;
        intentDecision?: Record<string, unknown>;
    }, signal?: AbortSignal): Promise<{ title: string; deliverable?: string; steps: Array<{ agent: string; title: string; tools: string[]; toolchain?: Record<string, unknown> }> }> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        const availableTools = dedupeStrings(payload.availableTools || [], 50);
        const availableToolchains = Array.isArray(payload.availableToolchains) ? payload.availableToolchains.slice(0, 20) : [];
        if (!availableTools.length) throw new AiActionError('INVALID_INPUT', 'availableTools is required');
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说创作 Agent 的计划器，只负责拆解计划，不执行工具。',
                '返回 1 到 8 个可审核步骤，每步指定一个 agent 和零到多个工具。',
                'agent 只能是 supervisor、writer、editor、reader、worldbuilding、research_rag。',
                'PreferredRole 不是 team 时，它是主视角和最终产出负责人；只在任务确有需要时加入辅助 agent，除非用户要求，否则不要加入 reader 评估。',
                '必须声明 deliverable：普通分析为 report；带逐条 finding、证据与审批的作者/编辑/读者/世界观/考据/团队审核为 expert_report；单章正文续写或改写为 chapter_draft；连续生成多章为 chapter_draft_batch；大纲、剧情线、角色、世界观或创作素材的新增与修改为 creative_assets_draft。',
                '草稿产物必须有且仅有一个生产者：优先选择能产生目标草稿的 AvailableToolchain；没有匹配链时，chapter_draft 才使用 chapter.generate_draft，creative_assets_draft 才使用 creative_assets.generate_draft。',
                'tools 只能从 AvailableTools 中选择；不要添加写回正文步骤，草稿必须停在审核阶段。',
                'AvailableToolchains 是经过校验的稳定流程。上下文装配、一致性审校、章节续写和创作素材生成等匹配任务应优先选择对应 Toolchain，不要重新拼装同一批原子 tools。',
                'IntentDecision 是 Runtime 校验后的高优先级任务提示。严格保持 operations 顺序、deliverable 和建议 Toolchain；能力不可用时才回退到 AvailableTools。',
                '使用 Toolchain 的步骤必须令 tools=[]，并填写 toolchain={"id":"稳定ID","version":"版本","input":{}}；不得猜测未列出的 ID 或版本。',
                '只返回严格 JSON：{"title":"计划标题","deliverable":"report|expert_report|chapter_draft|chapter_draft_batch|creative_assets_draft","steps":[{"agent":"editor","title":"步骤","tools":[],"toolchain":{"id":"chapter.consistency_review","version":"1.0.0","input":{}}}]}。',
            ].join(' ')
            : [
                'You plan tasks for a novel-writing agent. Plan only; do not execute tools.',
                'Return 1-8 reviewable steps as strict JSON with title and steps.',
                'Agents: supervisor, writer, editor, reader, worldbuilding, research_rag.',
                'When PreferredRole is not team, keep it as the primary perspective and deliverable owner. Do not add reader evaluation unless the user requests it.',
                'Declare deliverable as report, expert_report, chapter_draft, chapter_draft_batch, or creative_assets_draft. Use expert_report for structured expert findings and review. Use chapter_draft_batch for multi-chapter continuation. A draft deliverable must have exactly one producer.',
                'Use only AvailableTools. Generated changes must stop at draft review and never write directly.',
                'Prefer a matching AvailableToolchain for context assembly, consistency review, chapter continuation, or creative-asset drafting. A Toolchain step must have tools=[] and a listed id/version.',
                'IntentDecision is a validated high-priority planning hint. Preserve operation order and deliverable, using suggested Toolchains when available.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 2400);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_plan',
            systemPrompt,
            outputTokens,
            currentRequest: {
                goal,
                preferredRole: payload.role || 'team',
                intentDecision: payload.intentDecision || null,
            },
            sections: [{
                id: 'available-tools',
                kind: 'metadata',
                priority: 'high',
                value: availableTools,
            }, {
                id: 'available-toolchains',
                kind: 'metadata',
                priority: 'high',
                value: availableToolchains,
            }, {
                id: 'intent-decision',
                kind: 'decision',
                priority: payload.intentDecision ? 'required' : 'low',
                value: payload.intentDecision || null,
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.35),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 120000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed || !Array.isArray(parsed.steps)) {
            throw new AiActionError('UNKNOWN', 'Agent planner did not return valid JSON steps');
        }
        return {
            title: trimText(parsed.title, 120) || (isZh ? '创作任务计划' : 'Writing task plan'),
            deliverable: trimText(parsed.deliverable, 40),
            steps: parsed.steps,
        };
    }

    async reviseAgentPlan(payload: {
        goal: string;
        revision: string;
        role?: string;
        locale?: string;
        availableTools: string[];
        availableToolchains?: Array<Record<string, unknown>>;
        currentPlan: {
            title: string;
            deliverable?: string;
            preferredRole?: string;
            steps: Array<{ stepId: string; agent: string; title: string; tools: string[]; toolchain?: Record<string, unknown> }>;
        };
    }, signal?: AbortSignal): Promise<{ title: string; deliverable?: string; steps: Array<{ stepId?: string; agent: string; title: string; tools: string[]; toolchain?: Record<string, unknown> }> }> {
        const goal = trimText(payload.goal, 12000);
        const revision = trimText(payload.revision, 8000);
        if (!goal || !revision) throw new AiActionError('INVALID_INPUT', 'goal and revision are required');
        const availableTools = dedupeStrings(payload.availableTools || [], 50);
        const availableToolchains = Array.isArray(payload.availableToolchains) ? payload.availableToolchains.slice(0, 20) : [];
        if (!availableTools.length) throw new AiActionError('INVALID_INPUT', 'availableTools is required');
        const currentSteps = Array.isArray(payload.currentPlan?.steps) ? payload.currentPlan.steps.slice(0, 8) : [];
        if (!currentSteps.length) throw new AiActionError('INVALID_INPUT', 'currentPlan.steps is required');
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说创作 Agent 的计划修订器，只修改结构化计划，不执行工具。',
                '根据 Revision 精确增删、重排或修改步骤，不要忽略用户意见。',
                '未改变的步骤保留原 stepId；新增步骤不要填写 stepId。',
                'agent 只能是 supervisor、writer、editor、reader、worldbuilding、research_rag。',
                'tools 只能从 AvailableTools 中选择；任何生成内容必须停在草稿审核，禁止直接写回。',
                '保留仍适用的 Toolchain 调用；新选 Toolchain 只能来自 AvailableToolchains，且该步骤 tools 必须为空。',
                '保留或按用户意见更新 currentPlan.deliverable；草稿产物必须保留对应的 generate_draft 工具。',
                '只返回严格 JSON：{"title":"计划标题","deliverable":"report|expert_report|chapter_draft|chapter_draft_batch|creative_assets_draft","steps":[{"stepId":"可选原ID","agent":"editor","title":"步骤","tools":[]}]}。',
            ].join(' ')
            : [
                'Revise a structured novel-agent plan without executing it.',
                'Apply the revision precisely. Preserve stepId for unchanged steps and omit it for new steps.',
                'Use only the allowed agents and AvailableTools. Generated changes must stop at draft review.',
                'Return strict JSON with title and steps only.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 2400);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.revise_plan',
            systemPrompt,
            outputTokens,
            currentRequest: {
                goal,
                revision,
                preferredRole: payload.role || 'team',
            },
            sections: [
                {
                    id: 'current-plan',
                    kind: 'plan',
                    priority: 'required',
                    value: { title: payload.currentPlan.title, deliverable: payload.currentPlan.deliverable, steps: currentSteps },
                },
                {
                    id: 'available-tools',
                    kind: 'metadata',
                    priority: 'high',
                    value: availableTools,
                },
                {
                    id: 'available-toolchains',
                    kind: 'metadata',
                    priority: 'high',
                    value: availableToolchains,
                },
            ],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.25),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 120000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed || !Array.isArray(parsed.steps)) {
            throw new AiActionError('UNKNOWN', 'Agent plan revision did not return valid JSON steps');
        }
        return {
            title: trimText(parsed.title, 120) || payload.currentPlan.title,
            deliverable: trimText(parsed.deliverable, 40),
            steps: parsed.steps,
        };
    }

    async generateAgentConsistencyReview(payload: {
        goal: string;
        locale?: string;
        dimensions?: string[];
        contextBundle: Record<string, unknown>;
    }, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        if (!payload.contextBundle || typeof payload.contextBundle !== 'object') {
            throw new AiActionError('INVALID_INPUT', 'contextBundle is required');
        }
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说章节一致性审核器，只能依据 ContextBundle 中的章节与项目证据作判断。',
                '分别检查人物行为与状态、情节线与时间顺序、世界规则、地点、物品和技能。',
                '没有项目证据时不得把推测写成事实：evidence 必须为空，并在 uncertainty 中明确需要人工确认。',
                '同一问题只输出一次。每条 evidence 只能引用 ContextBundle 中实际存在的来源，不得伪造 ID、标题或原文。',
                '无法检查的维度放入 uncheckableDimensions，不要为了凑分数编造结论。',
                '只返回一个严格 JSON 对象，不要 Markdown 或代码围栏。',
                '格式：{"overallScore":0,"summary":"摘要","dimensions":[{"id":"character","label":"人物","score":0,"reason":"依据","checkable":true}],"issues":[{"issueId":"issue-1","type":"character_state","severity":"critical|high|medium|low|info","title":"问题","location":"章节位置","excerpt":"章节短引文","evidence":[{"sourceType":"character","sourceId":"可选","title":"来源","excerpt":"证据","confidence":0.8,"metadata":{}}],"recommendation":"建议","uncertainty":"不确定性"}],"uncheckableDimensions":[{"dimension":"维度","reason":"原因"}],"warnings":[]}。',
            ].join(' ')
            : [
                'Review chapter consistency using only the supplied ContextBundle.',
                'Check character state, plot and timeline, world rules, locations, items, and skills.',
                'Never state an unsupported inference as fact. Leave evidence empty and explain uncertainty when project evidence is missing.',
                'Deduplicate issues and list uncheckable dimensions explicitly.',
                'Return one strict JSON object only, with overallScore, summary, dimensions, issues, uncheckableDimensions, and warnings.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 4200);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_consistency_review',
            systemPrompt,
            outputTokens,
            currentRequest: {
                goal,
                dimensions: Array.isArray(payload.dimensions) ? payload.dimensions.slice(0, 12) : [],
            },
            sections: [{
                id: 'context-bundle',
                kind: 'retrieval',
                priority: 'required',
                value: payload.contextBundle,
                sourceRef: 'chapter.context@1.0.0',
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.2),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 180000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed || !Array.isArray(parsed.dimensions) || !Array.isArray(parsed.issues)) {
            throw new AiActionError('UNKNOWN', 'Consistency reviewer did not return valid structured JSON');
        }
        return parsed;
    }

    async generateAgentWriterRangeRevisionPlan(payload: {
        goal: string;
        locale?: string;
        dimensions?: string[];
        scopeBundle: Record<string, unknown>;
    }, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        if (!payload.scopeBundle || typeof payload.scopeBundle !== 'object') {
            throw new AiActionError('INVALID_INPUT', 'scopeBundle is required');
        }
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说作者的多章节修订规划器，只能依据 ChapterScopeBundle 中已批准范围、正文/摘要、项目资料和检索证据作判断。',
                '评估文风漂移、场景强弱、章节作用、改写优先级和继续创作前的准备度；这是修订计划，不直接改写正文。',
                'finding.chapterIds 和 rewriteOrder 只能使用 scope.chapterIds 中的真实 ID。evidence.sourceId 和 evidenceRefs 只能引用 bundle 中真实存在的来源。',
                '不得伪造章节、引文、证据 ID 或已经发生的修改。证据不足时 evidence 与 evidenceRefs 置空，并在 uncertainty 中说明。',
                'rewriteOrder 只列确有必要改写的章节，按优先级排序；continuationReadiness 说明继续写之前需要先处理什么。',
                'recommendedRole 只能是 writer、editor、worldbuilding、research_rag。只返回严格 JSON 对象，不要 Markdown 或代码围栏。',
                '格式：{"overallScore":0,"summary":"摘要","dimensions":[{"id":"style_drift","label":"文风稳定性","score":0,"reason":"依据","checkable":true}],"findings":[{"findingId":"finding-1","title":"修订项","summary":"判断","category":"style_drift|scene_strength|rewrite_priority|continuation_readiness|other","severity":"critical|high|medium|low|info","chapterIds":["真实章节ID"],"evidenceRefs":["真实来源ID"],"evidence":[{"sourceType":"chapter|character|plotline|rag","sourceId":"真实ID","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendation":"可执行修订建议","recommendedRole":"writer|editor|worldbuilding|research_rag","uncertainty":"不确定性"}],"rewriteOrder":["真实章节ID"],"continuationReadiness":"续写准备判断","recommendations":["总体建议"],"warnings":[]}。',
            ].join(' ')
            : [
                'Plan revisions for an approved multi-chapter range as a fiction writer using only the supplied ChapterScopeBundle.',
                'Assess style drift, scene strength, chapter function, rewrite priority, and readiness for continued writing. Do not rewrite prose.',
                'Use only real target chapter IDs and real evidence source IDs from the bundle. Never fabricate text, IDs, evidence, or completed changes.',
                'Order only chapters that genuinely need rewriting and explain continuation readiness. Return one strict JSON object only.',
            ].join(' ');
        const scopedChapterCount = Array.isArray((payload.scopeBundle as any)?.scope?.chapterIds)
            ? (payload.scopeBundle as any).scope.chapterIds.length
            : 1;
        const outputTokens = Math.min(
            this.settingsCache.http.maxTokens,
            Math.min(6000, Math.max(2800, 2200 + scopedChapterCount * 240)),
        );
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_writer_range_revision_plan',
            systemPrompt,
            outputTokens,
            currentRequest: {
                goal,
                dimensions: Array.isArray(payload.dimensions) ? payload.dimensions.slice(0, 12) : [],
            },
            sections: [{
                id: 'chapter-scope-bundle',
                kind: 'retrieval',
                priority: 'required',
                value: payload.scopeBundle,
                sourceRef: 'writer.range_revision_plan@1.0.0',
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.2),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 210000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed || !Array.isArray(parsed.dimensions) || !Array.isArray(parsed.findings)) {
            throw new AiActionError('UNKNOWN', 'Writer revision planner did not return valid structured JSON');
        }
        return parsed;
    }

    async generateAgentEditorRangeReview(payload: {
        goal: string;
        locale?: string;
        dimensions?: string[];
        scopeBundle: Record<string, unknown>;
    }, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        if (!payload.scopeBundle || typeof payload.scopeBundle !== 'object') {
            throw new AiActionError('INVALID_INPUT', 'scopeBundle is required');
        }
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说编辑的多章节范围审核器，只能依据 ChapterScopeBundle 中已批准范围、正文/摘要、项目资料和检索证据作判断。',
                '从结构、节奏、人物动机、文字质量和跨章连续性审核；只做编辑分析，不做读者体验、世界观专审或事实考据报告。',
                'finding.chapterIds 只能使用 scope.chapterIds 中的真实 ID。evidence.sourceId 和 evidenceRefs 只能引用 chapters、entityContext、plotContext、narrativeSummaries 或 evidence 中真实存在的 ID。',
                '不得伪造章节、引文、证据 ID 或已经发生的修改。证据不足时 evidence 与 evidenceRefs 置空，并在 uncertainty 中说明。',
                '问题要去重并可执行。recommendedRole 只能是 writer、editor、worldbuilding、research_rag。',
                '只返回严格 JSON 对象，不要 Markdown 或代码围栏。',
                '格式：{"overallScore":0,"summary":"摘要","dimensions":[{"id":"structure","label":"结构","score":0,"reason":"依据","checkable":true}],"findings":[{"findingId":"finding-1","title":"问题","summary":"判断","category":"structure|pacing|motivation|prose|continuity|other","severity":"critical|high|medium|low|info","chapterIds":["真实章节ID"],"evidenceRefs":["真实来源ID"],"evidence":[{"sourceType":"chapter|character|plotline|rag","sourceId":"真实ID","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendation":"修订建议","recommendedRole":"writer|editor|worldbuilding|research_rag","uncertainty":"不确定性"}],"recommendations":["总体建议"],"warnings":[]}。',
            ].join(' ')
            : [
                'Review an approved multi-chapter range as a novel editor using only the supplied ChapterScopeBundle.',
                'Assess structure, pacing, character motivation, prose quality, and cross-chapter continuity. Do not produce reader, worldbuilding, or fact-check reports.',
                'Use only real target chapter IDs and real evidence source IDs from the bundle. Never fabricate text, IDs, evidence, or project changes.',
                'Leave evidence empty and explain uncertainty when support is insufficient. Deduplicate findings and make recommendations actionable.',
                'Return one strict JSON object with overallScore, summary, dimensions, findings, recommendations, and warnings.',
            ].join(' ');
        const scopedChapterCount = Array.isArray((payload.scopeBundle as any)?.scope?.chapterIds)
            ? (payload.scopeBundle as any).scope.chapterIds.length
            : 1;
        const outputTokens = Math.min(
            this.settingsCache.http.maxTokens,
            Math.min(6000, Math.max(2800, 2200 + scopedChapterCount * 240)),
        );
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_editor_range_review',
            systemPrompt,
            outputTokens,
            currentRequest: {
                goal,
                dimensions: Array.isArray(payload.dimensions) ? payload.dimensions.slice(0, 12) : [],
            },
            sections: [{
                id: 'chapter-scope-bundle',
                kind: 'retrieval',
                priority: 'required',
                value: payload.scopeBundle,
                sourceRef: 'editor.range_review@1.0.0',
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.2),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 210000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed || !Array.isArray(parsed.dimensions) || !Array.isArray(parsed.findings)) {
            throw new AiActionError('UNKNOWN', 'Editor range reviewer did not return valid structured JSON');
        }
        return parsed;
    }

    async generateAgentReaderChapterEvaluation(payload: {
        locale?: string;
        chapter: {
            chapterId?: string;
            title?: string;
            contentMode?: string;
            content?: string;
        };
        priorReaderState?: string;
        position?: { index?: number; count?: number };
    }, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const chapterId = trimText(payload.chapter?.chapterId, 200);
        const content = trimText(payload.chapter?.content, 80000);
        if (!chapterId || !content) {
            throw new AiActionError('INVALID_INPUT', 'chapter.chapterId and chapter.content are required');
        }
        const priorReaderState = trimText(payload.priorReaderState, 2000);
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是首次阅读小说的普通读者评估器，必须严格按章节顺序盲读。',
                '你只能知道本次输入的当前章节，以及 priorReaderState 中前序章节留下的读者记忆。不得使用未来章节、世界观后台资料、人物卡、情节线、检索资料或其他专家结论。',
                '不要把猜测当作事实；只评估当前章造成的困惑、情绪、悬念、沉浸感、弃读风险与追更动力。',
                'findings 中 chapterIds、evidenceRefs 和 evidence.sourceId 只能使用当前 chapterId，evidence.sourceType 只能是 chapter。',
                'readerStateSummary 必须是供下一章读者继承的简洁已知状态，只记录读者已看到的事实、未解疑问、情绪和期待，不得补入后台答案。',
                '只返回严格 JSON 对象，不要 Markdown 或代码围栏。',
                '格式：{"chapterId":"当前ID","chapterTitle":"标题","clarityScore":0,"emotionalIntensity":0,"suspenseScore":0,"retentionScore":0,"dominantEmotion":"情绪","confusionPoints":[],"immersionBreaks":[],"effectiveHooks":[],"expectations":[],"dropRisk":"low|medium|high","summary":"本章读者反馈","readerStateSummary":"传递给下一章的读者已知状态","findings":[{"findingId":"finding-1","title":"问题","summary":"判断","category":"confusion|emotion|suspense|immersion|drop_risk|retention|other","severity":"critical|high|medium|low|info","chapterIds":["当前ID"],"evidenceRefs":["当前ID"],"evidence":[{"sourceType":"chapter","sourceId":"当前ID","title":"当前章","excerpt":"短证据"}],"recommendation":"建议","recommendedRole":"writer|editor","uncertainty":"不确定性"}],"warnings":[]}。',
            ].join(' ')
            : [
                'Act as a first-time fiction reader and evaluate chapters in strict reading order.',
                'You may use only the current chapter and priorReaderState from earlier chapters. Never use future chapters, backstage worldbuilding, character sheets, plotlines, retrieval evidence, or other expert conclusions.',
                'Evaluate confusion, emotion, suspense, immersion, drop risk, and retention without presenting guesses as facts.',
                'All finding and evidence references must use only the current chapter ID.',
                'readerStateSummary must contain only what the reader now knows, wonders, feels, and expects for the next chapter.',
                'Return one strict JSON object with scores, feedback lists, dropRisk, summary, readerStateSummary, findings, and warnings.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 4200);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_reader_chapter_evaluation',
            systemPrompt,
            outputTokens,
            currentRequest: {
                priorReaderState,
                position: payload.position || {},
            },
            sections: [{
                id: 'current-reader-chapter',
                kind: 'retrieval',
                priority: 'required',
                value: {
                    chapterId,
                    title: trimText(payload.chapter.title, 300),
                    contentMode: trimText(payload.chapter.contentMode, 40) || 'full',
                    content,
                },
                sourceRef: 'reader.journey_review@1.0.0',
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.35),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 210000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (
            !parsed
            || typeof parsed.summary !== 'string'
            || typeof parsed.readerStateSummary !== 'string'
            || !Array.isArray(parsed.findings)
        ) {
            throw new AiActionError('UNKNOWN', 'Reader journey evaluator did not return valid structured JSON');
        }
        return parsed;
    }

    async generateAgentWorldbuildingRangeConsistency(payload: {
        goal: string;
        locale?: string;
        dimensions?: string[];
        scopeBundle: Record<string, unknown>;
    }, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        if (!payload.scopeBundle || typeof payload.scopeBundle !== 'object') {
            throw new AiActionError('INVALID_INPUT', 'scopeBundle is required');
        }
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说世界观编辑的多章节一致性审核器，只能依据已批准的 ChapterScopeBundle、已登记项目实体和实际检索证据作判断。',
                '检查规则、术语、角色能力、地点空间、物品属性和跨章状态漂移；不要输出读者体验、文风评价或外部现实考据。',
                '必须区分“明确冲突”“正文尚未解释”和“覆盖不足无法判断”。未提及某条设定不等于违反设定，不得把缺少说明直接判定为冲突。',
                'finding.chapterIds 只能使用 scope.chapterIds 中的目标章节 ID；subjectIds 只能使用 entityContext 中真实存在的角色、物品、世界设定或地图 ID。',
                'evidence.sourceId 与 evidenceRefs 只能引用 chapters、entityContext、plotContext、narrativeSummaries 或 evidence 中真实存在的 ID。不得伪造规则、引文、实体、章节或已完成的修改。',
                '证据不足时 evidence 和 evidenceRefs 置空，并在 uncertainty 中说明。重复冲突只输出一次。recommendedRole 只能是 writer、editor、worldbuilding。',
                '只返回严格 JSON 对象，不要 Markdown 或代码围栏。',
                '格式：{"consistencyScore":0,"summary":"摘要","dimensions":[{"id":"rules","label":"规则","score":0,"reason":"依据","checkable":true}],"findings":[{"findingId":"finding-1","title":"冲突","summary":"判断","category":"rule_conflict|terminology|ability|location|item|state_drift|chronology|other","severity":"critical|high|medium|low|info","chapterIds":["真实章节ID"],"subjectIds":["真实实体ID"],"evidenceRefs":["真实来源ID"],"evidence":[{"sourceType":"chapter|character|worldsetting|item|map|plotline|rag","sourceId":"真实ID","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendation":"修订建议","recommendedRole":"writer|editor|worldbuilding","uncertainty":"不确定性"}],"entityAssessments":[{"entityType":"worldsetting|character|item|map|term|other","entityId":"可选真实实体ID","name":"名称","status":"consistent|conflict|insufficient","chapterIds":["真实章节ID"],"summary":"状态判断","evidence":[],"uncertainty":"不确定性"}],"recommendations":["总体建议"],"warnings":[]}。',
            ].join(' ')
            : [
                'Review worldbuilding consistency across an approved ChapterScopeBundle using only registered project entities and supplied retrieval evidence.',
                'Check rules, terminology, character abilities, locations, items, and cross-chapter state drift. Do not perform reader, prose, or real-world fact review.',
                'Distinguish an explicit contradiction from an unexplained detail or insufficient coverage. An omitted rule is not automatically a conflict.',
                'Use only real target chapter IDs, entity IDs, and evidence source IDs from the bundle. Never fabricate lore, quotes, IDs, or project changes.',
                'Leave evidence empty and explain uncertainty when support is insufficient. Deduplicate findings.',
                'Return one strict JSON object with consistencyScore, summary, dimensions, findings, entityAssessments, recommendations, and warnings.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 6000);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_worldbuilding_range_consistency',
            systemPrompt,
            outputTokens,
            currentRequest: {
                goal,
                dimensions: Array.isArray(payload.dimensions) ? payload.dimensions.slice(0, 12) : [],
            },
            sections: [{
                id: 'chapter-scope-bundle',
                kind: 'retrieval',
                priority: 'required',
                value: payload.scopeBundle,
                sourceRef: 'worldbuilding.range_consistency@1.0.0',
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.2),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 210000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (
            !parsed
            || typeof parsed.summary !== 'string'
            || !Array.isArray(parsed.dimensions)
            || !Array.isArray(parsed.findings)
            || !Array.isArray(parsed.entityAssessments)
        ) {
            throw new AiActionError('UNKNOWN', 'Worldbuilding consistency reviewer did not return valid structured JSON');
        }
        return parsed;
    }

    async extractAgentResearchClaims(payload: {
        goal: string;
        locale?: string;
        maxClaims?: number;
        scopeBundle: Record<string, unknown>;
    }, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        if (!payload.scopeBundle || typeof payload.scopeBundle !== 'object') {
            throw new AiActionError('INVALID_INPUT', 'scopeBundle is required');
        }
        const maxClaims = Math.max(1, Math.min(12, Number(payload.maxClaims || 8)));
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说考据流程的声明抽取器，只从 ChapterScopeBundle 的目标章节中提取可被证据核验的现实事实、历史、科学、医学、法律、技术、地理、文化或经济陈述。',
                '不要提取纯虚构世界规则、人物情绪、审美评价、剧情预测或无法形成明确陈述的句子。',
                'chapterId 必须是 scope.chapterIds 中真实存在的目标章节 ID；excerpt 必须是当前输入中的短摘录，不得改写成不存在的原文。',
                'searchKeyword 用于当前小说项目全文检索，应简短且有辨识度。requiresExternalEvidence 表示仅靠项目内容和已导入资料通常无法可靠核验。',
                `最多返回 ${maxClaims} 条，按对作品可信度的影响排序并去重。只返回严格 JSON，不要 Markdown。`,
                '格式：{"claims":[{"claimId":"claim-1","statement":"可核验陈述","chapterId":"真实章节ID","excerpt":"短摘录","category":"historical|scientific|medical|legal|technical|geographic|cultural|economic|other","importance":"high|medium|low","searchKeyword":"项目检索词","needsProjectSearch":true,"requiresExternalEvidence":false}],"warnings":[]}。',
            ].join(' ')
            : [
                'Extract evidence-checkable real-world claims only from target chapters in the supplied ChapterScopeBundle.',
                'Exclude fictional lore, emotions, aesthetic opinions, plot predictions, and vague statements.',
                'Use only real target chapter IDs and excerpts present in the input. Produce short project-search keywords and flag claims that require external evidence.',
                `Return at most ${maxClaims} deduplicated claims in strict JSON with claims and warnings.`,
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 3200);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.extract_research_claims',
            systemPrompt,
            outputTokens,
            currentRequest: { goal, maxClaims },
            sections: [{
                id: 'chapter-scope-bundle',
                kind: 'retrieval',
                priority: 'required',
                value: payload.scopeBundle,
                sourceRef: 'research.range_fact_check@1.0.0',
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.1),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 210000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed || !Array.isArray(parsed.claims)) {
            throw new AiActionError('UNKNOWN', 'Research claim extractor did not return valid structured JSON');
        }
        return parsed;
    }

    async generateAgentResearchFactCheck(payload: {
        goal: string;
        locale?: string;
        scopeBundle: Record<string, unknown>;
        claims?: unknown[];
        projectSearchEvidence?: Record<string, unknown[]>;
        externalSearchAvailable?: boolean;
    }, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        if (!payload.scopeBundle || typeof payload.scopeBundle !== 'object') {
            throw new AiActionError('INVALID_INPUT', 'scopeBundle is required');
        }
        if (!Array.isArray(payload.claims)) {
            throw new AiActionError('INVALID_INPUT', 'claims is required');
        }
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说考据与事实核查器，只能核验输入 claims 中已经抽取的声明，不得新增声明。',
                '证据仅来自 ChapterScopeBundle、已导入 RAG evidence 和 projectSearchEvidence。search.query 是小说项目全文搜索，不是互联网搜索；externalSearchAvailable=false。',
                '不得生成网址、书名、作者、机构、引文、来源 ID 或查询结果中不存在的证据。需要外部资料但当前证据不足时，verdict 必须是 unverified，并说明应补充何种可靠来源。',
                'supported 表示现有可追溯证据支持；contradicted 表示证据明确相反；mixed 表示来源或条件冲突；not_applicable 表示抽取项并非可核验事实。',
                'claimId 只能来自输入 claims；chapterIds 固定为该声明章节。evidence.sourceId 与 evidenceRefs 只能使用输入中真实存在的章节、项目实体、RAG 或项目搜索来源 ID。',
                'confidence 范围 0 到 1；没有证据时不得高于 0.3。只返回严格 JSON，不要 Markdown 或代码围栏。',
                '格式：{"overallReliabilityScore":0,"summary":"摘要","claims":[],"findings":[{"findingId":"finding-1","claimId":"真实claimId","statement":"原声明","summary":"核验判断","verdict":"supported|contradicted|mixed|unverified|not_applicable","confidence":0.8,"category":"historical|scientific|medical|legal|technical|geographic|cultural|economic|other","severity":"critical|high|medium|low|info","chapterIds":["真实章节ID"],"evidenceRefs":["真实来源ID"],"evidence":[{"sourceType":"chapter|rag|project_search","sourceId":"真实ID","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendation":"修订或补证建议","recommendedRole":"writer|editor|research_rag","uncertainty":"不确定性"}],"recommendations":[],"warnings":[],"searchStats":{}}。',
            ].join(' ')
            : [
                'Fact-check only the supplied claims using the ChapterScopeBundle, imported RAG evidence, and actual projectSearchEvidence.',
                'Project search is internal novel search, not internet search, and externalSearchAvailable is false. Never fabricate URLs, publications, authors, institutions, quotes, IDs, or sources.',
                'Claims requiring unavailable external evidence must remain unverified. Use only real claim, chapter, and evidence IDs from the input.',
                'Return strict JSON with overallReliabilityScore, summary, findings, recommendations, warnings, and searchStats.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 6000);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_research_fact_check',
            systemPrompt,
            outputTokens,
            currentRequest: {
                goal,
                claims: payload.claims,
                projectSearchEvidence: payload.projectSearchEvidence || {},
                externalSearchAvailable: false,
            },
            sections: [{
                id: 'chapter-scope-bundle',
                kind: 'retrieval',
                priority: 'required',
                value: payload.scopeBundle,
                sourceRef: 'research.range_fact_check@1.0.0',
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.1),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 210000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.findings)) {
            throw new AiActionError('UNKNOWN', 'Research fact-check reviewer did not return valid structured JSON');
        }
        return parsed;
    }

    async generateAgentScopeAudit(payload: {
        goal: string;
        locale?: string;
        childReports?: Array<Record<string, unknown>>;
    }, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        const childReports = Array.isArray(payload.childReports) ? payload.childReports : [];
        if (!childReports.length) {
            throw new AiActionError('INVALID_INPUT', 'childReports is required');
        }
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说团队审计 Supervisor，只能汇总输入中实际执行的专家子报告。不得读取正文、补做专家分析或伪造未执行专家意见。',
                '综合 finding 必须通过 sourceFindingIds 引用子报告中真实 findingId；sourceExperts 只能来自对应子报告 expert。',
                '相同问题要去重：多个专家支持同一判断标为 consensus；只有一个来源标为 single；专家判断实质冲突时标为 conflict，并在 conflicts 中保留双方来源。',
                '不得改变来源证据含义，不得生成新的 evidence sourceId、章节 ID、事实或已经发生的修改。',
                '建议按严重度、影响范围和专家共识排序。只返回严格 JSON，不要 Markdown 或代码围栏。',
                '格式：{"summary":"综合摘要","experts":[],"findings":[{"findingId":"audit-1","title":"问题","summary":"综合判断","category":"分类","severity":"critical|high|medium|low|info","chapterIds":["来源中的真实章节ID"],"sourceFindingIds":["真实findingId"],"sourceExperts":["editor|reader|worldbuilding|research_rag"],"relationship":"consensus|single|conflict","evidenceRefs":["来源中的真实证据ID"],"evidence":[],"recommendation":"建议","recommendedRole":"writer|editor|worldbuilding|research_rag","uncertainty":"不确定性"}],"conflicts":[{"conflictId":"conflict-1","topic":"分歧主题","sourceFindingIds":["至少两个真实findingId"],"experts":["至少两个专家"],"summary":"分歧","resolution":"处理建议"}],"recommendations":[],"warnings":[]}。',
            ].join(' ')
            : [
                'Act as a fiction audit supervisor and aggregate only the expert child reports actually provided.',
                'Never invent an unexecuted expert opinion, new finding, chapter, evidence source, fact, or project change.',
                'Every aggregate finding must cite real sourceFindingIds. Mark multi-expert agreement as consensus, one source as single, and substantive disagreement as conflict.',
                'Return strict JSON with summary, findings, conflicts, recommendations, and warnings.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 6000);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_scope_audit',
            systemPrompt,
            outputTokens,
            currentRequest: { goal },
            sections: [{
                id: 'executed-expert-reports',
                kind: 'artifact',
                priority: 'required',
                value: childReports,
                sourceRef: 'novel.scope_audit@1.0.0',
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.15),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 210000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (
            !parsed
            || typeof parsed.summary !== 'string'
            || !Array.isArray(parsed.findings)
            || !Array.isArray(parsed.conflicts)
        ) {
            throw new AiActionError('UNKNOWN', 'Scope audit supervisor did not return valid structured JSON');
        }
        return parsed;
    }

    async generateAgentPlotlineAnalysis(payload: {
        novelId?: string;
        goal: string;
        locale?: string;
        scope?: 'chapter' | 'volume' | 'novel';
        context: Record<string, unknown>;
    }, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        if (!payload.context || typeof payload.context !== 'object') {
            throw new AiActionError('INVALID_INPUT', 'context is required');
        }
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说情节线结构分析器，只能依据 PlotlineAnalysisContext 中已登记的情节线、章节摘录和检索证据作判断。',
                '分析主线与支线的推进程度、伏笔是否得到回收、长时间未推进的线索、节奏和连续性风险。',
                '不要续写正文，不要生成草稿，也不要声称已经修改作品。',
                '每条 evidence 只能引用输入中真实存在的 plotlineId 或 chapterId；不得伪造 ID、标题、章节内容或证据。',
                '范围未覆盖到的章节不能推断为没有发生；证据不足时 evidence 置空，并在 uncertainty 中说明。',
                '同一问题只输出一次。recommendation 必须是可执行的编辑建议，不得把猜测包装成事实。',
                '只返回一个严格 JSON 对象，不要 Markdown 或代码围栏。',
                '格式：{"overallScore":0,"summary":"摘要","threads":[{"plotlineId":"可选真实ID","name":"情节线","role":"main|subplot|unknown","status":"状态","progressionScore":0,"lastProgressLocation":"位置","coveredChapterIds":["真实chapterId"],"findings":["发现"],"evidence":[{"sourceType":"chapter|plotline|rag","sourceId":"真实ID或空","title":"来源","excerpt":"短证据","confidence":0.8,"metadata":{}}],"recommendations":["建议"],"uncertainty":"不确定性"}],"issues":[{"issueId":"issue-1","type":"stalled|unresolved_foreshadowing|pacing|continuity|coverage|other","severity":"critical|high|medium|low|info","title":"问题","plotlineIds":["真实ID"],"chapterIds":["真实ID"],"evidence":[],"recommendation":"建议","uncertainty":"不确定性"}],"recommendations":["总体建议"],"warnings":[]}。',
            ].join(' ')
            : [
                'Analyze plotline structure using only the supplied PlotlineAnalysisContext.',
                'Assess main and subplots, foreshadowing resolution, stalled threads, pacing, and continuity.',
                'Do not draft prose or claim any project change. Never fabricate IDs, chapter text, or evidence.',
                'Treat uncovered chapters as unknown. When evidence is missing, leave evidence empty and explain uncertainty.',
                'Return one strict JSON object with overallScore, summary, threads, issues, recommendations, and warnings.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 5200);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_plotline_analysis',
            systemPrompt,
            outputTokens,
            currentRequest: {
                novelId: trimText(payload.novelId, 200),
                goal,
                scope: payload.scope || 'novel',
            },
            sections: [{
                id: 'plotline-analysis-context',
                kind: 'retrieval',
                priority: 'required',
                value: payload.context,
                sourceRef: 'plotline.analysis@1.0.0',
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.2),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 210000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed || !Array.isArray(parsed.threads) || !Array.isArray(parsed.issues)) {
            throw new AiActionError('UNKNOWN', 'Plotline analyzer did not return valid structured JSON');
        }
        return parsed;
    }

    async generateAgentReport(payload: {
        goal: string;
        planTitle?: string;
        role?: string;
        locale?: string;
        steps?: Array<{ agent?: string; title?: string; status?: string }>;
        findings?: Array<{ toolName?: string; stepTitle?: string; data?: unknown }>;
        approvalResponses?: Array<Record<string, unknown>>;
        draftSessionId?: string;
        deliverable?: string;
    }, signal?: AbortSignal): Promise<{ content: string; conversationSummary: string }> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说创作 Agent 的最终报告撰写器。',
                '根据已执行计划、工具结果和用户确认，直接回答原始任务。',
                '必须给出具体发现、判断依据和可执行建议；读者任务要明确困惑点、期待点、弃读风险和追更动力。',
                '只能使用输入中提供的事实，不得声称执行了未列出的工具，不得编造正文细节。',
                'PreferredRole 是报告主视角。不得添加 Steps 中未执行 agent 的专属评估章节；例如没有 reader 步骤时，不得输出“读者视角评估”。',
                '如果证据不足，要明确指出缺口。若已生成草稿，说明草稿已进入审核，不要声称已经写回正文。',
                '一次生成两个版本：content 是供“产物”面板保存的完整 Markdown 报告；conversationSummary 是显示在会话中的精炼交付说明。',
                'conversationSummary 要像任务完成回执：先直接说明完成结果，再概括最重要的结论、变更或建议；控制在 2 至 5 个短段落或不超过 5 个要点，不要复制完整报告。',
                '若有完整报告，conversationSummary 可提示用户在“产物”中查看详情，但不要虚构产物名称或数量。',
                '只返回严格 JSON：{"content":"完整 Markdown 报告","conversationSummary":"精炼 Markdown 交付说明"}，不要复述内部事件名称。',
            ].join(' ')
            : [
                'Write the final report for a novel-writing agent run.',
                'Answer the original goal using only the supplied plan, findings, and user decisions.',
                'Give concrete findings, rationale, and actionable recommendations. State evidence gaps clearly.',
                'Use PreferredRole as the primary perspective. Do not add role-specific sections for agents absent from Steps.',
                'If a draft exists, say it is ready for review; never claim it was committed.',
                'Produce two versions: content is the complete Markdown report saved as an artifact; conversationSummary is a concise completion handoff shown in chat.',
                'The conversationSummary must lead with the outcome, capture only the most important conclusions, changes, or next actions in 2-5 short paragraphs or at most 5 bullets, and must not duplicate the full report.',
                'It may direct the user to the artifact for details, but must not invent artifact names or counts.',
                'Return strict JSON only: {"content":"complete Markdown report","conversationSummary":"concise Markdown completion handoff"}. Do not mention internal event names.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 4000);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.generate_report',
            systemPrompt,
            outputTokens,
            currentRequest: {
                goal,
                preferredRole: payload.role || 'team',
                deliverable: trimText(payload.deliverable, 40),
            },
            sections: [
                {
                    id: 'executed-plan',
                    kind: 'plan',
                    priority: 'high',
                    value: {
                        title: trimText(payload.planTitle, 200),
                        steps: payload.steps || [],
                    },
                },
                {
                    id: 'tool-findings',
                    kind: 'retrieval',
                    priority: 'required',
                    value: payload.findings || [],
                    sourceRef: 'executed-agent-tools',
                },
                {
                    id: 'approval-responses',
                    kind: 'decision',
                    priority: 'high',
                    value: payload.approvalResponses || [],
                    sourceRef: 'user-approvals',
                },
                {
                    id: 'draft-artifact',
                    kind: 'artifact',
                    priority: 'high',
                    value: { draftSessionId: trimText(payload.draftSessionId, 200) },
                },
            ],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: Math.min(this.settingsCache.http.temperature, 0.45),
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 180000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        const content = trimText(parsed?.content, 20000);
        const conversationSummary = trimText(parsed?.conversationSummary, 4000);
        if (!content) throw new AiActionError('UNKNOWN', 'Agent final report returned empty content');
        if (!conversationSummary) throw new AiActionError('UNKNOWN', 'Agent final report returned empty conversation summary');
        return { content, conversationSummary };
    }

    async detectAgentCreativeDirection(payload: {
        goal: string;
        planTitle?: string;
        stepTitle?: string;
        analysisSummary?: string;
        locale?: string;
    }, signal?: AbortSignal): Promise<{
        requiresDecision: boolean;
        title?: string;
        question?: string;
        reason?: string;
        options?: Array<{ id?: string; label: string; description?: string }>;
    }> {
        const goal = trimText(payload.goal, 12000);
        if (!goal) throw new AiActionError('INVALID_INPUT', 'goal is required');
        const isZh = (payload.locale || 'zh-CN').startsWith('zh');
        const systemPrompt = isZh
            ? [
                '你是小说创作 Agent 的执行前决策分析器，不生成正文，也不调用工具。',
                '判断任务在生成草稿前是否存在两个或以上互斥且会显著改变成稿的创作方向。',
                '普通细节差异、可以同时满足的要求、证据不足都不属于创作方向分歧。',
                '只有必须由用户选择时 requiresDecision=true，并给出 2 到 4 个具体、互斥、可执行的选项。',
                '只返回严格 JSON：{"requiresDecision":false}，或 {"requiresDecision":true,"title":"方向确认","question":"...","reason":"...","options":[{"id":"可选","label":"...","description":"..."}]}。',
            ].join(' ')
            : [
                'You detect mutually exclusive creative directions before a novel draft is generated.',
                'Do not write prose or call tools. Minor details, compatible requirements, and evidence quality are not direction conflicts.',
                'Return strict JSON. Set requiresDecision=true only when the user must choose among 2-4 concrete, exclusive directions.',
            ].join(' ');
        const outputTokens = Math.min(this.settingsCache.http.maxTokens, 1200);
        const prompt = this.assembleAgentPrompt({
            operation: 'agent.detect_creative_direction',
            systemPrompt,
            outputTokens,
            currentRequest: {
                goal,
                planTitle: trimText(payload.planTitle, 200),
                stepTitle: trimText(payload.stepTitle, 200),
            },
            sections: [{
                id: 'analysis-summary',
                kind: 'retrieval',
                priority: 'high',
                value: trimText(payload.analysisSummary, 2000),
            }],
        });
        const response = await this.getProvider().generate({
            systemPrompt,
            prompt,
            maxTokens: outputTokens,
            temperature: 0.1,
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 120000),
            signal,
        });
        const parsed = parseJsonObject(response.text);
        if (!parsed || typeof parsed.requiresDecision !== 'boolean') {
            throw new AiActionError('UNKNOWN', 'Creative direction detector returned invalid JSON');
        }
        if (!parsed.requiresDecision) return { requiresDecision: false };
        return {
            requiresDecision: true,
            title: trimText(parsed.title, 120),
            question: trimText(parsed.question, 500),
            reason: trimText(parsed.reason, 1000),
            options: Array.isArray(parsed.options) ? parsed.options : [],
        };
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
        const prompt = this.assembleDraftGenerationPrompt({
            operation: 'chapter.preview_generation_context',
            systemPrompt: bundle.systemPrompt,
            outputTokens: this.settingsCache.http.maxTokens,
            structured: bundle.structured,
            effectiveUserPrompt: bundle.effectiveUserPrompt,
            usedContext: bundle.usedContext,
        });
        devLog('INFO', 'AiService.previewContinuePrompt.success', 'Preview continue prompt success', {
            chapterId: payload.chapterId,
        });
        return {
            structured: bundle.structured,
            rawPrompt: buildRawPromptPreview(bundle.systemPrompt, prompt),
            editableUserPrompt: bundle.defaultUserPrompt,
            usedContext: bundle.usedContext,
            warnings: bundle.warnings,
        };
    }

    async continueWriting(payload: ContinueWritingPayload, signal?: AbortSignal): Promise<ContinueWritingResult> {
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
        const prompt = this.assembleDraftGenerationPrompt({
            operation: 'chapter.generate_draft',
            systemPrompt: bundle.systemPrompt,
            outputTokens: this.settingsCache.http.maxTokens,
            structured: bundle.structured,
            effectiveUserPrompt: bundle.effectiveUserPrompt,
            usedContext: bundle.usedContext,
        });

        const response = await provider.generate({
            systemPrompt: bundle.systemPrompt,
            prompt,
            maxTokens: this.settingsCache.http.maxTokens,
            temperature: generationTemperature,
            signal,
        });
        signal?.throwIfAborted();

        const consistency = await this.checkConsistency({
            novelId: payload.novelId,
            text: response.text,
        });

        const result = {
            text: response.text,
            usedContext: bundle.usedContext,
            warnings: bundle.warnings,
            contextPolicy: bundle.contextPolicy,
            contextSnapshot: bundle.contextSnapshot,
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

    async askNovel(payload: RagAskPayload, signal?: AbortSignal): Promise<RagAskResult> {
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
            signal,
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

    async upsertRagChapterIndex(chapterId: string, options?: { skipIfNovelNotIndexed?: boolean }): Promise<{ chunks: number; sources: number; provider: string; model: string; dimensions: number; fallbackUsed: boolean; fallbackError?: string; novelId?: string; sourceId: string; skipped?: boolean }> {
        if (options?.skipIfNovelNotIndexed) {
            const chapter = await db.chapter.findUnique({
                where: { id: chapterId },
                select: { volume: { select: { novelId: true } } },
            });
            const novelId = chapter?.volume?.novelId;
            if (!novelId || await getRagVectorChunkCount(novelId) === 0) {
                return {
                    chunks: 0,
                    sources: 0,
                    provider: 'none',
                    model: 'not-indexed',
                    dimensions: 0,
                    fallbackUsed: false,
                    sourceId: chapterId,
                    novelId,
                    skipped: true,
                };
            }
        }
        return upsertRagChapterIndex(chapterId, this.settingsCache.embedding);
    }

    async upsertRagSourceIndex(sourceType: RagEvidenceSourceType, sourceId: string, options?: { skipIfNovelNotIndexed?: boolean }): Promise<{ chunks: number; sources: number; provider: string; model: string; dimensions: number; fallbackUsed: boolean; fallbackError?: string; novelId?: string; sourceType: RagEvidenceSourceType; sourceId: string; skipped?: boolean }> {
        if (sourceType === 'chapter') {
            const result = await this.upsertRagChapterIndex(sourceId, options);
            return { ...result, sourceType };
        }
        if (options?.skipIfNovelNotIndexed) {
            const doc = await buildVectorDocumentForSource(sourceType, sourceId);
            const novelId = doc?.novelId;
            if (!novelId || await getRagVectorChunkCount(novelId) === 0) {
                return {
                    chunks: 0,
                    sources: 0,
                    provider: 'none',
                    model: 'not-indexed',
                    dimensions: 0,
                    fallbackUsed: false,
                    sourceType,
                    sourceId,
                    novelId,
                    skipped: true,
                };
            }
        }
        return upsertRagSourceIndex(sourceType, sourceId, this.settingsCache.embedding);
    }

    async deleteRagChapterIndex(novelId: string, chapterId: string): Promise<{ deleted: number }> {
        return deleteRagVectorSource({
            novelId,
            sourceType: 'chapter',
            sourceId: chapterId,
        });
    }

    async deleteRagSourceIndex(novelId: string, sourceType: RagEvidenceSourceType, sourceId: string): Promise<{ deleted: number }> {
        return deleteRagVectorSource({ novelId, sourceType, sourceId });
    }

    deleteGeneratedMapAsset(relativePath: string): boolean {
        const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!normalized.startsWith('maps/')) return false;
        const mapsRoot = path.resolve(this.userDataPath, 'maps');
        const absolutePath = path.resolve(this.userDataPath, normalized);
        if (absolutePath !== mapsRoot && !absolutePath.startsWith(`${mapsRoot}${path.sep}`)) return false;
        if (!fs.existsSync(absolutePath)) return false;
        fs.unlinkSync(absolutePath);
        return true;
    }

    private refreshRagSourceIndexInBackground(sourceType: RagEvidenceSourceType, sourceId: string, reason: string): void {
        void this.upsertRagSourceIndex(sourceType, sourceId, { skipIfNovelNotIndexed: true }).catch((error) => {
            console.warn('[RAG] Failed to refresh source index:', { sourceType, sourceId, reason, error });
        });
    }

    private async refreshLatestCreativeAssetIndexes(novelId: string, draft: CreativeAssetsDraft): Promise<void> {
        const findByNames = async (model: any, names: string[]) => {
            if (names.length === 0) return [];
            return model.findMany({
                where: { novelId, name: { in: names } },
                select: { id: true },
            });
        };
        const plotLineNames = (draft.plotLines ?? []).map((item) => item.name).filter(Boolean);
        const characterNames = (draft.characters ?? []).map((item) => item.name).filter(Boolean);
        const itemNames = [
            ...(draft.items ?? []).map((item) => item.name),
            ...(draft.skills ?? []).map((item) => item.name),
        ].filter(Boolean);

        const [plotLines, characters, items] = await Promise.all([
            findByNames((db as any).plotLine, plotLineNames),
            findByNames((db as any).character, characterNames),
            findByNames((db as any).item, itemNames),
        ]);
        for (const row of plotLines) this.refreshRagSourceIndexInBackground('plotLine', row.id, 'confirm-creative-assets');
        for (const row of characters) this.refreshRagSourceIndexInBackground('character', row.id, 'confirm-creative-assets');
        for (const row of items) this.refreshRagSourceIndexInBackground('item', row.id, 'confirm-creative-assets');

        const plotPoints = await (db as any).plotPoint.findMany({
            where: { novelId },
            orderBy: { createdAt: 'desc' },
            take: Math.max(0, (draft.plotPoints?.length ?? 0) + (draft.plotLines ?? []).reduce((sum, line) => sum + (line.points?.length ?? 0), 0)),
            select: { id: true },
        });
        for (const row of plotPoints) this.refreshRagSourceIndexInBackground('plotPoint', row.id, 'confirm-creative-assets');
    }

    private refreshRagAfterAction(actionId: string, result: unknown): void {
        const row = result && typeof result === 'object' ? result as { id?: unknown } : null;
        const id = typeof row?.id === 'string' ? row.id : '';
        if (!id) return;
        if (actionId === 'worldsetting.create' || actionId === 'worldsetting.update') {
            this.refreshRagSourceIndexInBackground('worldSetting', id, actionId);
        }
    }

    async previewCreativeAssetsPrompt(payload: CreativeAssetsGeneratePayload): Promise<PromptPreviewResult> {
        devLog('INFO', 'AiService.previewCreativeAssetsPrompt.start', 'Preview creative assets prompt start', {
            novelId: payload.novelId,
            briefLength: payload.brief?.length ?? 0,
            targetSections: payload.targetSections,
        });
        const bundle = await this.buildCreativeAssetsPromptBundle(payload);
        const prompt = this.assembleDraftGenerationPrompt({
            operation: 'creative_assets.preview_generation_context',
            systemPrompt: bundle.systemPrompt,
            outputTokens: this.settingsCache.http.maxTokens,
            structured: bundle.structured,
            effectiveUserPrompt: bundle.effectiveUserPrompt,
            usedContext: bundle.usedContext,
        });
        devLog('INFO', 'AiService.previewCreativeAssetsPrompt.success', 'Preview creative assets prompt success', {
            novelId: payload.novelId,
        });
        return {
            structured: bundle.structured,
            rawPrompt: buildRawPromptPreview(bundle.systemPrompt, prompt),
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

    async generateCreativeAssets(payload: CreativeAssetsGeneratePayload, signal?: AbortSignal): Promise<{ draft: CreativeAssetsDraft }> {
        devLog('INFO', 'AiService.generateCreativeAssets.start', 'Generate creative assets start', {
            novelId: payload.novelId,
            briefLength: payload.brief?.length ?? 0,
            providerType: this.settingsCache.providerType,
            targetSections: payload.targetSections,
        });
        const provider = this.getProvider();
        const bundle = await this.buildCreativeAssetsPromptBundle(payload);
        const targetSections = this.resolveCreativeTargetSections(payload);
        const prompt = this.assembleDraftGenerationPrompt({
            operation: 'creative_assets.generate_draft',
            systemPrompt: bundle.systemPrompt,
            outputTokens: this.settingsCache.http.maxTokens,
            structured: bundle.structured,
            effectiveUserPrompt: bundle.effectiveUserPrompt,
            usedContext: bundle.usedContext,
        });
        const response = await provider.generate({
            systemPrompt: bundle.systemPrompt,
            prompt,
            maxTokens: this.settingsCache.http.maxTokens,
            temperature: this.settingsCache.http.temperature,
            // 创作工坊需要生成多个板块的结构化 JSON，内容量大，使用更宽裕的超时
            timeoutMs: Math.max(this.settingsCache.http.timeoutMs, 180000),
            signal,
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
        const createdEntities: CreativeAssetWritebackEntitySnapshot[] = [];
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
                    createdEntities.push(createCreativeAssetEntitySnapshot('plotLine', createdLine));
                    plotLineIdByName.set(plotLine.name.toLowerCase(), createdLine.id);
                    localCreated.plotLines += 1;

                    for (const point of plotLine.points ?? []) {
                        const createdPoint = await (tx as any).plotPoint.create({
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
                        createdEntities.push(createCreativeAssetEntitySnapshot('plotPoint', createdPoint));
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
                    createdEntities.push(createCreativeAssetEntitySnapshot('plotLine', autoLine));
                    plotLineIdByName.set(defaultName.toLowerCase(), autoLine.id);
                    localCreated.plotLines += 1;
                    return autoLine.id;
                };

                for (const point of draft.plotPoints ?? []) {
                    const lineId = await resolvePlotLineIdForLoosePoint(point.plotLineName);
                    const createdPoint = await (tx as any).plotPoint.create({
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
                    createdEntities.push(createCreativeAssetEntitySnapshot('plotPoint', createdPoint));
                    localCreated.plotPoints += 1;
                }

                for (const character of draft.characters ?? []) {
                    const createdCharacter = await (tx as any).character.create({
                        data: {
                            novelId: payload.novelId,
                            name: character.name,
                            role: character.role || null,
                            description: character.description || null,
                            profile: toProfileJson(character.profile),
                            sortOrder: Date.now() + localCreated.characters,
                        },
                    });
                    createdEntities.push(createCreativeAssetEntitySnapshot('character', createdCharacter));
                    localCreated.characters += 1;
                }

                for (const item of draft.items ?? []) {
                    const createdItem = await (tx as any).item.create({
                        data: {
                            novelId: payload.novelId,
                            name: item.name,
                            type: item.type || 'item',
                            description: item.description || null,
                            profile: toProfileJson(item.profile),
                            sortOrder: Date.now() + localCreated.items,
                        },
                    });
                    createdEntities.push(createCreativeAssetEntitySnapshot('item', createdItem));
                    localCreated.items += 1;
                }

                for (const skill of draft.skills ?? []) {
                    const createdSkill = await (tx as any).item.create({
                        data: {
                            novelId: payload.novelId,
                            name: skill.name,
                            type: 'skill',
                            description: skill.description || null,
                            profile: toProfileJson(skill.profile),
                            sortOrder: Date.now() + localCreated.items + localCreated.skills,
                        },
                    });
                    createdEntities.push(createCreativeAssetEntitySnapshot('item', createdSkill));
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
                    let persistedMap = map;
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
                        persistedMap = await (tx as any).mapCanvas.update({
                            where: { id: map.id },
                            data: { background: saved.relativePath },
                        });
                        localCreated.mapImages += 1;
                    }
                    createdEntities.push(createCreativeAssetEntitySnapshot('mapCanvas', persistedMap));
                }

                committedCreated = localCreated;
            });

            const result = {
                success: true,
                created: committedCreated,
                createdEntities,
                warnings: validation.warnings,
                transactionMode: 'atomic' as const,
            };
            void this.refreshLatestCreativeAssetIndexes(payload.novelId, draft).catch((error) => {
                console.warn('[RAG] Failed to refresh creative asset indexes:', error);
            });
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
            const result = await handler(input.payload);
            this.refreshRagAfterAction(input.actionId, result);
            return result;
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
            recentChapters: recentChapters.slice(0, 20).map((chapter: any) => ({
                title: trimText(chapter?.title, 120),
                contentMode: trimText(chapter?.contentMode, 24),
                excerpt: trimText(chapter?.excerpt, chapter?.contentMode === 'summary' || chapter?.contentMode === 'excerpt' ? 2400 : 12000),
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
            currentChapterBeforeCursor: trimText(input.currentChapterBeforeCursor, 12000),
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
        contextPolicy: import('../../shared/agentChapterScope').ContinuationContextPolicy;
        contextSnapshot: import('../../shared/agentChapterScope').ContinuationContextSnapshot;
    }> {
        const isZh = /^zh/i.test(String(payload.locale || '').trim());
        const writeMode: 'new_chapter' | 'continue_chapter' | 'rewrite_chapter' =
            payload.mode === 'new_chapter'
                ? 'new_chapter'
                : payload.mode === 'rewrite_chapter'
                    ? 'rewrite_chapter'
                    : 'continue_chapter';
        const preparedContext = payload.preparedContext;
        const canReusePreparedContext = preparedContext?.policy?.version === 'continuation-context-v1'
            && preparedContext.snapshot?.novelId === payload.novelId
            && preparedContext.snapshot?.anchorChapterId === payload.chapterId;
        const context = canReusePreparedContext
            ? preparedContext
            : await this.contextBuilder.buildForContinueWriting({
                ...payload,
                mode: writeMode === 'new_chapter' ? 'new_chapter' : 'continue_chapter',
                recentRawChapterCount: payload.recentRawChapterCount ?? this.settingsCache.summary.recentChapterRawCount,
            });
        const compactHardContext = this.compactContinueHardContext(context.hardContext as Record<string, unknown>);
        const dynamicContextForPrompt = writeMode === 'rewrite_chapter'
            ? {
                ...context.dynamicContext,
                currentChapterBeforeCursor: extractPlainTextFromLexical(payload.currentContent || context.currentContentSource),
            }
            : context.dynamicContext;
        const compactDynamicContext = this.compactContinueDynamicContext(dynamicContextForPrompt as Record<string, unknown>);
        const normalizedUserIntent = trimText(payload.userIntent, 800);
        const normalizedCurrentLocation = trimText(payload.currentLocation, 120);
        const batchContext = payload.batchContext && typeof payload.batchContext === 'object'
            ? payload.batchContext
            : undefined;
        const writeParamsForPrompt = {
            ...context.params,
            targetLength: isZh
                ? `约${Math.max(100, Math.min(4000, Number(context.params.targetLength || 500)))}汉字`
                : `about ${Math.max(100, Math.min(4000, Number(context.params.targetLength || 500)))} Chinese characters`,
        };
        const systemPrompt = writeMode === 'rewrite_chapter'
            ? (isZh
                ? '你是中文小说章节改写助手。输出完整替换正文，严格遵守世界观、大纲与跨章连续性。'
                : 'Rewrite the complete fiction chapter with strict consistency to world settings, outline, and cross-chapter continuity.')
            : (isZh
                ? '你是中文小说续写助手。严格遵守世界观和大纲，不得破坏既有设定与人物行为逻辑。'
                : 'Continue writing with strict consistency to world settings and plot outline. Do not break established lore.');
        const promptSections = [
            `WriteMode=${writeMode}`,
            `HardContext=\n${JSON.stringify(compactHardContext, null, 2).slice(0, 18000)}`,
            `DynamicContext=\n${JSON.stringify(compactDynamicContext, null, 2).slice(0, 60000)}`,
            `ContinuationContextPolicy=\n${JSON.stringify(context.policy, null, 2)}`,
            ...(batchContext ? [`ChapterBatchContext=\n${JSON.stringify(batchContext, null, 2).slice(0, 42000)}`] : []),
            `WriteParams=\n${JSON.stringify(writeParamsForPrompt, null, 2)}`,
            ...(normalizedUserIntent ? [`UserIntent=${normalizedUserIntent}`] : []),
            ...(normalizedCurrentLocation ? [`CurrentLocation=${normalizedCurrentLocation}`] : []),
            writeMode === 'rewrite_chapter'
                ? (isZh
                    ? 'Constraint=输出目标章节的完整替换正文；保留应保留的事实与功能，但不得在原文后追加续写，不要解释修改过程。'
                    : 'Constraint=Output a complete replacement chapter. Preserve required facts and function; do not append to the original or explain edits.')
                : writeMode === 'new_chapter'
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
            writeMode === 'rewrite_chapter'
                ? (isZh
                    ? 'Constraint=currentChapterBeforeCursor 是待改写原文，只用于保留事实、人物状态和章节功能；输出必须是完整新版本。'
                    : 'Constraint=currentChapterBeforeCursor is the source chapter. Preserve required facts, state, and function while outputting a complete new version.')
                : (isZh
                    ? 'Constraint=你的任务是续写光标后的新内容，不要重复 currentChapterBeforeCursor 里的任何句子。'
                    : 'Constraint=Write only the continuation after cursor; do not repeat any sentence from currentChapterBeforeCursor.'),
        ];
        const defaultUserPrompt = promptSections.join('\n\n');
        const effectiveUserPrompt = payload.overrideUserPrompt?.trim() ? payload.overrideUserPrompt.trim() : defaultUserPrompt;
        const structuredParams = {
            ...context.params,
            contextPolicy: context.policy,
            contextSnapshot: {
                scopeId: context.snapshot.scopeId,
                anchorChapterId: context.snapshot.anchorChapterId,
                chapterSources: context.snapshot.chapterSources.map((source) => ({
                    chapterId: source.chapterId,
                    title: source.title,
                    contentMode: source.contentMode,
                    version: source.version,
                    contentHash: source.contentHash,
                    source: source.source,
                    summaryFresh: source.summaryFresh,
                })),
                narrativeSummaryIds: context.snapshot.narrativeSummaryIds,
                estimatedTokens: context.snapshot.estimatedTokens,
            },
            ...(normalizedUserIntent ? { userIntent: normalizedUserIntent } : {}),
            ...(normalizedCurrentLocation ? { currentLocation: normalizedCurrentLocation } : {}),
            ...(batchContext ? { batchContext } : {}),
        };
        return {
            systemPrompt,
            defaultUserPrompt,
            effectiveUserPrompt,
            structured: {
                goal: writeMode === 'rewrite_chapter'
                    ? (isZh ? '生成目标章节的完整替换正文。' : 'Generate a complete replacement for the target chapter.')
                    : writeMode === 'new_chapter'
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
                    ...(writeMode === 'rewrite_chapter'
                        ? (isZh
                            ? ['输出完整替换正文。', '不得追加在原文之后或解释修改过程。']
                            : ['Output a complete replacement chapter.', 'Do not append to the original or explain edits.'])
                        : (isZh
                            ? ['不得重复已有段落。', '只输出生成的续写正文。']
                            : ['Do not repeat existing paragraphs.', 'Output only generated chapter text.'])),
                ],
            },
            usedContext: context.usedContext,
            warnings: context.warnings,
            contextPolicy: context.policy,
            contextSnapshot: context.snapshot,
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

