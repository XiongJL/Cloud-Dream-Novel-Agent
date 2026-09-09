import { randomUUID } from 'node:crypto';
import {
    isDraftOperationTerminal,
    projectDraftOperation,
    type DraftOperationError,
    type DraftOperationRecord,
    type DraftOperationResultRef,
    type DraftOperationView,
} from '../../shared/draftOperation';
import { DraftOperationStore, type CreateDraftOperationInput } from './DraftOperationStore';

type ProviderDescriptor = {
    providerType: string;
    providerProfileId?: string;
    model: string;
};

type DraftOperationDependencies = {
    execute: (
        operation: DraftOperationRecord,
        payload: Record<string, unknown>,
        signal: AbortSignal,
    ) => Promise<unknown>;
    commitPrepared?: (
        operation: DraftOperationRecord,
        prepared: unknown,
    ) => Promise<DraftOperationRecord>;
    findExistingResult: (operationId: string) => Promise<DraftOperationResultRef | null>;
    getProvider: () => ProviderDescriptor;
    onStateChange?: (view: DraftOperationView) => void;
    deliverCompletion?: (event: {
        outboxId: string;
        operationId: string;
        eventType: string;
        payload: Record<string, unknown>;
    }) => Promise<void>;
};

const RETRYABLE_CODES = new Set([
    'NETWORK_ERROR',
    'PROVIDER_TIMEOUT',
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_UNAVAILABLE',
    'UPSTREAM_TIMEOUT',
]);
const LEASE_DURATION_MS = 90_000;
const HEARTBEAT_INTERVAL_MS = 20_000;

function asOperationError(operation: DraftOperationRecord, error: unknown): DraftOperationError {
    const source = error as {
        code?: string;
        message?: string;
        details?: Record<string, unknown> & { retryable?: boolean; providerRequestId?: string };
    };
    const code = String(source?.code || 'UNKNOWN');
    return {
        code,
        retryEligible: source?.details?.retryable === true || RETRYABLE_CODES.has(code),
        userMessage: String(source?.message || '草稿生成失败。'),
        diagnosticRef: operation.operationId,
        attempt: operation.attemptCount,
        ...(source?.details?.providerRequestId ? { providerRequestId: source.details.providerRequestId } : {}),
        ...(source?.details ? {
            details: Object.fromEntries(
                [
                    'modelResultRef',
                    'modelResultRevision',
                    'resultHash',
                    'terminationReason',
                    'responseId',
                    'model',
                    'usage',
                    'requestedMaxTokens',
                    'attemptCount',
                    'attempts',
                    'safeToRetryBeforePublish',
                    'incomplete',
                ]
                    .filter((key) => key in source.details!)
                    .map((key) => [key, source.details![key]]),
            ),
        } : {}),
    };
}

function retryDelayMs(attemptCount: number): number {
    return Math.min(30_000, 1_000 * (2 ** Math.max(0, attemptCount - 1)));
}

export class DraftOperationCoordinator {
    private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
    private readonly retryTimers = new Map<string, NodeJS.Timeout>();
    private readonly workerFailureCounts = new Map<string, number>();
    private readonly workerId = `draft-worker-${randomUUID()}`;
    private outboxTimer: NodeJS.Timeout | undefined;
    private outboxDraining = false;
    private shuttingDown = false;

    constructor(
        private readonly store: DraftOperationStore,
        private readonly dependencies: DraftOperationDependencies,
    ) {}

    async initialize(): Promise<void> {
        this.shuttingDown = false;
        await this.store.ensureSchema();
        const recoverable = await this.store.listRecoverable();
        for (const operation of recoverable) {
            if (operation.status === 'queued' || operation.status === 'retry_wait') {
                this.schedule(operation.operationId, operation.status === 'retry_wait' ? operation.leaseExpiresAt : undefined);
                continue;
            }
            await this.recoverExpired(operation);
        }
        this.scheduleOutboxDelivery(0);
    }

