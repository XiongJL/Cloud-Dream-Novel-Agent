import type { AiProviderType } from '../types';

export type AgentContextPriority = 'required' | 'high' | 'normal' | 'low';
export type AgentContextSectionKind =
    | 'decision'
    | 'plan'
    | 'artifact'
    | 'retrieval'
    | 'tool'
    | 'metadata';

export interface AgentContextMessage {
    role: 'user' | 'assistant';
    content: string;
    createdAt?: string;
    messageId?: string;
    sourceMessageIndex?: number;
}

export interface AgentContextArtifact {
    artifactId: string;
    runId?: string;
    type?: string;
    title?: string;
    status?: string;
    summary?: string | null;
    content?: string | null;
    reference?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    createdAt?: string;
}

export interface AgentConversationSummaryEntry {
    id: string;
    text: string;
    sourceMessageIds: string[];
    sourceRole: 'user' | 'assistant';
    createdAt?: string;
}

export interface AgentConversationArtifactRef {
    artifactId: string;
    runId?: string;
    type?: string;
    title: string;
    status?: string;
    summary?: string;
    createdAt?: string;
}

export interface AgentConversationSummary {
    version: 'agent-conversation-summary-v1';
    revision: number;
    coveredMessageIds: string[];
    coverage: {
        startMessageId?: string;
        endMessageId?: string;
        messageCount: number;
    };
    facts: AgentConversationSummaryEntry[];
    userDecisions: AgentConversationSummaryEntry[];
    unresolvedQuestions: AgentConversationSummaryEntry[];
    outcomes: AgentConversationSummaryEntry[];
    artifactRefs: AgentConversationArtifactRef[];
    updatedAt: string;
}

export interface AgentContextSection {
    id: string;
    kind: AgentContextSectionKind;
    priority?: AgentContextPriority;
    value: unknown;
    sourceRef?: string;
    maxTokens?: number;
}

export interface AgentContextAssemblerInput {
    providerType: AiProviderType;
    model?: string;
    contextWindowTokens?: number;
    outputTokens: number;
    safetyTokens?: number;
    systemPrompt?: string;
    currentRequest: unknown;
    history?: AgentContextMessage[];
    sections?: AgentContextSection[];
    persistentSummary?: AgentConversationSummary | Record<string, unknown> | null;
    artifacts?: AgentContextArtifact[];
}

export interface AgentContextDiagnostics {
    contextVersion: 'agent-context-v1';
    providerType: AiProviderType;
    model: string;
    contextWindowTokens: number;
    contextWindowSource: 'configured' | 'model-profile';
    outputTokens: number;
    safetyTokens: number;
    systemTokens: number;
    inputBudgetTokens: number;
    estimatedInputTokens: number;
    compressionApplied: boolean;
    currentRequestCompressed: boolean;
    historyMessagesTotal: number;
    historyMessagesKept: number;
    historyMessagesSummarized: number;
    historyMessagesOmitted: number;
    historyMessagesCompacted: number;
    persistentConstraintsCount: number;
    persistentSummaryRevision: number;
    persistentSummaryMessageCount: number;
    recalledMessageIds: string[];
    recalledArtifactIds: string[];
    currentRequestMode: 'raw' | 'compressed';
    historySources: Array<{
        mode: 'raw' | 'compressed' | 'summary' | 'omitted';
        startMessageIndex: number;
        endMessageIndex: number;
    }>;
    sectionSources: Array<{
        id: string;
        kind: AgentContextSectionKind;
        priority: AgentContextPriority;
        mode: 'raw' | 'compressed' | 'omitted';
        sourceRef?: string;
        estimatedTokens: number;
    }>;
    compressedSectionIds: string[];
    omittedSectionIds: string[];
    warnings: string[];
}

export interface AgentContextAssembly {
    prompt: string;
    payload: Record<string, unknown>;
    diagnostics: AgentContextDiagnostics;
    summaryUpdate?: AgentConversationSummary;
}

type NormalizedSection = AgentContextSection & { priority: AgentContextPriority };

type HistorySourceMode = AgentContextDiagnostics['historySources'][number]['mode'];

