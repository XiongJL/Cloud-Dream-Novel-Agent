import type { NarrativeStateDelta } from './draftBatch';

const EMPTY_DELTA: NarrativeStateDelta = {
    characterLocations: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    itemStates: [],
    resolvedConflicts: [],
    openedConflicts: [],
    warnings: [],
};

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function text(value: unknown, maxLength: number): string {
    return String(value ?? '').trim().slice(0, maxLength);
}

function strings(value: unknown, limit: number, maxLength: number): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => text(item, maxLength)).filter(Boolean))].slice(0, limit);
}

export function emptyNarrativeStateDelta(): NarrativeStateDelta {
    return {
        characterLocations: [],
        relationshipChanges: [],
        knowledgeChanges: [],
        itemStates: [],
        resolvedConflicts: [],
        openedConflicts: [],
        warnings: [],
    };
}

export function normalizeNarrativeStateDelta(value: unknown): NarrativeStateDelta {
    const source = record(value);
    return {
        characterLocations: (Array.isArray(source.characterLocations) ? source.characterLocations : [])
            .slice(0, 30)
            .map(record)
            .map((item) => ({
                characterKey: text(item.characterKey, 160),
                location: text(item.location, 300),
                evidenceExcerpt: text(item.evidenceExcerpt, 500),
            }))
            .filter((item) => item.characterKey && item.location && item.evidenceExcerpt),
        relationshipChanges: (Array.isArray(source.relationshipChanges) ? source.relationshipChanges : [])
            .slice(0, 30)
            .map(record)
            .map((item) => ({
                sourceCharacterKey: text(item.sourceCharacterKey, 160),
                targetCharacterKey: text(item.targetCharacterKey, 160),
                change: text(item.change, 500),
                evidenceExcerpt: text(item.evidenceExcerpt, 500),
            }))
            .filter((item) => item.sourceCharacterKey && item.targetCharacterKey && item.change && item.evidenceExcerpt),
        knowledgeChanges: (Array.isArray(source.knowledgeChanges) ? source.knowledgeChanges : [])
            .slice(0, 30)
            .map(record)
            .map((item) => ({
                characterKey: text(item.characterKey, 160),
                learned: strings(item.learned, 20, 500),
                forgotten: strings(item.forgotten, 20, 500),
                evidenceExcerpt: text(item.evidenceExcerpt, 500),
            }))
            .filter((item) => item.characterKey && (item.learned.length > 0 || item.forgotten.length > 0) && item.evidenceExcerpt),
        itemStates: (Array.isArray(source.itemStates) ? source.itemStates : [])
            .slice(0, 30)
            .map(record)
            .map((item) => ({
                itemKey: text(item.itemKey, 160),
                state: text(item.state, 500),
                ...(text(item.holderKey, 160) ? { holderKey: text(item.holderKey, 160) } : {}),
                ...(text(item.location, 300) ? { location: text(item.location, 300) } : {}),
                evidenceExcerpt: text(item.evidenceExcerpt, 500),
            }))
            .filter((item) => item.itemKey && item.state && item.evidenceExcerpt),
        resolvedConflicts: (Array.isArray(source.resolvedConflicts) ? source.resolvedConflicts : [])
            .slice(0, 20)
            .map(record)
            .map((item) => ({ conflict: text(item.conflict, 500), evidenceExcerpt: text(item.evidenceExcerpt, 500) }))
            .filter((item) => item.conflict && item.evidenceExcerpt),
        openedConflicts: (Array.isArray(source.openedConflicts) ? source.openedConflicts : [])
            .slice(0, 20)
            .map(record)
            .map((item) => ({ conflict: text(item.conflict, 500), evidenceExcerpt: text(item.evidenceExcerpt, 500) }))
            .filter((item) => item.conflict && item.evidenceExcerpt),
        warnings: strings(source.warnings, 20, 500),
    };
}

export function filterNarrativeStateDeltaEvidence(
    delta: NarrativeStateDelta,
    generatedText: string,
): NarrativeStateDelta {
    const hasEvidence = (excerpt: string): boolean => generatedText.includes(excerpt);
    return {
        ...EMPTY_DELTA,
        characterLocations: delta.characterLocations.filter((item) => hasEvidence(item.evidenceExcerpt)),
        relationshipChanges: delta.relationshipChanges.filter((item) => hasEvidence(item.evidenceExcerpt)),
        knowledgeChanges: delta.knowledgeChanges.filter((item) => hasEvidence(item.evidenceExcerpt)),
        itemStates: delta.itemStates.filter((item) => hasEvidence(item.evidenceExcerpt)),
        resolvedConflicts: delta.resolvedConflicts.filter((item) => hasEvidence(item.evidenceExcerpt)),
        openedConflicts: delta.openedConflicts.filter((item) => hasEvidence(item.evidenceExcerpt)),
        warnings: delta.warnings,
    };
}
