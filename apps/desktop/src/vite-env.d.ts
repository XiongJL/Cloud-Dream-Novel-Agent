/// <reference types="vite/client" />

interface DBAPI {
    getNovels: () => Promise<Novel[]>
    createNovel: (title: string) => Promise<Novel>
    getAgentConversations: (novelId: string) => Promise<AgentConversationRecord[]>
    upsertAgentConversation: (conversation: AgentConversationRecord) => Promise<{ ok: boolean }>
    updateAgentConversationDraft: (payload: { conversationId: string; composerDraft: string }) => Promise<{ ok: boolean }>
    acknowledgeAgentConversationRun: (payload: { conversationId: string; runId: string | null }) => Promise<{ ok: boolean }>
    deleteAgentConversation: (conversationId: string) => Promise<{ ok: boolean }>
    getVolumes: (novelId: string) => Promise<Volume[]>
    createVolume: (data: { novelId: string; title: string }) => Promise<Volume>
    createChapter: (data: { volumeId: string; title: string; order: number }) => Promise<Chapter>
    deleteChapter: (data: { chapterId: string }) => Promise<{
        mode: 'deleted' | 'reset'
        chapterId: string
        fallbackChapterId: string | null
        chapter?: Chapter | null
    }>
    getChapter: (chapterId: string) => Promise<Chapter | null>
    saveChapter: (data: { chapterId: string; content: string }) => Promise<Chapter>
    renameVolume: (data: { volumeId: string; title: string }) => Promise<Volume>
    renameChapter: (data: { chapterId: string; title: string }) => Promise<Chapter>
    updateNovel: (data: { id: string; data: { title?: string; coverUrl?: string; description?: string; formatting?: string } }) => Promise<Novel>
    deleteNovel: (novelId: string) => Promise<{ ok: boolean }>
    uploadNovelCover: (novelId: string) => Promise<{ path: string } | null>
    importNovelFile: () => Promise<{ novelId: string; title: string; volumeCount: number; chapterCount: number } | null>
    getIdeas: (novelId: string) => Promise<Idea[]>
    createIdea: (data: Idea) => Promise<Idea>
    deleteIdea: (id: string) => Promise<void>
    updateIdea: (id: string, data: Partial<Idea>) => Promise<Idea>
    getAllTags: (novelId?: string) => Promise<string[]>
    // Search
    search: (params: { novelId: string; keyword: string; limit?: number; offset?: number }) => Promise<SearchResult[]>
    rebuildSearchIndex: (novelId: string) => Promise<{ chapters: number; ideas: number }>
    checkIndexStatus: (novelId: string) => Promise<{
        indexedChapters: number
        totalChapters: number
        indexedIdeas: number
        totalIdeas: number
    }>

    // Story Structure
    getPlotLines: (novelId: string) => Promise<PlotLine[]>
    createPlotLine: (data: { novelId: string; name: string; color: string }) => Promise<PlotLine>
    updatePlotLine: (id: string, data: Partial<PlotLine>) => Promise<PlotLine>
    deletePlotLine: (id: string) => Promise<void>

    createPlotPoint: (data: Partial<PlotPoint>) => Promise<PlotPoint>
    updatePlotPoint: (id: string, data: Partial<PlotPoint>) => Promise<PlotPoint>
    deletePlotPoint: (id: string) => Promise<void>

    createPlotPointAnchor: (data: Partial<PlotPointAnchor>) => Promise<PlotPointAnchor>
    deletePlotPointAnchor: (id: string) => Promise<void>

    reorderPlotLines: (novelId: string, lineIds: string[]) => Promise<{ success: boolean }>
    reorderPlotPoints: (plotLineId: string, pointIds: string[]) => Promise<{ success: boolean }>

    // Character & Item
    getCharacters: (novelId: string) => Promise<Character[]>;
    getCharacter: (id: string) => Promise<Character | null>;
    createCharacter: (data: Omit<Character, 'id' | 'createdAt' | 'updatedAt' | 'sortOrder'>) => Promise<Character>;
    updateCharacter: (id: string, data: Partial<Character>) => Promise<Character>
    deleteCharacter: (id: string) => Promise<void>
    uploadCharacterImage: (characterId: string, type: 'avatar' | 'fullBody') => Promise<{ path: string; images?: string[] } | null>
    deleteCharacterImage: (characterId: string, imagePath: string, type: 'avatar' | 'fullBody') => Promise<void>
    getCharacterMapLocations: (characterId: string) => Promise<{ mapId: string; mapName: string; mapType: string }[]>

    getItems: (novelId: string) => Promise<Item[]>;
    getItem: (id: string) => Promise<Item | null>;
    createItem: (data: Omit<Item, 'id' | 'createdAt' | 'updatedAt' | 'sortOrder'>) => Promise<Item>;
    updateItem: (id: string, data: Partial<Item>) => Promise<Item>
    deleteItem: (id: string) => Promise<void>

    getMentionables: (novelId: string) => Promise<MentionableItem[]>

    // World Settings
    getWorldSettings: (novelId: string) => Promise<WorldSetting[]>
    createWorldSetting: (data: { novelId: string; name: string; type?: string }) => Promise<WorldSetting>
    updateWorldSetting: (id: string, data: Partial<WorldSetting>) => Promise<WorldSetting>
    deleteWorldSetting: (id: string) => Promise<void>

    // Relationships
    getRelationships: (characterId: string) => Promise<Relationship[]>
    createRelationship: (data: { sourceId: string; targetId: string; relation: string; description?: string }) => Promise<Relationship>
    deleteRelationship: (id: string) => Promise<void>

    // Item Ownership
    getCharacterItems: (characterId: string) => Promise<ItemOwnership[]>
    addItemToCharacter: (data: { characterId: string; itemId: string; note?: string }) => Promise<ItemOwnership>
    removeItemFromCharacter: (id: string) => Promise<void>
    updateItemOwnership: (id: string, data: { note?: string }) => Promise<ItemOwnership>

    // Data Aggregation
    getCharacterTimeline: (characterId: string) => Promise<CharacterTimelineEntry[]>
    getCharacterChapterAppearances: (characterId: string) => Promise<CharacterTimelineEntry[]>
    getRecentChapters: (characterName: string, novelId: string, limit?: number) => Promise<ChapterMetadata[]>

    // Map System
    getMaps: (novelId: string) => Promise<MapCanvas[]>
    getMap: (id: string) => Promise<MapCanvas | null>
    createMap: (data: { novelId: string; name: string; type?: string }) => Promise<MapCanvas>
    updateMap: (id: string, data: Partial<MapCanvas>) => Promise<MapCanvas>
    deleteMap: (id: string) => Promise<void>
    uploadMapBackground: (mapId: string) => Promise<{ path: string; width: number; height: number } | null>

    getMapMarkers: (mapId: string) => Promise<CharacterMapMarker[]>
    createMapMarker: (data: { characterId: string; mapId: string; x: number; y: number; label?: string }) => Promise<CharacterMapMarker>
    updateMapMarker: (id: string, data: { x?: number; y?: number; label?: string }) => Promise<CharacterMapMarker>
    deleteMapMarker: (id: string) => Promise<void>

