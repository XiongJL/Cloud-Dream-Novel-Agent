import { diffArrays } from 'diff';

export const TEXT_DIFF_VERSION = 2;

export type TextDiffSpanKind = 'unchanged' | 'added' | 'removed';
export type TextDiffRowKind = 'context' | 'delete' | 'insert' | 'modify';

export interface TextDiffSpan {
    kind: TextDiffSpanKind;
    value: string;
}

export interface TextDiffRow {
    kind: TextDiffRowKind;
    oldLine: number | null;
    newLine: number | null;
    oldText?: string;
    newText?: string;
    oldSpans?: TextDiffSpan[];
    newSpans?: TextDiffSpan[];
    hunkId?: string;
}

export interface TextDiffHunk {
    id: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    previousContextHash: string;
    nextContextHash: string;
    rows: TextDiffRow[];
}

export type TextDiffFallbackReason = 'input_limit' | 'refinement_budget' | 'worker_timeout' | 'worker_error';

export interface TextDiffStats {
    durationMs: number;
    originalParagraphCount: number;
    draftParagraphCount: number;
    candidateComparisonCount: number;
    refinementTimedOut: boolean;
}

export interface TextDiffProjection {
    version: typeof TEXT_DIFF_VERSION;
    rows: TextDiffRow[];
    hunks: TextDiffHunk[];
    addedCount: number;
    removedCount: number;
    changedParagraphCount: number;
    changedBlockCount: number;
    unchangedCount: number;
    degraded: boolean;
    fallbackReason?: TextDiffFallbackReason;
    stats: TextDiffStats;
}

export interface ComputeTextDiffOptions {
    maxParagraphs?: number;
    maxCharacters?: number;
    maxRefinementTimeMs?: number;
}

interface LogicalParagraph {
    text: string;
    key: string;
}

interface PairingResult {
    pairs: Array<{ oldIndex: number; newIndex: number }>;
    candidateComparisonCount: number;
}

type SegmenterConstructor = new (
    locale?: string,
    options?: { granularity?: 'word' | 'sentence' | 'grapheme' },
) => { segment(value: string): Iterable<{ segment: string }> };

const DEFAULT_MAX_PARAGRAPHS = 2_000;
const DEFAULT_MAX_CHARACTERS = 500_000;
const DEFAULT_REFINEMENT_TIME_MS = 750;
const MAX_PAIRING_CELLS = 4_096;
const LARGE_HUNK_BAND_RADIUS = 8;

function now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function graphemes(value: string): string[] {
    const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
    if (!Segmenter) return Array.from(value);
    return Array.from(new Segmenter('zh-CN', { granularity: 'grapheme' }).segment(value), (part) => part.segment);
}

function graphemeCount(value: string): number {
    return graphemes(value).length;
}

function normalizeComparisonText(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/[\p{White_Space}]+/gu, ' ')
        .trim();
}

