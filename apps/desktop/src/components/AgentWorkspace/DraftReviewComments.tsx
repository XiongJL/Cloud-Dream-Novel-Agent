import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, MessageSquarePlus, Pencil, Trash2, X } from 'lucide-react';
import { clsx } from 'clsx';
import type {
  ReviewCommentAnchor,
  ReviewCommentContext,
  ReviewCommentRecord,
  ReviewCommentSentMode,
} from '../../../shared/reviewComments';
import {
  activeReviewComments,
  pendingReviewComments,
  unresolvedReviewComments,
} from '../../../shared/reviewComments';

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

function splitParagraphs(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [''];
}

export function useReviewComments(context: ReviewCommentContext | null, reviewVersionIds?: string[]) {
  const [comments, setComments] = useState<ReviewCommentRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!context) {
      setComments([]);
      return [];
    }
    setIsLoading(true);
    setError('');
    try {
      const loaded = await window.automation.invoke('review.comment.list', {
        ...(reviewVersionIds?.length
          ? { reviewVersionIds }
          : { reviewVersionId: context.reviewVersionId }),
      }, 'desktop-ui') as ReviewCommentRecord[];
      setComments(loaded);
      return loaded;
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setIsLoading(false);
    }
  }, [context?.reviewVersionId, reviewVersionIds?.join('|')]);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const save = useCallback(async (anchor: ReviewCommentAnchor, body: string, commentId?: string) => {
    if (!context) throw new Error('审核版本不可用');
    setIsMutating(true);
    setError('');
    try {
      const saved = await window.automation.invoke('review.comment.save', {
        ...context,
        commentId,
        anchor,
        body,
      }, 'desktop-ui') as ReviewCommentRecord;
      setComments((current) => [
        ...current.filter((comment) => comment.commentId !== saved.commentId),
        saved,
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
      return saved;
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setIsMutating(false);
    }
  }, [context]);

  const remove = useCallback(async (commentId: string) => {
    setIsMutating(true);
    setError('');
    try {
      await window.automation.invoke('review.comment.delete', { commentId }, 'desktop-ui');
      setComments((current) => current.filter((comment) => comment.commentId !== commentId));
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setIsMutating(false);
    }
  }, []);

  const markSent = useCallback(async (mode: ReviewCommentSentMode) => {
    const candidates = mode === 'regenerate'
      ? unresolvedReviewComments(comments)
      : pendingReviewComments(comments);
    if (!candidates.length) return [];
    setIsMutating(true);
    setError('');
    try {
      const updated = await window.automation.invoke('review.comment.mark_sent', {
        commentIds: candidates.map((comment) => comment.commentId),
        mode,
      }, 'desktop-ui') as ReviewCommentRecord[];
      const updatedById = new Map(updated.map((comment) => [comment.commentId, comment]));
      setComments((current) => current.map((comment) => updatedById.get(comment.commentId) ?? comment));
      return updated;
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setIsMutating(false);
    }
  }, [comments]);

  return {
    comments,
    activeComments: useMemo(() => activeReviewComments(comments), [comments]),
    pendingComments: useMemo(() => pendingReviewComments(comments), [comments]),
    unresolvedComments: useMemo(() => unresolvedReviewComments(comments), [comments]),
    isLoading,
    isMutating,
    error,
    save,
    remove,
    markSent,
    reload,
  };
}

export function ReviewableParagraphs({
  text,
  reviewVersionId,
  comments,
  isDark,
  disabled,
  isMutating,
  onSave,
  onDelete,
}: {
  text: string;
  reviewVersionId: string;
  comments: ReviewCommentRecord[];
  isDark: boolean;
  disabled?: boolean;
  isMutating?: boolean;
  onSave: (anchor: ReviewCommentAnchor, body: string, commentId?: string) => Promise<unknown>;
  onDelete: (commentId: string) => Promise<void>;
}) {
  const paragraphs = useMemo(() => splitParagraphs(text), [text]);
  const [editing, setEditing] = useState<{ paragraphIndex: number; commentId?: string; body: string } | null>(null);
  const [localError, setLocalError] = useState('');

  const commentsByParagraph = useMemo(() => {
    const map = new Map<number, ReviewCommentRecord[]>();
    for (const comment of activeReviewComments(comments)) {
      if (comment.anchor.kind !== 'paragraph' || typeof comment.anchor.paragraphIndex !== 'number') continue;
      const items = map.get(comment.anchor.paragraphIndex) ?? [];
      items.push(comment);
      map.set(comment.anchor.paragraphIndex, items);
    }
    return map;
  }, [comments]);

  const submit = async (paragraphIndex: number, paragraph: string) => {
    if (!editing?.body.trim()) return;
    setLocalError('');
    try {
      await onSave({
        kind: 'paragraph',
        targetId: `${reviewVersionId}:paragraph:${paragraphIndex}`,
        paragraphIndex,
        quote: paragraph.slice(0, 500),
        contentHash: contentFingerprint(paragraph),
      }, editing.body.trim(), editing.commentId);
      setEditing(null);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  return (
    <div className={clsx('min-h-0 flex-1 overflow-y-auto px-5 py-5', isDark ? 'bg-[#111116]' : 'bg-[var(--ui-canvas)]')}>
      <div className="mx-auto max-w-3xl space-y-1">
        {paragraphs.map((paragraph, paragraphIndex) => {
          const paragraphComments = commentsByParagraph.get(paragraphIndex) ?? [];
          const isEditing = editing?.paragraphIndex === paragraphIndex;
          return (
            <section key={`${paragraphIndex}:${paragraph.slice(0, 24)}`} className={clsx('group grid grid-cols-[30px_minmax(0,1fr)] gap-2 rounded-md px-1 py-2', isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-white')}>
              <div className="pt-1">
                {!disabled && !isEditing && (
                  <button
                    type="button"
                    onClick={() => setEditing({ paragraphIndex, body: '' })}
                    className={clsx('grid h-7 w-7 place-items-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100', isDark ? 'bg-white/10 text-neutral-300' : 'border border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-secondary)]')}
                    title="添加审批意见"
                    aria-label={`为第 ${paragraphIndex + 1} 段添加审批意见`}
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="min-w-0">
                <p className={clsx('whitespace-pre-wrap font-serif text-[15px] leading-8', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>
                  {paragraph || '空段落'}
                </p>

                {paragraphComments.map((comment) => (
                  <div key={comment.commentId} className={clsx('mt-3 rounded-md border px-3 py-2.5 font-sans', isDark ? 'border-sky-400/20 bg-sky-400/[0.06]' : 'border-[#cfe0f2] bg-[#f4f8fc]')}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-xs font-semibold">
                        <span>审批意见</span>
                        <span className={clsx('font-normal', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                          {comment.status === 'sent' ? (comment.sentMode === 'discuss' ? '已发到会话' : '已发送') : '未发送'}
                        </span>
                      </div>
                      {!disabled && (
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => setEditing({ paragraphIndex, commentId: comment.commentId, body: comment.body })} className="grid h-7 w-7 place-items-center rounded hover:bg-black/5" title="编辑意见" aria-label="编辑审批意见"><Pencil className="h-3.5 w-3.5" /></button>
                          <button type="button" onClick={() => void onDelete(comment.commentId)} disabled={isMutating} className="grid h-7 w-7 place-items-center rounded text-red-500 hover:bg-red-500/10 disabled:opacity-45" title="删除意见" aria-label="删除审批意见"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      )}
                    </div>
                    <p className={clsx('mt-1.5 whitespace-pre-wrap text-sm leading-6', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-primary)]')}>{comment.body}</p>
                  </div>
                ))}

                {isEditing && (
                  <div className={clsx('mt-3 rounded-md border font-sans', isDark ? 'border-white/10 bg-[#17171d]' : 'border-[var(--ui-border-strong)] bg-white')}>
                    <div className={clsx('flex items-center justify-between border-b px-3 py-2 text-xs font-semibold', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                      <span>审批意见</span>
                      <span className={isDark ? 'text-neutral-500' : 'text-[var(--ui-text-disabled)]'}>本地草稿</span>
                    </div>
                    <textarea
                      autoFocus
                      rows={3}
                      maxLength={4000}
                      value={editing.body}
                      onChange={(event) => setEditing((current) => current ? { ...current, body: event.target.value } : current)}
                      placeholder="要求 Agent 如何重写这一段..."
                      className={clsx('w-full resize-y border-0 bg-transparent px-3 py-3 text-sm leading-6 outline-none', isDark ? 'text-neutral-200 placeholder:text-neutral-600' : 'text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-disabled)]')}
                    />
                    <div className={clsx('flex items-center justify-between border-t px-3 py-2', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                      <span className="text-xs text-red-500">{localError}</span>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => { setEditing(null); setLocalError(''); }} className={clsx('inline-flex h-8 items-center gap-1 rounded px-2 text-xs', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')}><X className="h-3.5 w-3.5" />取消</button>
                        <button type="button" disabled={!editing.body.trim() || isMutating} onClick={() => void submit(paragraphIndex, paragraph)} className={clsx('inline-flex h-8 items-center gap-1 rounded px-3 text-xs text-white disabled:opacity-45', isDark ? 'bg-[#1f2328]' : 'bg-indigo-600')}>
                          {isMutating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}保存意见
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
