import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { Loader2, MessageSquare, RefreshCw, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { ReviewCommentRecord } from '../../../shared/reviewComments';

export function ReviewSubmitDialog({
  open,
  comments,
  isDark,
  isSubmitting,
  isBatch,
  regenerateDisabled,
  regenerateDisabledReason,
  discussDisabled,
  onClose,
  onDiscuss,
  onRegenerate,
}: {
  open: boolean;
  comments: ReviewCommentRecord[];
  isDark: boolean;
  isSubmitting: boolean;
  isBatch?: boolean;
  regenerateDisabled?: boolean;
  regenerateDisabledReason?: string;
  discussDisabled?: boolean;
  onClose: () => void;
  onDiscuss: () => void;
  onRegenerate: (scope: 'commented_items' | 'from_earliest_chapter') => void;
}) {
  return (
    <Dialog open={open} onClose={isSubmitting ? () => undefined : onClose} className="relative z-[120]">
      <DialogBackdrop className="fixed inset-0 bg-black/45" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className={clsx('flex max-h-[min(720px,calc(100vh-32px))] w-full max-w-xl flex-col overflow-hidden rounded-lg border shadow-2xl', isDark ? 'border-white/10 bg-[#17171d] text-white' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-primary)]')}>
          <div className={clsx('flex items-start justify-between gap-4 border-b px-5 py-4', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
            <div>
              <DialogTitle className="text-base font-semibold">发送审批意见给 Agent</DialogTitle>
              <p className={clsx('mt-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>共 {comments.length} 条，来自 {new Set(comments.map((comment) => comment.reviewVersionId)).size} 个审核版本</p>
            </div>
            <button type="button" onClick={onClose} disabled={isSubmitting} className="grid h-8 w-8 place-items-center rounded hover:bg-black/5 disabled:opacity-45" title="关闭" aria-label="关闭发送面板"><X className="h-4 w-4" /></button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="space-y-2">
              {comments.map((comment, index) => (
                <div key={comment.commentId} className={clsx('rounded-md border px-3 py-2.5', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
                  <div className={clsx('text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                    {typeof comment.anchor.paragraphIndex === 'number' ? `第 ${comment.anchor.paragraphIndex + 1} 段` : `意见 ${index + 1}`}
                    {typeof comment.childIndex === 'number' ? ` · 批次第 ${comment.childIndex + 1} 章` : ''}
                    {comment.sentMode === 'discuss' ? ' · 已发到会话' : ''}
                  </div>
                  {comment.anchor.quote && <div className={clsx('mt-1 line-clamp-2 font-serif text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{comment.anchor.quote}</div>}
                  <div className="mt-1.5 text-sm leading-6">{comment.body}</div>
                </div>
              ))}
            </div>

            {isBatch && (
              <div className={clsx('mt-4 rounded-md border px-3 py-3 text-xs leading-5', isDark ? 'border-amber-400/20 bg-amber-400/[0.06] text-amber-200' : 'border-[#ead9b8] bg-[#fff9ed] text-[#7a5413]')}>
                当前版本将从最早出现审批意见的章节开始重新生成，后续依赖章节会进入新版本。仅重写有意见章节需要连续性复核能力，当前暂不开放。
              </div>
            )}
            {regenerateDisabledReason && (
              <div className={clsx('mt-4 rounded-md border px-3 py-3 text-xs leading-5', isDark ? 'border-sky-400/20 bg-sky-400/[0.06] text-sky-200' : 'border-[#cfe0f2] bg-[#f4f8fc] text-[#355b7d]')}>
                {regenerateDisabledReason}
              </div>
            )}
          </div>

          <div className={clsx('flex flex-wrap items-center justify-end gap-2 border-t px-5 py-4', isDark ? 'border-white/10 bg-black/10' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
            <button type="button" onClick={onClose} disabled={isSubmitting} className={clsx('h-9 rounded-md px-3 text-sm disabled:opacity-45', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white')}>取消</button>
            <button type="button" onClick={onDiscuss} disabled={isSubmitting || discussDisabled} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-white/10 text-neutral-300' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}><MessageSquare className="h-4 w-4" />只发到会话讨论</button>
            <button type="button" onClick={() => onRegenerate(isBatch ? 'from_earliest_chapter' : 'commented_items')} disabled={isSubmitting || regenerateDisabled} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-sm text-white disabled:opacity-45', isDark ? 'bg-[#1f2328]' : 'bg-indigo-600')}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}开始重新生成
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
