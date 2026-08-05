import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Loader2, MessageSquarePlus, Pencil, Trash2, X } from 'lucide-react';
import { clsx } from 'clsx';
import {
  TEXT_DIFF_VERSION,
  type TextDiffHunk,
  type TextDiffProjection,
  type TextDiffRow,
  type TextDiffSpan,
} from '../../../shared/textDiff';
import type { ReviewCommentAnchor, ReviewCommentRecord } from '../../../shared/reviewComments';
import { activeReviewComments } from '../../../shared/reviewComments';
import { useTextDiff } from './useTextDiff';

type Props = {
  originalText: string;
  draftText: string;
  isDark: boolean;
  reviewVersionId?: string;
  comments?: ReviewCommentRecord[];
  disabled?: boolean;
  isMutating?: boolean;
  onSave?: (anchor: ReviewCommentAnchor, body: string, commentId?: string) => Promise<unknown>;
  onDelete?: (commentId: string) => Promise<void>;
};

type DiffReviewKind = 'added' | 'removed' | 'changed';
type DiffViewMode = 'unified' | 'side-by-side';

type EditingComment = {
  hunkId: string;
  kind: DiffReviewKind;
  value: string;
  commentId?: string;
  body: string;
};

type DisplayItem =
  | { kind: 'row'; row: TextDiffRow; sourceIndex: number }
  | { kind: 'collapsed'; id: string; hiddenCount: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '操作失败');
}

function contentFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function hunkKind(hunk: TextDiffHunk): DiffReviewKind {
  if (hunk.oldCount === 0) return 'added';
  if (hunk.newCount === 0) return 'removed';
  return 'changed';
}

function hunkLabel(kind: DiffReviewKind): string {
  if (kind === 'added') return '新增段落';
  if (kind === 'removed') return '待删除段落';
  return '调整段落';
}

function hunkQuote(hunk: TextDiffHunk): string {
  return hunk.rows
    .map((row) => row.newText || row.oldText || '')
    .filter(Boolean)
    .join('\n')
    .slice(0, 500);
}

function hunkAnchor(reviewVersionId: string, hunk: TextDiffHunk, value: string): ReviewCommentAnchor {
  const kind = hunkKind(hunk);
  return {
    kind: 'diff_hunk',
    targetId: `${reviewVersionId}:diff:${hunk.id}`,
    diffVersion: TEXT_DIFF_VERSION,
    diffHunkId: hunk.id,
    ...(hunk.oldCount > 0 ? {
      oldStartLine: hunk.oldStart,
      oldEndLine: hunk.oldStart + hunk.oldCount - 1,
    } : {}),
    ...(hunk.newCount > 0 ? {
      newStartLine: hunk.newStart,
      newEndLine: hunk.newStart + hunk.newCount - 1,
    } : {}),
    side: kind === 'added' ? 'new' : kind === 'removed' ? 'old' : 'both',
    quote: value.slice(0, 500),
    contentHash: contentFingerprint(value),
    fieldPath: kind,
  };
}

function displayItems(rows: TextDiffRow[], expanded: Set<string>): DisplayItem[] {
  const items: DisplayItem[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== 'context') {
      items.push({ kind: 'row', row: rows[index], sourceIndex: index });
      index += 1;
      continue;
    }
    const start = index;
    while (index < rows.length && rows[index].kind === 'context') index += 1;
    const count = index - start;
    const id = `context:${start}:${index}`;
    if (count <= 8 || expanded.has(id)) {
      for (let rowIndex = start; rowIndex < index; rowIndex += 1) {
        items.push({ kind: 'row', row: rows[rowIndex], sourceIndex: rowIndex });
      }
      continue;
    }
    for (let rowIndex = start; rowIndex < start + 3; rowIndex += 1) {
      items.push({ kind: 'row', row: rows[rowIndex], sourceIndex: rowIndex });
    }
    items.push({ kind: 'collapsed', id, hiddenCount: count - 6 });
    for (let rowIndex = index - 3; rowIndex < index; rowIndex += 1) {
      items.push({ kind: 'row', row: rows[rowIndex], sourceIndex: rowIndex });
    }
  }
  return items;
}

