import type {
    AgentConversationCompressionSnapshot,
    AgentConversationSummaryCasToken,
} from '../../agent/AgentConversationStore';
import { AiActionError } from '../errors';
import type { AiProvider, AiProviderType } from '../types';
import {
    AgentContextTokenCounter,
    type AgentContextBudget,
    type AgentContextTokenCount,
} from './AgentContextTokenCounter';
import {
    AGENT_CONVERSATION_COMPACTOR_PROMPT_VERSION,
    AgentConversationCompactor,
    AgentConversationCompactorError,
    type AgentConversationCompactorOutput,
} from './AgentConversationCompactor';
import {
    buildDependencyHash,
    buildMessageSourceHash,
    canonicalJson,
    AGENT_CONVERSATION_SUMMARY_LIMITS,
    normalizeAgentConversationSummaryV2,
    sha256,
    validateAgentConversationSummaryCoverageV2,
    validateAndCreateSummaryV2,
    type AgentConversationCompactionResultV2,
    type AgentConversationSemanticProjection,
    type AgentConversationSummaryRebuildReason,
    type AgentConversationSummaryV2,
    type SummaryMessageSource,
    type SummarySourceFingerprint,
} from './AgentConversationSummaryV2';
import {
    ContextAtomicUnitBuilder,
    type ContextAtomicBuildResult,
    type ContextAtomicStateRef,
} from './ContextAtomicUnitBuilder';

export interface AgentContextCompressionStore {
    readCompressionSnapshot(conversationId: string): Promise<AgentConversationCompressionSnapshot | null>;
    compareAndSwapContextSummary(
        conversationId: string,
        token: AgentConversationSummaryCasToken,
        nextSummary: Record<string, unknown>,
    ): Promise<{ ok: true; summaryCasToken: AgentConversationSummaryCasToken } | { ok: false; reason: 'conflict' }>;
}

export type AgentContextCompressionMode = 'none' | 'projection' | 'semantic' | 'degraded';
export type AgentContextCompressionOperationKind =
    | 'none'
    | 'coverage_increment'
    | 'dependency_refresh'
    | 'generation_rebuild'
    | 'background_precompression';
export type AgentCurrentRequestIdentityStatus = 'not_applicable' | 'valid' | 'mismatch';

export interface AgentContextCompressionCoordinatorInput {
    storageConversationId: string;
    providerType: AiProviderType;
    model: string;
    configuredContextWindowTokens?: number;
    outputReserveTokens: number;
    systemPrompt: string;
    currentRequest: unknown;
    currentRequestIdentityRequired?: boolean;
    protectedContext: unknown;
    sections?: unknown[];
    stateRefs?: ContextAtomicStateRef[];
    availableProjectSources?: SummarySourceFingerprint[];
    signal?: AbortSignal;
    force?: boolean;
    explicitRetry?: boolean;
    background?: boolean;
    rebuildReason?: AgentConversationSummaryRebuildReason;
    /** Reserved by the coordinator when foreground work schedules a shared rebuild. */
    rebuildTaskId?: string;
    /** Monotonic wall-clock origin shared by all waiters for the reserved rebuild. */
    rebuildTaskStartedAt?: number;
}

export interface AgentContextCompressionCoordinatorDiagnostics {
    mode: AgentContextCompressionMode;
    operationKind: AgentContextCompressionOperationKind;
    triggered: boolean;
    triggerReason: 'none' | 'high_water' | 'forced' | 'source_changed' | 'dependency_changed' | 'manual_rebuild';
    currentRequestIdentityStatus: AgentCurrentRequestIdentityStatus;
    currentRequestPayloadOccurrences: number;
    preCompressionContextTokens: number;
    postCompressionContextTokens: number;
    preCompressionProviderInputTokens: number;
    postCompressionProviderInputTokens: number;
    hardTokenCountMethod: 'provider_exact' | 'tokenizer_exact' | 'conservative_upper_bound';
    hardTokenCountProfileId: string;
    targetContextBudget: number;
    summaryRevision: number;
    summaryGeneration: number;
    rebuildReason?: 'source_changed' | 'manual_quality_rebuild';
    coverageMessageCount: number;
    coverageStartMessageId?: string;
    coverageEndMessageId?: string;
    sourceHashStatus: 'none' | 'valid' | 'stale';
    dependencyHashStatus: 'none' | 'valid' | 'stale';
    boundaryUnitId?: string;
    atomicUnitCount: number;
    blockingUnitId?: string;
    blockingSequenceStart?: number;
    blockingSequenceEnd?: number;
    newlyCoveredMessageCount: number;
    recentTailMessageCount: number;
    recentTailContextTokens: number;
    recentTailUnitCount: number;
    sourceIndexLedgerEntries: number;
    sourceIndexBytes: number;
    semanticLedgerEntries: number;
    transientLedgerEntries: number;
    unprojectedSemanticMessageCount: number;
    invalidatedSourceCount: number;
    qualitySample?: {
        reason: 'initial' | 'periodic' | 'rebuild';
        revision: number;
        generation: number;
        projectionEntryCount: number;
        semanticLedgerEntries: number;
        directlyProjectedSemanticEntries: number;
        validationPassed: true;
    };
    rebuildTaskId: string | null;
    rebuildStatus: 'idle' | 'running' | 'completed' | 'discarded' | 'limit_exceeded';
    rebuildCompletedChunks: number;
    rebuildMaxChunks: number;
    rebuildElapsedMs: number;
    rebuildMaxDurationMs: number;
    /** @deprecated Kept for diagnostics persisted before v0.4. */
    rebuildChunksCompleted?: number;
    /** @deprecated Estimated total chunks, not the configured safety limit. */
    rebuildChunkCount?: number;
    compactor?: {
        providerType: AiProviderType;
        model: string;
        promptVersion: string;
        elapsedMs: number;
        inputTokens: number;
        outputTokens: number;
        tokenCountMethod: 'provider_exact' | 'tokenizer_exact' | 'conservative_upper_bound';
        inputBytes: number;
        outputBytes: number;
        retries: number;
    };
    statusCodes: Array<'CONTEXT_REBUILD_IN_PROGRESS' | 'CONTEXT_PRECOMPRESSION_IN_PROGRESS'>;
    errorCode?: string;
    /** @deprecated Use statusCodes/errorCode to distinguish recoverable state from failure. */
    failureCode?: string;
    consecutiveFailures: number;
    circuitOpen: boolean;
    casConflict: boolean;
    warnings: string[];
}

export interface AgentContextCompressionCoordinatorResult {
    snapshot: AgentConversationCompressionSnapshot | null;
    summary: AgentConversationSummaryV2 | null;
    diagnostics: AgentContextCompressionCoordinatorDiagnostics;
}

type FailureState = {
    consecutiveFailures: number;
    candidateIdentity: string;
    circuitOpen: boolean;
};

type SharedTask = {
    key: string;
    operationKind: AgentContextCompressionOperationKind;
    background: boolean;
    rebuildReason?: AgentConversationSummaryRebuildReason;
    controller: AbortController;
    promise: Promise<AgentContextCompressionCoordinatorResult>;
    waiters: Set<symbol>;
    progress: SharedTaskProgress | null;
};

type SharedTaskProgress = {
    taskId: string;
    startedAt: number;
    completedChunks: number;
    estimatedChunks: number;
};

type CurrentRequestIdentity = {
    status: AgentCurrentRequestIdentityStatus;
    messageId: string;
    contentHash: string;
};

type PreparedCompressionTask = {
    snapshot: AgentConversationCompressionSnapshot | null;
    budget: AgentContextBudget;
    operationKind: AgentContextCompressionOperationKind;
    requestIdentity: CurrentRequestIdentity;
    taskKey: string;
};

type AgentHardTokenCount = Omit<AgentContextTokenCount, 'method'> & {
    method: Exclude<AgentContextTokenCount['method'], 'estimated'>;
};

export interface AgentContextCompressionCoordinatorOptions {
    maxRebuildChunks?: number;
    maxRebuildDurationMs?: number;
    compactorTimeoutMs?: number;
}

const DEFAULT_MAX_REBUILD_CHUNKS = 24;
const DEFAULT_MAX_REBUILD_DURATION_MS = 180_000;
const DEFAULT_COMPACTOR_TIMEOUT_MS = 45_000;

function abortError(): AgentConversationCompactorError {
    return new AgentConversationCompactorError('CONTEXT_COMPACTION_ABORTED', 'Context compaction was cancelled.');
}

function currentRequestMessageId(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    return String((value as { messageId?: unknown }).messageId || '').trim();
}

function currentRequestContent(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const record = value as { content?: unknown; message?: unknown };
    return String(record.content ?? record.message ?? '');
}

function validateCurrentRequestIdentity(
    snapshot: AgentConversationCompressionSnapshot,
    input: AgentContextCompressionCoordinatorInput,
): CurrentRequestIdentity {
    const messageId = currentRequestMessageId(input.currentRequest);
    const content = currentRequestContent(input.currentRequest);
    const required = input.currentRequestIdentityRequired === true || Boolean(messageId);
    if (!required) return { status: 'not_applicable', messageId: '', contentHash: '' };
    const persisted = snapshot.messages.find((message) => message.messageId === messageId);
    if (!messageId || !persisted || persisted.role !== 'user' || persisted.content !== content) {
        throw new AiActionError(
            'CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH',
            'The current request does not match one persisted user message in this conversation.',
            undefined,
            {
                messageId: messageId || null,
                messageFound: Boolean(persisted),
                persistedRole: persisted?.role || null,
                contentMatches: Boolean(persisted && persisted.content === content),
            },
        );
    }
    return { status: 'valid', messageId, contentHash: sha256(content) };
}

function artifactSources(snapshot: AgentConversationCompressionSnapshot): SummarySourceFingerprint[] {
    return snapshot.artifacts.map((artifact) => ({
        sourceType: 'artifact' as const,
        sourceId: artifact.artifactId,
        sourceVersion: String(artifact.reviewRevision || 0),
        contentHash: sha256(canonicalJson({
            status: artifact.status,
            summary: artifact.summary || '',
            content: artifact.content || '',
            reference: artifact.reference,
            metadata: artifact.metadata,
            reviewRevision: artifact.reviewRevision || 0,
        })),
        title: artifact.title,
    }));
}