function similarityText(value: string): string {
    return normalizeComparisonText(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

export function splitLogicalParagraphs(value: string): string[] {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter((line) => line.trim().length > 0);
}

function logicalParagraphs(value: string): LogicalParagraph[] {
    return splitLogicalParagraphs(value).map((text) => ({
        text,
        key: normalizeComparisonText(text),
    }));
}

function hashText(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function characterBigrams(value: string): Map<string, number> {
    const chars = Array.from(value);
    const result = new Map<string, number>();
    if (chars.length === 1) result.set(chars[0], 1);
    for (let index = 0; index < chars.length - 1; index += 1) {
        const gram = `${chars[index]}${chars[index + 1]}`;
        result.set(gram, (result.get(gram) ?? 0) + 1);
    }
    return result;
}

function diceRatio(left: string, right: string): number {
    if (left === right) return 1;
    const leftBigrams = characterBigrams(left);
    const rightBigrams = characterBigrams(right);
    const leftTotal = Array.from(leftBigrams.values()).reduce((total, count) => total + count, 0);
    const rightTotal = Array.from(rightBigrams.values()).reduce((total, count) => total + count, 0);
    if (leftTotal === 0 || rightTotal === 0) return 0;
    let intersection = 0;
    for (const [gram, count] of leftBigrams) {
        intersection += Math.min(count, rightBigrams.get(gram) ?? 0);
    }
    return (2 * intersection) / (leftTotal + rightTotal);
}

function pairingScore(
    oldParagraph: LogicalParagraph,
    newParagraph: LogicalParagraph,
    oldIndex: number,
    newIndex: number,
    oldCount: number,
    newCount: number,
): number {
    const left = similarityText(oldParagraph.text);
    const right = similarityText(newParagraph.text);
    if (!left || !right) return 0;
    if (left === right) return 1;
    const shorterLength = Math.min(Array.from(left).length, Array.from(right).length);
    const longerLength = Math.max(Array.from(left).length, Array.from(right).length);
    const dice = diceRatio(left, right);
    const minimumDice = shorterLength >= 40 ? 0.22 : shorterLength >= 16 ? 0.32 : 0.48;
    const lengthRatio = shorterLength / Math.max(longerLength, 1);
    if (dice < minimumDice || lengthRatio < 0.35) return 0;
    const oldPosition = oldCount <= 1 ? 0 : oldIndex / (oldCount - 1);
    const newPosition = newCount <= 1 ? 0 : newIndex / (newCount - 1);
    const positionSimilarity = 1 - Math.min(Math.abs(oldPosition - newPosition), 1);
    return (dice * 0.75) + (lengthRatio * 0.15) + (positionSimilarity * 0.1);
}

function pairSmallHunk(oldItems: LogicalParagraph[], newItems: LogicalParagraph[]): PairingResult {
    const rowCount = oldItems.length;
    const columnCount = newItems.length;
    const scores = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => 0));
    let candidateComparisonCount = 0;
    for (let row = 0; row < rowCount; row += 1) {
        for (let column = 0; column < columnCount; column += 1) {
            scores[row][column] = pairingScore(oldItems[row], newItems[column], row, column, rowCount, columnCount);
            candidateComparisonCount += 1;
        }
    }

    const dp = Array.from({ length: rowCount + 1 }, () => Array.from({ length: columnCount + 1 }, () => 0));
    for (let row = 1; row <= rowCount; row += 1) {
        for (let column = 1; column <= columnCount; column += 1) {
            const score = scores[row - 1][column - 1];
            dp[row][column] = Math.max(
                dp[row - 1][column],
                dp[row][column - 1],
                score > 0 ? dp[row - 1][column - 1] + score : 0,
            );
        }
    }

    const pairs: Array<{ oldIndex: number; newIndex: number }> = [];
    let row = rowCount;
    let column = columnCount;
    const epsilon = 0.000001;
    while (row > 0 && column > 0) {
        const score = scores[row - 1][column - 1];
        if (score > 0 && Math.abs(dp[row][column] - (dp[row - 1][column - 1] + score)) < epsilon) {
            pairs.push({ oldIndex: row - 1, newIndex: column - 1 });
            row -= 1;
            column -= 1;
        } else if (dp[row - 1][column] >= dp[row][column - 1]) {
            row -= 1;
        } else {
            column -= 1;
        }
    }
    return { pairs: pairs.reverse(), candidateComparisonCount };
}

function pairLargeHunk(oldItems: LogicalParagraph[], newItems: LogicalParagraph[]): PairingResult {
    const pairs: Array<{ oldIndex: number; newIndex: number }> = [];
    let candidateComparisonCount = 0;
    let minimumNewIndex = 0;
    for (let oldIndex = 0; oldIndex < oldItems.length && minimumNewIndex < newItems.length; oldIndex += 1) {
        const proportional = oldItems.length <= 1
            ? minimumNewIndex
            : Math.round((oldIndex / (oldItems.length - 1)) * Math.max(newItems.length - 1, 0));
        const start = Math.max(minimumNewIndex, proportional - LARGE_HUNK_BAND_RADIUS);
        const end = Math.min(newItems.length - 1, proportional + LARGE_HUNK_BAND_RADIUS);
        let bestIndex = -1;
        let bestScore = 0;
        for (let newIndex = start; newIndex <= end; newIndex += 1) {
            const score = pairingScore(oldItems[oldIndex], newItems[newIndex], oldIndex, newIndex, oldItems.length, newItems.length);
            candidateComparisonCount += 1;
            if (score > bestScore) {
                bestScore = score;
                bestIndex = newIndex;
            }
        }
        if (bestIndex >= 0) {
            pairs.push({ oldIndex, newIndex: bestIndex });
            minimumNewIndex = bestIndex + 1;
        }
    }
    return { pairs, candidateComparisonCount };
}

function pairChangedParagraphs(oldItems: LogicalParagraph[], newItems: LogicalParagraph[]): PairingResult {
    if (!oldItems.length || !newItems.length) return { pairs: [], candidateComparisonCount: 0 };
    return oldItems.length * newItems.length <= MAX_PAIRING_CELLS
        ? pairSmallHunk(oldItems, newItems)
        : pairLargeHunk(oldItems, newItems);
}

function appendSpan(spans: TextDiffSpan[], kind: TextDiffSpanKind, value: string): void {
    if (!value) return;
    const previous = spans[spans.length - 1];
    if (previous?.kind === kind) previous.value += value;
    else spans.push({ kind, value });
}

function computeInlineSpans(oldText: string, newText: string): { oldSpans: TextDiffSpan[]; newSpans: TextDiffSpan[] } {
    const changes = diffArrays(graphemes(oldText), graphemes(newText));
    const oldSpans: TextDiffSpan[] = [];
    const newSpans: TextDiffSpan[] = [];
    for (let index = 0; index < changes.length; index += 1) {
        const change = changes[index];
        const value = change.value.join('');
        const previous = changes[index - 1];
        const next = changes[index + 1];
        const isNoisySingleAnchor = !change.added
            && !change.removed
            && change.value.length === 1
            && Boolean(previous && next)
            && Boolean(previous?.added || previous?.removed)
            && Boolean(next?.added || next?.removed)
            && ((previous?.value.length ?? 0) + (next?.value.length ?? 0) >= 8);
        if (isNoisySingleAnchor) {
            appendSpan(oldSpans, 'removed', value);
            appendSpan(newSpans, 'added', value);
        } else if (change.added) {
            appendSpan(newSpans, 'added', value);
        } else if (change.removed) {
            appendSpan(oldSpans, 'removed', value);
        } else {
            appendSpan(oldSpans, 'unchanged', value);
            appendSpan(newSpans, 'unchanged', value);
        }
    }
    return { oldSpans, newSpans };
}

function coarseInlineSpans(oldText: string, newText: string): { oldSpans: TextDiffSpan[]; newSpans: TextDiffSpan[] } {
    return {
        oldSpans: oldText ? [{ kind: 'removed', value: oldText }] : [],
        newSpans: newText ? [{ kind: 'added', value: newText }] : [],
    };
}

function appendChangedRows(
    rows: TextDiffRow[],
    oldItems: LogicalParagraph[],
    newItems: LogicalParagraph[],
    oldLineStart: number,
    newLineStart: number,
    deadline: number,
): { candidateComparisonCount: number; refinementTimedOut: boolean } {
    const pairing = pairChangedParagraphs(oldItems, newItems);
    let oldCursor = 0;
    let newCursor = 0;
    let refinementTimedOut = false;

    const appendDeletes = (end: number) => {
        while (oldCursor < end) {
            const paragraph = oldItems[oldCursor];
            rows.push({ kind: 'delete', oldLine: oldLineStart + oldCursor, newLine: null, oldText: paragraph.text });
            oldCursor += 1;
        }
    };
    const appendInserts = (end: number) => {
        while (newCursor < end) {
            const paragraph = newItems[newCursor];
            rows.push({ kind: 'insert', oldLine: null, newLine: newLineStart + newCursor, newText: paragraph.text });
            newCursor += 1;
        }
    };

    for (const pair of pairing.pairs) {
        appendDeletes(pair.oldIndex);
        appendInserts(pair.newIndex);
        const oldText = oldItems[pair.oldIndex].text;
        const newText = newItems[pair.newIndex].text;
        const canRefine = now() <= deadline;
        if (!canRefine) refinementTimedOut = true;
        const spans = canRefine ? computeInlineSpans(oldText, newText) : coarseInlineSpans(oldText, newText);
        rows.push({
            kind: 'modify',
            oldLine: oldLineStart + pair.oldIndex,
            newLine: newLineStart + pair.newIndex,
            oldText,
            newText,
            ...spans,
        });
        oldCursor = pair.oldIndex + 1;
        newCursor = pair.newIndex + 1;
    }
    appendDeletes(oldItems.length);
    appendInserts(newItems.length);
    return { candidateComparisonCount: pairing.candidateComparisonCount, refinementTimedOut };
}

function hunkStart(
    rows: TextDiffRow[],
    side: 'old' | 'new',
    previousContext?: TextDiffRow,
    nextContext?: TextDiffRow,
): number {
    const key = side === 'old' ? 'oldLine' : 'newLine';
    const first = rows.find((row) => row[key] !== null)?.[key];
    if (typeof first === 'number') return first;
    const previous = previousContext?.[key];
    if (typeof previous === 'number') return previous + 1;
    const next = nextContext?.[key];
    return typeof next === 'number' ? next : 1;
}

function buildHunks(rows: TextDiffRow[], paragraphs: { old: LogicalParagraph[]; new: LogicalParagraph[] }): TextDiffHunk[] {
    const hunks: TextDiffHunk[] = [];
    let index = 0;
    while (index < rows.length) {
        if (rows[index].kind === 'context') {
            index += 1;
            continue;
        }
        const start = index;
        while (index < rows.length && rows[index].kind !== 'context') index += 1;
        const hunkRows = rows.slice(start, index);
        const previousContext = start > 0 ? rows[start - 1] : undefined;
        const nextContext = index < rows.length ? rows[index] : undefined;
        const previousContextHash = hashText(previousContext?.oldText ?? previousContext?.newText ?? '^');
        const nextContextHash = hashText(nextContext?.oldText ?? nextContext?.newText ?? '$');
        const oldTexts = hunkRows.filter((row) => row.oldLine !== null).map((row) => row.oldText ?? '').join('\u241e');
        const oldStart = hunkStart(hunkRows, 'old', previousContext, nextContext);
        const newStart = hunkStart(hunkRows, 'new', previousContext, nextContext);
        const oldCount = hunkRows.filter((row) => row.oldLine !== null).length;
        const newCount = hunkRows.filter((row) => row.newLine !== null).length;
        const insertionGap = oldCount === 0
            ? `${previousContext?.oldLine ?? 0}:${nextContext?.oldLine ?? paragraphs.old.length + 1}`
            : '';
        const id = `diff-v${TEXT_DIFF_VERSION}:${hashText([
            String(TEXT_DIFF_VERSION),
            previousContextHash,
            nextContextHash,
            String(oldStart),
            String(oldCount),
            oldTexts,
            insertionGap,
        ].join('|'))}`;
        for (const row of hunkRows) row.hunkId = id;
        hunks.push({
            id,
            oldStart,
            oldCount,
            newStart,
            newCount,
            previousContextHash,
            nextContextHash,
            rows: hunkRows,
        });
    }
    return hunks;
}

function projectionCounts(rows: TextDiffRow[]): { addedCount: number; removedCount: number; unchangedCount: number; changedParagraphCount: number } {
    let addedCount = 0;
    let removedCount = 0;
    let unchangedCount = 0;
    let changedParagraphCount = 0;
    for (const row of rows) {
        if (row.kind === 'context') {
            unchangedCount += graphemeCount(row.oldText ?? '');
            continue;
        }
        changedParagraphCount += 1;
        if (row.kind === 'insert') addedCount += graphemeCount(row.newText ?? '');
        else if (row.kind === 'delete') removedCount += graphemeCount(row.oldText ?? '');
        else {
            addedCount += (row.newSpans ?? []).filter((span) => span.kind === 'added').reduce((total, span) => total + graphemeCount(span.value), 0);
            removedCount += (row.oldSpans ?? []).filter((span) => span.kind === 'removed').reduce((total, span) => total + graphemeCount(span.value), 0);
            unchangedCount += (row.oldSpans ?? []).filter((span) => span.kind === 'unchanged').reduce((total, span) => total + graphemeCount(span.value), 0);
        }
    }
    return { addedCount, removedCount, unchangedCount, changedParagraphCount };
}

function finalizeProjection(
    rows: TextDiffRow[],
    paragraphs: { old: LogicalParagraph[]; new: LogicalParagraph[] },
    startedAt: number,
    candidateComparisonCount: number,
    degraded: boolean,
    fallbackReason?: TextDiffFallbackReason,
): TextDiffProjection {
    const hunks = buildHunks(rows, paragraphs);
    const counts = projectionCounts(rows);
    return {
        version: TEXT_DIFF_VERSION,
        rows,
        hunks,
        ...counts,
        changedBlockCount: hunks.length,
        degraded,
        ...(fallbackReason ? { fallbackReason } : {}),
        stats: {
            durationMs: Math.max(0, now() - startedAt),
            originalParagraphCount: paragraphs.old.length,
            draftParagraphCount: paragraphs.new.length,
            candidateComparisonCount,
            refinementTimedOut: fallbackReason === 'refinement_budget',
        },
    };
}

export function computeCoarseTextDiff(
    originalText: string,
    draftText: string,
    fallbackReason: TextDiffFallbackReason = 'worker_timeout',
): TextDiffProjection {
    const startedAt = now();
    const oldParagraphs = logicalParagraphs(originalText);
    const newParagraphs = logicalParagraphs(draftText);
    let prefix = 0;
    while (prefix < oldParagraphs.length && prefix < newParagraphs.length && oldParagraphs[prefix].key === newParagraphs[prefix].key) prefix += 1;
    let suffix = 0;
    while (
        suffix < oldParagraphs.length - prefix
        && suffix < newParagraphs.length - prefix
        && oldParagraphs[oldParagraphs.length - 1 - suffix].key === newParagraphs[newParagraphs.length - 1 - suffix].key
    ) suffix += 1;

    const rows: TextDiffRow[] = [];
    for (let index = 0; index < prefix; index += 1) {
        rows.push({ kind: 'context', oldLine: index + 1, newLine: index + 1, oldText: oldParagraphs[index].text, newText: newParagraphs[index].text });
    }
    for (let index = prefix; index < oldParagraphs.length - suffix; index += 1) {
        rows.push({ kind: 'delete', oldLine: index + 1, newLine: null, oldText: oldParagraphs[index].text });
    }
    for (let index = prefix; index < newParagraphs.length - suffix; index += 1) {
        rows.push({ kind: 'insert', oldLine: null, newLine: index + 1, newText: newParagraphs[index].text });
    }
    for (let offset = suffix; offset > 0; offset -= 1) {
        const oldIndex = oldParagraphs.length - offset;
        const newIndex = newParagraphs.length - offset;
        rows.push({ kind: 'context', oldLine: oldIndex + 1, newLine: newIndex + 1, oldText: oldParagraphs[oldIndex].text, newText: newParagraphs[newIndex].text });
    }
    return finalizeProjection(rows, { old: oldParagraphs, new: newParagraphs }, startedAt, 0, true, fallbackReason);
}

export function computeTextDiff(
    originalText: string,
    draftText: string,
    options: ComputeTextDiffOptions = {},
): TextDiffProjection {
    const startedAt = now();
    const oldParagraphs = logicalParagraphs(originalText);
    const newParagraphs = logicalParagraphs(draftText);
    const maxParagraphs = options.maxParagraphs ?? DEFAULT_MAX_PARAGRAPHS;
    const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    if (
        oldParagraphs.length > maxParagraphs
        || newParagraphs.length > maxParagraphs
        || originalText.length > maxCharacters
        || draftText.length > maxCharacters
    ) {
        return computeCoarseTextDiff(originalText, draftText, 'input_limit');
    }

    const changes = diffArrays(
        oldParagraphs.map((paragraph) => paragraph.key),
        newParagraphs.map((paragraph) => paragraph.key),
    );
    const rows: TextDiffRow[] = [];
    let oldCursor = 0;
    let newCursor = 0;
    let candidateComparisonCount = 0;
    let refinementTimedOut = false;
    const deadline = startedAt + (options.maxRefinementTimeMs ?? DEFAULT_REFINEMENT_TIME_MS);

    for (let index = 0; index < changes.length; index += 1) {
        const change = changes[index];
        if (!change.added && !change.removed) {
            for (let offset = 0; offset < change.value.length; offset += 1) {
                rows.push({
                    kind: 'context',
                    oldLine: oldCursor + 1,
                    newLine: newCursor + 1,
                    oldText: oldParagraphs[oldCursor].text,
                    newText: newParagraphs[newCursor].text,
                });
                oldCursor += 1;
                newCursor += 1;
            }
            continue;
        }

        const removedCount = change.removed ? change.value.length : 0;
        const following = changes[index + 1];
        const addedCount = change.added
            ? change.value.length
            : following?.added
                ? following.value.length
                : 0;
        if (change.removed && following?.added) index += 1;

        if (removedCount > 0 && addedCount > 0) {
            const result = appendChangedRows(
                rows,
                oldParagraphs.slice(oldCursor, oldCursor + removedCount),
                newParagraphs.slice(newCursor, newCursor + addedCount),
                oldCursor + 1,
                newCursor + 1,
                deadline,
            );
            candidateComparisonCount += result.candidateComparisonCount;
            refinementTimedOut ||= result.refinementTimedOut;
        } else if (removedCount > 0) {
            for (let offset = 0; offset < removedCount; offset += 1) {
                rows.push({ kind: 'delete', oldLine: oldCursor + offset + 1, newLine: null, oldText: oldParagraphs[oldCursor + offset].text });
            }
        } else {
            for (let offset = 0; offset < addedCount; offset += 1) {
                rows.push({ kind: 'insert', oldLine: null, newLine: newCursor + offset + 1, newText: newParagraphs[newCursor + offset].text });
            }
        }
        oldCursor += removedCount;
        newCursor += addedCount;
    }

    return finalizeProjection(
        rows,
        { old: oldParagraphs, new: newParagraphs },
        startedAt,
        candidateComparisonCount,
        refinementTimedOut,
        refinementTimedOut ? 'refinement_budget' : undefined,
    );
}
