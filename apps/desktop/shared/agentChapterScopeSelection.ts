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

export function normalizeChapterScopeSelection(
    selection: AgentChapterScopeSelection,
    orderedChapterIds: string[],
    fallbackChapterId?: string,
    fallbackVolumeId?: string,
): AgentChapterScopeSelection {
    const knownIds = new Set(orderedChapterIds);
    const chapterIds = [...new Set(selection.chapterIds)].filter((id) => knownIds.has(id));
    const anchorChapterId = selection.anchorChapterId && knownIds.has(selection.anchorChapterId)
        ? selection.anchorChapterId
        : chapterIds.at(-1) || fallbackChapterId;
    const experts = [...new Set(selection.experts)].filter((expert): expert is AgentScopeExpert => (
        ['editor', 'reader', 'worldbuilding', 'research_rag'] as string[]
    ).includes(expert));
    return {
        ...selection,
        volumeId: selection.volumeId || fallbackVolumeId,
        chapterIds: selection.kind === 'current_chapter'
            ? (fallbackChapterId ? [fallbackChapterId] : chapterIds.slice(0, 1))
            : chapterIds,
        anchorChapterId,
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
