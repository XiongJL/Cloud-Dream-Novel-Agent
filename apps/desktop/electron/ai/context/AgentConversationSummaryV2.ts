import { createHash } from 'node:crypto';

export type SummaryAuthority = 'user' | 'project' | 'assistant';
export type SummaryEntryStatus = 'active' | 'resolved' | 'superseded';
export type UserMessageClassification = 'semantic' | 'transient';
export type AgentConversationCompactionMode = 'incremental' | 'rebuild_chunk';
export type AgentConversationSummaryRebuildReason = 'source_changed' | 'manual_quality_rebuild';
export type ProjectSourceType =
    | 'chapter'
    | 'character'
    | 'world_setting'
    | 'plotline'
    | 'plot_point'
    | 'item'
    | 'skill'
    | 'map'
    | 'attachment'
    | 'artifact';

export interface ProjectSourceRef {
    sourceType: ProjectSourceType;
    sourceId: string;
    sourceVersion?: string;
    contentHash: string;
}

export interface SummarySourceFingerprint extends ProjectSourceRef {
    title?: string;
}

export interface AgentConversationSummaryEntryV2 {
    id: string;
    text: string;
    sourceMessageIds?: string[];
    sourceArtifactIds?: string[];
    sourceProjectRefs?: ProjectSourceRef[];
    authority: SummaryAuthority;
    status: SummaryEntryStatus;
    supersededBy?: string;
}

export interface UserMessageLedgerEntry {
    messageId: string;
    gist: string;
    classification: UserMessageClassification;
    supersedesMessageIds?: string[];
}

export interface ArtifactSummaryRefV2 {
    artifactId: string;
    runId?: string;
    type: string;
    title: string;
    status?: string;
    sourceVersion?: string;
    contentHash: string;
    summary: string;
}

export interface AgentConversationSemanticProjection {
    activeIntent: AgentConversationSummaryEntryV2[];
    hardConstraints: AgentConversationSummaryEntryV2[];
    confirmedDecisions: AgentConversationSummaryEntryV2[];
    canonFacts: AgentConversationSummaryEntryV2[];
    creativeContinuity: AgentConversationSummaryEntryV2[];
    unresolvedQuestions: AgentConversationSummaryEntryV2[];
    completedOutcomes: AgentConversationSummaryEntryV2[];
    pendingWork: AgentConversationSummaryEntryV2[];
    artifactRefs: ArtifactSummaryRefV2[];
}

export interface AgentConversationSourceIndex {
    userMessageLedger: UserMessageLedgerEntry[];
    sourceFingerprints: SummarySourceFingerprint[];
    dependencyHash: string;
}

export interface AgentConversationSummaryV2 {
    version: 'agent-conversation-summary-v2';
    revision: number;
    previousRevision: number;
    generation: number;
    rebuild?: {
        previousGeneration: number;
        reason: AgentConversationSummaryRebuildReason;
    };
    coverage: {
        startMessageId: string;
        endMessageId: string;
        messageCount: number;
        sourceHash: string;
    };
    semanticProjection: AgentConversationSemanticProjection;
    sourceIndex: AgentConversationSourceIndex;
    updatedAt: string;
    compactor: {
        providerType: string;
        model: string;
        promptVersion: string;
    };
}

export interface AgentConversationCompactionResultV2 {
    mode: AgentConversationCompactionMode;
    semanticProjection: AgentConversationSemanticProjection;
    userMessageLedgerDelta: UserMessageLedgerEntry[];
    referencedSources: SummarySourceFingerprint[];
}

export interface SummaryMessageSource {
    messageId: string;
    sequence: number;
    role: 'user' | 'assistant';
    content: string;
}

