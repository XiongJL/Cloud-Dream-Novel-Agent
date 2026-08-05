import type { AgentChapterProcessingMode, AgentChapterScopeKind } from './agentChapterScope';

export type AgentScopeExpert = 'editor' | 'reader' | 'worldbuilding' | 'research_rag';

export interface AgentChapterScopeSelection {
    kind: AgentChapterScopeKind;
    volumeId?: string;
    chapterIds: string[];
    anchorChapterId?: string;
    processingMode: AgentChapterProcessingMode;
    experts: AgentScopeExpert[];
}

export function chapterScopeChapterTitle(title: unknown, order: unknown, fallbackIndex: number): string {
    const normalized = typeof title === 'string' ? title.trim() : '';
    if (normalized) return normalized;
    const chapterNumber = typeof order === 'number' && Number.isFinite(order) && order > 0
        ? Math.floor(order)
        : fallbackIndex + 1;
    return `第 ${chapterNumber} 章（未命名）`;
}

export function chapterScopeVolumeTitle(title: unknown, fallbackIndex: number): string {
    const normalized = typeof title === 'string' ? title.trim() : '';
    return normalized || `第 ${fallbackIndex + 1} 卷（未命名）`;
}

export function createDefaultChapterScope(chapterId?: string, volumeId?: string): AgentChapterScopeSelection {
    return {
        kind: 'current_chapter',
        volumeId,
        chapterIds: chapterId ? [chapterId] : [],
        anchorChapterId: chapterId,
        processingMode: 'detailed',
        experts: ['editor', 'reader', 'worldbuilding'],
    };
}

function scopeRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/** Recover the explicit chapter scope persisted inside a plan toolchain input. */
export function chapterScopeSelectionFromPlan(plan: unknown): AgentChapterScopeSelection | null {
    const planRecord = scopeRecord(plan);
    const steps = Array.isArray(planRecord?.steps) ? planRecord.steps : [];
    for (const stepValue of [...steps].reverse()) {
        const step = scopeRecord(stepValue);
        const toolchain = scopeRecord(step?.toolchain);
        const input = scopeRecord(toolchain?.input);
        const kind = input?.kind;
        if (!['current_chapter', 'selected_chapters', 'chapter_range', 'current_volume', 'novel'].includes(String(kind))) {
            continue;
        }
        const chapterIds = Array.isArray(input?.chapterIds)
            ? [...new Set(input.chapterIds.filter((value): value is string => typeof value === 'string' && value.length > 0))]
            : [];
        const declaredChapterCount = typeof input?.chapterCount === 'number' && Number.isFinite(input.chapterCount)
            ? Math.floor(input.chapterCount)
            : null;
        if (declaredChapterCount !== null && chapterIds.length > 0 && declaredChapterCount !== chapterIds.length) {
            continue;
        }
        if (kind === 'current_chapter' && chapterIds.length !== 1) continue;
        if (kind === 'selected_chapters' && chapterIds.length === 0) continue;
        if (kind === 'chapter_range' && chapterIds.length < 2) continue;
        if (kind === 'current_volume' && typeof input?.volumeId !== 'string') continue;
        const processingMode: AgentChapterProcessingMode = input?.processingMode === 'batched' ? 'batched' : 'detailed';
        const experts = Array.isArray(input?.experts)
            ? input.experts.filter((value): value is AgentScopeExpert => (
                typeof value === 'string'
                && ['editor', 'reader', 'worldbuilding', 'research_rag'].includes(value)
            ))
            : [];
        return {
            kind: kind as AgentChapterScopeKind,
            ...(typeof input?.volumeId === 'string' ? { volumeId: input.volumeId } : {}),
            chapterIds,
            ...(typeof input?.anchorChapterId === 'string'
                ? { anchorChapterId: input.anchorChapterId }
                : chapterIds[0] ? { anchorChapterId: chapterIds[0] } : {}),
            processingMode,
            experts: experts.length > 0 ? experts : ['editor', 'reader', 'worldbuilding'],
        };
    }
    return null;
}

export function normalizeChapterScopeSelection(
    selection: AgentChapterScopeSelection,
    orderedChapterIds: string[],
    fallbackChapterId?: string,
    fallbackVolumeId?: string,
): AgentChapterScopeSelection {
    const knownIds = new Set(orderedChapterIds);
    const chapterIds = [...new Set(selection.chapterIds)].filter((id) => knownIds.has(id));
    const anchorChapterId = selection.kind === 'novel'
        ? undefined
        : selection.anchorChapterId && knownIds.has(selection.anchorChapterId)
            ? selection.anchorChapterId
            : chapterIds.at(-1) || fallbackChapterId;
    const experts = [...new Set(selection.experts)].filter((expert): expert is AgentScopeExpert => (
        ['editor', 'reader', 'worldbuilding', 'research_rag'] as string[]
    ).includes(expert));
    return {
        ...selection,
        volumeId: selection.kind === 'novel' ? undefined : selection.volumeId || fallbackVolumeId,
        chapterIds: selection.kind === 'current_chapter'
            ? (fallbackChapterId ? [fallbackChapterId] : chapterIds.slice(0, 1))
            : chapterIds,
        ...(anchorChapterId ? { anchorChapterId } : { anchorChapterId: undefined }),
        experts: experts.length > 0 ? experts : ['editor', 'reader', 'worldbuilding'],
    };
}

export function chapterScopeLabel(selection: AgentChapterScopeSelection): string {
    if (selection.kind === 'current_chapter') return '当前章';
    if (selection.kind === 'selected_chapters') return `已选 ${selection.chapterIds.length} 章`;
    if (selection.kind === 'chapter_range') return selection.chapterIds.length >= 2 ? '章节区间' : '选择区间';
    if (selection.kind === 'current_volume') return '当前卷';
    return '整本小说';
}

export function isChapterScopeSelectionValid(selection: AgentChapterScopeSelection): boolean {
    if (selection.kind === 'current_chapter') return Boolean(selection.anchorChapterId || selection.chapterIds[0]);
    if (selection.kind === 'selected_chapters') return selection.chapterIds.length > 0;
    if (selection.kind === 'chapter_range') return selection.chapterIds.length >= 2;
    if (selection.kind === 'current_volume') return Boolean(selection.volumeId);
    return true;
}

export function chapterScopePayload(selection: AgentChapterScopeSelection): Record<string, unknown> {
    return {
        kind: selection.kind,
        ...(selection.volumeId ? { volumeId: selection.volumeId } : {}),
        chapterIds: selection.chapterIds,
        ...(selection.anchorChapterId ? { anchorChapterId: selection.anchorChapterId } : {}),
        processingMode: selection.processingMode,
        experts: selection.experts,
    };
}
