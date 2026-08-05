import { createHash, randomUUID } from 'node:crypto';
import { db, type PrismaClientType } from '@novel-editor/core';
import {
    transitionDraftOperation,
    type DraftOperationEvent,
    type DraftOperationRecord,
    type DraftOperationStatus,
} from '../../shared/draftOperation';

export type CreateDraftOperationInput = {
    operationKey: string;
    paramsHash: string;
    requestJson: string;
    novelId: string;
    volumeId?: string;
    chapterId: string;
    draftBatchId?: string;
    childIndex?: number;
    generationRevision: number;
    sourceChapterVersion: number;
    sourceContentHash: string;
    maxAttempts?: number;
    operationDeadlineAt: string;
    sourceConversationId?: string;
    sourceRunId?: string;
    sourceStepId?: string;
};

export type DraftAttemptStartInput = {
    operationId: string;
    attemptNumber: number;
    requestId: string;
    providerType: string;
    providerProfileId?: string;
    model: string;
};

type DraftOperationTransaction = Pick<
    PrismaClientType,
    'draftGenerationOperation' | 'draftOperationOutbox' | '$executeRawUnsafe' | '$queryRawUnsafe'
>;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function createOperationError(code: string, message: string, details?: Record<string, unknown>): Error & {
    code: string;
    details?: Record<string, unknown>;
} {
    return Object.assign(new Error(message), { code, details });
}

function canonicalize(value: unknown): JsonValue {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw createOperationError('INVALID_INPUT', 'Operation input contains a non-finite number');
        return value;
    }
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(record)
                .filter((key) => record[key] !== undefined)
                .sort()
                .map((key) => [key, canonicalize(record[key])]),
        );
    }
    throw createOperationError('INVALID_INPUT', `Operation input contains unsupported ${typeof value} value`);
}

export function canonicalDraftOperationJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

export function hashDraftOperationParams(value: unknown): string {
    return createHash('sha256').update(canonicalDraftOperationJson(value), 'utf8').digest('hex');
}

export function buildDraftOperationKey(input: {
    novelId: string;
    chapterId: string;
    draftBatchId?: string;
    childIndex?: number;
    generationRevision: number;
    paramsHash: string;
}): string {
    const identity = canonicalDraftOperationJson({
        operationType: 'chapter_draft',
        novelId: input.novelId,
        chapterId: input.chapterId,
        draftBatchId: input.draftBatchId ?? null,
        childIndex: input.childIndex ?? null,
        generationRevision: input.generationRevision,
        paramsHash: input.paramsHash,
    });
    return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function asIso(value: Date | string | null | undefined): string | undefined {
    if (value === null || value === undefined) return undefined;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row: any): DraftOperationRecord {
    return {
        operationId: row.operationId,
        operationKey: row.operationKey,
        operationType: 'chapter_draft',
        paramsHash: row.paramsHash,
        requestJson: row.requestJson,
        novelId: row.novelId,
        ...(row.volumeId ? { volumeId: row.volumeId } : {}),
        chapterId: row.chapterId,
        ...(row.draftBatchId ? { draftBatchId: row.draftBatchId } : {}),
        ...(typeof row.childIndex === 'number' ? { childIndex: row.childIndex } : {}),
        generationRevision: row.generationRevision,
        sourceChapterVersion: row.sourceChapterVersion,
        sourceContentHash: row.sourceContentHash,
        status: row.status as DraftOperationStatus,
        phase: row.phase,
        version: row.version,
        attemptCount: row.attemptCount,
        maxAttempts: row.maxAttempts,
        operationDeadlineAt: asIso(row.operationDeadlineAt)!,
        ...(typeof row.progress === 'number' ? { progress: row.progress } : {}),
        ...(asIso(row.heartbeatAt) ? { heartbeatAt: asIso(row.heartbeatAt) } : {}),
        ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
        ...(asIso(row.leaseExpiresAt) ? { leaseExpiresAt: asIso(row.leaseExpiresAt) } : {}),
        ...(asIso(row.cancelRequestedAt) ? { cancelRequestedAt: asIso(row.cancelRequestedAt) } : {}),
        ...(row.generatedPayloadJson ? { generatedPayloadJson: row.generatedPayloadJson } : {}),
        ...(row.resultDraftSessionId ? { resultDraftSessionId: row.resultDraftSessionId } : {}),
        ...(row.resultJson ? { resultJson: row.resultJson } : {}),
        warningJson: row.warningJson || '[]',
        ...(row.errorCode ? { errorCode: row.errorCode } : {}),
        ...(row.errorJson ? { errorJson: row.errorJson } : {}),
        ...(row.sourceConversationId ? { sourceConversationId: row.sourceConversationId } : {}),
        ...(row.sourceRunId ? { sourceRunId: row.sourceRunId } : {}),
        ...(row.sourceStepId ? { sourceStepId: row.sourceStepId } : {}),
        createdAt: asIso(row.createdAt)!,
        ...(asIso(row.startedAt) ? { startedAt: asIso(row.startedAt) } : {}),
        ...(asIso(row.completedAt) ? { completedAt: asIso(row.completedAt) } : {}),
        updatedAt: asIso(row.updatedAt)!,
    };
}

const DATE_PATCH_FIELDS = new Set([
    'heartbeatAt',
    'leaseExpiresAt',
    'cancelRequestedAt',
    'startedAt',
    'completedAt',
]);

function toDatabasePatch(patch: Partial<DraftOperationRecord>): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
        if (['operationId', 'operationKey', 'operationType', 'createdAt', 'updatedAt', 'version'].includes(key)) continue;
        if (DATE_PATCH_FIELDS.has(key)) {
            data[key] = value === undefined ? null : new Date(String(value));
        } else {
            data[key] = value === undefined ? null : value;
        }
    }
    return data;
}

