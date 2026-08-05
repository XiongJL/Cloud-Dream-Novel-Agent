import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, ChevronDown, ClipboardCheck, Loader2, PauseCircle, X } from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import type { Volume } from '../../types';
import type {
  ArtifactReviewSubmitResult,
  FindingDecision,
  FindingDecisionStatus,
} from '../../../shared/expertReport';
import {
  expertReportTypeLabel,
  expertRoleLabel,
  getExpertReport,
  projectChapterFindings,
  severityCounts,
} from '../../../shared/agentExpertReportProjection';
import type { ReportReviewAvailability } from './reportReviewAvailability';

const REVIEWABLE_TYPES = new Set([
  'writer_revision_plan', 'chapter_range_review', 'reader_journey',
  'worldbuilding_consistency', 'research_fact_check', 'scope_audit',
]);

const SEVERITY_LABELS = { critical: '严重', high: '高', medium: '中', low: '低', info: '提示' } as const;

export function ExpertReportPanel({
  isDark,
  artifacts,
  volumes,
  reviewAvailability,
  onReviewSubmitted,
}: {
  isDark: boolean;
  artifacts: AgentArtifact[];
  volumes: Volume[];
  reviewAvailability: ReportReviewAvailability;
  onReviewSubmitted: (artifactId: string, result: ArtifactReviewSubmitResult) => void;
}) {
  const reportArtifacts = useMemo(() => artifacts.filter((artifact) => (
    REVIEWABLE_TYPES.has(artifact.type) && getExpertReport(artifact)
  )), [artifacts]);
  const root = reportArtifacts.find((artifact) => artifact.type === 'scope_audit') ?? reportArtifacts[0] ?? null;
  const [selectedId, setSelectedId] = useState(root?.artifactId ?? '');
  const selectedArtifact = reportArtifacts.find((artifact) => artifact.artifactId === selectedId) ?? root;
  const report = getExpertReport(selectedArtifact);
  const [decisions, setDecisions] = useState<Record<string, FindingDecision>>({});
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!selectedArtifact) return;
    setSelectedId(selectedArtifact.artifactId);
    setDecisions(Object.fromEntries((selectedArtifact.reviewDecisions ?? []).map((decision) => [decision.findingId, decision])));
  }, [selectedArtifact?.artifactId, selectedArtifact?.reviewRevision]);

  const chapterTitleById = useMemo(() => new Map(volumes.flatMap((volume) => (
    volume.chapters.map((chapter) => [chapter.id, chapter.title] as const)
  ))), [volumes]);
  const matrix = report ? projectChapterFindings(report) : [];
  const counts = report ? severityCounts(report.findings) : null;
  const coverage = report?.coverage;
  const artifactIsReady = Boolean(selectedArtifact && ['ready', 'committed'].includes(selectedArtifact.status));
  const artifactIsStale = selectedArtifact?.reviewStatus === 'stale';
  const artifactIsIncomplete = selectedArtifact?.status === 'failed' || selectedArtifact?.status === 'discarded';
  const isGenerating = reviewAvailability === 'generating' && !artifactIsStale && !artifactIsIncomplete;
  const interactive = reviewAvailability === 'ready'
    && artifactIsReady
    && !artifactIsStale;
  const availabilityLabel = artifactIsStale
    ? '报告已过期'
    : artifactIsIncomplete || reviewAvailability === 'incomplete'
      ? '审核未完成'
      : reviewAvailability === 'generating'
        ? '审核生成中'
        : reviewAvailability === 'waiting'
          ? '审核待继续'
          : reviewAvailability === 'blocked'
            ? '暂不可审核'
            : '';
  const availabilityMessage = artifactIsStale
    ? '源章节已经变化，当前报告仅供查看，请重新生成后再处理。'
    : artifactIsIncomplete || reviewAvailability === 'incomplete'
      ? '任务未完整结束，当前仅展示已经生成的内容。'
      : reviewAvailability === 'generating'
        ? '结果仍可能增加或调整，完成后即可处理。'
        : reviewAvailability === 'waiting'
          ? '任务正在等待继续，完成后即可处理审核结果。'
          : reviewAvailability === 'blocked'
            ? '当前工作区暂不可提交审核，请稍后再试。'
            : '';

  if (!selectedArtifact || !report) {
    return (
      <div className={clsx('rounded-lg border p-3 text-sm leading-6', isDark ? 'border-white/10 bg-black/20 text-neutral-400' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-muted)]')}>
        当前会话还没有可审核的专家报告。
      </div>
    );
  }

  const chooseAll = (status: FindingDecisionStatus) => {
    if (!interactive) return;
    setDecisions(Object.fromEntries(report.findings.map((finding) => [finding.findingId, { findingId: finding.findingId, status }])));
  };

  const submit = async () => {
    const values = Object.values(decisions);
    if (!interactive || values.length === 0) return;
    setIsSubmitting(true);
    try {
      const result = await window.automation.invoke('artifact.review.submit', {
        artifactId: selectedArtifact.artifactId,
        expectedReviewRevision: selectedArtifact.reviewRevision ?? 0,
        decisions: values,
      }, 'desktop-ui') as ArtifactReviewSubmitResult;
      onReviewSubmitted(selectedArtifact.artifactId, result);
      const accepted = result.review.decisions.filter((decision) => decision.status === 'accepted').length;
      toast.success(accepted > 0 ? `审核已保存，已创建或更新 ${accepted} 个修订任务` : '审核决定已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 pb-4">
      {reportArtifacts.length > 1 && (
        <div className="flex gap-1 overflow-x-auto pb-1">
          {reportArtifacts.map((artifact) => {
            const itemReport = getExpertReport(artifact);
            if (!itemReport) return null;
            return (
              <button key={artifact.artifactId} type="button" onClick={() => setSelectedId(artifact.artifactId)} className={clsx('shrink-0 rounded-md border px-2 py-1.5 text-xs', artifact.artifactId === selectedArtifact.artifactId ? 'border-[#2f80ed] bg-[#eaf3ff] text-[#1d63b7]' : isDark ? 'border-white/10 text-neutral-400' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-muted)]')}>
                {expertRoleLabel(itemReport.expert)}
              </button>
            );
          })}
        </div>
      )}

      <section className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold"><ClipboardCheck className="h-4 w-4 shrink-0 text-[#2f80ed]" />{expertReportTypeLabel(report.type)}</div>
            <div className={clsx('mt-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{isGenerating ? `已发现 ${report.findings.length} 个问题` : `${report.findings.length} 个问题`} · {expertRoleLabel(report.expert)}</div>
          </div>
          <span className={clsx(
            'inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px]',
            !interactive
              ? artifactIsStale || artifactIsIncomplete || reviewAvailability === 'incomplete'
                ? 'bg-amber-50 text-amber-700'
                : isGenerating
                  ? isDark ? 'bg-blue-400/10 text-blue-300' : 'bg-[#eaf3ff] text-[#1d63b7]'
                  : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]'
              : selectedArtifact.reviewStatus === 'reviewed'
                ? 'bg-emerald-50 text-emerald-700'
                : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]',
          )}>
            {isGenerating && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />}
            {!interactive ? availabilityLabel : selectedArtifact.reviewStatus === 'reviewed' ? '已审核' : selectedArtifact.reviewStatus === 'in_review' ? '审核中' : '待审核'}
          </span>
        </div>
        {!interactive && availabilityMessage && (
          <div className={clsx('mt-3 flex items-start gap-2 rounded-md px-2.5 py-2 text-[11px] leading-5', isDark ? 'bg-white/5 text-neutral-400' : 'bg-[#f7faff] text-[var(--ui-text-muted)]')} aria-live="polite">
            {isGenerating
              ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[#2f80ed] motion-reduce:animate-none" />
              : <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>{availabilityMessage}</span>
          </div>
        )}
        {report.summary && <p className={clsx('mt-3 text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>{report.summary}</p>}
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {(['critical', 'high', 'medium', 'low'] as const).map((severity) => (
            <div key={severity} className={clsx('rounded-md border px-2 py-2 text-center', isDark ? 'border-white/10' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
              <div className="text-sm font-semibold tabular-nums">{counts?.[severity] ?? 0}</div>
              <div className={clsx('mt-0.5 text-[10px]', severity === 'critical' || severity === 'high' ? 'text-red-600' : isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{SEVERITY_LABELS[severity]}</div>
            </div>
          ))}
        </div>
        {coverage && (
          <div className={clsx('mt-3 text-[11px] leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
            覆盖 {coverage.contextChapterCount}/{coverage.totalChapterCount} 章 · 详细 {coverage.detailedChapterCount} · 摘要 {coverage.summarizedChapterCount}{coverage.omittedChapterCount > 0 ? ` · 省略 ${coverage.omittedChapterCount}` : ''}
          </div>
        )}
      </section>

      {matrix.length > 0 && (
        <section className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
          <div className="text-xs font-semibold">章节矩阵</div>
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
            {matrix.map((chapter) => (
              <div key={chapter.chapterId} title={chapterTitleById.get(chapter.chapterId) || chapter.chapterId} className={clsx('w-16 shrink-0 rounded-md border px-1.5 py-2 text-center', isDark ? 'border-white/10' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
                <div className="truncate text-[10px]">{chapterTitleById.get(chapter.chapterId) || chapter.chapterId}</div>
                <div className={clsx('mt-1 text-sm font-semibold', chapter.highestSeverity === 'critical' || chapter.highestSeverity === 'high' ? 'text-red-600' : chapter.findingCount > 0 ? 'text-amber-600' : 'text-emerald-600')}>{chapter.findingCount}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold">问题清单</div>
          <div className="flex gap-1">
            <button type="button" disabled={!interactive} onClick={() => chooseAll('accepted')} className={clsx('rounded px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40', isDark ? 'bg-white/10' : 'bg-[#eaf3ff] text-[#1d63b7]')}>全部接受</button>
            <button type="button" disabled={!interactive} onClick={() => chooseAll('deferred')} className={clsx('rounded px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>全部暂缓</button>
          </div>
        </div>
        {report.findings.map((finding) => {
          const decision = decisions[finding.findingId]?.status;
          const expanded = expandedFinding === finding.findingId;
          return (
            <article key={finding.findingId} className={clsx('rounded-lg border overflow-hidden', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
              <button type="button" onClick={() => setExpandedFinding(expanded ? null : finding.findingId)} className="w-full p-3 text-left">
                <div className="flex items-start gap-2">
                  <span className={clsx('shrink-0 rounded px-1.5 py-0.5 text-[10px]', finding.severity === 'critical' || finding.severity === 'high' ? 'bg-red-50 text-red-700' : finding.severity === 'medium' ? 'bg-amber-50 text-amber-700' : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>{SEVERITY_LABELS[finding.severity]}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium leading-5">{finding.title}</div>
                    <div className={clsx('mt-1 line-clamp-2 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{finding.summary}</div>
                  </div>
                  <ChevronDown className={clsx('mt-0.5 h-4 w-4 shrink-0 transition-transform', expanded && 'rotate-180')} />
                </div>
              </button>
              {expanded && (
                <div className={clsx('border-t px-3 py-3 text-xs leading-5', isDark ? 'border-white/10 text-neutral-400' : 'border-[var(--ui-border)] text-[var(--ui-text-secondary)]')}>
                  {finding.recommendation && <div><span className="font-medium">建议：</span>{finding.recommendation}</div>}
                  {finding.uncertainty && <div className="mt-1 text-amber-700"><span className="font-medium">需确认：</span>{finding.uncertainty}</div>}
                  <div className="mt-2">章节：{finding.chapterIds.map((id) => chapterTitleById.get(id) || id).join('、') || '全局'}</div>
                </div>
              )}
              <div className={clsx('grid grid-cols-3 gap-1 border-t p-2', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                <DecisionButton status="accepted" active={decision === 'accepted'} disabled={!interactive} isDark={isDark} onClick={() => setDecisions((current) => ({ ...current, [finding.findingId]: { findingId: finding.findingId, status: 'accepted' } }))} />
                <DecisionButton status="deferred" active={decision === 'deferred'} disabled={!interactive} isDark={isDark} onClick={() => setDecisions((current) => ({ ...current, [finding.findingId]: { findingId: finding.findingId, status: 'deferred' } }))} />
                <DecisionButton status="rejected" active={decision === 'rejected'} disabled={!interactive} isDark={isDark} onClick={() => setDecisions((current) => ({ ...current, [finding.findingId]: { findingId: finding.findingId, status: 'rejected' } }))} />
              </div>
            </article>
          );
        })}
      </section>

      <button type="button" disabled={!interactive || isSubmitting || Object.keys(decisions).length === 0} onClick={() => void submit()} className={clsx('h-9 w-full rounded-md px-3 inline-flex items-center justify-center gap-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40', isDark ? 'bg-[#1f2328]' : 'bg-indigo-600')}>
        {isSubmitting || isGenerating ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ClipboardCheck className="h-4 w-4" />}
        {interactive ? '保存审核决定' : availabilityLabel || '暂不可审核'}
      </button>
    </div>
  );
}

function DecisionButton({ status, active, disabled, isDark, onClick }: { status: FindingDecisionStatus; active: boolean; disabled: boolean; isDark: boolean; onClick: () => void }) {
  const config = status === 'accepted'
    ? { label: '接受', icon: CheckCircle2 }
    : status === 'deferred'
      ? { label: '暂缓', icon: PauseCircle }
      : { label: '驳回', icon: X };
  const Icon = config.icon;
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={clsx('h-8 rounded-md inline-flex items-center justify-center gap-1 text-xs disabled:cursor-not-allowed disabled:opacity-40', active ? status === 'accepted' ? 'bg-emerald-50 text-emerald-700' : status === 'deferred' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700' : isDark ? 'text-neutral-500 enabled:hover:bg-white/5' : 'text-[var(--ui-text-muted)] enabled:hover:bg-[var(--ui-surface-muted)]')}>
      {active ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}{config.label}
    </button>
  );
}
