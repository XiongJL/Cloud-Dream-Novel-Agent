import type { AiProvider, AiProviderType } from '../types';
import { normalizeAiError } from '../errors';
import {
    canonicalJson,
    normalizeCompactionResult,
    type AgentConversationCompactionMode,
    type AgentConversationCompactionResultV2,
    type AgentConversationSemanticProjection,
    type SummaryMessageSource,
    type SummarySourceFingerprint,
} from './AgentConversationSummaryV2';

export type AgentCompactorFailureCode =
    | 'CONTEXT_COMPACTION_TIMEOUT'
    | 'CONTEXT_COMPACTION_ABORTED'
    | 'CONTEXT_COMPACTION_INVALID'
    | 'CONTEXT_COMPACTION_OVERFLOW'
    | 'CONTEXT_COMPACTION_REBUILD_LIMIT'
    | 'CONTEXT_COMPACTION_PROVIDER_FAILED';

export class AgentConversationCompactorError extends Error {
    constructor(
        public readonly code: AgentCompactorFailureCode,
        message: string,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = 'AgentConversationCompactorError';
    }
}

export interface AgentConversationCompactorInput {
    mode: AgentConversationCompactionMode;
    dependencyRefresh?: boolean;
    providerType: AiProviderType;
    model: string;
    previousProjection: AgentConversationSemanticProjection | null;
    newlyCoveredMessages: SummaryMessageSource[];
    relevantHistoricalMessages?: SummaryMessageSource[];
    availableSources: SummarySourceFingerprint[];
    maxOutputTokens: number;
    timeoutMs: number;
    allowConnectionRetry?: boolean;
    signal?: AbortSignal;
}

export interface AgentConversationCompactorOutput {
    result: AgentConversationCompactionResultV2;
    promptVersion: string;
    inputBytes: number;
    outputBytes: number;
    retries: number;
    elapsedMs: number;
}

export const AGENT_CONVERSATION_COMPACTOR_PROMPT_VERSION = 'novel-context-compactor-v2.3';
const CONNECTION_RETRY_CODES = new Set(['NETWORK_ERROR', 'PROVIDER_UNAVAILABLE']);

function retryDelay(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, 150);
        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(abortErrorForRetry());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function extractJsonObject(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
            return null;
        }
    }
}

function isContextOverflow(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '');
    return /context(?:_| )length|maximum context|too many tokens|prompt is too long|context window/i.test(message);
}

function buildPrompt(input: AgentConversationCompactorInput): string {
    return canonicalJson({
        task: 'Update a traceable semantic projection for a novel-writing conversation.',
        mode: input.mode,
        operationKind: input.dependencyRefresh ? 'dependency_refresh' : 'coverage_increment',
        rules: [
            'Return one strict JSON object and no Markdown.',
            `Return mode exactly as ${input.mode}.`,
            'Inspect every newlyCoveredMessages item exactly once.',
            'Preserve user corrections, negations, hard constraints, creative facts, intent changes, unresolved questions, and pending work.',
            'Assistant proposals are not canon facts unless a user or project source confirms them.',
            'Every semanticProjection entry must cite real sourceMessageIds, sourceArtifactIds, or sourceProjectRefs.',
            'userMessageLedgerDelta must contain every newly covered user message exactly once and no older message.',
            'Use classification=transient only for greetings or acknowledgements that change no task meaning; otherwise use semantic.',
            'A correcting user message may list earlier user message IDs in supersedesMessageIds; never rewrite an earlier ledger entry.',
            'Summary entry IDs are scoped to this output revision. Keep an old ID only when useful, and never rely on it as a permanent ledger reference.',
            'Keep the semantic projection bounded to current intent, active constraints, current continuity, unresolved work, and useful recent outcomes. Historical detail remains retrievable by source.',
            'Relevant historical messages are evidence for resolving corrections and references, not newly covered messages; do not add them to userMessageLedgerDelta.',
            ...(input.dependencyRefresh ? [
                'This operation refreshes changed project dependencies. Rebuild affected projection entries from the latest availableSources.',
                'When newlyCoveredMessages is empty, userMessageLedgerDelta must be an empty array and the existing ledger remains unchanged outside this model request.',
            ] : []),
            'Do not emit tools, analysis, hidden reasoning, or source content not present in this request.',
        ],
        outputSchema: {
            mode: input.mode,
            semanticProjection: {
                activeIntent: 'SummaryEntry[]',
                hardConstraints: 'SummaryEntry[]',
                confirmedDecisions: 'SummaryEntry[]',
                canonFacts: 'SummaryEntry[]',
                creativeContinuity: 'SummaryEntry[]',
                unresolvedQuestions: 'SummaryEntry[]',
                completedOutcomes: 'SummaryEntry[]',
                pendingWork: 'SummaryEntry[]',
                artifactRefs: 'ArtifactSummaryRef[]',
            },
            userMessageLedgerDelta: 'UserMessageLedgerEntry[]',
            referencedSources: 'SummarySourceFingerprint[]',
        },
        enumRules: {
            authority: ['user', 'project', 'assistant'],
            status: ['active', 'resolved', 'superseded'],
            classification: ['semantic', 'transient'],
        },
        previousSemanticProjection: input.previousProjection,
        newlyCoveredMessages: input.newlyCoveredMessages,
        relevantHistoricalMessages: input.relevantHistoricalMessages || [],
        availableSources: input.availableSources,
    });
}

