import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  FileDiff,
  FileText,
  ListChecks,
  Loader2,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import type { Volume } from '../../types';
import type {
  DraftBatchInsertionMode,
  DraftBatchRecord,
} from '../../../shared/draftBatch';
import { resolveDraftBatchChapterDisplay } from '../../../shared/draftBatchChapterLabel';
import { projectDraftBatchReview } from '../../../shared/draftBatchReview';
import {
  appendPlainTextToLexical,
  createLexicalDocumentFromPlainText,
  extractReadableText,
  normalizeChapterDraftText,
  restoreReadableTextStructure,
} from '../../../shared/lexicalDocument';
import { DraftDiffView } from './DraftDiffView';
import { DraftMoreMenu } from './DraftMoreMenu';
import { useReviewComments } from './DraftReviewComments';
import { ReviewSubmitDialog } from './ReviewSubmitDialog';
import { ChapterBeatPreviewPanel } from './ChapterBeatPreviewPanel';
import type { ReviewCommentContext, ReviewCommentRecord } from '../../../shared/reviewComments';

type Props = {
  isDark: boolean;
  draftBatchId: string;
  mode: 'progress' | 'interrupted' | 'review';
  reviewContext: Pick<ReviewCommentContext, 'novelId' | 'sourceConversationId' | 'sourceRunId' | 'sourceArtifactId'>;
  volumes: Volume[];
  onBatchStatusChange: (draftBatchId: string, status: AgentArtifact['status']) => void;
  onRegenerate: (batch: DraftBatchRecord, fromChildIndex: number, comments?: ReviewCommentRecord[]) => Promise<void>;
  onDiscuss: (comments: ReviewCommentRecord[]) => Promise<void>;
  onBatchLoaded?: (batch: DraftBatchRecord) => void;
};

const CHILD_STATUS_LABELS: Record<DraftBatchRecord['children'][number]['status'], string> = {
  pending: '待生成',
  generating: '生成中',
  draft: '待审核',
  stale: '已过期',
  failed: '失败',
  committed: '已提交',
  discarded: '已丢弃',
};

const BATCH_STATUS_LABELS: Record<DraftBatchRecord['status'], string> = {
  outline_draft: '节拍待确认',
  ready_to_generate: '待生成',
  generating: '生成中',
  ready_for_review: '待审核',
  partially_failed: '部分失败',
  stale: '存在过期草稿',
  committed: '已提交',
  discarded: '已丢弃',
  failed: '失败',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '操作失败');
}

function childStatusTone(status: DraftBatchRecord['children'][number]['status'], isDark: boolean): string {
  if (status === 'committed') return 'bg-emerald-50 text-emerald-700';
  if (status === 'draft') return 'bg-[#e8f2ff] text-[#2f80ed]';
  if (status === 'failed' || status === 'stale') return 'bg-red-50 text-red-700';
  if (status === 'generating') return 'bg-amber-50 text-amber-700';
  return isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]';
}