const CONSTRAINT_PATTERN = /(?:必须|不要|不能|禁止|只允许|仅限|请保持|需要保持|务必|记住|风格|视角|篇幅|长度|must\b|do not\b|don't\b|never\b|only\b|keep\b|remember\b|style\b|perspective\b|length\b)/i;
const DECISION_PATTERN = /(?:决定|采用|选择|确认|就按|改为|保持|不要|不能|禁止|必须|只允许|仅限|务必|decide|choose|confirm|use\b|keep\b|must\b|never\b|do not\b)/i;
const FACT_PATTERN = /(?:当前|目前|已经|已有|设定|角色|章节|大纲|世界观|主线|支线|事实|状态|现有|current|already|existing|fact|state|chapter|character|outline)/i;
const QUESTION_PATTERN = /[?？]\s*$|(?:请问|是否|能否|哪一|哪个|什么|如何|怎么|为什么|吗[？?]?\s*$|呢[？?]?\s*$)/i;
const VAGUE_RECALL_PATTERN = /(?:上面|之前|此前|刚才|前面|继续|总结|结论|那个|这些|那些|above|previous|earlier|continue|summary|that)/i;
const PRIORITY_ORDER: Record<AgentContextPriority, number> = {
    required: 0,
    high: 1,
    normal: 2,
    low: 3,
};

export function estimateAgentContextTokens(value: string): number {
    if (!value) return 0;
    let cjk = 0;
    let other = 0;
    for (const character of value) {
        if (/[^\u0000-\u00ff]/.test(character)) cjk += 1;
        else other += 1;
    }
    return Math.max(1, cjk + Math.ceil(other / 4));
}

export function resolveAgentContextWindow(
    providerType: AiProviderType,
    model = '',
    configuredTokens = 0,
): { tokens: number; source: 'configured' | 'model-profile' } {
    if (Number.isFinite(configuredTokens) && configuredTokens >= 8192) {
        return {
            tokens: Math.min(2_000_000, Math.floor(configuredTokens)),
            source: 'configured',
        };
    }

    const normalizedModel = model.trim().toLowerCase();
    let tokens = providerType === 'mcp-cli' ? 32_768 : 65_536;
    if (/gemini|qwen-long/.test(normalizedModel)) tokens = 262_144;
    else if (/claude/.test(normalizedModel)) tokens = 180_000;
    else if (/gpt-5|gpt-4\.1/.test(normalizedModel)) tokens = 262_144;
    else if (/gpt-4o|\bo[134](?:-|$)/.test(normalizedModel)) tokens = 98_304;
    else if (/deepseek|qwen|glm|doubao/.test(normalizedModel)) tokens = 65_536;
    return { tokens, source: 'model-profile' };
}

function safeStringify(value: unknown): string {
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? String(value ?? '') : serialized;
    } catch {
        return String(value ?? '');
    }
}

function truncateToTokens(value: string, maxTokens: number): string {
    const normalized = value.trim();
    if (!normalized || maxTokens <= 0) return '';
    if (estimateAgentContextTokens(normalized) <= maxTokens) return normalized;

    let low = 0;
    let high = normalized.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (estimateAgentContextTokens(normalized.slice(0, middle)) <= Math.max(1, maxTokens - 12)) low = middle;
        else high = middle - 1;
    }
    const omitted = Math.max(0, normalized.length - low);
    return `${normalized.slice(0, low).trimEnd()}\n[compressed: ${omitted} chars omitted]`;
}

function compactValue(value: unknown, maxTokens: number): unknown {
    const serialized = safeStringify(value);
    if (estimateAgentContextTokens(serialized) <= maxTokens) return value;
    if (Array.isArray(value) && value.length > 0) {
        const buildArrayExcerpt = (sampleCount: number): Record<string, unknown> => {
            const headCount = Math.ceil(sampleCount / 2);
            const tailCount = Math.floor(sampleCount / 2);
            const itemBudget = Math.max(24, Math.floor((maxTokens - 40) / Math.max(1, sampleCount)));
            return {
                compressed: true,
                totalItems: value.length,
                head: value.slice(0, headCount).map((item) => compactValue(item, itemBudget)),
                tail: tailCount > 0
                    ? value.slice(Math.max(headCount, value.length - tailCount)).map((item) => compactValue(item, itemBudget))
                    : [],
            };
        };
        const broadExcerpt = buildArrayExcerpt(Math.min(6, value.length));
        if (estimateAgentContextTokens(safeStringify(broadExcerpt)) <= maxTokens) return broadExcerpt;
        const narrowExcerpt = buildArrayExcerpt(Math.min(2, value.length));
        if (estimateAgentContextTokens(safeStringify(narrowExcerpt)) <= maxTokens) return narrowExcerpt;
    }
    return {
        compressed: true,
        excerpt: truncateToTokens(serialized, Math.max(32, maxTokens - 16)),
    };
}

function isCompressedValue(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && (value as { compressed?: unknown }).compressed === true);
}

function stableHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function normalizeHistory(history: AgentContextMessage[] | undefined): AgentContextMessage[] {
    if (!Array.isArray(history)) return [];
    return history.flatMap((message, sourceMessageIndex) => {
        const content = String(message?.content || '').trim();
        if (!content || (message.role !== 'user' && message.role !== 'assistant')) return [];
        const createdAt = message.createdAt ? String(message.createdAt) : undefined;
        const messageId = String(message.messageId || '').trim()
            || `legacy_${stableHash(`${sourceMessageIndex}\u0000${message.role}\u0000${createdAt || ''}\u0000${content}`)}`;
        return [{
            role: message.role,
            content,
            messageId,
            sourceMessageIndex,
            ...(createdAt ? { createdAt } : {}),
        }];
    });
}

function normalizeSummaryEntry(value: unknown): AgentConversationSummaryEntry | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const text = String(record.text || '').trim();
    const sourceMessageIds = Array.isArray(record.sourceMessageIds)
        ? [...new Set(record.sourceMessageIds.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 12)
        : [];
    if (!text || !sourceMessageIds.length) return null;
    const sourceRole = record.sourceRole === 'assistant' ? 'assistant' : 'user';
    return {
        id: String(record.id || `summary_${stableHash(`${sourceRole}\u0000${text}\u0000${sourceMessageIds.join('|')}`)}`),
        text: truncateToTokens(text, 180),
        sourceMessageIds,
        sourceRole,
        ...(record.createdAt ? { createdAt: String(record.createdAt) } : {}),
    };
}