const PROJECT_SOURCE_TYPES = new Set<ProjectSourceType>([
    'chapter', 'character', 'world_setting', 'plotline', 'plot_point',
    'item', 'skill', 'map', 'attachment', 'artifact',
]);
const ENTRY_STATUSES = new Set<SummaryEntryStatus>(['active', 'resolved', 'superseded']);
const AUTHORITIES = new Set<SummaryAuthority>(['user', 'project', 'assistant']);
const CLASSIFICATIONS = new Set<UserMessageClassification>(['semantic', 'transient']);
const COMPACTION_MODES = new Set<AgentConversationCompactionMode>(['incremental', 'rebuild_chunk']);
const REBUILD_REASONS = new Set<AgentConversationSummaryRebuildReason>(['source_changed', 'manual_quality_rebuild']);
const PROJECTION_KEYS = [
    'activeIntent',
    'hardConstraints',
    'confirmedDecisions',
    'canonFacts',
    'creativeContinuity',
    'unresolvedQuestions',
    'completedOutcomes',
    'pendingWork',
] as const;
const NON_TRANSIENT_PATTERN = /(?:不要|不能|禁止|必须|改为|纠正|决定|确认|选择|审批|范围|章节|人物|角色|设定|钥匙|事实|继续|生成|修改|重写|must\b|never\b|do not\b|change\b|decide\b|approve\b|chapter\b|character\b)/i;

export const AGENT_CONVERSATION_SUMMARY_LIMITS = Object.freeze({
    maxProjectionEntries: 96,
    maxArtifactRefs: 32,
    maxEntryTextCharacters: 1_200,
    maxArtifactSummaryCharacters: 1_200,
    maxSourceRefsPerEntry: 16,
    maxLedgerGistCharacters: 280,
});

export class AgentCompactionValidationError extends Error {
    constructor(message: string, public readonly details?: Record<string, unknown>) {
        super(message);
        this.name = 'AgentCompactionValidationError';
    }
}

export function canonicalJson(value: unknown): string {
    const normalize = (input: unknown): unknown => {
        if (Array.isArray(input)) return input.map(normalize);
        if (input && typeof input === 'object') {
            return Object.fromEntries(Object.entries(input as Record<string, unknown>)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, normalize(item)]));
        }
        if (typeof input === 'number' && !Number.isFinite(input)) return null;
        return input;
    };
    return JSON.stringify(normalize(value));
}

export function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildMessageSourceHash(messages: SummaryMessageSource[]): string {
    return sha256(canonicalJson(messages.map((message) => ({
        sequence: message.sequence,
        messageId: message.messageId,
        role: message.role,
        contentHash: sha256(message.content),
    }))));
}

export function buildDependencyHash(sources: SummarySourceFingerprint[]): string {
    return sha256(canonicalJson([...sources]
        .sort((left, right) => `${left.sourceType}:${left.sourceId}`.localeCompare(`${right.sourceType}:${right.sourceId}`))
        .map(({ sourceType, sourceId, sourceVersion, contentHash }) => ({
            sourceType, sourceId, sourceVersion: sourceVersion || '', contentHash,
        }))));
}

function recordOf(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function nonEmpty(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(nonEmpty).filter(Boolean))];
}

function normalizeProjectSource(value: unknown): ProjectSourceRef | null {
    const record = recordOf(value);
    if (!record) return null;
    const sourceType = nonEmpty(record.sourceType) as ProjectSourceType;
    const sourceId = nonEmpty(record.sourceId);
    const contentHash = nonEmpty(record.contentHash);
    if (!PROJECT_SOURCE_TYPES.has(sourceType) || !sourceId || !contentHash) return null;
    return {
        sourceType,
        sourceId,
        ...(nonEmpty(record.sourceVersion) ? { sourceVersion: nonEmpty(record.sourceVersion) } : {}),
        contentHash,
    };
}

function normalizeFingerprint(value: unknown): SummarySourceFingerprint | null {
    const source = normalizeProjectSource(value);
    if (!source) return null;
    const record = value as Record<string, unknown>;
    return { ...source, ...(nonEmpty(record.title) ? { title: nonEmpty(record.title) } : {}) };
}

