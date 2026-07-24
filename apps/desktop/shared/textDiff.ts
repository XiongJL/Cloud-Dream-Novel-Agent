import { diffChars } from 'diff';

export type TextDiffSegmentKind = 'unchanged' | 'added' | 'removed';

export interface TextDiffSegment {
    kind: TextDiffSegmentKind;
    value: string;
}
export interface TextDiffProjection {
    segments: TextDiffSegment[];
    addedCount: number;
    removedCount: number;
    changedBlockCount: number;
    unchangedCount: number;
}

function characterCount(value: string): number {
    return Array.from(value).length;
}

export function projectTextDiff(originalText: string, draftText: string): TextDiffProjection {
    const changes = diffChars(originalText || '', draftText || '');
    const segments: TextDiffSegment[] = changes
        .filter((change) => change.value.length > 0)
        .map((change) => ({
            kind: change.added ? 'added' : change.removed ? 'removed' : 'unchanged',
            value: change.value,
        }));
    let addedCount = 0;
    let removedCount = 0;
    let unchangedCount = 0;
    let changedBlockCount = 0;
    let insideChangedBlock = false;
    for (const segment of segments) {
        const count = characterCount(segment.value);
        if (segment.kind === 'unchanged') {
            unchangedCount += count;
            insideChangedBlock = false;
            continue;
        }
        if (!insideChangedBlock) changedBlockCount += 1;
        insideChangedBlock = true;
        if (segment.kind === 'added') addedCount += count;
        else removedCount += count;
    }
    return { segments, addedCount, removedCount, changedBlockCount, unchangedCount };
}
