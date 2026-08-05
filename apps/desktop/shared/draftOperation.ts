export type DraftOperationStatus =
    | 'queued'
    | 'running_generation'
    | 'retry_wait'
    | 'running_postprocess'
    | 'committing'
    | 'cancel_requested'
    | 'succeeded'
    | 'definitive_failed'
    | 'cancelled'
    | 'reconcile_required';

export type DraftOperationPhase =
    | 'accepted'
    | 'generating'
    | 'postprocessing'
    | 'committing'
    | 'terminal';

export type DraftOperationError = {
    code: string;
    retryEligible: boolean;
    userMessage: string;
    diagnosticRef: string;
    attempt?: number;
    providerRequestId?: string;
};

export type DraftOperationResultRef = {
    draftSessionId: string;
    draftBatchId?: string;
    childIndex?: number;
    generationRevision: number;
};

export type DraftOperationView = {
    operationId: string;
    operationKey: string;
    status: DraftOperationStatus;
    phase: DraftOperationPhase;
    version: number;
    attempt: number;
    maxAttempts: number;
    progress?: number;
    heartbeatAt?: string;
    retryAt?: string;
    operationDeadlineAt: string;
    result?: DraftOperationResultRef;
    warnings: string[];
    error?: DraftOperationError;
    createdAt: string;
    updatedAt: string;
};

export type DraftOperationRecord = {
    operationId: string;
    operationKey: string;
    operationType: 'chapter_draft';
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
    status: DraftOperationStatus;
    phase: DraftOperationPhase;
    version: number;
    attemptCount: number;
    maxAttempts: number;
    operationDeadlineAt: string;
    progress?: number;
    heartbeatAt?: string;
    leaseOwner?: string;
    leaseExpiresAt?: string;
    cancelRequestedAt?: string;
    generatedPayloadJson?: string;
    resultDraftSessionId?: string;
    resultJson?: string;
    warningJson: string;
    errorCode?: string;
    errorJson?: string;
    sourceConversationId?: string;
    sourceRunId?: string;
    sourceStepId?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    updatedAt: string;
};

export type DraftOperationEvent =
    | { type: 'CLAIM'; now: string; workerId: string; leaseExpiresAt: string }
    | { type: 'HEARTBEAT'; now: string; workerId: string; leaseExpiresAt: string; progress?: number }
    | { type: 'GENERATION_SUCCEEDED'; now: string; generatedPayloadJson: string }
    | { type: 'RETRYABLE_FAILURE'; now: string; retryAt: string; errorCode: string; errorJson: string }
    | { type: 'TERMINAL_FAILURE'; now: string; errorCode: string; errorJson: string }
    | { type: 'RETRY_DUE'; now: string; workerId: string; leaseExpiresAt: string }
    | { type: 'POSTPROCESS_COMPLETED'; now: string; generatedPayloadJson?: string; warningJson?: string }
    | { type: 'CANCEL_REQUEST'; now: string }
    | { type: 'ABORT_CONFIRMED'; now: string }
    | { type: 'RESULT_WON_RACE'; now: string }
    | { type: 'COMMIT_SUCCEEDED'; now: string; draftSessionId: string; resultJson: string }
    | { type: 'COMMIT_REJECTED'; now: string; errorCode: string; errorJson: string }
    | { type: 'RETRY_REQUESTED'; now: string }
    | { type: 'RECONCILIATION_REQUIRED'; now: string; errorCode: string; errorJson: string };

export type DraftOperationTransition = {
    changed: boolean;
    nextStatus: DraftOperationStatus;
    patch: Partial<DraftOperationRecord>;
    emitCompletion: boolean;
};

const TERMINAL_STATUSES = new Set<DraftOperationStatus>([
    'succeeded',
    'definitive_failed',
    'cancelled',
    'reconcile_required',
]);

export function isDraftOperationTerminal(status: DraftOperationStatus): boolean {
    return TERMINAL_STATUSES.has(status);
}

export function phaseForDraftOperationStatus(status: DraftOperationStatus): DraftOperationPhase {
    switch (status) {
        case 'queued':
        case 'retry_wait':
            return 'accepted';
        case 'running_generation':
        case 'cancel_requested':
            return 'generating';
        case 'running_postprocess':
            return 'postprocessing';
        case 'committing':
            return 'committing';
        default:
            return 'terminal';
    }
}