function normalizeArtifactRef(value: unknown): AgentConversationArtifactRef | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const artifactId = String(record.artifactId || '').trim();
    if (!artifactId) return null;
    return {
        artifactId,
        ...(record.runId ? { runId: String(record.runId) } : {}),
        ...(record.type ? { type: String(record.type) } : {}),
        title: truncateToTokens(String(record.title || record.type || artifactId), 80),
        ...(record.status ? { status: String(record.status) } : {}),
        ...(record.summary ? { summary: truncateToTokens(String(record.summary), 160) } : {}),
        ...(record.createdAt ? { createdAt: String(record.createdAt) } : {}),
    };
}

export function normalizeAgentConversationSummary(value: unknown): AgentConversationSummary | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 'agent-conversation-summary-v1') return null;
    const coveredMessageIds = Array.isArray(record.coveredMessageIds)
        ? [...new Set(record.coveredMessageIds.map((item) => String(item || '').trim()).filter(Boolean))]
        : [];
    const entries = (key: string) => (Array.isArray(record[key]) ? record[key] as unknown[] : [])
        .map(normalizeSummaryEntry)
        .filter((item): item is AgentConversationSummaryEntry => Boolean(item));
    const artifactRefs = (Array.isArray(record.artifactRefs) ? record.artifactRefs : [])
        .map(normalizeArtifactRef)
        .filter((item): item is AgentConversationArtifactRef => Boolean(item));
    const coverage = record.coverage && typeof record.coverage === 'object'
        ? record.coverage as Record<string, unknown>
        : {};
    return {
        version: 'agent-conversation-summary-v1',
        revision: Math.max(1, Math.floor(Number(record.revision) || 1)),
        coveredMessageIds,
        coverage: {
            ...(coverage.startMessageId ? { startMessageId: String(coverage.startMessageId) } : {}),
            ...(coverage.endMessageId ? { endMessageId: String(coverage.endMessageId) } : {}),
            messageCount: coveredMessageIds.length,
        },
        facts: entries('facts').slice(-40),
        userDecisions: entries('userDecisions').slice(-32),
        unresolvedQuestions: entries('unresolvedQuestions').slice(-16),
        outcomes: entries('outcomes').slice(-32),
        artifactRefs: artifactRefs.slice(-64),
        updatedAt: String(record.updatedAt || new Date(0).toISOString()),
    };
}

function normalizeArtifacts(artifacts: AgentContextArtifact[] | undefined): AgentContextArtifact[] {
    if (!Array.isArray(artifacts)) return [];
    const byId = new Map<string, AgentContextArtifact>();
    for (const artifact of artifacts) {
        const artifactId = String(artifact?.artifactId || '').trim();
        if (!artifactId) continue;
        byId.set(artifactId, {
            artifactId,
            ...(artifact.runId ? { runId: String(artifact.runId) } : {}),
            ...(artifact.type ? { type: String(artifact.type) } : {}),
            ...(artifact.title ? { title: String(artifact.title) } : {}),
            ...(artifact.status ? { status: String(artifact.status) } : {}),
            ...(artifact.summary ? { summary: String(artifact.summary) } : {}),
            ...(artifact.content ? { content: String(artifact.content) } : {}),
            ...(artifact.reference ? { reference: artifact.reference } : {}),
            ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
            ...(artifact.createdAt ? { createdAt: String(artifact.createdAt) } : {}),
        });
    }
    return [...byId.values()];
}

function summaryEntry(
    category: string,
    message: AgentContextMessage,
): AgentConversationSummaryEntry {
    const messageId = String(message.messageId || '');
    return {
        id: `${category}_${stableHash(`${messageId}\u0000${message.content}`)}`,
        text: truncateToTokens(message.content, 180),
        sourceMessageIds: [messageId],
        sourceRole: message.role,
        ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    };
}

function mergeSummaryEntries(
    previous: AgentConversationSummaryEntry[],
    additions: AgentConversationSummaryEntry[],
    limit: number,
): AgentConversationSummaryEntry[] {
    const byId = new Map(previous.map((entry) => [entry.id, entry]));
    for (const entry of additions) byId.set(entry.id, entry);
    return [...byId.values()].slice(-limit);
}

function artifactRefFromArtifact(artifact: AgentContextArtifact): AgentConversationArtifactRef {
    return {
        artifactId: artifact.artifactId,
        ...(artifact.runId ? { runId: artifact.runId } : {}),
        ...(artifact.type ? { type: artifact.type } : {}),
        title: truncateToTokens(String(artifact.title || artifact.type || artifact.artifactId), 80),
        ...(artifact.status ? { status: artifact.status } : {}),
        ...(artifact.summary ? { summary: truncateToTokens(String(artifact.summary), 160) } : {}),
        ...(artifact.createdAt ? { createdAt: artifact.createdAt } : {}),
    };
}