    getMapElements: (mapId: string) => Promise<MapElement[]>
    createMapElement: (data: { mapId: string; type: string; x: number; y: number; text?: string; iconKey?: string }) => Promise<MapElement>
    updateMapElement: (id: string, data: Partial<MapElement>) => Promise<MapElement>
    deleteMapElement: (id: string) => Promise<void>
}

interface PlotLine {
    id: string;
    novelId: string;
    name: string;
    description?: string | null;
    color: string;
    sortOrder: number;
    points?: PlotPoint[];
    createdAt: string | Date;
    updatedAt: string | Date;
}

interface PlotPoint {
    id: string;
    novelId: string;
    plotLineId: string;
    title: string;
    description?: string | null;
    type: string;
    status: string;
    order: number;
    anchors?: PlotPointAnchor[];
    createdAt: string | Date;
    updatedAt: string | Date;
}

interface PlotPointAnchor {
    id: string;
    plotPointId: string;
    chapterId: string;
    type: string;
    lexicalKey?: string | null;
    offset?: number | null;
    length?: number | null;
    createdAt: string | Date;
    updatedAt: string | Date;
}

interface SearchResult {
    entityType: 'chapter' | 'idea'
    entityId: string
    chapterId: string
    novelId: string
    title: string
    snippet: string
    preview?: string
    keyword: string
    matchType: 'content' | 'title' | 'volume'
    chapterOrder?: number
    volumeId?: string
    volumeTitle?: string
    volumeOrder?: number
}

interface Idea {
    id: string
    novelId: string
    chapterId?: string
    content: string
    quote?: string
    cursor?: string
    timestamp: number
    isStarred?: boolean
}

interface Novel {
    id: string
    title: string
    description?: string | null
    coverUrl?: string | null
    createdAt: string | Date
    updatedAt: string | Date
    version: number
    deleted: boolean
    wordCount: number
    formatting: string
    volumes?: Volume[]
}

interface ChapterMetadata {
    id: string
    title: string
    order: number
    wordCount: number
    updatedAt: string | Date
}

interface Volume {
    id: string
    title: string
    order: number
    novelId: string
    version: number
    deleted: boolean
    createdAt: string | Date
    updatedAt: string | Date
    chapters: ChapterMetadata[]
}

interface Chapter extends ChapterMetadata {
    content: string
    volumeId: string
    createdAt: string | Date
    version: number
    deleted: boolean
    anchors?: PlotPointAnchor[]
}

interface Character {
    id: string
    novelId: string
    name: string
    role?: string | null
    avatar?: string | null
    description?: string | null
    profile: string
    sortOrder: number
    isStarred?: boolean
    items?: ItemOwnershipWithItem[]
    createdAt: string | Date
    updatedAt: string | Date
}

interface Item {
    id: string
    novelId: string
    name: string
    type: string
    icon?: string | null
    description?: string | null
    profile: string
    sortOrder: number
    createdAt: string | Date
    updatedAt: string | Date
}

interface ItemOwnershipWithItem {
    id: string
    itemId: string
    characterId: string
    note?: string | null
    item: Item
}

interface MentionableItem {
    id: string
    name: string
    type: 'character' | 'item'
    avatar?: string | null
    icon?: string | null
    role?: string | null
    isStarred?: boolean
}

interface WorldSetting {
    id: string
    novelId: string
    name: string
    content: string
    type: string
    sortOrder: number
    createdAt: string | Date
    updatedAt: string | Date
}

interface Relationship {
    id: string
    sourceId: string
    targetId: string
    relation: string
    description?: string | null
    source?: Character
    target?: Character
    createdAt: string | Date
    updatedAt: string | Date
}

interface ItemOwnership {
    id: string
    characterId: string
    itemId: string
    note?: string | null
    character?: Character
    item?: Item
    createdAt: string | Date
}

interface CharacterTimelineEntry {
    chapterId: string
    chapterTitle: string
    volumeTitle: string
    order: number
    volumeOrder: number
    snippet: string
}

interface SyncAPI {
    pull: () => Promise<{ success: boolean; count: number }>
    push: () => Promise<{ success: boolean; count: number }>
}

interface AISettings {
    providerType: 'http' | 'mcp-cli'
    http: {
        apiMode: 'chat-completions' | 'responses'
        baseUrl: string
        apiKey: string
        model: string
        imageModel: string
        imageSize: string
        imageOutputFormat: 'png' | 'jpeg' | 'webp'
        imageWatermark: boolean
        timeoutMs: number
        maxTokens: number
        outputBudgetMode: 'auto' | 'manual'
        contextWindowTokens: number
        temperature: number
    }
    mcpCli: {
        cliPath: string
        argsTemplate: string
        workingDir: string
        envJson: string
        startupTimeoutMs: number
        contextWindowTokens: number
    }
    proxy: {
        mode: 'system' | 'off' | 'custom'
        httpProxy?: string
        httpsProxy?: string
        allProxy?: string
        noProxy?: string
    }
    summary: {
        summaryMode: 'local' | 'ai'
        summaryTriggerPolicy: 'auto' | 'manual' | 'finalized'
        summaryDebounceMs: number
        summaryMinIntervalMs: number
        summaryMinWordDelta: number
        summaryFinalizeStableMs: number
        summaryFinalizeMinWords: number
        recentChapterRawCount: number
    }
    embedding: {
        enabled: boolean
        baseUrl: string
        apiKey: string
        model: string
        dimensions?: number
        batchSize: number
        timeoutMs: number
        fallbackToHash: boolean
    }
}

type RagIntent =
    | 'character_state'
    | 'future_plot_for_entity'
    | 'outline_next'
    | 'unresolved_threads'
    | 'consistency_check'
    | 'general_qa'

type RagEvidenceSourceType =
    | 'character'
    | 'relationship'
    | 'item'
    | 'map'
    | 'plotPoint'
    | 'plotLine'
    | 'worldSetting'
    | 'chapter'
    | 'chapterSummary'
    | 'narrativeSummary'
    | 'searchHit'
    | 'idea'
    | 'currentContext'

interface RagAskPayload {
    novelId: string
    question: string
    chapterId?: string
    currentContent?: string
    selectedText?: string
    currentLocation?: string
    locale?: string
    maxEvidenceItems?: number
    overrideUserPrompt?: string
}

interface RagEvidenceItem {
    id: string
    sourceType: RagEvidenceSourceType
    sourceId: string
    title: string
    excerpt: string
    metadata?: Record<string, unknown>
    score?: number
}

interface RagAskResult {
    ok: boolean
    question: string
    intent: RagIntent
    answer: string
    confidence: 'high' | 'medium' | 'low'
    evidence: RagEvidenceItem[]
    citations: Array<{ evidenceId: string; label: string }>
    warnings: string[]
    usedContext: string[]
    rawPrompt?: string
    editableUserPrompt?: string
    error?: string
}

interface RagRebuildIndexResult {
    chunks: number
    sources: number
    provider: string
    model: string
    dimensions: number
    fallbackUsed: boolean
    fallbackError?: string
}