function mergeSources(
    snapshot: AgentConversationCompressionSnapshot,
    supplied: SummarySourceFingerprint[] | undefined,
): SummarySourceFingerprint[] {
    const byKey = new Map<string, SummarySourceFingerprint>();
    for (const source of [...artifactSources(snapshot), ...(supplied || [])]) {
        byKey.set(`${source.sourceType}:${source.sourceId}`, source);
    }
    return [...byKey.values()].sort((left, right) => (
        `${left.sourceType}:${left.sourceId}`.localeCompare(`${right.sourceType}:${right.sourceId}`)
    ));
}

function relevantCompactorSources(
    summary: AgentConversationSummaryV2 | null,
    messages: SummaryMessageSource[],
    available: SummarySourceFingerprint[],
): SummarySourceFingerprint[] {
    const referencedKeys = new Set((summary?.sourceIndex.sourceFingerprints || []).map((source) => (
        `${source.sourceType}:${source.sourceId}`
    )));
    const query = messages.map((message) => message.content.toLowerCase()).join('\n');
    return available.filter((source) => (
        referencedKeys.has(`${source.sourceType}:${source.sourceId}`)
        || query.includes(source.sourceId.toLowerCase())
        || Boolean(source.title && query.includes(source.title.toLowerCase()))
    )).slice(0, 32);
}

function lexicalTerms(value: string): string[] {
    return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []).slice(0, 64))];
}

function relevantHistoricalMessages(
    summary: AgentConversationSummaryV2 | null,
    allMessages: SummaryMessageSource[],
    newlyCovered: SummaryMessageSource[],
): SummaryMessageSource[] {
    if (!summary) return [];
    const newIds = new Set(newlyCovered.map((message) => message.messageId));
    const covered = allMessages.slice(0, summary.coverage.messageCount).filter((message) => !newIds.has(message.messageId));
    const byId = new Map(covered.map((message) => [message.messageId, message]));
    const queryTerms = lexicalTerms(newlyCovered.map((message) => message.content).join('\n'));
    const scoreById = new Map<string, number>();
    const score = (id: string, amount: number) => scoreById.set(id, Math.max(scoreById.get(id) || 0, amount));
    for (const entry of summary.sourceIndex.userMessageLedger) {
        const haystack = entry.gist.toLowerCase();
        const matches = queryTerms.filter((term) => haystack.includes(term)).length;
        if (matches) score(entry.messageId, 20 + matches);
    }
    const projectionEntries = Object.entries(summary.semanticProjection)
        .filter(([key]) => key !== 'artifactRefs')
        .flatMap(([, entries]) => entries as AgentConversationSemanticProjection['activeIntent']);
    for (const entry of projectionEntries) {
        const haystack = entry.text.toLowerCase();
        const matches = queryTerms.filter((term) => haystack.includes(term)).length;
        if (matches) {
            for (const id of entry.sourceMessageIds || []) score(id, 40 + matches);
        }
    }
    for (const message of covered.filter((item) => item.role === 'user').slice(-4)) score(message.messageId, 5);
    return [...scoreById.entries()]
        .sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore
            || (byId.get(rightId)?.sequence || 0) - (byId.get(leftId)?.sequence || 0))
        .slice(0, 12)
        .map(([id]) => byId.get(id))
        .filter((message): message is SummaryMessageSource => Boolean(message))
        .sort((left, right) => left.sequence - right.sequence)
        .map((message) => ({ ...message, content: message.content.slice(0, 1_200) }));
}

function rebuildHistoricalMessages(
    processed: SummaryMessageSource[],
    chunk: SummaryMessageSource[],
): SummaryMessageSource[] {
    if (!processed.length) return [];
    const terms = lexicalTerms(chunk.map((message) => message.content).join('\n'));
    return processed
        .map((message) => ({
            message,
            score: terms.filter((term) => message.content.toLowerCase().includes(term)).length,
        }))
        .sort((left, right) => right.score - left.score || right.message.sequence - left.message.sequence)
        .slice(0, 12)
        .map(({ message }) => ({ ...message, content: message.content.slice(0, 1_200) }))
        .sort((left, right) => left.sequence - right.sequence);
}

function filterStaleProjection(
    projection: AgentConversationSemanticProjection,
    staleKeys: Set<string>,
): AgentConversationSemanticProjection {
    const keepEntry = (entry: AgentConversationSemanticProjection['activeIntent'][number]) => (
        !(entry.sourceProjectRefs || []).some((source) => staleKeys.has(`${source.sourceType}:${source.sourceId}`))
        && !(entry.sourceArtifactIds || []).some((id) => staleKeys.has(`artifact:${id}`))
    );
    return {
        activeIntent: projection.activeIntent.filter(keepEntry),
        hardConstraints: projection.hardConstraints.filter(keepEntry),
        confirmedDecisions: projection.confirmedDecisions.filter(keepEntry),
        canonFacts: projection.canonFacts.filter(keepEntry),
        creativeContinuity: projection.creativeContinuity.filter(keepEntry),
        unresolvedQuestions: projection.unresolvedQuestions.filter(keepEntry),
        completedOutcomes: projection.completedOutcomes.filter(keepEntry),
        pendingWork: projection.pendingWork.filter(keepEntry),
        artifactRefs: projection.artifactRefs.filter((ref) => !staleKeys.has(`artifact:${ref.artifactId}`)),
    };
}

function validateExistingSummary(input: {
    rawSummary: Record<string, unknown> | null;
    messages: SummaryMessageSource[];
    availableSources: SummarySourceFingerprint[];
}): {
    summary: AgentConversationSummaryV2 | null;
    persistedSummary: AgentConversationSummaryV2 | null;
    sourceHashStatus: 'none' | 'valid' | 'stale';
    dependencyHashStatus: 'none' | 'valid' | 'stale';
    invalidatedSourceCount: number;
} {
    const summary = normalizeAgentConversationSummaryV2(input.rawSummary);
    if (!summary) {
        return {
            summary: null,
            persistedSummary: null,
            sourceHashStatus: 'none',
            dependencyHashStatus: 'none',
            invalidatedSourceCount: 0,
        };
    }
    const covered = input.messages.slice(0, summary.coverage.messageCount);
    const sourceValid = validateAgentConversationSummaryCoverageV2(summary, covered);
    if (!sourceValid) {
        return {
            summary: null,
            persistedSummary: summary,
            sourceHashStatus: 'stale',
            dependencyHashStatus: 'none',
            invalidatedSourceCount: 0,
        };
    }
    const availableByKey = new Map(input.availableSources.map((source) => [
        `${source.sourceType}:${source.sourceId}`,
        source,
    ]));
    const staleKeys = new Set<string>();
    for (const source of summary.sourceIndex.sourceFingerprints) {
        const current = availableByKey.get(`${source.sourceType}:${source.sourceId}`);
        if (!current || current.contentHash !== source.contentHash
            || (source.sourceVersion && source.sourceVersion !== current.sourceVersion)) {
            staleKeys.add(`${source.sourceType}:${source.sourceId}`);
        }
    }
    if (!staleKeys.size) {
        return {
            summary,
            persistedSummary: summary,
            sourceHashStatus: 'valid',
            dependencyHashStatus: 'valid',
            invalidatedSourceCount: 0,
        };
    }
    return {
        summary: {
            ...summary,
            semanticProjection: filterStaleProjection(summary.semanticProjection, staleKeys),
        },
        persistedSummary: summary,
        sourceHashStatus: 'valid',
        dependencyHashStatus: 'stale',
        invalidatedSourceCount: staleKeys.size,
    };
}

function countCandidateTokens(
    counter: AgentContextTokenCounter,
    input: AgentContextCompressionCoordinatorInput,
    summary: AgentConversationSummaryV2 | null,
    messages: SummaryMessageSource[],
): AgentHardTokenCount {
    const coveredCount = summary?.coverage.messageCount || 0;
    const prompt = canonicalJson({
        currentRequest: input.currentRequest,
        protectedContext: input.protectedContext,
        persistentSummary: summary?.semanticProjection || null,
        history: messages.slice(coveredCount),
        sections: input.sections || [],
    });
    const count = counter.count({
        providerType: input.providerType,
        model: input.model,
        systemPrompt: input.systemPrompt,
        prompt,
        configuredContextWindowTokens: input.configuredContextWindowTokens,
    });
    if (!count) throw new AiActionError(
        'CONTEXT_TOKEN_COUNTER_UNAVAILABLE',
        'No hard-safe token counter is available for this model.',
    );
    if (count.method === 'estimated') throw new AiActionError(
        'CONTEXT_TOKEN_COUNTER_UNAVAILABLE',
        'An estimated token count cannot be used for a hard context budget.',
    );
    return count as AgentHardTokenCount;
}

function compactorInputBytes(
    projection: AgentConversationSemanticProjection | null,
    messages: SummaryMessageSource[],
    sources: SummarySourceFingerprint[],
    historicalMessages: SummaryMessageSource[] = [],
): number {
    return Buffer.byteLength(canonicalJson({ projection, messages, sources, historicalMessages }), 'utf8') + 2_048;
}

function capPrefixForCompactor(input: {
    build: ContextAtomicBuildResult;
    coveredMessages: SummaryMessageSource[];
    newlyCoveredMessages: SummaryMessageSource[];
    previousProjection: AgentConversationSemanticProjection | null;
    sources: SummarySourceFingerprint[];
    historicalMessages?: SummaryMessageSource[];
    maximumBytes: number;
    maximumUserMessages: number;
}): { coveredMessages: SummaryMessageSource[]; newlyCoveredMessages: SummaryMessageSource[]; boundaryUnitId?: string } {
    const previousCount = input.coveredMessages.length - input.newlyCoveredMessages.length;
    const newIds = new Set(input.newlyCoveredMessages.map((message) => message.messageId));
    const candidateUnits = input.build.units.filter((unit) => (
        unit.status === 'closed' && unit.messageIds.some((id) => newIds.has(id))
    ));
    let keepUnits = candidateUnits.length;
    let newlyCovered = input.newlyCoveredMessages;
    while (keepUnits > 0 && (
        compactorInputBytes(
            input.previousProjection,
            newlyCovered,
            input.sources,
            input.historicalMessages,
        ) > input.maximumBytes
        || newlyCovered.filter((message) => message.role === 'user').length > input.maximumUserMessages
    )) {
        keepUnits -= 1;
        const keptIds = new Set(candidateUnits.slice(0, keepUnits).flatMap((unit) => unit.messageIds));
        newlyCovered = input.newlyCoveredMessages.filter((message) => keptIds.has(message.messageId));
    }
    return {
        coveredMessages: input.coveredMessages.slice(0, previousCount + newlyCovered.length),
        newlyCoveredMessages: newlyCovered,
        boundaryUnitId: candidateUnits[keepUnits - 1]?.unitId,
    };
}