export function advanceAgentConversationSummary(input: {
    previous?: AgentConversationSummary | Record<string, unknown> | null;
    history: AgentContextMessage[];
    newlyCoveredMessageIds?: string[];
    artifacts?: AgentContextArtifact[];
    updatedAt?: string;
}): AgentConversationSummary | undefined {
    const history = normalizeHistory(input.history);
    const previous = normalizeAgentConversationSummary(input.previous);
    const previousCovered = new Set(previous?.coveredMessageIds || []);
    const requestedCovered = new Set((input.newlyCoveredMessageIds || []).map(String));
    const newlyCovered = history.filter((message) => (
        requestedCovered.has(String(message.messageId)) && !previousCovered.has(String(message.messageId))
    ));
    const artifacts = normalizeArtifacts(input.artifacts);
    const previousArtifactById = new Map((previous?.artifactRefs || []).map((item) => [item.artifactId, item]));
    const hasArtifactChanges = artifacts.some((artifact) => {
        const previousRef = previousArtifactById.get(artifact.artifactId);
        return safeStringify(previousRef || null) !== safeStringify(artifactRefFromArtifact(artifact));
    });
    if (!newlyCovered.length && !hasArtifactChanges) return undefined;

    const allCovered = [...(previous?.coveredMessageIds || [])];
    for (const message of newlyCovered) {
        const messageId = String(message.messageId || '');
        if (messageId && !previousCovered.has(messageId)) {
            allCovered.push(messageId);
            previousCovered.add(messageId);
        }
    }
    const facts = newlyCovered
        .filter((message) => message.role === 'user' && FACT_PATTERN.test(message.content) && !QUESTION_PATTERN.test(message.content))
        .map((message) => summaryEntry('fact', message));
    const decisions = newlyCovered
        .filter((message) => message.role === 'user' && DECISION_PATTERN.test(message.content))
        .map((message) => summaryEntry('decision', message));
    const outcomes = newlyCovered
        .filter((message) => message.role === 'assistant' && !QUESTION_PATTERN.test(message.content))
        .map((message) => summaryEntry('outcome', message));
    const sourceIndexById = new Map(history.map((message, index) => [String(message.messageId), index]));
    const unresolvedQuestions = newlyCovered
        .filter((message) => {
            if (message.role !== 'assistant' || !QUESTION_PATTERN.test(message.content)) return false;
            const sourceIndex = sourceIndexById.get(String(message.messageId)) ?? -1;
            return !history.slice(sourceIndex + 1).some((item) => item.role === 'user');
        })
        .map((message) => summaryEntry('question', message));
    const stillUnresolved = (previous?.unresolvedQuestions || []).filter((entry) => {
        const sourceIndex = Math.max(...entry.sourceMessageIds.map((id) => sourceIndexById.get(id) ?? -1));
        return sourceIndex < 0 || !history.slice(sourceIndex + 1).some((item) => item.role === 'user');
    });
    const artifactById = new Map((previous?.artifactRefs || []).map((item) => [item.artifactId, item]));
    for (const artifact of artifacts) artifactById.set(artifact.artifactId, artifactRefFromArtifact(artifact));
    const firstMessageId = allCovered[0];
    const lastMessageId = allCovered[allCovered.length - 1];
    return {
        version: 'agent-conversation-summary-v1',
        revision: (previous?.revision || 0) + 1,
        coveredMessageIds: allCovered,
        coverage: {
            ...(firstMessageId ? { startMessageId: firstMessageId } : {}),
            ...(lastMessageId ? { endMessageId: lastMessageId } : {}),
            messageCount: allCovered.length,
        },
        facts: mergeSummaryEntries(previous?.facts || [], facts, 40),
        userDecisions: mergeSummaryEntries(previous?.userDecisions || [], decisions, 32),
        unresolvedQuestions: mergeSummaryEntries(stillUnresolved, unresolvedQuestions, 16),
        outcomes: mergeSummaryEntries(previous?.outcomes || [], outcomes, 32),
        artifactRefs: [...artifactById.values()].slice(-64),
        updatedAt: input.updatedAt || new Date().toISOString(),
    };
}

function extractPersistentConstraints(history: AgentContextMessage[], budget: number): Array<Record<string, unknown>> {
    const constraints: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let used = 0;
    const perConstraintBudget = Math.max(180, Math.min(1024, Math.floor(budget / 4)));
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message.role !== 'user' || !CONSTRAINT_PATTERN.test(message.content)) continue;
        const sentences = message.content
            .split(/(?<=[。！？!?；;\n])/)
            .map((part) => part.trim())
            .filter((part) => part && CONSTRAINT_PATTERN.test(part));
        const excerpt = truncateToTokens(sentences.join(' ') || message.content, perConstraintBudget);
        const key = excerpt.toLowerCase();
        if (!excerpt || seen.has(key)) continue;
        const entry = { sourceMessageIndex: index, excerpt };
        const cost = estimateAgentContextTokens(safeStringify(entry));
        if (used + cost > budget) continue;
        constraints.unshift(entry);
        seen.add(key);
        used += cost;
    }
    return constraints;
}

function recallTerms(value: string): string[] {
    const normalized = value.toLowerCase();
    const terms = new Set<string>();
    for (const word of normalized.match(/[a-z0-9_.:-]{3,}/g) || []) terms.add(word);
    for (const chunk of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
        if (chunk.length <= 8) terms.add(chunk);
        for (let index = 0; index < chunk.length - 1; index += 1) terms.add(chunk.slice(index, index + 2));
    }
    return [...terms].slice(0, 80);
}

function recallScore(query: string, terms: string[], target: string, ids: string[]): number {
    const normalizedTarget = target.toLowerCase();
    let score = ids.some((id) => query.includes(id.toLowerCase())) ? 100 : 0;
    for (const term of terms) {
        if (normalizedTarget.includes(term)) score += term.length >= 4 ? 3 : 1;
    }
    return score;
}