export class AgentConversationCompactor {
    constructor(private readonly provider: AiProvider) {}

    async compact(input: AgentConversationCompactorInput): Promise<AgentConversationCompactorOutput> {
        if (input.signal?.aborted) {
            throw new AgentConversationCompactorError('CONTEXT_COMPACTION_ABORTED', 'Context compaction was cancelled.');
        }
        if (!input.newlyCoveredMessages.length && !input.dependencyRefresh) {
            throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'Context compaction requires a non-empty message prefix.');
        }
        if (input.dependencyRefresh && input.mode !== 'incremental') {
            throw new AgentConversationCompactorError('CONTEXT_COMPACTION_INVALID', 'Dependency refresh must use incremental mode.');
        }
        const prompt = buildPrompt(input);
        const startedAt = Date.now();
        let retries = 0;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const response = await this.provider.generate({
                    systemPrompt: 'You are a deterministic conversation compactor. Output strict JSON only. Never call tools.',
                    prompt,
                    maxTokens: Math.max(512, Math.floor(input.maxOutputTokens)),
                    temperature: 0,
                    timeoutMs: Math.max(1_000, Math.floor(input.timeoutMs)),
                    signal: input.signal,
                });
                if (input.signal?.aborted) {
                    throw new AgentConversationCompactorError('CONTEXT_COMPACTION_ABORTED', 'Context compaction was cancelled.');
                }
                const outputBytes = Buffer.byteLength(response.text, 'utf8');
                if (outputBytes > Math.max(512, Math.floor(input.maxOutputTokens))) {
                    throw new AgentConversationCompactorError(
                        'CONTEXT_COMPACTION_INVALID',
                        'Context compactor output exceeds its conservative output-token budget.',
                        { outputUpperBoundTokens: outputBytes, maxOutputTokens: input.maxOutputTokens },
                    );
                }
                const parsed = extractJsonObject(response.text);
                const result = normalizeCompactionResult(parsed);
                if (!result || result.mode !== input.mode) {
                    throw new AgentConversationCompactorError(
                        'CONTEXT_COMPACTION_INVALID',
                        'Context compactor returned invalid JSON or an invalid schema.',
                        { attempts: attempt + 1 },
                    );
                }
                return {
                    result,
                    promptVersion: AGENT_CONVERSATION_COMPACTOR_PROMPT_VERSION,
                    inputBytes: Buffer.byteLength(prompt, 'utf8'),
                    outputBytes,
                    retries,
                    elapsedMs: Date.now() - startedAt,
                };
            } catch (error) {
                if (error instanceof AgentConversationCompactorError) throw error;
                if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                    throw new AgentConversationCompactorError('CONTEXT_COMPACTION_ABORTED', 'Context compaction was cancelled.');
                }
                if (isContextOverflow(error)) {
                    throw new AgentConversationCompactorError(
                        'CONTEXT_COMPACTION_OVERFLOW',
                        'Context compactor input exceeded its model window.',
                        { attempts: attempt + 1 },
                    );
                }
                const normalized = normalizeAiError(error);
                if (normalized.code === 'PROVIDER_TIMEOUT') {
                    throw new AgentConversationCompactorError(
                        'CONTEXT_COMPACTION_TIMEOUT',
                        normalized.message,
                        { attempts: attempt + 1 },
                    );
                }
                if (attempt === 0 && input.allowConnectionRetry !== false && CONNECTION_RETRY_CODES.has(normalized.code)) {
                    retries += 1;
                    await retryDelay(input.signal);
                    continue;
                }
                throw new AgentConversationCompactorError(
                    'CONTEXT_COMPACTION_PROVIDER_FAILED',
                    normalized.message,
                    { providerCode: normalized.code, attempts: attempt + 1 },
                );
            }
        }
        throw new AgentConversationCompactorError('CONTEXT_COMPACTION_PROVIDER_FAILED', 'Context compaction failed.');
    }
}

function abortErrorForRetry(): AgentConversationCompactorError {
    return new AgentConversationCompactorError('CONTEXT_COMPACTION_ABORTED', 'Context compaction was cancelled.');
}