function normalizeEntry(value: unknown): AgentConversationSummaryEntryV2 | null {
    const record = recordOf(value);
    if (!record) return null;
    const id = nonEmpty(record.id);
    const text = nonEmpty(record.text);
    const authority = nonEmpty(record.authority) as SummaryAuthority;
    const status = nonEmpty(record.status) as SummaryEntryStatus;
    if (!id || !text || text.length > AGENT_CONVERSATION_SUMMARY_LIMITS.maxEntryTextCharacters
        || !AUTHORITIES.has(authority) || !ENTRY_STATUSES.has(status)) return null;
    const sourceMessageIds = uniqueStrings(record.sourceMessageIds);
    const sourceArtifactIds = uniqueStrings(record.sourceArtifactIds);
    const sourceProjectRefs = (Array.isArray(record.sourceProjectRefs) ? record.sourceProjectRefs : [])
        .map(normalizeProjectSource)
        .filter((item): item is ProjectSourceRef => Boolean(item));
    const entry: AgentConversationSummaryEntryV2 = {
        id,
        text,
        authority,
        status,
        ...(sourceMessageIds.length ? { sourceMessageIds } : {}),
        ...(sourceArtifactIds.length ? { sourceArtifactIds } : {}),
        ...(sourceProjectRefs.length ? { sourceProjectRefs } : {}),
        ...(nonEmpty(record.supersededBy) ? { supersededBy: nonEmpty(record.supersededBy) } : {}),
    };
    if (sourceMessageIds.length + sourceArtifactIds.length + sourceProjectRefs.length
        > AGENT_CONVERSATION_SUMMARY_LIMITS.maxSourceRefsPerEntry) return null;
    if (!(entry.sourceMessageIds?.length || entry.sourceArtifactIds?.length || entry.sourceProjectRefs?.length)) return null;
    return entry;
}

function normalizeArtifactRef(value: unknown): ArtifactSummaryRefV2 | null {
    const record = recordOf(value);
    if (!record) return null;
    const artifactId = nonEmpty(record.artifactId);
    const type = nonEmpty(record.type);
    const title = nonEmpty(record.title);
    const contentHash = nonEmpty(record.contentHash);
    const summary = nonEmpty(record.summary);
    if (!artifactId || !type || !title || !contentHash
        || summary.length > AGENT_CONVERSATION_SUMMARY_LIMITS.maxArtifactSummaryCharacters) return null;
    return {
        artifactId,
        type,
        title,
        contentHash,
        summary,
        ...(nonEmpty(record.runId) ? { runId: nonEmpty(record.runId) } : {}),
        ...(nonEmpty(record.status) ? { status: nonEmpty(record.status) } : {}),
        ...(nonEmpty(record.sourceVersion) ? { sourceVersion: nonEmpty(record.sourceVersion) } : {}),
    };
}

function normalizeProjection(value: unknown): AgentConversationSemanticProjection | null {
    const record = recordOf(value);
    if (!record) return null;
    const projection = {} as AgentConversationSemanticProjection;
    for (const key of PROJECTION_KEYS) {
        if (!Array.isArray(record[key])) return null;
        const rawEntries = record[key] as unknown[];
        projection[key] = rawEntries
            .map(normalizeEntry)
            .filter((item): item is AgentConversationSummaryEntryV2 => Boolean(item));
        if (projection[key].length !== rawEntries.length) return null;
    }
    if (!Array.isArray(record.artifactRefs)) return null;
    projection.artifactRefs = record.artifactRefs
        .map(normalizeArtifactRef)
        .filter((item): item is ArtifactSummaryRefV2 => Boolean(item));
    if (projection.artifactRefs.length !== record.artifactRefs.length
        || projection.artifactRefs.length > AGENT_CONVERSATION_SUMMARY_LIMITS.maxArtifactRefs
        || PROJECTION_KEYS.reduce((count, key) => count + projection[key].length, 0)
            > AGENT_CONVERSATION_SUMMARY_LIMITS.maxProjectionEntries) return null;
    return projection;
}