    async start(input: CreateDraftOperationInput): Promise<{ operation: DraftOperationView; existing: boolean }> {
        const created = await this.store.createOrGet(input);
        if (created.operation.status === 'queued' || created.operation.status === 'retry_wait') {
            this.schedule(
                created.operation.operationId,
                created.operation.status === 'retry_wait' ? created.operation.leaseExpiresAt : undefined,
            );
        }
        return { operation: projectDraftOperation(created.operation), existing: created.existing };
    }

    async get(operationId: string): Promise<DraftOperationView> {
        return projectDraftOperation(await this.store.get(operationId));
    }

    async cancel(operationId: string, expectedVersion?: number): Promise<DraftOperationView> {
        const current = await this.store.get(operationId);
        if (isDraftOperationTerminal(current.status) || current.status === 'committing') {
            return projectDraftOperation(current);
        }
        const updated = await this.store.transition(
            operationId,
            expectedVersion === current.version ? expectedVersion : current.version,
            { type: 'CANCEL_REQUEST', now: new Date().toISOString() },
        );
        const retryTimer = this.retryTimers.get(operationId);
        if (retryTimer) clearTimeout(retryTimer);
        this.retryTimers.delete(operationId);
        this.active.get(operationId)?.controller.abort(
            Object.assign(new Error('Draft operation cancelled'), { code: 'CANCELLED' }),
        );
        this.emit(updated);
        return projectDraftOperation(updated);
    }

