export type ReportReviewAvailability =
  | 'generating'
  | 'waiting'
  | 'ready'
  | 'incomplete'
  | 'blocked';

export function resolveReportReviewAvailability({
  runStatus,
  workspaceBusy,
  runtimeRecoveryPending,
  planPending,
}: {
  runStatus: AgentRunStatus | null | undefined;
  workspaceBusy: boolean;
  runtimeRecoveryPending: boolean;
  planPending: boolean;
}): ReportReviewAvailability {
  if (runStatus === 'running' || runStatus === 'cancelling') return 'generating';
  if (runStatus === 'waiting_approval' || runStatus === 'waiting_user_input') return 'waiting';
  // A terminal parent Run does not invalidate an already-ready Artifact. The
  // report panels perform their own status/revision/staleness checks.
  if (runStatus === 'failed' || runStatus === 'cancelled') return 'ready';
  if (runStatus !== 'completed') return 'blocked';
  if (workspaceBusy || runtimeRecoveryPending || planPending) return 'blocked';
  return 'ready';
}