function projectionEntries(projection: AgentConversationSemanticProjection) {
    return Object.entries(projection)
        .filter(([key]) => key !== 'artifactRefs')
        .flatMap(([, entries]) => entries as AgentConversationSemanticProjection['activeIntent']);
}

function sourceIndexDiagnostics(summary: AgentConversationSummaryV2 | null): {
    sourceIndexLedgerEntries: number;
    sourceIndexBytes: number;
    semanticLedgerEntries: number;
    transientLedgerEntries: number;
    unprojectedSemanticMessageCount: number;
} {
    if (!summary) return {
        sourceIndexLedgerEntries: 0,
        sourceIndexBytes: 0,
        semanticLedgerEntries: 0,
        transientLedgerEntries: 0,
        unprojectedSemanticMessageCount: 0,
    };
    const projectedMessageIds = new Set(
        projectionEntries(summary.semanticProjection).flatMap((entry) => entry.sourceMessageIds || []),
    );
    const semantic = summary.sourceIndex.userMessageLedger.filter((entry) => entry.classification === 'semantic');
    return {
        sourceIndexLedgerEntries: summary.sourceIndex.userMessageLedger.length,
        sourceIndexBytes: Buffer.byteLength(canonicalJson(summary.sourceIndex), 'utf8'),
        semanticLedgerEntries: semantic.length,
        transientLedgerEntries: summary.sourceIndex.userMessageLedger.length - semantic.length,
        unprojectedSemanticMessageCount: semantic.filter((entry) => !projectedMessageIds.has(entry.messageId)).length,
    };
}

function qualitySample(summary: AgentConversationSummaryV2): AgentContextCompressionCoordinatorDiagnostics['qualitySample'] {
    const shouldSample = summary.revision === 1 || summary.revision % 5 === 0 || Boolean(summary.rebuild);
    if (!shouldSample) return undefined;
    const stats = sourceIndexDiagnostics(summary);
    return {
        reason: summary.rebuild ? 'rebuild' : summary.revision === 1 ? 'initial' : 'periodic',
        revision: summary.revision,
        generation: summary.generation,
        projectionEntryCount: projectionEntries(summary.semanticProjection).length,
        semanticLedgerEntries: stats.semanticLedgerEntries,
        directlyProjectedSemanticEntries: stats.semanticLedgerEntries - stats.unprojectedSemanticMessageCount,
        validationPassed: true,
    };
}

function countMessageContextTokens(
    counter: AgentContextTokenCounter,
    input: AgentContextCompressionCoordinatorInput,
    messages: SummaryMessageSource[],
): number {
    const count = counter.count({
        providerType: input.providerType,
        model: input.model,
        prompt: canonicalJson(messages),
        configuredContextWindowTokens: input.configuredContextWindowTokens,
    });
    return count?.contextTokens || 0;
}

function countTailUnits(build: ContextAtomicBuildResult, tailMessages: SummaryMessageSource[]): number {
    const tailIds = new Set(tailMessages.map((message) => message.messageId));
    return build.units.filter((unit) => unit.messageIds.some((id) => tailIds.has(id))).length;
}

function relevantRebuildSources(
    projection: AgentConversationSemanticProjection | null,
    messages: SummaryMessageSource[],
    available: SummarySourceFingerprint[],
): SummarySourceFingerprint[] {
    const referencedKeys = new Set<string>();
    for (const entry of projection ? projectionEntries(projection) : []) {
        for (const source of entry.sourceProjectRefs || []) {
            referencedKeys.add(`${source.sourceType}:${source.sourceId}`);
        }
        for (const artifactId of entry.sourceArtifactIds || []) referencedKeys.add(`artifact:${artifactId}`);
    }
    for (const artifact of projection?.artifactRefs || []) referencedKeys.add(`artifact:${artifact.artifactId}`);
    const query = messages.map((message) => message.content.toLowerCase()).join('\n');
    return available.filter((source) => (
        referencedKeys.has(`${source.sourceType}:${source.sourceId}`)
        || query.includes(source.sourceId.toLowerCase())
        || Boolean(source.title && query.includes(source.title.toLowerCase()))
    )).slice(0, 32);
}

function validateRebuildChunk(input: {
    result: AgentConversationCompactionResultV2;
    chunkMessages: SummaryMessageSource[];
    processedMessages: SummaryMessageSource[];
    availableSources: SummarySourceFingerprint[];
}): void {
    if (input.result.mode !== 'rebuild_chunk') {
        throw new AgentConversationCompactorError(
            'CONTEXT_COMPACTION_INVALID',
            'A rebuild chunk returned the wrong compaction mode.',
        );
    }
    const expectedUserIds = input.chunkMessages
        .filter((message) => message.role === 'user')
        .map((message) => message.messageId);
    const actualUserIds = input.result.userMessageLedgerDelta.map((entry) => entry.messageId);
    if (canonicalJson(expectedUserIds) !== canonicalJson(actualUserIds)) {
        throw new AgentConversationCompactorError(
            'CONTEXT_COMPACTION_INVALID',
            'A rebuild chunk ledger must contain every chunk user message exactly once and in order.',
        );
    }
    const messageById = new Map(input.processedMessages.map((message) => [message.messageId, message]));
    const sourceByKey = new Map(input.availableSources.map((source) => [
        `${source.sourceType}:${source.sourceId}`,
        source,
    ]));
    for (const ledger of input.result.userMessageLedgerDelta) {
        const source = messageById.get(ledger.messageId);
        if (!source || source.role !== 'user') {
            throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'A rebuild ledger cites an invalid user message.');
        }
        for (const targetId of ledger.supersedesMessageIds || []) {
            const target = messageById.get(targetId);
            if (!target || target.role !== 'user' || target.sequence >= source.sequence) {
                throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'A rebuild ledger has an invalid supersession target.');
            }
        }
    }
    for (const entry of projectionEntries(input.result.semanticProjection)) {
        const messageSources = (entry.sourceMessageIds || []).map((id) => messageById.get(id));
        if (messageSources.some((message) => !message)) {
            throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'A rebuild projection cites an unprocessed message.');
        }
        if (entry.authority === 'user' && !messageSources.some((message) => message?.role === 'user')) {
            throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'A user projection entry lacks a user source.');
        }
        if (entry.authority === 'assistant' && !messageSources.some((message) => message?.role === 'assistant')) {
            throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'An assistant projection entry lacks an assistant source.');
        }
        for (const artifactId of entry.sourceArtifactIds || []) {
            if (!sourceByKey.has(`artifact:${artifactId}`)) {
                throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'A rebuild projection cites an unavailable Artifact.');
            }
        }
        for (const source of entry.sourceProjectRefs || []) {
            const available = sourceByKey.get(`${source.sourceType}:${source.sourceId}`);
            if (!available || available.contentHash !== source.contentHash
                || (source.sourceVersion && source.sourceVersion !== available.sourceVersion)) {
                throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'A rebuild projection cites a stale project source.');
            }
        }
    }
    for (const artifact of input.result.semanticProjection.artifactRefs) {
        const available = sourceByKey.get(`artifact:${artifact.artifactId}`);
        if (!available || available.contentHash !== artifact.contentHash
            || (artifact.sourceVersion && artifact.sourceVersion !== available.sourceVersion)) {
            throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'A rebuild projection contains a stale Artifact reference.');
        }
    }
    for (const source of input.result.referencedSources) {
        const available = sourceByKey.get(`${source.sourceType}:${source.sourceId}`);
        if (!available || available.contentHash !== source.contentHash
            || (source.sourceVersion && source.sourceVersion !== available.sourceVersion)) {
            throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'A rebuild chunk returned a stale source fingerprint.');
        }
    }
}

export class AgentContextCompressionCoordinator {
    private readonly counter = new AgentContextTokenCounter();
    private readonly atomicBuilder = new ContextAtomicUnitBuilder();
    private readonly tasks = new Map<string, SharedTask>();
    private readonly failures = new Map<string, FailureState>();
    private readonly options: Required<AgentContextCompressionCoordinatorOptions>;

    constructor(
        private readonly store: AgentContextCompressionStore,
        private readonly providerFactory: () => AiProvider,
        options: AgentContextCompressionCoordinatorOptions = {},
    ) {
        this.options = {
            maxRebuildChunks: Math.max(1, Math.floor(options.maxRebuildChunks || DEFAULT_MAX_REBUILD_CHUNKS)),
            maxRebuildDurationMs: Math.max(1_000, Math.floor(options.maxRebuildDurationMs || DEFAULT_MAX_REBUILD_DURATION_MS)),
            compactorTimeoutMs: Math.max(1_000, Math.floor(options.compactorTimeoutMs || DEFAULT_COMPACTOR_TIMEOUT_MS)),
        };
    }

