import type { PrismaClientType } from '@novel-editor/core';
import type { AgentConversationMessageKind } from '../../shared/agentConversationContext';
import type { AgentChapterScopeSelection } from '../../shared/agentChapterScopeSelection';
import {
    normalizeAgentConversationSummaryV2,
    validateAgentConversationSummaryCoverageV2,
} from '../ai/context/AgentConversationSummaryV2';

export type AgentRunEventRecord = {
    eventId: string;
    sequence: number;
    runId: string;
    planId?: string | null;
    threadId?: string | null;
    stepId?: string | null;
    type: string;
    agent?: string | null;
    toolName?: string | null;
    status?: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
};

export type AgentArtifactRecord = {
    artifactId: string;
    runId: string;
    planId: string;
    type:
        | 'report'
        | 'context_bundle'
        | 'chapter_scope_context'
        | 'consistency_review'
        | 'plotline_analysis'
        | 'chapter_draft'
        | 'chapter_draft_batch'
        | 'creative_assets_draft'
        | 'writer_revision_plan'
        | 'chapter_range_review'
        | 'reader_journey'
        | 'worldbuilding_consistency'
        | 'research_fact_check'
        | 'scope_audit';
    title: string;
    status: 'ready' | 'committed' | 'discarded' | 'failed';
    summary?: string | null;
    content?: string | null;
    reference: Record<string, unknown>;
    metadata: Record<string, unknown>;
    reviewStatus?: 'unreviewed' | 'in_review' | 'reviewed' | 'stale';
    reviewRevision?: number;
    reviewDecisions?: Array<{ findingId: string; status: 'accepted' | 'rejected' | 'deferred'; note?: string }>;
    reviewStaleChapterIds?: string[];
    reviewedAt?: string | null;
    createdAt: string;
};

export type AgentRunRecord = {
    runId: string;
    threadId: string;
    planId: string;
    status: string;
    currentStepId?: string | null;
    progress: number;
    events: AgentRunEventRecord[];
    artifacts?: AgentArtifactRecord[];
    draftSessionId?: string | null;
    draftBatchId?: string | null;
    draftOperationId?: string | null;
    draftOperationKey?: string | null;
    draftOperationStatus?: string | null;
    draftOperationVersion?: number | null;
    cancelRequested?: boolean;
    pendingApproval?: Record<string, unknown> | null;
    approvalResponses?: Array<Record<string, unknown>>;
    pendingUserInput?: Record<string, unknown> | null;
    userInputResponses?: Array<Record<string, unknown>>;
    planSnapshot?: unknown;
    retryOfRunId?: string | null;
    retryRootRunId?: string | null;
    retryAttempt?: number;
    failureRevision?: number;
    resumedFrom?: Record<string, unknown> | null;
    completionKind?: 'complete' | 'partial';
    recovery?: Record<string, unknown> | null;
};

export type AgentConversationRecord = {
    id: string;
    novelId: string;
    title: string;
    description: string;
    role: string;
    runtimeConversationId?: string | null;
    updatedAt: string;
    chapterScope?: AgentChapterScopeSelection | null;
    suggestedGoal?: string | null;
    plan?: unknown;
    run?: unknown;
    runs?: AgentRunRecord[];
    contextSummary?: Record<string, unknown> | null;
    pendingUserInput?: Record<string, unknown> | null;
    userInputResolutions?: Array<Record<string, unknown>>;
    composerDraft?: string;
    attentionAcknowledgedRunId?: string | null;
    error?: string;
    messages: Array<{
        id: string;
        sequence?: number;
        role: 'user' | 'assistant' | 'system';
        content: string;
        createdAt: string;
        kind?: AgentConversationMessageKind;
        contextReads?: Array<{ toolName: string; status: 'completed' | 'failed'; message?: string }>;
        contextDiagnostics?: Record<string, unknown>;
        attachmentIds?: string[];
        chapterScopeSnapshot?: AgentChapterScopeSelection;
        activities?: Array<Record<string, unknown>>;
        failure?: Record<string, unknown>;
        evidenceSnapshotId?: string;
    }>;
};

type AgentConversationRow = {
    id: string;
    novelId: string;
    title: string;
    description: string | null;
    role: string;
    runtimeConversationId: string | null;
    updatedAt: string;
    chapterScopeJson: string | null;
    suggestedGoal: string | null;
    planJson: string | null;
    runJson: string | null;
    contextSummaryJson: string | null;
    pendingUserInputJson: string | null;
    userInputResolutionsJson: string | null;
    composerDraft: string | null;
    attentionAcknowledgedRunId: string | null;
    error: string | null;
};

type AgentMessageRow = Omit<AgentConversationRecord['messages'][number], 'contextReads' | 'contextDiagnostics'> & {
    conversationId: string;
    sequence: number;
    metadataJson: string | null;
};
type AgentRunRow = {
    runId: string;
    conversationId: string;
    novelId: string;
    threadId: string;
    planId: string;
    status: string;
    currentStepId: string | null;
    progress: number;
    draftSessionId: string | null;
    draftBatchId: string | null;
    draftOperationId: string | null;
    draftOperationKey: string | null;
    draftOperationStatus: string | null;
    draftOperationVersion: number | null;
    cancelRequested: number | boolean | null;
    pendingApprovalJson: string | null;
    approvalResponsesJson: string | null;
    pendingUserInputJson: string | null;
    userInputResponsesJson: string | null;
    planJson: string | null;
    retryOfRunId: string | null;
    retryRootRunId: string | null;
    retryAttempt: number | null;
    failureRevision: number | null;
    resumedFromJson: string | null;
    completionKind: string | null;
    recoveryJson: string | null;
};
type AgentRunEventRow = Omit<AgentRunEventRecord, 'payload'> & { payloadJson: string | null };
type AgentArtifactRow = {
    artifactId: string;
    runId: string;
    planId: string;
    type: AgentArtifactRecord['type'];
    title: string;
    status: AgentArtifactRecord['status'];
    summary: string | null;
    content: string | null;
    referenceJson: string | null;
    metadataJson: string | null;
    reviewStatus: NonNullable<AgentArtifactRecord['reviewStatus']>;
    reviewRevision: number;
    reviewDecisionsJson: string | null;
    reviewStaleChapterIdsJson: string | null;
    reviewedAt: string | null;
    createdAt: string;
};

export type AgentConversationSummaryCasToken = Readonly<{
    rawValue: string | null;
    version: string | null;
    revision: number | null;
    generation: number | null;
    sourceHash: string | null;
    dependencyHash: string | null;
}>;