interface McpCliSetupPayload {
    commandPath: string
    launcherExists: boolean
    command: string
    args: string[]
    codexToml: string
    claudeCommand: string
    jsonConfig: string
}

interface AIAPI {
    previewContinuePrompt: (payload: {
        locale?: string
        mode?: 'new_chapter' | 'continue_chapter' | 'rewrite_chapter'
        novelId: string
        chapterId: string
        currentContent: string
        ideaIds?: string[]
        contextChapterCount?: number
        recentRawChapterCount?: number
        targetLength?: number
        style?: string
        tone?: string
        pace?: string
        temperature?: number
        userIntent?: string
        currentLocation?: string
        overrideUserPrompt?: string
    }) => Promise<{
        structured: {
            goal: string
            contextRefs: string[]
            params: Record<string, unknown>
            constraints: string[]
        }
        rawPrompt: string
        editableUserPrompt: string
        usedContext?: string[]
        warnings?: string[]
    }>
    getSettings: () => Promise<AISettings>
    getMcpCliSetup: () => Promise<McpCliSetupPayload>
    getMapImageStats: () => Promise<{
        totalCalls: number
        successCalls: number
        failedCalls: number
        rateLimitFailures: number
        lastFailureCode?: string
        lastFailureAt?: string
        updatedAt: string
    }>
    updateSettings: (partial: Partial<AISettings>) => Promise<AISettings>
    testConnection: () => Promise<{ ok: boolean; detail?: string }>
    testMcp: () => Promise<{ ok: boolean; detail?: string }>
    testProxy: () => Promise<{ ok: boolean; detail?: string }>
    testGenerate: (prompt?: string) => Promise<{ ok: boolean; text?: string; detail?: string }>
    generateTitle: (payload: {
        novelId: string
        chapterId: string
        content: string
        style?: 'stable' | 'literary' | 'viral'
        count?: number
    }) => Promise<{
        candidates: Array<{ title: string; styleTag: string }>
    }>
    continueWriting: (payload: {
        locale?: string
        novelId: string
        chapterId: string
        currentContent: string
        ideaIds?: string[]
        contextChapterCount?: number
        recentRawChapterCount?: number
        targetLength?: number
        style?: string
        tone?: string
        pace?: string
        temperature?: number
        userIntent?: string
        currentLocation?: string
        overrideUserPrompt?: string
    }) => Promise<{
        text: string
        usedContext: string[]
        warnings?: string[]
        consistency: {
            ok: boolean
            issues: string[]
        }
    }>
    checkConsistency: (payload: { novelId: string; text: string }) => Promise<{ ok: boolean; issues: string[] }>
    askNovel: (payload: RagAskPayload) => Promise<RagAskResult>
    previewNovelAskPrompt: (payload: RagAskPayload) => Promise<RagAskResult>
    previewCreativeAssetsPrompt: (payload: {
        locale?: string;
        brief: string;
        novelId: string;
        overrideUserPrompt?: string;
        targetSections?: Array<'plotLines' | 'plotPoints' | 'characters' | 'items' | 'skills' | 'worldSettings' | 'maps'>;
        contextChapterCount?: number;
        includeExistingEntities?: boolean;
        filterCompletedPlotLines?: boolean;
    }) => Promise<{
        structured: {
            goal: string
            contextRefs: string[]
            params: Record<string, unknown>
            constraints: string[]
        }
        rawPrompt: string
        editableUserPrompt: string
        usedContext?: string[]
    }>
    generateCreativeAssets: (payload: {
        locale?: string;
        brief: string;
        novelId: string;
        overrideUserPrompt?: string;
        targetSections?: Array<'plotLines' | 'plotPoints' | 'characters' | 'items' | 'skills' | 'worldSettings' | 'maps'>;
        contextChapterCount?: number;
        includeExistingEntities?: boolean;
        filterCompletedPlotLines?: boolean;
    }) => Promise<{
        draft: Record<string, unknown>
    }>
    validateCreativeAssetsDraft: (payload: { novelId: string; draft: Record<string, unknown> }) => Promise<{
        ok: boolean
        errors: Array<{ scope: string; name?: string; code: string; detail: string }>
        warnings: string[]
        normalizedDraft: Record<string, unknown>
    }>
    confirmCreativeAssets: (payload: { novelId: string; draft: Record<string, unknown> }) => Promise<{
        success: boolean
        created: Record<string, number>
        warnings: string[]
        errors?: Array<{ scope: string; name?: string; code: string; detail: string }>
        transactionMode: 'atomic'
    }>
    previewMapPrompt: (payload: {
        novelId: string
        prompt: string
        mapId?: string
        mapName?: string
        mapType?: 'world' | 'region' | 'scene'
        imageSize?: string
        styleTemplate?: 'realistic' | 'fantasy' | 'ancient' | 'scifi'
        overrideUserPrompt?: string
    }) => Promise<{
        structured: {
            goal: string
            contextRefs: string[]
            params: Record<string, unknown>
            constraints: string[]
        }
        rawPrompt: string
        editableUserPrompt: string
        usedWorldLore?: Array<{ id: string; title: string; excerpt: string }>
    }>
    generateMapImage: (payload: {
        novelId: string
        prompt: string
        mapId?: string
        mapName?: string
        mapType?: 'world' | 'region' | 'scene'
        imageSize?: string
        styleTemplate?: 'realistic' | 'fantasy' | 'ancient' | 'scifi'
        overrideUserPrompt?: string
    }) => Promise<{
        ok: boolean
        detail: string
        code?: string
        mapId?: string
        path?: string
    }>
    rebuildChapterSummary: (chapterId: string) => Promise<{ ok: boolean; detail?: string }>
    rebuildAgentContextSummary: (storageConversationId: string) => Promise<{
        ok: boolean
        status: 'completed' | 'in_progress' | 'failed'
        revision: number
        generation: number
        diagnostics: AgentContextCompressionCoordinatorDiagnostics
    }>
    executeAction: (actionId: string, payload?: unknown) => Promise<unknown>
    openClawInvoke: (name: string, args?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>
    openClawMcpInvoke: (name: string, args?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>
}

interface CreativeDraftSelection {
    plotLines: boolean[]
    plotPoints: boolean[]
    characters: boolean[]
    items: boolean[]
    skills: boolean[]
    maps: boolean[]
}

interface ChapterDraftPayload {
    chapterId: string
    baseContent: string
    generatedText: string
    content: string
    presentation?: 'silent' | 'toast' | 'modal'
    usedContext: string[]
    consistency: {
        ok: boolean
        issues: string[]
    }
    warnings?: string[]
    narrativeStateDelta?: import('../shared/draftBatch').NarrativeStateDelta
    contextPolicy?: import('../shared/agentChapterScope').ContinuationContextPolicy
    contextSnapshot?: import('../shared/agentChapterScope').ContinuationContextSnapshot
    sourceSnapshot?: import('../shared/draftBatch').DraftBatchSourceSnapshot
}

interface AgentAttachmentsAPI {
    select: (payload: { novelId: string; conversationId: string }) => Promise<import('../shared/agentAttachment').AgentAttachmentRecord | null>
    list: (payload: { novelId: string; conversationId: string }) => Promise<import('../shared/agentAttachment').AgentAttachmentRecord[]>
    get: (payload: { novelId: string; conversationId: string; attachmentId: string }) => Promise<import('../shared/agentAttachment').AgentAttachmentContent>
    bind: (payload: { novelId: string; conversationId: string; messageId: string; attachmentIds: string[] }) => Promise<import('../shared/agentAttachment').AgentAttachmentRecord[]>
    removePending: (payload: { novelId: string; conversationId: string; attachmentId: string }) => Promise<{ ok: true }>
}

interface DraftSessionRecord {
    draftSessionId: string
    workspace: 'ai-workbench' | 'chapter-editor'
    type: 'creative-assets' | 'chapter-draft' | 'outline-draft'
    source: 'internal-ai' | 'external-cli'
    origin: 'codex' | 'claude-code' | 'openclaw' | 'desktop-ui' | 'mcp-bridge' | 'unknown'
    novelId: string
    chapterId?: string
    draftBatchId?: string
    childIndex?: number
    generationRevision?: number
    dependsOnDraftSessionId?: string
    revisionOfDraftSessionId?: string
    reviewRequestId?: string
    status: 'draft' | 'stale' | 'committed' | 'discarded' | 'failed'
    payload: Record<string, unknown> | ChapterDraftPayload
    selection?: CreativeDraftSelection
    validation?: {
        ok: boolean
        errors: Array<{ scope: string; name?: string; code: string; detail: string }>
        warnings: string[]
        normalizedDraft: Record<string, unknown>
    } | null
    previewSummary: string
    version: number
    createdAt: string
    updatedAt: string
    writebacks?: import('../shared/draftWriteback').DraftWritebackRecord[]
}

interface AutomationAPI {
    invoke: (method: string, params?: unknown, origin?: 'desktop-ui' | 'unknown') => Promise<unknown>
    onDataChanged: (callback: (payload: { method: string }) => void) => () => void
}

type DraftBatchRecord = import('../shared/draftBatch').DraftBatchRecord
type DraftBatchCreateInput = import('../shared/draftBatch').DraftBatchCreateInput
type DraftBatchCommitPrefixInput = import('../shared/draftBatch').DraftBatchCommitPrefixInput
type DraftBatchCommittedChapter = import('../shared/draftBatch').DraftBatchCommittedChapter
type DraftBatchPrepareRegenerationInput = import('../shared/draftBatch').DraftBatchPrepareRegenerationInput
type DraftBatchMarkFailedInput = import('../shared/draftBatch').DraftBatchMarkFailedInput
type DraftBatchReconciliationInspection = import('../shared/draftBatch').DraftBatchReconciliationInspection
type DraftBatchReconcileUnknownInput = import('../shared/draftBatch').DraftBatchReconcileUnknownInput

type AgentName = 'supervisor' | 'writer' | 'editor' | 'reader' | 'worldbuilding' | 'research_rag'
type AgentStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
type AgentRunStatus = 'idle' | 'waiting_approval' | 'waiting_user_input' | 'running' | 'completed' | 'failed' | 'cancelled' | 'cancelling'
type AgentRunEventType =
    | 'run_started'
    | 'plan_pending'
    | 'plan_approved'
    | 'plan_rejected'
    | 'message'
    | 'step_started'
    | 'step_completed'
    | 'step_failed'
    | 'tool_call'
    | 'tool_result'
    | 'toolchain_started'
    | 'toolchain_node_started'
    | 'toolchain_node_completed'
    | 'toolchain_completed'
    | 'toolchain_failed'
    | 'draft_created'
    | 'draft_operation_started'
    | 'draft_operation_progress'
    | 'artifact_created'
    | 'approval_required'
    | 'user_input_required'
    | 'user_input_resolved'
    | 'error'
    | 'run_completed'
    | 'run_failed'
    | 'run_cancelled'
    | 'request_retry_scheduled'
    | 'request_retry_started'
    | 'request_retry_succeeded'
    | 'request_retry_exhausted'
    | 'run_retry_started'

type AgentRoleMode = 'team' | 'writer' | 'editor' | 'reader' | 'worldbuilding' | 'research_rag'
type AgentConversationMessageKind = 'chat' | 'role_status' | 'workflow_notice' | 'context_compression'

interface AgentConversationMessageRecord {
    id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    createdAt: string
    kind?: AgentConversationMessageKind
    contextReads?: Array<{ toolName: string; status: 'completed' | 'failed'; message?: string }>
    contextDiagnostics?: AgentContextDiagnostics
    attachmentIds?: string[]
    chapterScopeSnapshot?: import('../shared/agentChapterScopeSelection').AgentChapterScopeSelection
    activities?: AgentChatActivityEvent[]
    failure?: AgentChatFailure
    evidenceSnapshotId?: string
}

interface AgentChatActivityEvent {
    eventId: string
    sequence: number
    requestId: string
    callId?: string
    type: 'request_started' | 'model_started' | 'model_completed' | 'tool_started' | 'tool_completed' | 'tool_failed' | 'finalization_started' | 'request_completed' | 'request_failed' | 'request_cancelled'
    stage: 'scope_validation' | 'context_read' | 'analysis' | 'finalization'
    toolName?: string
    displayName: string
    status: 'running' | 'completed' | 'failed' | 'cancelled'
    elapsedMs?: number
    details?: Record<string, unknown>
    createdAt: string
}

interface AgentChatFailure {
    code: 'SCOPE_CONFLICT' | 'CONTEXT_READ_TIMEOUT' | 'CONTEXT_READ_FAILED' | 'MODEL_SUMMARY_TIMEOUT' | 'REQUEST_DEADLINE_EXCEEDED' | 'CANCELLED' | 'EVIDENCE_SNAPSHOT_MISSING' | string
    message: string
    retryable?: boolean
    coverage?: { completed: number; total: number }
    recovery?: AgentChatRecoveryDescriptor
}

interface AgentChatRecoveryDescriptor {
    recoveryRef: string
    recoveryAction: 'repair_model_output'
}

interface AgentConversationSummaryEntry {
    id: string
    text: string
    sourceMessageIds: string[]
    sourceRole: 'user' | 'assistant'
    createdAt?: string
}

interface AgentConversationArtifactRef {
    artifactId: string
    runId?: string
    type?: string
    title: string
    status?: string
    summary?: string
    createdAt?: string
}

interface AgentConversationSummary {
    version: 'agent-conversation-summary-v1'
    revision: number
    coveredMessageIds: string[]
    coverage: {
        startMessageId?: string
        endMessageId?: string
        messageCount: number
    }
    facts: AgentConversationSummaryEntry[]
    userDecisions: AgentConversationSummaryEntry[]
    unresolvedQuestions: AgentConversationSummaryEntry[]
    outcomes: AgentConversationSummaryEntry[]
    artifactRefs: AgentConversationArtifactRef[]
    updatedAt: string
}

interface AgentConversationSummaryEntryV2 {
    id: string
    text: string
    sourceMessageIds?: string[]
    sourceArtifactIds?: string[]
    authority: 'user' | 'project' | 'assistant'
    status: 'active' | 'resolved' | 'superseded'
    supersededBy?: string
}

interface AgentConversationSummaryV2 {
    version: 'agent-conversation-summary-v2'
    revision: number
    previousRevision: number
    generation: number
    rebuild?: {
        previousGeneration: number
        reason: 'source_changed' | 'manual_quality_rebuild'
    }
    coverage: {
        startMessageId: string
        endMessageId: string
        messageCount: number
        sourceHash: string
    }
    semanticProjection: {
        activeIntent: AgentConversationSummaryEntryV2[]
        hardConstraints: AgentConversationSummaryEntryV2[]
        confirmedDecisions: AgentConversationSummaryEntryV2[]
        canonFacts: AgentConversationSummaryEntryV2[]
        creativeContinuity: AgentConversationSummaryEntryV2[]
        unresolvedQuestions: AgentConversationSummaryEntryV2[]
        completedOutcomes: AgentConversationSummaryEntryV2[]
        pendingWork: AgentConversationSummaryEntryV2[]
        artifactRefs: AgentConversationArtifactRef[]
    }
    sourceIndex: {
        userMessageLedger: Array<{
            messageId: string
            gist: string
            classification: 'semantic' | 'transient'
            supersedesMessageIds?: string[]
        }>
        sourceFingerprints: Array<Record<string, unknown>>
        dependencyHash: string
    }
    updatedAt: string
}

interface AgentConversationRecord {
    id: string
    novelId: string
    title: string
    description: string
    role: AgentRoleMode
    runtimeConversationId: string | null
    updatedAt: string
    chapterScope?: import('../shared/agentChapterScopeSelection').AgentChapterScopeSelection | null
    messages: AgentConversationMessageRecord[]
    suggestedGoal: string | null
    plan: AgentPlan | null
    run: AgentRun | null
    runs?: AgentRun[]
    contextSummary?: AgentConversationSummary | AgentConversationSummaryV2 | null
    pendingUserInput?: AgentUserInputRequest | null
    userInputResolutions?: AgentUserInputResolution[]
    composerDraft?: string
    attentionAcknowledgedRunId?: string | null
    error: string
}

interface AgentPlanStep {
    stepId: string
    agent: AgentName
    title: string
    tools: string[]
    toolchain?: {
        id: string
        version: string
        input: Record<string, unknown>
    } | null
    skills?: AgentSkillRef[]
    status: AgentStepStatus
}

interface AgentPresetTask {
    id: string
    label: string
    description: string
    goal: string
    deliverable: 'report' | 'chapter_draft' | 'chapter_draft_batch' | 'creative_assets_draft'
}

interface AgentRoleDefinition {
    id: 'team' | AgentName
    agent: AgentName
    label: string
    description: string
    tools: string[]
    skills: string[]
    defaultSkillIds: string[]
    presets: AgentPresetTask[]
}

interface AgentSkillIndexEntry {
    id: string
    stableId: string
    title: string
    description: string
    scope: 'builtin' | 'user' | 'novel'
    ownerNovelId?: string | null
    category: 'style' | 'narrative_method' | 'generation' | 'review' | 'character_voice' | 'novel_rules' | 'other'
    guidanceMode: 'adaptive' | 'guided' | 'strict'
    semanticSelection: 'off' | 'suggest' | 'auto'
    triggerHints: string[]
    antiTriggerHints: string[]
    allowedRoles: string[]
    supportedOperations: string[]
    version: string
    revisionId: string
    enabled: boolean
}

interface AgentSkillRef {
    skillId: string
    stableId: string
    revisionId: string
    version: string
    contentHash: string
    scope: 'builtin' | 'user' | 'novel'
    selectionSource: 'explicit' | 'shortcut' | 'role' | 'preset' | 'semantic' | 'user' | 'novel' | 'builtin'
    position: 'primary' | 'auxiliary'
}

interface AgentSkillResolveResult {
    primary?: AgentSkillRef | null
    auxiliary?: AgentSkillResolveResult['primary']
    reasonCodes: string[]
    warnings: string[]
}

interface AgentSkillPreviewResult {
    resolved: AgentSkillResolveResult
    compiled: {
        sections: Array<{ skill: NonNullable<AgentSkillResolveResult['primary']>; prompt: string; estimatedTokens: number }>
        prompt: string
        estimatedTokens: number
        warnings: string[]
    }
}

interface AgentPlan {
    planId: string
    threadId: string
    title: string
    goal: string
    requiresApproval: boolean
    steps: AgentPlanStep[]
    preferredRole?: 'team' | AgentName
    deliverable?: 'report' | 'expert_report' | 'chapter_draft' | 'chapter_draft_batch' | 'creative_assets_draft'
    requestedEffect?: 'unknown' | 'none' | 'read_only' | 'draft_write' | 'data_write' | 'external'
    userDecisions?: Record<string, unknown> | null
}

interface AgentRunEvent {
    eventId: string
    sequence: number
    runId: string
    planId?: string
    threadId?: string
    stepId?: string
    type: AgentRunEventType
    agent?: AgentName
    toolName?: string
    status?: string
    payload: Record<string, unknown>
    createdAt: string
}

interface AgentArtifact {
    artifactId: string
    runId: string
    planId: string
    type: 'report' | 'context_bundle' | 'chapter_scope_context' | 'consistency_review' | 'plotline_analysis' | 'chapter_draft' | 'chapter_draft_batch' | 'creative_assets_draft' | 'writer_revision_plan' | 'chapter_range_review' | 'reader_journey' | 'worldbuilding_consistency' | 'research_fact_check' | 'scope_audit' | 'novel_bootstrap_draft' | 'agent_skill_pack_draft'
    title: string
    status: 'ready' | 'committed' | 'discarded' | 'failed'
    summary?: string | null
    content?: string | null
    reference: Record<string, unknown>
    metadata: Record<string, unknown>
    reviewStatus?: 'unreviewed' | 'in_review' | 'reviewed' | 'stale'
    reviewRevision?: number
    reviewDecisions?: Array<{ findingId: string; status: 'accepted' | 'rejected' | 'deferred'; note?: string }>
    reviewStaleChapterIds?: string[]
    reviewedAt?: string | null
    createdAt: string
}

interface AgentApprovalOption {
    id: string
    label: string
    description?: string
}

interface AgentApprovalRequest {
    checkpointId: string
    checkpointType?: string
    title: string
    question: string
    reason?: string
    options: AgentApprovalOption[]
    allowFreeText: boolean
    freeTextPlaceholder?: string
    stepId?: string
    draftBatchId?: string
    outlineRevision?: number
    revisionCount?: number
    maxRevisionCount?: number
    revisionError?: string
    beats?: DraftBatchRecord['outline']['beats']
}

interface AgentApprovalResponse {
    checkpointId: string
    checkpointType?: string
    selectedOptionIds: string[]
    freeText?: string
    draftBatchId?: string
    outlineRevision?: number
}

type AgentUserInputPhase = 'pre_plan' | 'execution'

interface AgentUserInputEvidence {
    evidenceId: string
    sourceKind: 'editor_snapshot' | 'chapter' | 'attachment' | 'rag' | 'search' | 'creative_setting'
    sourceId: string
    title: string
    version?: string
    contentHash?: string
    coverage?: string
}

interface AgentUserInputOption {
    optionId: string
    label: string
    description: string
    evidenceIds?: string[]
}

interface AgentUserInputQuestion {
    questionId: string
    header: string
    prompt: string
    options: AgentUserInputOption[]
    recommendedOptionId: string
    recommendationReason: string
    evidenceIds?: string[]
    allowCustom: true
}

interface AgentUserInputRequest {
    schemaVersion: 'agent-user-input-v1'
    requestId: string
    inputSessionId: string
    conversationId: string
    sourceMessageId?: string
    phase: AgentUserInputPhase
    round: 1 | 2 | 3
    maxRounds: 1 | 2 | 3
    previousRequestId?: string
    title: string
    reason: string
    questions: AgentUserInputQuestion[]
    evidence: AgentUserInputEvidence[]
    runId?: string
    stepId?: string
    createdAt: string
}

type AgentUserInputAnswer =
    | { questionId: string; answerKind: 'option'; selectedOptionId: string }
    | { questionId: string; answerKind: 'custom'; customText: string }
    | { questionId: string; answerKind: 'skipped' }

interface AgentUserInputEffectiveAnswer {
    questionId: string
    answerKind: 'option' | 'custom'
    selectedOptionId?: string
    customText?: string
    source: 'user' | 'recommended_fallback'
}

interface AgentUserInputResolution {
    requestId: string
    inputSessionId?: string
    round: 1 | 2 | 3
    phase: AgentUserInputPhase
    status: 'resolved' | 'dismissed'
    answers: AgentUserInputAnswer[]
    effectiveAnswers: AgentUserInputEffectiveAnswer[]
    understandingSummary: string
    resolvedAt: string
    nextAction: 'follow_up_required' | 'plan_created' | 'run_resumed' | 'returned_to_chat' | 'run_cancelled'
    request?: AgentUserInputRequest
    pendingUserInput?: AgentUserInputRequest
    plan?: AgentPlan
    run?: AgentRun
}

interface AgentRecoveryDescriptor {
    failureKind: 'transport' | 'model_output_truncated' | 'model_output_invalid' | 'local_transform_failed' | 'artifact_publish_failed' | 'persistence_failed' | 'side_effect_unknown'
    failedAtPhase: 'model_pending' | 'model_received' | 'normalizing' | 'publishing'
    retryStrategy: 'retry_request' | 'repair_model_output' | 'reprocess_saved_result' | 'resume_publish' | 'reconcile_side_effect' | 'none'
    canRecover: boolean
    recoveryRevision: number
    actionLabel?: string
    blockedReason?: 'processor_update_required' | 'stale_dependency' | 'unsafe_side_effect' | 'repair_exhausted'
    completedArtifactIds: string[]
    affectedArtifactIds: string[]
    diagnosticRef: string
}

interface AgentRun {
    runId: string
    threadId: string
    planId: string
    status: AgentRunStatus
    deadlineAt?: string
    currentStepId?: string
    progress: number
    events: AgentRunEvent[]
    artifacts?: AgentArtifact[]
    skillSnapshot?: AgentSkillRef[]
    draftSessionId?: string
    draftBatchId?: string
    draftOperationId?: string
    draftOperationKey?: string
    draftOperationStatus?: string
    draftOperationVersion?: number
    cancelRequested?: boolean
    pendingApproval?: AgentApprovalRequest | null
    approvalResponses?: AgentApprovalResponse[]
    pendingUserInput?: AgentUserInputRequest | null
    userInputResponses?: Array<{
        requestId: string
        checkpointType?: string
        answers: AgentUserInputAnswer[]
        understandingSummary: string
    }>
    planSnapshot?: AgentPlan
    retryOfRunId?: string
    retryRootRunId?: string
    retryAttempt?: number
    failureRevision?: number
    resumedFrom?: Record<string, unknown>
    completionKind?: 'complete' | 'partial'
    recovery?: AgentRecoveryDescriptor | null
}

interface AgentRunStatusResult {
    runId: string
    planId: string
    threadId: string
    status: AgentRunStatus
    deadlineAt?: string
    currentStepId?: string
    currentStepTitle?: string
    totalSteps: number
    completedSteps: number
    lastSequence: number
    lastEventAt?: string
    draftSessionId?: string
    draftBatchId?: string
    draftOperationId?: string
    draftOperationKey?: string
    draftOperationStatus?: string
    draftOperationVersion?: number
    artifacts: AgentArtifact[]
    pendingApproval?: AgentApprovalRequest | null
    pendingUserInput?: AgentUserInputRequest | null
    retryOfRunId?: string
    retryRootRunId?: string
    retryAttempt: number
    failureRevision: number
    completionKind: 'complete' | 'partial'
    recovery?: AgentRecoveryDescriptor | null
}

interface AgentChatResponse {
    conversationId: string
    assistantMessage: {
        messageId: string
        role: 'assistant'
        content: string
        createdAt: string
    }
    suggestedActions: Array<{ label: string; method: string }>
    awaitingUserInput: boolean
    contextReads: Array<{ toolName: string; status: 'completed' | 'failed'; message?: string }>
    contextDiagnostics?: AgentContextDiagnostics
    contextCompression?: AgentContextCompression
    intentDecision?: AgentIntentDecision
    pendingUserInput?: AgentUserInputRequest | null
    status: 'completed' | 'failed' | 'cancelled'
    activities: AgentChatActivityEvent[]
    failure?: AgentChatFailure
    evidenceSnapshotId?: string
}

interface AgentIntentTargetRef {
    kind: 'novel' | 'volume' | 'chapter' | 'chapter_scope' | 'selection' | 'conversation'
    source: 'explicit_id' | 'current_selection' | 'conversation_reference'
    id?: string
    ids?: string[]
    selector?: string
    volumeId?: string
    title?: string
    label?: string
}

interface AgentIntentOperation {
    type: string
    target: AgentIntentTargetRef
    suggestedToolchainId?: string
    suggestedToolchainVersion?: string
    requestedEffect: 'unknown' | 'none' | 'read_only' | 'draft_write' | 'data_write' | 'external'
    confidence: number
}

interface AgentIntentDecision {
    interaction: 'conversation' | 'task' | 'clarification_response'
    route: 'respond' | 'clarify' | 'plan' | 'retry_failed_run'
    operations: AgentIntentOperation[]
    deliverable: 'none' | 'report' | 'chapter_draft' | 'chapter_draft_batch' | 'creative_assets_draft'
    contextNeeds: string[]
    missingUserDecisions: string[]
    suggestedRole?: string
    requestedEffect: 'unknown' | 'none' | 'read_only' | 'draft_write' | 'data_write' | 'external'
    needsClarification: boolean
    confidence: number
    reasonCodes: string[]
    responseContent: string
    explorationPerformed: boolean
    requestedSkills: Array<{
        skillId: string
        requestedRevisionId?: string | null
        selectionSource: 'explicit' | 'shortcut' | 'preset' | 'semantic'
    }>
    disabledSkillsForTurn: boolean
    recovery?: {
        failedRunId: string
        expectedFailureRevision: number
        mode: 'failed_node'
    }
}

interface AgentContextHistorySource {
    mode: 'raw' | 'compressed' | 'summary' | 'omitted'
    startMessageIndex: number
    endMessageIndex: number
    startMessageId?: string
    endMessageId?: string
}

interface AgentContextSectionSource {
    id: string
    kind: 'decision' | 'plan' | 'artifact' | 'retrieval' | 'tool' | 'metadata'
    priority: 'required' | 'high' | 'normal' | 'low'
    mode: 'raw' | 'compressed' | 'omitted'
    sourceRef?: string
    estimatedTokens: number
}

interface AgentContextDiagnostics {
    contextVersion: 'agent-context-v1' | 'agent-context-v2'
    providerType: 'http' | 'mcp-cli'
    model: string
    contextWindowTokens: number
    contextWindowSource: 'configured' | 'model-profile' | 'compatibility-fallback'
    outputTokens: number
    safetyTokens: number
    systemTokens: number
    inputBudgetTokens: number
    estimatedInputTokens: number
    compressionApplied: boolean
    currentRequestCompressed: boolean
    historyMessagesTotal: number
    historyMessagesKept: number
    historyMessagesSummarized: number
    historyMessagesOmitted: number
    historyMessagesCompacted: number
    persistentConstraintsCount: number
    persistentSummaryRevision: number
    persistentSummaryMessageCount: number
    recalledMessageIds: string[]
    recalledArtifactIds: string[]
    currentRequestMode: 'raw' | 'compressed'
    historySources: AgentContextHistorySource[]
    sectionSources: AgentContextSectionSource[]
    compressedSectionIds: string[]
    omittedSectionIds: string[]
    warnings: string[]
    compressionMode?: 'none' | 'projection' | 'micro' | 'semantic' | 'degraded'
    hardTokenCountMethod?: 'provider_exact' | 'tokenizer_exact' | 'conservative_upper_bound' | 'estimated'
    tokenCounterProfileId?: string
    contextTokens?: number
    providerInputTokens?: number
    hardContextBudget?: number
    hardProviderInputLimit?: number
    providerReserveTokens?: number
    fixedProviderInputTokens?: number
    triggerContextBudget?: number
    targetContextBudget?: number
    nextTurnReserveTokens?: number
    projectedNextTurnContextTokens?: number
    wouldRetriggerNextTurn?: boolean
    semanticSummaryVersion?: 2
    semanticSummaryDependencyStatus?: 'none' | 'valid' | 'stale'
    sourceIndexLedgerEntries?: number
    sourceIndexBytes?: number
    coordinator?: AgentContextCompressionCoordinatorDiagnostics
}

interface AgentContextCompressionCoordinatorDiagnostics {
    mode: 'none' | 'projection' | 'semantic' | 'degraded'
    operationKind: 'none' | 'coverage_increment' | 'dependency_refresh' | 'generation_rebuild' | 'background_precompression'
    triggered: boolean
    triggerReason: 'none' | 'high_water' | 'forced' | 'source_changed' | 'dependency_changed' | 'manual_rebuild'
    currentRequestIdentityStatus: 'not_applicable' | 'valid' | 'mismatch'
    currentRequestPayloadOccurrences: number
    preCompressionContextTokens: number
    postCompressionContextTokens: number
    preCompressionProviderInputTokens: number
    postCompressionProviderInputTokens: number
    hardTokenCountMethod: 'provider_exact' | 'tokenizer_exact' | 'conservative_upper_bound'
    hardTokenCountProfileId: string
    targetContextBudget: number
    summaryRevision: number
    summaryGeneration: number
    rebuildReason?: 'source_changed' | 'manual_quality_rebuild'
    rebuildTaskId: string | null
    rebuildStatus: 'idle' | 'running' | 'completed' | 'discarded' | 'limit_exceeded'
    rebuildCompletedChunks: number
    rebuildMaxChunks: number
    rebuildElapsedMs: number
    rebuildMaxDurationMs: number
    /** @deprecated Legacy aliases retained for persisted diagnostics. */
    rebuildChunksCompleted?: number
    rebuildChunkCount?: number
    coverageMessageCount: number
    coverageStartMessageId?: string
    coverageEndMessageId?: string
    sourceHashStatus: 'none' | 'valid' | 'stale'
    dependencyHashStatus: 'none' | 'valid' | 'stale'
    boundaryUnitId?: string
    atomicUnitCount: number
    blockingUnitId?: string
    blockingSequenceStart?: number
    blockingSequenceEnd?: number
    newlyCoveredMessageCount: number
    recentTailMessageCount: number
    recentTailContextTokens: number
    recentTailUnitCount: number
    sourceIndexLedgerEntries: number
    sourceIndexBytes: number
    semanticLedgerEntries: number
    transientLedgerEntries: number
    unprojectedSemanticMessageCount: number
    invalidatedSourceCount: number
    qualitySample?: {
        reason: 'initial' | 'periodic' | 'rebuild'
        revision: number
        generation: number
        projectionEntryCount: number
        semanticLedgerEntries: number
        directlyProjectedSemanticEntries: number
        validationPassed: true
    }
    compactor?: {
        providerType: 'http' | 'mcp-cli'
        model: string
        promptVersion: string
        elapsedMs: number
        inputTokens: number
        outputTokens: number
        tokenCountMethod: 'provider_exact' | 'tokenizer_exact' | 'conservative_upper_bound'
        inputBytes: number
        outputBytes: number
        retries: number
    }
    statusCodes: Array<'CONTEXT_REBUILD_IN_PROGRESS' | 'CONTEXT_PRECOMPRESSION_IN_PROGRESS'>
    errorCode?: string
    /** @deprecated Use statusCodes/errorCode. */
    failureCode?: string
    consecutiveFailures: number
    circuitOpen: boolean
    casConflict: boolean
    warnings: string[]
}

interface AgentContextCompression {
    applied: true
    mode: 'none' | 'projection' | 'micro' | 'semantic' | 'degraded'
    model: string
    contextWindowTokens: number
    inputBudgetTokens: number
    estimatedInputTokens: number
    historyMessagesTotal: number
    historyMessagesKept: number
    historyMessagesSummarized: number
    historyMessagesOmitted: number
    historyMessagesCompacted: number
    persistentSummaryRevision: number
    persistentSummaryMessageCount: number
    recalledMessageCount: number
    recalledArtifactCount: number
    compressedSectionIds: string[]
    omittedSectionIds: string[]
    operationKind?: 'none' | 'coverage_increment' | 'dependency_refresh' | 'generation_rebuild' | 'background_precompression'
    triggerReason?: 'none' | 'high_water' | 'forced' | 'source_changed' | 'dependency_changed' | 'manual_rebuild'
    currentRequestIdentityStatus?: 'not_applicable' | 'valid' | 'mismatch'
    currentRequestPayloadOccurrences?: number
    summaryGeneration?: number
    rebuildReason?: 'source_changed' | 'manual_quality_rebuild'
    rebuildTaskId?: string | null
    rebuildStatus?: 'idle' | 'running' | 'completed' | 'discarded' | 'limit_exceeded'
    rebuildCompletedChunks?: number
    rebuildMaxChunks?: number
    rebuildElapsedMs?: number
    rebuildMaxDurationMs?: number
    preCompressionContextTokens?: number
    postCompressionContextTokens?: number
    preCompressionProviderInputTokens?: number
    postCompressionProviderInputTokens?: number
    hardTokenCountMethod?: 'provider_exact' | 'tokenizer_exact' | 'conservative_upper_bound'
    hardTokenCountProfileId?: string
    statusCodes?: Array<'CONTEXT_REBUILD_IN_PROGRESS' | 'CONTEXT_PRECOMPRESSION_IN_PROGRESS'>
    errorCode?: string
    /** @deprecated Legacy aliases retained for persisted diagnostics. */
    rebuildChunksCompleted?: number
    rebuildChunkCount?: number
    sourceHashStatus?: 'none' | 'valid' | 'stale'
    dependencyHashStatus?: 'none' | 'valid' | 'stale'
    failureCode?: string
    consecutiveFailures?: number
    circuitOpen?: boolean
    casConflict?: boolean
}

interface AgentHealthResult {
    ok: boolean
    code?: string
    message?: string
    data?: {
        phase?: 'idle' | 'starting_python' | 'loading_modules' | 'loading_web_server' | 'loading_graph_engine' | 'loading_tool_protocol' | 'loading_runtime' | 'initializing_state' | 'loading_tools' | 'restoring_state' | 'starting_server' | 'ready' | 'failed'
        elapsedMs?: number
        phaseElapsedMs?: number
        port?: number
        capabilities?: string[]
        toolTransport?: string
        availability?: 'starting' | 'ready' | 'slow' | 'recovering' | 'failed'
        consecutiveHealthFailures?: number
        activeInvocations?: number
        autoRestartAttempted?: boolean
        recovering?: boolean
        canManualRetry?: boolean
    }
}

interface AgentAPI {
    health: () => Promise<AgentHealthResult>
    ensureReady: () => Promise<AgentHealthResult>
    restart: () => Promise<AgentHealthResult>
    roles: (payload?: Record<string, unknown>) => Promise<AgentRoleDefinition[]>
    skills: (payload?: Record<string, unknown>) => Promise<AgentSkillIndexEntry[]>
    resolveSkill: (payload: Record<string, unknown>) => Promise<AgentSkillResolveResult>
    previewSkill: (payload: Record<string, unknown>) => Promise<AgentSkillPreviewResult>
    authorSkill: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
    skillDrafts: (payload?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
    skillDraft: (payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>
    commitSkillDraft: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
    discardSkillDraft: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
    chat: (payload: Record<string, unknown>, options?: { requestId?: string }) => Promise<AgentChatResponse>
    recoverChat: (payload: Record<string, unknown>, options?: { requestId?: string }) => Promise<AgentChatResponse>
    retryChatSummary: (payload: Record<string, unknown>, options?: { requestId?: string }) => Promise<AgentChatResponse>
    deleteChatContext: (payload: { conversationId: string; storageConversationId?: string }) => Promise<{ ok: boolean; removedEvidenceSnapshots: number }>
    cancelChat: (payload: { requestId: string }) => Promise<{ ok: boolean; cancelled: boolean }>
    onChatProgress: (callback: (payload: {
        requestId: string
        sequence: number
        phase: 'thinking' | 'reading' | 'extending' | 'finalizing' | 'cancelled'
        toolName?: string
        attachmentId?: string
        selector?: unknown
        eventId?: string
        callId?: string
        type?: AgentChatActivityEvent['type']
        stage?: AgentChatActivityEvent['stage']
        displayName?: string
        status?: AgentChatActivityEvent['status']
        elapsedMs?: number
        details?: Record<string, unknown>
        createdAt?: string
    }) => void) => () => void
    plan: (payload: Record<string, unknown>) => Promise<AgentPlan>
    registerPlan: (payload: Record<string, unknown>) => Promise<AgentPlan>
    revisePlan: (payload: Record<string, unknown>) => Promise<AgentPlan>
    executePlan: (payload: Record<string, unknown>) => Promise<AgentRun>
    retryRun: (payload: Record<string, unknown>) => Promise<AgentRun>
    reviseDraft: (payload: Record<string, unknown>) => Promise<AgentRun>
    regenerateBatch: (payload: Record<string, unknown>) => Promise<AgentRun>
    inspectSideEffect: (payload: Record<string, unknown>) => Promise<AgentSideEffectInspection>
    reconcileSideEffect: (payload: Record<string, unknown>) => Promise<AgentSideEffectReconciliationResult>
    runStatus: (payload: Record<string, unknown>) => Promise<AgentRunStatusResult>
    cancel: (payload: Record<string, unknown>) => Promise<AgentRun>
    submitApproval: (payload: Record<string, unknown>) => Promise<AgentRun>
    submitUserInput: (payload: Record<string, unknown>) => Promise<AgentUserInputResolution>
    dismissUserInput: (payload: Record<string, unknown>) => Promise<AgentUserInputResolution>
    subscribeRun: (runId: string, options?: { afterSequence?: number }) => Promise<{ ok: boolean }>
    unsubscribeRun: (runId: string) => Promise<{ ok: boolean }>
    onRunEvent: (callback: (event: AgentRunEvent) => void) => () => void
    onRunDisconnected: (callback: (payload: { runId: string; message: string }) => void) => () => void
}

interface AgentSideEffectInspection {
    batch: DraftBatchRecord
    child: DraftBatchRecord['children'][number]
    candidates: import('../shared/draftBatch').DraftBatchReconciliationCandidate[]
    invocation: {
        invocationKey: string
        requestId: string
        runId: string
        stepId?: string
        method: string
        status: string
        createdAt: string
        updatedAt: string
        errorCode?: string
    }
    canAcceptExisting: boolean
    canConfirmAbsent: boolean
}

interface AgentSideEffectReconciliationResult {
    batch: DraftBatchRecord
    resolution: import('../shared/draftBatch').DraftBatchReconciliationResolution
    invocation: {
        invocationKey: string
        requestId: string
        method: string
        status: string
        updatedAt: string
    }
}

interface Window {
    ipcRenderer: import('electron').IpcRenderer
    db: DBAPI
    electron: {
        toggleFullScreen: () => Promise<boolean>
        getUserDataPath: () => Promise<string>
        getUpdateInfo: () => Promise<{
            currentVersion: string
            latestVersion: string | null
            releaseUrl: string
            updateAvailable: boolean
            status: 'available' | 'up-to-date' | 'unavailable'
        }>
        openExternal: (url: string) => Promise<boolean>
        onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void
    }
    sync: SyncAPI
    backup: {
        export: (password?: string) => Promise<string>;
        import: (filePath?: string, password?: string) => Promise<{ success: boolean; code?: string; message?: string; filePath?: string }>;
        getAutoBackups: () => Promise<Array<{ filename: string; createdAt: number; size: number }>>;
        restoreAutoBackup: (filename: string) => Promise<void>;
    }
    ai: AIAPI
    automation: AutomationAPI
    agent: AgentAPI
    agentAttachments: AgentAttachmentsAPI
}