function rowContainsQuote(row: TextDiffRow, quote: string): boolean {
  const normalized = quote.trim();
  if (!normalized) return false;
  return [row.oldText, row.newText].some((text) => Boolean(text && (text.includes(normalized) || normalized.includes(text))));
}

function resolveComments(comments: ReviewCommentRecord[], projection: TextDiffProjection) {
  const commentsByHunk = new Map<string, ReviewCommentRecord[]>();
  const orphaned: ReviewCommentRecord[] = [];
  const hunkIds = new Set(projection.hunks.map((hunk) => hunk.id));
  for (const comment of activeReviewComments(comments)) {
    if (comment.anchor.kind !== 'diff_hunk') continue;
    let hunkId = comment.anchor.diffHunkId && hunkIds.has(comment.anchor.diffHunkId)
      ? comment.anchor.diffHunkId
      : undefined;
    if (!hunkId && comment.anchor.quote) {
      const matches = projection.hunks.filter((hunk) => hunk.rows.some((row) => rowContainsQuote(row, comment.anchor.quote ?? '')));
      if (matches.length === 1) hunkId = matches[0].id;
    }
    if (!hunkId && comment.anchor.contentHash) {
      const matches = projection.hunks.filter((hunk) => contentFingerprint(hunkQuote(hunk)) === comment.anchor.contentHash);
      if (matches.length === 1) hunkId = matches[0].id;
    }
    if (!hunkId) {
      orphaned.push(comment);
      continue;
    }
    const current = commentsByHunk.get(hunkId) ?? [];
    current.push(comment);
    commentsByHunk.set(hunkId, current);
  }
  return { commentsByHunk, orphaned };
}

function useWideDiff(containerRef: React.RefObject<HTMLElement>): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setWide(element.getBoundingClientRect().width >= 1000);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);
  return wide;
}

