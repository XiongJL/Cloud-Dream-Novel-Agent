import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import type { CreativeAssetsDraft, DraftSelection } from '../AIWorkbench/types';
import type { ReviewCommentAnchor, ReviewCommentRecord } from '../../../shared/reviewComments';
import { DraftMoreMenu } from './DraftMoreMenu';
import type { useReviewComments } from './DraftReviewComments';
import { ReviewSubmitDialog } from './ReviewSubmitDialog';

type ReviewCommentsController = ReturnType<typeof useReviewComments>;
type CreativeSection = keyof DraftSelection;

const SECTIONS: Array<{ id: CreativeSection; label: string; singular: string }> = [
  { id: 'plotLines', label: '情节线', singular: '情节线' },
  { id: 'plotPoints', label: '情节点', singular: '情节点' },
  { id: 'characters', label: '角色', singular: '角色' },
  { id: 'items', label: '物品与设定', singular: '物品' },
  { id: 'skills', label: '技能', singular: '技能' },
  { id: 'worldSettings', label: '世界设定', singular: '设定' },
  { id: 'maps', label: '地图与地点', singular: '地图' },
];

const FIELD_LABELS: Record<string, string> = {
  description: '说明',
  role: '定位',
  type: '类型',
  status: '状态',
  plotLineName: '所属情节线',
  color: '颜色',
  imagePrompt: '画面描述',
  imageUrl: '图片地址',
  content: '内容',
  icon: '图标',
};

function normalizeDraft(input: unknown): CreativeAssetsDraft {
  const value = input && typeof input === 'object' ? input as CreativeAssetsDraft : {};
  return Object.fromEntries(SECTIONS.map(({ id }) => [id, Array.isArray(value[id]) ? value[id] : []])) as CreativeAssetsDraft;
}

function selectWholePackage(draft: CreativeAssetsDraft): DraftSelection {
  return Object.fromEntries(SECTIONS.map(({ id }) => [id, (draft[id] ?? []).map(() => true)])) as DraftSelection;
}

function itemTitle(item: Record<string, unknown>, fallback: string): string {
  return String(item.name || item.title || fallback).trim() || fallback;
}

function itemDetails(item: Record<string, unknown>): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(item)) {
    if (['name', 'title', 'imageBase64', 'mimeType', 'points'].includes(key) || value === null || value === undefined || value === '') continue;
    if (key === 'profile' && typeof value === 'object' && !Array.isArray(value)) {
      for (const [profileKey, profileValue] of Object.entries(value as Record<string, unknown>)) {
        if (String(profileValue || '').trim()) rows.push({ label: profileKey, value: String(profileValue) });
      }
      continue;
    }
    if (Array.isArray(value)) {
      const text = value.map((entry) => typeof entry === 'object' ? JSON.stringify(entry) : String(entry)).join('；');
      if (text) rows.push({ label: FIELD_LABELS[key] || key, value: text });
      continue;
    }
    if (typeof value !== 'object') rows.push({ label: FIELD_LABELS[key] || key, value: String(value) });
  }
  return rows;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '操作失败');
}

