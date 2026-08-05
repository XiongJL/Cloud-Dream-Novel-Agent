import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClientType } from '@novel-editor/core';
import type {
    ChapterBeat,
    ChapterBeatInput,
    DraftBatchCommittedChapter,
    DraftBatchCreateInput,
    DraftBatchInspectReconciliationInput,
    DraftBatchListFilters,
    DraftBatchMarkFailedInput,
    DraftBatchReconcileUnknownInput,
    DraftBatchReconciliationInspection,
    DraftBatchRecord,
    NarrativeStateDelta,
} from '../../shared/draftBatch';
import type { DraftWritebackRecord } from '../../shared/draftWriteback';
import type { DraftOperationRecord, DraftOperationResultRef } from '../../shared/draftOperation';
import type { DraftListFilters, DraftSessionRecord } from './types';

type DraftSessionFileShape = {
    sessions: DraftSessionRecord[];
    batches: DraftBatchRecord[];
};

const EMPTY_STORE: DraftSessionFileShape = {
    sessions: [],
    batches: [],
};

export type DraftSessionCreateInput = Omit<DraftSessionRecord, 'draftSessionId' | 'version' | 'createdAt' | 'updatedAt'>;

export type DraftBatchChildProgress = {
    title: string;
    coreConflict: string;
    keyEvents: string[];
    reveals: string[];
    endingHook: string;
    summary: string;
    stateDelta?: NarrativeStateDelta;
};

export type PreparedChapterDraft =
    | {
        kind: 'existing';
        result: DraftOperationResultRef;
    }
    | {
        kind: 'create';
        sessionInput: DraftSessionCreateInput;
        draftBatchId?: string;
        childIndex?: number;
        progress?: DraftBatchChildProgress;
        expectedGenerationRevision?: number;
    };

type DraftEntityTransaction = Pick<PrismaClientType, '$executeRawUnsafe' | '$queryRawUnsafe'>;

function createStoreError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

function normalizeBeat(input: ChapterBeatInput, childIndex: number): ChapterBeat {
    const title = String(input?.title ?? '').trim();
    const chapterGoal = String(input?.chapterGoal ?? '').trim();
    const coreConflict = String(input?.coreConflict ?? '').trim();
    const endingHook = String(input?.endingHook ?? '').trim();
    const targetWordCount = Number(input?.targetWordCount);
    if (!title || !chapterGoal || !coreConflict || !endingHook) {
        throw createStoreError('INVALID_INPUT', `Chapter beat ${childIndex + 1} is incomplete`);
    }
    if (!Number.isInteger(targetWordCount) || targetWordCount < 100 || targetWordCount > 50000) {
        throw createStoreError('INVALID_INPUT', `Chapter beat ${childIndex + 1} targetWordCount must be between 100 and 50000`);
    }
    return {
        beatId: randomUUID(),
        childIndex,
        title,
        chapterGoal,
        coreConflict,
        keyEvents: Array.isArray(input.keyEvents) ? input.keyEvents.map(String).map((item) => item.trim()).filter(Boolean) : [],
        reveals: Array.isArray(input.reveals) ? input.reveals.map(String).map((item) => item.trim()).filter(Boolean) : [],
        endingHook,
        targetWordCount,
    };
}

function normalizeBeats(beats: ChapterBeatInput[]): ChapterBeat[] {
    if (!Array.isArray(beats) || beats.length < 1 || beats.length > 5) {
        throw createStoreError('INVALID_INPUT', 'A chapter draft batch must contain between 1 and 5 beats');
    }
    return beats.map(normalizeBeat);
}

function createEmptyNarrativeStateLedger(): DraftBatchRecord['stateLedger'] {
    return {
        characterLocations: {},
        relationshipChanges: [],
        knowledgeState: {},
        foreshadowing: [],
        timeline: [],
        itemStates: {},
        unresolvedConflicts: [],
        stateDeltas: [],
    };
}

function advanceNarrativeStateLedger(
    ledger: DraftBatchRecord['stateLedger'],
    childIndex: number,
    draftSessionId: string,
    progress?: DraftBatchChildProgress,
    generationRevision = 1,
): DraftBatchRecord['stateLedger'] {
    if (!progress) return ledger;
    const conflict = progress.coreConflict.trim();
    const heuristicLedger: DraftBatchRecord['stateLedger'] = {
        ...ledger,
        timeline: [
            ...ledger.timeline,
            {
                childIndex,
                draftSessionId,
                title: progress.title,
                keyEvents: progress.keyEvents,
                reveals: progress.reveals,
                summary: progress.summary,
            },
        ],
        foreshadowing: [
            ...ledger.foreshadowing,
            ...(progress.endingHook.trim() ? [{ childIndex, hook: progress.endingHook.trim(), status: 'open' }] : []),
        ],
        unresolvedConflicts: conflict && !ledger.unresolvedConflicts.includes(conflict)
            ? [...ledger.unresolvedConflicts, conflict]
            : ledger.unresolvedConflicts,
        stateDeltas: ledger.stateDeltas ?? [],
    };
    return progress.stateDelta
        ? applyNarrativeStateDelta(heuristicLedger, progress.stateDelta, { childIndex, draftSessionId, generationRevision })
        : heuristicLedger;
}

function applyNarrativeStateDelta(
    ledger: DraftBatchRecord['stateLedger'],
    delta: NarrativeStateDelta,
    metadata: { childIndex: number; draftSessionId: string; generationRevision?: number },
): DraftBatchRecord['stateLedger'] {
    const characterLocations = { ...ledger.characterLocations };
    for (const item of delta.characterLocations) characterLocations[item.characterKey] = item.location;
    const knowledgeState = Object.fromEntries(
        Object.entries(ledger.knowledgeState).map(([key, values]) => [key, [...values]]),
    );
    for (const item of delta.knowledgeChanges) {
        const known = new Set(knowledgeState[item.characterKey] ?? []);
        for (const fact of item.forgotten) known.delete(fact);
        for (const fact of item.learned) known.add(fact);
        knowledgeState[item.characterKey] = [...known];
    }
    const itemStates = { ...ledger.itemStates };
    for (const item of delta.itemStates) itemStates[item.itemKey] = item.state;
    const resolved = new Set(delta.resolvedConflicts.map((item) => item.conflict));
    const unresolvedConflicts = ledger.unresolvedConflicts.filter((item) => !resolved.has(item));
    for (const item of delta.openedConflicts) {
        if (!unresolvedConflicts.includes(item.conflict)) unresolvedConflicts.push(item.conflict);
    }
    const stateDeltas = (ledger.stateDeltas ?? []).filter((item) => !(
        item.childIndex === metadata.childIndex
        && item.draftSessionId === metadata.draftSessionId
    ));
    stateDeltas.push({
        ...delta,
        childIndex: metadata.childIndex,
        generationRevision: metadata.generationRevision ?? 1,
        draftSessionId: metadata.draftSessionId,
    });
    return {
        ...ledger,
        characterLocations,
        relationshipChanges: [
            ...ledger.relationshipChanges.filter((item) => !(
                item.source === 'state_extraction'
                && item.childIndex === metadata.childIndex
                && item.draftSessionId === metadata.draftSessionId
            )),
            ...delta.relationshipChanges.map((item) => ({
                ...item,
                source: 'state_extraction',
                childIndex: metadata.childIndex,
                draftSessionId: metadata.draftSessionId,
                generationRevision: metadata.generationRevision ?? 1,
            })),
        ],
        knowledgeState,
        itemStates,
        unresolvedConflicts,
        stateDeltas,
    };
}

