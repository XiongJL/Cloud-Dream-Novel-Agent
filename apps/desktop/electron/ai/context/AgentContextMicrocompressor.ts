import { createHash } from 'node:crypto';
import type { AgentContextSectionKind } from './AgentContextAssembler';

export interface AgentContextMicrocompressionReference {
    sourceRef: string;
    contentHash: string;
    characterCount: number;
}

export interface AgentContextMicrocompressionResult {
    value: unknown;
    applied: boolean;
    references: AgentContextMicrocompressionReference[];
}

const INLINE_THRESHOLD = 8_000;
const EXCERPT_CHARACTERS = 1_600;
const TEXT_FIELDS = ['content', 'text', 'body', 'markdown', 'raw', 'output'] as const;

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function serialized(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value ?? '');
    } catch {
        return String(value ?? '');
    }
}

function excerpt(value: string): string {
    if (value.length <= EXCERPT_CHARACTERS) return value;
    const head = Math.floor(EXCERPT_CHARACTERS * 0.7);
    const tail = EXCERPT_CHARACTERS - head;
    return `${value.slice(0, head)}\n[reference excerpt omitted ${value.length - EXCERPT_CHARACTERS} chars]\n${value.slice(-tail)}`;
}

function referenceValue(value: string, sourceRef: string): {
    value: Record<string, unknown>;
    reference: AgentContextMicrocompressionReference;
} {
    const reference = {
        sourceRef,
        contentHash: sha256(value),
        characterCount: value.length,
    };
    return {
        reference,
        value: {
            compressed: true,
            compression: 'stable_reference',
            ...reference,
            excerpt: excerpt(value),
        },
    };
}

function recordSourceRef(record: Record<string, unknown>): string | null {
    const artifactId = String(record.artifactId || '').trim();
    if (artifactId) return `agent-artifact:${artifactId}`;
    const chapterId = String(record.chapterId || '').trim();
    if (chapterId) return `chapter:${chapterId}`;
    const attachmentId = String(record.attachmentId || '').trim();
    if (attachmentId) return `attachment:${attachmentId}`;
    return null;
}

function compressValue(
    value: unknown,
    options: { sectionKind: AgentContextSectionKind; sourceRef?: string },
    references: AgentContextMicrocompressionReference[],
    depth = 0,
): unknown {
    if (depth > 12 || value === null || value === undefined) return value;
    if (typeof value === 'string') {
        const durableSource = options.sourceRef
            && !/(?:editor-buffer|current-exploration|working-memory)/i.test(options.sourceRef);
        if (value.length <= INLINE_THRESHOLD || !durableSource) return value;
        const compressed = referenceValue(value, options.sourceRef!);
        references.push(compressed.reference);
        return compressed.value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => compressValue(item, options, references, depth + 1));
    }
    if (typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = { ...record };
    const stableRef = recordSourceRef(record);
    const durableSectionSource = options.sourceRef
        && !/(?:editor-buffer|current-exploration|working-memory)/i.test(options.sourceRef);
    const toolName = String(record.toolName || '').trim();
    const resultStableRef = record.result && typeof record.result === 'object' && !Array.isArray(record.result)
        ? recordSourceRef(record.result as Record<string, unknown>)
        : null;
    if (toolName && 'result' in record && !resultStableRef && durableSectionSource) {
        const resultText = serialized(record.result);
        if (resultText.length > INLINE_THRESHOLD) {
            const argsHash = sha256(serialized(record.args || {})).slice(0, 16);
            const compressed = referenceValue(
                resultText,
                `${options.sourceRef}:tool-result:${toolName}:${argsHash}`,
            );
            output.result = compressed.value;
            references.push(compressed.reference);
        }
    }
    for (const field of TEXT_FIELDS) {
        const fieldValue = record[field];
        if (typeof fieldValue !== 'string' || fieldValue.length <= INLINE_THRESHOLD || !stableRef) continue;
        const compressed = referenceValue(fieldValue, `${stableRef}:${field}`);
        output[field] = compressed.value;
        references.push(compressed.reference);
    }
    for (const [key, child] of Object.entries(output)) {
        if (TEXT_FIELDS.includes(key as typeof TEXT_FIELDS[number]) && child !== record[key]) continue;
        output[key] = compressValue(child, options, references, depth + 1);
    }
    return output;
}

export function microcompressAgentContextValue(
    value: unknown,
    options: { sectionKind: AgentContextSectionKind; sourceRef?: string },
): AgentContextMicrocompressionResult {
    const references: AgentContextMicrocompressionReference[] = [];
    const compressed = compressValue(value, options, references);
    return {
        value: compressed,
        applied: references.length > 0,
        references,
    };
}
