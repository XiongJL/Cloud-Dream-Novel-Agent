import { createHash, randomUUID } from 'node:crypto';
import { db, type PrismaClientType } from '@novel-editor/core';
import type {
    AgentArtifactReviewRecord,
    AgentRevisionTask,
    AgentRevisionTaskEntryReason,
    AgentRevisionTaskStatus,
    ArtifactReviewSubmitInput,
    ArtifactReviewSubmitResult,
    ExpertFinding,
    ExpertReportPayload,
    FindingDecision,
    RevisionTaskListFilters,
    RevisionTaskSyncRunInput,
    RevisionTaskSyncRunResult,
    RevisionTaskUpdateStatusInput,
} from '../../shared/expertReport';
import { normalizeExpertReportFindingIds } from '../../shared/expertReport';
import type { AgentChapterSnapshot } from '../../shared/agentChapterScope';

type ArtifactReviewRow = {
    artifactId: string;
    novelId: string;
    conversationId: string;
    runId: string;
    metadataJson: string | null;
    referenceJson: string | null;
    reviewStatus: AgentArtifactReviewRecord['reviewStatus'];
    reviewRevision: number;
    reviewDecisionsJson: string | null;
    reviewStaleChapterIdsJson: string | null;
    reviewedAt: string | null;
};

type RevisionTaskRow = {
    revisionTaskId: string;
    novelId: string;
    sourceArtifactId: string;
    sourceFindingId: string;
    title: string;
    description: string;
    targetChapterIdsJson: string;
    sourceExpert: AgentRevisionTask['sourceExpert'];
    severity: AgentRevisionTask['severity'];
    recommendedRole: AgentRevisionTask['recommendedRole'];
    status: AgentRevisionTaskStatus;
    sourceSnapshotJson: string;
    note: string | null;
    planId: string | null;
    planJson: string | null;
    sourceConversationId: string | null;
    sourceRunId: string | null;
    entryReason: AgentRevisionTaskEntryReason | null;
    createdAt: string | Date;
    updatedAt: string | Date;
};

type ChapterSnapshotRow = {
    chapterId: string;
    version: number;
    content: string;
};