export function DraftDiffView({
  originalText,
  draftText,
  isDark,
  reviewVersionId,
  comments = [],
  disabled,
  isMutating,
  onSave,
  onDelete,
}: Props) {
  const { projection, isLoading } = useTextDiff(originalText, draftText);
  const containerRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hunkElements = useRef(new Map<string, HTMLElement>());
  const isWide = useWideDiff(containerRef);
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified');
  const [expandedContexts, setExpandedContexts] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<EditingComment | null>(null);
  const [localError, setLocalError] = useState('');
  const [activeHunkIndex, setActiveHunkIndex] = useState(0);
  const reviewEnabled = Boolean(reviewVersionId && onSave && onDelete);

  useEffect(() => {
    if (!isWide) setViewMode('unified');
  }, [isWide]);

  useEffect(() => {
    setExpandedContexts(new Set());
    setActiveHunkIndex(0);
    hunkElements.current.clear();
  }, [projection]);

  const items = useMemo(
    () => projection ? displayItems(projection.rows, expandedContexts) : [],
    [expandedContexts, projection],
  );
  const resolvedComments = useMemo(
    () => projection ? resolveComments(comments, projection) : { commentsByHunk: new Map<string, ReviewCommentRecord[]>(), orphaned: [] },
    [comments, projection],
  );
  const hunkById = useMemo(
    () => new Map((projection?.hunks ?? []).map((hunk) => [hunk.id, hunk])),
    [projection?.hunks],
  );

  const submit = async () => {
    if (!editing?.body.trim() || !reviewVersionId || !onSave) return;
    const hunk = hunkById.get(editing.hunkId);
    if (!hunk) return;
    setLocalError('');
    try {
      await onSave(hunkAnchor(reviewVersionId, hunk, editing.value), editing.body.trim(), editing.commentId);
      setEditing(null);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  const goToHunk = (direction: -1 | 1) => {
    if (!projection?.hunks.length) return;
    const nextIndex = Math.min(Math.max(activeHunkIndex + direction, 0), projection.hunks.length - 1);
    setActiveHunkIndex(nextIndex);
    hunkElements.current.get(projection.hunks[nextIndex].id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (!projection) {
    return (
      <section ref={containerRef} className="grid min-h-0 flex-1 place-items-center">
        <div className="flex items-center gap-2 text-sm text-[var(--ui-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />正在计算差异…</div>
      </section>
    );
  }

  return (
    <section ref={containerRef} className="flex min-h-0 flex-1 flex-col">
      <div className={clsx('flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs', isDark ? 'border-white/10 bg-white/[0.02] text-neutral-400' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-muted)]')}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-semibold text-current">修改摘要</span>
          <span>{projection.hunks.length} 处调整</span>
          <span className={isDark ? 'text-emerald-300' : 'text-emerald-700'}>新增 {projection.addedCount} 字</span>
          <span className={isDark ? 'text-red-300' : 'text-red-700'}>删除 {projection.removedCount} 字</span>
          {isLoading && <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />重新计算</span>}
        </div>
        <div className="flex items-center gap-1">
          {projection.hunks.length > 0 && (
            <>
              <button type="button" onClick={() => goToHunk(-1)} disabled={activeHunkIndex <= 0} className="grid h-7 w-7 place-items-center rounded hover:bg-black/5 disabled:opacity-35" title="上一处修改"><ArrowUp className="h-3.5 w-3.5" /></button>
              <span className="min-w-12 text-center tabular-nums">{activeHunkIndex + 1}/{projection.hunks.length}</span>
              <button type="button" onClick={() => goToHunk(1)} disabled={activeHunkIndex >= projection.hunks.length - 1} className="grid h-7 w-7 place-items-center rounded hover:bg-black/5 disabled:opacity-35" title="下一处修改"><ArrowDown className="h-3.5 w-3.5" /></button>
            </>
          )}
          {isWide && (
            <div className={clsx('ml-2 flex rounded border p-0.5', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
              <button type="button" onClick={() => setViewMode('unified')} className={clsx('h-7 rounded px-2', viewMode === 'unified' && (isDark ? 'bg-white/10 text-white' : 'bg-white text-[var(--ui-text-primary)]'))}>统一式</button>
              <button type="button" onClick={() => setViewMode('side-by-side')} className={clsx('h-7 rounded px-2', viewMode === 'side-by-side' && (isDark ? 'bg-white/10 text-white' : 'bg-white text-[var(--ui-text-primary)]'))}>双栏</button>
            </div>
          )}
        </div>
      </div>

      {projection.degraded && (
        <div className={clsx('shrink-0 border-b px-5 py-2 text-xs', isDark ? 'border-amber-400/20 bg-amber-400/[0.06] text-amber-200' : 'border-[#ead9b7] bg-[#fff8e8] text-[#805d18]')}>
          文本较长或计算超时，已显示段落级差异，行内高亮已简化。
        </div>
      )}

      {resolvedComments.orphaned.length > 0 && (
        <div className={clsx('shrink-0 border-b px-5 py-3', isDark ? 'border-white/10 bg-sky-400/[0.04]' : 'border-[var(--ui-border)] bg-[#f4f8fc]')}>
          <div className="text-xs font-semibold">{resolvedComments.orphaned.length} 条审批意见定位已变化</div>
          <div className="mt-2 space-y-1.5">
            {resolvedComments.orphaned.map((comment) => (
              <div key={comment.commentId} className="flex items-start justify-between gap-3 text-xs">
                <span className="min-w-0 whitespace-pre-wrap text-[var(--ui-text-secondary)]">{comment.body}</span>
                {!disabled && <button type="button" onClick={() => void onDelete?.(comment.commentId)} disabled={isMutating} className="shrink-0 text-red-500 disabled:opacity-45">删除</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={scrollRef} className={clsx('min-h-0 flex-1 overflow-y-auto py-3 font-serif text-[15px] leading-7', isDark ? 'bg-[#111116] text-neutral-300' : 'bg-[var(--ui-canvas)] text-[var(--ui-text-secondary)]')}>
        {projection.rows.length === 0 ? (
          <div className="grid min-h-40 place-items-center text-sm text-[var(--ui-text-muted)]">原文和草稿均为空</div>
        ) : projection.hunks.length === 0 ? (
          <div>
            <div className="px-5 pb-3 text-xs font-medium text-emerald-600">原文和草稿没有差异</div>
            {items.map((item) => item.kind === 'collapsed'
              ? <CollapsedContext key={item.id} item={item} onExpand={() => setExpandedContexts((current) => new Set(current).add(item.id))} />
              : <DiffRowView key={item.sourceIndex} row={item.row} viewMode={viewMode} isDark={isDark} />)}
          </div>
        ) : (
          <div>
            {items.map((item) => {
              if (item.kind === 'collapsed') {
                return <CollapsedContext key={item.id} item={item} onExpand={() => setExpandedContexts((current) => new Set(current).add(item.id))} />;
              }
              const { row, sourceIndex } = item;
              const hunk = row.hunkId ? hunkById.get(row.hunkId) : undefined;
              const isHunkStart = Boolean(row.hunkId && projection.rows[sourceIndex - 1]?.hunkId !== row.hunkId);
              const isHunkTail = Boolean(row.hunkId && projection.rows[sourceIndex + 1]?.hunkId !== row.hunkId);
              const hunkComments = row.hunkId ? resolvedComments.commentsByHunk.get(row.hunkId) ?? [] : [];
              const isEditing = Boolean(row.hunkId && editing?.hunkId === row.hunkId);
              const quote = hunk ? hunkQuote(hunk) : '';
              const kind = hunk ? hunkKind(hunk) : 'changed';
              return (
                <section
                  key={`${sourceIndex}:${row.kind}`}
                  ref={isHunkStart && row.hunkId ? (element) => {
                    if (element) hunkElements.current.set(row.hunkId as string, element);
                  } : undefined}
                  className="group relative"
                >
                  <DiffRowView row={row} viewMode={viewMode} isDark={isDark} />
                  {row.hunkId && reviewEnabled && !disabled && !isEditing && (
                    <button
                      type="button"
                      onClick={() => setEditing({ hunkId: row.hunkId as string, kind, value: quote, body: '' })}
                      className={clsx('absolute right-3 top-1 grid h-7 w-7 place-items-center rounded border opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100', isDark ? 'border-white/10 bg-[#202027] text-neutral-300' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-secondary)]')}
                      title="添加审批意见"
                      aria-label="为本处差异添加审批意见"
                    >
                      <MessageSquarePlus className="h-4 w-4" />
                    </button>
                  )}
                  {isHunkTail && (
                    <div className="mx-5">
                      {isEditing && editing && (
                        <DiffCommentEditor editing={editing} isDark={isDark} isMutating={isMutating} localError={localError} setEditing={setEditing} setLocalError={setLocalError} onSubmit={submit} />
                      )}
                      {hunkComments.filter((comment) => comment.commentId !== editing?.commentId).map((comment) => (
                        <DiffCommentCard
                          key={comment.commentId}
                          comment={comment}
                          hunkId={row.hunkId as string}
                          kind={kind}
                          value={quote}
                          isDark={isDark}
                          disabled={disabled}
                          isMutating={isMutating}
                          onEdit={setEditing}
                          onDelete={onDelete}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function CollapsedContext({ item, onExpand }: { item: Extract<DisplayItem, { kind: 'collapsed' }>; onExpand: () => void }) {
  return (
    <button type="button" onClick={onExpand} className="my-1 flex w-full items-center justify-center border-y border-dashed border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] px-4 py-1.5 font-sans text-xs text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]">
      展开 {item.hiddenCount} 个未修改段落
    </button>
  );
}

function DiffRowView({ row, viewMode, isDark }: { row: TextDiffRow; viewMode: DiffViewMode; isDark: boolean }) {
  if (viewMode === 'side-by-side') return <SideBySideRow row={row} isDark={isDark} />;
  if (row.kind === 'modify') {
    return (
      <>
        <UnifiedLine oldLine={row.oldLine} newLine={null} text={row.oldText ?? ''} spans={row.oldSpans} tone="removed" isDark={isDark} />
        <UnifiedLine oldLine={null} newLine={row.newLine} text={row.newText ?? ''} spans={row.newSpans} tone="added" isDark={isDark} />
      </>
    );
  }
  return (
    <UnifiedLine
      oldLine={row.oldLine}
      newLine={row.newLine}
      text={row.oldText ?? row.newText ?? ''}
      tone={row.kind === 'delete' ? 'removed' : row.kind === 'insert' ? 'added' : 'context'}
      isDark={isDark}
    />
  );
}

function UnifiedLine({
  oldLine,
  newLine,
  text,
  spans,
  tone,
  isDark,
}: {
  oldLine: number | null;
  newLine: number | null;
  text: string;
  spans?: TextDiffSpan[];
  tone: 'context' | 'added' | 'removed';
  isDark: boolean;
}) {
  return (
    <div className={clsx(
      'grid grid-cols-[42px_42px_minmax(0,1fr)] border-l-2 px-2 py-1',
      tone === 'added' && (isDark ? 'border-emerald-400 bg-emerald-500/10' : 'border-emerald-500 bg-emerald-50'),
      tone === 'removed' && (isDark ? 'border-red-400 bg-red-500/10' : 'border-red-500 bg-red-50'),
      tone === 'context' && 'border-transparent',
    )}>
      <LineNumber value={oldLine} />
      <LineNumber value={newLine} />
      <div className="min-w-0 whitespace-pre-wrap break-words pr-10">
        <span className="mr-2 select-none font-mono text-xs text-[var(--ui-text-disabled)]">{tone === 'added' ? '+' : tone === 'removed' ? '−' : ' '}</span>
        {spans?.length ? <DiffSpans spans={spans} isDark={isDark} /> : text}
      </div>
    </div>
  );
}

function SideBySideRow({ row, isDark }: { row: TextDiffRow; isDark: boolean }) {
  const oldChanged = row.kind === 'delete' || row.kind === 'modify';
  const newChanged = row.kind === 'insert' || row.kind === 'modify';
  return (
    <div className="grid grid-cols-[42px_minmax(0,1fr)_42px_minmax(0,1fr)] border-l-2 border-transparent">
      <div className={clsx('py-1', oldChanged && (isDark ? 'bg-red-500/10' : 'bg-red-50'))}><LineNumber value={row.oldLine} /></div>
      <div className={clsx('min-w-0 whitespace-pre-wrap break-words border-r px-2 py-1 pr-10', isDark ? 'border-white/10' : 'border-[var(--ui-border)]', oldChanged && (isDark ? 'bg-red-500/10' : 'bg-red-50'))}>
        {row.oldLine === null ? ' ' : row.oldSpans?.length ? <DiffSpans spans={row.oldSpans} isDark={isDark} /> : row.oldText}
      </div>
      <div className={clsx('py-1', newChanged && (isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'))}><LineNumber value={row.newLine} /></div>
      <div className={clsx('min-w-0 whitespace-pre-wrap break-words px-2 py-1 pr-10', newChanged && (isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'))}>
        {row.newLine === null ? ' ' : row.newSpans?.length ? <DiffSpans spans={row.newSpans} isDark={isDark} /> : row.newText}
      </div>
    </div>
  );
}

function LineNumber({ value }: { value: number | null }) {
  return <span className="select-none pr-2 text-right font-mono text-xs leading-7 tabular-nums text-[var(--ui-text-disabled)]">{value ?? ''}</span>;
}

function DiffSpans({ spans, isDark }: { spans: TextDiffSpan[]; isDark: boolean }) {
  return spans.map((span, index) => {
    if (span.kind === 'added') return <ins key={index} className={clsx('no-underline', isDark ? 'bg-emerald-400/25 text-emerald-100' : 'bg-emerald-200 text-emerald-950')}>{span.value}</ins>;
    if (span.kind === 'removed') return <del key={index} className={clsx('no-underline', isDark ? 'bg-red-400/25 text-red-100' : 'bg-red-200 text-red-950')}>{span.value}</del>;
    return <span key={index}>{span.value}</span>;
  });
}

function DiffCommentCard({
  comment,
  hunkId,
  kind,
  value,
  isDark,
  disabled,
  isMutating,
  onEdit,
  onDelete,
}: {
  comment: ReviewCommentRecord;
  hunkId: string;
  kind: DiffReviewKind;
  value: string;
  isDark: boolean;
  disabled?: boolean;
  isMutating?: boolean;
  onEdit: (next: EditingComment) => void;
  onDelete?: (commentId: string) => Promise<void>;
}) {
  return (
    <div className={clsx('my-3 rounded-md border px-3 py-2.5 font-sans', isDark ? 'border-sky-400/20 bg-sky-400/[0.06]' : 'border-[#cfe0f2] bg-[#f4f8fc]')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <span>审批意见</span>
          <span className="font-normal text-[var(--ui-text-muted)]">{hunkLabel(kind)}</span>
          <span className="font-normal text-[var(--ui-text-muted)]">{comment.status === 'sent' ? (comment.sentMode === 'discuss' ? '已发到会话' : '已发送') : '未发送'}</span>
        </div>
        {!disabled && (
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => onEdit({ hunkId, kind, value, commentId: comment.commentId, body: comment.body })} className="grid h-7 w-7 place-items-center rounded hover:bg-black/5" title="编辑意见"><Pencil className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={() => void onDelete?.(comment.commentId)} disabled={isMutating} className="grid h-7 w-7 place-items-center rounded text-red-500 hover:bg-red-500/10 disabled:opacity-45" title="删除意见"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        )}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-[var(--ui-text-primary)]">{comment.body}</p>
    </div>
  );
}

function DiffCommentEditor({
  editing,
  isDark,
  isMutating,
  localError,
  setEditing,
  setLocalError,
  onSubmit,
}: {
  editing: EditingComment;
  isDark: boolean;
  isMutating?: boolean;
  localError: string;
  setEditing: (next: EditingComment | null) => void;
  setLocalError: (next: string) => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <div className={clsx('my-3 rounded-md border font-sans', isDark ? 'border-white/10 bg-[#17171d]' : 'border-[var(--ui-border-strong)] bg-white')}>
      <div className="flex items-center justify-between border-b border-[var(--ui-border)] px-3 py-2 text-xs font-semibold"><span>审批意见</span><span className="text-[var(--ui-text-disabled)]">{hunkLabel(editing.kind)}</span></div>
      <textarea autoFocus rows={3} maxLength={4000} value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} placeholder="说明这处修改需要如何处理…" className="w-full resize-y border-0 bg-transparent px-3 py-3 text-sm leading-6 outline-none" />
      <div className="flex items-center justify-between border-t border-[var(--ui-border)] px-3 py-2">
        <span className="text-xs text-red-500">{localError}</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setEditing(null); setLocalError(''); }} className="inline-flex h-8 items-center gap-1 rounded px-2 text-xs text-[var(--ui-text-muted)]"><X className="h-3.5 w-3.5" />取消</button>
          <button type="button" disabled={!editing.body.trim() || isMutating} onClick={() => void onSubmit()} className="inline-flex h-8 items-center gap-1 rounded bg-indigo-600 px-3 text-xs text-white disabled:opacity-45">{isMutating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}保存意见</button>
        </div>
      </div>
    </div>
  );
}