    async retry(operationId: string, expectedVersion?: number): Promise<DraftOperationView> {
        const current = await this.store.get(operationId);
        const updated = await this.store.transition(
            operationId,
            expectedVersion ?? current.version,
            { type: 'RETRY_REQUESTED', now: new Date().toISOString() },
        );
        this.emit(updated);
        this.schedule(operationId);
        return projectDraftOperation(updated);
    }

    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        if (this.outboxTimer) clearTimeout(this.outboxTimer);
        this.outboxTimer = undefined;
        for (const timer of this.retryTimers.values()) clearTimeout(timer);
        this.retryTimers.clear();
        for (const active of this.active.values()) {
            active.controller.abort(Object.assign(new Error('Draft operation worker shutting down'), { code: 'CANCELLED' }));
        }
        await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
    }

    private emit(operation: DraftOperationRecord): void {
        this.dependencies.onStateChange?.(projectDraftOperation(operation));
        if (isDraftOperationTerminal(operation.status)) this.scheduleOutboxDelivery(0);
    }

    private scheduleOutboxDelivery(delayMs: number): void {
        if (!this.dependencies.deliverCompletion || this.shuttingDown) return;
        if (this.outboxTimer) clearTimeout(this.outboxTimer);
        this.outboxTimer = setTimeout(() => {
            this.outboxTimer = undefined;
            void this.drainCompletionOutbox();
        }, Math.max(0, delayMs));
        this.outboxTimer.unref?.();
    }

    private async drainCompletionOutbox(): Promise<void> {
        if (!this.dependencies.deliverCompletion || this.outboxDraining || this.shuttingDown) return;
        this.outboxDraining = true;
        try {
            const entries = await this.store.listPendingOutbox(100);
            for (const entry of entries) {
                try {
                    const parsed = JSON.parse(entry.payloadJson) as unknown;
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        throw new Error('Draft completion outbox payload is invalid');
                    }
                    await this.dependencies.deliverCompletion({
                        outboxId: entry.outboxId,
                        operationId: entry.operationId,
                        eventType: entry.eventType,
                        payload: parsed as Record<string, unknown>,
                    });
                    await this.store.markOutboxDelivered(entry.outboxId);
                } catch (error) {
                    const attemptCount = entry.attemptCount + 1;
                    const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(attemptCount - 1, 5)));
                    await this.store.rescheduleOutbox(
                        entry.outboxId,
                        attemptCount,
                        new Date(Date.now() + delayMs),
                    );
                    console.warn('[DraftOperation] Failed to deliver completion; retry scheduled', {
                        outboxId: entry.outboxId,
                        operationId: entry.operationId,
                        attemptCount,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        } catch (error) {
            console.warn('[DraftOperation] Completion outbox drain failed; retry scheduled', {
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            this.outboxDraining = false;
            // Periodic fallback covers process startup ordering and notifications
            // created while a drain was already in progress.
            this.scheduleOutboxDelivery(5_000);
        }
    }

    private schedule(operationId: string, notBefore?: string): void {
        const existingTimer = this.retryTimers.get(operationId);
        if (existingTimer) clearTimeout(existingTimer);
        const delay = notBefore ? Math.max(0, Date.parse(notBefore) - Date.now()) : 0;
        const timer = setTimeout(() => {
            this.retryTimers.delete(operationId);
            if (this.active.has(operationId)) {
                this.schedule(operationId, new Date(Date.now() + 50).toISOString());
                return;
            }
            const controller = new AbortController();
            const promise = this.run(operationId, controller.signal)
                .then(() => {
                    this.workerFailureCounts.delete(operationId);
                })
                .catch((error) => {
                    const failureCount = (this.workerFailureCounts.get(operationId) || 0) + 1;
                    this.workerFailureCounts.set(operationId, failureCount);
                    const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(failureCount - 1, 5)));
                    console.warn('[DraftOperation] Worker run failed before completion; retry scheduled', {
                        operationId,
                        failureCount,
                        delayMs,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    if (!this.shuttingDown) {
                        this.schedule(operationId, new Date(Date.now() + delayMs).toISOString());
                    }
                })
                .finally(() => this.active.delete(operationId));
            this.active.set(operationId, { controller, promise });
        }, delay);
        timer.unref?.();
        this.retryTimers.set(operationId, timer);
    }

    private async recoverExpired(operation: DraftOperationRecord): Promise<void> {
        const existing = await this.dependencies.findExistingResult(operation.operationId);
        if (existing) {
            await this.finalizeExisting(operation, existing);
            return;
        }
        if (
            this.dependencies.commitPrepared
            && operation.generatedPayloadJson
            && ['running_postprocess', 'committing', 'cancel_requested'].includes(operation.status)
        ) {
            try {
                await this.finalizePrepared(operation, JSON.parse(operation.generatedPayloadJson) as unknown);
                return;
            } catch (error) {
                const refreshed = await this.store.get(operation.operationId);
                if (isDraftOperationTerminal(refreshed.status)) return;
                if (refreshed.status === 'committing') {
                    const normalized = asOperationError(refreshed, error);
                    const rejected = await this.store.transition(refreshed.operationId, refreshed.version, {
                        type: 'COMMIT_REJECTED',
                        now: new Date().toISOString(),
                        errorCode: normalized.code,
                        errorJson: JSON.stringify({ ...normalized, retryEligible: false }),
                    });
                    this.emit(rejected);
                    return;
                }
                operation = refreshed;
            }
        }
        if (operation.status === 'cancel_requested') {
            await this.store.completeAttempt({
                operationId: operation.operationId,
                attemptNumber: operation.attemptCount,
                status: 'cancelled',
                errorCode: 'WORKER_RESTARTED_AFTER_CANCEL',
                errorJson: JSON.stringify({
                    code: 'WORKER_RESTARTED_AFTER_CANCEL',
                    retryEligible: false,
                    userMessage: '取消请求已在应用恢复时确认。',
                    diagnosticRef: operation.operationId,
                }),
            }).catch(() => undefined);
            const cancelled = await this.store.transition(operation.operationId, operation.version, {
                type: 'ABORT_CONFIRMED',
                now: new Date().toISOString(),
            });
            this.emit(cancelled);
            return;
        }
        if (operation.status === 'running_generation') {
            await this.store.completeAttempt({
                operationId: operation.operationId,
                attemptNumber: operation.attemptCount,
                status: 'failed',
                errorCode: 'WORKER_RESTARTED',
                errorJson: JSON.stringify({
                    code: 'WORKER_RESTARTED',
                    retryEligible: true,
                    userMessage: '生成进程中断，任务将在恢复后重试。',
                    diagnosticRef: operation.operationId,
                }),
            }).catch(() => undefined);
            const now = new Date();
            const retryAt = new Date(now.getTime() + retryDelayMs(operation.attemptCount));
            const updated = await this.store.transition(operation.operationId, operation.version, {
                type: 'RETRYABLE_FAILURE',
                now: now.toISOString(),
                retryAt: retryAt.toISOString(),
                errorCode: 'WORKER_RESTARTED',
                errorJson: JSON.stringify({
                    code: 'WORKER_RESTARTED',
                    retryEligible: true,
                    userMessage: '草稿生成进程已恢复，任务将重新尝试。',
                    diagnosticRef: operation.operationId,
                }),
            });
            this.emit(updated);
            this.schedule(updated.operationId, updated.leaseExpiresAt);
            return;
        }
        const updated = await this.store.transition(operation.operationId, operation.version, {
            type: 'RECONCILIATION_REQUIRED',
            now: new Date().toISOString(),
            errorCode: 'RECOVERY_STATE_INCOMPLETE',
            errorJson: JSON.stringify({
                code: 'RECOVERY_STATE_INCOMPLETE',
                retryEligible: false,
                userMessage: '草稿任务的恢复数据不完整，需要人工处理。',
                diagnosticRef: operation.operationId,
            }),
        });
        this.emit(updated);
    }

    private async finalizeExisting(
        initial: DraftOperationRecord,
        result: DraftOperationResultRef,
    ): Promise<DraftOperationRecord> {
        let current = initial;
        const now = new Date().toISOString();
        if (current.status === 'running_generation') {
            current = await this.store.transition(current.operationId, current.version, {
                type: 'GENERATION_SUCCEEDED',
                now,
                generatedPayloadJson: JSON.stringify(result),
            });
        }
        if (current.status === 'running_postprocess') {
            current = await this.store.transition(current.operationId, current.version, {
                type: 'POSTPROCESS_COMPLETED',
                now,
            });
        }
        if (current.status === 'cancel_requested') {
            current = await this.store.transition(current.operationId, current.version, {
                type: 'RESULT_WON_RACE',
                now,
            });
        }
        if (current.status !== 'committing') return current;
        current = await this.store.transition(current.operationId, current.version, {
            type: 'COMMIT_SUCCEEDED',
            now,
            draftSessionId: result.draftSessionId,
            resultJson: JSON.stringify(result),
        });
        this.emit(current);
        return current;
    }

    private async finalizePrepared(
        initial: DraftOperationRecord,
        prepared: unknown,
    ): Promise<DraftOperationRecord> {
        let current = initial;
        const now = new Date().toISOString();
        if (current.status === 'running_generation') {
            current = await this.store.transition(current.operationId, current.version, {
                type: 'GENERATION_SUCCEEDED',
                now,
                generatedPayloadJson: JSON.stringify(prepared),
            });
        }
        if (current.status === 'running_postprocess') {
            current = await this.store.transition(current.operationId, current.version, {
                type: 'POSTPROCESS_COMPLETED',
                now,
            });
        }
        if (current.status === 'cancel_requested') {
            current = await this.store.transition(current.operationId, current.version, {
                type: 'RESULT_WON_RACE',
                now,
            });
        }
        if (current.status !== 'committing') return current;
        if (this.dependencies.commitPrepared) {
            current = await this.dependencies.commitPrepared(current, prepared);
            this.emit(current);
            return current;
        }
        const result = prepared as DraftOperationResultRef;
        if (!result || typeof result.draftSessionId !== 'string') {
            throw Object.assign(new Error('Draft operation result is invalid'), { code: 'INVALID_DRAFT_RESULT' });
        }
        return this.finalizeExisting(current, result);
    }

    private async run(operationId: string, signal: AbortSignal): Promise<void> {
        let operation = await this.store.get(operationId);
        if (isDraftOperationTerminal(operation.status)) return;
        if (Date.now() >= Date.parse(operation.operationDeadlineAt)) {
            const failure = {
                code: 'OPERATION_DEADLINE_EXCEEDED',
                retryEligible: false,
                userMessage: '草稿生成超过总时限。',
                diagnosticRef: operation.operationId,
            };
            operation = await this.store.transition(operationId, operation.version, {
                type: 'TERMINAL_FAILURE',
                now: new Date().toISOString(),
                errorCode: failure.code,
                errorJson: JSON.stringify(failure),
            });
            this.emit(operation);
            return;
        }

        const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
        if (operation.status === 'queued') {
            operation = await this.store.transition(operationId, operation.version, {
                type: 'CLAIM',
                now: new Date().toISOString(),
                workerId: this.workerId,
                leaseExpiresAt,
            });
        } else if (operation.status === 'retry_wait') {
            operation = await this.store.transition(operationId, operation.version, {
                type: 'RETRY_DUE',
                now: new Date().toISOString(),
                workerId: this.workerId,
                leaseExpiresAt,
            });
        } else {
            return;
        }
        this.emit(operation);

        const provider = this.dependencies.getProvider();
        const requestId = `draftrequest_${randomUUID().replace(/-/gu, '')}`;
        await this.store.startAttempt({
            operationId,
            attemptNumber: operation.attemptCount,
            requestId,
            providerType: provider.providerType,
            providerProfileId: provider.providerProfileId,
            model: provider.model,
        });

        let heartbeatTimer: NodeJS.Timeout | undefined;
        let heartbeatTail: Promise<void> = Promise.resolve();
        const heartbeat = (): void => {
            heartbeatTail = heartbeatTail.then(async () => {
                const current = await this.store.get(operationId);
                if (current.status !== 'running_generation' || current.leaseOwner !== this.workerId) return;
                const refreshed = await this.store.transition(operationId, current.version, {
                    type: 'HEARTBEAT',
                    now: new Date().toISOString(),
                    workerId: this.workerId,
                    leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS).toISOString(),
                    progress: current.progress,
                });
                this.emit(refreshed);
            }).catch(() => undefined);
        };
        const stopHeartbeat = async (): Promise<void> => {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
            await heartbeatTail;
        };
        heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
        heartbeatTimer.unref?.();

        try {
            const payload = JSON.parse(operation.requestJson) as Record<string, unknown>;
            const prepared = await this.dependencies.execute(operation, payload, signal);
            await stopHeartbeat();
            await this.store.completeAttempt({
                operationId,
                attemptNumber: operation.attemptCount,
                status: 'succeeded',
            });
            operation = await this.store.get(operationId);
            await this.finalizePrepared(operation, prepared);
        } catch (error) {
            await stopHeartbeat();
            operation = await this.store.get(operationId);
            const normalized = asOperationError(operation, error);
            await this.store.completeAttempt({
                operationId,
                attemptNumber: operation.attemptCount,
                status: normalized.code === 'CANCELLED' ? 'cancelled' : 'failed',
                errorCode: normalized.code,
                errorJson: JSON.stringify(normalized),
            }).catch(() => undefined);

            if (operation.status === 'committing') {
                operation = await this.store.transition(operationId, operation.version, {
                    type: 'COMMIT_REJECTED',
                    now: new Date().toISOString(),
                    errorCode: normalized.code,
                    errorJson: JSON.stringify({ ...normalized, retryEligible: false }),
                });
                this.emit(operation);
                return;
            }

            if (operation.status === 'cancel_requested' || normalized.code === 'CANCELLED') {
                if (operation.status === 'cancel_requested') {
                    operation = await this.store.transition(operationId, operation.version, {
                        type: 'ABORT_CONFIRMED',
                        now: new Date().toISOString(),
                    });
                    this.emit(operation);
                }
                return;
            }

            const canRetry = normalized.retryEligible
                && operation.attemptCount < operation.maxAttempts
                && Date.now() + retryDelayMs(operation.attemptCount) < Date.parse(operation.operationDeadlineAt);
            if (canRetry) {
                const retryAt = new Date(Date.now() + retryDelayMs(operation.attemptCount)).toISOString();
                operation = await this.store.transition(operationId, operation.version, {
                    type: 'RETRYABLE_FAILURE',
                    now: new Date().toISOString(),
                    retryAt,
                    errorCode: normalized.code,
                    errorJson: JSON.stringify(normalized),
                });
                this.emit(operation);
                this.schedule(operationId, retryAt);
                return;
            }

            operation = await this.store.transition(operationId, operation.version, {
                type: 'TERMINAL_FAILURE',
                now: new Date().toISOString(),
                errorCode: normalized.code,
                errorJson: JSON.stringify({ ...normalized, retryEligible: false }),
            });
            this.emit(operation);
        } finally {
            await stopHeartbeat();
        }
    }
}