function rollbackNarrativeStateLedger(
    batch: DraftBatchRecord,
    fromChildIndex: number,
): DraftBatchRecord['stateLedger'] {
    const belongsToPreservedPrefix = (item: Record<string, unknown>): boolean => (
        typeof item.childIndex !== 'number' || item.childIndex < fromChildIndex
    );
    const preservedDeltas = (batch.stateLedger.stateDeltas ?? []).filter((item) => item.childIndex < fromChildIndex);
    let rebuilt: DraftBatchRecord['stateLedger'] = {
        ...batch.stateLedger,
        characterLocations: {},
        relationshipChanges: batch.stateLedger.relationshipChanges.filter((item) => (
            item.source !== 'state_extraction' && belongsToPreservedPrefix(item)
        )),
        knowledgeState: {},
        foreshadowing: batch.stateLedger.foreshadowing.filter(belongsToPreservedPrefix),
        timeline: batch.stateLedger.timeline.filter(belongsToPreservedPrefix),
        itemStates: {},
        unresolvedConflicts: batch.outline.beats
            .filter((beat) => beat.childIndex < fromChildIndex)
            .map((beat) => beat.coreConflict.trim())
            .filter(Boolean),
        stateDeltas: [],
    };
    for (const delta of preservedDeltas) {
        rebuilt = applyNarrativeStateDelta(rebuilt, delta, {
            childIndex: delta.childIndex,
            draftSessionId: delta.draftSessionId,
            generationRevision: delta.generationRevision,
        });
    }
    return rebuilt;
}

export class DraftSessionStore {
    private readonly database: PrismaClientType;
    private cache: DraftSessionFileShape | null = null;
    private sqliteSchemaReady: Promise<void> | null = null;

    constructor(database: PrismaClientType) {
        this.database = database;
    }

    private async ensureLoaded(): Promise<void> {
        if (this.cache) return;
        await this.ensureSqliteSchema();
        const [sessionRows, batchRows, childRows] = await this.database.$transaction(async (tx) => {
            const sessions = await tx.$queryRawUnsafe<Array<{ payloadJson: string }>>(
                'SELECT "payloadJson" FROM "DraftSession" ORDER BY "updatedAt" DESC',
            );
            const batches = await tx.$queryRawUnsafe<Array<{ draftBatchId: string; payloadJson: string }>>(
                'SELECT "draftBatchId", "payloadJson" FROM "DraftBatch" ORDER BY "updatedAt" DESC',
            );
            const children = await tx.$queryRawUnsafe<Array<{
                draftBatchId: string;
                childIndex: number;
                payloadJson: string;
            }>>(
                'SELECT "draftBatchId", "childIndex", "payloadJson" FROM "DraftBatchChild" ORDER BY "draftBatchId", "childIndex"',
            );
            return [sessions, batches, children] as const;
        });
        const childrenByBatch = new Map<string, DraftBatchRecord['children']>();
        for (const row of childRows) {
            const children = childrenByBatch.get(row.draftBatchId) ?? [];
            children.push(JSON.parse(row.payloadJson) as DraftBatchRecord['children'][number]);
            childrenByBatch.set(row.draftBatchId, children);
        }
        this.cache = {
            sessions: sessionRows.map((row) => JSON.parse(row.payloadJson) as DraftSessionRecord),
            batches: batchRows.map((row) => ({
                ...(JSON.parse(row.payloadJson) as Omit<DraftBatchRecord, 'children'>),
                children: childrenByBatch.get(row.draftBatchId) ?? [],
            })),
        };
    }

