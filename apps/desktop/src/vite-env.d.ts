/// <reference types="vite/client" />

interface DBAPI {
    getNovels: () => Promise<Novel[]>
    createNovel: (title: string) => Promise<Novel>
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
        baseUrl: string
        apiKey: string
        model: string
        imageModel: string
        imageSize: string
        imageOutputFormat: 'png' | 'jpeg' | 'webp'
        imageWatermark: boolean
        timeoutMs: number
        maxTokens: number
        temperature: number
    }
    mcpCli: {
        cliPath: string
        argsTemplate: string
        workingDir: string
        envJson: string
        startupTimeoutMs: number
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
        mode?: 'new_chapter' | 'continue_chapter'
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
        targetSections?: Array<'plotLines' | 'plotPoints' | 'characters' | 'items' | 'skills' | 'maps'>;
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
        targetSections?: Array<'plotLines' | 'plotPoints' | 'characters' | 'items' | 'skills' | 'maps'>;
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
    executeAction: (actionId: string, payload?: unknown) => Promise<unknown>
    openClawInvoke: (name: string, args?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>
    openClawMcpInvoke: (name: string, args?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>
    openClawSkillInvoke: (name: string, input?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>
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
}

interface DraftSessionRecord {
    draftSessionId: string
    workspace: 'ai-workbench' | 'chapter-editor'
    type: 'creative-assets' | 'chapter-draft' | 'outline-draft'
    source: 'internal-ai' | 'external-cli'
    origin: 'codex' | 'claude-code' | 'openclaw' | 'desktop-ui' | 'mcp-bridge' | 'unknown'
    novelId: string
    chapterId?: string
    status: 'draft' | 'committed' | 'discarded' | 'failed'
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
}

interface AutomationAPI {
    invoke: (method: string, params?: unknown, origin?: 'desktop-ui' | 'unknown') => Promise<unknown>
    onDataChanged: (callback: (payload: { method: string }) => void) => () => void
}

interface Window {
    ipcRenderer: import('electron').IpcRenderer
    db: DBAPI
    electron: {
        toggleFullScreen: () => Promise<boolean>
        getUserDataPath: () => Promise<string>
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
}
