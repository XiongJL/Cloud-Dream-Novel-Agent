import type { PrismaClientType } from '@novel-editor/core';

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
    cancelRequested?: boolean;
    pendingApproval?: Record<string, unknown> | null;
    approvalResponses?: Array<Record<string, unknown>>;
    planSnapshot?: unknown;
};

export type AgentConversationRecord = {
    id: string;
    novelId: string;
    title: string;
    description: string;
    role: string;
    runtimeConversationId?: string | null;
    updatedAt: string;
    suggestedGoal?: string | null;
    plan?: unknown;
    run?: unknown;
    runs?: AgentRunRecord[];
    contextSummary?: Record<string, unknown> | null;
    error?: string;
    messages: Array<{
        id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        createdAt: string;
        contextReads?: Array<{ toolName: string; status: 'completed' | 'failed'; message?: string }>;
        contextDiagnostics?: Record<string, unknown>;
        attachmentIds?: string[];
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
    suggestedGoal: string | null;
    planJson: string | null;
    runJson: string | null;
    contextSummaryJson: string | null;
    error: string | null;
};

type AgentMessageRow = Omit<AgentConversationRecord['messages'][number], 'contextReads' | 'contextDiagnostics'> & {
    conversationId: string;
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
    cancelRequested: number | boolean | null;
    pendingApprovalJson: string | null;
    approvalResponsesJson: string | null;
    planJson: string | null;
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

function parseJsonField(value: string | null): unknown {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function mapAgentRun(row: AgentRunRow, events: AgentRunEventRow[], artifacts: AgentArtifactRow[]): AgentRunRecord {
    return {
        runId: row.runId,
        threadId: row.threadId,
        planId: row.planId,
        status: row.status,
        currentStepId: row.currentStepId,
        progress: Number(row.progress || 0),
        draftSessionId: row.draftSessionId,
        cancelRequested: Boolean(row.cancelRequested),
        pendingApproval: (parseJsonField(row.pendingApprovalJson) || null) as Record<string, unknown> | null,
        approvalResponses: (parseJsonField(row.approvalResponsesJson) || []) as Array<Record<string, unknown>>,
        planSnapshot: parseJsonField(row.planJson) || undefined,
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
            reviewedAt: artifact.reviewedAt,
            createdAt: artifact.createdAt,
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
            createdAt: event.createdAt,
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

export class AgentConversationStore {
    private readonly db: PrismaClientType;
    private readonly writeQueues = new Map<string, Promise<void>>();
    private legacyStepMessagesCleaned = false;

    constructor(db: PrismaClientType) {
        this.db = db;
    }

    async ensureSchema(): Promise<void> {
        await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentConversation (
                id TEXT PRIMARY KEY, novelId TEXT NOT NULL, title TEXT NOT NULL,
                description TEXT, role TEXT NOT NULL, runtimeConversationId TEXT,
                suggestedGoal TEXT, planJson TEXT, runJson TEXT, contextSummaryJson TEXT, error TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `);
        const conversationColumns = await this.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(AgentConversation)');
        if (!conversationColumns.some((column) => column.name === 'contextSummaryJson')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentConversation ADD COLUMN contextSummaryJson TEXT');
        }
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_conversation_novel_updated ON AgentConversation(novelId, updatedAt)');
        await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentMessage (
                id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, metadataJson TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE
            )
        `);
        const messageColumns = await this.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(AgentMessage)');
        if (!messageColumns.some((column) => column.name === 'metadataJson')) {
            await this.db.$executeRawUnsafe('ALTER TABLE AgentMessage ADD COLUMN metadataJson TEXT');
        }
        await this.db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_message_conversation_created ON AgentMessage(conversationId, createdAt)');
        await this.db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentRun (
                runId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, novelId TEXT NOT NULL,
                threadId TEXT NOT NULL, planId TEXT NOT NULL, status TEXT NOT NULL,
                currentStepId TEXT, progress REAL NOT NULL DEFAULT 0, draftSessionId TEXT,
                cancelRequested INTEGER NOT NULL DEFAULT 0, pendingApprovalJson TEXT,
                approvalResponsesJson TEXT, planJson TEXT,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversationId) REFERENCES AgentConversation(id) ON DELETE CASCADE,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `);
        const columns = await this.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(AgentRun)');
        const names = new Set(columns.map((column) => column.name));
        if (!names.has('pendingApprovalJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN pendingApprovalJson TEXT');
        if (!names.has('approvalResponsesJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN approvalResponsesJson TEXT');
        if (!names.has('planJson')) await this.db.$executeRawUnsafe('ALTER TABLE AgentRun ADD COLUMN planJson TEXT');
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
                   updatedAt, suggestedGoal, planJson, runJson, contextSummaryJson, error
            FROM AgentConversation WHERE novelId = ? ORDER BY datetime(updatedAt) DESC
        `, novelId);
        const conversations: AgentConversationRecord[] = [];
        for (const row of rows) {
            const messages = await this.db.$queryRawUnsafe<AgentMessageRow[]>(`
                SELECT id, conversationId, role, content, metadataJson, createdAt FROM AgentMessage
                WHERE conversationId = ? ORDER BY datetime(createdAt) ASC
            `, row.id);
            const runRows = await this.db.$queryRawUnsafe<AgentRunRow[]>(`
                SELECT runId, conversationId, novelId, threadId, planId, status,
                       currentStepId, progress, draftSessionId, cancelRequested,
                       pendingApprovalJson, approvalResponsesJson, planJson
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
                updatedAt: row.updatedAt,
                suggestedGoal: row.suggestedGoal,
                plan: parseJsonField(row.planJson),
                run: currentRun,
                runs,
                contextSummary: (parseJsonField(row.contextSummaryJson) || null) as Record<string, unknown> | null,
                error: row.error || '',
                messages: visibleMessages.map(({ id, role, content, metadataJson, createdAt }) => {
                    const metadata = parseJsonField(metadataJson);
                    const record = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
                    return {
                        id,
                        role,
                        content,
                        createdAt,
                        ...(Array.isArray(record.contextReads) ? { contextReads: record.contextReads as AgentConversationRecord['messages'][number]['contextReads'] } : {}),
                        ...(record.contextDiagnostics && typeof record.contextDiagnostics === 'object'
                            ? { contextDiagnostics: record.contextDiagnostics as Record<string, unknown> }
                            : {}),
                        ...(Array.isArray(record.attachmentIds)
                            ? { attachmentIds: record.attachmentIds.filter((id): id is string => typeof id === 'string') }
                            : {}),
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
                    suggestedGoal, planJson, runJson, contextSummaryJson, error, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    novelId = excluded.novelId, title = excluded.title,
                    description = excluded.description, role = excluded.role,
                    runtimeConversationId = excluded.runtimeConversationId,
                    suggestedGoal = excluded.suggestedGoal, planJson = excluded.planJson,
                    runJson = excluded.runJson, contextSummaryJson = excluded.contextSummaryJson,
                    error = excluded.error, updatedAt = excluded.updatedAt
            `, conversation.id, conversation.novelId, conversation.title, conversation.description || '',
            conversation.role, conversation.runtimeConversationId || null, conversation.suggestedGoal || null,
            conversation.plan ? JSON.stringify(conversation.plan) : null,
            JSON.stringify({ runId: (conversation.run as AgentRunRecord | null | undefined)?.runId ?? null }),
            conversation.contextSummary ? JSON.stringify(conversation.contextSummary) : null,
            conversation.error || '', now, updatedAt);
            await this.db.$executeRawUnsafe('DELETE FROM AgentMessage WHERE conversationId = ?', conversation.id);
            for (const message of conversation.messages || []) {
                const metadata = {
                    ...(message.contextReads?.length ? { contextReads: message.contextReads } : {}),
                    ...(message.contextDiagnostics ? { contextDiagnostics: message.contextDiagnostics } : {}),
                    ...(message.attachmentIds?.length ? { attachmentIds: message.attachmentIds } : {}),
                };
                await this.db.$executeRawUnsafe(`
                    INSERT INTO AgentMessage (id, conversationId, role, content, metadataJson, createdAt) VALUES (?, ?, ?, ?, ?, ?)
                `, message.id, conversation.id, message.role, message.content,
                Object.keys(metadata).length ? JSON.stringify(metadata) : null, message.createdAt || now);
            }
            const run = conversation.run as AgentRunRecord | null | undefined;
            if (run?.runId) {
                await this.db.$executeRawUnsafe(`
                    INSERT INTO AgentRun (
                        runId, conversationId, novelId, threadId, planId, status,
                        currentStepId, progress, draftSessionId, cancelRequested,
                        pendingApprovalJson, approvalResponsesJson, planJson, createdAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(runId) DO UPDATE SET
                        conversationId = excluded.conversationId, novelId = excluded.novelId,
                        threadId = excluded.threadId, planId = excluded.planId, status = excluded.status,
                        currentStepId = excluded.currentStepId, progress = excluded.progress,
                        draftSessionId = excluded.draftSessionId, cancelRequested = excluded.cancelRequested,
                        pendingApprovalJson = excluded.pendingApprovalJson,
                        approvalResponsesJson = excluded.approvalResponsesJson,
                        planJson = excluded.planJson, updatedAt = excluded.updatedAt
                `, run.runId, conversation.id, conversation.novelId, run.threadId, run.planId, run.status,
                run.currentStepId || null, Number(run.progress || 0), run.draftSessionId || null,
                run.cancelRequested ? 1 : 0, run.pendingApproval ? JSON.stringify(run.pendingApproval) : null,
                JSON.stringify(run.approvalResponses || []),
                run.planSnapshot ? JSON.stringify(run.planSnapshot) : null, now, updatedAt);
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
        const next = previous.catch(() => undefined).then(task);
        const settled = next.then(() => undefined, () => undefined);
        this.writeQueues.set(conversationId, settled);
        try {
            return await next;
        } finally {
            if (this.writeQueues.get(conversationId) === settled) this.writeQueues.delete(conversationId);
        }
    }
}
