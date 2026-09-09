export type AiProviderType = 'http' | 'mcp-cli';
export type AiProxyMode = 'system' | 'off' | 'custom';
export type AiHttpApiMode = 'chat-completions' | 'responses';

export interface AiProxySettings {
    mode: AiProxyMode;
    httpProxy?: string;
    httpsProxy?: string;
    allProxy?: string;
    noProxy?: string;
}

export interface AiHttpSettings {
    apiMode: AiHttpApiMode;
    baseUrl: string;
    apiKey: string;
    model: string;
    imageModel: string;
    imageSize: string;
    imageOutputFormat: 'png' | 'jpeg' | 'webp';
    imageWatermark: boolean;
    timeoutMs: number;
    maxTokens: number;
    outputBudgetMode: 'auto' | 'manual';
    contextWindowTokens: number;
    temperature: number;
}

export interface AiMcpCliSettings {
    cliPath: string;
    argsTemplate: string;
    workingDir: string;
    envJson: string;
    startupTimeoutMs: number;
    contextWindowTokens: number;
}

export interface AiSummarySettings {
    summaryMode: 'local' | 'ai';
    summaryTriggerPolicy: 'auto' | 'manual' | 'finalized';
    summaryDebounceMs: number;
    summaryMinIntervalMs: number;
    summaryMinWordDelta: number;
    summaryFinalizeStableMs: number;
    summaryFinalizeMinWords: number;
    recentChapterRawCount: number;
}

export interface AiEmbeddingSettings {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions?: number;
    batchSize: number;
    timeoutMs: number;
    fallbackToHash: boolean;
}

export interface AiSettings {
    providerType: AiProviderType;
    http: AiHttpSettings;
    mcpCli: AiMcpCliSettings;
    proxy: AiProxySettings;
    summary: AiSummarySettings;
    embedding: AiEmbeddingSettings;
}

export interface AiHealthCheckResult {
    ok: boolean;
    detail?: string;
}

export interface AiGenerateRequest {
    prompt: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    /** Hard limit for the complete provider attempt. */
    timeoutMs?: number;
    /** Time allowed before the first response body bytes arrive. */
    firstByteTimeoutMs?: number;
    /** Maximum silence between chunks once a streaming response starts. */
    streamIdleTimeoutMs?: number;
    /** Provider transport activity for durable attempt telemetry. */
    onActivity?: (kind: 'first_byte' | 'chunk') => void;
    signal?: AbortSignal;
}

export interface AiGenerateResponse {
    text: string;
    model?: string;
    responseId?: string;
    usage?: Record<string, unknown>;
    finishReason?: string;
    requestedMaxTokens?: number;
    elapsedMs?: number;
    attemptCount?: number;
}

export interface AiGenerationMetadata {
    lengthValidation?: import('../../shared/writingPolicy').WritingLengthTarget & { actual: number; withinRange: boolean; repairAttempted: boolean };
    taskOutputLimitTokens?: number;
    responseId?: string;
    usage?: Record<string, unknown>;
    finishReason?: string;
    requestedMaxTokens?: number;
    elapsedMs?: number;
    attemptCount: number;
    budget: import('./TaskOutputBudget').TaskOutputBudget;
}

export interface AiImageRequest {
    prompt: string;
    size?: string;
    model?: string;
    outputFormat?: 'png' | 'jpeg' | 'webp';
    watermark?: boolean;
}

export interface AiImageResponse {
    imageUrl?: string;
    imageBase64?: string;
    mimeType?: string;
}

export interface AiProvider {
    readonly name: AiProviderType;
    healthCheck(input?: unknown): Promise<AiHealthCheckResult>;
    generate(req: AiGenerateRequest): Promise<AiGenerateResponse>;
    generateImage?(req: AiImageRequest): Promise<AiImageResponse>;
}

export interface TitleGenerationPayload {
    novelId: string;
    chapterId: string;
    content: string;
    style?: 'stable' | 'literary' | 'viral';
    count?: number;
}

export interface TitleCandidate {
    title: string;
    styleTag: string;
}

export interface ContinueWritingPayload {
    locale?: string;
    mode?: 'new_chapter' | 'continue_chapter' | 'rewrite_chapter';
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
    preparedContext?: import('./context/ContextBuilder').ContinueWritingContext;
    batchContext?: Record<string, unknown>;
    presentation?: 'silent' | 'toast' | 'modal';
}

export interface ChapterBeatGenerationPayload {
    novelId: string;
    chapterId: string;
    goal: string;
    chapterCount: number;
    locale?: string;
    context?: Record<string, unknown>;
    taskMode?: 'sequence_continuation' | 'batch_rewrite';
    targetChapterIds?: string[];
    revisionInstruction?: string;
    previousBeats?: ChapterBeatGenerationResult['beats'];
}

export interface ChapterBeatGenerationResult {
    beats: Array<{
        title: string;
        chapterGoal: string;
        coreConflict: string;
        keyEvents: string[];
        reveals: string[];
        endingHook: string;
        targetWordCount: number;
    }>;
}

