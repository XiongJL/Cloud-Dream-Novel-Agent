import { useEffect, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { clsx } from 'clsx';
import type { DraftBatchRecord } from '../../../shared/draftBatch';

type Props = {
  isDark: boolean;
  beats: DraftBatchRecord['outline']['beats'];
  revision: number;
  statusLabel?: string;
  historical?: boolean;
  chapterLabels?: readonly string[];
};

export function ChapterBeatPreviewPanel({
  isDark,
  beats,
  revision,
  statusLabel = '节拍待确认',
  historical = false,
  chapterLabels = [],
}: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [revision]);

  const selectedBeat = beats[selectedIndex] ?? beats[0] ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={clsx('shrink-0 border-b px-5 py-4', isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-[#2f80ed]" />
              <span className={clsx('rounded px-2 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>{statusLabel}</span>
            </div>
            <p className={clsx('mt-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
              共 {beats.length} 章 · 节拍 v{revision}{historical ? ' · 历史版本' : ''}
            </p>
          </div>
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {beats.map((beat, index) => (
            <button
              key={beat.beatId || `${revision}:${index}`}
              type="button"
              onClick={() => setSelectedIndex(index)}
              className={clsx(
                'min-w-[132px] rounded-md border px-3 py-2 text-left',
                selectedIndex === index
                  ? (isDark ? 'border-[#2f80ed] bg-[#2f80ed]/10' : 'border-[#2f80ed] bg-[#edf5ff]')
                  : (isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white'),
              )}
            >
              <div className="text-xs font-semibold">{chapterLabels[index] || `批次第 ${index + 1} 章`}</div>
              <div className="mt-1 truncate text-xs text-[var(--ui-text-muted)]" title={beat.title}>{beat.title}</div>
            </button>
          ))}
        </div>
      </header>

      <div className={clsx('min-h-0 flex-1 overflow-y-auto px-6 py-5', isDark ? 'bg-[#111116]' : 'bg-[var(--ui-canvas)]')}>
        {selectedBeat ? (
          <article className="mx-auto max-w-3xl">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{chapterLabels[selectedIndex] || `批次第 ${selectedIndex + 1} 章`} · 只读节拍</div>
                <h3 className="mt-1 text-base font-semibold">{selectedBeat.title}</h3>
              </div>
              <span className={clsx('rounded px-2 py-1 text-[11px]', isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>v{revision}</span>
            </div>
            <dl className="mt-5 space-y-4 text-sm leading-6">
              <div><dt className="font-semibold">章节目标</dt><dd className={clsx('mt-1 whitespace-pre-wrap', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.chapterGoal}</dd></div>
              <div><dt className="font-semibold">核心冲突</dt><dd className={clsx('mt-1 whitespace-pre-wrap', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.coreConflict}</dd></div>
              <div><dt className="font-semibold">关键事件</dt><dd className={clsx('mt-1 whitespace-pre-wrap', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.keyEvents.join('；') || '未指定'}</dd></div>
              <div><dt className="font-semibold">信息揭示</dt><dd className={clsx('mt-1 whitespace-pre-wrap', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.reveals.join('；') || '未指定'}</dd></div>
              <div><dt className="font-semibold">结尾钩子</dt><dd className={clsx('mt-1 whitespace-pre-wrap', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.endingHook}</dd></div>
              <div><dt className="font-semibold">目标字数</dt><dd className={clsx('mt-1 tabular-nums', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.targetWordCount.toLocaleString()} 字</dd></div>
            </dl>
          </article>
        ) : (
          <div className="grid h-full place-items-center text-sm text-[var(--ui-text-muted)]">当前版本没有可显示的节拍。</div>
        )}
      </div>
      <footer className={clsx('shrink-0 border-t px-5 py-3 text-xs leading-5', isDark ? 'border-white/10 bg-[#0f0f13] text-neutral-500' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-muted)]')}>
        只读预览 · 节拍确认和调整在会话中完成
      </footer>
    </div>
  );
}
