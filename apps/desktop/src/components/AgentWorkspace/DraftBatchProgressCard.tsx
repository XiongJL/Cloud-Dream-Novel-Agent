import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Eye,
  ListChecks,
  Loader2,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { ActivityDetail } from '../../../shared/agentActivityProjection';
import type {
  ChapterBeatCheckpointSnapshot,
  DraftBatchConversationState,
  DraftBatchPrimaryView,
} from '../../../shared/agentDraftBatchConversation';
import type { DraftBatchRecord } from '../../../shared/draftBatch';
import { resolveDraftBatchChapterDisplay } from '../../../shared/draftBatchChapterLabel';
import type { ProjectedApprovalRequest } from '../../../shared/agentRunProjection';
import type { Volume } from '../../types';

export type DraftBatchProgressCardDraft = {
  expanded: boolean;
  revision: string;
};

type RevisionItem = {
  id: string;
  title: string;
};

type Props = {
  state: DraftBatchConversationState;
  batch: DraftBatchRecord | null;
  volumes: Volume[];
  runStatus: AgentRunStatus;
  isDark: boolean;
  isWorking: boolean;
  interactive: boolean;
  draft?: DraftBatchProgressCardDraft;
  revisionItems?: RevisionItem[];
  activitySummary?: string;
  activityDetails?: ActivityDetail[];
  onDraftChange: (draft: DraftBatchProgressCardDraft) => void;
  onSubmit: (approval: ProjectedApprovalRequest, selectedOptionIds: string[], freeText: string) => void;
  onDismiss: () => void;
  onOpenSnapshot: (snapshot: ChapterBeatCheckpointSnapshot, historical: boolean) => void;
  onOpenCurrent: (view: Exclude<DraftBatchPrimaryView, 'none' | 'chapter_beat_snapshot'>) => void;
  onRetry: () => void;
};

const CHILD_LABELS: Record<DraftBatchRecord['children'][number]['status'], string> = {
  pending: '待生成',
  generating: '生成中',
  draft: '已生成',
  stale: '已过期',
  failed: '失败',
  committed: '已提交',
  discarded: '已丢弃',
};

function stageCopy(state: DraftBatchConversationState, batch: DraftBatchRecord | null) {
  const { stage, generatedCount, totalCount } = state;
  if (stage === 'awaiting_outline') return {
    title: `章节拍待确认${totalCount ? ` · ${totalCount} 章` : ''}`,
    badge: '待确认',
    summary: '正文尚未生成。确认章节拍后才会开始生成正文。',
    action: '查看章节拍',
  };
  if (stage === 'starting_generation') return {
    title: '节拍已确认 · 正在启动正文生成',
    badge: '排队中',
    summary: `已确认节拍 v${batch?.outline.revision ?? state.beatHistory[0]?.outlineRevision ?? 1}，正文任务正在排队。`,
    action: '查看生成进度',
  };
  if (stage === 'generating' && generatedCount > 0) return {
    title: `已生成 ${generatedCount}/${totalCount} · 继续生成中`,
    badge: '生成中',
    summary: '已有内容可只读查看，其余章节仍在生成。',
    action: '查看已生成内容',
  };
  if (stage === 'generating') return {
    title: `正在生成正文 · 0/${totalCount}`,
    badge: '生成中',
    summary: '正文草稿正在生成中。',
    action: '查看生成进度',
  };
  if (stage === 'interrupted' && generatedCount > 0) return {
    title: `生成未完成 · 已生成 ${generatedCount}/${totalCount}`,
    badge: '未完成',
    summary: '已生成内容仍可查看；后续章节尚未完成。',
    action: '查看已生成内容',
  };
  if (stage === 'interrupted') return {
    title: '章节生成未完成',
    badge: '未完成',
    summary: batch?.children.find((child) => child.error)?.error?.message || '正文尚未生成完成，可查看原因或从现有进度恢复。',
    action: '查看失败原因',
  };
  if (stage === 'ready_for_review') return {
    title: `${totalCount || '多'} 章待审核`,
    badge: '待审核',
    summary: '正文草稿已生成，尚未写回正式章节。',
    action: '打开批次审核',
  };
  if (stage === 'committed') return { title: '多章节草稿已写回', badge: '已完成', summary: '批次正文已经提交到正式章节。', action: '查看已提交内容' };
  if (stage === 'discarded') return { title: '多章节草稿已丢弃', badge: '已丢弃', summary: '该批次已结束，现有记录仅供回看。', action: '查看批次记录' };
  if (stage === 'stale') return { title: '多章节草稿已过期', badge: '已过期', summary: '来源章节或前序草稿已经变化，当前批次仅供回看。', action: '查看批次记录' };
  return {
    title: `正在生成${totalCount ? ` ${totalCount}` : ''} 章节拍`,
    badge: '准备中',
    summary: '正在准备生成前检查点，正文尚未生成。',
    action: '',
  };
}

