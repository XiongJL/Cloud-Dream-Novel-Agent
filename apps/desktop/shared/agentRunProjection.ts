export type ProjectedAgentStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ProjectedAgentRunStatus = 'idle' | 'waiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled' | 'cancelling';

export type ProjectedAgentRunEvent = {
    eventId: string;
    sequence: number;
    runId: string;
    stepId?: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
};

export type ProjectedAgentArtifact = {
    artifactId: string;
    runId: string;
    planId: string;
    type:
        | 'report'
        | 'context_bundle'
        | 'chapter_scope_context'
        | 'consistency_review'
        | 'plotline_analysis'
        | 'chapter_draft'
        | 'chapter_draft_batch'
        | 'creative_assets_draft'
        | 'writer_revision_plan'
        | 'chapter_range_review'
        | 'reader_journey'
        | 'worldbuilding_consistency'
        | 'research_fact_check'
        | 'scope_audit';
    title: string;
    status: 'ready' | 'committed' | 'discarded' | 'failed';
    summary?: string | null;
    content?: string | null;
    reference: Record<string, unknown>;
    metadata: Record<string, unknown>;
    reviewStatus?: 'unreviewed' | 'in_review' | 'reviewed' | 'stale';
    reviewRevision?: number;
    createdAt: string;
};

export type ProjectedApprovalRequest = {
    checkpointId: string;
    checkpointType?: string;
    title: string;
    question: string;
    reason?: string;
    options: Array<{ id: string; label: string; description?: string }>;
    allowFreeText: boolean;
    stepId?: string;
};

export type ProjectedRun = {
    runId: string;
    threadId: string;
    planId: string;
    status: ProjectedAgentRunStatus;
    currentStepId?: string;
    progress: number;
    events: ProjectedAgentRunEvent[];
    artifacts?: ProjectedAgentArtifact[];
    draftSessionId?: string;
    draftBatchId?: string;
    pendingApproval?: ProjectedApprovalRequest | null;
    retryOfRunId?: string;
    retryRootRunId?: string;
    retryAttempt?: number;
    failureRevision?: number;
    resumedFrom?: Record<string, unknown>;
};

export type ProjectedPlan = {
    steps: Array<{ stepId: string; status: ProjectedAgentStepStatus }>;
};

export type ProjectedMessage = {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string;
};

export type AgentRunProjection = {
    run: ProjectedRun;
    plan: ProjectedPlan | null;
    messages: ProjectedMessage[];
    error: string;
};

export function isConversationMessageEvent(event: ProjectedAgentRunEvent): boolean {
    if (event.type !== 'message' || typeof event.payload?.content !== 'string') return false;
    return event.payload.kind === 'final_report' || event.payload.visibility === 'conversation';
}

export function artifactFromRunEvent(event: ProjectedAgentRunEvent): ProjectedAgentArtifact | null {
    if (event.type !== 'artifact_created') return null;
    const artifact = event.payload?.artifact;
    if (!artifact || typeof artifact !== 'object') return null;
    const item = artifact as Record<string, unknown>;
    if (
        typeof item.artifactId !== 'string'
        || typeof item.runId !== 'string'
        || typeof item.planId !== 'string'
        || ![
            'report',
            'context_bundle',
            'chapter_scope_context',
            'consistency_review',
            'plotline_analysis',
            'chapter_draft',
            'chapter_draft_batch',
            'creative_assets_draft',
            'writer_revision_plan',
            'chapter_range_review',
            'reader_journey',
            'worldbuilding_consistency',
            'research_fact_check',
            'scope_audit',
        ].includes(String(item.type))
        || typeof item.title !== 'string'
    ) return null;
    const status = ['ready', 'committed', 'discarded', 'failed'].includes(String(item.status))
        ? item.status as ProjectedAgentArtifact['status']
        : 'ready';
    return {
        artifactId: item.artifactId,
        runId: item.runId,
        planId: item.planId,
        type: item.type as ProjectedAgentArtifact['type'],
        title: item.title,
        status,
        summary: typeof item.summary === 'string' ? item.summary : null,
        content: typeof item.content === 'string' ? item.content : null,
        reference: item.reference && typeof item.reference === 'object' ? item.reference as Record<string, unknown> : {},
        metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {},
        reviewStatus: ['unreviewed', 'in_review', 'reviewed', 'stale'].includes(String(item.reviewStatus))
            ? item.reviewStatus as ProjectedAgentArtifact['reviewStatus']
            : 'unreviewed',
        reviewRevision: Number.isInteger(item.reviewRevision) ? Number(item.reviewRevision) : 0,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : event.createdAt,
    };
}