export type AgentConversationCompressionSnapshot = {
    storageConversationId: string;
    novelId: string;
    messages: Array<{
        messageId: string;
        sequence: number;
        role: 'user' | 'assistant';
        content: string;
        createdAt: string;
        contextReads?: Array<{ toolName: string; status: 'completed' | 'failed'; message?: string }>;
        attachmentIds?: string[];
        evidenceSnapshotId?: string;
    }>;
    artifacts: AgentArtifactRecord[];
    authoritativeContext: {
        currentPlan: unknown;
        activeRun: AgentRunRecord | null;
        pendingUserInput: Record<string, unknown> | null;
        userInputResolutions: Array<Record<string, unknown>>;
    };
    contextSummary: Record<string, unknown> | null;
    summaryCasToken: AgentConversationSummaryCasToken;
};

function parseJsonField(value: string | null): unknown {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function summaryCasToken(rawValue: string | null): AgentConversationSummaryCasToken {
    const parsed = parseJsonField(rawValue);
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    const coverage = record?.coverage && typeof record.coverage === 'object' && !Array.isArray(record.coverage)
        ? record.coverage as Record<string, unknown>
        : null;
    const sourceIndex = record?.sourceIndex && typeof record.sourceIndex === 'object' && !Array.isArray(record.sourceIndex)
        ? record.sourceIndex as Record<string, unknown>
        : null;
    const revision = Number(record?.revision);
    const parsedGeneration = Number(record?.generation);
    const generation = record?.version === 'agent-conversation-summary-v2' && record?.generation === undefined
        ? 1
        : parsedGeneration;
    return Object.freeze({
        rawValue,
        version: typeof record?.version === 'string' ? record.version : null,
        revision: Number.isInteger(revision) && revision >= 0 ? revision : null,
        generation: Number.isInteger(generation) && generation >= 1 ? generation : null,
        sourceHash: typeof coverage?.sourceHash === 'string' ? coverage.sourceHash : null,
        dependencyHash: typeof sourceIndex?.dependencyHash === 'string' ? sourceIndex.dependencyHash : null,
    });
}

function sameSummaryCasToken(
    left: AgentConversationSummaryCasToken,
    right: AgentConversationSummaryCasToken,
): boolean {
    return left.rawValue === right.rawValue
        && left.version === right.version
        && left.revision === right.revision
        && left.generation === right.generation
        && left.sourceHash === right.sourceHash
        && left.dependencyHash === right.dependencyHash;
}

function dateTimeString(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    return '';
}

function storedDraftBatchId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.draftBatchId === 'string' && record.draftBatchId.trim()) return record.draftBatchId;
    const details = record.details;
    if (details && typeof details === 'object') {
        const nestedId = (details as Record<string, unknown>).draftBatchId;
        if (typeof nestedId === 'string' && nestedId.trim()) return nestedId;
    }
    const artifact = record.artifact;
    if (artifact && typeof artifact === 'object') {
        const reference = (artifact as Record<string, unknown>).reference;
        if (reference && typeof reference === 'object') {
            const nestedId = (reference as Record<string, unknown>).draftBatchId;
            if (typeof nestedId === 'string' && nestedId.trim()) return nestedId;
        }
    }
    return null;
}

function mapAgentRun(row: AgentRunRow, events: AgentRunEventRow[], artifacts: AgentArtifactRow[]): AgentRunRecord {
    const recoveredDraftBatchId = row.draftBatchId
        || [...events].reverse().map((event) => storedDraftBatchId(parseJsonField(event.payloadJson))).find(Boolean)
        || [...artifacts].reverse().map((artifact) => storedDraftBatchId(parseJsonField(artifact.referenceJson))).find(Boolean)
        || null;
    return {
        runId: row.runId,
        threadId: row.threadId,
        planId: row.planId,
        status: row.status,
        currentStepId: row.currentStepId,
        progress: Number(row.progress || 0),
        draftSessionId: row.draftSessionId,
        draftBatchId: recoveredDraftBatchId,
        draftOperationId: row.draftOperationId,
        draftOperationKey: row.draftOperationKey,
        draftOperationStatus: row.draftOperationStatus,
        draftOperationVersion: row.draftOperationVersion,
        cancelRequested: Boolean(row.cancelRequested),
        pendingApproval: (parseJsonField(row.pendingApprovalJson) || null) as Record<string, unknown> | null,
        approvalResponses: (parseJsonField(row.approvalResponsesJson) || []) as Array<Record<string, unknown>>,
        pendingUserInput: (parseJsonField(row.pendingUserInputJson) || null) as Record<string, unknown> | null,
        userInputResponses: (parseJsonField(row.userInputResponsesJson) || []) as Array<Record<string, unknown>>,
        planSnapshot: parseJsonField(row.planJson) || undefined,
        retryOfRunId: row.retryOfRunId,
        retryRootRunId: row.retryRootRunId,
        retryAttempt: Number(row.retryAttempt || 0),
        failureRevision: Number(row.failureRevision || 0),
        resumedFrom: (parseJsonField(row.resumedFromJson) || null) as Record<string, unknown> | null,
        completionKind: row.completionKind === 'partial' ? 'partial' : 'complete',
        recovery: (parseJsonField(row.recoveryJson) || null) as Record<string, unknown> | null,
        artifacts: artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            runId: artifact.runId,
            planId: artifact.planId,
            type: artifact.type,
            title: artifact.title,
            status: artifact.status,
            summary: artifact.summary,
            content: artifact.content,
            reference: (parseJsonField(artifact.referenceJson) || {}) as Record<string, unknown>,
            metadata: (parseJsonField(artifact.metadataJson) || {}) as Record<string, unknown>,
            reviewStatus: artifact.reviewStatus || 'unreviewed',
            reviewRevision: Number(artifact.reviewRevision || 0),
            reviewDecisions: (parseJsonField(artifact.reviewDecisionsJson) || []) as NonNullable<AgentArtifactRecord['reviewDecisions']>,
            reviewStaleChapterIds: (parseJsonField(artifact.reviewStaleChapterIdsJson) || []) as string[],
            reviewedAt: artifact.reviewedAt ? dateTimeString(artifact.reviewedAt) : null,
            createdAt: dateTimeString(artifact.createdAt),
        })),
        events: events.map((event) => ({
            eventId: event.eventId,
            sequence: Number(event.sequence || 0),
            runId: event.runId,
            planId: event.planId,
            threadId: event.threadId,
            stepId: event.stepId,
            type: event.type,
            agent: event.agent,
            toolName: event.toolName,
            status: event.status,
            payload: (parseJsonField(event.payloadJson) || {}) as Record<string, unknown>,
            createdAt: dateTimeString(event.createdAt),
        })),
    };
}