function statusTone(stage: DraftBatchConversationState['stage'], isDark: boolean): string {
  if (stage === 'interrupted') return isDark ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-700';
  if (stage === 'awaiting_outline') return isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-700';
  if (stage === 'committed' || stage === 'ready_for_review') return isDark ? 'bg-emerald-500/10 text-emerald-300' : 'bg-emerald-50 text-emerald-700';
  return isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]';
}

export function DraftBatchProgressCard({
  state,
  batch,
  volumes,
  runStatus,
  isDark,
  isWorking,
  interactive,
  draft,
  revisionItems = [],
  activitySummary,
  activityDetails = [],
  onDraftChange,
  onSubmit,
  onDismiss,
  onOpenSnapshot,
  onOpenCurrent,
  onRetry,
}: Props) {
  const activeCheckpoint = state.activeCheckpoint;
  const [expanded, setExpanded] = useState(draft?.expanded ?? Boolean(activeCheckpoint));
  const [revision, setRevision] = useState(draft?.revision ?? '');
  const [submitting, setSubmitting] = useState<'approve' | 'revise' | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [revisionItemsExpanded, setRevisionItemsExpanded] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastCheckpointIdRef = useRef<string | null>(activeCheckpoint?.checkpointId ?? null);

  useEffect(() => {
    if (!activeCheckpoint || lastCheckpointIdRef.current === activeCheckpoint.checkpointId) return;
    lastCheckpointIdRef.current = activeCheckpoint.checkpointId;
    setExpanded(true);
    setRevision('');
    setSubmitting(null);
  }, [activeCheckpoint?.checkpointId]);

  useEffect(() => {
    if (!isWorking) setSubmitting(null);
  }, [isWorking]);

  useEffect(() => {
    onDraftChange({ expanded, revision });
  }, [expanded, revision]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 36), 144)}px`;
  }, [revision]);

  const copy = stageCopy(state, batch);
  const canInteract = interactive && Boolean(activeCheckpoint);
  const canRevise = canInteract && activeCheckpoint?.approval.allowFreeText;
  const submitRevision = () => {
    const value = revision.trim();
    if (!activeCheckpoint || !value || !canRevise || isWorking) return;
    setSubmitting('revise');
    onSubmit(activeCheckpoint.approval, [], value);
  };
  const approve = () => {
    if (!activeCheckpoint || !canInteract || isWorking) return;
    setSubmitting('approve');
    onSubmit(activeCheckpoint.approval, ['approve_beats'], '');
  };
  const openPrimaryView = () => {
    if (state.primaryView === 'chapter_beat_snapshot' && activeCheckpoint) {
      onOpenSnapshot(activeCheckpoint, false);
    } else if (state.primaryView !== 'none' && state.primaryView !== 'chapter_beat_snapshot') {
      onOpenCurrent(state.primaryView);
    }
  };
  const showRetry = interactive && runStatus === 'failed' && state.stage === 'interrupted';

  return (
    <section className={clsx('overflow-hidden rounded-lg border shadow-sm', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
      <header className="flex min-h-16 items-center gap-3 px-4 py-3">
        <button type="button" onClick={() => setExpanded((current) => !current)} className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-md', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-subtle)]')} aria-expanded={expanded} aria-label={expanded ? '折叠批次进度' : '展开批次进度'}>
          <ChevronDown className={clsx('h-4 w-4 transition-transform', !expanded && '-rotate-90')} />
        </button>
        <span className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-md', isDark ? 'bg-white/10' : 'bg-[#edf5ff]')}>
          {['preparing_outline', 'starting_generation', 'generating'].includes(state.stage)
            ? <Loader2 className="h-4 w-4 animate-spin text-[#2f80ed] motion-reduce:animate-none" />
            : state.stage === 'interrupted'
              ? <AlertCircle className="h-4 w-4 text-amber-600" />
              : state.stage === 'committed'
                ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                : <ListChecks className="h-4 w-4 text-[#2f80ed]" />}
        </span>
        <button type="button" onClick={() => setExpanded((current) => !current)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{copy.title}</h3>
            <span className={clsx('rounded px-1.5 py-0.5 text-[10px]', statusTone(state.stage, isDark))}>{copy.badge}</span>
          </div>
          <p className={clsx('mt-0.5 line-clamp-2 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{copy.summary}</p>
        </button>
        {copy.action && state.primaryView !== 'none' && (
          <button type="button" onClick={openPrimaryView} className={clsx('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}>
            <Eye className="h-3.5 w-3.5" />{copy.action}
          </button>
        )}
        {canInteract && <button type="button" onClick={onDismiss} disabled={isWorking} className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-md disabled:opacity-40', isDark ? 'text-neutral-500 hover:bg-white/5' : 'text-[var(--ui-text-disabled)] hover:bg-[var(--ui-surface-subtle)]')} aria-label="取消任务"><X className="h-4 w-4" /></button>}
      </header>

      {expanded && (
        <div className={clsx('border-t px-4 pb-4 pt-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          {activeCheckpoint ? (
            <>
              <div className={clsx('divide-y rounded-md border', isDark ? 'divide-white/10 border-white/10' : 'divide-[var(--ui-border)] border-[var(--ui-border)]')}>
                {activeCheckpoint.beats.map((beat, index) => (
                  <div key={beat.beatId || `${activeCheckpoint.checkpointId}:${index}`} className="px-3 py-2.5">
                    <div className="text-sm font-medium">{index + 1}. {beat.title}</div>
                    <div className={clsx('mt-0.5 line-clamp-2 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{beat.chapterGoal}</div>
                  </div>
                ))}
              </div>
              {activeCheckpoint.approval.revisionError && <div className={clsx('mt-3 flex gap-2 rounded-md px-3 py-2 text-xs leading-5', isDark ? 'bg-red-500/10 text-red-200' : 'bg-red-50 text-red-700')}><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{activeCheckpoint.approval.revisionError}</span></div>}
              {canInteract && (
                <div className="mt-3 space-y-2">
                  <button type="button" onClick={approve} disabled={isWorking} className={clsx('inline-flex min-h-10 w-full items-center justify-between rounded-md border px-3 text-left text-sm font-semibold disabled:opacity-50', isDark ? 'border-white/10 hover:bg-white/5' : 'border-[var(--ui-border)] hover:bg-[var(--ui-surface-subtle)]')}>
                    <span>确认并生成</span>
                    {isWorking && submitting === 'approve' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowRight className="h-4 w-4 opacity-50" />}
                  </button>
                  <div className={clsx('flex min-h-11 items-end gap-2 rounded-md border px-3 py-2', canRevise ? (isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]') : 'opacity-70')}>
                    <Pencil className="mb-1.5 h-4 w-4 shrink-0 text-[var(--ui-text-muted)]" />
                    <textarea ref={inputRef} value={revision} onChange={(event) => setRevision(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submitRevision(); } }} rows={1} maxLength={4000} disabled={!canRevise || isWorking} placeholder={canRevise ? (activeCheckpoint.approval.freeTextPlaceholder || '告诉我如何调整这些章节节拍……') : `已达到 ${activeCheckpoint.approval.maxRevisionCount ?? 10} 次调整上限`} aria-label="节拍调整意见" className={clsx('max-h-36 min-h-7 min-w-0 flex-1 resize-none border-0 bg-transparent py-1 text-sm leading-5 outline-none disabled:opacity-60', isDark ? 'placeholder:text-neutral-600' : 'placeholder:text-[var(--ui-text-disabled)]')} />
                    <button type="button" onClick={submitRevision} disabled={!canRevise || isWorking || !revision.trim()} className={clsx('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-semibold disabled:opacity-40', isDark ? 'border-white/15 bg-white/5 text-neutral-200 hover:bg-white/10' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}>
                      {isWorking && submitting === 'revise' && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}提交
                    </button>
                  </div>
                  <p className={clsx('px-1 text-[11px]', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>已调整 {activeCheckpoint.approval.revisionCount ?? 0}/{activeCheckpoint.approval.maxRevisionCount ?? 10} 次</p>
                </div>
              )}
            </>
          ) : batch?.children.length ? (
            <div className="space-y-2">
              {batch.children.map((child) => (
                <div key={child.childIndex} className={clsx('flex items-center gap-3 rounded-md border px-3 py-2.5 text-xs', isDark ? 'border-white/10 bg-white/[0.02]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
                  <span className="w-20 shrink-0 font-semibold">{resolveDraftBatchChapterDisplay(batch, child.childIndex, volumes).shortLabel}</span>
                  <span className="min-w-0 flex-1 truncate" title={child.title}>{child.title}</span>
                  <span className={clsx('shrink-0 rounded px-1.5 py-0.5 text-[10px]', child.status === 'failed' ? 'text-red-600' : child.status === 'generating' ? 'text-[#2f80ed]' : 'text-[var(--ui-text-muted)]')}>{CHILD_LABELS[child.status]}</span>
                </div>
              ))}
            </div>
          ) : null}

          {showRetry && <button type="button" onClick={onRetry} disabled={isWorking} className={clsx('mt-3 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm text-white disabled:opacity-50', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}><RotateCcw className="h-4 w-4" />重试失败步骤</button>}

          {state.beatHistory.length > 0 && (
            <div className={clsx('mt-3 border-t pt-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
              <button type="button" onClick={() => setHistoryExpanded((current) => !current)} className="flex w-full items-center gap-2 text-left text-xs font-medium" aria-expanded={historyExpanded}>
                <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', !historyExpanded && '-rotate-90')} />节拍记录（{state.beatHistory.length}）
              </button>
              {historyExpanded && <div className="mt-2 space-y-1.5">{state.beatHistory.map((snapshot) => (
                <div key={`${snapshot.checkpointId}:${snapshot.outlineRevision}`} className={clsx('flex items-center gap-3 rounded-md px-3 py-2 text-xs', isDark ? 'bg-white/[0.03]' : 'bg-[var(--ui-surface-subtle)]')}>
                  <span className="font-semibold">v{snapshot.outlineRevision}</span><span className="min-w-0 flex-1 text-[var(--ui-text-muted)]">{snapshot.statusLabel}</span>
                  <button type="button" onClick={() => onOpenSnapshot(snapshot, true)} className={clsx('rounded px-2 py-1', isDark ? 'hover:bg-white/5' : 'hover:bg-white')}>查看 v{snapshot.outlineRevision} 节拍</button>
                </div>
              ))}</div>}
            </div>
          )}

          {revisionItems.length > 0 && (
            <div className={clsx('mt-3 border-t pt-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
              <button type="button" onClick={() => setRevisionItemsExpanded((current) => !current)} className="flex w-full items-center gap-2 text-left text-xs font-medium" aria-expanded={revisionItemsExpanded}><ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', !revisionItemsExpanded && '-rotate-90')} />修订建议（{revisionItems.length}）</button>
              {revisionItemsExpanded && <div className="mt-2 space-y-1.5">{revisionItems.map((item, index) => <div key={item.id} className="flex gap-2 px-3 py-1.5 text-xs"><span className="text-[var(--ui-text-muted)]">{index + 1}.</span><span>{item.title}</span></div>)}</div>}
            </div>
          )}

          {activityDetails.length > 0 && (
            <div className={clsx('mt-3 border-t pt-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
              <button type="button" onClick={() => setActivityExpanded((current) => !current)} className="flex w-full items-center gap-2 text-left text-xs font-medium" aria-expanded={activityExpanded}><ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', !activityExpanded && '-rotate-90')} />活动详情<span className="text-[var(--ui-text-muted)]">{activitySummary}</span></button>
              {activityExpanded && <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">{activityDetails.map((detail) => <div key={detail.eventId} className={clsx('rounded-md px-3 py-2 text-xs', isDark ? 'bg-white/[0.03]' : 'bg-[var(--ui-surface-subtle)]')}><div className="font-medium">{detail.title}</div>{detail.summary && <div className="mt-1 leading-5 text-[var(--ui-text-muted)]">{detail.summary}</div>}</div>)}</div>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
