import { createHash } from 'node:crypto';
import type { PrismaClientType } from '@novel-editor/core';
import type { AgentStructuredOutputContract } from './AgentStructuredOutputContracts';

const MAX_RAW_RESULT_BYTES = 4 * 1024 * 1024;

export type AgentModelResultRecord = {
    modelResultRef: string;
    requestId: string;
    revision: number;
    sourceMethod: string;
    contractId: string;
    contractVersion: string;
    rawText: string;
    resultHash: string;
    repairAttemptId?: string;
    repairedFromRevision?: number;
};

export type AgentModelRepairClaim = {
    status: 'claimed' | 'in_progress' | 'completed' | 'failed';
    result?: AgentModelResultRecord;
};

type AgentModelResultRow = {
    requestId: string;
    revision: number;
    sourceMethod: string;
    contractId: string;
    contractVersion: string;
    rawText: string;
    resultHash: string;
    repairAttemptId: string | null;
    repairedFromRevision: number | null;
};

function toRecord(row: AgentModelResultRow): AgentModelResultRecord {
    return {
        modelResultRef: row.requestId,
        requestId: row.requestId,
        revision: Number(row.revision),
        sourceMethod: row.sourceMethod,
        contractId: row.contractId,
        contractVersion: row.contractVersion,
        rawText: row.rawText,
        resultHash: row.resultHash,
        ...(row.repairAttemptId ? { repairAttemptId: row.repairAttemptId } : {}),
        ...(row.repairedFromRevision !== null ? { repairedFromRevision: Number(row.repairedFromRevision) } : {}),
    };
}

export class AgentModelResultStore {
    private schemaReady: Promise<void> | null = null;