function normalizeLedgerEntry(value: unknown): UserMessageLedgerEntry | null {
    const record = recordOf(value);
    if (!record) return null;
    const messageId = nonEmpty(record.messageId);
    const gist = nonEmpty(record.gist);
    const classification = nonEmpty(record.classification) as UserMessageClassification;
    if (!messageId || !gist || gist.length > AGENT_CONVERSATION_SUMMARY_LIMITS.maxLedgerGistCharacters
        || !CLASSIFICATIONS.has(classification)) return null;
    const supersedesMessageIds = uniqueStrings(record.supersedesMessageIds);
    if (classification === 'transient' && supersedesMessageIds.length) return null;
    return {
        messageId,
        gist,
        classification,
        ...(supersedesMessageIds.length ? { supersedesMessageIds } : {}),
    };
}

export function normalizeAgentConversationSummaryV2(value: unknown): AgentConversationSummaryV2 | null {
    const record = recordOf(value);
    if (!record || record.version !== 'agent-conversation-summary-v2') return null;
    const coverage = recordOf(record.coverage);
    const sourceIndex = recordOf(record.sourceIndex);
    const compactor = recordOf(record.compactor);
    const semanticProjection = normalizeProjection(record.semanticProjection);
    if (!coverage || !sourceIndex || !compactor || !semanticProjection) return null;
    const startMessageId = nonEmpty(coverage.startMessageId);
    const endMessageId = nonEmpty(coverage.endMessageId);
    const sourceHash = nonEmpty(coverage.sourceHash);
    const revision = Math.floor(Number(record.revision));
    const previousRevision = Math.floor(Number(record.previousRevision));
    // Early development builds emitted v2 without generation. Treat them as
    // generation 1 so existing local conversations remain recoverable.
    const generation = record.generation === undefined ? 1 : Math.floor(Number(record.generation));
    const messageCount = Math.floor(Number(coverage.messageCount));
    if (!startMessageId || !endMessageId || !sourceHash || revision < 1 || previousRevision < 0
        || revision !== previousRevision + 1
        || generation < 1 || messageCount < 1) return null;
    const rebuildRecord = record.rebuild === undefined ? null : recordOf(record.rebuild);
    let rebuild: AgentConversationSummaryV2['rebuild'];
    if (record.rebuild !== undefined) {
        if (!rebuildRecord) return null;
        const previousGeneration = Math.floor(Number(rebuildRecord.previousGeneration));
        const reason = nonEmpty(rebuildRecord.reason) as AgentConversationSummaryRebuildReason;
        if (previousGeneration < 1 || previousGeneration + 1 !== generation || !REBUILD_REASONS.has(reason)) return null;
        rebuild = { previousGeneration, reason };
    }
    const userMessageLedger = (Array.isArray(sourceIndex.userMessageLedger) ? sourceIndex.userMessageLedger : [])
        .map(normalizeLedgerEntry)
        .filter((item): item is UserMessageLedgerEntry => Boolean(item));
    const sourceFingerprints = (Array.isArray(sourceIndex.sourceFingerprints) ? sourceIndex.sourceFingerprints : [])
        .map(normalizeFingerprint)
        .filter((item): item is SummarySourceFingerprint => Boolean(item));
    const dependencyHash = nonEmpty(sourceIndex.dependencyHash);
    if (userMessageLedger.length !== (Array.isArray(sourceIndex.userMessageLedger) ? sourceIndex.userMessageLedger.length : 0)
        || new Set(userMessageLedger.map((entry) => entry.messageId)).size !== userMessageLedger.length
        || sourceFingerprints.length !== (Array.isArray(sourceIndex.sourceFingerprints) ? sourceIndex.sourceFingerprints.length : 0)
        || !dependencyHash || dependencyHash !== buildDependencyHash(sourceFingerprints)) return null;
    const updatedAt = nonEmpty(record.updatedAt);
    const providerType = nonEmpty(compactor.providerType);
    const model = nonEmpty(compactor.model);
    const promptVersion = nonEmpty(compactor.promptVersion);
    if (!updatedAt || !providerType || !model || !promptVersion) return null;
    return {
        version: 'agent-conversation-summary-v2',
        revision,
        previousRevision,
        generation,
        ...(rebuild ? { rebuild } : {}),
        coverage: { startMessageId, endMessageId, messageCount, sourceHash },
        semanticProjection,
        sourceIndex: { userMessageLedger, sourceFingerprints, dependencyHash },
        updatedAt,
        compactor: {
            providerType,
            model,
            promptVersion,
        },
    };
}