    private async prepareTask(input: AgentContextCompressionCoordinatorInput): Promise<PreparedCompressionTask> {
        const budget = this.counter.budget({
            providerType: input.providerType,
            model: input.model,
            configuredContextWindowTokens: input.configuredContextWindowTokens,
            outputReserveTokens: input.outputReserveTokens,
            systemPrompt: input.systemPrompt,
        });
        if (!budget) throw new AiActionError(
            'CONTEXT_TOKEN_COUNTER_UNAVAILABLE',
            'No hard-safe token counter is available for this model.',
        );
        const snapshot = await this.store.readCompressionSnapshot(input.storageConversationId);
        if (!snapshot) {
            return {
                snapshot: null,
                budget,
                operationKind: 'none',
                requestIdentity: { status: 'not_applicable', messageId: '', contentHash: '' },
                taskKey: canonicalJson({
                    storageConversationId: input.storageConversationId,
                    summaryCasTokenDigest: null,
                    operationKind: 'none',
                    providerProfileId: budget.profile.profileId,
                    model: input.model,
                }),
            };
        }
        const requestIdentity = validateCurrentRequestIdentity(snapshot, input);
        const messages = snapshot.messages.filter((message) => (
            !requestIdentity.messageId || message.messageId !== requestIdentity.messageId
        )) as SummaryMessageSource[];
        const sources = mergeSources(snapshot, input.availableProjectSources);
        const existing = validateExistingSummary({
            rawSummary: snapshot.contextSummary,
            messages,
            availableSources: sources,
        });
        const rebuildReason = existing.persistedSummary
            ? input.rebuildReason
                || (existing.sourceHashStatus === 'stale' ? 'source_changed' : undefined)
            : undefined;
        const dependencyRefresh = existing.dependencyHashStatus === 'stale'
            && Boolean(existing.summary)
            && !rebuildReason;
        const operationKind: AgentContextCompressionOperationKind = rebuildReason
            ? 'generation_rebuild'
            : dependencyRefresh
                ? 'dependency_refresh'
                : input.background
                    ? 'background_precompression'
                    : 'coverage_increment';
        const targetGeneration = rebuildReason
            ? (existing.persistedSummary?.generation || 0) + 1
            : existing.persistedSummary?.generation || 1;
        const taskKey = canonicalJson({
            storageConversationId: input.storageConversationId,
            summaryCasTokenDigest: sha256(canonicalJson(snapshot.summaryCasToken)),
            operationKind,
            targetGeneration,
            rebuildReason: rebuildReason || null,
            targetSourceHash: buildMessageSourceHash(messages),
            targetDependencyHash: buildDependencyHash(sources),
            currentRequest: requestIdentity.status === 'valid' ? {
                messageId: requestIdentity.messageId,
                contentHash: requestIdentity.contentHash,
            } : null,
            providerProfileId: budget.profile.profileId,
            model: input.model,
            compactorPromptVersion: AGENT_CONVERSATION_COMPACTOR_PROMPT_VERSION,
            assemblyInputHash: sha256(canonicalJson({
                currentRequest: input.currentRequest,
                protectedContext: input.protectedContext,
                sections: input.sections || [],
                stateRefs: input.stateRefs || [],
                configuredContextWindowTokens: input.configuredContextWindowTokens || null,
                outputReserveTokens: input.outputReserveTokens,
                systemPromptHash: sha256(input.systemPrompt),
                force: Boolean(input.force),
                explicitRetry: Boolean(input.explicitRetry),
                background: Boolean(input.background),
            })),
        });
        return { snapshot, budget, operationKind, requestIdentity, taskKey };
    }

    async prepare(input: AgentContextCompressionCoordinatorInput): Promise<AgentContextCompressionCoordinatorResult> {
        if (!input.storageConversationId.trim()) {
            throw new AiActionError('INVALID_INPUT', 'storageConversationId is required for context compression.');
        }
        if (input.signal?.aborted) throw abortError();
        const prepared = await this.prepareTask(input);
        if (input.signal?.aborted) throw abortError();
        const taskKey = prepared.taskKey;
        const current = this.tasks.get(input.storageConversationId);
        if (current) {
            if (current.background && !input.background) {
                return this.backgroundInProgressResult(input, current, prepared);
            }
            const result = await this.waitForTask(current, input.signal);
            if (current.key === taskKey) return result;
            return this.prepare(input);
        }
        const controller = new AbortController();
        const progress = input.rebuildReason || input.background ? {
            taskId: input.rebuildTaskId || `context-rebuild-${sha256(canonicalJson({
                conversationId: input.storageConversationId,
                taskKey,
                startedAt: Date.now(),
            })).slice(0, 24)}`,
            startedAt: input.rebuildTaskStartedAt || Date.now(),
            completedChunks: 0,
            estimatedChunks: 0,
        } : null;
        const promise = this.perform(input, controller.signal, progress, prepared);
        const task: SharedTask = {
            key: taskKey,
            operationKind: prepared.operationKind,
            background: Boolean(input.background),
            ...(input.rebuildReason ? { rebuildReason: input.rebuildReason } : {}),
            controller,
            promise,
            waiters: new Set(),
            progress,
        };
        this.tasks.set(input.storageConversationId, task);
        void promise.finally(() => {
            if (this.tasks.get(input.storageConversationId) === task) this.tasks.delete(input.storageConversationId);
        }).catch(() => undefined);
        return this.waitForTask(task, input.signal);
    }

