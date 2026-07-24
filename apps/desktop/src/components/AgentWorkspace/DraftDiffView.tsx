import { useMemo } from 'react';
import { clsx } from 'clsx';
import { projectTextDiff } from '../../../shared/textDiff';

type Props = {
  originalText: string;
  draftText: string;
  isDark: boolean;
};

export function DraftDiffView({ originalText, draftText, isDark }: Props) {
  const projection = useMemo(
    () => projectTextDiff(originalText, draftText),
    [draftText, originalText],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className={clsx('flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-2 text-xs', isDark ? 'border-white/10 bg-white/[0.02] text-neutral-400' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-muted)]')}>
        <span className="font-semibold text-current">修改摘要</span>
        <span>{projection.changedBlockCount} 处调整</span>
        <span className={isDark ? 'text-emerald-300' : 'text-emerald-700'}>新增 {projection.addedCount} 字</span>
        <span className={isDark ? 'text-red-300' : 'text-red-700'}>删除 {projection.removedCount} 字</span>
      </div>
      <div className={clsx('min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-6 py-5 font-serif text-[15px] leading-8', isDark ? 'bg-[#111116] text-neutral-300' : 'bg-[var(--ui-canvas)] text-[var(--ui-text-secondary)]')}>
        {projection.segments.length === 0 ? (
          <span className={isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]'}>原文和草稿均为空</span>
        ) : projection.segments.map((segment, index) => {
          if (segment.kind === 'added') {
            return <ins key={index} className={clsx('no-underline', isDark ? 'bg-emerald-500/20 text-emerald-100' : 'bg-emerald-100 text-emerald-900')}>{segment.value}</ins>;
          }
          if (segment.kind === 'removed') {
            return <del key={index} className={clsx(isDark ? 'bg-red-500/20 text-red-200 decoration-red-300' : 'bg-red-100 text-red-800 decoration-red-500')}>{segment.value}</del>;
          }
          return <span key={index}>{segment.value}</span>;
        })}
      </div>
    </section>
  );
}