export function normalizeCompactionResult(value: unknown): AgentConversationCompactionResultV2 | null {
    const record = recordOf(value);
    if (!record) return null;
    const semanticProjection = normalizeProjection(record.semanticProjection);
    if (!semanticProjection) return null;
    const mode = nonEmpty(record.mode) as AgentConversationCompactionMode;
    if (!COMPACTION_MODES.has(mode)) return null;
    if (!Array.isArray(record.userMessageLedgerDelta) || !Array.isArray(record.referencedSources)) return null;
    const userMessageLedgerDelta = record.userMessageLedgerDelta
        .map(normalizeLedgerEntry)
        .filter((item): item is UserMessageLedgerEntry => Boolean(item));
    const referencedSources = record.referencedSources
        .map(normalizeFingerprint)
        .filter((item): item is SummarySourceFingerprint => Boolean(item));
    if (userMessageLedgerDelta.length !== record.userMessageLedgerDelta.length
        || referencedSources.length !== record.referencedSources.length) return null;
    return {
        mode,
        semanticProjection,
        userMessageLedgerDelta,
        referencedSources,
    };
}

function allProjectionEntries(projection: AgentConversationSemanticProjection): AgentConversationSummaryEntryV2[] {
    return PROJECTION_KEYS.flatMap((key) => projection[key]);
}

export function validateAgentConversationSummaryCoverageV2(
    summary: AgentConversationSummaryV2,
    coveredMessages: SummaryMessageSource[],
): boolean {
    if (coveredMessages.length !== summary.coverage.messageCount
        || coveredMessages[0]?.messageId !== summary.coverage.startMessageId
        || coveredMessages[coveredMessages.length - 1]?.messageId !== summary.coverage.endMessageId
        || buildMessageSourceHash(coveredMessages) !== summary.coverage.sourceHash) return false;
    for (let index = 1; index < coveredMessages.length; index += 1) {
        if (coveredMessages[index].sequence <= coveredMessages[index - 1].sequence) return false;
    }
    const messageById = new Map(coveredMessages.map((message) => [message.messageId, message]));
    if (messageById.size !== coveredMessages.length) return false;
    const coveredUserIds = coveredMessages
        .filter((message) => message.role === 'user')
        .map((message) => message.messageId);
    if (canonicalJson(summary.sourceIndex.userMessageLedger.map((entry) => entry.messageId))
        !== canonicalJson(coveredUserIds)) return false;
    for (const ledger of summary.sourceIndex.userMessageLedger) {
        const source = messageById.get(ledger.messageId);
        if (!source || source.role !== 'user') return false;
        if (ledger.classification === 'transient' && NON_TRANSIENT_PATTERN.test(source.content)) return false;
        for (const targetId of ledger.supersedesMessageIds || []) {
            const target = messageById.get(targetId);
            if (!target || target.role !== 'user' || target.sequence >= source.sequence) return false;
        }
    }
    const fingerprintByKey = new Map(summary.sourceIndex.sourceFingerprints.map((source) => [
        `${source.sourceType}:${source.sourceId}`,
        source,
    ]));
    if (fingerprintByKey.size !== summary.sourceIndex.sourceFingerprints.length
        || buildDependencyHash(summary.sourceIndex.sourceFingerprints) !== summary.sourceIndex.dependencyHash) return false;
    const entries = allProjectionEntries(summary.semanticProjection);
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    if (entryById.size !== entries.length) return false;
    for (const entry of entries) {
        const messageSources = (entry.sourceMessageIds || []).map((id) => messageById.get(id));
        if (messageSources.some((message) => !message)) return false;
        if (entry.authority === 'user' && !messageSources.some((message) => message?.role === 'user')) return false;
        if (entry.authority === 'assistant' && !messageSources.some((message) => message?.role === 'assistant')) return false;
        if (entry.authority === 'project' && !(entry.sourceProjectRefs?.length || entry.sourceArtifactIds?.length)) return false;
        for (const artifactId of entry.sourceArtifactIds || []) {
            if (!fingerprintByKey.has(`artifact:${artifactId}`)) return false;
        }
        for (const source of entry.sourceProjectRefs || []) {
            const fingerprint = fingerprintByKey.get(`${source.sourceType}:${source.sourceId}`);
            if (!fingerprint || fingerprint.contentHash !== source.contentHash
                || (source.sourceVersion && source.sourceVersion !== fingerprint.sourceVersion)) return false;
        }
        if (entry.status === 'superseded' && (!entry.supersededBy || !entryById.has(entry.supersededBy))) return false;
    }
    if (summary.semanticProjection.canonFacts.some((entry) => entry.authority === 'assistant')) return false;
    for (const artifact of summary.semanticProjection.artifactRefs) {
        const fingerprint = fingerprintByKey.get(`artifact:${artifact.artifactId}`);
        if (!fingerprint || fingerprint.contentHash !== artifact.contentHash
            || (artifact.sourceVersion && artifact.sourceVersion !== fingerprint.sourceVersion)) return false;
    }
    return true;
}