function recallSummaryMessages(
    summary: AgentConversationSummary | null,
    history: AgentContextMessage[],
    currentRequest: unknown,
): Array<Record<string, unknown>> {
    if (!summary) return [];
    const query = safeStringify(currentRequest).toLowerCase();
    const terms = recallTerms(query);
    const entries = [
        ...summary.userDecisions,
        ...summary.unresolvedQuestions,
        ...summary.facts,
        ...summary.outcomes,
    ];
    const scored = entries.map((entry, index) => ({
        entry,
        index,
        score: recallScore(query, terms, entry.text, [entry.id, ...entry.sourceMessageIds]),
    })).filter((item) => item.score > 0);
    if (!scored.length && VAGUE_RECALL_PATTERN.test(query)) {
        for (let index = Math.max(0, entries.length - 3); index < entries.length; index += 1) {
            scored.push({ entry: entries[index], index, score: 1 });
        }
    }
    scored.sort((left, right) => right.score - left.score || right.index - left.index);
    const directlyReferencedIds = summary.coveredMessageIds.filter((messageId) => query.includes(messageId.toLowerCase()));
    const vagueFallbackIds = !scored.length && VAGUE_RECALL_PATTERN.test(query)
        ? summary.coveredMessageIds.slice(-3)
        : [];
    const recalledIds = [...new Set([
        ...directlyReferencedIds,
        ...scored.slice(0, 4).flatMap((item) => item.entry.sourceMessageIds),
        ...vagueFallbackIds,
    ])].slice(0, 6);
    const historyById = new Map(history.map((message) => [String(message.messageId), message]));
    return recalledIds.flatMap((messageId) => {
        const message = historyById.get(messageId);
        if (!message) return [];
        return [{
            messageId,
            role: message.role,
            content: truncateToTokens(message.content, 420),
            ...(message.createdAt ? { createdAt: message.createdAt } : {}),
            sourceRef: `agent-message:${messageId}`,
        }];
    });
}

function recallSummaryArtifacts(
    summary: AgentConversationSummary | null,
    artifacts: AgentContextArtifact[],
    currentRequest: unknown,
): Array<Record<string, unknown>> {
    if (!artifacts.length) return [];
    const query = safeStringify(currentRequest).toLowerCase();
    const terms = recallTerms(query);
    const refById = new Map((summary?.artifactRefs || []).map((item) => [item.artifactId, item]));
    for (const artifact of artifacts) {
        if (!refById.has(artifact.artifactId)) refById.set(artifact.artifactId, artifactRefFromArtifact(artifact));
    }
    const scored = artifacts.flatMap((artifact, index) => {
        const ref = refById.get(artifact.artifactId);
        if (!ref) return [];
        const target = [ref.title, ref.summary, ref.type].filter(Boolean).join(' ');
        const score = recallScore(query, terms, target, [ref.artifactId]);
        return score > 0 ? [{ artifact, ref, index, score }] : [];
    });
    if (!scored.length && VAGUE_RECALL_PATTERN.test(query) && /(?:草稿|报告|审核|产物|artifact|draft|report|review)/i.test(query)) {
        const candidates = artifacts.filter((artifact) => refById.has(artifact.artifactId));
        for (let index = Math.max(0, candidates.length - 2); index < candidates.length; index += 1) {
            const artifact = candidates[index];
            scored.push({ artifact, ref: refById.get(artifact.artifactId)!, index, score: 1 });
        }
    }
    scored.sort((left, right) => right.score - left.score || right.index - left.index);
    return scored.slice(0, 3).map(({ artifact, ref }) => ({
        artifactId: artifact.artifactId,
        ...(artifact.runId ? { runId: artifact.runId } : {}),
        type: artifact.type || ref.type,
        title: artifact.title || ref.title,
        summary: truncateToTokens(String(artifact.summary || ref.summary || ''), 180),
        contentExcerpt: truncateToTokens(String(artifact.content || safeStringify(artifact.metadata || {})), 520),
        reference: compactValue(artifact.reference || {}, 120),
        sourceRef: `agent-artifact:${artifact.artifactId}`,
    }));
}

function summarizeHistoryRange(
    history: AgentContextMessage[],
    start: number,
    end: number,
): Record<string, unknown> {
    const messages = history.slice(start, end + 1);
    const userRequests = messages
        .map((message, offset) => ({
            message,
            sourceMessageIndex: Number(message.sourceMessageIndex ?? start + offset),
            sourceMessageId: message.messageId,
        }))
        .filter(({ message }) => message.role === 'user')
        .slice(-2)
        .map(({ message, sourceMessageIndex, sourceMessageId }) => ({
            sourceMessageIndex,
            sourceMessageId,
            excerpt: truncateToTokens(message.content, 100),
        }));
    const assistantOutcome = messages
        .map((message, offset) => ({
            message,
            sourceMessageIndex: Number(message.sourceMessageIndex ?? start + offset),
            sourceMessageId: message.messageId,
        }))
        .filter(({ message }) => message.role === 'assistant')
        .slice(-1)
        .map(({ message, sourceMessageIndex, sourceMessageId }) => ({
            sourceMessageIndex,
            sourceMessageId,
            excerpt: truncateToTokens(message.content, 120),
        }));
    return {
        sourceRange: {
            startMessageIndex: Number(messages[0]?.sourceMessageIndex ?? start),
            endMessageIndex: Number(messages[messages.length - 1]?.sourceMessageIndex ?? end),
        },
        sourceMessageIds: messages.map((message) => message.messageId).filter(Boolean),
        userRequests,
        assistantOutcome,
    };
}