export function CreativeAssetsReviewPanel({
  isDark,
  session,
  reviewComments,
  onSessionChange,
  onArtifactStatusChange,
  onDiscuss,
  onRegenerate,
}: {
  isDark: boolean;
  session: DraftSessionRecord;
  reviewComments: ReviewCommentsController;
  onSessionChange: (session: DraftSessionRecord) => void;
  onArtifactStatusChange: (draftSessionId: string, status: AgentArtifact['status']) => void;
  onDiscuss: (comments: ReviewCommentRecord[]) => Promise<void>;
  onRegenerate: (session: DraftSessionRecord, comments: ReviewCommentRecord[]) => Promise<void>;
}) {
  const draft = useMemo(() => normalizeDraft(session.payload), [session.payload]);
  const [expandedSections, setExpandedSections] = useState<Set<CreativeSection>>(() => new Set(SECTIONS.map((section) => section.id)));
  const [editing, setEditing] = useState<{ targetId: string; anchor: ReviewCommentAnchor; body: string; commentId?: string } | null>(null);
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState('');
  const [validationErrors, setValidationErrors] = useState<Array<{ scope?: string; name?: string; detail?: string }>>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const isDraft = session.status === 'draft';
  const blockingComments = isDraft ? reviewComments.activeComments : [];
  const latestWriteback = useMemo(
    () => [...(session.writebacks ?? [])].reverse().find((item) => item.status === 'committed' && item.mode === 'creative_assets') ?? null,
    [session.writebacks],
  );
  const totalItems = SECTIONS.reduce((total, section) => total + (draft[section.id]?.length ?? 0), 0);
  const commentsByTarget = useMemo(() => {
    const map = new Map<string, ReviewCommentRecord[]>();
    for (const comment of reviewComments.activeComments) {
      const items = map.get(comment.anchor.targetId) ?? [];
      items.push(comment);
      map.set(comment.anchor.targetId, items);
    }
    return map;
  }, [reviewComments.activeComments]);

  const submitComment = async () => {
    if (!editing?.body.trim()) return;
    try {
      await reviewComments.save(editing.anchor, editing.body.trim(), editing.commentId);
      setEditing(null);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  const handleCommit = async () => {
    if (!isDraft || blockingComments.length > 0) return;
    setIsMutating(true);
    setError('');
    setValidationErrors([]);
    setWarnings([]);
    try {
      const synced = await window.automation.invoke('draft.update', {
        draftSessionId: session.draftSessionId,
        version: session.version,
        payload: draft,
        selection: selectWholePackage(draft),
      }, 'desktop-ui') as DraftSessionRecord;
      const response = await window.automation.invoke('draft.commit', {
        draftSessionId: synced.draftSessionId,
        version: synced.version,
      }, 'desktop-ui') as {
        session: DraftSessionRecord;
        validation?: { ok: boolean; errors: Array<{ scope?: string; name?: string; detail?: string }>; warnings: string[] };
        confirmResult?: { success: boolean; created: Record<string, number>; warnings: string[]; errors?: Array<{ scope?: string; name?: string; detail?: string }> };
      };
      setValidationErrors(response.validation?.errors ?? response.confirmResult?.errors ?? []);
      setWarnings(response.validation?.warnings ?? response.confirmResult?.warnings ?? []);
      onSessionChange(response.session);
      if (!response.confirmResult?.success) {
        if (response.session.status === 'failed') onArtifactStatusChange(session.draftSessionId, 'failed');
        throw new Error('素材包校验或入库失败，请处理提示后重试。');
      }
      onArtifactStatusChange(session.draftSessionId, 'committed');
      const created = response.confirmResult.created;
      window.dispatchEvent(new CustomEvent('creative-assets-persisted', { detail: { novelId: session.novelId, created } }));
      if ((created.characters || 0) + (created.items || 0) + (created.skills || 0) + (created.worldSettings || 0) > 0) {
        window.dispatchEvent(new CustomEvent('world-assets-updated', { detail: { novelId: session.novelId } }));
      }
      if ((created.maps || 0) + (created.mapImages || 0) > 0) {
        window.dispatchEvent(new CustomEvent('map-assets-updated', { detail: { novelId: session.novelId } }));
      }
      if ((created.plotLines || 0) + (created.plotPoints || 0) > 0) window.dispatchEvent(new Event('plot-update'));
      toast.success('创作素材审核包已整体入库');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleDiscard = async () => {
    if (!isDraft || !window.confirm('确定丢弃整个创作素材审核包吗？')) return;
    setIsMutating(true);
    setError('');
    try {
      const discarded = await window.automation.invoke('draft.discard', {
        draftSessionId: session.draftSessionId,
        version: session.version,
      }, 'desktop-ui') as DraftSessionRecord;
      onSessionChange(discarded);
      onArtifactStatusChange(session.draftSessionId, 'discarded');
      toast.success('创作素材审核包已丢弃');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleUndo = async () => {
    if (!latestWriteback) return;
    setIsMutating(true);
    setError('');
    try {
      const response = await window.automation.invoke('draft.undo', {
        draftSessionId: session.draftSessionId,
        version: session.version,
        writebackId: latestWriteback.writebackId,
      }, 'desktop-ui') as { session: DraftSessionRecord };
      onSessionChange(response.session);
      onArtifactStatusChange(session.draftSessionId, 'ready');
      window.dispatchEvent(new CustomEvent('creative-assets-persisted', { detail: { novelId: session.novelId, undone: true } }));
      window.dispatchEvent(new CustomEvent('world-assets-updated', { detail: { novelId: session.novelId, undone: true } }));
      window.dispatchEvent(new CustomEvent('map-assets-updated', { detail: { novelId: session.novelId, undone: true } }));
      window.dispatchEvent(new Event('plot-update'));
      toast.success('已撤销本次素材整包入库');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleDiscuss = async () => {
    if (!reviewComments.pendingComments.length) return;
    setIsMutating(true);
    setError('');
    try {
      await onDiscuss(reviewComments.pendingComments);
      await reviewComments.markSent('discuss');
      setSubmitDialogOpen(false);
      toast.success('素材审批意见已发送到来源会话');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleRegenerate = async () => {
    if (!blockingComments.length) return;
    setIsMutating(true);
    setError('');
    try {
      await onRegenerate(session, blockingComments);
      await reviewComments.markSent('regenerate');
      setSubmitDialogOpen(false);
      toast.success('已开始生成新的创作素材审核包');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const statusLabel = session.status === 'committed' ? '已入库'
    : session.status === 'discarded' ? '已丢弃'
      : session.status === 'stale' ? '历史版本'
        : session.status === 'failed' ? '失败'
          : '待审核';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={clsx('shrink-0 border-b px-5 py-4', isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">创作素材审核包</h2>
              <span className={clsx('rounded px-2 py-0.5 text-[11px]', isDraft ? 'bg-[#e8f2ff] text-[#2f80ed]' : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>{statusLabel}</span>
            </div>
            <div className={clsx('mt-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
              共 {totalItems} 条素材 · 无审批意见的条目默认认可 · 入库时整包提交
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SECTIONS.filter((section) => (draft[section.id]?.length ?? 0) > 0).map((section) => (
              <span key={section.id} className={clsx('rounded px-2 py-1 text-[11px]', isDark ? 'bg-white/5 text-neutral-400' : 'bg-white text-[var(--ui-text-muted)]')}>{section.label} {draft[section.id]?.length ?? 0}</span>
            ))}
          </div>
        </div>
        {(error || reviewComments.error) && <div className={clsx('mt-3 rounded-md px-3 py-2 text-xs', isDark ? 'bg-red-500/10 text-red-200' : 'bg-red-50 text-red-700')}>{error || reviewComments.error}</div>}
        {validationErrors.length > 0 && (
          <div className={clsx('mt-3 rounded-md px-3 py-2 text-xs leading-5', isDark ? 'bg-red-500/10 text-red-200' : 'bg-red-50 text-red-700')}>
            {validationErrors.map((issue, index) => <div key={`${issue.scope}-${issue.name}-${index}`}>{issue.scope ? `${issue.scope} · ` : ''}{issue.name ? `${issue.name}：` : ''}{issue.detail || '校验失败'}</div>)}
          </div>
        )}
        {warnings.length > 0 && <div className={clsx('mt-3 rounded-md px-3 py-2 text-xs leading-5', isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-[#fff6df] text-[#76520b]')}>{warnings.join('；')}</div>}
      </div>

      <div className={clsx('min-h-0 flex-1 overflow-y-auto px-5 py-4', isDark ? 'bg-[#111116]' : 'bg-[var(--ui-canvas)]')}>
        <div className="mx-auto max-w-4xl space-y-3">
          {SECTIONS.map((section) => {
            const items = (draft[section.id] ?? []) as Array<Record<string, unknown>>;
            if (!items.length) return null;
            const expanded = expandedSections.has(section.id);
            return (
              <section key={section.id} className={clsx('border-b pb-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                <button type="button" onClick={() => setExpandedSections((current) => {
                  const next = new Set(current);
                  if (next.has(section.id)) next.delete(section.id); else next.add(section.id);
                  return next;
                })} className="flex w-full items-center justify-between py-2 text-left">
                  <span className="text-sm font-semibold">{section.label} <span className={clsx('ml-1 font-normal', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{items.length}</span></span>
                  <ChevronDown className={clsx('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
                </button>
                {expanded && <div className="space-y-2 pt-1">
                  {items.map((item, index) => {
                    const title = itemTitle(item, `${section.singular} ${index + 1}`);
                    const details = itemDetails(item);
                    const targetId = `${session.draftSessionId}:${section.id}:${index}`;
                    const itemComments = commentsByTarget.get(targetId) ?? [];
                    const isEditing = editing?.targetId === targetId;
                    const quote = [title, ...details.slice(0, 2).map((row) => `${row.label}：${row.value}`)].join('；').slice(0, 500);
                    return (
                      <article key={targetId} className={clsx('group border px-4 py-3', isDark ? 'border-white/10 bg-white/[0.02]' : 'border-[var(--ui-border)] bg-white')}>
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold">{title}</div>
                            {details.length > 0 && <dl className="mt-2 grid gap-x-5 gap-y-1 text-xs leading-5 sm:grid-cols-2">
                              {details.map((row, rowIndex) => <div key={`${row.label}-${rowIndex}`} className="min-w-0"><dt className={clsx('inline', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{row.label}：</dt><dd className="inline whitespace-pre-wrap break-words">{row.value}</dd></div>)}
                            </dl>}
                          </div>
                          {isDraft && !isEditing && <button type="button" onClick={() => setEditing({ targetId, anchor: { kind: 'asset_item', targetId, fieldPath: `${section.id}.${index}`, quote }, body: '' })} className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded opacity-70 hover:opacity-100', isDark ? 'bg-white/10 text-neutral-300' : 'border border-[var(--ui-border-strong)] text-[var(--ui-text-secondary)]')} title="添加审批意见" aria-label={`为${title}添加审批意见`}><MessageSquarePlus className="h-4 w-4" /></button>}
                        </div>

                        {itemComments.map((comment) => <div key={comment.commentId} className={clsx('mt-3 border-l-2 pl-3', isDark ? 'border-sky-400/40' : 'border-[#9dbbd8]')}>
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-xs font-semibold">审批意见 <span className={clsx('ml-1 font-normal', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{comment.status === 'sent' ? (comment.sentMode === 'discuss' ? '已发到会话' : '已发送') : '未发送'}</span></div>
                            {isDraft && <div className="flex gap-1">
                              <button type="button" onClick={() => setEditing({ targetId, anchor: comment.anchor, body: comment.body, commentId: comment.commentId })} className="grid h-7 w-7 place-items-center rounded hover:bg-black/5" title="编辑意见" aria-label="编辑审批意见"><Pencil className="h-3.5 w-3.5" /></button>
                              <button type="button" onClick={() => void reviewComments.remove(comment.commentId)} disabled={reviewComments.isMutating} className="grid h-7 w-7 place-items-center rounded text-red-500 hover:bg-red-500/10 disabled:opacity-45" title="删除意见" aria-label="删除审批意见"><Trash2 className="h-3.5 w-3.5" /></button>
                            </div>}
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{comment.body}</p>
                        </div>)}

                        {isEditing && <div className={clsx('mt-3 border-t pt-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                          <textarea autoFocus rows={3} maxLength={4000} value={editing.body} onChange={(event) => setEditing((current) => current ? { ...current, body: event.target.value } : current)} placeholder="要求 Agent 如何调整这条素材..." className={clsx('w-full resize-y rounded-md border px-3 py-2 text-sm leading-6 outline-none', isDark ? 'border-white/10 bg-black/20 text-neutral-200' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')} />
                          <div className="mt-2 flex justify-end gap-2">
                            <button type="button" onClick={() => setEditing(null)} className={clsx('inline-flex h-8 items-center gap-1 rounded px-2 text-xs', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')}><X className="h-3.5 w-3.5" />取消</button>
                            <button type="button" disabled={!editing.body.trim() || reviewComments.isMutating} onClick={() => void submitComment()} className={clsx('inline-flex h-8 items-center gap-1 rounded px-3 text-xs text-white disabled:opacity-45', isDark ? 'bg-[#1f2328]' : 'bg-indigo-600')}>{reviewComments.isMutating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}保存意见</button>
                          </div>
                        </div>}
                      </article>
                    );
                  })}
                </div>}
              </section>
            );
          })}
          {totalItems === 0 && <div className="py-16 text-center"><AlertCircle className="mx-auto h-6 w-6 text-amber-500" /><p className="mt-3 text-sm text-[var(--ui-text-muted)]">当前素材审核包没有可审核条目。</p></div>}
        </div>
      </div>

      <div className={clsx('flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3', isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
        <div className={clsx('min-w-[220px] flex-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
          {!isDraft
            ? latestWriteback
              ? '素材包已入库，可撤销本次操作；若素材已被修改或建立关联，撤销会被拒绝'
              : `该素材包${statusLabel}`
            : blockingComments.length > 0
            ? reviewComments.pendingComments.length > 0
              ? `有 ${reviewComments.pendingComments.length} 条审批意见待发送，处理前不能入库`
              : blockingComments.some((comment) => comment.sentMode === 'regenerate')
                ? `已发送 ${blockingComments.length} 条审批意见，等待新版本；生成失败时可用原意见重试`
                : `有 ${blockingComments.length} 条意见已发到会话，需重新生成或调整后才能入库`
            : '当前素材包可整体入库；不会按类型或条目部分提交'}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <DraftMoreMenu isDark={isDark} disabled={!isDraft || isMutating} discardLabel="丢弃整个素材包" onDiscard={() => void handleDiscard()} />
          {latestWriteback && <button type="button" disabled={isMutating} onClick={() => void handleUndo()} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-white/10 text-neutral-200' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}><Undo2 className="h-4 w-4" />撤销整包入库</button>}
          {isDraft && blockingComments.length > 0 && <button type="button" disabled={isMutating || reviewComments.isMutating} onClick={() => setSubmitDialogOpen(true)} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-sky-400/30 text-sky-200' : 'border-[#9dbbd8] bg-white text-[#355b7d]')}><Send className="h-4 w-4" />{reviewComments.pendingComments.length > 0 ? '发送意见' : '处理意见'} ({blockingComments.length})</button>}
          <button type="button" disabled={!isDraft || totalItems === 0 || isMutating || blockingComments.length > 0} onClick={() => void handleCommit()} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-sm text-white disabled:opacity-45', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}>{isMutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}整包入库</button>
        </div>
      </div>

      <ReviewSubmitDialog
        open={submitDialogOpen}
        comments={blockingComments}
        isDark={isDark}
        isSubmitting={isMutating || reviewComments.isMutating}
        discussDisabled={reviewComments.pendingComments.length === 0}
        onClose={() => setSubmitDialogOpen(false)}
        onDiscuss={() => void handleDiscuss()}
        onRegenerate={() => void handleRegenerate()}
      />
    </div>
  );
}