    private async flush(): Promise<void> {
        await this.ensureSqliteSchema();
        const snapshot = this.cache ?? EMPTY_STORE;
        try {
            await this.database.$transaction(async (tx) => {
                    // The in-memory mutation API remains unchanged for this phase,
                    // but persistence is normalized by entity and replaced inside
                    // one SQLite transaction so readers never observe a half-flush.
                    await tx.$executeRawUnsafe('DELETE FROM "DraftBatchChild"');
                    await tx.$executeRawUnsafe('DELETE FROM "DraftBatch"');
                    await tx.$executeRawUnsafe('DELETE FROM "DraftSession"');
                    for (const session of snapshot.sessions) {
                        await tx.$executeRawUnsafe(
                        `INSERT INTO "DraftSession" (
                            "draftSessionId", "workspace", "type", "source", "origin", "novelId",
                            "chapterId", "sourceOperationId", "draftBatchId", "childIndex",
                            "generationRevision", "status", "payloadJson", "version", "createdAt", "updatedAt"
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        session.draftSessionId,
                        session.workspace,
                        session.type,
                        session.source,
                        session.origin,
                        session.novelId,
                        session.chapterId ?? null,
                        session.sourceOperationId ?? null,
                        session.draftBatchId ?? null,
                        session.childIndex ?? null,
                        session.generationRevision ?? null,
                        session.status,
                        JSON.stringify(session),
                        session.version,
                        new Date(session.createdAt),
                        new Date(session.updatedAt),
                        );
                    }
                    for (const batch of snapshot.batches) {
                        const { children, ...batchPayload } = batch;
                        await tx.$executeRawUnsafe(
                        `INSERT INTO "DraftBatch" (
                            "draftBatchId", "novelId", "volumeId", "anchorChapterId", "mode", "status",
                            "payloadJson", "version", "createdAt", "updatedAt"
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        batch.draftBatchId,
                        batch.novelId,
                        batch.volumeId,
                        batch.anchorChapterId,
                        batch.mode,
                        batch.status,
                        JSON.stringify(batchPayload),
                        batch.version,
                        new Date(batch.createdAt),
                        new Date(batch.updatedAt),
                        );
                        for (const child of children) {
                            await tx.$executeRawUnsafe(
                            `INSERT INTO "DraftBatchChild" (
                                "draftBatchId", "childIndex", "status", "generationRevision",
                                "draftSessionId", "targetChapterId", "payloadJson", "updatedAt"
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            batch.draftBatchId,
                            child.childIndex,
                            child.status,
                            child.generationRevision,
                            child.draftSessionId ?? null,
                            child.targetChapterId ?? null,
                            JSON.stringify(child),
                            new Date(batch.updatedAt),
                            );
                        }
                    }
            });
        } catch (error) {
            // A caller may already have mutated the cached object graph.
            // Reload from the rolled-back database before the next access.
            this.cache = null;
            throw error;
        }
    }

    private async ensureSqliteSchema(): Promise<void> {
        if (!this.sqliteSchemaReady) {
            this.sqliteSchemaReady = this.initializeSqliteSchema().catch((error) => {
                this.sqliteSchemaReady = null;
                throw error;
            });
        }
        return this.sqliteSchemaReady;
    }

    private async initializeSqliteSchema(): Promise<void> {
        await this.database.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "DraftSession" (
                "draftSessionId" TEXT NOT NULL PRIMARY KEY,
                "workspace" TEXT NOT NULL,
                "type" TEXT NOT NULL,
                "source" TEXT NOT NULL,
                "origin" TEXT NOT NULL,
                "novelId" TEXT NOT NULL,
                "chapterId" TEXT,
                "sourceOperationId" TEXT,
                "draftBatchId" TEXT,
                "childIndex" INTEGER,
                "generationRevision" INTEGER,
                "status" TEXT NOT NULL,
                "payloadJson" TEXT NOT NULL,
                "version" INTEGER NOT NULL,
                "createdAt" DATETIME NOT NULL,
                "updatedAt" DATETIME NOT NULL
            )
        `);
        await this.database.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "DraftBatch" (
                "draftBatchId" TEXT NOT NULL PRIMARY KEY,
                "novelId" TEXT NOT NULL,
                "volumeId" TEXT NOT NULL,
                "anchorChapterId" TEXT NOT NULL,
                "mode" TEXT NOT NULL,
                "status" TEXT NOT NULL,
                "payloadJson" TEXT NOT NULL,
                "version" INTEGER NOT NULL,
                "createdAt" DATETIME NOT NULL,
                "updatedAt" DATETIME NOT NULL
            )
        `);
        await this.database.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "DraftBatchChild" (
                "draftBatchId" TEXT NOT NULL,
                "childIndex" INTEGER NOT NULL,
                "status" TEXT NOT NULL,
                "generationRevision" INTEGER NOT NULL,
                "draftSessionId" TEXT,
                "targetChapterId" TEXT,
                "payloadJson" TEXT NOT NULL,
                "updatedAt" DATETIME NOT NULL,
                PRIMARY KEY ("draftBatchId", "childIndex"),
                CONSTRAINT "DraftBatchChild_draftBatchId_fkey"
                    FOREIGN KEY ("draftBatchId") REFERENCES "DraftBatch" ("draftBatchId")
                    ON DELETE CASCADE ON UPDATE CASCADE
            )
        `);
        const statements = [
            'CREATE UNIQUE INDEX IF NOT EXISTS "DraftSession_sourceOperationId_key" ON "DraftSession"("sourceOperationId")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_session_novel_status_updated" ON "DraftSession"("novelId", "status", "updatedAt")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_session_batch_child" ON "DraftSession"("draftBatchId", "childIndex")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_batch_novel_status_updated" ON "DraftBatch"("novelId", "status", "updatedAt")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_batch_volume_updated" ON "DraftBatch"("volumeId", "updatedAt")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_batch_child_session" ON "DraftBatchChild"("draftSessionId")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_batch_child_status_updated" ON "DraftBatchChild"("status", "updatedAt")',
        ];
        for (const statement of statements) await this.database.$executeRawUnsafe(statement);
    }

    private createSessionRecord(input: DraftSessionCreateInput): DraftSessionRecord {
        const now = new Date().toISOString();
        return {
            ...input,
            draftSessionId: randomUUID(),
            version: 1,
            createdAt: now,
            updatedAt: now,
        };
    }

    private async insertSession(
        tx: DraftEntityTransaction,
        session: DraftSessionRecord,
    ): Promise<void> {
        await tx.$executeRawUnsafe(
            `INSERT INTO "DraftSession" (
                "draftSessionId", "workspace", "type", "source", "origin", "novelId",
                "chapterId", "sourceOperationId", "draftBatchId", "childIndex",
                "generationRevision", "status", "payloadJson", "version", "createdAt", "updatedAt"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            session.draftSessionId,
            session.workspace,
            session.type,
            session.source,
            session.origin,
            session.novelId,
            session.chapterId ?? null,
            session.sourceOperationId ?? null,
            session.draftBatchId ?? null,
            session.childIndex ?? null,
            session.generationRevision ?? null,
            session.status,
            JSON.stringify(session),
            session.version,
            new Date(session.createdAt),
            new Date(session.updatedAt),
        );
    }

    async persistPreparedChapterDraft(
        tx: DraftEntityTransaction,
        operation: DraftOperationRecord,
        prepared: PreparedChapterDraft,
    ): Promise<DraftOperationResultRef> {
        const existingRows = await tx.$queryRawUnsafe<Array<{ payloadJson: string }>>(
            'SELECT "payloadJson" FROM "DraftSession" WHERE "sourceOperationId" = ? LIMIT 1',
            operation.operationId,
        );
        if (existingRows[0]) {
            const existing = JSON.parse(existingRows[0].payloadJson) as DraftSessionRecord;
            if (
                existing.sourceOperationId !== operation.operationId
                || (existing.draftBatchId ?? null) !== (operation.draftBatchId ?? null)
                || (existing.childIndex ?? null) !== (operation.childIndex ?? null)
                || existing.generationRevision !== operation.generationRevision
            ) {
                throw createStoreError(
                    'IDEMPOTENCY_CONFLICT',
                    'Draft operation is already attached to another target revision',
                );
            }
            return {
                draftSessionId: existing.draftSessionId,
                ...(existing.draftBatchId ? { draftBatchId: existing.draftBatchId } : {}),
                ...(typeof existing.childIndex === 'number' ? { childIndex: existing.childIndex } : {}),
                generationRevision: existing.generationRevision ?? operation.generationRevision,
            };
        }
        if (prepared.kind === 'existing') {
            throw createStoreError('DRAFT_RESULT_NOT_COMMITTED', 'Prepared existing draft result is no longer present');
        }
        if (
            prepared.sessionInput.sourceOperationId !== operation.operationId
            || prepared.sessionInput.novelId !== operation.novelId
            || (prepared.draftBatchId ?? null) !== (operation.draftBatchId ?? null)
            || (prepared.childIndex ?? null) !== (operation.childIndex ?? null)
            || (prepared.expectedGenerationRevision ?? prepared.sessionInput.generationRevision) !== operation.generationRevision
        ) {
            throw createStoreError('DRAFT_RESULT_MISMATCH', 'Prepared draft does not match the operation target revision');
        }

        if (!prepared.draftBatchId || typeof prepared.childIndex !== 'number') {
            const session = this.createSessionRecord({
                ...prepared.sessionInput,
                sourceOperationId: operation.operationId,
                generationRevision: operation.generationRevision,
            });
            const activeRows = await tx.$queryRawUnsafe<Array<{
                draftSessionId: string;
                payloadJson: string;
                version: number;
            }>>(
                `SELECT "draftSessionId", "payloadJson", "version" FROM "DraftSession"
                 WHERE "draftBatchId" IS NULL AND "novelId" = ? AND "workspace" = ?
                   AND "type" = ? AND "status" = 'draft'`,
                session.novelId,
                session.workspace,
                session.type,
            );
            for (const row of activeRows) {
                const stale = {
                    ...(JSON.parse(row.payloadJson) as DraftSessionRecord),
                    status: 'stale' as const,
                    version: row.version + 1,
                    updatedAt: session.createdAt,
                };
                await tx.$executeRawUnsafe(
                    `UPDATE "DraftSession" SET "status" = 'stale', "payloadJson" = ?,
                     "version" = ?, "updatedAt" = ? WHERE "draftSessionId" = ? AND "version" = ?`,
                    JSON.stringify(stale),
                    stale.version,
                    new Date(stale.updatedAt),
                    row.draftSessionId,
                    row.version,
                );
            }
            await this.insertSession(tx, session);
            return {
                draftSessionId: session.draftSessionId,
                generationRevision: operation.generationRevision,
            };
        }

        const batchRows = await tx.$queryRawUnsafe<Array<{ payloadJson: string; version: number }>>(
            'SELECT "payloadJson", "version" FROM "DraftBatch" WHERE "draftBatchId" = ? LIMIT 1',
            prepared.draftBatchId,
        );
        const childRows = await tx.$queryRawUnsafe<Array<{ childIndex: number; payloadJson: string }>>(
            `SELECT "childIndex", "payloadJson" FROM "DraftBatchChild"
             WHERE "draftBatchId" = ? ORDER BY "childIndex"`,
            prepared.draftBatchId,
        );
        if (!batchRows[0]) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current: DraftBatchRecord = {
            ...(JSON.parse(batchRows[0].payloadJson) as Omit<DraftBatchRecord, 'children'>),
            children: childRows.map((row) => JSON.parse(row.payloadJson) as DraftBatchRecord['children'][number]),
        };
        if (!['ready_to_generate', 'generating'].includes(current.status)) {
            throw createStoreError('INVALID_STATE', 'Draft batch is not ready to generate');
        }
        const child = current.children[prepared.childIndex];
        if (!child || child.childIndex !== prepared.childIndex) {
            throw createStoreError('NOT_FOUND', 'Draft batch child not found');
        }
        if (child.draftSessionId) throw createStoreError('INVALID_STATE', 'Draft batch child already has a draft session');
        if (child.generationRevision !== operation.generationRevision) {
            throw createStoreError('VERSION_CONFLICT', 'Draft batch child generation revision conflict');
        }
        if (
            prepared.childIndex > 0
            && !['draft', 'committed'].includes(current.children[prepared.childIndex - 1]?.status ?? '')
        ) {
            throw createStoreError('INVALID_STATE', 'The previous chapter draft must complete first');
        }
        const previousSessionId = prepared.childIndex > 0
            ? current.children[prepared.childIndex - 1]?.draftSessionId
            : undefined;
        const session = this.createSessionRecord({
            ...prepared.sessionInput,
            novelId: current.novelId,
            sourceOperationId: operation.operationId,
            draftBatchId: prepared.draftBatchId,
            childIndex: prepared.childIndex,
            generationRevision: child.generationRevision,
            dependsOnDraftSessionId: previousSessionId,
            status: 'draft',
        });
        const children = current.children.map((item) => item.childIndex === prepared.childIndex
            ? { ...item, status: 'draft' as const, draftSessionId: session.draftSessionId }
            : item);
        const allDraftsReady = children.every((item) => item.status === 'draft' || item.status === 'committed');
        const updatedBatch: DraftBatchRecord = {
            ...current,
            status: allDraftsReady ? 'ready_for_review' : 'generating',
            children,
            stateLedger: advanceNarrativeStateLedger(
                current.stateLedger,
                prepared.childIndex,
                session.draftSessionId,
                prepared.progress,
                child.generationRevision,
            ),
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
        };
        const { children: _children, ...batchPayload } = updatedBatch;
        await this.insertSession(tx, session);
        const changedBatch = await tx.$executeRawUnsafe(
            `UPDATE "DraftBatch" SET "status" = ?, "payloadJson" = ?, "version" = ?, "updatedAt" = ?
             WHERE "draftBatchId" = ? AND "version" = ?`,
            updatedBatch.status,
            JSON.stringify(batchPayload),
            updatedBatch.version,
            new Date(updatedBatch.updatedAt),
            updatedBatch.draftBatchId,
            batchRows[0].version,
        );
        if (changedBatch !== 1) throw createStoreError('VERSION_CONFLICT', 'Draft batch changed concurrently');
        const updatedChild = children[prepared.childIndex];
        const changedChild = await tx.$executeRawUnsafe(
            `UPDATE "DraftBatchChild" SET "status" = ?, "draftSessionId" = ?,
             "payloadJson" = ?, "updatedAt" = ? WHERE "draftBatchId" = ? AND "childIndex" = ?
             AND "generationRevision" = ? AND "draftSessionId" IS NULL`,
            updatedChild.status,
            updatedChild.draftSessionId ?? null,
            JSON.stringify(updatedChild),
            new Date(updatedBatch.updatedAt),
            updatedBatch.draftBatchId,
            updatedChild.childIndex,
            operation.generationRevision,
        );
        if (changedChild !== 1) throw createStoreError('VERSION_CONFLICT', 'Draft batch child changed concurrently');
        return {
            draftSessionId: session.draftSessionId,
            draftBatchId: prepared.draftBatchId,
            childIndex: prepared.childIndex,
            generationRevision: operation.generationRevision,
        };
    }

    invalidateCache(): void {
        this.cache = null;
    }

    async list(filters?: DraftListFilters): Promise<DraftSessionRecord[]> {
        await this.ensureLoaded();
        return [...(this.cache?.sessions ?? [])]
            .filter((session) => {
                if (filters?.novelId && session.novelId !== filters.novelId) return false;
                if (filters?.sourceOperationId && session.sourceOperationId !== filters.sourceOperationId) return false;
                if (filters?.draftBatchId && session.draftBatchId !== filters.draftBatchId) return false;
                if (!filters?.draftBatchId && !filters?.includeBatchChildren && session.draftBatchId) return false;
                if (filters?.workspace && session.workspace !== filters.workspace) return false;
                if (filters?.type && session.type !== filters.type) return false;
                if (filters?.status && session.status !== filters.status) return false;
                if (!filters?.includeInactive && session.status !== 'draft') return false;
                return true;
            })
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    async getById(draftSessionId: string): Promise<DraftSessionRecord | null> {
        await this.ensureLoaded();
        return this.cache?.sessions.find((session) => session.draftSessionId === draftSessionId) ?? null;
    }

    async getBySourceOperationId(sourceOperationId: string): Promise<DraftSessionRecord | null> {
        await this.ensureLoaded();
        return this.cache?.sessions.find((session) => session.sourceOperationId === sourceOperationId) ?? null;
    }

    async getLatest(filters: Omit<DraftListFilters, 'includeInactive'>): Promise<DraftSessionRecord | null> {
        const sessions = await this.list(filters);
        return sessions[0] ?? null;
    }

    async create(input: DraftSessionCreateInput): Promise<DraftSessionRecord> {
        await this.ensureLoaded();
        if (input.sourceOperationId) {
            const existing = this.cache?.sessions.find((session) => session.sourceOperationId === input.sourceOperationId);
            if (existing) return existing;
        }
        const session = this.createSessionRecord(input);
        const sessions = this.cache?.sessions ?? [];
        const retained = input.draftBatchId
            ? sessions
            : sessions.map((item) => (
                !item.draftBatchId
                && item.novelId === session.novelId
                && item.workspace === session.workspace
                && item.type === session.type
                && item.status === 'draft'
                    ? {
                        ...item,
                        status: 'stale' as const,
                        version: item.version + 1,
                        updatedAt: session.createdAt,
                    }
                    : item
            ));
        this.cache = {
            sessions: [session, ...retained],
            batches: this.cache?.batches ?? [],
        };
        await this.flush();
        return session;
    }

    async update(
        draftSessionId: string,
        expectedVersion: number | undefined,
        updater: (current: DraftSessionRecord) => DraftSessionRecord,
    ): Promise<DraftSessionRecord> {
        await this.ensureLoaded();
        const sessions = this.cache?.sessions ?? [];
        const index = sessions.findIndex((session) => session.draftSessionId === draftSessionId);
        if (index < 0) {
            throw createStoreError('NOT_FOUND', 'Draft session not found');
        }
        const current = sessions[index];
        if (typeof expectedVersion === 'number' && current.version !== expectedVersion) {
            throw createStoreError('VERSION_CONFLICT', 'Draft session version conflict');
        }
        const next = updater(current);
        const updated: DraftSessionRecord = {
            ...next,
            draftSessionId: current.draftSessionId,
            createdAt: current.createdAt,
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
        };
        sessions[index] = updated;
        await this.flush();
        return updated;
    }

    async listBatches(filters?: DraftBatchListFilters): Promise<DraftBatchRecord[]> {
        await this.ensureLoaded();
        return [...(this.cache?.batches ?? [])]
            .filter((batch) => {
                if (filters?.novelId && batch.novelId !== filters.novelId) return false;
                if (filters?.volumeId && batch.volumeId !== filters.volumeId) return false;
                if (filters?.status && batch.status !== filters.status) return false;
                if (!filters?.includeInactive && ['committed', 'discarded', 'failed'].includes(batch.status)) return false;
                return true;
            })
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    async getBatchById(draftBatchId: string): Promise<DraftBatchRecord | null> {
        await this.ensureLoaded();
        return this.cache?.batches.find((batch) => batch.draftBatchId === draftBatchId) ?? null;
    }

    async createBatch(input: DraftBatchCreateInput): Promise<DraftBatchRecord> {
        await this.ensureLoaded();
        const novelId = String(input?.novelId ?? '').trim();
        const volumeId = String(input?.volumeId ?? '').trim();
        const anchorChapterId = String(input?.anchorChapterId ?? '').trim();
        if (!novelId || !volumeId || !anchorChapterId) {
            throw createStoreError('INVALID_INPUT', 'novelId, volumeId and anchorChapterId are required');
        }
        if (input.mode !== 'sequence_continuation' && input.mode !== 'batch_rewrite') {
            throw createStoreError('INVALID_INPUT', 'Unsupported draft batch mode');
        }
        const beats = normalizeBeats(input.beats);
        const targetChapterIds = Array.isArray(input.targetChapterIds)
            ? input.targetChapterIds.map((chapterId) => String(chapterId || '').trim()).filter(Boolean)
            : [];
        if (input.mode === 'batch_rewrite' && targetChapterIds.length !== beats.length) {
            throw createStoreError('INVALID_INPUT', 'batch_rewrite requires one targetChapterId per beat');
        }
        if (input.mode === 'batch_rewrite' && new Set(targetChapterIds).size !== targetChapterIds.length) {
            throw createStoreError('INVALID_INPUT', 'batch_rewrite targetChapterIds must be unique');
        }
        const sourceSnapshot = Array.isArray(input.sourceSnapshot) ? input.sourceSnapshot : [];
        if (input.mode === 'batch_rewrite') {
            const snapshotByChapterId = new Map(sourceSnapshot.map((snapshot) => [snapshot.chapterId, snapshot]));
            const missingSnapshots = targetChapterIds.filter((chapterId) => {
                const snapshot = snapshotByChapterId.get(chapterId);
                return !snapshot || !Number.isInteger(snapshot.version) || snapshot.version < 1 || !String(snapshot.contentHash || '').trim();
            });
            if (missingSnapshots.length > 0) {
                throw createStoreError(
                    'INVALID_INPUT',
                    `batch_rewrite requires a versioned source snapshot for every target chapter: ${missingSnapshots.join(', ')}`,
                );
            }
        }
        const now = new Date().toISOString();
        const batch: DraftBatchRecord = {
            draftBatchId: randomUUID(),
            novelId,
            volumeId,
            anchorChapterId,
            mode: input.mode,
            insertionMode: input.insertionMode,
            status: 'outline_draft',
            outline: {
                revision: 1,
                status: 'draft',
                beats,
            },
            children: beats.map((beat, childIndex) => ({
                childIndex,
                title: beat.title,
                status: 'pending',
                generationRevision: 1,
                targetChapterId: targetChapterIds[childIndex] || undefined,
                dependsOnChildIndex: childIndex > 0 ? childIndex - 1 : undefined,
            })),
            stateLedger: createEmptyNarrativeStateLedger(),
            sourceSnapshot,
            runId: input.runId,
            linkedRunIds: input.runId ? [input.runId] : [],
            version: 1,
            createdAt: now,
            updatedAt: now,
        };
        this.cache = {
            sessions: this.cache?.sessions ?? [],
            batches: [batch, ...(this.cache?.batches ?? [])],
        };
        await this.flush();
        return batch;
    }

    async updateBatchOutline(
        draftBatchId: string,
        expectedVersion: number,
        beatInputs: ChapterBeatInput[],
    ): Promise<DraftBatchRecord> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const index = batches.findIndex((batch) => batch.draftBatchId === draftBatchId);
        if (index < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[index];
        if (current.version !== expectedVersion) throw createStoreError('VERSION_CONFLICT', 'Draft batch version conflict');
        if (current.children.some((child) => Boolean(child.draftSessionId))) {
            throw createStoreError('INVALID_STATE', 'Cannot change chapter beats after draft generation has started');
        }
        const beats = normalizeBeats(beatInputs);
        if (current.mode === 'batch_rewrite' && beats.length !== current.children.length) {
            throw createStoreError('INVALID_INPUT', 'A rewrite batch cannot change its target chapter count');
        }
        const targetChapterIds = current.children.map((child) => child.targetChapterId);
        const updated: DraftBatchRecord = {
            ...current,
            status: 'outline_draft',
            outline: {
                revision: current.outline.revision + 1,
                status: 'draft',
                beats,
            },
            children: beats.map((beat, childIndex) => ({
                childIndex,
                title: beat.title,
                status: 'pending',
                generationRevision: 1,
                targetChapterId: targetChapterIds[childIndex],
                dependsOnChildIndex: childIndex > 0 ? childIndex - 1 : undefined,
            })),
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
        };
        batches[index] = updated;
        await this.flush();
        return updated;
    }

    async approveBatchOutline(
        draftBatchId: string,
        expectedVersion: number,
        outlineRevision: number,
        approvedBy: string,
    ): Promise<DraftBatchRecord> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const index = batches.findIndex((batch) => batch.draftBatchId === draftBatchId);
        if (index < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[index];
        if (current.version !== expectedVersion) throw createStoreError('VERSION_CONFLICT', 'Draft batch version conflict');
        if (current.outline.revision !== outlineRevision) throw createStoreError('VERSION_CONFLICT', 'Draft batch outline revision conflict');
        if (current.status !== 'outline_draft') throw createStoreError('INVALID_STATE', 'Draft batch outline is not awaiting approval');
        const now = new Date().toISOString();
        const updated: DraftBatchRecord = {
            ...current,
            status: 'ready_to_generate',
            outline: {
                ...current.outline,
                status: 'approved',
                approvedAt: now,
                approvedBy: approvedBy.trim() || 'unknown',
            },
            version: current.version + 1,
            updatedAt: now,
        };
        batches[index] = updated;
        await this.flush();
        return updated;
    }

    async createBatchChildSession(
        draftBatchId: string,
        childIndex: number,
        input: Omit<DraftSessionCreateInput, 'draftBatchId' | 'childIndex' | 'generationRevision' | 'dependsOnDraftSessionId'>,
        progress?: DraftBatchChildProgress,
        expectedGenerationRevision?: number,
    ): Promise<{ batch: DraftBatchRecord; session: DraftSessionRecord }> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const batchIndex = batches.findIndex((batch) => batch.draftBatchId === draftBatchId);
        if (batchIndex < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[batchIndex];
        if (input.sourceOperationId) {
            const existing = this.cache?.sessions.find((session) => session.sourceOperationId === input.sourceOperationId);
            if (existing) {
                if (
                    existing.draftBatchId !== draftBatchId
                    || existing.childIndex !== childIndex
                    || existing.generationRevision !== current.children[childIndex]?.generationRevision
                ) {
                    throw createStoreError('IDEMPOTENCY_CONFLICT', 'Draft operation is already attached to another batch child revision');
                }
                return { batch: current, session: existing };
            }
        }
        if (!['ready_to_generate', 'generating'].includes(current.status)) {
            throw createStoreError('INVALID_STATE', 'Draft batch is not ready to generate');
        }
        const child = current.children[childIndex];
        if (!child || child.childIndex !== childIndex) throw createStoreError('NOT_FOUND', 'Draft batch child not found');
        if (child.draftSessionId) throw createStoreError('INVALID_STATE', 'Draft batch child already has a draft session');
        if (
            typeof expectedGenerationRevision === 'number'
            && child.generationRevision !== expectedGenerationRevision
        ) {
            throw createStoreError('VERSION_CONFLICT', 'Draft batch child generation revision conflict');
        }
        if (childIndex > 0 && !['draft', 'committed'].includes(current.children[childIndex - 1]?.status ?? '')) {
            throw createStoreError('INVALID_STATE', 'The previous chapter draft must complete first');
        }
        const previousSessionId = childIndex > 0 ? current.children[childIndex - 1]?.draftSessionId : undefined;
        const session = this.createSessionRecord({
            ...input,
            novelId: current.novelId,
            draftBatchId,
            childIndex,
            generationRevision: child.generationRevision,
            dependsOnDraftSessionId: previousSessionId,
            status: 'draft',
        });
        const children = current.children.map((item) => item.childIndex === childIndex
            ? { ...item, status: 'draft' as const, draftSessionId: session.draftSessionId }
            : item);
        const allDraftsReady = children.every((item) => item.status === 'draft' || item.status === 'committed');
        const updatedBatch: DraftBatchRecord = {
            ...current,
            status: allDraftsReady ? 'ready_for_review' : 'generating',
            children,
            stateLedger: advanceNarrativeStateLedger(
                current.stateLedger,
                childIndex,
                session.draftSessionId,
                progress,
                child.generationRevision,
            ),
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
        };
        batches[batchIndex] = updatedBatch;
        this.cache = {
            sessions: [session, ...(this.cache?.sessions ?? [])],
            batches,
        };
        await this.flush();
        return { batch: updatedBatch, session };
    }

    async prepareBatchRegeneration(
        draftBatchId: string,
        expectedVersion: number,
        requestedFromChildIndex: number | undefined,
        runId: string,
    ): Promise<{ batch: DraftBatchRecord; fromChildIndex: number; preservedDrafts: DraftSessionRecord[] }> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const batchIndex = batches.findIndex((batch) => batch.draftBatchId === draftBatchId);
        if (batchIndex < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[batchIndex];
        if (current.version !== expectedVersion) throw createStoreError('VERSION_CONFLICT', 'Draft batch version conflict');
        if (current.status === 'committed' || current.status === 'discarded') {
            throw createStoreError('INVALID_STATE', `Cannot regenerate a ${current.status} draft batch`);
        }

        const inferredIndex = current.children.findIndex((child) => (
            child.status === 'stale'
            || child.status === 'failed'
            || child.status === 'pending'
            || child.status === 'generating'
        ));
        const fromChildIndex = requestedFromChildIndex ?? inferredIndex;
        if (!Number.isInteger(fromChildIndex) || fromChildIndex < 0 || fromChildIndex >= current.children.length) {
            throw createStoreError(
                'INVALID_INPUT',
                'fromChildIndex is required when the batch has no failed, stale or pending child',
            );
        }
        if (current.children.slice(fromChildIndex).some((child) => child.status === 'committed')) {
            throw createStoreError('INVALID_STATE', 'Committed batch children cannot be regenerated');
        }
        const invalidPrefix = current.children
            .slice(0, fromChildIndex)
            .find((child) => child.status !== 'draft' && child.status !== 'committed');
        if (invalidPrefix) {
            throw createStoreError(
                'INVALID_STATE',
                `Draft batch child ${invalidPrefix.childIndex + 1} must be resolved before regenerating a later child`,
            );
        }
        const unknownChild = current.children
            .slice(fromChildIndex)
            .find((child) => child.error?.sideEffectUnknown);
        if (unknownChild) {
            throw createStoreError(
                'SIDE_EFFECT_UNKNOWN',
                `Draft batch child ${unknownChild.childIndex + 1} has an unknown generation result and must be reconciled first`,
            );
        }

        const resetSessionIds = new Set(
            current.children
                .slice(fromChildIndex)
                .flatMap((child) => child.draftSessionId ? [child.draftSessionId] : []),
        );
        const currentSessions = this.cache?.sessions ?? [];
        const currentSessionById = new Map(currentSessions.map((session) => [session.draftSessionId, session]));
        const preservedDrafts = current.children
            .slice(0, fromChildIndex)
            .flatMap((child) => child.draftSessionId ? [currentSessionById.get(child.draftSessionId)] : [])
            .filter((session): session is DraftSessionRecord => Boolean(session));
        if (preservedDrafts.length !== fromChildIndex) {
            throw createStoreError('INVALID_STATE', 'Preserved draft prefix is missing one or more DraftSessions');
        }
        const now = new Date().toISOString();
        const sessions = currentSessions.map((session) => {
            if (!resetSessionIds.has(session.draftSessionId) || session.status === 'stale') return session;
            return {
                ...session,
                status: 'stale' as const,
                version: session.version + 1,
                updatedAt: now,
            };
        });
        const children = current.children.map((child) => child.childIndex < fromChildIndex
            ? child
            : {
                ...child,
                status: 'pending' as const,
                generationRevision: child.generationRevision + 1,
                draftSessionId: undefined,
                error: undefined,
                reconciliation: undefined,
            });
        const linkedRunIds = runId && !current.linkedRunIds.includes(runId)
            ? [...current.linkedRunIds, runId]
            : current.linkedRunIds;
        const updated: DraftBatchRecord = {
            ...current,
            status: 'ready_to_generate',
            children,
            stateLedger: rollbackNarrativeStateLedger(current, fromChildIndex),
            linkedRunIds,
            version: current.version + 1,
            updatedAt: now,
        };
        batches[batchIndex] = updated;
        this.cache = { sessions, batches };
        await this.flush();
        return { batch: updated, fromChildIndex, preservedDrafts };
    }

    async markBatchChildFailed(input: DraftBatchMarkFailedInput): Promise<DraftBatchRecord> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const batchIndex = batches.findIndex((batch) => batch.draftBatchId === input.draftBatchId);
        if (batchIndex < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[batchIndex];
        if (current.version !== input.version) throw createStoreError('VERSION_CONFLICT', 'Draft batch version conflict');
        const child = current.children[input.childIndex];
        if (!child || child.childIndex !== input.childIndex) throw createStoreError('NOT_FOUND', 'Draft batch child not found');
        if (child.generationRevision !== input.generationRevision) {
            throw createStoreError('VERSION_CONFLICT', 'Draft batch child generation revision conflict');
        }
        if (child.draftSessionId || child.status === 'committed' || child.status === 'discarded') {
            throw createStoreError('INVALID_STATE', 'Draft batch child already has a terminal result');
        }
        const error = {
            code: String(input.error?.code || 'GENERATION_FAILED'),
            message: String(input.error?.message || 'Draft generation failed'),
            ...(input.error?.sideEffectUnknown ? { sideEffectUnknown: true } : {}),
            ...(input.error?.invocationKey ? { invocationKey: String(input.error.invocationKey) } : {}),
            ...(input.error?.requestId ? { requestId: String(input.error.requestId) } : {}),
            ...(input.error?.method ? { method: String(input.error.method) } : {}),
        };
        const children = current.children.map((item) => item.childIndex === input.childIndex
            ? {
                ...item,
                status: 'failed' as const,
                error,
                ...(error.sideEffectUnknown && error.invocationKey ? {
                    reconciliation: {
                        resolution: 'pending' as const,
                        invocationKey: error.invocationKey,
                        ...(error.requestId ? { requestId: error.requestId } : {}),
                        method: error.method || 'chapter.generate_draft',
                    },
                } : {}),
            }
            : item);
        const now = new Date().toISOString();
        const updated: DraftBatchRecord = {
            ...current,
            status: children.slice(0, input.childIndex).some((item) => item.status === 'draft' || item.status === 'committed')
                ? 'partially_failed'
                : 'failed',
            children,
            version: current.version + 1,
            updatedAt: now,
        };
        batches[batchIndex] = updated;
        await this.flush();
        return updated;
    }

    async inspectBatchReconciliation(
        input: DraftBatchInspectReconciliationInput,
    ): Promise<DraftBatchReconciliationInspection> {
        await this.ensureLoaded();
        const batch = (this.cache?.batches ?? []).find((item) => item.draftBatchId === input.draftBatchId);
        if (!batch) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const child = batch.children[input.childIndex];
        if (!child || child.childIndex !== input.childIndex) throw createStoreError('NOT_FOUND', 'Draft batch child not found');
        if (child.generationRevision !== input.generationRevision) {
            throw createStoreError('VERSION_CONFLICT', 'Draft batch child generation revision conflict');
        }
        const candidates = (this.cache?.sessions ?? [])
            .filter((session) => (
                session.draftBatchId === batch.draftBatchId
                && session.childIndex === child.childIndex
                && session.generationRevision === child.generationRevision
                && session.type === 'chapter-draft'
                && session.status === 'draft'
            ))
            .map((session) => ({
                draftSessionId: session.draftSessionId,
                draftBatchId: batch.draftBatchId,
                childIndex: child.childIndex,
                generationRevision: child.generationRevision,
                status: session.status,
                previewSummary: session.previewSummary,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
            }));
        return { batch, child, candidates };
    }

    async reconcileBatchUnknown(input: DraftBatchReconcileUnknownInput): Promise<DraftBatchRecord> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const batchIndex = batches.findIndex((batch) => batch.draftBatchId === input.draftBatchId);
        if (batchIndex < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[batchIndex];
        const child = current.children[input.childIndex];
        if (!child || child.childIndex !== input.childIndex) throw createStoreError('NOT_FOUND', 'Draft batch child not found');
        if (
            child.reconciliation?.resolution === input.resolution
            && child.reconciliation.invocationKey === input.invocationKey
        ) return current;
        if (current.version !== input.version) throw createStoreError('VERSION_CONFLICT', 'Draft batch version conflict');
        if (child.generationRevision !== input.generationRevision) {
            throw createStoreError('VERSION_CONFLICT', 'Draft batch child generation revision conflict');
        }
        if (!input.confirmation) throw createStoreError('CONFIRMATION_REQUIRED', 'Explicit reconciliation confirmation is required');
        if (!child.error?.sideEffectUnknown || child.status !== 'failed') {
            throw createStoreError('INVALID_STATE', 'Draft batch child is not awaiting side-effect reconciliation');
        }
        const expectedInvocationKey = child.reconciliation?.invocationKey || child.error.invocationKey;
        if (!expectedInvocationKey || expectedInvocationKey !== input.invocationKey) {
            throw createStoreError('VERSION_CONFLICT', 'Invocation key does not match the unknown batch child');
        }

        const now = new Date().toISOString();
        let acceptedSession: DraftSessionRecord | undefined;
        if (input.resolution === 'reconciled_succeeded') {
            const candidateId = String(input.candidateDraftSessionId || '').trim();
            if (!candidateId) throw createStoreError('INVALID_INPUT', 'candidateDraftSessionId is required');
            acceptedSession = (this.cache?.sessions ?? []).find((session) => (
                session.draftSessionId === candidateId
                && session.draftBatchId === current.draftBatchId
                && session.childIndex === child.childIndex
                && session.generationRevision === child.generationRevision
                && session.type === 'chapter-draft'
                && session.status === 'draft'
            ));
            if (!acceptedSession) throw createStoreError('CANDIDATE_NOT_FOUND', 'No matching draft candidate was found');
            const usedByOtherChild = current.children.some((item) => (
                item.childIndex !== child.childIndex && item.draftSessionId === acceptedSession?.draftSessionId
            ));
            if (usedByOtherChild) throw createStoreError('INVALID_STATE', 'Draft candidate is already attached to another child');
        } else if (input.resolution !== 'reconciled_absent') {
            throw createStoreError('INVALID_INPUT', `Unsupported reconciliation resolution: ${String(input.resolution)}`);
        }

        const reconciliation = {
            resolution: input.resolution,
            invocationKey: input.invocationKey,
            ...(child.reconciliation?.requestId || child.error.requestId ? {
                requestId: child.reconciliation?.requestId || child.error.requestId,
            } : {}),
            method: child.reconciliation?.method || child.error.method || 'chapter.generate_draft',
            ...(acceptedSession ? { candidateDraftSessionId: acceptedSession.draftSessionId } : {}),
            ...(input.note?.trim() ? { note: input.note.trim() } : {}),
            reconciledAt: now,
        };
        const children = current.children.map((item) => {
            if (item.childIndex !== child.childIndex) return item;
            if (acceptedSession) {
                return {
                    ...item,
                    status: 'draft' as const,
                    draftSessionId: acceptedSession.draftSessionId,
                    error: undefined,
                    reconciliation,
                };
            }
            return {
                ...item,
                status: 'failed' as const,
                error: {
                    code: 'RECONCILED_ABSENT',
                    message: '用户已确认没有可用草稿，可以重新生成。',
                },
                reconciliation,
            };
        });
        const allDraftsReady = children.every((item) => item.status === 'draft' || item.status === 'committed');
        const hasFailure = children.some((item) => item.status === 'failed');
        const hasUsablePrefix = children.some((item) => item.status === 'draft' || item.status === 'committed');
        const nextStatus: DraftBatchRecord['status'] = allDraftsReady
            ? 'ready_for_review'
            : hasFailure
                ? (hasUsablePrefix ? 'partially_failed' : 'failed')
                : 'generating';
        const beat = current.outline.beats[child.childIndex];
        const acceptedPayload = acceptedSession?.payload && typeof acceptedSession.payload === 'object'
            ? acceptedSession.payload as Record<string, unknown>
            : {};
        const acceptedStateDelta = acceptedPayload.narrativeStateDelta && typeof acceptedPayload.narrativeStateDelta === 'object'
            ? acceptedPayload.narrativeStateDelta as NarrativeStateDelta
            : undefined;
        const updated: DraftBatchRecord = {
            ...current,
            status: nextStatus,
            children,
            stateLedger: acceptedSession && beat
                ? advanceNarrativeStateLedger(current.stateLedger, child.childIndex, acceptedSession.draftSessionId, {
                    title: beat.title,
                    coreConflict: beat.coreConflict,
                    keyEvents: beat.keyEvents,
                    reveals: beat.reveals,
                    endingHook: beat.endingHook,
                    summary: acceptedSession.previewSummary,
                    stateDelta: acceptedStateDelta,
                }, acceptedSession.generationRevision)
                : current.stateLedger,
            version: current.version + 1,
            updatedAt: now,
        };
        batches[batchIndex] = updated;
        await this.flush();
        return updated;
    }

    async markBatchChildrenStale(
        draftBatchId: string,
        expectedVersion: number,
        afterChildIndex: number,
    ): Promise<DraftBatchRecord> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const batchIndex = batches.findIndex((batch) => batch.draftBatchId === draftBatchId);
        if (batchIndex < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[batchIndex];
        if (current.version !== expectedVersion) throw createStoreError('VERSION_CONFLICT', 'Draft batch version conflict');
        if (!Number.isInteger(afterChildIndex) || afterChildIndex < 0 || afterChildIndex >= current.children.length) {
            throw createStoreError('INVALID_INPUT', 'afterChildIndex is outside the draft batch');
        }
        const staleSessionIds = new Set<string>();
        const children = current.children.map((child) => {
            if (child.childIndex <= afterChildIndex || ['committed', 'discarded'].includes(child.status)) return child;
            if (child.draftSessionId) staleSessionIds.add(child.draftSessionId);
            return { ...child, status: 'stale' as const };
        });
        const now = new Date().toISOString();
        const sessions = (this.cache?.sessions ?? []).map((session) => staleSessionIds.has(session.draftSessionId)
            ? { ...session, status: 'stale' as const, version: session.version + 1, updatedAt: now }
            : session);
        const updated: DraftBatchRecord = {
            ...current,
            status: 'stale',
            children,
            stateLedger: rollbackNarrativeStateLedger(current, afterChildIndex),
            version: current.version + 1,
            updatedAt: now,
        };
        batches[batchIndex] = updated;
        this.cache = { sessions, batches };
        await this.flush();
        return updated;
    }

    async commitBatchPrefix(
        draftBatchId: string,
        expectedVersion: number,
        prefixLength: number,
        insertionMode: DraftBatchRecord['insertionMode'],
        committedChapters: DraftBatchCommittedChapter[],
        writeback?: DraftWritebackRecord,
    ): Promise<{ batch: DraftBatchRecord; sessions: DraftSessionRecord[] }> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const batchIndex = batches.findIndex((batch) => batch.draftBatchId === draftBatchId);
        if (batchIndex < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[batchIndex];
        if (current.version !== expectedVersion) throw createStoreError('VERSION_CONFLICT', 'Draft batch version conflict');
        if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > current.children.length) {
            throw createStoreError('INVALID_INPUT', 'prefixLength is outside the draft batch');
        }

        const firstUncommittedIndex = current.children.findIndex((child) => child.status !== 'committed');
        const committedPrefixLength = firstUncommittedIndex < 0 ? current.children.length : firstUncommittedIndex;
        if (current.children.slice(committedPrefixLength).some((child) => child.status === 'committed')) {
            throw createStoreError('INVALID_STATE', 'Draft batch contains a non-contiguous committed child');
        }
        if (prefixLength <= committedPrefixLength) {
            throw createStoreError('INVALID_STATE', 'Requested prefix is already committed');
        }

        const expectedIndexes = Array.from(
            { length: prefixLength - committedPrefixLength },
            (_, offset) => committedPrefixLength + offset,
        );
        if (
            committedChapters.length !== expectedIndexes.length
            || committedChapters.some((chapter, index) => chapter.childIndex !== expectedIndexes[index])
        ) {
            throw createStoreError('INVALID_INPUT', 'Committed chapter mapping does not match the requested prefix');
        }
        if (current.mode === 'batch_rewrite' && (!writeback || writeback.mode !== 'batch_rewrite')) {
            throw createStoreError('INVALID_INPUT', 'Rewrite commits require a reversible writeback record');
        }

        const sessions = this.cache?.sessions ?? [];
        const sessionById = new Map(sessions.map((session) => [session.draftSessionId, session]));
        const committedByIndex = new Map(committedChapters.map((chapter) => [chapter.childIndex, chapter]));
        for (const childIndex of expectedIndexes) {
            const child = current.children[childIndex];
            const session = child?.draftSessionId ? sessionById.get(child.draftSessionId) : undefined;
            if (!child || child.status !== 'draft' || !session || session.status !== 'draft') {
                throw createStoreError('INVALID_STATE', `Draft batch child ${childIndex + 1} is not ready to commit`);
            }
            if (session.draftBatchId !== draftBatchId || session.childIndex !== childIndex) {
                throw createStoreError('INVALID_STATE', `Draft batch child ${childIndex + 1} session linkage is invalid`);
            }
        }

        const now = new Date().toISOString();
        const updatedSessions = sessions.map((session) => {
            const committedChapter = typeof session.childIndex === 'number'
                ? committedByIndex.get(session.childIndex)
                : undefined;
            if (session.draftBatchId !== draftBatchId || !committedChapter) return session;
            return {
                ...session,
                chapterId: committedChapter.chapterId,
                status: 'committed' as const,
                payload: {
                    ...(session.payload as Record<string, unknown>),
                    chapterId: committedChapter.chapterId,
                    content: committedChapter.content,
                },
                version: session.version + 1,
                updatedAt: now,
            } as DraftSessionRecord;
        });
        const children = current.children.map((child) => {
            const committedChapter = committedByIndex.get(child.childIndex);
            return committedChapter
                ? { ...child, status: 'committed' as const, targetChapterId: committedChapter.chapterId }
                : child;
        });
        const allCommitted = children.every((child) => child.status === 'committed');
        const updated: DraftBatchRecord = {
            ...current,
            insertionMode,
            status: allCommitted
                ? 'committed'
                : children.some((child) => child.status === 'failed')
                    ? 'partially_failed'
                    : children.some((child) => child.status === 'stale')
                        ? 'stale'
                        : 'ready_for_review',
            children,
            writebacks: writeback ? [...(current.writebacks ?? []), writeback] : current.writebacks,
            version: current.version + 1,
            updatedAt: now,
        };
        batches[batchIndex] = updated;
        this.cache = { sessions: updatedSessions, batches };
        await this.flush();
        return {
            batch: updated,
            sessions: updatedSessions.filter((session) => (
                session.draftBatchId === draftBatchId
                && typeof session.childIndex === 'number'
                && session.childIndex < prefixLength
            )).sort((left, right) => (left.childIndex ?? 0) - (right.childIndex ?? 0)),
        };
    }

    async undoBatchWriteback(
        draftBatchId: string,
        expectedVersion: number,
        writebackId: string,
        restoredChapters: DraftBatchCommittedChapter[],
    ): Promise<{ batch: DraftBatchRecord; sessions: DraftSessionRecord[]; writeback: DraftWritebackRecord }> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const batchIndex = batches.findIndex((batch) => batch.draftBatchId === draftBatchId);
        if (batchIndex < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[batchIndex];
        if (current.version !== expectedVersion) throw createStoreError('VERSION_CONFLICT', 'Draft batch version conflict');
        const latestActive = [...(current.writebacks ?? [])].reverse().find((item) => item.status === 'committed');
        if (!latestActive || latestActive.writebackId !== writebackId) {
            throw createStoreError('INVALID_STATE', 'Only the latest writeback can be undone');
        }
        const restoredByIndex = new Map(restoredChapters.map((chapter) => [chapter.childIndex, chapter]));
        if (
            restoredChapters.length !== latestActive.chapters.length
            || latestActive.chapters.some((snapshot) => (
                typeof snapshot.childIndex !== 'number'
                || restoredByIndex.get(snapshot.childIndex)?.chapterId !== snapshot.chapterId
            ))
        ) {
            throw createStoreError('INVALID_INPUT', 'Restored chapter mapping does not match the writeback');
        }

        const now = new Date().toISOString();
        const restoredIndexes = new Set(restoredChapters.map((chapter) => chapter.childIndex));
        const children = current.children.map((child) => restoredIndexes.has(child.childIndex)
            ? { ...child, status: 'draft' as const }
            : child);
        const sessions = (this.cache?.sessions ?? []).map((session) => (
            session.draftBatchId === draftBatchId
            && typeof session.childIndex === 'number'
            && restoredIndexes.has(session.childIndex)
        ) ? {
                ...session,
                status: 'draft' as const,
                version: session.version + 1,
                updatedAt: now,
            } : session);
        const restoredById = new Map(restoredChapters.map((chapter) => [chapter.chapterId, chapter]));
        const sourceSnapshot = current.sourceSnapshot.map((snapshot) => {
            const restored = restoredById.get(snapshot.chapterId);
            return restored ? {
                chapterId: restored.chapterId,
                version: restored.version,
                contentHash: createHash('sha256').update(restored.content || '', 'utf8').digest('hex'),
            } : snapshot;
        });
        const undoneWriteback: DraftWritebackRecord = {
            ...latestActive,
            status: 'undone',
            undoneAt: now,
        };
        const updated: DraftBatchRecord = {
            ...current,
            status: children.every((child) => child.status === 'committed') ? 'committed' : 'ready_for_review',
            children,
            sourceSnapshot,
            writebacks: (current.writebacks ?? []).map((item) => (
                item.writebackId === writebackId ? undoneWriteback : item
            )),
            version: current.version + 1,
            updatedAt: now,
        };
        batches[batchIndex] = updated;
        this.cache = { sessions, batches };
        await this.flush();
        return {
            batch: updated,
            sessions: sessions.filter((session) => session.draftBatchId === draftBatchId),
            writeback: undoneWriteback,
        };
    }

    async discardBatch(draftBatchId: string, expectedVersion: number): Promise<DraftBatchRecord> {
        await this.ensureLoaded();
        const batches = this.cache?.batches ?? [];
        const batchIndex = batches.findIndex((batch) => batch.draftBatchId === draftBatchId);
        if (batchIndex < 0) throw createStoreError('NOT_FOUND', 'Draft batch not found');
        const current = batches[batchIndex];
        if (current.version !== expectedVersion) throw createStoreError('VERSION_CONFLICT', 'Draft batch version conflict');
        if (current.status === 'committed') throw createStoreError('INVALID_STATE', 'A committed draft batch cannot be discarded');
        const sessionIds = new Set(current.children.flatMap((child) => child.draftSessionId ? [child.draftSessionId] : []));
        const now = new Date().toISOString();
        const sessions = (this.cache?.sessions ?? []).map((session) => sessionIds.has(session.draftSessionId)
            ? { ...session, status: 'discarded' as const, version: session.version + 1, updatedAt: now }
            : session);
        const updated: DraftBatchRecord = {
            ...current,
            status: 'discarded',
            children: current.children.map((child) => ({ ...child, status: 'discarded' })),
            version: current.version + 1,
            updatedAt: now,
        };
        batches[batchIndex] = updated;
        this.cache = { sessions, batches };
        await this.flush();
        return updated;
    }
}