function assertSameParameters(record: DraftOperationRecord, input: CreateDraftOperationInput): DraftOperationRecord {
    if (record.paramsHash !== input.paramsHash) {
        throw createOperationError(
            'IDEMPOTENCY_CONFLICT',
            'The draft operation key already exists with different parameters',
            { operationId: record.operationId, operationKey: record.operationKey },
        );
    }
    return record;
}

export class DraftOperationStore {
    private schemaReady: Promise<void> | null = null;

    constructor(private readonly database: PrismaClientType = db) {}

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
        await this.database.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "DraftGenerationOperation" (
                "operationId" TEXT NOT NULL PRIMARY KEY,
                "operationKey" TEXT NOT NULL,
                "operationType" TEXT NOT NULL,
                "paramsHash" TEXT NOT NULL,
                "requestJson" TEXT NOT NULL,
                "novelId" TEXT NOT NULL,
                "volumeId" TEXT,
                "chapterId" TEXT NOT NULL,
                "draftBatchId" TEXT,
                "childIndex" INTEGER,
                "generationRevision" INTEGER NOT NULL,
                "sourceChapterVersion" INTEGER NOT NULL,
                "sourceContentHash" TEXT NOT NULL,
                "status" TEXT NOT NULL,
                "phase" TEXT NOT NULL,
                "version" INTEGER NOT NULL DEFAULT 1,
                "attemptCount" INTEGER NOT NULL DEFAULT 0,
                "maxAttempts" INTEGER NOT NULL DEFAULT 4,
                "operationDeadlineAt" DATETIME NOT NULL,
                "progress" REAL,
                "heartbeatAt" DATETIME,
                "leaseOwner" TEXT,
                "leaseExpiresAt" DATETIME,
                "cancelRequestedAt" DATETIME,
                "generatedPayloadJson" TEXT,
                "resultDraftSessionId" TEXT,
                "resultJson" TEXT,
                "warningJson" TEXT NOT NULL DEFAULT '[]',
                "errorCode" TEXT,
                "errorJson" TEXT,
                "sourceConversationId" TEXT,
                "sourceRunId" TEXT,
                "sourceStepId" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "startedAt" DATETIME,
                "completedAt" DATETIME,
                "updatedAt" DATETIME NOT NULL
            )
        `);
        const columns = await this.database.$queryRawUnsafe<Array<{ name: string }>>(
            'PRAGMA table_info("DraftGenerationOperation")',
        );
        if (!columns.some((column) => column.name === 'requestJson')) {
            await this.database.$executeRawUnsafe(
                'ALTER TABLE "DraftGenerationOperation" ADD COLUMN "requestJson" TEXT NOT NULL DEFAULT \'{}\'',
            );
        }
        await this.database.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "DraftGenerationAttempt" (
                "attemptId" TEXT NOT NULL PRIMARY KEY,
                "operationId" TEXT NOT NULL,
                "attemptNumber" INTEGER NOT NULL,
                "requestId" TEXT NOT NULL,
                "providerType" TEXT NOT NULL,
                "providerProfileId" TEXT,
                "model" TEXT NOT NULL,
                "providerRequestId" TEXT,
                "providerResponseId" TEXT,
                "status" TEXT NOT NULL,
                "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "firstByteAt" DATETIME,
                "lastChunkAt" DATETIME,
                "completedAt" DATETIME,
                "inputTokens" INTEGER,
                "outputTokens" INTEGER,
                "estimatedCost" REAL,
                "errorCode" TEXT,
                "errorJson" TEXT,
                CONSTRAINT "DraftGenerationAttempt_operationId_fkey"
                    FOREIGN KEY ("operationId") REFERENCES "DraftGenerationOperation" ("operationId")
                    ON DELETE CASCADE ON UPDATE CASCADE
            )
        `);
        await this.database.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "DraftOperationOutbox" (
                "outboxId" TEXT NOT NULL PRIMARY KEY,
                "operationId" TEXT NOT NULL,
                "eventType" TEXT NOT NULL,
                "payloadJson" TEXT NOT NULL,
                "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
                "attemptCount" INTEGER NOT NULL DEFAULT 0,
                "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "deliveredAt" DATETIME,
                CONSTRAINT "DraftOperationOutbox_operationId_fkey"
                    FOREIGN KEY ("operationId") REFERENCES "DraftGenerationOperation" ("operationId")
                    ON DELETE CASCADE ON UPDATE CASCADE
            )
        `);
        const statements = [
            'CREATE UNIQUE INDEX IF NOT EXISTS "DraftGenerationOperation_operationKey_key" ON "DraftGenerationOperation"("operationKey")',
            'CREATE UNIQUE INDEX IF NOT EXISTS "uq_draft_operation_batch_child_revision" ON "DraftGenerationOperation"("draftBatchId", "childIndex", "generationRevision")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_operation_status_lease" ON "DraftGenerationOperation"("status", "leaseExpiresAt")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_operation_novel_updated" ON "DraftGenerationOperation"("novelId", "updatedAt")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_operation_run_updated" ON "DraftGenerationOperation"("sourceRunId", "updatedAt")',
            'CREATE UNIQUE INDEX IF NOT EXISTS "uq_draft_attempt_operation_number" ON "DraftGenerationAttempt"("operationId", "attemptNumber")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_attempt_operation_status" ON "DraftGenerationAttempt"("operationId", "status")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_outbox_delivery_due" ON "DraftOperationOutbox"("deliveryStatus", "nextAttemptAt")',
            'CREATE INDEX IF NOT EXISTS "idx_draft_outbox_operation_created" ON "DraftOperationOutbox"("operationId", "createdAt")',
        ];
        for (const statement of statements) await this.database.$executeRawUnsafe(statement);
    }

    async createOrGet(input: CreateDraftOperationInput): Promise<{ operation: DraftOperationRecord; existing: boolean }> {
        const deadline = new Date(input.operationDeadlineAt);
        if (!Number.isFinite(deadline.getTime())) {
            throw createOperationError('INVALID_INPUT', 'operationDeadlineAt must be an ISO timestamp');
        }
        if (!input.operationKey || !input.paramsHash || !input.novelId || !input.chapterId) {
            throw createOperationError('INVALID_INPUT', 'Operation identity and target fields are required');
        }
        if (!Number.isInteger(input.generationRevision) || input.generationRevision < 1) {
            throw createOperationError('INVALID_INPUT', 'generationRevision must be a positive integer');
        }

        const existing = await this.database.draftGenerationOperation.findUnique({
            where: { operationKey: input.operationKey },
        });
        if (existing) return { operation: assertSameParameters(toRecord(existing), input), existing: true };

        try {
            const created = await this.database.draftGenerationOperation.create({
                data: {
                    operationId: `draftop_${randomUUID().replace(/-/gu, '')}`,
                    operationKey: input.operationKey,
                    operationType: 'chapter_draft',
                    paramsHash: input.paramsHash,
                    requestJson: input.requestJson,
                    novelId: input.novelId,
                    volumeId: input.volumeId,
                    chapterId: input.chapterId,
                    draftBatchId: input.draftBatchId,
                    childIndex: input.childIndex,
                    generationRevision: input.generationRevision,
                    sourceChapterVersion: input.sourceChapterVersion,
                    sourceContentHash: input.sourceContentHash,
                    status: 'queued',
                    phase: 'accepted',
                    maxAttempts: Math.max(1, input.maxAttempts ?? 4),
                    operationDeadlineAt: deadline,
                    warningJson: '[]',
                    sourceConversationId: input.sourceConversationId,
                    sourceRunId: input.sourceRunId,
                    sourceStepId: input.sourceStepId,
                },
            });
            return { operation: toRecord(created), existing: false };
        } catch (error) {
            const raced = await this.database.draftGenerationOperation.findFirst({
                where: {
                    OR: [
                        { operationKey: input.operationKey },
                        ...(input.draftBatchId && typeof input.childIndex === 'number'
                            ? [{
                                draftBatchId: input.draftBatchId,
                                childIndex: input.childIndex,
                                generationRevision: input.generationRevision,
                            }]
                            : []),
                    ],
                },
            });
            if (raced) {
                return { operation: assertSameParameters(toRecord(raced), input), existing: true };
            }
            throw error;
        }
    }

    async get(operationId: string): Promise<DraftOperationRecord> {
        const row = await this.database.draftGenerationOperation.findUnique({ where: { operationId } });
        if (!row) throw createOperationError('NOT_FOUND', `Draft operation ${operationId} was not found`);
        return toRecord(row);
    }

    async getByKey(operationKey: string): Promise<DraftOperationRecord | null> {
        const row = await this.database.draftGenerationOperation.findUnique({ where: { operationKey } });
        return row ? toRecord(row) : null;
    }

    async transition(
        operationId: string,
        expectedVersion: number,
        event: DraftOperationEvent,
    ): Promise<DraftOperationRecord> {
        return this.database.$transaction(async (tx) => {
            const currentRow = await tx.draftGenerationOperation.findUnique({ where: { operationId } });
            if (!currentRow) throw createOperationError('NOT_FOUND', `Draft operation ${operationId} was not found`);
            const current = toRecord(currentRow);
            if (current.version !== expectedVersion) {
                throw createOperationError('VERSION_CONFLICT', 'Draft operation version conflict', {
                    operationId,
                    expectedVersion,
                    actualVersion: current.version,
                });
            }
            return this.applyTransition(tx, current, expectedVersion, event);
        });
    }

    async commitSucceeded(
        operationId: string,
        expectedVersion: number,
        persistResult: (
            tx: Pick<PrismaClientType, '$executeRawUnsafe' | '$queryRawUnsafe'>,
            operation: DraftOperationRecord,
        ) => Promise<{ draftSessionId: string; draftBatchId?: string; childIndex?: number; generationRevision: number }>,
    ): Promise<DraftOperationRecord> {
        return this.database.$transaction(async (tx) => {
            const currentRow = await tx.draftGenerationOperation.findUnique({ where: { operationId } });
            if (!currentRow) throw createOperationError('NOT_FOUND', `Draft operation ${operationId} was not found`);
            const current = toRecord(currentRow);
            if (current.version !== expectedVersion) {
                throw createOperationError('VERSION_CONFLICT', 'Draft operation version conflict', {
                    operationId,
                    expectedVersion,
                    actualVersion: current.version,
                });
            }
            if (current.status !== 'committing') {
                throw createOperationError(
                    'INVALID_OPERATION_TRANSITION',
                    `Draft operation cannot commit from ${current.status}`,
                    { operationId, status: current.status },
                );
            }

            // persistResult participates in this exact transaction. If entity
            // persistence, the operation CAS, or outbox insertion fails, SQLite
            // rolls all three durable effects back together.
            const result = await persistResult(tx, current);
            return this.applyTransition(tx, current, expectedVersion, {
                type: 'COMMIT_SUCCEEDED',
                now: new Date().toISOString(),
                draftSessionId: result.draftSessionId,
                resultJson: JSON.stringify(result),
            });
        });
    }

    private async applyTransition(
        tx: DraftOperationTransaction,
        current: DraftOperationRecord,
        expectedVersion: number,
        event: DraftOperationEvent,
    ): Promise<DraftOperationRecord> {
        const operationId = current.operationId;
        const transition = transitionDraftOperation(current, event);
        if (!transition.changed) return current;
        if (event.type === 'COMMIT_SUCCEEDED') {
            const sessions = await tx.$queryRawUnsafe<Array<{
                sourceOperationId: string | null;
                draftBatchId: string | null;
                childIndex: number | null;
                generationRevision: number | null;
            }>>(
                `SELECT "sourceOperationId", "draftBatchId", "childIndex", "generationRevision"
                 FROM "DraftSession" WHERE "draftSessionId" = ?`,
                event.draftSessionId,
            );
            const session = sessions[0];
            if (
                !session
                || session.sourceOperationId !== operationId
                || session.generationRevision !== current.generationRevision
                || (current.draftBatchId ?? null) !== session.draftBatchId
                || (current.childIndex ?? null) !== session.childIndex
            ) {
                throw createOperationError(
                    'DRAFT_RESULT_NOT_COMMITTED',
                    'Draft result is not durably linked to this operation revision',
                    { operationId, draftSessionId: event.draftSessionId },
                );
            }
            if (current.draftBatchId && typeof current.childIndex === 'number') {
                const children = await tx.$queryRawUnsafe<Array<{
                    draftSessionId: string | null;
                    generationRevision: number;
                }>>(
                    `SELECT "draftSessionId", "generationRevision" FROM "DraftBatchChild"
                     WHERE "draftBatchId" = ? AND "childIndex" = ?`,
                    current.draftBatchId,
                    current.childIndex,
                );
                if (
                    children[0]?.draftSessionId !== event.draftSessionId
                    || children[0]?.generationRevision !== current.generationRevision
                ) {
                    throw createOperationError(
                        'DRAFT_BATCH_RESULT_NOT_COMMITTED',
                        'Draft batch child is not durably linked to this operation revision',
                        {
                            operationId,
                            draftSessionId: event.draftSessionId,
                            draftBatchId: current.draftBatchId,
                            childIndex: current.childIndex,
                        },
                    );
                }
            }
        }
        const changed = await tx.draftGenerationOperation.updateMany({
            where: { operationId, version: expectedVersion, status: current.status },
            data: {
                ...toDatabasePatch(transition.patch),
                version: { increment: 1 },
            },
        });
        if (changed.count !== 1) {
            throw createOperationError('VERSION_CONFLICT', 'Draft operation changed concurrently', {
                operationId,
                expectedVersion,
            });
        }
        const updatedRow = await tx.draftGenerationOperation.findUnique({ where: { operationId } });
        if (!updatedRow) throw createOperationError('PERSISTENCE_ERROR', 'Updated draft operation disappeared');
        const updated = toRecord(updatedRow);
        if (transition.emitCompletion) {
            await tx.draftOperationOutbox.create({
                data: {
                    outboxId: `draftout_${randomUUID().replace(/-/gu, '')}`,
                    operationId,
                    eventType: 'draft.operation.completed',
                    payloadJson: JSON.stringify({
                        operationId,
                        operationKey: updated.operationKey,
                        status: updated.status,
                        version: updated.version,
                        resultDraftSessionId: updated.resultDraftSessionId,
                        errorCode: updated.errorCode,
                    }),
                },
            });
        }
        return updated;
    }

    async startAttempt(input: DraftAttemptStartInput): Promise<void> {
        await this.database.draftGenerationAttempt.create({
            data: {
                attemptId: `draftattempt_${randomUUID().replace(/-/gu, '')}`,
                operationId: input.operationId,
                attemptNumber: input.attemptNumber,
                requestId: input.requestId,
                providerType: input.providerType,
                providerProfileId: input.providerProfileId,
                model: input.model,
                status: 'running',
            },
        });
    }

    async markAttemptActivity(
        operationId: string,
        attemptNumber: number,
        kind: 'first_byte' | 'chunk',
        at = new Date(),
    ): Promise<void> {
        await this.database.draftGenerationAttempt.update({
            where: { operationId_attemptNumber: { operationId, attemptNumber } },
            data: kind === 'first_byte' ? { firstByteAt: at, lastChunkAt: at } : { lastChunkAt: at },
        });
    }

    async completeAttempt(input: {
        operationId: string;
        attemptNumber: number;
        status: 'succeeded' | 'failed' | 'cancelled';
        providerRequestId?: string;
        providerResponseId?: string;
        inputTokens?: number;
        outputTokens?: number;
        estimatedCost?: number;
        errorCode?: string;
        errorJson?: string;
    }): Promise<void> {
        await this.database.draftGenerationAttempt.update({
            where: {
                operationId_attemptNumber: {
                    operationId: input.operationId,
                    attemptNumber: input.attemptNumber,
                },
            },
            data: {
                status: input.status,
                providerRequestId: input.providerRequestId,
                providerResponseId: input.providerResponseId,
                inputTokens: input.inputTokens,
                outputTokens: input.outputTokens,
                estimatedCost: input.estimatedCost,
                errorCode: input.errorCode,
                errorJson: input.errorJson,
                completedAt: new Date(),
            },
        });
    }

    async listRecoverable(limit = 100): Promise<DraftOperationRecord[]> {
        const rows = await this.database.draftGenerationOperation.findMany({
            where: {
                status: {
                    in: [
                        'queued',
                        'retry_wait',
                        'running_generation',
                        'running_postprocess',
                        'committing',
                        'cancel_requested',
                    ],
                },
            },
            orderBy: { updatedAt: 'asc' },
            take: Math.max(1, Math.min(limit, 1000)),
        });
        return rows.map(toRecord);
    }

    async listPendingOutbox(limit = 100): Promise<Array<{
        outboxId: string;
        operationId: string;
        eventType: string;
        payloadJson: string;
        attemptCount: number;
    }>> {
        return this.database.draftOperationOutbox.findMany({
            where: { deliveryStatus: 'pending', nextAttemptAt: { lte: new Date() } },
            orderBy: { createdAt: 'asc' },
            take: Math.max(1, Math.min(limit, 1000)),
            select: {
                outboxId: true,
                operationId: true,
                eventType: true,
                payloadJson: true,
                attemptCount: true,
            },
        });
    }

    async markOutboxDelivered(outboxId: string): Promise<void> {
        await this.database.draftOperationOutbox.update({
            where: { outboxId },
            data: { deliveryStatus: 'delivered', deliveredAt: new Date() },
        });
    }

    async rescheduleOutbox(outboxId: string, attemptCount: number, nextAttemptAt: Date): Promise<void> {
        await this.database.draftOperationOutbox.update({
            where: { outboxId },
            data: { deliveryStatus: 'pending', attemptCount, nextAttemptAt },
        });
    }
}