function filterLeakedStepMessages<T extends AgentConversationRecord['messages'][number]>(
    messages: T[],
    runs: AgentRunRecord[],
): T[] {
    const stepTitles = new Set<string>();
    for (const run of runs) {
        const snapshot = run.planSnapshot;
        if (!snapshot || typeof snapshot !== 'object') continue;
        const steps = (snapshot as { steps?: unknown }).steps;
        if (!Array.isArray(steps)) continue;
        for (const step of steps) {
            if (!step || typeof step !== 'object') continue;
            const title = (step as { title?: unknown }).title;
            if (typeof title === 'string' && title.trim()) stepTitles.add(title.trim());
        }
    }
    if (stepTitles.size === 0) return messages;
    return messages.filter((message) => (
        message.role !== 'assistant' || !stepTitles.has(message.content.trim())
    ));
}

const SQLITE_LOCK_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];
let globalWriteQueue: Promise<void> = Promise.resolve();

function isSqliteLockedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; meta?: { code?: unknown; message?: unknown }; message?: unknown };
    const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
    const metaMessage = typeof candidate.meta?.message === 'string' ? candidate.meta.message.toLowerCase() : '';
    return candidate.code === 'P2010'
        && candidate.meta?.code === '5'
        && (message.includes('database is locked') || metaMessage.includes('database is locked'));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithSqliteLockRetry<T>(task: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
        try {
            return await task();
        } catch (error) {
            const delayMs = SQLITE_LOCK_RETRY_DELAYS_MS[attempt];
            if (!isSqliteLockedError(error) || delayMs === undefined) throw error;
            attempt += 1;
            console.warn('[AgentConversationStore] SQLite database is locked; retrying write', {
                attempt,
                delayMs,
            });
            await delay(delayMs);
        }
    }
}

async function enqueueGlobalWrite<T>(task: () => Promise<T>): Promise<T> {
    const previous = globalWriteQueue;
    let release!: () => void;
    globalWriteQueue = new Promise((resolve) => {
        release = resolve;
    });
    await previous.catch(() => undefined);
    try {
        return await runWithSqliteLockRetry(task);
    } finally {
        release();
    }
}

export class AgentConversationStore {
    private readonly db: PrismaClientType;
    private readonly writeQueues = new Map<string, Promise<void>>();
    private schemaReady: Promise<void> | null = null;
    private legacyStepMessagesCleaned = false;

    constructor(db: PrismaClientType) {
        this.db = db;
    }

    async ensureSchema(): Promise<void> {
        if (!this.schemaReady) {
            this.schemaReady = this.initializeSchema().catch((error) => {
                this.schemaReady = null;
                throw error;
            });
        }
        return this.schemaReady;
    }