function historyContext(
    history: AgentContextMessage[],
    budget: number,
): {
    recentHistory: Array<Record<string, unknown>>;
    rollingSummary: Array<Record<string, unknown>>;
    summarizedCount: number;
    omittedCount: number;
} {
    if (!history.length || budget < 64) {
        return { recentHistory: [], rollingSummary: [], summarizedCount: 0, omittedCount: history.length };
    }

    const recentBudget = Math.max(64, Math.floor(budget * 0.68));
    const recentHistory: Array<Record<string, unknown>> = [];
    let recentUsed = 0;
    let firstRecentIndex = history.length;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        const entry = { sourceMessageIndex: Number(message.sourceMessageIndex ?? index), ...message };
        const cost = estimateAgentContextTokens(safeStringify(entry));
        if (recentUsed + cost > recentBudget) {
            if (!recentHistory.length) {
                const compacted = {
                    sourceMessageIndex: Number(message.sourceMessageIndex ?? index),
                    role: message.role,
                    content: truncateToTokens(message.content, Math.max(32, recentBudget - 24)),
                    messageId: message.messageId,
                    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
                    compressed: true,
                };
                recentHistory.unshift(compacted);
                firstRecentIndex = index;
            }
            break;
        }
        recentHistory.unshift(entry);
        firstRecentIndex = index;
        recentUsed += cost;
    }

    const summaryBudget = Math.max(0, budget - estimateAgentContextTokens(safeStringify(recentHistory)));
    const candidates: Array<{ start: number; end: number; summary: Record<string, unknown> }> = [];
    for (let end = firstRecentIndex - 1; end >= 0; end -= 6) {
        const start = Math.max(0, end - 5);
        candidates.unshift({ start, end, summary: summarizeHistoryRange(history, start, end) });
    }

    const rollingSummary: Array<Record<string, unknown>> = [];
    let summaryUsed = 0;
    let summarizedCount = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        const cost = estimateAgentContextTokens(safeStringify(candidate.summary));
        if (summaryUsed + cost > summaryBudget) continue;
        rollingSummary.unshift(candidate.summary);
        summaryUsed += cost;
        summarizedCount += candidate.end - candidate.start + 1;
    }
    const olderCount = Math.max(0, firstRecentIndex);
    return {
        recentHistory,
        rollingSummary,
        summarizedCount,
        omittedCount: Math.max(0, olderCount - summarizedCount),
    };
}

function collapseHistorySourceIndexes(
    indexes: number[],
    mode: HistorySourceMode,
): AgentContextDiagnostics['historySources'] {
    const sorted = [...new Set(indexes.filter(Number.isFinite))].sort((left, right) => left - right);
    if (!sorted.length) return [];
    const ranges: AgentContextDiagnostics['historySources'] = [];
    let start = sorted[0];
    let end = sorted[0];
    for (const index of sorted.slice(1)) {
        if (index === end + 1) {
            end = index;
            continue;
        }
        ranges.push({ mode, startMessageIndex: start, endMessageIndex: end });
        start = index;
        end = index;
    }
    ranges.push({ mode, startMessageIndex: start, endMessageIndex: end });
    return ranges;
}