function parseJsonArray(value: string): string[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

export function projectDraftOperation(record: DraftOperationRecord): DraftOperationView {
    let result: DraftOperationResultRef | undefined;
    if (record.resultJson) {
        try {
            const parsed = JSON.parse(record.resultJson) as DraftOperationResultRef;
            if (parsed && typeof parsed.draftSessionId === 'string') result = parsed;
        } catch {
            // A corrupt result remains diagnosable through reconcile_required.
        }
    }
    let error: DraftOperationError | undefined;
    if (record.errorJson) {
        try {
            const parsed = JSON.parse(record.errorJson) as DraftOperationError;
            if (parsed && typeof parsed.code === 'string') error = parsed;
        } catch {
            // Preserve the normalized error code even if diagnostic JSON is corrupt.
        }
    }
    if (!error && record.errorCode) {
        error = {
            code: record.errorCode,
            retryEligible: false,
            userMessage: '草稿生成失败。',
            diagnosticRef: record.operationId,
        };
    }
    return {
        operationId: record.operationId,
        operationKey: record.operationKey,
        status: record.status,
        phase: record.phase,
        version: record.version,
        attempt: record.attemptCount,
        maxAttempts: record.maxAttempts,
        ...(typeof record.progress === 'number' ? { progress: record.progress } : {}),
        ...(record.heartbeatAt ? { heartbeatAt: record.heartbeatAt } : {}),
        ...(record.status === 'retry_wait' && record.leaseExpiresAt ? { retryAt: record.leaseExpiresAt } : {}),
        operationDeadlineAt: record.operationDeadlineAt,
        ...(result ? { result } : {}),
        warnings: parseJsonArray(record.warningJson),
        ...(error ? { error } : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}

function invalidTransition(status: DraftOperationStatus, event: DraftOperationEvent): never {
    throw Object.assign(
        new Error(`Draft operation cannot handle ${event.type} from ${status}`),
        { code: 'INVALID_OPERATION_TRANSITION', status, eventType: event.type },
    );
}

function transitionTo(
    current: DraftOperationRecord,
    status: DraftOperationStatus,
    patch: Partial<DraftOperationRecord>,
): DraftOperationTransition {
    const terminal = isDraftOperationTerminal(status);
    return {
        changed: true,
        nextStatus: status,
        patch: {
            ...patch,
            status,
            phase: phaseForDraftOperationStatus(status),
            ...(terminal && patch.completedAt ? { completedAt: patch.completedAt } : {}),
        },
        emitCompletion: terminal && !isDraftOperationTerminal(current.status),
    };
}

export function transitionDraftOperation(
    current: DraftOperationRecord,
    event: DraftOperationEvent,
): DraftOperationTransition {
    if (
        (current.status === 'succeeded' && event.type === 'COMMIT_SUCCEEDED')
        || (current.status === 'cancelled' && ['CANCEL_REQUEST', 'ABORT_CONFIRMED'].includes(event.type))
        || (current.status === 'definitive_failed' && ['TERMINAL_FAILURE', 'COMMIT_REJECTED'].includes(event.type))
        || (current.status === 'reconcile_required' && event.type === 'RECONCILIATION_REQUIRED')
    ) {
        return { changed: false, nextStatus: current.status, patch: {}, emitCompletion: false };
    }

    if (event.type === 'RECONCILIATION_REQUIRED' && !isDraftOperationTerminal(current.status)) {
        return transitionTo(current, 'reconcile_required', {
            errorCode: event.errorCode,
            errorJson: event.errorJson,
            completedAt: event.now,
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
        });
    }

    switch (current.status) {
        case 'queued':
            if (event.type === 'CLAIM') {
                return transitionTo(current, 'running_generation', {
                    leaseOwner: event.workerId,
                    leaseExpiresAt: event.leaseExpiresAt,
                    heartbeatAt: event.now,
                    startedAt: current.startedAt ?? event.now,
                    attemptCount: current.attemptCount + 1,
                    errorCode: undefined,
                    errorJson: undefined,
                });
            }
            if (event.type === 'CANCEL_REQUEST') {
                return transitionTo(current, 'cancelled', {
                    cancelRequestedAt: event.now,
                    completedAt: event.now,
                });
            }
            if (event.type === 'TERMINAL_FAILURE') {
                return transitionTo(current, 'definitive_failed', {
                    errorCode: event.errorCode,
                    errorJson: event.errorJson,
                    completedAt: event.now,
                });
            }
            break;
        case 'running_generation':
            if (event.type === 'HEARTBEAT') {
                if (current.leaseOwner !== event.workerId) invalidTransition(current.status, event);
                return transitionTo(current, current.status, {
                    heartbeatAt: event.now,
                    leaseExpiresAt: event.leaseExpiresAt,
                    ...(typeof event.progress === 'number' ? { progress: event.progress } : {}),
                });
            }
            if (event.type === 'GENERATION_SUCCEEDED') {
                return transitionTo(current, 'running_postprocess', {
                    generatedPayloadJson: event.generatedPayloadJson,
                    progress: 0.75,
                });
            }
            if (event.type === 'RETRYABLE_FAILURE') {
                return transitionTo(current, 'retry_wait', {
                    errorCode: event.errorCode,
                    errorJson: event.errorJson,
                    leaseOwner: undefined,
                    leaseExpiresAt: event.retryAt,
                });
            }
            if (event.type === 'TERMINAL_FAILURE') {
                return transitionTo(current, 'definitive_failed', {
                    errorCode: event.errorCode,
                    errorJson: event.errorJson,
                    completedAt: event.now,
                    leaseOwner: undefined,
                    leaseExpiresAt: undefined,
                });
            }
            if (event.type === 'CANCEL_REQUEST') {
                return transitionTo(current, 'cancel_requested', { cancelRequestedAt: event.now });
            }
            break;
        case 'retry_wait':
            if (event.type === 'RETRY_DUE') {
                return transitionTo(current, 'running_generation', {
                    leaseOwner: event.workerId,
                    leaseExpiresAt: event.leaseExpiresAt,
                    heartbeatAt: event.now,
                    attemptCount: current.attemptCount + 1,
                });
            }
            if (event.type === 'CANCEL_REQUEST') {
                return transitionTo(current, 'cancelled', {
                    cancelRequestedAt: event.now,
                    completedAt: event.now,
                });
            }
            if (event.type === 'TERMINAL_FAILURE') {
                return transitionTo(current, 'definitive_failed', {
                    errorCode: event.errorCode,
                    errorJson: event.errorJson,
                    completedAt: event.now,
                });
            }
            break;
        case 'running_postprocess':
            if (event.type === 'POSTPROCESS_COMPLETED') {
                return transitionTo(current, 'committing', {
                    ...(event.generatedPayloadJson ? { generatedPayloadJson: event.generatedPayloadJson } : {}),
                    ...(event.warningJson ? { warningJson: event.warningJson } : {}),
                    progress: 0.9,
                });
            }
            if (event.type === 'CANCEL_REQUEST') {
                return transitionTo(current, 'cancel_requested', { cancelRequestedAt: event.now });
            }
            break;
        case 'committing':
            if (event.type === 'COMMIT_SUCCEEDED') {
                return transitionTo(current, 'succeeded', {
                    resultDraftSessionId: event.draftSessionId,
                    resultJson: event.resultJson,
                    generatedPayloadJson: undefined,
                    progress: 1,
                    completedAt: event.now,
                    leaseOwner: undefined,
                    leaseExpiresAt: undefined,
                });
            }
            if (event.type === 'COMMIT_REJECTED') {
                return transitionTo(current, 'definitive_failed', {
                    generatedPayloadJson: undefined,
                    errorCode: event.errorCode,
                    errorJson: event.errorJson,
                    completedAt: event.now,
                    leaseOwner: undefined,
                    leaseExpiresAt: undefined,
                });
            }
            break;
        case 'definitive_failed':
            if (event.type === 'RETRY_REQUESTED') {
                if (current.attemptCount >= current.maxAttempts || Date.parse(event.now) >= Date.parse(current.operationDeadlineAt)) {
                    return invalidTransition(current.status, event);
                }
                return transitionTo(current, 'queued', {
                    completedAt: undefined,
                    errorCode: undefined,
                    errorJson: undefined,
                    progress: 0,
                });
            }
            break;
        case 'cancel_requested':
            if (event.type === 'ABORT_CONFIRMED') {
                return transitionTo(current, 'cancelled', {
                    completedAt: event.now,
                    leaseOwner: undefined,
                    leaseExpiresAt: undefined,
                });
            }
            if (event.type === 'RESULT_WON_RACE') {
                return transitionTo(current, 'committing', { progress: 0.9 });
            }
            break;
        default:
            break;
    }

    return invalidTransition(current.status, event);
}