export function approvalFromRunEvent(event: ProjectedAgentRunEvent): ProjectedApprovalRequest | null {
    if (event.type !== 'approval_required') return null;
    const payload = event.payload ?? {};
    const checkpointId = typeof payload.checkpointId === 'string' ? payload.checkpointId : '';
    const title = typeof payload.title === 'string' ? payload.title : '';
    const question = typeof payload.question === 'string' ? payload.question : '';
    if (!checkpointId || !title || !question) return null;
    const options = (Array.isArray(payload.options) ? payload.options : [])
        .map((option) => {
            if (!option || typeof option !== 'object') return null;
            const item = option as Record<string, unknown>;
            if (typeof item.id !== 'string' || typeof item.label !== 'string') return null;
            return {
                id: item.id,
                label: item.label,
                description: typeof item.description === 'string' ? item.description : undefined,
            };
        })
        .filter((option): option is NonNullable<typeof option> => option !== null);
    return {
        checkpointId,
        checkpointType: typeof payload.checkpointType === 'string' ? payload.checkpointType : undefined,
        title,
        question,
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
        options,
        allowFreeText: Boolean(payload.allowFreeText),
        stepId: typeof payload.stepId === 'string' ? payload.stepId : undefined,
    };
}

export function getActiveRunApproval(run: ProjectedRun | null): ProjectedApprovalRequest | null {
    if (!run || run.status !== 'waiting_approval') return null;
    if (run.pendingApproval) return run.pendingApproval;
    for (let index = run.events.length - 1; index >= 0; index -= 1) {
        const approval = approvalFromRunEvent(run.events[index]);
        if (approval) return approval;
    }
    return null;
}

export function getRunRecoverySnapshot(run: ProjectedRun | null): {
    runId: string | null;
    lastSequence: number;
    isLive: boolean;
    draftSessionId: string | null;
    pendingApproval: ProjectedApprovalRequest | null;
} {
    if (!run) return { runId: null, lastSequence: 0, isLive: false, draftSessionId: null, pendingApproval: null };
    return {
        runId: run.runId,
        lastSequence: Math.max(0, ...run.events.map((event) => Number(event.sequence) || 0)),
        isLive: ['running', 'cancelling', 'waiting_approval'].includes(run.status),
        draftSessionId: run.draftSessionId ?? null,
        pendingApproval: getActiveRunApproval(run),
    };
}

export function applyAgentRunEvent(
    current: AgentRunProjection,
    event: ProjectedAgentRunEvent,
    createMessageIdentity: () => { id: string; createdAt: string },
): AgentRunProjection {
    if (current.run.runId !== event.runId) return current;
    const payload = event.payload ?? {};
    const messageIdentity = isConversationMessageEvent(event)
        ? createMessageIdentity()
        : null;
    const messages = messageIdentity
        ? [...current.messages, { ...messageIdentity, role: 'assistant' as const, content: payload.content as string }]
        : current.messages;
    const plan = current.plan && event.stepId
        ? {
            ...current.plan,
            steps: current.plan.steps.map((step) => {
                if (step.stepId !== event.stepId) return step;
                const status: ProjectedAgentStepStatus | null = event.type === 'step_started' ? 'running'
                    : event.type === 'step_completed' ? 'completed'
                        : event.type === 'step_failed' ? 'failed'
                            : null;
                return status ? { ...step, status } : step;
            }),
        }
        : current.plan;
    const terminalStatus: ProjectedAgentRunStatus | null = event.type === 'run_completed' ? 'completed'
        : event.type === 'run_failed' ? 'failed'
            : event.type === 'run_cancelled' ? 'cancelled'
                : null;
    const approval = approvalFromRunEvent(event);
    const approvalSubmitted = event.type === 'message' && payload.kind === 'approval_submitted';
    const draftSessionId = event.type === 'draft_created' && typeof payload.draftSessionId === 'string'
        ? payload.draftSessionId
        : current.run.draftSessionId;
    const draftBatchId = typeof payload.draftBatchId === 'string'
        ? payload.draftBatchId
        : current.run.draftBatchId;
    const eventArtifact = artifactFromRunEvent(event);
    const artifacts = eventArtifact && !(current.run.artifacts ?? []).some((item) => item.artifactId === eventArtifact.artifactId)
        ? [...(current.run.artifacts ?? []), eventArtifact]
        : current.run.artifacts;
    const run: ProjectedRun = {
        ...current.run,
        events: [...current.run.events, event],
        artifacts,
        draftSessionId,
        draftBatchId,
        status: terminalStatus ?? (approval ? 'waiting_approval' : approvalSubmitted ? 'running' : current.run.status),
        pendingApproval: approval ?? (approvalSubmitted ? null : current.run.pendingApproval),
        currentStepId: terminalStatus ? undefined : (event.stepId ?? current.run.currentStepId),
        progress: terminalStatus === 'completed' ? 1 : current.run.progress,
        failureRevision: event.type === 'run_failed' && typeof payload.failureRevision === 'number'
            ? payload.failureRevision
            : current.run.failureRevision,
    };
    return {
        run,
        plan,
        messages,
        error: (event.type === 'error' || event.type === 'run_failed') && typeof payload.message === 'string'
            ? payload.message
            : current.error,
    };
}