    private async initializeSchema(): Promise<void> {
        await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentConversation (
                id TEXT PRIMARY KEY, novelId TEXT NOT NULL, title TEXT NOT NULL,
                description TEXT, role TEXT NOT NULL, runtimeConversationId TEXT,
                suggestedGoal TEXT, planJson TEXT, runJson TEXT, contextSummaryJson TEXT, chapterScopeJson TEXT,
                pendingUserInputJson TEXT, userInputResolutionsJson TEXT,
                composerDraft TEXT NOT NULL DEFAULT '', attentionAcknowledgedRunId TEXT, error TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `);
        const conversationColumns = await this.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(AgentConversation)');
        if (!conversationColumns.some((column) => column.name === 'contextSummaryJson')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentConversation ADD COLUMN contextSummaryJson TEXT');
        }
        if (!conversationColumns.some((column) => column.name === 'pendingUserInputJson')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentConversation ADD COLUMN pendingUserInputJson TEXT');
        }
        if (!conversationColumns.some((column) => column.name === 'userInputResolutionsJson')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentConversation ADD COLUMN userInputResolutionsJson TEXT');
        }
        if (!conversationColumns.some((column) => column.name === 'chapterScopeJson')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentConversation ADD COLUMN chapterScopeJson TEXT');
        }
        if (!conversationColumns.some((column) => column.name === 'composerDraft')) {
            await this.db.$executeRawUnsafe("ALTER TABLE AgentConversation ADD COLUMN composerDraft TEXT NOT NULL DEFAULT ''");
        }
        if (!conversationColumns.some((column) => column.name === 'attentionAcknowledgedRunId')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentConversation ADD COLUMN attentionAcknowledgedRunId TEXT');
        }
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_conversation_novel_updated ON AgentConversation(novelId, updatedAt)');
        await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentMessage (
                id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, metadataJson TEXT, sequence INTEGER NOT NULL,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE
            )
        `);
        const messageColumns = await this.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(AgentMessage)');
        if (!messageColumns.some((column) => column.name === 'metadataJson')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentMessage ADD COLUMN metadataJson TEXT');
        }
        if (!messageColumns.some((column) => column.name === 'sequence')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentMessage ADD COLUMN sequence INTEGER');
        }
        await this.db.$executeRawUnsafe(`
            UPDATE AgentMessage AS current
            SET sequence = (
                SELECT COUNT(*)
                FROM AgentMessage AS prior
                WHERE prior.conversationId = current.conversationId
                  AND (
                    datetime(prior.createdAt) < datetime(current.createdAt)
                    OR (datetime(prior.createdAt) = datetime(current.createdAt) AND prior.id <= current.id)
                  )
            )
            WHERE sequence IS NULL OR sequence < 1
        `);
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_message_conversation_created ON AgentMessage(conversationId, createdAt)');
        await this.db.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_message_conversation_sequence ON AgentMessage(conversationId, sequence)');
        await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentRun (
                runId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, novelId TEXT NOT NULL,
                threadId TEXT NOT NULL, planId TEXT NOT NULL, status TEXT NOT NULL,
                currentStepId TEXT, progress REAL NOT NULL DEFAULT 0, draftSessionId TEXT, draftBatchId TEXT,
                draftOperationId TEXT, draftOperationKey TEXT, draftOperationStatus TEXT, draftOperationVersion INTEGER,
                cancelRequested INTEGER NOT NULL DEFAULT 0, pendingApprovalJson TEXT,
                approvalResponsesJson TEXT, pendingUserInputJson TEXT,
                userInputResponsesJson TEXT, planJson TEXT,
                retryOfRunId TEXT, retryRootRunId TEXT, retryAttempt INTEGER NOT NULL DEFAULT 0,
                failureRevision INTEGER NOT NULL DEFAULT 0, resumedFromJson TEXT,
                completionKind TEXT NOT NULL DEFAULT 'complete', recoveryJson TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `);
        const columns = await this.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(AgentRun)');
        const names = new Set(columns.map((column) => column.name));
        if (!names.has('pendingApprovalJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN pendingApprovalJson TEXT');
        if (!names.has('draftBatchId')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN draftBatchId TEXT');
        if (!names.has('draftOperationId')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN draftOperationId TEXT');
        if (!names.has('draftOperationKey')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN draftOperationKey TEXT');
        if (!names.has('draftOperationStatus')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN draftOperationStatus TEXT');
        if (!names.has('draftOperationVersion')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN draftOperationVersion INTEGER');
        if (!names.has('approvalResponsesJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN approvalResponsesJson TEXT');
        if (!names.has('planJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN planJson TEXT');
        if (!names.has('pendingUserInputJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN pendingUserInputJson TEXT');
        if (!names.has('userInputResponsesJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN userInputResponsesJson TEXT');
        if (!names.has('retryOfRunId')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN retryOfRunId TEXT');
        if (!names.has('retryRootRunId')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN retryRootRunId TEXT');
        if (!names.has('retryAttempt')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN retryAttempt INTEGER NOT NULL DEFAULT 0');
        if (!names.has('failureRevision')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN failureRevision INTEGER NOT NULL DEFAULT 0');
        if (!names.has('resumedFromJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN resumedFromJson TEXT');
        if (!names.has('completionKind')) await this.db.$executeRawUnsafe("ALTER TABLE AgentRun ADD COLUMN completionKind TEXT NOT NULL DEFAULT 'complete'");
        if (!names.has('recoveryJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN recoveryJson TEXT');
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_run_conversation_updated ON AgentRun(conversationId, updatedAt)');
        await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentRunEvent (
                eventId TEXT PRIMARY KEY, sequence INTEGER NOT NULL, runId TEXT NOT NULL,
                planId TEXT, threadId TEXT, stepId TEXT, type TEXT NOT NULL, agent TEXT,
                toolName TEXT, status TEXT, payloadJson TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (runId) REFERENCES AgentRun(runId) ON DELETE CASCADE
            )
        `);
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_run_event_run_sequence ON AgentRunEvent(runId, sequence)');
        await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentArtifact (
                artifactId TEXT PRIMARY KEY, conversationId TEXT NOT NULL,
                runId TEXT NOT NULL, novelId TEXT NOT NULL, planId TEXT NOT NULL,
                type TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
                summary TEXT, content TEXT, referenceJson TEXT, metadataJson TEXT,
                reviewStatus TEXT NOT NULL DEFAULT 'unreviewed',
                reviewRevision INTEGER NOT NULL DEFAULT 0,
                reviewDecisionsJson TEXT, reviewStaleChapterIdsJson TEXT, reviewedAt DATETIME,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE,
                FOREIGN KEY (runId) REFERENCES AgentRun(runId) ON DELETE CASCADE,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `);
        const artifactColumns = await this.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(AgentArtifact)');
        const artifactColumnNames = new Set(artifactColumns.map((column) => column.name));
        if (!artifactColumnNames.has('reviewStatus')) {
            await this.db.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewStatus TEXT NOT NULL DEFAULT 'unreviewed'");
        }
        if (!artifactColumnNames.has('reviewRevision')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentArtifact ADD COLUMN reviewRevision INTEGER NOT NULL DEFAULT 0');
        }
        if (!artifactColumnNames.has('reviewDecisionsJson')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentArtifact ADD COLUMN reviewDecisionsJson TEXT');
        }
        if (!artifactColumnNames.has('reviewStaleChapterIdsJson')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentArtifact ADD COLUMN reviewStaleChapterIdsJson TEXT');
        }
        if (!artifactColumnNames.has('reviewedAt')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentArtifact ADD COLUMN reviewedAt DATETIME');
        }
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_artifact_conversation_created ON AgentArtifact(conversationId, createdAt)');
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_artifact_run_created ON AgentArtifact(runId, createdAt)');
        if (!this.legacyStepMessagesCleaned) {
            await this.cleanupLegacyStepMessages();
            this.legacyStepMessagesCleaned = true;
        }
    }

    async list(novelId: string): Promise<AgentConversationRecord[]> {
        await this.ensureSchema();
        const rows = await this.db.$queryRawUnsafe<AgentConversationRow[]>(`
            SELECT id, novelId, title, description, role, runtimeConversationId,
                   updatedAt, suggestedGoal, planJson, runJson, contextSummaryJson, chapterScopeJson,
                   pendingUserInputJson, userInputResolutionsJson, composerDraft,
                   attentionAcknowledgedRunId, error
            FROM AgentConversation WHERE novelId = ? ORDER BY datetime(updatedAt) DESC
        `, novelId);
        const conversations: AgentConversationRecord[] = [];
        for (const row of rows) {
            const messages = await this.db.$queryRawUnsafe<AgentMessageRow[]>(`
                SELECT id, conversationId, role, content, metadataJson, sequence, createdAt FROM AgentMessage
                WHERE conversationId = ? ORDER BY sequence ASC
            `, row.id);
            const runRows = await this.db.$queryRawUnsafe<AgentRunRow[]>(`
                SELECT runId, conversationId, novelId, threadId, planId, status,
                       currentStepId, progress, draftSessionId, draftBatchId,
                       draftOperationId, draftOperationKey, draftOperationStatus, draftOperationVersion,
                       cancelRequested,
                       pendingApprovalJson, approvalResponsesJson, pendingUserInputJson,
                       userInputResponsesJson, planJson,
                       retryOfRunId, retryRootRunId, retryAttempt, failureRevision,
                       resumedFromJson, completionKind, recoveryJson
                FROM AgentRun WHERE conversationId = ? ORDER BY datetime(updatedAt) DESC
            `, row.id);
            const runs: AgentRunRecord[] = [];
            for (const run of runRows) {
                const events = await this.db.$queryRawUnsafe<AgentRunEventRow[]>(`
                    SELECT eventId, sequence, runId, planId, threadId, stepId, type,
                           agent, toolName, status, payloadJson, createdAt
                    FROM AgentRunEvent WHERE runId = ? ORDER BY sequence ASC
                `, run.runId);
                const artifacts = await this.db.$queryRawUnsafe<AgentArtifactRow[]>(`
                    SELECT artifactId, runId, planId, type, title, status, summary,
                           content, referenceJson, metadataJson, reviewStatus, reviewRevision,
                           reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt, createdAt
                    FROM AgentArtifact WHERE runId = ? ORDER BY datetime(createdAt) ASC
                `, run.runId);
                runs.push(mapAgentRun(run, events, artifacts));
            }
            const runPointer = parseJsonField(row.runJson);
            const hasRunPointer = Boolean(runPointer && typeof runPointer === 'object' && Object.prototype.hasOwnProperty.call(runPointer, 'runId'));
            const activeRunId = hasRunPointer ? (runPointer as { runId?: unknown }).runId : undefined;
            const currentRun = hasRunPointer
                ? (typeof activeRunId === 'string' ? runs.find((run) => run.runId === activeRunId) ?? null : null)
                : runs[0] || null;
            const visibleMessages = filterLeakedStepMessages(messages, runs);
            conversations.push({
                id: row.id,
                novelId: row.novelId,
                title: row.title,
                description: row.description || '',
                role: row.role,
                runtimeConversationId: row.runtimeConversationId,
                updatedAt: dateTimeString(row.updatedAt),
                chapterScope: (parseJsonField(row.chapterScopeJson) || null) as AgentChapterScopeSelection | null,
                suggestedGoal: row.suggestedGoal,
                plan: parseJsonField(row.planJson),
                run: currentRun,
                runs,
                contextSummary: (parseJsonField(row.contextSummaryJson) || null) as Record<string, unknown> | null,
                pendingUserInput: (parseJsonField(row.pendingUserInputJson) || null) as Record<string, unknown> | null,
                userInputResolutions: (parseJsonField(row.userInputResolutionsJson) || []) as Array<Record<string, unknown>>,
                composerDraft: row.composerDraft || '',
                attentionAcknowledgedRunId: row.attentionAcknowledgedRunId,
                error: row.error || '',
                messages: visibleMessages.map(({ id, sequence, role, content, metadataJson, createdAt }) => {
                    const metadata = parseJsonField(metadataJson);
                    const record = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
                    return {
                        id,
                        sequence: Number(sequence),
                        role,
                        content,
                        createdAt: dateTimeString(createdAt),
                        ...(['chat', 'role_status', 'workflow_notice', 'context_compression'].includes(String(record.kind))
                            ? { kind: record.kind as AgentConversationMessageKind }
                            : {}),
                        ...(Array.isArray(record.contextReads) ? { contextReads: record.contextReads as AgentConversationRecord['messages'][number]['contextReads'] } : {}),
                        ...(record.contextDiagnostics && typeof record.contextDiagnostics === 'object'
                            ? { contextDiagnostics: record.contextDiagnostics as Record<string, unknown> }
                            : {}),
                        ...(Array.isArray(record.attachmentIds)
                            ? { attachmentIds: record.attachmentIds.filter((id): id is string => typeof id === 'string') }
                            : {}),
                        ...(record.chapterScopeSnapshot && typeof record.chapterScopeSnapshot === 'object'
                            ? { chapterScopeSnapshot: record.chapterScopeSnapshot as AgentChapterScopeSelection }
                            : {}),
                        ...(Array.isArray(record.activities) ? { activities: record.activities as Array<Record<string, unknown>> } : {}),
                        ...(record.failure && typeof record.failure === 'object' ? { failure: record.failure as Record<string, unknown> } : {}),
                        ...(typeof record.evidenceSnapshotId === 'string' ? { evidenceSnapshotId: record.evidenceSnapshotId } : {}),
                    };
                }),
            });
        }
        return conversations;
    }

    async upsert(conversation: AgentConversationRecord): Promise<{ ok: true }> {
        return this.enqueue(conversation.id, async () => {
            await this.ensureSchema();
            const now = new Date().toISOString();
            const updatedAt = conversation.updatedAt || now;
            await this.db.$executeRawUnsafe(`
                INSERT INTO AgentConversation (
                    id, novelId, title, description, role, runtimeConversationId,
                    suggestedGoal, planJson, runJson, contextSummaryJson, chapterScopeJson,
                    composerDraft, attentionAcknowledgedRunId, error, createdAt, updatedAt,
                    pendingUserInputJson, userInputResolutionsJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    novelId = excluded.novelId, title = excluded.title,
                    description = excluded.description, role = excluded.role,
                    runtimeConversationId = excluded.runtimeConversationId,
                    suggestedGoal = excluded.suggestedGoal, planJson = excluded.planJson,
                    runJson = excluded.runJson,
                    chapterScopeJson = excluded.chapterScopeJson,
                    composerDraft = excluded.composerDraft,
                    attentionAcknowledgedRunId = excluded.attentionAcknowledgedRunId,
                    pendingUserInputJson = excluded.pendingUserInputJson,
                    userInputResolutionsJson = excluded.userInputResolutionsJson,
                    error = excluded.error, updatedAt = excluded.updatedAt
            `, conversation.id, conversation.novelId, conversation.title, conversation.description || '',
            conversation.role, conversation.runtimeConversationId || null, conversation.suggestedGoal || null,
            conversation.plan ? JSON.stringify(conversation.plan) : null,
            JSON.stringify({ runId: (conversation.run as AgentRunRecord | null | undefined)?.runId ?? null }),
            null,
            conversation.chapterScope ? JSON.stringify(conversation.chapterScope) : null,
            conversation.composerDraft || '', conversation.attentionAcknowledgedRunId || null,
            conversation.error || '', now, updatedAt,
            conversation.pendingUserInput ? JSON.stringify(conversation.pendingUserInput) : null,
            JSON.stringify(conversation.userInputResolutions || []));
            await this.db.$executeRawUnsafe('DELETE FROM AgentMessage WHERE conversationId = ?', conversation.id);
            for (const [messageIndex, message] of (conversation.messages || []).entries()) {
                const metadata = {
                    ...(message.kind ? { kind: message.kind } : {}),
                    ...(message.contextReads?.length ? { contextReads: message.contextReads } : {}),
                    ...(message.contextDiagnostics ? { contextDiagnostics: message.contextDiagnostics } : {}),
                    ...(message.attachmentIds?.length ? { attachmentIds: message.attachmentIds } : {}),
                    ...(message.chapterScopeSnapshot ? { chapterScopeSnapshot: message.chapterScopeSnapshot } : {}),
                    ...(message.activities?.length ? { activities: message.activities } : {}),
                    ...(message.failure ? { failure: message.failure } : {}),
                    ...(message.evidenceSnapshotId ? { evidenceSnapshotId: message.evidenceSnapshotId } : {}),
                };
                await this.db.$executeRawUnsafe(`
                    INSERT INTO AgentMessage (id, conversationId, role, content, metadataJson, sequence, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)
                `, message.id, conversation.id, message.role, message.content,
                Object.keys(metadata).length ? JSON.stringify(metadata) : null, messageIndex + 1, message.createdAt || now);
            }
            const run = conversation.run as AgentRunRecord | null | undefined;
            if (run?.runId) {
                await this.db.$executeRawUnsafe(`
                    INSERT INTO AgentRun (
                        runId, conversationId, novelId, threadId, planId, status,
                        currentStepId, progress, draftSessionId, draftBatchId,
                        draftOperationId, draftOperationKey, draftOperationStatus, draftOperationVersion,
                        cancelRequested,
                        pendingApprovalJson, approvalResponsesJson, pendingUserInputJson,
                        userInputResponsesJson, planJson,
                        retryOfRunId, retryRootRunId, retryAttempt, failureRevision,
                        resumedFromJson, completionKind, recoveryJson,
                        createdAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(runId) DO UPDATE SET
                        conversationId = excluded.conversationId, novelId = excluded.novelId,
                        threadId = excluded.threadId, planId = excluded.planId, status = excluded.status,
                        currentStepId = excluded.currentStepId, progress = excluded.progress,
                        draftSessionId = excluded.draftSessionId, draftBatchId = excluded.draftBatchId,
                        draftOperationId = excluded.draftOperationId,
                        draftOperationKey = excluded.draftOperationKey,
                        draftOperationStatus = excluded.draftOperationStatus,
                        draftOperationVersion = excluded.draftOperationVersion,
                        cancelRequested = excluded.cancelRequested,
                        pendingApprovalJson = excluded.pendingApprovalJson,
                        approvalResponsesJson = excluded.approvalResponsesJson,
                        pendingUserInputJson = excluded.pendingUserInputJson,
                        userInputResponsesJson = excluded.userInputResponsesJson,
                        planJson = excluded.planJson,
                        retryOfRunId = excluded.retryOfRunId,
                        retryRootRunId = excluded.retryRootRunId,
                        retryAttempt = excluded.retryAttempt,
                        failureRevision = excluded.failureRevision,
                        resumedFromJson = excluded.resumedFromJson,
                        completionKind = excluded.completionKind,
                        recoveryJson = excluded.recoveryJson,
                        updatedAt = excluded.updatedAt
                `, run.runId, conversation.id, conversation.novelId, run.threadId, run.planId, run.status,
                run.currentStepId || null, Number(run.progress || 0), run.draftSessionId || null, run.draftBatchId || null,
                run.draftOperationId || null, run.draftOperationKey || null,
                run.draftOperationStatus || null, run.draftOperationVersion ?? null,
                run.cancelRequested ? 1 : 0, run.pendingApproval ? JSON.stringify(run.pendingApproval) : null,
                JSON.stringify(run.approvalResponses || []),
                run.pendingUserInput ? JSON.stringify(run.pendingUserInput) : null,
                JSON.stringify(run.userInputResponses || []),
                run.planSnapshot ? JSON.stringify(run.planSnapshot) : null,
                run.retryOfRunId || null, run.retryRootRunId || null,
                Number(run.retryAttempt || 0), Number(run.failureRevision || 0),
                run.resumedFrom ? JSON.stringify(run.resumedFrom) : null,
                run.completionKind || 'complete', run.recovery ? JSON.stringify(run.recovery) : null,
                now, updatedAt);
                for (const event of run.events || []) {
                    await this.db.$executeRawUnsafe(`
                        INSERT INTO AgentRunEvent (
                            eventId, sequence, runId, planId, threadId, stepId,
                            type, agent, toolName, status, payloadJson, createdAt
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(eventId) DO UPDATE SET
                            sequence = excluded.sequence, planId = excluded.planId,
                            threadId = excluded.threadId, stepId = excluded.stepId,
                            type = excluded.type, agent = excluded.agent, toolName = excluded.toolName,
                            status = excluded.status, payloadJson = excluded.payloadJson,
                            createdAt = excluded.createdAt
                    `, event.eventId, Number(event.sequence || 0), run.runId, event.planId || null,
                    event.threadId || null, event.stepId || null, event.type, event.agent || null,
                    event.toolName || null, event.status || null, JSON.stringify(event.payload || {}), event.createdAt || now);
                }
                for (const artifact of run.artifacts || []) {
                    await this.db.$executeRawUnsafe(`
                        INSERT INTO AgentArtifact (
                            artifactId, conversationId, runId, novelId, planId, type,
                            title, status, summary, content, referenceJson, metadataJson,
                            reviewStatus, reviewRevision, reviewDecisionsJson,
                            reviewStaleChapterIdsJson, reviewedAt, createdAt, updatedAt
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(artifactId) DO UPDATE SET
                            title = excluded.title, status = excluded.status,
                            summary = excluded.summary, content = excluded.content,
                            referenceJson = excluded.referenceJson,
                            metadataJson = excluded.metadataJson, updatedAt = excluded.updatedAt
                    `, artifact.artifactId, conversation.id, run.runId, conversation.novelId,
                    artifact.planId || run.planId, artifact.type, artifact.title, artifact.status,
                    artifact.summary || null, artifact.content || null,
                    JSON.stringify(artifact.reference || {}), JSON.stringify(artifact.metadata || {}),
                    artifact.reviewStatus || 'unreviewed', Number(artifact.reviewRevision || 0),
                    JSON.stringify(artifact.reviewDecisions || []),
                    JSON.stringify(artifact.reviewStaleChapterIds || []), artifact.reviewedAt || null,
                    artifact.createdAt || now, updatedAt);
                }
            }
            return { ok: true };
        });
    }

    async updateComposerDraft(conversationId: string, composerDraft: string): Promise<{ ok: true }> {
        return this.enqueue(conversationId, async () => {
            await this.ensureSchema();
            await this.db.$executeRawUnsafe(
                'UPDATE AgentConversation SET composerDraft = ? WHERE id = ?',
                composerDraft,
                conversationId,
            );
            return { ok: true };
        });
    }

    async readCompressionSnapshot(conversationId: string): Promise<AgentConversationCompressionSnapshot | null> {
        await this.ensureSchema();
        const rows = await this.db.$queryRawUnsafe<AgentConversationRow[]>(`
            SELECT id, novelId, title, description, role, runtimeConversationId,
                   updatedAt, suggestedGoal, planJson, runJson, contextSummaryJson, chapterScopeJson,
                   pendingUserInputJson, userInputResolutionsJson, composerDraft,
                   attentionAcknowledgedRunId, error
            FROM AgentConversation WHERE id = ? LIMIT 1
        `, conversationId);
        const row = rows[0];
        if (!row) return null;
        const messages = await this.db.$queryRawUnsafe<AgentMessageRow[]>(`
            SELECT id, conversationId, role, content, metadataJson, sequence, createdAt
            FROM AgentMessage
            WHERE conversationId = ? AND role IN ('user', 'assistant')
            ORDER BY sequence ASC
        `, conversationId);
        const runRows = await this.db.$queryRawUnsafe<AgentRunRow[]>(`
            SELECT runId, conversationId, novelId, threadId, planId, status,
                   currentStepId, progress, draftSessionId, draftBatchId,
                   draftOperationId, draftOperationKey, draftOperationStatus, draftOperationVersion,
                   cancelRequested, pendingApprovalJson, approvalResponsesJson, pendingUserInputJson,
                   userInputResponsesJson, planJson,
                   retryOfRunId, retryRootRunId, retryAttempt, failureRevision,
                   resumedFromJson, completionKind, recoveryJson
            FROM AgentRun WHERE conversationId = ? ORDER BY datetime(updatedAt) DESC
        `, conversationId);
        const runPointer = parseJsonField(row.runJson);
        const activeRunId = runPointer && typeof runPointer === 'object'
            ? (runPointer as { runId?: unknown }).runId
            : undefined;
        const activeRunRow = typeof activeRunId === 'string'
            ? runRows.find((run) => run.runId === activeRunId)
            : runRows[0];
        let activeRun: AgentRunRecord | null = null;
        if (activeRunRow) {
            const events = await this.db.$queryRawUnsafe<AgentRunEventRow[]>(`
                SELECT eventId, sequence, runId, planId, threadId, stepId, type,
                       agent, toolName, status, payloadJson, createdAt
                FROM AgentRunEvent WHERE runId = ? ORDER BY sequence ASC
            `, activeRunRow.runId);
            const runArtifacts = await this.db.$queryRawUnsafe<AgentArtifactRow[]>(`
                SELECT artifactId, runId, planId, type, title, status, summary,
                       content, referenceJson, metadataJson, reviewStatus, reviewRevision,
                       reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt, createdAt
                FROM AgentArtifact WHERE runId = ? ORDER BY datetime(createdAt) ASC
            `, activeRunRow.runId);
            activeRun = mapAgentRun(activeRunRow, events, runArtifacts);
        }
        const artifactRows = await this.db.$queryRawUnsafe<AgentArtifactRow[]>(`
            SELECT artifactId, runId, planId, type, title, status, summary,
                   content, referenceJson, metadataJson, reviewStatus, reviewRevision,
                   reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt, createdAt
            FROM AgentArtifact WHERE conversationId = ? ORDER BY datetime(createdAt) ASC
        `, conversationId);
        const rawSummary = row.contextSummaryJson;
        return {
            storageConversationId: row.id,
            novelId: row.novelId,
            messages: messages.map((message) => {
                const metadata = parseJsonField(message.metadataJson);
                const record = metadata && typeof metadata === 'object'
                    ? metadata as Record<string, unknown>
                    : {};
                return {
                    messageId: message.id,
                    sequence: Number(message.sequence),
                    role: message.role as 'user' | 'assistant',
                    content: message.content,
                    createdAt: dateTimeString(message.createdAt),
                    ...(Array.isArray(record.contextReads)
                        ? { contextReads: record.contextReads as AgentConversationCompressionSnapshot['messages'][number]['contextReads'] }
                        : {}),
                    ...(Array.isArray(record.attachmentIds)
                        ? { attachmentIds: record.attachmentIds.filter((id): id is string => typeof id === 'string') }
                        : {}),
                    ...(typeof record.evidenceSnapshotId === 'string'
                        ? { evidenceSnapshotId: record.evidenceSnapshotId }
                        : {}),
                };
            }),
            artifacts: artifactRows.map((artifact) => ({
                artifactId: artifact.artifactId,
                runId: artifact.runId,
                planId: artifact.planId,
                type: artifact.type,
                title: artifact.title,
                status: artifact.status,
                summary: artifact.summary,
                content: artifact.content,
                reference: (parseJsonField(artifact.referenceJson) || {}) as Record<string, unknown>,
                metadata: (parseJsonField(artifact.metadataJson) || {}) as Record<string, unknown>,
                reviewStatus: artifact.reviewStatus || 'unreviewed',
                reviewRevision: Number(artifact.reviewRevision || 0),
                reviewDecisions: (parseJsonField(artifact.reviewDecisionsJson) || []) as NonNullable<AgentArtifactRecord['reviewDecisions']>,
                reviewStaleChapterIds: (parseJsonField(artifact.reviewStaleChapterIdsJson) || []) as string[],
                reviewedAt: artifact.reviewedAt ? dateTimeString(artifact.reviewedAt) : null,
                createdAt: dateTimeString(artifact.createdAt),
            })),
            authoritativeContext: {
                currentPlan: parseJsonField(row.planJson),
                activeRun,
                pendingUserInput: (parseJsonField(row.pendingUserInputJson) || null) as Record<string, unknown> | null,
                userInputResolutions: (parseJsonField(row.userInputResolutionsJson) || []) as Array<Record<string, unknown>>,
            },
            contextSummary: (parseJsonField(rawSummary) || null) as Record<string, unknown> | null,
            summaryCasToken: summaryCasToken(rawSummary),
        };
    }

    async compareAndSwapContextSummary(
        conversationId: string,
        token: AgentConversationSummaryCasToken,
        nextSummary: Record<string, unknown>,
    ): Promise<{ ok: true; summaryCasToken: AgentConversationSummaryCasToken } | { ok: false; reason: 'conflict' }> {
        return this.enqueue(conversationId, async () => {
            await this.ensureSchema();
            const expected = summaryCasToken(token.rawValue);
            if (!sameSummaryCasToken(token, expected)) {
                throw new Error('Invalid Agent conversation summary CAS token.');
            }
            const nextVersion = String(nextSummary.version || '');
            const nextRevision = Number(nextSummary.revision);
            const nextPreviousRevision = Number(nextSummary.previousRevision);
            const nextGeneration = Number(nextSummary.generation);
            const nextRebuild = nextSummary.rebuild && typeof nextSummary.rebuild === 'object'
                ? nextSummary.rebuild as Record<string, unknown>
                : null;
            const expectedPreviousRevision = expected.version === 'agent-conversation-summary-v2'
                ? expected.revision
                : 0;
            const expectedGeneration = expected.version === 'agent-conversation-summary-v2'
                ? Number(expected.generation || 1)
                : 0;
            const rebuilding = nextGeneration === expectedGeneration + 1 && expectedGeneration >= 1;
            const validGenerationTransition = expectedGeneration === 0
                ? nextGeneration === 1 && !nextRebuild
                : rebuilding
                    ? Number(nextRebuild?.previousGeneration) === expectedGeneration
                        && ['source_changed', 'manual_quality_rebuild'].includes(String(nextRebuild?.reason || ''))
                    : nextGeneration === expectedGeneration && !nextRebuild;
            if (nextVersion !== 'agent-conversation-summary-v2'
                || !Number.isInteger(nextRevision)
                || nextRevision !== Number(expectedPreviousRevision || 0) + 1
                || nextPreviousRevision !== Number(expectedPreviousRevision || 0)
                || !Number.isInteger(nextGeneration)
                || !validGenerationTransition) {
                throw new Error('Invalid Agent conversation summary revision transition.');
            }
            const normalizedNext = normalizeAgentConversationSummaryV2(nextSummary);
            if (!normalizedNext) {
                throw new Error('Invalid Agent conversation summary payload.');
            }
            const currentMessageRows = await this.db.$queryRawUnsafe<AgentMessageRow[]>(`
                SELECT id, conversationId, role, content, metadataJson, sequence, createdAt
                FROM AgentMessage
                WHERE conversationId = ? AND role IN ('user', 'assistant')
                ORDER BY sequence ASC
            `, conversationId);
            const coveredRows = currentMessageRows.slice(0, normalizedNext.coverage.messageCount);
            const coveredMessages = coveredRows.map((message) => ({
                messageId: message.id,
                sequence: Number(message.sequence),
                role: message.role as 'user' | 'assistant',
                content: message.content,
            }));
            if (!validateAgentConversationSummaryCoverageV2(normalizedNext, coveredMessages)) {
                return { ok: false as const, reason: 'conflict' as const };
            }
            const nextRaw = JSON.stringify(nextSummary);
            const affected = await this.db.$executeRawUnsafe(
                `UPDATE AgentConversation
                 SET contextSummaryJson = ?
                 WHERE id = ? AND contextSummaryJson IS ?`,
                nextRaw,
                conversationId,
                token.rawValue,
            );
            if (Number(affected) !== 1) return { ok: false as const, reason: 'conflict' as const };
            return { ok: true as const, summaryCasToken: summaryCasToken(nextRaw) };
        });
    }

    async acknowledgeRun(conversationId: string, runId: string | null): Promise<{ ok: true }> {
        return this.enqueue(conversationId, async () => {
            await this.ensureSchema();
            await this.db.$executeRawUnsafe(
                'UPDATE AgentConversation SET attentionAcknowledgedRunId = ? WHERE id = ?',
                runId,
                conversationId,
            );
            return { ok: true };
        });
    }

    async delete(conversationId: string): Promise<{ ok: true }> {
        return this.enqueue(conversationId, async () => {
            await this.ensureSchema();
            const runs = await this.db.$queryRawUnsafe<Array<{ runId: string }>>('SELECT runId FROM AgentRun WHERE conversationId = ?', conversationId);
            for (const run of runs) {
                await this.db.$executeRawUnsafe('DELETE FROM AgentArtifact WHERE runId = ?', run.runId);
                await this.db.$executeRawUnsafe('DELETE FROM AgentRunEvent WHERE runId = ?', run.runId);
            }
            await this.db.$executeRawUnsafe('DELETE FROM AgentRun WHERE conversationId = ?', conversationId);
            await this.db.$executeRawUnsafe('DELETE FROM AgentMessage WHERE conversationId = ?', conversationId);
            await this.db.$executeRawUnsafe('DELETE FROM AgentConversation WHERE id = ?', conversationId);
            return { ok: true };
        });
    }

    private async cleanupLegacyStepMessages(): Promise<void> {
        const runRows = await this.db.$queryRawUnsafe<Array<{ conversationId: string; planJson: string | null }>>(`
            SELECT conversationId, planJson FROM AgentRun WHERE planJson IS NOT NULL
        `);
        const titlesByConversation = new Map<string, Set<string>>();
        for (const row of runRows) {
            const snapshot = parseJsonField(row.planJson);
            if (!snapshot || typeof snapshot !== 'object') continue;
            const steps = (snapshot as { steps?: unknown }).steps;
            if (!Array.isArray(steps)) continue;
            const titles = titlesByConversation.get(row.conversationId) ?? new Set<string>();
            for (const step of steps) {
                if (!step || typeof step !== 'object') continue;
                const title = (step as { title?: unknown }).title;
                if (typeof title === 'string' && title.trim()) titles.add(title.trim());
            }
            titlesByConversation.set(row.conversationId, titles);
        }
        if (titlesByConversation.size === 0) return;
        const messages = await this.db.$queryRawUnsafe<Array<{ id: string; conversationId: string; content: string }>>(`
            SELECT id, conversationId, content FROM AgentMessage WHERE role = 'assistant'
        `);
        for (const message of messages) {
            if (!titlesByConversation.get(message.conversationId)?.has(message.content.trim())) continue;
            await this.db.$executeRawUnsafe(
                'DELETE FROM AgentMessage WHERE id = ? AND conversationId = ?',
                message.id,
                message.conversationId,
            );
        }
    }

    private async enqueue<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.writeQueues.get(conversationId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(() => enqueueGlobalWrite(task));
        const settled = next.then(() => undefined, () => undefined);
        this.writeQueues.set(conversationId, settled);
        try {
            return await next;
        } finally {
            if (this.writeQueues.get(conversationId) === settled) this.writeQueues.delete(conversationId);
        }
    }
}
