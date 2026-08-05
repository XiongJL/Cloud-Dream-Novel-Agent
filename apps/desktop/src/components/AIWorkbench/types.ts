export type {
    ChapterBeat,
    ChapterBeatInput,
    DraftBatchChildRecord,
    DraftBatchCreateInput,
    DraftBatchRecord,
} from '../../../shared/draftBatch';

export type DraftPlotPoint = {
    title: string;
    description?: string;
    type?: string;
    status?: string;
    plotLineName?: string;
};

export type DraftPlotLine = {
    name: string;
    description?: string;
    color?: string;
    points?: DraftPlotPoint[];
};

export type DraftCharacter = {
    name: string;
    role?: string;
    description?: string;
    profile?: Record<string, string>;
};

export type DraftItem = {
    name: string;
    type?: string;
    description?: string;
    profile?: Record<string, string>;
};

export type DraftSkill = {
    name: string;
    description?: string;
    profile?: Record<string, string>;
};

export type DraftWorldSetting = {
    name: string;
    type?: 'history' | 'geography' | 'magic_system' | 'faction' | 'technology' | 'other';
    content?: string;
    icon?: string;
};

export type DraftMap = {
    name: string;
    type?: 'world' | 'region' | 'scene';
    description?: string;
    imagePrompt?: string;
    imageUrl?: string;
    imageBase64?: string;
    mimeType?: string;
};

export type CreativeAssetsDraft = {
    plotLines?: DraftPlotLine[];
    plotPoints?: DraftPlotPoint[];
    characters?: DraftCharacter[];
    items?: DraftItem[];
    skills?: DraftSkill[];
    worldSettings?: DraftWorldSetting[];
    maps?: DraftMap[];
};

export type CreativeSection = 'plotLines' | 'plotPoints' | 'characters' | 'items' | 'skills' | 'worldSettings' | 'maps';

export type DraftSelection = {
    plotLines: boolean[];
    plotPoints: boolean[];
    characters: boolean[];
    items: boolean[];
    skills: boolean[];
    worldSettings: boolean[];
    maps: boolean[];
};

export type CreativeDraftIssue = {
    scope: string;
    name?: string;
    code: string;
    detail: string;
};

export type ValidationResult = {
    ok: boolean;
    errors: CreativeDraftIssue[];
    warnings: string[];
    normalizedDraft: Record<string, unknown>;
};

export type ConfirmResult = {
    success: boolean;
    created: Record<string, number>;
    warnings: string[];
    errors?: CreativeDraftIssue[];
    transactionMode: 'atomic';
};

export type DraftSessionStatus = 'draft' | 'stale' | 'committed' | 'discarded' | 'failed';

export type DraftSessionRecord = {
    draftSessionId: string;
    workspace: 'ai-workbench' | 'chapter-editor';
    type: 'creative-assets' | 'chapter-draft' | 'outline-draft';
    source: 'internal-ai' | 'external-cli';
    origin: 'codex' | 'claude-code' | 'openclaw' | 'desktop-ui' | 'mcp-bridge' | 'unknown';
    novelId: string;
    chapterId?: string;
    draftBatchId?: string;
    childIndex?: number;
    generationRevision?: number;
    dependsOnDraftSessionId?: string;
    revisionOfDraftSessionId?: string;
    reviewRequestId?: string;
    status: DraftSessionStatus;
    payload: CreativeAssetsDraft | Record<string, unknown>;
    selection?: DraftSelection;
    validation?: ValidationResult | null;
    previewSummary: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    writebacks?: import('../../../shared/draftWriteback').DraftWritebackRecord[];
};
