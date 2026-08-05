import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { BookOpen, Check, ChevronDown, ListChecks, Users, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { Volume } from '../../types';
import {
  chapterScopeChapterTitle,
  chapterScopeLabel,
  chapterScopeVolumeTitle,
  type AgentChapterScopeSelection,
  type AgentScopeExpert,
} from '../../../shared/agentChapterScopeSelection';
import type { AgentChapterScopeKind } from '../../../shared/agentChapterScope';

const SCOPE_OPTIONS: Array<{ kind: AgentChapterScopeKind; label: string; description: string }> = [
  { kind: 'current_chapter', label: '当前章', description: '首先参考编辑器当前章节' },
  { kind: 'selected_chapters', label: '选择章节', description: '首先参考选中的不连续章节' },
  { kind: 'chapter_range', label: '章节区间', description: '首先参考连续章节区间' },
  { kind: 'current_volume', label: '当前卷', description: '首先参考编辑器当前卷' },
  { kind: 'novel', label: '整本小说', description: '以整本目录和分批摘要为起点' },
];

const EXPERTS: Array<{ id: AgentScopeExpert; label: string }> = [
  { id: 'editor', label: '编辑' },
  { id: 'reader', label: '读者' },
  { id: 'worldbuilding', label: '世界观' },
  { id: 'research_rag', label: '考据' },
];

export function ChapterScopeSelector({
  isDark,
  value,
  volumes,
  currentChapterId,
  currentVolumeId,
  teamMode,
  open,
  disabled,
  onChange,
  onToggle,
  onClose,
}: {
  isDark: boolean;
  value: AgentChapterScopeSelection;
  volumes: Volume[];
  currentChapterId?: string;
  currentVolumeId?: string;
  teamMode: boolean;
  open: boolean;
  disabled?: boolean;
  onChange: (value: AgentChapterScopeSelection) => void;
  onToggle: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chapters = useMemo(() => volumes.flatMap((volume, volumeIndex) => (
    [...volume.chapters]
      .sort((a, b) => a.order - b.order)
      .map((chapter, chapterIndex) => ({
        ...chapter,
        displayTitle: chapterScopeChapterTitle(chapter.title, chapter.order, chapterIndex),
        volumeId: volume.id,
        volumeTitle: chapterScopeVolumeTitle(volume.title, volumeIndex),
      }))
  )), [volumes]);
  const chapterIndex = useMemo(() => new Map(chapters.map((chapter, index) => [chapter.id, index])), [chapters]);
  const selected = new Set(value.chapterIds);
  const rangeStart = value.kind === 'chapter_range' ? value.chapterIds[0] ?? '' : '';
  const rangeEnd = value.kind === 'chapter_range' ? value.chapterIds[1] ?? '' : '';

  const selectKind = (kind: AgentChapterScopeKind) => {
    const usesCurrentChapter = kind === 'current_chapter';
    const usesCurrentVolume = kind === 'current_volume';
    const next: AgentChapterScopeSelection = {
      ...value,
      kind,
      volumeId: usesCurrentVolume || usesCurrentChapter ? currentVolumeId : undefined,
      chapterIds: usesCurrentChapter && currentChapterId ? [currentChapterId] : [],
      anchorChapterId: usesCurrentChapter || usesCurrentVolume ? currentChapterId : undefined,
      processingMode: kind === 'novel' || kind === 'current_volume' ? 'batched' : 'detailed',
    };
    onChange(next);
  };

  const setRange = (startId: string, endId: string) => {
    const startIndex = chapterIndex.get(startId);
    const endIndex = chapterIndex.get(endId);
    const ordered = startIndex !== undefined && endIndex !== undefined && startIndex > endIndex
      ? [endId, startId]
      : [startId, endId];
    onChange({
      ...value,
      kind: 'chapter_range',
      chapterIds: ordered.filter(Boolean),
      anchorChapterId: ordered.filter(Boolean).at(-1),
    });
  };

  const toggleChapter = (chapterId: string) => {
    const nextIds = selected.has(chapterId)
      ? value.chapterIds.filter((id) => id !== chapterId)
      : chapters.filter((chapter) => selected.has(chapter.id) || chapter.id === chapterId).map((chapter) => chapter.id);
    onChange({ ...value, chapterIds: nextIds, anchorChapterId: nextIds.at(-1) });
  };

  const toggleExpert = (expert: AgentScopeExpert) => {
    const next = value.experts.includes(expert)
      ? value.experts.filter((item) => item !== expert)
      : [...value.experts, expert];
    if (next.length > 0) onChange({ ...value, experts: next });
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onClose, open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={onToggle}
        className={clsx(
          'h-8 max-w-[136px] rounded-md border px-2 inline-flex items-center gap-1.5 text-xs disabled:opacity-40',
          isDark ? 'border-white/10 bg-black/20 hover:bg-white/5' : 'border-[var(--ui-border)] bg-white hover:bg-[var(--ui-surface-subtle)]',
        )}
        title="选择 Agent 首先参考的章节范围"
      >
        <ListChecks className="h-4 w-4 shrink-0 text-[#2f80ed]" />
        <span className="truncate">{chapterScopeLabel(value)}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
      </button>

      {open && (
        <div className={clsx(
          'absolute bottom-[calc(100%+8px)] left-0 z-50 w-[420px] max-w-[calc(100vw-48px)] overflow-hidden rounded-lg border shadow-xl',
          isDark ? 'border-white/10 bg-[#17171c] shadow-black/40' : 'border-[var(--ui-border)] bg-white shadow-black/10',
        )}>
          <div className="flex items-center justify-between gap-3 border-b border-inherit px-3 py-2.5">
            <div>
              <div className="text-sm font-semibold">章节范围</div>
              <div className={clsx('mt-0.5 text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>初始上下文；Agent 可按任务需要申请补读其他章节</div>
            </div>
            <button type="button" onClick={onClose} className={clsx('grid h-7 w-7 place-items-center rounded-md', isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]')} title="关闭">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-[142px_1fr] min-h-[280px] max-h-[480px]">
            <div className={clsx('border-r border-inherit p-2', isDark ? 'bg-black/15' : 'bg-[var(--ui-surface-subtle)]')}>
              {SCOPE_OPTIONS.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  onClick={() => selectKind(option.kind)}
                  className={clsx(
                    'w-full rounded-md px-2 py-2 text-left',
                    value.kind === option.kind
                      ? (isDark ? 'bg-white/10' : 'bg-white shadow-sm')
                      : (isDark ? 'hover:bg-white/5' : 'hover:bg-white/70'),
                  )}
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-medium">
                    {option.label}
                    {value.kind === option.kind && <Check className="h-3.5 w-3.5 text-[#2f80ed]" />}
                  </div>
                  <div className={clsx('mt-0.5 text-[10px] leading-4', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{option.description}</div>
                </button>
              ))}
            </div>

            <div className="min-w-0 overflow-y-auto p-3">
              {value.kind === 'current_chapter' && (
                <ScopeNotice icon={<BookOpen className="h-4 w-4" />} title="当前章节" description={chapters.find((chapter) => chapter.id === currentChapterId)?.displayTitle || '尚未选择章节'} isDark={isDark} />
              )}
              {value.kind === 'current_volume' && (
                <ScopeNotice
                  icon={<BookOpen className="h-4 w-4" />}
                  title="当前卷"
                  description={(() => {
                    const index = volumes.findIndex((volume) => volume.id === currentVolumeId);
                    return index >= 0 ? chapterScopeVolumeTitle(volumes[index].title, index) : '当前章节不属于可用卷';
                  })()}
                  isDark={isDark}
                />
              )}
              {value.kind === 'novel' && (
                <ScopeNotice icon={<BookOpen className="h-4 w-4" />} title="整本小说" description={`共 ${chapters.length} 章；超过 20 章时按批次装配摘要上下文`} isDark={isDark} />
              )}
              {value.kind === 'selected_chapters' && (
                <div className="space-y-3">
                  {volumes.map((volume, volumeIndex) => (
                    <div key={volume.id}>
                      <div className={clsx('sticky top-0 py-1 text-[11px] font-medium', isDark ? 'bg-[#17171c] text-neutral-400' : 'bg-white text-[var(--ui-text-secondary)]')}>{chapterScopeVolumeTitle(volume.title, volumeIndex)}</div>
                      <div className="space-y-0.5">
                        {[...volume.chapters].sort((a, b) => a.order - b.order).map((chapter, chapterIndex) => (
                          <button key={chapter.id} type="button" onClick={() => toggleChapter(chapter.id)} className={clsx('w-full rounded px-2 py-1.5 flex items-center gap-2 text-left text-xs', isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]')}>
                            <span className={clsx('grid h-4 w-4 place-items-center rounded-sm border', selected.has(chapter.id) ? 'border-[#2f80ed] bg-[#2f80ed] text-white' : isDark ? 'border-white/20' : 'border-[var(--ui-border-strong)]')}>
                              {selected.has(chapter.id) && <Check className="h-3 w-3" />}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{chapterScopeChapterTitle(chapter.title, chapter.order, chapterIndex)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {value.kind === 'chapter_range' && (
                <div className="space-y-3">
                  <label className="block text-xs">
                    <span className={isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]'}>起始章节</span>
                    <select value={rangeStart} onChange={(event) => setRange(event.target.value, rangeEnd)} className={clsx('mt-1.5 h-9 w-full rounded-md border px-2 outline-none', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
                      <option value="">请选择</option>
                      {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.volumeTitle} · {chapter.displayTitle}</option>)}
                    </select>
                  </label>
                  <label className="block text-xs">
                    <span className={isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]'}>结束章节</span>
                    <select value={rangeEnd} onChange={(event) => setRange(rangeStart, event.target.value)} className={clsx('mt-1.5 h-9 w-full rounded-md border px-2 outline-none', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
                      <option value="">请选择</option>
                      {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.volumeTitle} · {chapter.displayTitle}</option>)}
                    </select>
                  </label>
                </div>
              )}

              {teamMode && (
                <div className={clsx('mt-4 border-t pt-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                  <div className="flex items-center gap-2 text-xs font-medium"><Users className="h-3.5 w-3.5" />团队专家</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {EXPERTS.map((expert) => (
                      <button key={expert.id} type="button" onClick={() => toggleExpert(expert.id)} className={clsx('rounded-md border px-2 py-1 text-xs', value.experts.includes(expert.id) ? 'border-[#2f80ed] bg-[#eaf3ff] text-[#1d63b7]' : isDark ? 'border-white/10 text-neutral-400' : 'border-[var(--ui-border)] text-[var(--ui-text-muted)]')}>
                        {expert.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeNotice({ icon, title, description, isDark }: { icon: ReactNode; title: string; description: string; isDark: boolean }) {
  return (
    <div className={clsx('rounded-md border p-3', isDark ? 'border-white/10 bg-white/5' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
      <div className="flex items-center gap-2 text-sm font-medium">{icon}{title}</div>
      <div className={clsx('mt-1.5 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{description}</div>
    </div>
  );
}