export interface NarrativeStateExtractionPayload {
    locale?: string;
    generatedText: string;
    currentBeat?: Record<string, unknown>;
    priorStateLedger?: Record<string, unknown>;
    characters?: Array<{ key: string; name: string }>;
    items?: Array<{ key: string; name: string }>;
}

export interface NarrativeStateExtractionResult {
    delta: import('../../shared/draftBatch').NarrativeStateDelta;
}

export interface ContinueWritingResult {
    text: string;
    usedContext: string[];
    warnings?: string[];
    contextPolicy?: import('../../shared/agentChapterScope').ContinuationContextPolicy;
    contextSnapshot?: import('../../shared/agentChapterScope').ContinuationContextSnapshot;
    consistency: {
        ok: boolean;
        issues: string[];
    };
    generation?: AiGenerationMetadata;
}

export interface CreativeAssetsDraft {
    plotLines?: Array<{
        name: string;
        description?: string;
        color?: string;
        points?: Array<{
            title: string;
            description?: string;
            type?: string;
            status?: string;
        }>;
    }>;
    plotPoints?: Array<{
        title: string;
        description?: string;
        type?: string;
        status?: string;
        plotLineName?: string;
    }>;
    characters?: Array<{
        name: string;
        role?: string;
        description?: string;
        profile?: Record<string, string>;
    }>;
    items?: Array<{
        name: string;
        type?: string;
        description?: string;
        profile?: Record<string, string>;
    }>;
    skills?: Array<{
        name: string;
        description?: string;
        profile?: Record<string, string>;
    }>;
    worldSettings?: Array<{
        name: string;
        type?: 'history' | 'geography' | 'magic_system' | 'faction' | 'technology' | 'other';
        content?: string;
        icon?: string;
    }>;
    maps?: Array<{
        name: string;
        type?: 'world' | 'region' | 'scene';
        description?: string;
        imagePrompt?: string;
        imageUrl?: string;
        imageBase64?: string;
        mimeType?: string;
    }>;
}

export interface CreativeAssetsDraftIssue {
    scope: string;
    name?: string;
    code: 'INVALID_INPUT' | 'CONFLICT' | 'PERSISTENCE_ERROR' | 'UNKNOWN';
    detail: string;
}

export interface CreativeAssetsDraftValidationResult {
    ok: boolean;
    errors: CreativeAssetsDraftIssue[];
    warnings: string[];
    normalizedDraft: CreativeAssetsDraft;
}

export interface ConfirmCreativeAssetsResult {
    success: boolean;
    created: Record<string, number>;
    createdEntities?: import('../../shared/draftWriteback').CreativeAssetWritebackEntitySnapshot[];
    warnings: string[];
    errors?: CreativeAssetsDraftIssue[];
    transactionMode: 'atomic';
}

export interface AiMapImagePayload {
    novelId: string;
    prompt: string;
    mapId?: string;
    mapName?: string;
    mapType?: 'world' | 'region' | 'scene';
    imageSize?: string;
    styleTemplate?: 'realistic' | 'fantasy' | 'ancient' | 'scifi';
    overrideUserPrompt?: string;
}

export interface CreativeAssetsGeneratePayload {
    locale?: string;
    brief: string;
    novelId: string;
    overrideUserPrompt?: string;
    targetSections?: Array<'plotLines' | 'plotPoints' | 'characters' | 'items' | 'skills' | 'worldSettings' | 'maps'>;
    contextChapterCount?: number;
    includeExistingEntities?: boolean;
    filterCompletedPlotLines?: boolean;
}

export interface PromptPreviewStructured {
    goal: string;
    contextRefs: string[];
    params: Record<string, unknown>;
    constraints: string[];
}

export interface PromptPreviewLoreItem {
    id: string;
    title: string;
    excerpt: string;
}

export interface PromptPreviewResult {
    structured: PromptPreviewStructured;
    rawPrompt: string;
    editableUserPrompt: string;
    usedContext?: string[];
    usedWorldLore?: PromptPreviewLoreItem[];
    warnings?: string[];
    outputBudget?: import('./TaskOutputBudget').TaskOutputBudget;
}

export interface AiMapImageResult {
    ok: boolean;
    detail: string;
    code?: string;
    mapId?: string;
    path?: string;
}

export interface AiMapImageStats {
    totalCalls: number;
    successCalls: number;
    failedCalls: number;
    rateLimitFailures: number;
    lastFailureCode?: string;
    lastFailureAt?: string;
    updatedAt: string;
}

export interface AiActionExecutePayload {
    actionId: string;
    payload?: unknown;
}

export interface OpenClawSmokeResult {
    ok: boolean;
    kind: 'mcp';
    detail: string;
    missingActions: string[];
    checks: Array<{
        actionId: string;
        ok: boolean;
        skipped?: boolean;
        detail: string;
    }>;
}

export interface AiCapabilityCoverageItem {
    moduleId: string;
    title: string;
    requiredActions: string[];
    supportedActions: string[];
    missingActions: string[];
    coverage: number;
}

export interface AiCapabilityCoverageResult {
    overallCoverage: number;
    totalRequired: number;
    totalSupported: number;
    modules: AiCapabilityCoverageItem[];
}