export function DraftBatchReviewPanel({
  isDark,
  draftBatchId,
  mode,
  reviewContext,
  volumes,
  onBatchStatusChange,
  onRegenerate,
  onDiscuss,
  onBatchLoaded,
}: Props) {
  const [batch, setBatch] = useState<DraftBatchRecord | null>(null);
  const [sessions, setSessions] = useState<Record<number, DraftSessionRecord>>({});
  const [sourceChapterContent, setSourceChapterContent] = useState<Record<number, string>>({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [generatedText, setGeneratedText] = useState('');
  const [reviewMode, setReviewMode] = useState<'diff' | 'original' | 'draft'>('diff');
  const [commitPrefix, setCommitPrefix] = useState(1);
  const [insertionMode, setInsertionMode] = useState<DraftBatchInsertionMode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState('');
  const [showBeat, setShowBeat] = useState(false);
  const [reconciliation, setReconciliation] = useState<AgentSideEffectInspection | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [confirmAbsent, setConfirmAbsent] = useState(false);
  const [reconciliationNote, setReconciliationNote] = useState('');
  const [isInspecting, setIsInspecting] = useState(false);
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
  const reviewInteractive = mode === 'review';

  const loadBatch = useCallback(async () => {
    const nextBatch = await window.automation.invoke('draft.batch.get', { draftBatchId }, 'desktop-ui') as DraftBatchRecord | null;
    if (!nextBatch) throw new Error('草稿批次不存在或已经被清理。');
    const [loadedSessions, loadedSourceChapters] = await Promise.all([
      Promise.all(nextBatch.children.map(async (child) => {
      if (!child.draftSessionId) return null;
      const session = await window.automation.invoke('draft.get', { draftSessionId: child.draftSessionId }, 'desktop-ui') as DraftSessionRecord | null;
      return session && typeof session.childIndex === 'number' ? session : null;
      })),
      Promise.all(nextBatch.children.map(async (child) => {
        if (nextBatch.mode !== 'batch_rewrite' || !child.targetChapterId) return null;
        try {
          const chapter = await window.db.getChapter(child.targetChapterId);
          return chapter ? [child.childIndex, chapter.content] as const : null;
        } catch {
          return null;
        }
      })),
    ]);
    const sessionMap = Object.fromEntries(
      loadedSessions.flatMap((session) => session ? [[session.childIndex as number, session]] : []),
    );
    setBatch(nextBatch);
    onBatchLoaded?.(nextBatch);
    setSessions(sessionMap);
    setSourceChapterContent(Object.fromEntries(
      loadedSourceChapters.flatMap((entry) => entry ? [entry] : []),
    ));
    setSelectedIndex((current) => (
      nextBatch.children[current]
        ? current
        : nextBatch.children.find((child) => child.status === 'draft')?.childIndex ?? 0
    ));
    return { batch: nextBatch, sessions: sessionMap };
  }, [draftBatchId, onBatchLoaded]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError('');
    void loadBatch()
      .catch((nextError) => {
        if (!cancelled) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [loadBatch]);

  useEffect(() => {
    if (!batch || !['outline_draft', 'ready_to_generate', 'generating'].includes(batch.status)) return undefined;
    const intervalId = window.setInterval(() => {
      void loadBatch().catch((nextError) => setError(errorMessage(nextError)));
    }, 1500);
    return () => window.clearInterval(intervalId);
  }, [batch?.status, loadBatch]);

  const projection = useMemo(() => batch ? projectDraftBatchReview(batch) : null, [batch]);
  const chapterDisplay = useCallback((childIndex: number) => (
    batch
      ? resolveDraftBatchChapterDisplay(batch, childIndex, volumes)
      : { shortLabel: `批次第 ${childIndex + 1} 项`, fullLabel: `批次第 ${childIndex + 1} 项`, source: 'batch' as const }
  ), [batch, volumes]);
  const selectedChild = batch?.children[selectedIndex] ?? null;
  const selectedChapterDisplay = chapterDisplay(selectedIndex);
  const selectedSession = sessions[selectedIndex] ?? null;
  const chapterPayload = selectedSession?.type === 'chapter-draft'
    ? selectedSession.payload as ChapterDraftPayload
    : null;
  const selectedBeat = batch?.outline.beats[selectedIndex] ?? null;
  const selectedHasDraft = Boolean(selectedSession && chapterPayload);
  const hasAnyDraft = Object.keys(sessions).length > 0;
  const reviewVersionIds = useMemo(
    () => Object.values(sessions).map((session) => session.draftSessionId),
    [sessions],
  );
  const selectedReviewContext: ReviewCommentContext | null = selectedSession ? {
    ...reviewContext,
    reviewVersionId: selectedSession.draftSessionId,
    draftSessionId: selectedSession.draftSessionId,
    draftBatchId,
    childIndex: selectedIndex,
  } : null;
  const reviewComments = useReviewComments(selectedReviewContext, reviewVersionIds);
  const selectedReviewComments = useMemo(
    () => reviewComments.comments.filter((comment) => comment.reviewVersionId === selectedSession?.draftSessionId),
    [reviewComments.comments, selectedSession?.draftSessionId],
  );
  const originalText = useMemo(
    () => restoreReadableTextStructure(
      chapterPayload?.baseContent ?? '',
      sourceChapterContent[selectedIndex] ?? '',
    ),
    [chapterPayload?.baseContent, selectedIndex, sourceChapterContent],
  );
  const normalizedContent = useMemo(
    () => chapterPayload
      ? batch?.mode === 'batch_rewrite'
        ? createLexicalDocumentFromPlainText(generatedText)
        : appendPlainTextToLexical(chapterPayload.baseContent, generatedText)
      : '',
    [batch?.mode, chapterPayload, generatedText],
  );
  const draftText = useMemo(
    () => batch?.mode === 'batch_rewrite' ? generatedText : extractReadableText(normalizedContent),
    [batch?.mode, generatedText, normalizedContent],
  );
  const isDirty = Boolean(chapterPayload && (
    generatedText !== chapterPayload.generatedText
    || normalizedContent !== chapterPayload.content
  ));

  useEffect(() => {
    let cancelled = false;
    if (!selectedChild?.error?.sideEffectUnknown) {
      setReconciliation(null);
      setSelectedCandidateId('');
      setConfirmAbsent(false);
      setReconciliationNote('');
      return () => { cancelled = true; };
    }
    setIsInspecting(true);
    setError('');
    void window.agent.inspectSideEffect({
      draftBatchId,
      childIndex: selectedChild.childIndex,
      generationRevision: selectedChild.generationRevision,
      invocationKey: selectedChild.reconciliation?.invocationKey ?? selectedChild.error.invocationKey,
    }).then((inspection) => {
      if (cancelled) return;
      setReconciliation(inspection);
      setSelectedCandidateId(inspection.candidates.length === 1 ? inspection.candidates[0].draftSessionId : '');
    }).catch((nextError) => {
      if (!cancelled) setError(errorMessage(nextError));
    }).finally(() => {
      if (!cancelled) setIsInspecting(false);
    });
    return () => { cancelled = true; };
  }, [draftBatchId, selectedChild?.childIndex, selectedChild?.generationRevision, selectedChild?.error?.sideEffectUnknown]);

  useEffect(() => {
    const chapterTitle = selectedBeat?.title || selectedChild?.title || '';
    setGeneratedText(normalizeChapterDraftText(chapterPayload?.generatedText ?? '', chapterTitle));
  }, [chapterPayload?.generatedText, selectedBeat?.title, selectedChild?.title, selectedIndex]);

  useEffect(() => {
    if (!projection) return;
    setCommitPrefix((current) => {
      const minimum = projection.committedPrefixLength + 1;
      if (!projection.canCommit) return projection.committedPrefixLength;
      return Math.min(Math.max(current, minimum), projection.reviewablePrefixLength);
    });
  }, [projection]);

  const anchorVolume = useMemo(
    () => volumes.find((volume) => volume.id === batch?.volumeId),
    [batch?.volumeId, volumes],
  );
  const anchorIsVolumeEnd = Boolean(
    batch
    && anchorVolume?.chapters[anchorVolume.chapters.length - 1]?.id === batch.anchorChapterId,
  );
  const needsInsertionConfirmation = batch?.mode === 'sequence_continuation' && !anchorIsVolumeEnd;

  useEffect(() => {
    if (!batch) return;
    if (!needsInsertionConfirmation) {
      setInsertionMode(batch.insertionMode ?? 'after_anchor');
    } else {
      setInsertionMode(null);
    }
  }, [batch?.draftBatchId, needsInsertionConfirmation]);

  const saveSelected = async (): Promise<void> => {
    if (!reviewInteractive || !selectedSession || !chapterPayload || !isDirty) return;
    await window.automation.invoke('draft.update', {
      draftSessionId: selectedSession.draftSessionId,
      version: selectedSession.version,
      payload: {
        ...chapterPayload,
        generatedText,
        content: normalizedContent,
      },
    }, 'desktop-ui');
    await loadBatch();
  };

  const handleSave = async () => {
    setIsMutating(true);
    setError('');
    try {
      await saveSelected();
      toast.success('章节草稿修改已保存');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleCommit = async () => {
    if (!reviewInteractive || !batch || !projection?.canCommit) return;
    if (reviewComments.unresolvedComments.length > 0) {
      setError('请先处理整批仍未解决的审批意见，再确认写回。');
      return;
    }
    if (needsInsertionConfirmation && !insertionMode) {
      setError('请选择新增章节的写入位置。');
      return;
    }
    setIsMutating(true);
    setError('');
    try {
      await saveSelected();
      const latest = await window.automation.invoke('draft.batch.get', { draftBatchId }, 'desktop-ui') as DraftBatchRecord;
      const latestProjection = projectDraftBatchReview(latest);
      const nextPrefix = Math.min(commitPrefix, latestProjection.reviewablePrefixLength);
      if (nextPrefix <= latestProjection.committedPrefixLength) {
        throw new Error('保存修改后没有可连续提交的章节，请先处理过期草稿。');
      }
      const response = await window.automation.invoke('draft.batch.commit_prefix', {
        draftBatchId,
        version: latest.version,
        prefixLength: nextPrefix,
        insertionMode: insertionMode ?? undefined,
      }, 'desktop-ui') as { batch: DraftBatchRecord };
      setBatch(response.batch);
      await loadBatch();
      onBatchStatusChange(draftBatchId, response.batch.status === 'committed' ? 'committed' : 'ready');
      toast.success(`已提交批次前 ${nextPrefix} 章`);
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleDiscard = async () => {
    if (!reviewInteractive || !batch || !projection?.canDiscard) return;
    if (!window.confirm('丢弃整批草稿后无法继续提交，确定要丢弃吗？')) return;
    setIsMutating(true);
    setError('');
    try {
      const discarded = await window.automation.invoke('draft.batch.discard', {
        draftBatchId,
        version: batch.version,
      }, 'desktop-ui') as DraftBatchRecord;
      setBatch(discarded);
      await loadBatch();
      onBatchStatusChange(draftBatchId, 'discarded');
      toast.success('整批草稿已丢弃');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const latestWriteback = useMemo(
    () => [...(batch?.writebacks ?? [])].reverse().find((item) => item.status === 'committed') ?? null,
    [batch?.writebacks],
  );

  const handleUndo = async () => {
    if (!batch || !latestWriteback) return;
    setIsMutating(true);
    setError('');
    try {
      const response = await window.automation.invoke('draft.batch.undo', {
        draftBatchId,
        version: batch.version,
        writebackId: latestWriteback.writebackId,
      }, 'desktop-ui') as { batch: DraftBatchRecord };
      setBatch(response.batch);
      await loadBatch();
      onBatchStatusChange(draftBatchId, 'ready');
      toast.success('已撤销本次写回，草稿可继续调整');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleRegenerate = async () => {
    if (!batch || projection?.regenerationChildIndex === null || projection?.regenerationChildIndex === undefined) return;
    setIsMutating(true);
    setError('');
    try {
      await onRegenerate(batch, projection.regenerationChildIndex);
      toast.success(`已从${chapterDisplay(projection.regenerationChildIndex).shortLabel}开始重新生成`);
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleDiscussComments = async () => {
    if (!reviewComments.pendingComments.length) return;
    setIsMutating(true);
    setError('');
    try {
      await onDiscuss(reviewComments.pendingComments);
      await reviewComments.markSent('discuss');
      setSubmitDialogOpen(false);
      toast.success('整批审批意见已发送到来源会话');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleRegenerateFromComments = async () => {
    if (!batch || !reviewComments.unresolvedComments.length || isDirty) return;
    const earliestChildIndex = Math.min(...reviewComments.unresolvedComments.map((comment) => comment.childIndex ?? 0));
    setIsMutating(true);
    setError('');
    try {
      await onRegenerate(batch, earliestChildIndex, reviewComments.unresolvedComments);
      await reviewComments.markSent('regenerate');
      setSubmitDialogOpen(false);
      toast.success(`已从${chapterDisplay(earliestChildIndex).shortLabel}开始生成新的待审核版本`);
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  const handleReconcile = async (resolution: 'reconciled_succeeded' | 'reconciled_absent') => {
    if (!batch || !selectedChild || !reconciliation) return;
    if (resolution === 'reconciled_absent' && !confirmAbsent) {
      setError('请先确认已核对草稿中心且没有生成结果。');
      return;
    }
    setIsMutating(true);
    setError('');
    try {
      await window.agent.reconcileSideEffect({
        draftBatchId,
        version: batch.version,
        childIndex: selectedChild.childIndex,
        generationRevision: selectedChild.generationRevision,
        invocationKey: reconciliation.invocation.invocationKey,
        resolution,
        confirmation: true,
        candidateDraftSessionId: resolution === 'reconciled_succeeded' ? selectedCandidateId : undefined,
        note: reconciliationNote.trim() || undefined,
      });
      setReconciliation(null);
      setConfirmAbsent(false);
      setReconciliationNote('');
      await loadBatch();
      toast.success(resolution === 'reconciled_succeeded' ? '已接纳匹配草稿' : '已确认未创建草稿，可以重新生成');
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsMutating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div><Loader2 className="mx-auto h-5 w-5 animate-spin text-[#2f80ed]" /><p className="mt-3 text-sm text-[var(--ui-text-muted)]">正在读取草稿批次...</p></div>
      </div>
    );
  }

  if (!batch || !projection) {
    return (
      <div className="grid h-full place-items-center px-8 text-center">
        <div><AlertCircle className="mx-auto h-6 w-6 text-red-500" /><p className="mt-3 text-sm text-red-600">{error || '草稿批次不可用'}</p></div>
      </div>
    );
  }

  if (!hasAnyDraft && !selectedChild?.error?.sideEffectUnknown) {
    return (
      <ChapterBeatPreviewPanel
        isDark={isDark}
        beats={batch.outline.beats}
        revision={batch.outline.revision}
        statusLabel={BATCH_STATUS_LABELS[batch.status]}
        chapterLabels={batch.outline.beats.map((beat) => chapterDisplay(beat.childIndex).shortLabel)}
      />
    );
  }

  const originalPane = (
    <section className={clsx('flex min-h-0 flex-1 flex-col', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
      <div className={clsx('flex h-11 shrink-0 items-center justify-between border-b px-5', isDark ? 'border-white/10 bg-white/[0.02]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
        <span className="text-sm font-semibold">{batch.mode === 'batch_rewrite' ? '当前原文' : '写入前'}</span>
        <span className="text-xs tabular-nums text-[var(--ui-text-muted)]">{Array.from(originalText).length} 字</span>
      </div>
      <div className={clsx('min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-6 py-5 font-serif text-[15px] leading-8', isDark ? 'bg-[#111116] text-neutral-300' : 'bg-[var(--ui-canvas)] text-[var(--ui-text-secondary)]')}>
        {originalText || (batch.mode === 'sequence_continuation' ? '这是新增章节，提交前不会进入正式章节树。' : '原文为空')}
      </div>
    </section>
  );

  const draftPane = (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className={clsx('flex h-11 shrink-0 items-center justify-between border-b px-5', isDark ? 'border-white/10 bg-white/[0.02]' : 'border-[var(--ui-border)] bg-white')}>
        <div className="flex items-center gap-2"><span className="text-sm font-semibold">Agent 草稿</span>{isDirty && <span className="rounded bg-[#fff4d8] px-1.5 py-0.5 text-[11px] text-[#8a5a00]">已修改</span>}</div>
        <span className="text-xs tabular-nums text-[var(--ui-text-muted)]">{Array.from(generatedText).length} 字</span>
      </div>
      <textarea
        aria-label={`${selectedChapterDisplay.fullLabel} Agent 草稿`}
        value={generatedText}
        onChange={(event) => setGeneratedText(event.target.value)}
        disabled={!reviewInteractive || selectedChild?.status !== 'draft' || isMutating}
        className={clsx('min-h-0 flex-1 resize-none border-0 px-6 py-5 font-serif text-[15px] leading-8 outline-none', isDark ? 'bg-[#0f0f13] text-neutral-200 disabled:text-neutral-500' : 'bg-white text-[var(--ui-text-primary)] disabled:text-[var(--ui-text-muted)]')}
      />
    </section>
  );

  const beatPreviewPane = (
    <div className={clsx('min-h-0 flex-1 overflow-y-auto px-6 py-5', isDark ? 'bg-[#111116]' : 'bg-[var(--ui-canvas)]')}>
      <article className={clsx('mx-auto max-w-3xl rounded-lg border px-5 py-5', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{selectedChapterDisplay.shortLabel} · 只读节拍</div>
            <h3 className="mt-1 text-base font-semibold">{selectedBeat?.title || selectedChild?.title || '章节节拍'}</h3>
          </div>
          <span className={clsx('rounded px-2 py-1 text-[11px]', isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>预览</span>
        </div>
        {selectedBeat ? (
          <dl className="mt-5 space-y-4 text-sm leading-6">
            <div><dt className="font-semibold">章节目标</dt><dd className={clsx('mt-1 whitespace-pre-wrap', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.chapterGoal}</dd></div>
            <div><dt className="font-semibold">核心冲突</dt><dd className={clsx('mt-1 whitespace-pre-wrap', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.coreConflict}</dd></div>
            <div><dt className="font-semibold">关键事件</dt><dd className={clsx('mt-1 whitespace-pre-wrap', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.keyEvents.join('；')}</dd></div>
            <div><dt className="font-semibold">结尾钩子</dt><dd className={clsx('mt-1 whitespace-pre-wrap', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{selectedBeat.endingHook}</dd></div>
          </dl>
        ) : <p className="mt-4 text-sm text-[var(--ui-text-muted)]">当前章节没有可显示的节拍。</p>}
        <div className={clsx('mt-5 border-t pt-4 text-xs leading-5', isDark ? 'border-white/10 text-neutral-500' : 'border-[var(--ui-border)] text-[var(--ui-text-muted)]')}>
          此处只用于阅读生成依据。需要确认时请在会话中的确认卡操作；正文草稿生成后才会开放差异对比、原文和草稿查看。
        </div>
      </article>
    </div>
  );

  const reconciliationPane = (
    <div className={clsx('min-h-0 flex-1 overflow-y-auto px-6 py-5', isDark ? 'bg-[#111116]' : 'bg-[var(--ui-canvas)]')}>
      <div className={clsx('mx-auto max-w-3xl rounded-md border', isDark ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-[#e3d6bd] bg-white')}>
        <div className={clsx('flex items-start gap-3 border-b px-5 py-4', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          <span className={clsx('grid h-9 w-9 shrink-0 place-items-center rounded-md', isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-[#fff7e7] text-[#9a6700]')}><ShieldCheck className="h-5 w-5" /></span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">需要核对{selectedChapterDisplay.shortLabel}生成结果</h3>
            <p className="mt-1 text-xs leading-5 text-[var(--ui-text-muted)]">Runtime 没有确认本次写入是否完成。对账只更新调用台账和草稿关联，不会重新调用模型或写入正文。</p>
          </div>
        </div>

        {isInspecting ? (
          <div className="grid min-h-48 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-[#2f80ed]" /></div>
        ) : reconciliation ? (
          <div className="space-y-5 px-5 py-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs">
              <div><dt className="text-[var(--ui-text-muted)]">工具</dt><dd className="mt-1 font-mono text-[var(--ui-text-secondary)]">{reconciliation.invocation.method}</dd></div>
              <div><dt className="text-[var(--ui-text-muted)]">批次 / 子项 / 生成修订</dt><dd className="mt-1 text-[var(--ui-text-secondary)]">{draftBatchId.slice(0, 8)}… / {selectedIndex + 1} / r{selectedChild?.generationRevision}</dd></div>
              <div><dt className="text-[var(--ui-text-muted)]">Request ID</dt><dd className="mt-1 truncate font-mono text-[var(--ui-text-secondary)]" title={reconciliation.invocation.requestId}>{reconciliation.invocation.requestId}</dd></div>
              <div><dt className="text-[var(--ui-text-muted)]">台账状态</dt><dd className="mt-1 font-medium text-[#9a6700]">{reconciliation.invocation.status}</dd></div>
            </dl>

            <section>
              <h4 className="text-xs font-semibold">精确匹配的草稿</h4>
              <div className="mt-2 space-y-2">
                {reconciliation.candidates.length > 0 ? reconciliation.candidates.map((candidate) => (
                  <label key={candidate.draftSessionId} className={clsx('flex cursor-pointer gap-3 rounded-md border px-3 py-3 text-xs', selectedCandidateId === candidate.draftSessionId ? 'border-[#2f80ed] bg-[#edf5ff]' : (isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]'))}>
                    <input type="radio" name="reconciliation-candidate" checked={selectedCandidateId === candidate.draftSessionId} onChange={() => setSelectedCandidateId(candidate.draftSessionId)} className="mt-0.5" />
                    <span className="min-w-0"><b className="block font-mono">{candidate.draftSessionId}</b><span className="mt-1 block line-clamp-2 leading-5 text-[var(--ui-text-muted)]">{candidate.previewSummary || '草稿预览不可用'}</span></span>
                  </label>
                )) : <div className={clsx('rounded-md border border-dashed px-3 py-4 text-center text-xs', isDark ? 'border-white/10 text-neutral-500' : 'border-[var(--ui-border-strong)] text-[var(--ui-text-muted)]')}>未找到同时匹配批次、子项和生成修订的草稿。</div>}
              </div>
            </section>

            <label className="block text-xs"><span className="font-semibold">对账备注（可选）</span><textarea value={reconciliationNote} onChange={(event) => setReconciliationNote(event.target.value)} rows={2} maxLength={300} className={clsx('mt-2 w-full resize-none rounded-md border px-3 py-2 outline-none', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border-strong)] bg-white')} placeholder="记录人工核对依据" /></label>

            <div className={clsx('flex flex-wrap items-center justify-between gap-3 border-t pt-4', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
              <label className="flex max-w-md items-start gap-2 text-xs leading-5 text-[var(--ui-text-muted)]"><input type="checkbox" checked={confirmAbsent} onChange={(event) => setConfirmAbsent(event.target.checked)} className="mt-1" /><span>我已核对草稿中心，确认本次调用没有创建可用草稿。</span></label>
              <div className="flex gap-2">
                <button type="button" disabled={mode === 'progress' || !reconciliation.canConfirmAbsent || !confirmAbsent || isMutating} onClick={() => void handleReconcile('reconciled_absent')} className={clsx('h-9 rounded-md border px-3 text-xs disabled:opacity-45', isDark ? 'border-white/10 text-neutral-300' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}>确认未创建</button>
                <button type="button" disabled={mode === 'progress' || !reconciliation.canAcceptExisting || !selectedCandidateId || isMutating} onClick={() => void handleReconcile('reconciled_succeeded')} className={clsx('h-9 rounded-md px-3 text-xs text-white disabled:opacity-45', isDark ? 'bg-[#1f2328]' : 'bg-indigo-600')}>接纳已有草稿</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={clsx('max-h-[45%] shrink-0 overflow-y-auto border-b px-5 py-4', isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={clsx('rounded px-2 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>{BATCH_STATUS_LABELS[batch.status]}</span>
              {selectedChild?.error?.sideEffectUnknown && <span className={clsx('text-xs font-medium', isDark ? 'text-red-300' : 'text-red-700')}>生成结果需要核对</span>}
            </div>
            <div className={clsx('mt-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
              共 {batch.children.length} 章 · 已提交批次前 {projection.committedPrefixLength} 章 · 可提交批次前 {projection.reviewablePrefixLength} 章 · 节拍 v{batch.outline.revision}
            </div>
          </div>
          {selectedHasDraft && <div className={clsx('flex max-w-full shrink-0 overflow-x-auto rounded-md border p-1', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
            {([
              { id: 'diff', label: '高亮差异', icon: FileDiff },
              { id: 'original', label: '完整原文', icon: FileText },
              { id: 'draft', label: '完整草稿', icon: Save },
            ] as const).map((option) => {
              const Icon = option.icon;
              return <button key={option.id} type="button" onClick={() => setReviewMode(option.id)} className={clsx('inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs', reviewMode === option.id ? (isDark ? 'bg-white/10 text-white' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-primary)]') : 'text-[var(--ui-text-muted)]')}><Icon className="h-3.5 w-3.5" />{option.label}</button>;
            })}
          </div>}
        </div>

        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {batch.children.map((child) => (
            <button
              key={child.childIndex}
              type="button"
              onClick={() => setSelectedIndex(child.childIndex)}
              className={clsx('min-w-[132px] rounded-md border px-3 py-2 text-left', selectedIndex === child.childIndex ? 'border-[#2f80ed] bg-[#edf5ff]' : (isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white'))}
            >
              <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{chapterDisplay(child.childIndex).shortLabel}</span><span className={clsx('rounded px-1.5 py-0.5 text-[10px]', childStatusTone(child.status, isDark))}>{CHILD_STATUS_LABELS[child.status]}</span></div>
              <div className="mt-1 truncate text-xs text-[var(--ui-text-muted)]" title={child.title}>{child.title}</div>
            </button>
          ))}
        </div>

        {selectedBeat && selectedHasDraft && (
          <div className={clsx('mt-3 border-t pt-3 text-xs', isDark ? 'border-white/10 text-neutral-400' : 'border-[var(--ui-border)] text-[var(--ui-text-secondary)]')}>
            <button type="button" onClick={() => setShowBeat((current) => !current)} className="inline-flex items-center gap-1 font-medium"><ListChecks className="h-3.5 w-3.5 text-[#2f80ed]" />章节节拍<ChevronDown className={clsx('h-3 w-3 transition-transform', showBeat && 'rotate-180')} /></button>
            {showBeat && <div className="mt-2 grid grid-cols-1 gap-2 break-words text-xs font-normal leading-5"><span><b>目标：</b>{selectedBeat.chapterGoal}</span><span><b>冲突：</b>{selectedBeat.coreConflict}</span><span><b>事件：</b>{selectedBeat.keyEvents.join('；')}</span><span><b>钩子：</b>{selectedBeat.endingHook}</span></div>}
          </div>
        )}

        {selectedChild?.error && <div className={clsx('mt-3 flex gap-2 rounded-md px-3 py-2 text-xs leading-5', isDark ? 'bg-red-500/10 text-red-200' : 'bg-red-50 text-red-700')}><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{selectedChild.error.message}{selectedChild.error.sideEffectUnknown ? '。调用结果未知，完成对账前禁止重新生成。' : ''}</span></div>}
        {(error || reviewComments.error) && <div className={clsx('mt-3 rounded-md px-3 py-2 text-xs', isDark ? 'bg-red-500/10 text-red-200' : 'bg-red-50 text-red-700')}>{error || reviewComments.error}</div>}
      </div>

      {selectedChild?.error?.sideEffectUnknown ? reconciliationPane : selectedHasDraft ? (
        <div className="flex min-h-0 flex-1">
          {reviewMode === 'diff' && selectedSession && (
            <DraftDiffView
              originalText={originalText}
              draftText={draftText}
              isDark={isDark}
              reviewVersionId={selectedSession.draftSessionId}
              comments={selectedReviewComments}
              disabled={!reviewInteractive || selectedChild?.status !== 'draft'}
              isMutating={reviewComments.isMutating}
              onSave={reviewComments.save}
              onDelete={reviewComments.remove}
            />
          )}
          {reviewMode === 'original' && originalPane}
          {reviewMode === 'draft' && draftPane}
        </div>
      ) : beatPreviewPane}

      {selectedHasDraft ? <div className={clsx('max-h-[40%] shrink-0 overflow-y-auto border-t px-5 py-3', isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
        {reviewInteractive && needsInsertionConfirmation && projection.canCommit && (
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-xs text-[var(--ui-text-muted)]">当前章不是卷末，请确认新增章节位置</span>
            <div className={clsx('flex rounded-md border p-1', isDark ? 'border-white/10' : 'border-[var(--ui-border-strong)] bg-white')}>
              {([
                { id: 'after_anchor', label: '当前章后插入' },
                { id: 'volume_end', label: '卷末追加' },
              ] as const).map((option) => <button key={option.id} type="button" onClick={() => setInsertionMode(option.id)} className={clsx('h-7 rounded px-2 text-xs', insertionMode === option.id ? 'bg-[#2f80ed] text-white' : 'text-[var(--ui-text-muted)]')}>{option.label}</button>)}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-[220px] flex-1 text-xs text-[var(--ui-text-muted)]">
            {!reviewInteractive
              ? mode === 'progress'
                ? '生成仍在继续，当前内容仅供只读查看；批次完整后开放审核和写回。'
                : '批次未完整生成，已生成内容仅供只读查看；请先完成恢复或重试。'
              : reviewComments.unresolvedComments.length > 0
              ? reviewComments.pendingComments.length > 0
                ? `整批有 ${reviewComments.pendingComments.length} 条审批意见待发送，处理前不能写回正文`
                : `整批有 ${reviewComments.unresolvedComments.length} 条意见已发到会话，需重新生成或调整后才能写回`
              : latestWriteback
              ? '写回后可撤销本次操作；若正文已再次修改，撤销会被拒绝。'
              : projection.sideEffectUnknownChildIndex !== null
              ? `${chapterDisplay(projection.sideEffectUnknownChildIndex).shortLabel}调用结果未知，需要先对账`
              : selectedChild?.status === 'draft' ? (isDirty ? '当前章节修改尚未保存' : '当前章节草稿已保存') : `当前章节${CHILD_STATUS_LABELS[selectedChild?.status ?? 'pending']}`}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {reviewInteractive && <DraftMoreMenu isDark={isDark} disabled={!projection.canDiscard || isMutating} discardLabel="丢弃整批草稿" onDiscard={() => void handleDiscard()} />}
            {mode !== 'progress' && projection.regenerationChildIndex !== null && <button type="button" disabled={isMutating} onClick={() => void handleRegenerate()} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-white/10 text-neutral-300' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}><RotateCcw className="h-4 w-4" />从{chapterDisplay(projection.regenerationChildIndex).shortLabel}继续</button>}
            {reviewInteractive && latestWriteback && <button type="button" disabled={isMutating} onClick={() => void handleUndo()} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-white/10 text-neutral-200' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}><RotateCcw className="h-4 w-4" />撤销本次写回</button>}
            {reviewInteractive && selectedChild?.status === 'draft' && reviewMode !== 'draft' && <button type="button" disabled={isMutating} onClick={() => setReviewMode('draft')} className={clsx('h-9 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-white/10 text-neutral-300' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}>继续调整</button>}
            {reviewInteractive && <button type="button" disabled={selectedChild?.status !== 'draft' || !isDirty || isMutating} onClick={() => void handleSave()} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-white/10 text-neutral-300' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}><Save className="h-4 w-4" />保存调整</button>}
            {reviewInteractive && reviewComments.unresolvedComments.length > 0 && <button type="button" disabled={isMutating || reviewComments.isMutating} onClick={() => setSubmitDialogOpen(true)} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-sky-400/30 text-sky-200' : 'border-[#9dbbd8] bg-white text-[#355b7d]')}><Send className="h-4 w-4" />{reviewComments.pendingComments.length > 0 ? '发送意见' : '处理意见'} ({reviewComments.unresolvedComments.length})</button>}
            {reviewInteractive && projection.canCommit && <select aria-label="提交批次章节前缀" value={commitPrefix} onChange={(event) => setCommitPrefix(Number(event.target.value))} disabled={isMutating} className={clsx('h-9 rounded-md border px-2 text-sm outline-none', isDark ? 'border-white/10 bg-[#17171d]' : 'border-[var(--ui-border-strong)] bg-white')}>{Array.from({ length: projection.reviewablePrefixLength - projection.committedPrefixLength }, (_, offset) => projection.committedPrefixLength + offset + 1).map((length) => <option key={length} value={length}>批次前 {length} 章</option>)}</select>}
            {reviewInteractive && <button type="button" disabled={!projection.canCommit || isMutating || reviewComments.unresolvedComments.length > 0 || (needsInsertionConfirmation && !insertionMode)} onClick={() => void handleCommit()} className={clsx('inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-sm text-white disabled:opacity-45', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}>{isMutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{projection.canCommit ? '确认写回' : '无可写回章节'}</button>}
          </div>
        </div>
      </div> : !selectedChild?.error?.sideEffectUnknown ? (
        <div className={clsx('shrink-0 border-t px-5 py-3 text-xs leading-5', isDark ? 'border-white/10 bg-[#0f0f13] text-neutral-500' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-muted)]')}>
          只读预览 · 节拍确认在会话中完成
        </div>
      ) : null}
      <ReviewSubmitDialog
        open={submitDialogOpen}
        comments={reviewComments.unresolvedComments}
        isDark={isDark}
        isSubmitting={isMutating || reviewComments.isMutating}
        isBatch
        regenerateDisabled={isDirty}
        regenerateDisabledReason={isDirty ? '当前章节有尚未保存的手动修改。请先保存调整，再提交整批审批意见重新生成。' : undefined}
        discussDisabled={reviewComments.pendingComments.length === 0}
        onClose={() => setSubmitDialogOpen(false)}
        onDiscuss={() => void handleDiscussComments()}
        onRegenerate={() => void handleRegenerateFromComments()}
      />
    </div>
  );
}