    private waitForTask(
        task: SharedTask,
        signal?: AbortSignal,
    ): Promise<AgentContextCompressionCoordinatorResult> {
        if (signal?.aborted) {
            if (!task.background && task.waiters.size === 0) task.controller.abort();
            return Promise.reject(abortError());
        }
        const waiter = Symbol('context-compression-waiter');
        task.waiters.add(waiter);
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                task.waiters.delete(waiter);
                signal?.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                if (task.waiters.size === 0) task.controller.abort();
                reject(abortError());
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            task.promise.then((result) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(result);
            }, (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            });
        });
    }

    private async perform(
        input: AgentContextCompressionCoordinatorInput,
        signal: AbortSignal,
        taskProgress: SharedTaskProgress | null,
        prepared: PreparedCompressionTask,
    ): Promise<AgentContextCompressionCoordinatorResult> {
        const { budget, requestIdentity, operationKind } = prepared;
        const snapshot = prepared.snapshot;
        if (!snapshot) return this.noSnapshotResult(budget);
        const requestMessageId = requestIdentity.messageId;
        const messages = snapshot.messages.filter((message) => (
            !requestMessageId || message.messageId !== requestMessageId
        )) as SummaryMessageSource[];
        const sources = mergeSources(snapshot, input.availableProjectSources);
        const existing = validateExistingSummary({
            rawSummary: snapshot.contextSummary,
            messages,
            availableSources: sources,
        });
        let summary = existing.summary;
        const rebuildReason = existing.persistedSummary
            ? input.rebuildReason
                || (existing.sourceHashStatus === 'stale' ? 'source_changed' : undefined)
            : undefined;
        const previousSummary = rebuildReason ? existing.persistedSummary : summary;
        const compactionMode = rebuildReason ? 'rebuild_chunk' as const : 'incremental' as const;
        const preCount = countCandidateTokens(this.counter, input, summary, messages);
        const dependencyRefresh = existing.dependencyHashStatus === 'stale' && Boolean(summary) && !rebuildReason;
        const trigger = Boolean(input.force) || Boolean(input.rebuildReason)
            || Boolean(rebuildReason) || dependencyRefresh || preCount.contextTokens >= budget.triggerContextBudget;
        const build = this.atomicBuilder.build({ messages, stateRefs: input.stateRefs });
        const initialTailMessages = messages.slice(summary?.coverage.messageCount || 0);
        const indexDiagnostics = sourceIndexDiagnostics(summary);
        const failureKey = `${input.storageConversationId}:${budget.profile.profileId}:${input.model}`;
        const baseDiagnostics: AgentContextCompressionCoordinatorDiagnostics = {
            mode: summary ? 'projection' : 'none',
            operationKind: trigger ? operationKind : 'none',
            triggered: trigger,
            triggerReason: trigger
                ? rebuildReason === 'source_changed'
                    ? 'source_changed' as const
                    : rebuildReason === 'manual_quality_rebuild'
                        ? 'manual_rebuild' as const
                        : dependencyRefresh
                            ? 'dependency_changed' as const
                        : input.force
                            ? 'forced' as const
                            : 'high_water' as const
                : 'none',
            currentRequestIdentityStatus: requestIdentity.status,
            currentRequestPayloadOccurrences: requestIdentity.status === 'valid' ? 1 : 0,
            preCompressionContextTokens: preCount.contextTokens,
            postCompressionContextTokens: preCount.contextTokens,
            preCompressionProviderInputTokens: preCount.providerInputTokens,
            postCompressionProviderInputTokens: preCount.providerInputTokens,
            hardTokenCountMethod: preCount.method,
            hardTokenCountProfileId: preCount.profileId,
            targetContextBudget: budget.targetContextBudget,
            summaryRevision: summary?.revision || 0,
            summaryGeneration: summary?.generation || 0,
            ...(rebuildReason || summary?.rebuild?.reason
                ? { rebuildReason: rebuildReason || summary!.rebuild!.reason }
                : {}),
            rebuildTaskId: rebuildReason ? taskProgress?.taskId || null : null,
            rebuildStatus: rebuildReason ? 'running' : 'idle',
            rebuildCompletedChunks: taskProgress?.completedChunks || 0,
            rebuildMaxChunks: this.options.maxRebuildChunks,
            rebuildElapsedMs: rebuildReason && taskProgress
                ? Math.max(0, Date.now() - taskProgress.startedAt)
                : 0,
            rebuildMaxDurationMs: this.options.maxRebuildDurationMs,
            coverageMessageCount: summary?.coverage.messageCount || 0,
            ...(summary ? {
                coverageStartMessageId: summary.coverage.startMessageId,
                coverageEndMessageId: summary.coverage.endMessageId,
            } : {}),
            sourceHashStatus: existing.sourceHashStatus,
            dependencyHashStatus: existing.dependencyHashStatus,
            atomicUnitCount: build.units.length,
            ...(build.blockingUnit ? {
                blockingUnitId: build.blockingUnit.unitId,
                blockingSequenceStart: build.blockingUnit.sequenceStart,
                blockingSequenceEnd: build.blockingUnit.sequenceEnd,
            } : {}),
            newlyCoveredMessageCount: 0,
            recentTailMessageCount: initialTailMessages.length,
            recentTailContextTokens: countMessageContextTokens(this.counter, input, initialTailMessages),
            recentTailUnitCount: countTailUnits(build, initialTailMessages),
            ...indexDiagnostics,
            invalidatedSourceCount: existing.invalidatedSourceCount,
            statusCodes: [],
            consecutiveFailures: this.failures.get(failureKey)?.consecutiveFailures || 0,
            circuitOpen: this.failures.get(failureKey)?.circuitOpen || false,
            casConflict: false,
            warnings: [],
        };
        if (!trigger) return { snapshot, summary, diagnostics: baseDiagnostics };

        const minimumRecentTokens = Math.min(10_000, Math.max(1_024, Math.floor(budget.targetContextBudget * 0.35)));
        const selected = this.atomicBuilder.selectPrefix({
            build,
            messages,
            previousCoverageEndMessageId: rebuildReason ? undefined : summary?.coverage.endMessageId,
            minimumRecentUnits: 5,
            minimumRecentTokens,
            countMessageTokens: (items) => Buffer.byteLength(canonicalJson(items), 'utf8'),
        });
        const compactorMaxOutputTokens = Math.min(
            8_192,
            Math.max(1_536, Math.floor(budget.contextWindowTokens * 0.1875)),
        );
        const projectionOutputReserve = Math.max(768, Math.floor(compactorMaxOutputTokens * 0.45));
        const worstLedgerEntryTokens = AGENT_CONVERSATION_SUMMARY_LIMITS.maxLedgerGistCharacters * 3 + 160;
        const maximumUserMessages = Math.max(
            1,
            Math.floor((compactorMaxOutputTokens - projectionOutputReserve - 256) / worstLedgerEntryTokens),
        );
        const maximumCompactorBytes = Math.max(
            1_024,
            budget.contextWindowTokens - compactorMaxOutputTokens - budget.fixedProviderInputTokens
                - budget.safetyReserveTokens - budget.providerReserveTokens,
        );
        let capped = capPrefixForCompactor({
            build,
            coveredMessages: selected.coveredMessages,
            newlyCoveredMessages: selected.newlyCoveredMessages,
            previousProjection: rebuildReason ? null : summary?.semanticProjection || null,
            sources: relevantCompactorSources(summary, selected.newlyCoveredMessages, sources),
            maximumBytes: maximumCompactorBytes,
            maximumUserMessages,
        });
        const dependencyRefreshOnly = dependencyRefresh && !capped.newlyCoveredMessages.length;
        if (dependencyRefreshOnly) {
            capped = {
                coveredMessages: messages.slice(0, summary!.coverage.messageCount),
                newlyCoveredMessages: [],
                boundaryUnitId: build.units.find((unit) => (
                    unit.messageIds.includes(summary!.coverage.endMessageId)
                ))?.unitId,
            };
        }
        baseDiagnostics.boundaryUnitId = capped.boundaryUnitId || selected.boundaryUnitId;
        baseDiagnostics.newlyCoveredMessageCount = capped.newlyCoveredMessages.length;
        const cappedTailMessages = messages.slice(capped.coveredMessages.length);
        baseDiagnostics.recentTailMessageCount = cappedTailMessages.length;
        baseDiagnostics.recentTailContextTokens = countMessageContextTokens(this.counter, input, cappedTailMessages);
        baseDiagnostics.recentTailUnitCount = countTailUnits(build, cappedTailMessages);
        if (!capped.newlyCoveredMessages.length && !dependencyRefreshOnly) {
            baseDiagnostics.mode = 'degraded';
            baseDiagnostics.warnings.push(selected.blockedBy?.reason || 'No closed atomic prefix is available for semantic compaction.');
            return { snapshot, summary, diagnostics: baseDiagnostics };
        }

        const compactorSources = relevantCompactorSources(summary, capped.newlyCoveredMessages, sources);
        const identityMessages = rebuildReason ? selected.coveredMessages : capped.newlyCoveredMessages;
        const candidateIdentity = `${compactionMode}:${previousSummary?.generation || 0}:${buildMessageSourceHash(identityMessages)}:${buildDependencyHash(sources)}`;
        let failure = this.failures.get(failureKey);
        if (input.explicitRetry || (failure && failure.candidateIdentity !== candidateIdentity)) {
            failure = undefined;
            this.failures.delete(failureKey);
        }
        if (failure?.circuitOpen) {
            baseDiagnostics.mode = 'degraded';
            baseDiagnostics.failureCode = 'CONTEXT_COMPACTION_CIRCUIT_OPEN';
            baseDiagnostics.errorCode = 'CONTEXT_COMPACTION_CIRCUIT_OPEN';
            baseDiagnostics.consecutiveFailures = failure.consecutiveFailures;
            baseDiagnostics.circuitOpen = true;
            baseDiagnostics.warnings.push('Semantic compaction circuit is open for this conversation and model.');
            return { snapshot, summary, diagnostics: baseDiagnostics };
        }

        if (rebuildReason && capped.coveredMessages.length < selected.coveredMessages.length) {
            if (!input.background) {
                const scheduled = this.scheduleBackgroundRebuild(input, rebuildReason);
                return {
                    snapshot,
                    summary,
                    diagnostics: {
                        ...baseDiagnostics,
                        mode: summary ? 'projection' : 'degraded',
                        rebuildTaskId: scheduled.taskId,
                        rebuildStatus: 'running',
                        rebuildCompletedChunks: 0,
                        rebuildMaxChunks: this.options.maxRebuildChunks,
                        rebuildElapsedMs: 0,
                        rebuildMaxDurationMs: this.options.maxRebuildDurationMs,
                        rebuildChunksCompleted: 0,
                        rebuildChunkCount: Math.ceil(
                            selected.coveredMessages.filter((message) => message.role === 'user').length
                                / maximumUserMessages,
                        ),
                        statusCodes: ['CONTEXT_REBUILD_IN_PROGRESS'],
                        failureCode: 'CONTEXT_REBUILD_IN_PROGRESS',
                        warnings: [
                            ...baseDiagnostics.warnings,
                            'The complete generation rebuild is continuing as a shared background task.',
                        ],
                    },
                };
            }
            return this.performMultiChunkRebuild({
                input,
                signal,
                taskProgress: taskProgress!,
                budget,
                snapshot,
                trustedSummary: summary,
                previousSummary: previousSummary!,
                rebuildReason,
                messages,
                sources,
                build,
                targetMessages: selected.coveredMessages,
                baseDiagnostics,
                failureKey,
                candidateIdentity,
                maximumCompactorBytes,
                maximumUserMessages,
                compactorMaxOutputTokens,
            });
        }

        const compactor = new AgentConversationCompactor(this.providerFactory());
        let compacted: AgentConversationCompactorOutput;
        try {
            compacted = await compactor.compact({
                mode: compactionMode,
                dependencyRefresh,
                providerType: input.providerType,
                model: input.model,
                previousProjection: rebuildReason ? null : summary?.semanticProjection || null,
                newlyCoveredMessages: capped.newlyCoveredMessages,
                relevantHistoricalMessages: rebuildReason
                    ? []
                    : relevantHistoricalMessages(summary, messages, capped.newlyCoveredMessages),
                availableSources: compactorSources,
                maxOutputTokens: compactorMaxOutputTokens,
                timeoutMs: this.options.compactorTimeoutMs,
                signal,
            });
        } catch (error) {
            if (error instanceof AgentConversationCompactorError
                && error.code === 'CONTEXT_COMPACTION_OVERFLOW'
                && Number(error.details?.attempts || 1) < 2) {
                capped = capPrefixForCompactor({
                    build,
                    coveredMessages: capped.coveredMessages,
                    newlyCoveredMessages: capped.newlyCoveredMessages,
                    previousProjection: rebuildReason ? null : summary?.semanticProjection || null,
                    sources: compactorSources,
                    maximumBytes: Math.floor(maximumCompactorBytes / 2),
                    maximumUserMessages,
                });
                if (capped.newlyCoveredMessages.length) {
                    try {
                        compacted = await compactor.compact({
                            mode: compactionMode,
                            dependencyRefresh,
                            providerType: input.providerType,
                            model: input.model,
                            previousProjection: rebuildReason ? null : summary?.semanticProjection || null,
                            newlyCoveredMessages: capped.newlyCoveredMessages,
                            relevantHistoricalMessages: rebuildReason
                                ? []
                                : relevantHistoricalMessages(summary, messages, capped.newlyCoveredMessages),
                            availableSources: compactorSources,
                            maxOutputTokens: compactorMaxOutputTokens,
                            timeoutMs: this.options.compactorTimeoutMs,
                            allowConnectionRetry: false,
                            signal,
                        });
                    } catch (retryError) {
                        return this.failedResult(snapshot, summary, baseDiagnostics, failureKey, candidateIdentity, retryError);
                    }
                } else {
                    return this.failedResult(snapshot, summary, baseDiagnostics, failureKey, candidateIdentity, error);
                }
            } else {
                return this.failedResult(snapshot, summary, baseDiagnostics, failureKey, candidateIdentity, error);
            }
        }
        if (signal.aborted) throw abortError();
        const projectionCount = this.counter.count({
            providerType: input.providerType,
            model: input.model,
            prompt: canonicalJson(compacted.result.semanticProjection),
            configuredContextWindowTokens: input.configuredContextWindowTokens,
        });
        const projectionBudget = Math.max(512, Math.min(
            4_096,
            compactorMaxOutputTokens - 256,
            Math.max(768, Math.floor(budget.targetContextBudget * 0.18)),
        ));
        if (!projectionCount || projectionCount.contextTokens > projectionBudget) {
            return this.failedResult(
                snapshot,
                summary,
                baseDiagnostics,
                failureKey,
                candidateIdentity,
                new AgentConversationCompactorError(
                    'CONTEXT_COMPACTION_INVALID',
                    'Semantic projection exceeds its bounded model-visible budget.',
                    { projectionTokens: projectionCount?.contextTokens, projectionBudget },
                ),
            );
        }
        let nextSummary: AgentConversationSummaryV2;
        try {
            nextSummary = validateAndCreateSummaryV2({
                previous: previousSummary,
                result: compacted.result,
                coveredMessages: capped.coveredMessages,
                newlyCoveredMessages: capped.newlyCoveredMessages,
                availableProjectSources: sources,
                providerType: input.providerType,
                model: input.model,
                promptVersion: compacted.promptVersion,
                ...(rebuildReason ? { rebuildReason } : {}),
                ...(dependencyRefreshOnly ? { dependencyRefresh: true } : {}),
            });
        } catch (error) {
            return this.failedResult(snapshot, summary, baseDiagnostics, failureKey, candidateIdentity, error);
        }
        if (signal.aborted) throw abortError();
        const latest = await this.store.readCompressionSnapshot(input.storageConversationId);
        if (latest && requestIdentity.status === 'valid') validateCurrentRequestIdentity(latest, input);
        const latestMessages = (latest?.messages || []).filter((message) => (
            !requestMessageId || message.messageId !== requestMessageId
        )) as SummaryMessageSource[];
        const latestCoveredMessages = latestMessages.slice(0, nextSummary.coverage.messageCount);
        const latestSources = latest ? mergeSources(latest, input.availableProjectSources) : [];
        const latestSourceByKey = new Map(latestSources.map((source) => [
            `${source.sourceType}:${source.sourceId}`,
            source,
        ]));
        const sourcesStillCurrent = nextSummary.sourceIndex.sourceFingerprints.every((source) => {
            const current = latestSourceByKey.get(`${source.sourceType}:${source.sourceId}`);
            return current?.contentHash === source.contentHash
                && (!source.sourceVersion || current.sourceVersion === source.sourceVersion);
        });
        const candidateStillCurrent = latest
            && latest.summaryCasToken.rawValue === snapshot.summaryCasToken.rawValue
            && latestCoveredMessages.length === nextSummary.coverage.messageCount
            && buildMessageSourceHash(latestCoveredMessages) === nextSummary.coverage.sourceHash
            && sourcesStillCurrent;
        if (!candidateStillCurrent) {
            return this.failedResult(
                latest || snapshot,
                normalizeAgentConversationSummaryV2(latest?.contextSummary || null) || summary,
                { ...baseDiagnostics, casConflict: true },
                failureKey,
                candidateIdentity,
                new AiActionError('CONTEXT_COMPACTION_CONFLICT', 'Context compaction sources changed before publication.'),
            );
        }
        const cas = await this.store.compareAndSwapContextSummary(
            input.storageConversationId,
            snapshot.summaryCasToken,
            nextSummary as unknown as Record<string, unknown>,
        );
        if (!cas.ok) {
            const conflicted = await this.store.readCompressionSnapshot(input.storageConversationId);
            const latestSummary = normalizeAgentConversationSummaryV2(conflicted?.contextSummary || null);
            return this.failedResult(
                conflicted || latest || snapshot,
                latestSummary || summary,
                { ...baseDiagnostics, casConflict: true },
                failureKey,
                candidateIdentity,
                new AiActionError('CONTEXT_COMPACTION_CONFLICT', 'Context summary CAS conflict.'),
            );
        }
        summary = nextSummary;
        this.failures.delete(failureKey);
        const postCount = countCandidateTokens(this.counter, input, summary, latestMessages);
        const latestTailMessages = latestMessages.slice(summary.coverage.messageCount);
        return {
            snapshot: latest,
            summary,
            diagnostics: {
                ...baseDiagnostics,
                mode: 'semantic',
                postCompressionContextTokens: postCount.contextTokens,
                postCompressionProviderInputTokens: postCount.providerInputTokens,
                summaryRevision: summary.revision,
                summaryGeneration: summary.generation,
                ...(summary.rebuild ? { rebuildReason: summary.rebuild.reason } : {}),
                coverageMessageCount: summary.coverage.messageCount,
                coverageStartMessageId: summary.coverage.startMessageId,
                coverageEndMessageId: summary.coverage.endMessageId,
                sourceHashStatus: 'valid',
                dependencyHashStatus: 'valid',
                newlyCoveredMessageCount: capped.newlyCoveredMessages.length,
                recentTailMessageCount: latestTailMessages.length,
                recentTailContextTokens: countMessageContextTokens(this.counter, input, latestTailMessages),
                recentTailUnitCount: countTailUnits(
                    this.atomicBuilder.build({ messages: latestMessages, stateRefs: input.stateRefs }),
                    latestTailMessages,
                ),
                ...sourceIndexDiagnostics(summary),
                invalidatedSourceCount: existing.invalidatedSourceCount,
                ...(qualitySample(summary) ? { qualitySample: qualitySample(summary) } : {}),
                compactor: {
                    providerType: input.providerType,
                    model: input.model,
                    promptVersion: compacted.promptVersion,
                    elapsedMs: compacted.elapsedMs,
                    inputTokens: compacted.inputBytes,
                    outputTokens: compacted.outputBytes,
                    tokenCountMethod: postCount.method,
                    inputBytes: compacted.inputBytes,
                    outputBytes: compacted.outputBytes,
                    retries: compacted.retries,
                },
                consecutiveFailures: 0,
                circuitOpen: false,
            },
        };
    }

    private async performMultiChunkRebuild(args: {
        input: AgentContextCompressionCoordinatorInput;
        signal: AbortSignal;
        taskProgress: SharedTaskProgress;
        budget: AgentContextBudget;
        snapshot: AgentConversationCompressionSnapshot;
        trustedSummary: AgentConversationSummaryV2 | null;
        previousSummary: AgentConversationSummaryV2;
        rebuildReason: AgentConversationSummaryRebuildReason;
        messages: SummaryMessageSource[];
        sources: SummarySourceFingerprint[];
        build: ContextAtomicBuildResult;
        targetMessages: SummaryMessageSource[];
        baseDiagnostics: AgentContextCompressionCoordinatorDiagnostics;
        failureKey: string;
        candidateIdentity: string;
        maximumCompactorBytes: number;
        maximumUserMessages: number;
        compactorMaxOutputTokens: number;
    }): Promise<AgentContextCompressionCoordinatorResult> {
        const startedAt = args.taskProgress.startedAt;
        const deadline = startedAt + this.options.maxRebuildDurationMs;
        const compactor = new AgentConversationCompactor(this.providerFactory());
        const projectionBudget = Math.max(512, Math.min(
            4_096,
            args.compactorMaxOutputTokens - 256,
            Math.max(768, Math.floor(args.budget.targetContextBudget * 0.18)),
        ));
        let processedCount = 0;
        let candidateProjection: AgentConversationSemanticProjection | null = null;
        const candidateLedger: AgentConversationCompactionResultV2['userMessageLedgerDelta'] = [];
        const candidateSources = new Map<string, SummarySourceFingerprint>();
        let chunksCompleted = 0;
        let aggregateInputBytes = 0;
        let aggregateOutputBytes = 0;
        let aggregateRetries = 0;
        let aggregateElapsedMs = 0;
        let promptVersion = '';
        args.taskProgress.estimatedChunks = Math.ceil(
            args.targetMessages.filter((message) => message.role === 'user').length
                / args.maximumUserMessages,
        );
        const rebuildDiagnostics = (
            status: AgentContextCompressionCoordinatorDiagnostics['rebuildStatus'],
            extra: Partial<AgentContextCompressionCoordinatorDiagnostics> = {},
        ): AgentContextCompressionCoordinatorDiagnostics => ({
            ...args.baseDiagnostics,
            rebuildTaskId: args.taskProgress.taskId,
            rebuildStatus: status,
            rebuildCompletedChunks: chunksCompleted,
            rebuildMaxChunks: this.options.maxRebuildChunks,
            rebuildElapsedMs: Math.max(0, Date.now() - startedAt),
            rebuildMaxDurationMs: this.options.maxRebuildDurationMs,
            rebuildChunksCompleted: chunksCompleted,
            rebuildChunkCount: args.taskProgress.estimatedChunks,
            ...extra,
        });

        while (processedCount < args.targetMessages.length) {
            if (args.signal.aborted) throw abortError();
            if (chunksCompleted >= this.options.maxRebuildChunks) {
                return this.failedResult(
                    args.snapshot,
                    args.trustedSummary,
                    rebuildDiagnostics('limit_exceeded'),
                    args.failureKey,
                    args.candidateIdentity,
                    new AgentConversationCompactorError(
                        'CONTEXT_COMPACTION_REBUILD_LIMIT',
                        'Generation rebuild exceeded its maximum chunk count.',
                        { maxRebuildChunks: this.options.maxRebuildChunks },
                    ),
                );
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs < 1_000) {
                return this.failedResult(
                    args.snapshot,
                    args.trustedSummary,
                    rebuildDiagnostics('limit_exceeded'),
                    args.failureKey,
                    args.candidateIdentity,
                    new AgentConversationCompactorError(
                        'CONTEXT_COMPACTION_REBUILD_LIMIT',
                        'Generation rebuild exceeded its total duration limit.',
                        { maxRebuildDurationMs: this.options.maxRebuildDurationMs },
                    ),
                );
            }
            const remaining = args.targetMessages.slice(processedCount);
            const initialSources = relevantRebuildSources(candidateProjection, remaining, args.sources);
            let historical = rebuildHistoricalMessages(
                args.targetMessages.slice(0, processedCount),
                remaining,
            );
            let capped = capPrefixForCompactor({
                build: args.build,
                coveredMessages: args.targetMessages,
                newlyCoveredMessages: remaining,
                previousProjection: candidateProjection,
                sources: initialSources,
                historicalMessages: historical,
                maximumBytes: args.maximumCompactorBytes,
                maximumUserMessages: args.maximumUserMessages,
            });
            while (!capped.newlyCoveredMessages.length && historical.length) {
                historical = historical.slice(1);
                capped = capPrefixForCompactor({
                    build: args.build,
                    coveredMessages: args.targetMessages,
                    newlyCoveredMessages: remaining,
                    previousProjection: candidateProjection,
                    sources: initialSources,
                    historicalMessages: historical,
                    maximumBytes: args.maximumCompactorBytes,
                    maximumUserMessages: args.maximumUserMessages,
                });
            }
            if (!capped.newlyCoveredMessages.length) {
                return this.failedResult(
                    args.snapshot,
                    args.trustedSummary,
                    rebuildDiagnostics('discarded'),
                    args.failureKey,
                    args.candidateIdentity,
                    new AgentConversationCompactorError(
                        'CONTEXT_COMPACTION_INVALID',
                        'No bounded closed atomic unit fits in the next rebuild chunk.',
                    ),
                );
            }
            let chunkSources = relevantRebuildSources(
                candidateProjection,
                capped.newlyCoveredMessages,
                args.sources,
            );
            let compacted: AgentConversationCompactorOutput;
            try {
                compacted = await compactor.compact({
                    mode: 'rebuild_chunk',
                    providerType: args.input.providerType,
                    model: args.input.model,
                    previousProjection: candidateProjection,
                    newlyCoveredMessages: capped.newlyCoveredMessages,
                    relevantHistoricalMessages: historical,
                    availableSources: chunkSources,
                    maxOutputTokens: args.compactorMaxOutputTokens,
                    timeoutMs: Math.min(this.options.compactorTimeoutMs, remainingMs),
                    signal: args.signal,
                });
            } catch (error) {
                if (!(error instanceof AgentConversationCompactorError)
                    || error.code !== 'CONTEXT_COMPACTION_OVERFLOW') {
                    return this.failedResult(
                        args.snapshot,
                        args.trustedSummary,
                        rebuildDiagnostics('discarded'),
                        args.failureKey,
                        args.candidateIdentity,
                        error,
                    );
                }
                capped = capPrefixForCompactor({
                    build: args.build,
                    coveredMessages: args.targetMessages,
                    newlyCoveredMessages: remaining,
                    previousProjection: candidateProjection,
                    sources: chunkSources,
                    historicalMessages: historical,
                    maximumBytes: Math.floor(args.maximumCompactorBytes / 2),
                    maximumUserMessages: args.maximumUserMessages,
                });
                if (!capped.newlyCoveredMessages.length) {
                    return this.failedResult(
                        args.snapshot,
                        args.trustedSummary,
                        rebuildDiagnostics('discarded'),
                        args.failureKey,
                        args.candidateIdentity,
                        error,
                    );
                }
                chunkSources = relevantRebuildSources(
                    candidateProjection,
                    capped.newlyCoveredMessages,
                    args.sources,
                );
                try {
                    compacted = await compactor.compact({
                        mode: 'rebuild_chunk',
                        providerType: args.input.providerType,
                        model: args.input.model,
                        previousProjection: candidateProjection,
                        newlyCoveredMessages: capped.newlyCoveredMessages,
                        relevantHistoricalMessages: historical,
                        availableSources: chunkSources,
                        maxOutputTokens: args.compactorMaxOutputTokens,
                        timeoutMs: Math.min(this.options.compactorTimeoutMs, Math.max(1_000, deadline - Date.now())),
                        allowConnectionRetry: false,
                        signal: args.signal,
                    });
                } catch (retryError) {
                    return this.failedResult(
                        args.snapshot,
                        args.trustedSummary,
                        rebuildDiagnostics('discarded'),
                        args.failureKey,
                        args.candidateIdentity,
                        retryError,
                    );
                }
            }

            const processedMessages = args.targetMessages.slice(
                0,
                processedCount + capped.newlyCoveredMessages.length,
            );
            try {
                validateRebuildChunk({
                    result: compacted.result,
                    chunkMessages: capped.newlyCoveredMessages,
                    processedMessages,
                    availableSources: args.sources,
                });
            } catch (error) {
                return this.failedResult(
                    args.snapshot,
                    args.trustedSummary,
                    rebuildDiagnostics('discarded'),
                    args.failureKey,
                    args.candidateIdentity,
                    error,
                );
            }
            const projectionCount = this.counter.count({
                providerType: args.input.providerType,
                model: args.input.model,
                prompt: canonicalJson(compacted.result.semanticProjection),
                configuredContextWindowTokens: args.input.configuredContextWindowTokens,
            });
            if (!projectionCount || projectionCount.contextTokens > projectionBudget) {
                return this.failedResult(
                    args.snapshot,
                    args.trustedSummary,
                    rebuildDiagnostics('discarded'),
                    args.failureKey,
                    args.candidateIdentity,
                    new AgentConversationCompactorError(
                        'CONTEXT_COMPACTION_INVALID',
                        'A rebuild candidate projection exceeds its bounded model-visible budget.',
                        { projectionTokens: projectionCount?.contextTokens, projectionBudget },
                    ),
                );
            }
            candidateProjection = compacted.result.semanticProjection;
            candidateLedger.push(...compacted.result.userMessageLedgerDelta);
            for (const source of compacted.result.referencedSources) {
                candidateSources.set(`${source.sourceType}:${source.sourceId}`, source);
            }
            processedCount += capped.newlyCoveredMessages.length;
            chunksCompleted += 1;
            args.taskProgress.completedChunks = chunksCompleted;
            aggregateInputBytes += compacted.inputBytes;
            aggregateOutputBytes += compacted.outputBytes;
            aggregateRetries += compacted.retries;
            aggregateElapsedMs += compacted.elapsedMs;
            promptVersion = compacted.promptVersion;
        }

        if (args.signal.aborted) throw abortError();
        if (Date.now() >= deadline) {
            return this.failedResult(
                args.snapshot,
                args.trustedSummary,
                rebuildDiagnostics('limit_exceeded'),
                args.failureKey,
                args.candidateIdentity,
                new AgentConversationCompactorError(
                    'CONTEXT_COMPACTION_REBUILD_LIMIT',
                    'Generation rebuild reached its total duration limit before final validation.',
                    { maxRebuildDurationMs: this.options.maxRebuildDurationMs },
                ),
            );
        }
        const finalResult: AgentConversationCompactionResultV2 = {
            mode: 'rebuild_chunk',
            semanticProjection: candidateProjection!,
            userMessageLedgerDelta: candidateLedger,
            referencedSources: [...candidateSources.values()],
        };
        let nextSummary: AgentConversationSummaryV2;
        try {
            nextSummary = validateAndCreateSummaryV2({
                previous: args.previousSummary,
                result: finalResult,
                coveredMessages: args.targetMessages,
                newlyCoveredMessages: args.targetMessages,
                availableProjectSources: args.sources,
                providerType: args.input.providerType,
                model: args.input.model,
                promptVersion,
                rebuildReason: args.rebuildReason,
            });
        } catch (error) {
            return this.failedResult(
                args.snapshot,
                args.trustedSummary,
                rebuildDiagnostics('discarded'),
                args.failureKey,
                args.candidateIdentity,
                error,
            );
        }

        const latest = await this.store.readCompressionSnapshot(args.input.storageConversationId);
        if (latest && currentRequestMessageId(args.input.currentRequest)) {
            validateCurrentRequestIdentity(latest, args.input);
        }
        const requestMessageId = currentRequestMessageId(args.input.currentRequest);
        const latestMessages = (latest?.messages || []).filter((message) => (
            !requestMessageId || message.messageId !== requestMessageId
        )) as SummaryMessageSource[];
        const latestCovered = latestMessages.slice(0, args.targetMessages.length);
        const sourceStillCurrent = latest
            && latest.summaryCasToken.rawValue === args.snapshot.summaryCasToken.rawValue
            && latestCovered.length === args.targetMessages.length
            && buildMessageSourceHash(latestCovered) === nextSummary.coverage.sourceHash;
        const latestSources = latest ? mergeSources(latest, args.input.availableProjectSources) : [];
        const latestSourceByKey = new Map(latestSources.map((source) => [
            `${source.sourceType}:${source.sourceId}`,
            source,
        ]));
        const dependenciesStillCurrent = nextSummary.sourceIndex.sourceFingerprints.every((source) => {
            const current = latestSourceByKey.get(`${source.sourceType}:${source.sourceId}`);
            return current?.contentHash === source.contentHash
                && (!source.sourceVersion || current.sourceVersion === source.sourceVersion);
        });
        if (!sourceStillCurrent || !dependenciesStillCurrent) {
            return this.failedResult(
                latest || args.snapshot,
                args.trustedSummary,
                rebuildDiagnostics('discarded', { casConflict: true }),
                args.failureKey,
                args.candidateIdentity,
                new AiActionError('CONTEXT_COMPACTION_CONFLICT', 'Generation rebuild sources changed before publication.'),
            );
        }
        if (args.signal.aborted) throw abortError();
        if (Date.now() >= deadline) {
            return this.failedResult(
                latest || args.snapshot,
                args.trustedSummary,
                rebuildDiagnostics('limit_exceeded'),
                args.failureKey,
                args.candidateIdentity,
                new AgentConversationCompactorError(
                    'CONTEXT_COMPACTION_REBUILD_LIMIT',
                    'Generation rebuild reached its total duration limit before publication.',
                    { maxRebuildDurationMs: this.options.maxRebuildDurationMs },
                ),
            );
        }
        const cas = await this.store.compareAndSwapContextSummary(
            args.input.storageConversationId,
            args.snapshot.summaryCasToken,
            nextSummary as unknown as Record<string, unknown>,
        );
        if (!cas.ok) {
            const conflicted = await this.store.readCompressionSnapshot(args.input.storageConversationId);
            return this.failedResult(
                conflicted || latest || args.snapshot,
                normalizeAgentConversationSummaryV2(conflicted?.contextSummary || null) || args.trustedSummary,
                rebuildDiagnostics('discarded', { casConflict: true }),
                args.failureKey,
                args.candidateIdentity,
                new AiActionError('CONTEXT_COMPACTION_CONFLICT', 'Context summary CAS conflict.'),
            );
        }
        this.failures.delete(args.failureKey);
        const postCount = countCandidateTokens(this.counter, args.input, nextSummary, args.messages);
        return {
            snapshot: latest,
            summary: nextSummary,
            diagnostics: {
                ...rebuildDiagnostics('completed'),
                mode: 'semantic',
                postCompressionContextTokens: postCount.contextTokens,
                postCompressionProviderInputTokens: postCount.providerInputTokens,
                summaryRevision: nextSummary.revision,
                summaryGeneration: nextSummary.generation,
                rebuildReason: nextSummary.rebuild!.reason,
                rebuildStatus: 'completed',
                rebuildCompletedChunks: chunksCompleted,
                rebuildChunksCompleted: chunksCompleted,
                rebuildChunkCount: chunksCompleted,
                coverageMessageCount: nextSummary.coverage.messageCount,
                coverageStartMessageId: nextSummary.coverage.startMessageId,
                coverageEndMessageId: nextSummary.coverage.endMessageId,
                sourceHashStatus: 'valid',
                dependencyHashStatus: 'valid',
                newlyCoveredMessageCount: args.targetMessages.length,
                recentTailMessageCount: args.messages.length - args.targetMessages.length,
                recentTailContextTokens: countMessageContextTokens(
                    this.counter,
                    args.input,
                    args.messages.slice(args.targetMessages.length),
                ),
                recentTailUnitCount: countTailUnits(
                    args.build,
                    args.messages.slice(args.targetMessages.length),
                ),
                ...sourceIndexDiagnostics(nextSummary),
                invalidatedSourceCount: 0,
                ...(qualitySample(nextSummary) ? { qualitySample: qualitySample(nextSummary) } : {}),
                compactor: {
                    providerType: args.input.providerType,
                    model: args.input.model,
                    promptVersion,
                    elapsedMs: aggregateElapsedMs,
                    inputTokens: aggregateInputBytes,
                    outputTokens: aggregateOutputBytes,
                    tokenCountMethod: postCount.method,
                    inputBytes: aggregateInputBytes,
                    outputBytes: aggregateOutputBytes,
                    retries: aggregateRetries,
                },
                consecutiveFailures: 0,
                circuitOpen: false,
            },
        };
    }

    private failedResult(
        snapshot: AgentConversationCompressionSnapshot,
        summary: AgentConversationSummaryV2 | null,
        diagnostics: AgentContextCompressionCoordinatorDiagnostics,
        failureKey: string,
        candidateIdentity: string,
        error: unknown,
    ): AgentContextCompressionCoordinatorResult {
        if (error instanceof AgentConversationCompactorError
            && error.code === 'CONTEXT_COMPACTION_ABORTED') throw error;
        const previous = this.failures.get(failureKey);
        const consecutiveFailures = previous?.candidateIdentity === candidateIdentity
            ? previous.consecutiveFailures + 1
            : 1;
        const nextFailure = {
            candidateIdentity,
            consecutiveFailures,
            circuitOpen: consecutiveFailures >= 3,
        };
        this.failures.set(failureKey, nextFailure);
        const failureCode = error instanceof AgentConversationCompactorError
            ? error.code
            : error instanceof AiActionError
                ? error.code
                : 'CONTEXT_COMPACTION_INVALID';
        return {
            snapshot,
            summary,
            diagnostics: {
                ...diagnostics,
                mode: 'degraded',
                errorCode: failureCode,
                failureCode,
                consecutiveFailures,
                circuitOpen: nextFailure.circuitOpen,
                warnings: [...diagnostics.warnings, error instanceof Error ? error.message : String(error)],
            },
        };
    }

    private scheduleBackgroundRebuild(
        input: AgentContextCompressionCoordinatorInput,
        rebuildReason: AgentConversationSummaryRebuildReason,
    ): { taskId: string; startedAt: number } {
        const startedAt = Date.now();
        const taskId = `context-rebuild-${sha256(canonicalJson({
            conversationId: input.storageConversationId,
            rebuildReason,
            startedAt,
        })).slice(0, 24)}`;
        queueMicrotask(() => {
            void this.prepare({
                ...input,
                signal: undefined,
                force: true,
                background: true,
                rebuildReason,
                rebuildTaskId: taskId,
                rebuildTaskStartedAt: startedAt,
            }).catch(() => undefined);
        });
        return { taskId, startedAt };
    }

    private async backgroundInProgressResult(
        input: AgentContextCompressionCoordinatorInput,
        activeTask: SharedTask,
        prepared: PreparedCompressionTask,
    ): Promise<AgentContextCompressionCoordinatorResult> {
        const { budget, requestIdentity } = prepared;
        const snapshot = prepared.snapshot;
        if (!snapshot) return this.noSnapshotResult(budget);
        const requestMessageId = requestIdentity.messageId;
        const messages = snapshot.messages.filter((message) => (
            !requestMessageId || message.messageId !== requestMessageId
        )) as SummaryMessageSource[];
        const sources = mergeSources(snapshot, input.availableProjectSources);
        const existing = validateExistingSummary({
            rawSummary: snapshot.contextSummary,
            messages,
            availableSources: sources,
        });
        const trustedSummary = existing.summary;
        const persistedSummary = existing.persistedSummary;
        const build = this.atomicBuilder.build({ messages, stateRefs: input.stateRefs });
        const preCount = countCandidateTokens(this.counter, input, trustedSummary, messages);
        const tailMessages = messages.slice(trustedSummary?.coverage.messageCount || 0);
        const failureKey = `${input.storageConversationId}:${budget.profile.profileId}:${input.model}`;
        const rebuildReason = activeTask.rebuildReason || input.rebuildReason
            || (existing.sourceHashStatus === 'stale' ? 'source_changed' : undefined);
        const statusCode = rebuildReason
            ? 'CONTEXT_REBUILD_IN_PROGRESS' as const
            : 'CONTEXT_PRECOMPRESSION_IN_PROGRESS' as const;
        return {
            snapshot,
            summary: trustedSummary,
            diagnostics: {
                mode: trustedSummary ? 'projection' : 'degraded',
                operationKind: activeTask.operationKind,
                triggered: true,
                triggerReason: activeTask.operationKind === 'dependency_refresh'
                    ? 'dependency_changed'
                    : rebuildReason === 'manual_quality_rebuild'
                    ? 'manual_rebuild'
                    : rebuildReason === 'source_changed'
                        ? 'source_changed'
                        : 'forced',
                currentRequestIdentityStatus: requestIdentity.status,
                currentRequestPayloadOccurrences: requestIdentity.status === 'valid' ? 1 : 0,
                preCompressionContextTokens: preCount.contextTokens,
                postCompressionContextTokens: preCount.contextTokens,
                preCompressionProviderInputTokens: preCount.providerInputTokens,
                postCompressionProviderInputTokens: preCount.providerInputTokens,
                hardTokenCountMethod: preCount.method,
                hardTokenCountProfileId: preCount.profileId,
                targetContextBudget: budget.targetContextBudget,
                summaryRevision: persistedSummary?.revision || 0,
                summaryGeneration: persistedSummary?.generation || 0,
                ...(rebuildReason ? { rebuildReason } : {}),
                rebuildTaskId: rebuildReason ? activeTask.progress?.taskId || null : null,
                rebuildStatus: rebuildReason ? 'running' : 'idle',
                rebuildCompletedChunks: rebuildReason ? activeTask.progress?.completedChunks || 0 : 0,
                rebuildMaxChunks: this.options.maxRebuildChunks,
                rebuildElapsedMs: rebuildReason && activeTask.progress
                    ? Math.max(0, Date.now() - activeTask.progress.startedAt)
                    : 0,
                rebuildMaxDurationMs: this.options.maxRebuildDurationMs,
                ...(rebuildReason ? {
                    rebuildChunksCompleted: activeTask.progress?.completedChunks || 0,
                    rebuildChunkCount: activeTask.progress?.estimatedChunks || undefined,
                } : {}),
                coverageMessageCount: trustedSummary?.coverage.messageCount || 0,
                ...(trustedSummary ? {
                    coverageStartMessageId: trustedSummary.coverage.startMessageId,
                    coverageEndMessageId: trustedSummary.coverage.endMessageId,
                } : {}),
                sourceHashStatus: existing.sourceHashStatus,
                dependencyHashStatus: existing.dependencyHashStatus,
                atomicUnitCount: build.units.length,
                ...(build.blockingUnit ? {
                    blockingUnitId: build.blockingUnit.unitId,
                    blockingSequenceStart: build.blockingUnit.sequenceStart,
                    blockingSequenceEnd: build.blockingUnit.sequenceEnd,
                } : {}),
                newlyCoveredMessageCount: 0,
                recentTailMessageCount: tailMessages.length,
                recentTailContextTokens: countMessageContextTokens(this.counter, input, tailMessages),
                recentTailUnitCount: countTailUnits(build, tailMessages),
                ...sourceIndexDiagnostics(trustedSummary),
                invalidatedSourceCount: existing.invalidatedSourceCount,
                statusCodes: [statusCode],
                failureCode: statusCode,
                consecutiveFailures: this.failures.get(failureKey)?.consecutiveFailures || 0,
                circuitOpen: this.failures.get(failureKey)?.circuitOpen || false,
                casConflict: false,
                warnings: [rebuildReason
                    ? 'A shared generation rebuild is still running; this request is using authoritative fallback context.'
                    : 'Shared background precompression is still running; this request is using the current authoritative context.'],
            },
        };
    }

    private noSnapshotResult(budget: AgentContextBudget): AgentContextCompressionCoordinatorResult {
        return {
            snapshot: null,
            summary: null,
            diagnostics: {
                mode: 'degraded',
                operationKind: 'none',
                triggered: false,
                triggerReason: 'none',
                currentRequestIdentityStatus: 'not_applicable',
                currentRequestPayloadOccurrences: 0,
                preCompressionContextTokens: 0,
                postCompressionContextTokens: 0,
                preCompressionProviderInputTokens: 0,
                postCompressionProviderInputTokens: 0,
                hardTokenCountMethod: 'conservative_upper_bound',
                hardTokenCountProfileId: budget.profile.profileId,
                targetContextBudget: budget.targetContextBudget,
                summaryRevision: 0,
                summaryGeneration: 0,
                rebuildTaskId: null,
                rebuildStatus: 'idle',
                rebuildCompletedChunks: 0,
                rebuildMaxChunks: this.options.maxRebuildChunks,
                rebuildElapsedMs: 0,
                rebuildMaxDurationMs: this.options.maxRebuildDurationMs,
                coverageMessageCount: 0,
                sourceHashStatus: 'none',
                dependencyHashStatus: 'none',
                atomicUnitCount: 0,
                newlyCoveredMessageCount: 0,
                recentTailMessageCount: 0,
                recentTailContextTokens: 0,
                recentTailUnitCount: 0,
                sourceIndexLedgerEntries: 0,
                sourceIndexBytes: 0,
                semanticLedgerEntries: 0,
                transientLedgerEntries: 0,
                unprojectedSemanticMessageCount: 0,
                invalidatedSourceCount: 0,
                statusCodes: [],
                errorCode: 'CONTEXT_CONVERSATION_NOT_PERSISTED',
                failureCode: 'CONTEXT_CONVERSATION_NOT_PERSISTED',
                consecutiveFailures: 0,
                circuitOpen: false,
                casConflict: false,
                warnings: ['The persisted conversation was not available; semantic compaction was skipped.'],
            },
        };
    }
}
