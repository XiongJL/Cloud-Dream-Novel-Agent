import type {
    AgentChapterScope,
    AgentChapterSnapshot,
    ChapterScopeCoverage,
    ChapterScopeEvidence,
} from './agentChapterScope';

export type ExpertReportArtifactType =
    | 'writer_revision_plan'
    | 'chapter_range_review'
    | 'reader_journey'
    | 'worldbuilding_consistency'
    | 'research_fact_check'
    | 'scope_audit';

export type ExpertAgentRole =
    | 'writer'
    | 'editor'
    | 'reader'
    | 'worldbuilding'
    | 'research_rag'
    | 'supervisor';

export type ExpertFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingDecisionStatus = 'accepted' | 'rejected' | 'deferred';
export type AgentArtifactReviewStatus = 'unreviewed' | 'in_review' | 'reviewed' | 'stale';
export type AgentRevisionTaskStatus = 'open' | 'planned' | 'deferred' | 'resolved' | 'closed' | 'stale';
export type AgentRevisionTaskEntryReason = 'accepted' | 'deferred' | 'failed' | 'cancelled' | 'interrupted' | 'legacy';

export interface ExpertFinding {
    findingId: string;
    title: string;
    summary: string;
    category: string;
    severity: ExpertFindingSeverity;
    chapterIds: string[];
    expert: ExpertAgentRole;
    evidenceRefs: string[];
    evidence?: ChapterScopeEvidence[];
    recommendation?: string;
    recommendedRole?: ExpertAgentRole;
    uncertainty?: string;
}

export interface ExpertReportPayload {
    artifactId: string;
    novelId: string;
    runId: string;
    planId: string;
    type: ExpertReportArtifactType;
    title: string;
    expert: ExpertAgentRole;
    scope: AgentChapterScope;
    findings: ExpertFinding[];
    sourceSnapshot: AgentChapterSnapshot[];
    coverage?: ChapterScopeCoverage;
    summary?: string;
    generatedAt: string;
}

export function normalizeExpertReportFindingIds(report: ExpertReportPayload): ExpertReportPayload {
    const seen = new Set<string>();
    const findings = report.findings.map((finding, index) => {
        const baseId = finding.findingId.trim() || `finding-auto-${index + 1}`;
        let findingId = baseId;
        let suffix = 2;
        while (seen.has(findingId)) {
            findingId = `${baseId}__${suffix}`;
            suffix += 1;
        }
        seen.add(findingId);
        return findingId === finding.findingId ? finding : { ...finding, findingId };
    });
    return findings.every((finding, index) => finding === report.findings[index])
        ? report
        : { ...report, findings };
}

export interface FindingDecision {
    findingId: string;
    status: FindingDecisionStatus;
    note?: string;
}

export interface AgentArtifactReviewRecord {
    artifactId: string;
    reviewStatus: AgentArtifactReviewStatus;
    reviewRevision: number;
    decisions: FindingDecision[];
    staleChapterIds: string[];
    reviewedAt?: string;
}

export interface ArtifactReviewSubmitInput {
    artifactId: string;
    expectedReviewRevision: number;
    decisions: FindingDecision[];
    createRevisionTasks?: boolean;
}

export interface AgentRevisionTask {
    revisionTaskId: string;
    novelId: string;
    sourceArtifactId: string;
    sourceFindingId: string;
    title: string;
    description: string;
    targetChapterIds: string[];
    sourceExpert: ExpertAgentRole;
    severity: ExpertFindingSeverity;
    recommendedRole: ExpertAgentRole;
    status: AgentRevisionTaskStatus;
    sourceSnapshot: AgentChapterSnapshot[];
    note?: string;
    planId?: string;
    plan?: Record<string, unknown>;
    sourceConversationId?: string;
    sourceRunId?: string;
    entryReason: AgentRevisionTaskEntryReason;
    createdAt: string;
    updatedAt: string;
}

export interface ArtifactReviewSubmitResult {
    review: AgentArtifactReviewRecord;
    revisionTasks: AgentRevisionTask[];
}

export interface RevisionTaskListFilters {
    novelId: string;
    chapterId?: string;
    expert?: ExpertAgentRole;
    severity?: ExpertFindingSeverity;
    status?: AgentRevisionTaskStatus;
}

export interface RevisionTaskCreatePlanInput {
    revisionTaskId: string;
    threadId?: string;
    locale?: string;
    role?: ExpertAgentRole;
    availableTools: string[];
    availableToolchains?: Array<Record<string, unknown>>;
}

export interface RevisionTaskCreatePlanResult {
    task: AgentRevisionTask;
    plan: {
        planId: string;
        threadId: string;
        title: string;
        goal: string;
        requiresApproval: true;
        preferredRole: string;
        deliverable?: string;
        steps: Array<{
            stepId: string;
            agent: string;
            title: string;
            tools: string[];
            toolchain?: Record<string, unknown>;
            status: 'pending';
        }>;
    };
}

export interface RevisionTaskUpdateStatusInput {
    revisionTaskId: string;
    expectedUpdatedAt: string;
    status: Extract<AgentRevisionTaskStatus, 'open' | 'deferred' | 'resolved' | 'closed'>;
}

export interface RevisionTaskSyncRunInput {
    novelId: string;
    sourceArtifactId: string;
    sourceConversationId: string;
    sourceRunId?: string;
    findingIds: string[];
    completedFindingIds?: string[];
    outcome: 'completed' | 'committed' | 'failed' | 'cancelled' | 'interrupted';
}

export interface RevisionTaskSyncRunResult {
    revisionTasks: AgentRevisionTask[];
}