export function validateAndCreateSummaryV2(input: {
    previous: AgentConversationSummaryV2 | null;
    result: AgentConversationCompactionResultV2;
    coveredMessages: SummaryMessageSource[];
    newlyCoveredMessages: SummaryMessageSource[];
    availableProjectSources: SummarySourceFingerprint[];
    providerType: string;
    model: string;
    promptVersion: string;
    rebuildReason?: AgentConversationSummaryRebuildReason;
    dependencyRefresh?: boolean;
    updatedAt?: string;
}): AgentConversationSummaryV2 {
    const { previous, result } = input;
    const rebuilding = result.mode === 'rebuild_chunk';
    const messages = [...input.coveredMessages].sort((left, right) => left.sequence - right.sequence);
    const deltaMessages = [...input.newlyCoveredMessages].sort((left, right) => left.sequence - right.sequence);
    const refreshingDependencies = input.dependencyRefresh === true;
    if (!messages.length || (!deltaMessages.length && !refreshingDependencies)) {
        throw new AgentCompactionValidationError('Coverage must advance by at least one message.');
    }
    for (let index = 1; index < messages.length; index += 1) {
        if (messages[index].sequence <= messages[index - 1].sequence) {
            throw new AgentCompactionValidationError('Coverage message sequence is not strictly increasing.');
        }
    }
    if (rebuilding) {
        if (!previous || !input.rebuildReason) {
            throw new AgentCompactionValidationError('A rebuild result requires a previous summary and rebuild reason.');
        }
        if (deltaMessages.length !== messages.length
            || canonicalJson(deltaMessages.map((message) => message.messageId))
                !== canonicalJson(messages.map((message) => message.messageId))) {
            throw new AgentCompactionValidationError('A published rebuild must contain the complete target coverage.');
        }
    } else if (input.rebuildReason) {
        throw new AgentCompactionValidationError('An incremental result cannot declare a rebuild reason.');
    } else if (refreshingDependencies) {
        if (!previous || deltaMessages.length > 0
            || messages.length !== previous.coverage.messageCount
            || messages[0]?.messageId !== previous.coverage.startMessageId
            || messages[messages.length - 1]?.messageId !== previous.coverage.endMessageId
            || buildMessageSourceHash(messages) !== previous.coverage.sourceHash) {
            throw new AgentCompactionValidationError('Dependency refresh must preserve the complete existing coverage boundary.');
        }
    } else if (previous) {
        const previousEnd = messages.findIndex((message) => message.messageId === previous.coverage.endMessageId);
        if (previousEnd < 0 || previousEnd + 1 + deltaMessages.length !== messages.length) {
            throw new AgentCompactionValidationError('New coverage is not adjacent to the previous boundary.');
        }
        const actualDelta = messages.slice(previousEnd + 1).map((message) => message.messageId);
        if (canonicalJson(actualDelta) !== canonicalJson(deltaMessages.map((message) => message.messageId))) {
            throw new AgentCompactionValidationError('Compaction delta does not match the requested prefix.');
        }
    } else if (deltaMessages.length !== messages.length) {
        throw new AgentCompactionValidationError('Initial v2 coverage must be rebuilt from the full requested prefix.');
    }

    const messageById = new Map(messages.map((message) => [message.messageId, message]));
    const projectByKey = new Map(input.availableProjectSources.map((source) => [`${source.sourceType}:${source.sourceId}`, source]));
    const entries = allProjectionEntries(result.semanticProjection);
    const entryById = new Map<string, AgentConversationSummaryEntryV2>();
    for (const entry of entries) {
        if (entryById.has(entry.id)) throw new AgentCompactionValidationError(`Duplicate summary entry: ${entry.id}`);
        entryById.set(entry.id, entry);
        const messageSources = (entry.sourceMessageIds || []).map((id) => messageById.get(id));
        if ((entry.sourceMessageIds || []).some((id) => !messageById.has(id))) {
            throw new AgentCompactionValidationError(`Unknown source message for summary entry: ${entry.id}`);
        }
        for (const artifactId of entry.sourceArtifactIds || []) {
            if (!projectByKey.has(`artifact:${artifactId}`)) {
                throw new AgentCompactionValidationError(`Unknown source artifact for summary entry: ${entry.id}`);
            }
        }
        for (const source of entry.sourceProjectRefs || []) {
            const available = projectByKey.get(`${source.sourceType}:${source.sourceId}`);
            if (!available || available.contentHash !== source.contentHash || (source.sourceVersion && source.sourceVersion !== available.sourceVersion)) {
                throw new AgentCompactionValidationError(`Stale or unknown project source for summary entry: ${entry.id}`);
            }
        }
        if (entry.authority === 'user' && !messageSources.some((message) => message?.role === 'user')) {
            throw new AgentCompactionValidationError(`User authority lacks a user source: ${entry.id}`);
        }
        if (entry.authority === 'assistant' && !messageSources.some((message) => message?.role === 'assistant')) {
            throw new AgentCompactionValidationError(`Assistant authority lacks an assistant source: ${entry.id}`);
        }
        if (entry.authority === 'project' && !(entry.sourceProjectRefs?.length || entry.sourceArtifactIds?.length)) {
            throw new AgentCompactionValidationError(`Project authority lacks a project source: ${entry.id}`);
        }
    }
    for (const entry of result.semanticProjection.canonFacts) {
        if (entry.authority === 'assistant') throw new AgentCompactionValidationError(`Assistant-only canon fact: ${entry.id}`);
    }
    for (const artifact of result.semanticProjection.artifactRefs) {
        const available = projectByKey.get(`artifact:${artifact.artifactId}`);
        if (!available || available.contentHash !== artifact.contentHash
            || (artifact.sourceVersion && artifact.sourceVersion !== available.sourceVersion)) {
            throw new AgentCompactionValidationError(`Stale or unknown artifact summary: ${artifact.artifactId}`);
        }
    }
    for (const entry of entries) {
        if (entry.status === 'superseded' && (!entry.supersededBy || !entryById.has(entry.supersededBy))) {
            throw new AgentCompactionValidationError(`Invalid superseded chain: ${entry.id}`);
        }
    }

    const deltaUserMessages = deltaMessages.filter((message) => message.role === 'user');
    const deltaLedgerById = new Map(result.userMessageLedgerDelta.map((entry) => [entry.messageId, entry]));
    if (deltaLedgerById.size !== result.userMessageLedgerDelta.length || deltaLedgerById.size !== deltaUserMessages.length) {
        throw new AgentCompactionValidationError('Ledger delta must contain every newly covered user message exactly once.');
    }
    for (const message of deltaUserMessages) {
        const ledger = deltaLedgerById.get(message.messageId);
        if (!ledger) throw new AgentCompactionValidationError(`Missing ledger entry: ${message.messageId}`);
        if (ledger.classification === 'transient' && NON_TRANSIENT_PATTERN.test(message.content)) {
            throw new AgentCompactionValidationError(`Semantic user message marked transient: ${message.messageId}`);
        }
        for (const targetId of ledger.supersedesMessageIds || []) {
            const target = messageById.get(targetId);
            if (!target || target.role !== 'user' || target.sequence >= message.sequence) {
                throw new AgentCompactionValidationError(`Invalid ledger supersession target: ${message.messageId}`);
            }
        }
    }

    const previousLedger = rebuilding ? [] : previous?.sourceIndex.userMessageLedger || [];
    const previousLedgerIds = new Set(previousLedger.map((entry) => entry.messageId));
    if (result.userMessageLedgerDelta.some((entry) => previousLedgerIds.has(entry.messageId))) {
        throw new AgentCompactionValidationError('Compactor attempted to rewrite an existing ledger entry.');
    }
    const userMessageLedger = [...previousLedger, ...result.userMessageLedgerDelta];
    const coveredUserIds = messages.filter((message) => message.role === 'user').map((message) => message.messageId);
    if (canonicalJson(userMessageLedger.map((entry) => entry.messageId)) !== canonicalJson(coveredUserIds)) {
        throw new AgentCompactionValidationError('Merged ledger does not match cumulative user coverage.');
    }

    const fingerprintByKey = new Map<string, SummarySourceFingerprint>();
    for (const source of rebuilding ? [] : previous?.sourceIndex.sourceFingerprints || []) {
        const available = projectByKey.get(`${source.sourceType}:${source.sourceId}`);
        if (available && available.contentHash === source.contentHash
            && (!source.sourceVersion || source.sourceVersion === available.sourceVersion)) {
            fingerprintByKey.set(`${source.sourceType}:${source.sourceId}`, source);
        }
    }
    for (const source of result.referencedSources) {
        const available = projectByKey.get(`${source.sourceType}:${source.sourceId}`);
        if (!available || available.contentHash !== source.contentHash || (source.sourceVersion && source.sourceVersion !== available.sourceVersion)) {
            throw new AgentCompactionValidationError(`Stale or unknown referenced source: ${source.sourceType}:${source.sourceId}`);
        }
        fingerprintByKey.set(`${source.sourceType}:${source.sourceId}`, source);
    }
    const sourceFingerprints = [...fingerprintByKey.values()]
        .sort((left, right) => `${left.sourceType}:${left.sourceId}`.localeCompare(`${right.sourceType}:${right.sourceId}`));
    const revision = previous ? previous.revision + 1 : 1;
    const generation = rebuilding ? previous!.generation + 1 : previous?.generation || 1;
    return {
        version: 'agent-conversation-summary-v2',
        revision,
        previousRevision: previous?.revision || 0,
        generation,
        ...(rebuilding ? {
            rebuild: {
                previousGeneration: previous!.generation,
                reason: input.rebuildReason!,
            },
        } : {}),
        coverage: {
            startMessageId: messages[0].messageId,
            endMessageId: messages[messages.length - 1].messageId,
            messageCount: messages.length,
            sourceHash: buildMessageSourceHash(messages),
        },
        semanticProjection: result.semanticProjection,
        sourceIndex: {
            userMessageLedger,
            sourceFingerprints,
            dependencyHash: buildDependencyHash(sourceFingerprints),
        },
        updatedAt: input.updatedAt || new Date().toISOString(),
        compactor: {
            providerType: input.providerType,
            model: input.model,
            promptVersion: input.promptVersion,
        },
    };
}

export function emptySemanticProjection(): AgentConversationSemanticProjection {
    return {
        activeIntent: [],
        hardConstraints: [],
        confirmedDecisions: [],
        canonFacts: [],
        creativeContinuity: [],
        unresolvedQuestions: [],
        completedOutcomes: [],
        pendingWork: [],
        artifactRefs: [],
    };
}
