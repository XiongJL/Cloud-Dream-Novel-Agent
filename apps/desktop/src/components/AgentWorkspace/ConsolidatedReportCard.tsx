import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  Eye,
  FileCheck2,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import type { ArtifactReviewSubmitResult, FindingDecision, FindingDecisionStatus } from '../../../shared/expertReport';
import {
  expertRoleLabel,
  getExpertReport,
  getFindingSourceExperts,
  projectConsolidatedFindings,
  selectConsolidatedReportArtifact,
} from '../../../shared/agentExpertReportProjection';
import type { ReportReviewAvailability } from './reportReviewAvailability';

const SEVERITY_LABELS = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '提示',
} as const;

export function ConsolidatedReportCard({
  artifacts,
  isDark,
  reviewAvailability,
  onOpenDetails,
  onModifySelected,
  onReviewSubmitted,
}: {
  artifacts: AgentArtifact[];
  isDark: boolean;
  reviewAvailability: ReportReviewAvailability;
  onOpenDetails?: () => void;
  onModifySelected: (artifact: AgentArtifact, findingIds: string[]) => Promise<void>;
  onReviewSubmitted: (artifactId: string, result: ArtifactReviewSubmitResult) => void;
}) {
  const artifact = useMemo(() => selectConsolidatedReportArtifact(artifacts), [artifacts]);
  // Normalizing legacy finding IDs can return a new report object. Keep that
  // projection stable while the artifact is unchanged so a local checkbox
  // update does not immediately retrigger the hydration effect below.
  const report = useMemo(() => getExpertReport(artifact), [artifact]);
  const findings = useMemo(() => report ? projectConsolidatedFindings(report) : [], [report]);
  const [expanded, setExpanded] = useState(true);
  const [menuFindingId, setMenuFindingId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, FindingDecision>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const artifactIsReady = Boolean(artifact && ['ready', 'committed'].includes(artifact.status));
  const artifactIsStale = artifact?.reviewStatus === 'stale';
  const artifactIsIncomplete = artifact?.status === 'failed' || artifact?.status === 'discarded';
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

  useEffect(() => {
    if (!artifact || !report) return;
    const stored = Object.fromEntries((artifact.reviewDecisions ?? []).map((decision) => [decision.findingId, decision]));
    const hasStoredDecision = Object.keys(stored).length > 0;
    if (!hasStoredDecision) {
      for (const finding of findings.slice(0, Math.min(3, findings.length))) {
        stored[finding.findingId] = { findingId: finding.findingId, status: 'accepted' };
      }
    }
    setDecisions(stored);
  }, [artifact?.artifactId, artifact?.reviewRevision, findings, report]);

  useEffect(() => {
    if (!interactive) setMenuFindingId(null);
  }, [interactive]);

  if (!artifact || !report || findings.length === 0) return null;

  const selectedCount = findings.filter((finding) => decisions[finding.findingId]?.status === 'accepted').length;
  const submit = async (
    nextDecisions: FindingDecision[],
    successMessage: string,
    createRevisionTasks = true,
  ): Promise<ArtifactReviewSubmitResult | null> => {
    if (!interactive || isSubmitting || nextDecisions.length === 0) return null;
    setIsSubmitting(true);
    try {
      const result = await window.automation.invoke('artifact.review.submit', {
        artifactId: artifact.artifactId,
        expectedReviewRevision: artifact.reviewRevision ?? 0,
        decisions: nextDecisions,
        createRevisionTasks,
      }, 'desktop-ui') as ArtifactReviewSubmitResult;
      onReviewSubmitted(artifact.artifactId, result);
      setDecisions(Object.fromEntries(result.review.decisions.map((decision) => [decision.findingId, decision])));
      toast.success(successMessage);
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setIsSubmitting(false);
    }
  };

  const decideFinding = (findingId: string, status: FindingDecisionStatus) => {
    const decision = { findingId, status };
    setDecisions((current) => ({ ...current, [findingId]: decision }));
    setMenuFindingId(null);
    void submit([decision], status === 'deferred' ? '已加入待改清单' : '已忽略这条建议');
  };

  const deferVisible = () => {
    const next = findings.map((finding) => ({ findingId: finding.findingId, status: 'deferred' as const }));
    setDecisions((current) => ({ ...current, ...Object.fromEntries(next.map((decision) => [decision.findingId, decision])) }));
    void submit(next, '已将当前建议加入待改清单');
  };

  const selectedDecisions = findings.flatMap((finding) => (
    decisions[finding.findingId]?.status === 'accepted'
      ? [{ findingId: finding.findingId, status: 'accepted' as const }]
      : []
  ));
  const visibleDecisions = findings.map((finding) => (
    decisions[finding.findingId] ?? { findingId: finding.findingId, status: 'deferred' as const }
  ));

  const modifySelected = async () => {
    const result = await submit(visibleDecisions, `已确认 ${selectedCount} 项修改建议`, false);
    if (!result) return;
    try {
      await onModifySelected(artifact, selectedDecisions.map((decision) => decision.findingId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className={clsx(
      'overflow-hidden rounded-lg border',
      isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white',
    )}>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-md', isDark ? 'bg-white/10' : 'bg-[#edf5ff]')}>
          <FileCheck2 className="h-4 w-4 text-[#2f80ed]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">综合审核</h3>
            <span className={clsx('rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
              {isGenerating ? `已发现 ${report.findings.length} 项建议` : `${report.findings.length} 项建议`}
            </span>
            {availabilityLabel && (
              <span className={clsx(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
                isGenerating
                  ? isDark ? 'bg-blue-400/10 text-blue-300' : 'bg-[#eaf3ff] text-[#1d63b7]'
                  : artifactIsStale || artifactIsIncomplete || reviewAvailability === 'incomplete'
                    ? 'bg-amber-50 text-amber-700'
                    : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]',
              )}>
                {isGenerating && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />}
                {availabilityLabel}
              </span>
            )}
          </div>
          {report.summary && (
            <p className={clsx('mt-1 line-clamp-2 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{report.summary}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-md', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')}
          aria-expanded={expanded}
          aria-label={expanded ? '折叠综合审核' : '展开综合审核'}
          title={expanded ? '折叠' : '展开'}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {expanded && (
        <>
          <div className={clsx('divide-y border-y', isDark ? 'divide-white/10 border-white/10' : 'divide-[var(--ui-border)] border-[var(--ui-border)]')}>
            {findings.map((finding) => {
              const decision = decisions[finding.findingId]?.status;
              const selected = decision === 'accepted';
              const sourceExperts = getFindingSourceExperts(artifact, finding);
              return (
                <div key={finding.findingId} className="flex items-start gap-3 px-4 py-3">
                  <button
                    type="button"
                    disabled={!interactive || isSubmitting}
                    onClick={() => setDecisions((current) => ({
                      ...current,
                      [finding.findingId]: {
                        findingId: finding.findingId,
                        status: selected ? 'deferred' : 'accepted',
                      },
                    }))}
                    className={clsx(
                      'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border transition-colors disabled:cursor-default',
                      selected
                        ? 'border-[#2f80ed] bg-[#2f80ed] text-white'
                        : isDark ? 'border-white/20 text-transparent' : 'border-[var(--ui-border-strong)] bg-white text-transparent',
                    )}
                    aria-pressed={selected}
                    aria-label={selected ? `取消本次修改：${finding.title}` : `加入本次修改：${finding.title}`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={clsx(
                        'rounded px-1.5 py-0.5 text-[10px]',
                        finding.severity === 'critical' || finding.severity === 'high'
                          ? 'bg-red-50 text-red-700'
                          : finding.severity === 'medium'
                            ? 'bg-amber-50 text-amber-700'
                            : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]',
                      )}>{SEVERITY_LABELS[finding.severity]}</span>
                      <span className="text-sm font-medium leading-5">{finding.title}</span>
                    </div>
                    <p className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                      {finding.recommendation || finding.summary}
                    </p>
                    <div className={clsx('mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>
                      <span>{sourceExperts.map(expertRoleLabel).join('、')}</span>
                      {decision === 'deferred' && <span className="text-amber-600">稍后处理</span>}
                      {decision === 'rejected' && <span>已忽略</span>}
                    </div>
                  </div>
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      disabled={!interactive || isSubmitting}
                      onClick={() => setMenuFindingId((current) => current === finding.findingId ? null : finding.findingId)}
                      className={clsx('grid h-8 w-8 place-items-center rounded-md disabled:cursor-default disabled:opacity-40', isDark ? 'text-neutral-500 enabled:hover:bg-white/5' : 'text-[var(--ui-text-disabled)] enabled:hover:bg-[var(--ui-surface-muted)]')}
                      aria-label={`处理建议：${finding.title}`}
                      title={interactive ? '更多操作' : availabilityLabel}
                    >
                      <Ellipsis className="h-4 w-4" />
                    </button>
                    {menuFindingId === finding.findingId && (
                      <div className={clsx('absolute right-0 top-9 z-20 w-28 rounded-md border p-1 shadow-lg', isDark ? 'border-white/10 bg-[#1b1b21]' : 'border-[var(--ui-border)] bg-white')}>
                        <button type="button" onClick={() => decideFinding(finding.findingId, 'deferred')} className={clsx('h-8 w-full rounded px-2 text-left text-xs', isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]')}>稍后处理</button>
                        <button type="button" onClick={() => decideFinding(finding.findingId, 'rejected')} className={clsx('h-8 w-full rounded px-2 text-left text-xs', isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]')}>忽略建议</button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {!interactive && availabilityMessage && (
            <div className={clsx('flex items-center gap-2 border-b px-4 py-2.5 text-xs', isDark ? 'border-white/10 bg-white/[0.02] text-neutral-400' : 'border-[var(--ui-border)] bg-[#f7faff] text-[var(--ui-text-muted)]')} aria-live="polite">
              {isGenerating
                ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#2f80ed] motion-reduce:animate-none" />
                : <ShieldCheck className="h-3.5 w-3.5 shrink-0" />}
              {availabilityMessage}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <button type="button" disabled={!onOpenDetails} onClick={onOpenDetails} className={clsx('inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs disabled:cursor-default disabled:opacity-60', isDark ? 'text-neutral-400 enabled:hover:bg-white/5' : 'text-[var(--ui-text-muted)] enabled:hover:bg-[var(--ui-surface-muted)]')}>
              <Eye className="h-3.5 w-3.5" />
              查看依据与全部 {report.findings.length} 项
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={!interactive || isSubmitting} onClick={deferVisible} className={clsx('h-9 rounded-md px-3 text-sm disabled:cursor-not-allowed disabled:opacity-40', isDark ? 'text-neutral-400 enabled:hover:bg-white/5' : 'text-[var(--ui-text-muted)] enabled:hover:bg-[var(--ui-surface-muted)]')}>稍后再说</button>
              <button
                type="button"
                disabled={!interactive || isSubmitting || selectedCount === 0}
                onClick={() => void modifySelected()}
                className={clsx('inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}
              >
                {isSubmitting || isGenerating ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ShieldCheck className="h-4 w-4" />}
                {interactive ? `帮我修改 ${selectedCount} 项` : availabilityLabel || '暂不可审核'}
              </button>
            </div>
          </div>
          <div className={clsx('flex items-center gap-2 border-t px-4 py-2 text-[11px]', isDark ? 'border-white/10 text-neutral-600' : 'border-[var(--ui-border)] text-[var(--ui-text-disabled)]')}>
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            先生成可审核草稿，确认后才会写回正文
          </div>
        </>
      )}
    </section>
  );
}