    constructor(private readonly database: PrismaClientType) {}

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
            CREATE TABLE IF NOT EXISTS "AgentModelResultCheckpoint" (
                "requestId" TEXT NOT NULL,
                "revision" INTEGER NOT NULL,
                "sourceMethod" TEXT NOT NULL,
                "contractId" TEXT NOT NULL,
                "contractVersion" TEXT NOT NULL,
                "rawText" TEXT NOT NULL,
                "resultHash" TEXT NOT NULL,
                "repairAttemptId" TEXT,
                "repairedFromRevision" INTEGER,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY ("requestId", "revision")
            )
        `);
        await this.database.$executeRawUnsafe(
            'CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_model_result_repair_attempt" ON "AgentModelResultCheckpoint"("repairAttemptId") WHERE "repairAttemptId" IS NOT NULL',
        );
        await this.database.$executeRawUnsafe(
            'CREATE INDEX IF NOT EXISTS "idx_agent_model_result_created" ON "AgentModelResultCheckpoint"("createdAt")',
        );
        await this.database.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "AgentModelRepairAttempt" (
                "repairAttemptId" TEXT NOT NULL PRIMARY KEY,
                "requestId" TEXT NOT NULL,
                "repairAttempt" INTEGER NOT NULL,
                "status" TEXT NOT NULL,
                "resultRevision" INTEGER,
                "errorCode" TEXT,
                "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    async save(
        requestId: string,
        sourceMethod: string,
        contract: AgentStructuredOutputContract,
        rawText: string,
        options: { repairAttemptId?: string; repairedFromRevision?: number } = {},
    ): Promise<AgentModelResultRecord> {
        await this.ensureSchema();
        if (Buffer.byteLength(rawText, 'utf8') > MAX_RAW_RESULT_BYTES) {
            throw Object.assign(new Error('Structured model result exceeds the 4 MiB checkpoint limit'), {
                code: 'MODEL_RESULT_TOO_LARGE',
            });
        }
        if (options.repairAttemptId) {
            const existing = await this.findByRepairAttempt(options.repairAttemptId);
            if (existing) return existing;
        }
        const rows = await this.database.$queryRawUnsafe<Array<{ revision: number | bigint | null }>>(
            'SELECT MAX("revision") AS revision FROM "AgentModelResultCheckpoint" WHERE "requestId" = ?',
            requestId,
        );
        const revision = Number(rows[0]?.revision ?? 0) + 1;
        const resultHash = createHash('sha256').update(rawText, 'utf8').digest('hex');
        await this.database.$executeRawUnsafe(
            `INSERT INTO "AgentModelResultCheckpoint" (
                "requestId", "revision", "sourceMethod", "contractId", "contractVersion",
                "rawText", "resultHash", "repairAttemptId", "repairedFromRevision"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            requestId, revision, sourceMethod, contract.contractId, contract.version,
            rawText, resultHash, options.repairAttemptId ?? null, options.repairedFromRevision ?? null,
        );
        return {
            modelResultRef: requestId,
            requestId,
            revision,
            sourceMethod,
            contractId: contract.contractId,
            contractVersion: contract.version,
            rawText,
            resultHash,
            ...options,
        };
    }

    async getLatest(modelResultRef: string): Promise<AgentModelResultRecord | null> {
        await this.ensureSchema();
        const rows = await this.database.$queryRawUnsafe<AgentModelResultRow[]>(
            `SELECT "requestId", "revision", "sourceMethod", "contractId", "contractVersion",
                    "rawText", "resultHash", "repairAttemptId", "repairedFromRevision"
             FROM "AgentModelResultCheckpoint" WHERE "requestId" = ? ORDER BY "revision" DESC LIMIT 1`,
            modelResultRef,
        );
        return rows[0] ? toRecord(rows[0]) : null;
    }

    async findByRepairAttempt(repairAttemptId: string): Promise<AgentModelResultRecord | null> {
        await this.ensureSchema();
        const rows = await this.database.$queryRawUnsafe<AgentModelResultRow[]>(
            `SELECT "requestId", "revision", "sourceMethod", "contractId", "contractVersion",
                    "rawText", "resultHash", "repairAttemptId", "repairedFromRevision"
             FROM "AgentModelResultCheckpoint" WHERE "repairAttemptId" = ? LIMIT 1`,
            repairAttemptId,
        );
        return rows[0] ? toRecord(rows[0]) : null;
    }

    async claimRepairAttempt(
        repairAttemptId: string,
        requestId: string,
        repairAttempt: 1 | 2,
    ): Promise<AgentModelRepairClaim> {
        await this.ensureSchema();
        const inserted = await this.database.$executeRawUnsafe(
            `INSERT OR IGNORE INTO "AgentModelRepairAttempt" (
                "repairAttemptId", "requestId", "repairAttempt", "status"
            ) VALUES (?, ?, ?, 'in_progress')`,
            repairAttemptId, requestId, repairAttempt,
        );
        if (Number(inserted) > 0) return { status: 'claimed' };
        const rows = await this.database.$queryRawUnsafe<Array<{
            requestId: string;
            status: string;
            resultRevision: number | null;
        }>>(
            'SELECT "requestId", "status", "resultRevision" FROM "AgentModelRepairAttempt" WHERE "repairAttemptId" = ?',
            repairAttemptId,
        );
        const existing = rows[0];
        if (!existing || existing.requestId !== requestId) return { status: 'failed' };
        if (existing.status === 'completed') {
            const result = await this.findByRepairAttempt(repairAttemptId);
            return result ? { status: 'completed', result } : { status: 'failed' };
        }
        if (existing.status === 'in_progress') {
            // The model response may have been checkpointed immediately before
            // the caller lost the reply. Reconcile that durable result instead
            // of issuing a second repair request and charging twice.
            const result = await this.findByRepairAttempt(repairAttemptId);
            if (result) {
                await this.completeRepairAttempt(repairAttemptId, result.revision);
                return { status: 'completed', result };
            }
        }
        return { status: existing.status === 'failed' ? 'failed' : 'in_progress' };
    }

    async completeRepairAttempt(repairAttemptId: string, resultRevision: number): Promise<void> {
        await this.ensureSchema();
        await this.database.$executeRawUnsafe(
            `UPDATE "AgentModelRepairAttempt"
             SET "status" = 'completed', "resultRevision" = ?, "updatedAt" = CURRENT_TIMESTAMP
             WHERE "repairAttemptId" = ? AND "status" = 'in_progress'`,
            resultRevision, repairAttemptId,
        );
    }

    async failRepairAttempt(repairAttemptId: string, errorCode: string): Promise<void> {
        await this.ensureSchema();
        await this.database.$executeRawUnsafe(
            `UPDATE "AgentModelRepairAttempt"
             SET "status" = 'failed', "errorCode" = ?, "updatedAt" = CURRENT_TIMESTAMP
             WHERE "repairAttemptId" = ? AND "status" = 'in_progress'`,
            errorCode.slice(0, 100), repairAttemptId,
        );
    }
}