function reviewError(code: string, message: string, details?: unknown): Error & { code: string; details?: unknown } {
    return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

function parseJson<T>(value: string | null, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function hashContent(content: string): string {
    return createHash('sha256').update(content || '', 'utf8').digest('hex');
}

function formatTimestamp(value: string | Date): string {
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function mapTask(row: RevisionTaskRow): AgentRevisionTask {
    return {
        revisionTaskId: row.revisionTaskId,
        novelId: row.novelId,
        sourceArtifactId: row.sourceArtifactId,
        sourceFindingId: row.sourceFindingId,
        title: row.title,
        description: row.description,
        targetChapterIds: parseJson<string[]>(row.targetChapterIdsJson, []),
        sourceExpert: row.sourceExpert,
        severity: row.severity,
        recommendedRole: row.recommendedRole,
        status: row.status,
        sourceSnapshot: parseJson<AgentChapterSnapshot[]>(row.sourceSnapshotJson, []),
        ...(row.note ? { note: row.note } : {}),
        ...(row.planId ? { planId: row.planId } : {}),
        ...(row.planJson ? { plan: parseJson<Record<string, unknown>>(row.planJson, {}) } : {}),
        ...(row.sourceConversationId ? { sourceConversationId: row.sourceConversationId } : {}),
        ...(row.sourceRunId ? { sourceRunId: row.sourceRunId } : {}),
        entryReason: row.entryReason || 'legacy',
        createdAt: formatTimestamp(row.createdAt),
        updatedAt: formatTimestamp(row.updatedAt),
    };
}

function extractExpertReport(row: ArtifactReviewRow): ExpertReportPayload {
    const metadata = parseJson<Record<string, unknown>>(row.metadataJson, {});
    const reference = parseJson<Record<string, unknown>>(row.referenceJson, {});
    const candidate = metadata.expertReport ?? reference.expertReport ?? metadata.report ?? reference.report ?? metadata;
    if (!candidate || typeof candidate !== 'object') {
        throw reviewError('INVALID_REPORT', 'Artifact does not contain an expert report payload');
    }
    const report = candidate as Partial<ExpertReportPayload>;
    if (!Array.isArray(report.findings) || !Array.isArray(report.sourceSnapshot)) {
        throw reviewError('INVALID_REPORT', 'Expert report findings and sourceSnapshot are required');
    }
    const normalizedReport = normalizeExpertReportFindingIds(report as ExpertReportPayload);
    const findingIds = new Set<string>();
    for (const finding of normalizedReport.findings) {
        const id = typeof finding?.findingId === 'string' ? finding.findingId.trim() : '';
        if (!id || findingIds.has(id)) {
            throw reviewError('INVALID_REPORT', 'Expert report findingId values must be non-empty and unique');
        }
        findingIds.add(id);
    }
    return {
        ...normalizedReport,
        artifactId: report.artifactId || row.artifactId,
        novelId: report.novelId || row.novelId,
    } as ExpertReportPayload;
}

export class AgentReviewStore {
    private schemaReady: Promise<void> | null = null;

    constructor(private readonly client: PrismaClientType = db) {}

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
        const artifactColumns = await this.client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(AgentArtifact)');
        if (!artifactColumns.length) {
            throw reviewError('ARTIFACT_STORE_UNAVAILABLE', 'AgentArtifact store has not been initialized');
        }
        const names = new Set(artifactColumns.map((column) => column.name));
        if (!names.has('reviewStatus')) {
            await this.client.$executeRawUnsafe("ALTER TABLE AgentArtifact ADD COLUMN reviewStatus TEXT NOT NULL DEFAULT 'unreviewed'");
        }
        if (!names.has('reviewRevision')) {
            await this.client.$executeRawUnsafe('ALTER TABLE AgentArtifact ADD COLUMN reviewRevision INTEGER NOT NULL DEFAULT 0');
        }
        if (!names.has('reviewDecisionsJson')) {
            await this.client.$executeRawUnsafe('ALTER TABLE AgentArtifact ADD COLUMN reviewDecisionsJson TEXT');
        }
        if (!names.has('reviewStaleChapterIdsJson')) {
            await this.client.$executeRawUnsafe('ALTER TABLE AgentArtifact ADD COLUMN reviewStaleChapterIdsJson TEXT');
        }
        if (!names.has('reviewedAt')) {
            await this.client.$executeRawUnsafe('ALTER TABLE AgentArtifact ADD COLUMN reviewedAt DATETIME');
        }
        await this.client.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS AgentRevisionTask (
                revisionTaskId TEXT PRIMARY KEY,
                novelId TEXT NOT NULL,
                sourceArtifactId TEXT NOT NULL,
                sourceFindingId TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                targetChapterIdsJson TEXT NOT NULL,
                sourceExpert TEXT NOT NULL,
                severity TEXT NOT NULL,
                recommendedRole TEXT NOT NULL,
                status TEXT NOT NULL,
                sourceSnapshotJson TEXT NOT NULL,
                note TEXT,
                planId TEXT,
                planJson TEXT,
                sourceConversationId TEXT,
                sourceRunId TEXT,
                entryReason TEXT NOT NULL DEFAULT 'legacy',
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(sourceArtifactId, sourceFindingId),
                FOREIGN KEY (sourceArtifactId) REFERENCES AgentArtifact(artifactId) ON DELETE CASCADE,
                FOREIGN KEY (novelId) REFERENCES Novel(id) ON DELETE CASCADE
            )
        `);
        const revisionTaskColumns = await this.client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(AgentRevisionTask)');
        const revisionTaskColumnNames = new Set(revisionTaskColumns.map((column) => column.name));
        if (!revisionTaskColumnNames.has('sourceConversationId')) {
            await this.client.$executeRawUnsafe('ALTER TABLE AgentRevisionTask ADD COLUMN sourceConversationId TEXT');
        }
        if (!revisionTaskColumnNames.has('sourceRunId')) {
            await this.client.$executeRawUnsafe('ALTER TABLE AgentRevisionTask ADD COLUMN sourceRunId TEXT');
        }
        if (!revisionTaskColumnNames.has('entryReason')) {
            await this.client.$executeRawUnsafe("ALTER TABLE AgentRevisionTask ADD COLUMN entryReason TEXT NOT NULL DEFAULT 'legacy'");
        }
        await this.client.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_revision_task_novel_status ON AgentRevisionTask(novelId, status, updatedAt)');
        await this.client.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_agent_revision_task_artifact ON AgentRevisionTask(sourceArtifactId, sourceFindingId)');
    }

    private async findStaleChapterIds(
        client: Pick<PrismaClientType, '$queryRawUnsafe'>,
        novelId: string,
        snapshots: AgentChapterSnapshot[],
    ): Promise<string[]> {
        if (!snapshots.length) return [];
        const ids = [...new Set(snapshots.map((snapshot) => snapshot.chapterId).filter(Boolean))];
        const placeholders = ids.map(() => '?').join(', ');
        const rows = await client.$queryRawUnsafe<ChapterSnapshotRow[]>(`
            SELECT c.id AS chapterId, c.version AS version, c.content AS content
            FROM Chapter c
            INNER JOIN Volume v ON v.id = c.volumeId
            WHERE v.novelId = ? AND c.deleted = 0 AND c.id IN (${placeholders})
        `, novelId, ...ids);
        const currentById = new Map(rows.map((row) => [row.chapterId, row]));
        return snapshots.flatMap((snapshot) => {
            const current = currentById.get(snapshot.chapterId);
            if (!current || Number(current.version) !== Number(snapshot.version) || hashContent(current.content) !== snapshot.contentHash) {
                return [snapshot.chapterId];
            }
            return [];
        });
    }

    async submitArtifactReview(input: ArtifactReviewSubmitInput): Promise<ArtifactReviewSubmitResult> {
        await this.ensureSchema();
        if (!input?.artifactId?.trim()) throw reviewError('INVALID_INPUT', 'artifactId is required');
        if (!Number.isInteger(input.expectedReviewRevision) || input.expectedReviewRevision < 0) {
            throw reviewError('INVALID_INPUT', 'expectedReviewRevision must be a non-negative integer');
        }
        if (!Array.isArray(input.decisions) || input.decisions.length === 0) {
            throw reviewError('INVALID_INPUT', 'decisions is required');
        }

        return this.client.$transaction(async (tx) => {
            const rows = await tx.$queryRawUnsafe<ArtifactReviewRow[]>(`
                SELECT artifactId, novelId, conversationId, runId, metadataJson, referenceJson, reviewStatus, reviewRevision,
                       reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt
                FROM AgentArtifact WHERE artifactId = ?
            `, input.artifactId);
            const artifact = rows[0];
            if (!artifact) throw reviewError('NOT_FOUND', `Artifact not found: ${input.artifactId}`);
            if (Number(artifact.reviewRevision) !== input.expectedReviewRevision) {
                throw reviewError('VERSION_CONFLICT', 'Artifact review was changed by another operation', {
                    expectedReviewRevision: input.expectedReviewRevision,
                    actualReviewRevision: Number(artifact.reviewRevision),
                });
            }

            const report = extractExpertReport(artifact);
            const findingById = new Map(report.findings.map((finding) => [finding.findingId, finding]));
            const incomingById = new Map<string, FindingDecision>();
            for (const decision of input.decisions) {
                if (!findingById.has(decision.findingId)) {
                    throw reviewError('INVALID_INPUT', `Unknown findingId: ${decision.findingId}`);
                }
                if (!['accepted', 'rejected', 'deferred'].includes(decision.status)) {
                    throw reviewError('INVALID_INPUT', `Unsupported finding decision: ${String(decision.status)}`);
                }
                if (incomingById.has(decision.findingId)) {
                    throw reviewError('INVALID_INPUT', `Duplicate finding decision: ${decision.findingId}`);
                }
                incomingById.set(decision.findingId, decision);
            }

            const previous = parseJson<FindingDecision[]>(artifact.reviewDecisionsJson, []);
            const merged = new Map(previous.map((decision) => [decision.findingId, decision]));
            for (const decision of incomingById.values()) merged.set(decision.findingId, decision);
            const decisions = report.findings.flatMap((finding) => {
                const decision = merged.get(finding.findingId);
                return decision ? [decision] : [];
            });
            const staleChapterIds = await this.findStaleChapterIds(tx as unknown as PrismaClientType, artifact.novelId, report.sourceSnapshot);
            const reviewStatus: AgentArtifactReviewRecord['reviewStatus'] = staleChapterIds.length
                ? 'stale'
                : decisions.length === report.findings.length
                    ? 'reviewed'
                    : 'in_review';
            const reviewRevision = Number(artifact.reviewRevision) + 1;
            const reviewedAt = new Date().toISOString();

            await tx.$executeRawUnsafe(`
                UPDATE AgentArtifact
                SET reviewStatus = ?, reviewRevision = ?, reviewDecisionsJson = ?,
                    reviewStaleChapterIdsJson = ?, reviewedAt = ?, updatedAt = ?
                WHERE artifactId = ?
            `, reviewStatus, reviewRevision, JSON.stringify(decisions), JSON.stringify(staleChapterIds),
            reviewedAt, reviewedAt, artifact.artifactId);

            const upsertRevisionTask = async (
                finding: ExpertFinding,
                decision: FindingDecision,
                taskStatus: AgentRevisionTaskStatus,
            ) => {
                await tx.$executeRawUnsafe(`
                        INSERT INTO AgentRevisionTask (
                            revisionTaskId, novelId, sourceArtifactId, sourceFindingId, title, description,
                            targetChapterIdsJson, sourceExpert, severity, recommendedRole, status,
                            sourceSnapshotJson, note, sourceConversationId, sourceRunId, entryReason, createdAt, updatedAt
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(sourceArtifactId, sourceFindingId) DO UPDATE SET
                            title = excluded.title, description = excluded.description,
                            targetChapterIdsJson = excluded.targetChapterIdsJson,
                            sourceExpert = excluded.sourceExpert, severity = excluded.severity,
                            recommendedRole = excluded.recommendedRole,
                            status = CASE
                                WHEN AgentRevisionTask.status IN ('planned', 'resolved') THEN AgentRevisionTask.status
                                ELSE excluded.status
                            END,
                            sourceSnapshotJson = excluded.sourceSnapshotJson,
                            note = excluded.note,
                            sourceConversationId = excluded.sourceConversationId,
                            sourceRunId = excluded.sourceRunId,
                            entryReason = excluded.entryReason,
                            updatedAt = excluded.updatedAt
                `, `revision_${randomUUID().replace(/-/g, '')}`, artifact.novelId, artifact.artifactId,
                    finding.findingId, finding.title, finding.recommendation || finding.summary,
                    JSON.stringify(finding.chapterIds || []), finding.expert || report.expert,
                    finding.severity, finding.recommendedRole || 'editor', taskStatus,
                    JSON.stringify(report.sourceSnapshot), decision.note || null, artifact.conversationId, artifact.runId,
                    decision.status === 'deferred' ? 'deferred' : 'accepted', reviewedAt, reviewedAt);
            };

            for (const decision of incomingById.values()) {
                const finding = findingById.get(decision.findingId) as ExpertFinding;
                if (decision.status === 'accepted' && input.createRevisionTasks !== false) {
                    const taskStatus: AgentRevisionTaskStatus = staleChapterIds.length ? 'stale' : 'open';
                    await upsertRevisionTask(finding, decision, taskStatus);
                } else if (decision.status === 'deferred') {
                    const taskStatus: AgentRevisionTaskStatus = staleChapterIds.length ? 'stale' : 'deferred';
                    await upsertRevisionTask(finding, decision, taskStatus);
                } else {
                    await tx.$executeRawUnsafe(`
                        UPDATE AgentRevisionTask SET status = ?, note = ?, updatedAt = ?
                        WHERE sourceArtifactId = ? AND sourceFindingId = ? AND status != 'resolved'
                    `, 'closed', decision.note || null, reviewedAt, artifact.artifactId, finding.findingId);
                }
            }

            const taskRows = await tx.$queryRawUnsafe<RevisionTaskRow[]>(`
                SELECT * FROM AgentRevisionTask WHERE sourceArtifactId = ? ORDER BY datetime(createdAt) ASC
            `, artifact.artifactId);
            return {
                review: {
                    artifactId: artifact.artifactId,
                    reviewStatus,
                    reviewRevision,
                    decisions,
                    staleChapterIds,
                    reviewedAt,
                },
                revisionTasks: taskRows.map(mapTask),
            };
        });
    }

    async listRevisionTasks(filters: RevisionTaskListFilters): Promise<AgentRevisionTask[]> {
        await this.ensureSchema();
        if (!filters?.novelId?.trim()) throw reviewError('INVALID_INPUT', 'novelId is required');
        const clauses = ['task.novelId = ?'];
        const values: unknown[] = [filters.novelId];
        if (filters.expert) {
            clauses.push('task.sourceExpert = ?');
            values.push(filters.expert);
        }
        if (filters.severity) {
            clauses.push('task.severity = ?');
            values.push(filters.severity);
        }
        if (filters.status) {
            clauses.push('task.status = ?');
            values.push(filters.status);
        }
        if (filters.chapterId) {
            clauses.push('EXISTS (SELECT 1 FROM json_each(task.targetChapterIdsJson) WHERE json_each.value = ?)');
            values.push(filters.chapterId);
        }
        const rows = await this.client.$queryRawUnsafe<RevisionTaskRow[]>(`
            SELECT task.*,
                   COALESCE(task.sourceConversationId, artifact.conversationId) AS sourceConversationId,
                   COALESCE(task.sourceRunId, artifact.runId) AS sourceRunId
            FROM AgentRevisionTask task
            LEFT JOIN AgentArtifact artifact ON artifact.artifactId = task.sourceArtifactId
            WHERE ${clauses.join(' AND ')}
            ORDER BY CASE task.severity
                WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                WHEN 'low' THEN 3 ELSE 4 END, datetime(task.updatedAt) DESC
        `, ...values);
        return rows.map(mapTask);
    }

    async getRevisionTask(revisionTaskId: string): Promise<AgentRevisionTask> {
        await this.ensureSchema();
        const rows = await this.client.$queryRawUnsafe<RevisionTaskRow[]>(
            `SELECT task.*,
                    COALESCE(task.sourceConversationId, artifact.conversationId) AS sourceConversationId,
                    COALESCE(task.sourceRunId, artifact.runId) AS sourceRunId
             FROM AgentRevisionTask task
             LEFT JOIN AgentArtifact artifact ON artifact.artifactId = task.sourceArtifactId
             WHERE task.revisionTaskId = ?`, revisionTaskId,
        );
        if (!rows[0]) throw reviewError('NOT_FOUND', `Revision task not found: ${revisionTaskId}`);
        return mapTask(rows[0]);
    }

    async updateRevisionTaskStatus(input: RevisionTaskUpdateStatusInput): Promise<AgentRevisionTask> {
        await this.ensureSchema();
        const revisionTaskId = String(input?.revisionTaskId || '').trim();
        const expectedUpdatedAt = String(input?.expectedUpdatedAt || '').trim();
        if (!revisionTaskId) throw reviewError('INVALID_INPUT', 'revisionTaskId is required');
        if (!expectedUpdatedAt) throw reviewError('INVALID_INPUT', 'expectedUpdatedAt is required');
        const rows = await this.client.$queryRawUnsafe<RevisionTaskRow[]>(
            'SELECT * FROM AgentRevisionTask WHERE revisionTaskId = ?', revisionTaskId,
        );
        const row = rows[0];
        if (!row) throw reviewError('NOT_FOUND', `Revision task not found: ${revisionTaskId}`);
        const current = mapTask(row);
        if (current.updatedAt !== expectedUpdatedAt) {
            throw reviewError('VERSION_CONFLICT', 'Revision task changed since it was loaded');
        }
        if (current.status === input.status) return current;
        const transitions: Record<AgentRevisionTaskStatus, AgentRevisionTaskStatus[]> = {
            open: ['deferred', 'closed'],
            planned: ['resolved', 'closed'],
            deferred: ['open', 'closed'],
            resolved: ['closed'],
            closed: [],
            stale: ['closed'],
        };
        if (!transitions[current.status].includes(input.status)) {
            throw reviewError('INVALID_TASK_STATUS', `Revision task cannot change from ${current.status} to ${input.status}`);
        }
        const currentTime = new Date(current.updatedAt).getTime();
        const updatedAt = new Date(Math.max(Date.now(), currentTime + 1)).toISOString();
        const changed = await this.client.$executeRawUnsafe(
            `UPDATE AgentRevisionTask SET status = ?, updatedAt = ?
             WHERE revisionTaskId = ?
               AND strftime('%Y-%m-%dT%H:%M:%fZ', updatedAt) = ?`,
            input.status,
            updatedAt,
            revisionTaskId,
            expectedUpdatedAt,
        );
        if (!changed) throw reviewError('VERSION_CONFLICT', 'Revision task changed since it was loaded');
        return this.getRevisionTask(revisionTaskId);
    }

    async assertRevisionTaskFresh(task: AgentRevisionTask): Promise<void> {
        await this.ensureSchema();
        const staleChapterIds = await this.findStaleChapterIds(this.client, task.novelId, task.sourceSnapshot);
        if (!staleChapterIds.length) return;
        const now = new Date().toISOString();
        await this.client.$transaction([
            this.client.$executeRawUnsafe(
                "UPDATE AgentRevisionTask SET status = 'stale', updatedAt = ? WHERE revisionTaskId = ?",
                now, task.revisionTaskId,
            ),
            this.client.$executeRawUnsafe(
                "UPDATE AgentArtifact SET reviewStatus = 'stale', reviewStaleChapterIdsJson = ?, updatedAt = ? WHERE artifactId = ?",
                JSON.stringify(staleChapterIds), now, task.sourceArtifactId,
            ),
        ]);
        throw reviewError('REPORT_STALE', 'Source chapters changed after the report was generated', { staleChapterIds });
    }

    async attachPlan(revisionTaskId: string, plan: Record<string, unknown> & { planId: string }): Promise<AgentRevisionTask> {
        await this.ensureSchema();
        const now = new Date().toISOString();
        const changed = await this.client.$executeRawUnsafe(`
            UPDATE AgentRevisionTask SET status = 'planned', planId = ?, planJson = ?, updatedAt = ?
            WHERE revisionTaskId = ? AND status = 'open'
        `, plan.planId, JSON.stringify(plan), now, revisionTaskId);
        if (!changed) {
            const current = await this.getRevisionTask(revisionTaskId);
            throw reviewError('INVALID_TASK_STATUS', `Revision task cannot create a plan from status ${current.status}`);
        }
        return this.getRevisionTask(revisionTaskId);
    }

    async syncRevisionTasksFromRun(input: RevisionTaskSyncRunInput): Promise<RevisionTaskSyncRunResult> {
        await this.ensureSchema();
        const novelId = String(input?.novelId || '').trim();
        const sourceArtifactId = String(input?.sourceArtifactId || '').trim();
        const sourceConversationId = String(input?.sourceConversationId || '').trim();
        const sourceRunId = String(input?.sourceRunId || '').trim();
        const findingIds = [...new Set((input?.findingIds ?? []).map((id) => String(id || '').trim()).filter(Boolean))];
        const completedFindingIds = new Set((input?.completedFindingIds ?? []).map((id) => String(id || '').trim()).filter(Boolean));
        if (!novelId || !sourceArtifactId || !sourceConversationId || !findingIds.length) {
            throw reviewError('INVALID_INPUT', 'novelId, sourceArtifactId, sourceConversationId and findingIds are required');
        }
        if (!['completed', 'committed', 'failed', 'cancelled', 'interrupted'].includes(input.outcome)) {
            throw reviewError('INVALID_INPUT', `Unsupported revision run outcome: ${String(input.outcome)}`);
        }

        const artifactRows = await this.client.$queryRawUnsafe<ArtifactReviewRow[]>(`
            SELECT artifactId, novelId, conversationId, runId, metadataJson, referenceJson, reviewStatus, reviewRevision,
                   reviewDecisionsJson, reviewStaleChapterIdsJson, reviewedAt
            FROM AgentArtifact WHERE artifactId = ? AND novelId = ?
        `, sourceArtifactId, novelId);
        const artifact = artifactRows[0];
        if (!artifact) throw reviewError('NOT_FOUND', `Artifact not found: ${sourceArtifactId}`);
        const report = extractExpertReport(artifact);
        const findingById = new Map(report.findings.map((finding) => [finding.findingId, finding]));
        for (const findingId of findingIds) {
            if (!findingById.has(findingId)) throw reviewError('INVALID_INPUT', `Unknown findingId: ${findingId}`);
        }

        const now = new Date().toISOString();
        const placeholders = findingIds.map(() => '?').join(', ');
        if (input.outcome === 'completed') {
            await this.client.$executeRawUnsafe(`
                UPDATE AgentRevisionTask
                SET status = 'planned', sourceConversationId = ?, sourceRunId = ?, updatedAt = ?
                WHERE sourceArtifactId = ? AND sourceFindingId IN (${placeholders})
                  AND status NOT IN ('resolved', 'stale')
            `, sourceConversationId, sourceRunId || null, now, sourceArtifactId, ...findingIds);
        } else if (input.outcome === 'committed') {
            await this.client.$executeRawUnsafe(`
                UPDATE AgentRevisionTask
                SET status = 'resolved', sourceConversationId = ?, sourceRunId = ?, updatedAt = ?
                WHERE sourceArtifactId = ? AND sourceFindingId IN (${placeholders})
                  AND status NOT IN ('resolved', 'stale')
            `, sourceConversationId, sourceRunId || null, now, sourceArtifactId, ...findingIds);
        } else {
            const pendingFindingIds = findingIds.filter((findingId) => !completedFindingIds.has(findingId));
            const staleChapterIds = await this.findStaleChapterIds(this.client, novelId, report.sourceSnapshot);
            for (const findingId of pendingFindingIds) {
                const finding = findingById.get(findingId) as ExpertFinding;
                const status: AgentRevisionTaskStatus = staleChapterIds.length ? 'stale' : 'open';
                await this.client.$executeRawUnsafe(`
                    INSERT INTO AgentRevisionTask (
                        revisionTaskId, novelId, sourceArtifactId, sourceFindingId, title, description,
                        targetChapterIdsJson, sourceExpert, severity, recommendedRole, status,
                        sourceSnapshotJson, sourceConversationId, sourceRunId, entryReason, createdAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(sourceArtifactId, sourceFindingId) DO UPDATE SET
                        title = excluded.title,
                        description = excluded.description,
                        targetChapterIdsJson = excluded.targetChapterIdsJson,
                        sourceExpert = excluded.sourceExpert,
                        severity = excluded.severity,
                        recommendedRole = excluded.recommendedRole,
                        status = CASE
                            WHEN AgentRevisionTask.status IN ('resolved', 'stale') THEN AgentRevisionTask.status
                            ELSE excluded.status
                        END,
                        sourceSnapshotJson = excluded.sourceSnapshotJson,
                        sourceConversationId = excluded.sourceConversationId,
                        sourceRunId = excluded.sourceRunId,
                        entryReason = excluded.entryReason,
                        planId = NULL,
                        planJson = NULL,
                        updatedAt = excluded.updatedAt
                `, `revision_${randomUUID().replace(/-/g, '')}`, novelId, sourceArtifactId, finding.findingId,
                finding.title, finding.recommendation || finding.summary, JSON.stringify(finding.chapterIds || []),
                finding.expert || report.expert, finding.severity, finding.recommendedRole || 'editor', status,
                JSON.stringify(report.sourceSnapshot), sourceConversationId, sourceRunId || null, input.outcome, now, now);
            }
        }

        const rows = await this.client.$queryRawUnsafe<RevisionTaskRow[]>(`
            SELECT task.*,
                   COALESCE(task.sourceConversationId, artifact.conversationId) AS sourceConversationId,
                   COALESCE(task.sourceRunId, artifact.runId) AS sourceRunId
            FROM AgentRevisionTask task
            LEFT JOIN AgentArtifact artifact ON artifact.artifactId = task.sourceArtifactId
            WHERE task.sourceArtifactId = ? AND task.sourceFindingId IN (${placeholders})
            ORDER BY datetime(task.updatedAt) DESC
        `, sourceArtifactId, ...findingIds);
        return { revisionTasks: rows.map(mapTask) };
    }
}