export class AgentContextAssembler {
    assemble(input: AgentContextAssemblerInput): AgentContextAssembly {
        const model = String(input.model || (input.providerType === 'mcp-cli' ? 'mcp-cli' : 'unknown-model'));
        const contextWindow = resolveAgentContextWindow(input.providerType, model, input.contextWindowTokens);
        const outputTokens = Math.max(128, Math.floor(input.outputTokens || 0));
        const safetyTokens = Number.isFinite(input.safetyTokens) && Number(input.safetyTokens) > 0
            ? Math.floor(Number(input.safetyTokens))
            : Math.max(2048, Math.min(16_384, Math.floor(contextWindow.tokens * 0.1)));
        const systemTokens = estimateAgentContextTokens(String(input.systemPrompt || ''));
        const inputBudgetTokens = Math.max(128, contextWindow.tokens - outputTokens - safetyTokens - systemTokens);
        const warnings: string[] = [];
        if (contextWindow.tokens <= outputTokens + safetyTokens + systemTokens) {
            warnings.push('Configured context window is smaller than the reserved system, output, and safety budgets.');
        }

        const history = normalizeHistory(input.history);
        const persistentSummary = normalizeAgentConversationSummary(input.persistentSummary);
        const artifacts = normalizeArtifacts(input.artifacts);
        const coveredMessageIds = new Set(persistentSummary?.coveredMessageIds || []);
        const historyForAssembly = history.filter((message) => !coveredMessageIds.has(String(message.messageId)));
        const recalledMessages = recallSummaryMessages(persistentSummary, history, input.currentRequest);
        const recalledArtifacts = recallSummaryArtifacts(persistentSummary, artifacts, input.currentRequest);
        const requestBudget = Math.max(256, Math.floor(inputBudgetTokens * 0.28));
        const persistentConstraints = extractPersistentConstraints(
            history,
            Math.max(128, Math.floor(inputBudgetTokens * 0.12)),
        );
        const normalizedSections: NormalizedSection[] = (input.sections || [])
            .filter((section) => section && String(section.id || '').trim())
            .map((section) => ({ ...section, id: String(section.id), priority: section.priority || 'normal' }))
            .sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]);

        const payload: Record<string, unknown> = {
            contextVersion: 'agent-context-v1',
            currentRequest: compactValue(input.currentRequest, requestBudget),
            persistentConstraints,
            persistentSummary: persistentSummary
                ? compactValue(persistentSummary, Math.max(256, Math.floor(inputBudgetTokens * 0.18)))
                : null,
            recalledMessages: compactValue(recalledMessages, Math.max(128, Math.floor(inputBudgetTokens * 0.1))),
            recalledArtifacts: compactValue(recalledArtifacts, Math.max(128, Math.floor(inputBudgetTokens * 0.12))),
            rollingSummary: [],
            recentHistory: [],
            sections: [],
        };
        const omittedSectionIds: string[] = [];
        const sectionOutput: Array<Record<string, unknown>> = [];
        const sectionBudget = Math.max(128, Math.floor(inputBudgetTokens * 0.42));
        let sectionUsed = 0;
        for (let index = 0; index < normalizedSections.length; index += 1) {
            const section = normalizedSections[index];
            const remainingCount = normalizedSections.length - index;
            const defaultCap = Math.max(96, Math.floor((sectionBudget - sectionUsed) / Math.max(1, remainingCount)));
            const cap = Math.max(64, Math.min(section.maxTokens || defaultCap, sectionBudget - sectionUsed));
            if (cap < 64 && section.priority !== 'required') {
                omittedSectionIds.push(section.id);
                continue;
            }
            const entry = {
                id: section.id,
                kind: section.kind,
                priority: section.priority,
                ...(section.sourceRef ? { sourceRef: section.sourceRef } : {}),
                value: compactValue(section.value, Math.max(32, cap - 24)),
            };
            const cost = estimateAgentContextTokens(safeStringify(entry));
            if (sectionUsed + cost > sectionBudget && section.priority !== 'required') {
                omittedSectionIds.push(section.id);
                continue;
            }
            sectionOutput.push(entry);
            sectionUsed += cost;
        }
        payload.sections = sectionOutput;

        const baseTokens = estimateAgentContextTokens(safeStringify(payload));
        const historyBudget = Math.max(0, inputBudgetTokens - baseTokens - 32);
        const assembledHistory = historyContext(historyForAssembly, historyBudget);
        payload.rollingSummary = assembledHistory.rollingSummary;
        payload.recentHistory = assembledHistory.recentHistory;

        let prompt = safeStringify(payload);
        let estimatedInputTokens = estimateAgentContextTokens(prompt);
        const rollingSummary = payload.rollingSummary as Array<Record<string, unknown>>;
        const recentHistory = payload.recentHistory as Array<Record<string, unknown>>;
        while (estimatedInputTokens > inputBudgetTokens && rollingSummary.length) {
            rollingSummary.shift();
            prompt = safeStringify(payload);
            estimatedInputTokens = estimateAgentContextTokens(prompt);
        }
        while (estimatedInputTokens > inputBudgetTokens && recentHistory.length > 1) {
            recentHistory.shift();
            prompt = safeStringify(payload);
            estimatedInputTokens = estimateAgentContextTokens(prompt);
        }
        while (estimatedInputTokens > inputBudgetTokens && sectionOutput.some((section) => section.priority !== 'required')) {
            let removableIndex = sectionOutput.length - 1;
            while (removableIndex >= 0 && sectionOutput[removableIndex].priority === 'required') removableIndex -= 1;
            const [removed] = sectionOutput.splice(removableIndex, 1);
            omittedSectionIds.push(String(removed.id));
            prompt = safeStringify(payload);
            estimatedInputTokens = estimateAgentContextTokens(prompt);
        }
        while (estimatedInputTokens > inputBudgetTokens && persistentConstraints.length) {
            persistentConstraints.shift();
            prompt = safeStringify(payload);
            estimatedInputTokens = estimateAgentContextTokens(prompt);
        }
        if (estimatedInputTokens > inputBudgetTokens) {
            payload.currentRequest = compactValue(input.currentRequest, Math.max(64, Math.floor(requestBudget / 2)));
            prompt = safeStringify(payload);
            estimatedInputTokens = estimateAgentContextTokens(prompt);
        }

        const historyIndexById = new Map(history.map((message, index) => [
            String(message.messageId),
            Number(message.sourceMessageIndex ?? index),
        ]));
        const summaryIndexes = new Set<number>();
        for (const messageId of persistentSummary?.coveredMessageIds || []) {
            const index = historyIndexById.get(messageId);
            if (typeof index === 'number') summaryIndexes.add(index);
        }
        for (const summary of rollingSummary) {
            const sourceMessageIds = Array.isArray(summary.sourceMessageIds)
                ? summary.sourceMessageIds.map(String)
                : [];
            if (sourceMessageIds.length) {
                for (const messageId of sourceMessageIds) {
                    const index = historyIndexById.get(messageId);
                    if (typeof index === 'number') summaryIndexes.add(index);
                }
                continue;
            }
            const range = summary.sourceRange as { startMessageIndex?: number; endMessageIndex?: number } | undefined;
            if (!range || typeof range.startMessageIndex !== 'number' || typeof range.endMessageIndex !== 'number') continue;
            for (let index = range.startMessageIndex; index <= range.endMessageIndex; index += 1) summaryIndexes.add(index);
        }
        const representedSummaryCount = summaryIndexes.size;
        const keptSourceIndexes = new Set(recentHistory.map((message) => Number(message.sourceMessageIndex)));
        const historyMessagesKept = [...keptSourceIndexes].filter(Number.isFinite).length;
        const representedIndexes = new Set([...keptSourceIndexes, ...summaryIndexes]);
        const allHistoryIndexes = history.map((message, index) => Number(message.sourceMessageIndex ?? index));
        const omittedIndexes = allHistoryIndexes.filter((index) => !representedIndexes.has(index));
        const historyMessagesOmitted = omittedIndexes.length;
        const historyMessagesCompacted = recentHistory.filter((message) => message.compressed === true).length;
        const currentRequestCompressed = isCompressedValue(payload.currentRequest);
        const compressedSectionIds = sectionOutput
            .filter((section) => isCompressedValue(section.value))
            .map((section) => String(section.id));
        const compressionApplied = currentRequestCompressed
            || representedSummaryCount > 0
            || historyMessagesOmitted > 0
            || historyMessagesCompacted > 0
            || compressedSectionIds.length > 0
            || omittedSectionIds.length > 0;
        if (persistentSummary && persistentSummary.coveredMessageIds.length) {
            warnings.push('Older conversation messages were represented by a persisted, traceable summary.');
        } else if (representedSummaryCount > 0) {
            warnings.push('Older conversation messages were represented by traceable rolling summaries.');
        }
        if (historyMessagesOmitted > 0) warnings.push(`${historyMessagesOmitted} older conversation messages could not fit in this model request.`);
        if (omittedSectionIds.length) warnings.push('Lower-priority context sections were omitted to fit the model budget.');

        const rawIndexes: number[] = [];
        const compactedIndexes: number[] = [];
        for (const message of recentHistory) {
            const index = Number(message.sourceMessageIndex);
            if (!Number.isFinite(index)) continue;
            (message.compressed === true ? compactedIndexes : rawIndexes).push(index);
        }
        const historySources = [
            ...collapseHistorySourceIndexes(rawIndexes, 'raw'),
            ...collapseHistorySourceIndexes(compactedIndexes, 'compressed'),
            ...collapseHistorySourceIndexes([...summaryIndexes], 'summary'),
            ...collapseHistorySourceIndexes(omittedIndexes, 'omitted'),
        ].sort((left, right) => left.startMessageIndex - right.startMessageIndex);
        const historyByIndex = new Map(history.map((message, index) => [
            Number(message.sourceMessageIndex ?? index),
            message,
        ]));
        const newlyCoveredMessageIds = [...new Set([...summaryIndexes, ...omittedIndexes]
            .sort((left, right) => left - right)
            .flatMap((index) => {
                const messageId = historyByIndex.get(index)?.messageId;
                return messageId ? [String(messageId)] : [];
            }))];
        const summaryUpdate = advanceAgentConversationSummary({
            previous: persistentSummary,
            history,
            newlyCoveredMessageIds,
            artifacts,
        });
        const omittedSectionSet = new Set(omittedSectionIds);
        const sectionById = new Map(sectionOutput.map((section) => [String(section.id), section]));
        const sectionSources = normalizedSections.map((section) => {
            const output = sectionById.get(section.id);
            const mode = omittedSectionSet.has(section.id) || !output
                ? 'omitted' as const
                : isCompressedValue(output.value) ? 'compressed' as const : 'raw' as const;
            return {
                id: section.id,
                kind: section.kind,
                priority: section.priority,
                mode,
                ...(section.sourceRef ? { sourceRef: section.sourceRef } : {}),
                estimatedTokens: output ? estimateAgentContextTokens(safeStringify(output)) : 0,
            };
        });

        return {
            prompt,
            payload,
            ...(summaryUpdate ? { summaryUpdate } : {}),
            diagnostics: {
                contextVersion: 'agent-context-v1',
                providerType: input.providerType,
                model,
                contextWindowTokens: contextWindow.tokens,
                contextWindowSource: contextWindow.source,
                outputTokens,
                safetyTokens,
                systemTokens,
                inputBudgetTokens,
                estimatedInputTokens,
                compressionApplied,
                currentRequestCompressed,
                historyMessagesTotal: history.length,
                historyMessagesKept,
                historyMessagesSummarized: representedSummaryCount,
                historyMessagesOmitted,
                historyMessagesCompacted,
                persistentConstraintsCount: persistentConstraints.length,
                persistentSummaryRevision: persistentSummary?.revision || 0,
                persistentSummaryMessageCount: persistentSummary?.coveredMessageIds.length || 0,
                recalledMessageIds: recalledMessages.map((item) => String(item.messageId || '')).filter(Boolean),
                recalledArtifactIds: recalledArtifacts.map((item) => String(item.artifactId || '')).filter(Boolean),
                currentRequestMode: currentRequestCompressed ? 'compressed' : 'raw',
                historySources,
                sectionSources,
                compressedSectionIds,
                omittedSectionIds: [...new Set(omittedSectionIds)],
                warnings,
            },
        };
    }
}
