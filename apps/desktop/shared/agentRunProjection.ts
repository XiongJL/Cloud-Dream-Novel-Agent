export type ProjectedAgentStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ProjectedAgentRunStatus = 'idle' | 'waiting_approval' | 'waiting_user_input' | 'running' | 'completed' | 'failed' | 'cancelled' | 'cancelling';

export type ProjectedAgentRecovery = {
    failureKind: 'transport' | 'model_output_truncated' | 'model_output_invalid' | 'local_transform_failed' | 'artifact_publish_failed' | 'persistence_failed' | 'side_effect_unknown';
    failedAtPhase: 'model_pending' | 'model_received' | 'normalizing' | 'publishing';
    retryStrategy: 'retry_request' | 'repair_model_output' | 'reprocess_saved_result' | 'resume_publish' | 'reconcile_side_effect' | 'none';
    canRecover: boolean;
    recoveryRevision: number;
    actionLabel?: string;
    blockedReason?: 'processor_update_required' | 'stale_dependency' | 'unsafe_side_effect' | 'repair_exhausted';
    completedArtifactIds: string[];
    affectedArtifactIds: string[];
    diagnosticRef: string;
};

export type ProjectedAgentRunEvent = {
    eventId: string;
    sequence: number;
    runId: string;
    stepId?: string;
    agent?: string;
    toolName?: string;
    status?: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
};

export type ProjectedChapterBeat = {
    title: string;
    chapterGoal: string;
    coreConflict: string;
    keyEvents: string[];
    reveals: string[];
    endingHook: string;
    targetWordCount: number;
    beatId?: string;
    childIndex?: number;
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
        | 'scope_audit'
        | 'novel_bootstrap_draft'
        | 'agent_skill_pack_draft';
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
    freeTextPlaceholder?: string;
    stepId?: string;
    draftBatchId?: string;
    outlineRevision?: number;
    revisionCount?: number;
    maxRevisionCount?: number;
    revisionError?: string;
    beats?: ProjectedChapterBeat[];
};

export type ProjectedChapterBeatResponse = {
    checkpointId: string;
    selectedOptionIds: string[];
    freeText: string;
    summary?: string;
    sequence: number;
    createdAt: string;
};

export type ProjectedChapterBeatTimelineItem =
    | {
        kind: 'activity';
        key: string;
        events: ProjectedAgentRunEvent[];
        status: ProjectedAgentRunStatus;
    }
    | {
        kind: 'checkpoint';
        key: string;
        event: ProjectedAgentRunEvent;
        approval: ProjectedApprovalRequest;
        response?: ProjectedChapterBeatResponse;
        active: boolean;
    }
    | {
        kind: 'revision';
        key: string;
        response: ProjectedChapterBeatResponse;
    };

export type ProjectedUserInputRequest = {
    schemaVersion: 'agent-user-input-v1';
    requestId: string;
    inputSessionId: string;
    conversationId: string;
    phase: 'pre_plan' | 'execution';
    round: 1 | 2 | 3;
    maxRounds: 1 | 2 | 3;
    previousRequestId?: string;
    title: string;
    reason: string;
    questions: Array<{
        questionId: string;
        header: string;
        prompt: string;
        options: Array<{ optionId: string; label: string; description: string }>;
        recommendedOptionId: string;
        recommendationReason: string;
        allowCustom: true;
    }>;
    evidence: Array<{ evidenceId: string; sourceKind: string; sourceId: string; title: string; coverage?: string }>;
    runId?: string;
    stepId?: string;
    createdAt: string;
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
    draftOperationId?: string;
    draftOperationKey?: string;
    draftOperationStatus?: string;
    draftOperationVersion?: number;
    pendingApproval?: ProjectedApprovalRequest | null;
    pendingUserInput?: ProjectedUserInputRequest | null;
    userInputResponses?: Array<Record<string, unknown>>;
    retryOfRunId?: string;
    retryRootRunId?: string;
    retryAttempt?: number;
    failureRevision?: number;
    resumedFrom?: Record<string, unknown>;
    completionKind?: 'complete' | 'partial';
    recovery?: ProjectedAgentRecovery | null;
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
    const beats = (Array.isArray(payload.beats) ? payload.beats : []).flatMap((rawBeat) => {
        if (!rawBeat || typeof rawBeat !== 'object') return [];
        const beat = rawBeat as Record<string, unknown>;
        if (
            typeof beat.title !== 'string'
            || typeof beat.chapterGoal !== 'string'
            || typeof beat.coreConflict !== 'string'
            || typeof beat.endingHook !== 'string'
        ) return [];
        return [{
            title: beat.title,
            chapterGoal: beat.chapterGoal,
            coreConflict: beat.coreConflict,
            keyEvents: Array.isArray(beat.keyEvents) ? beat.keyEvents.filter((item): item is string => typeof item === 'string') : [],
            reveals: Array.isArray(beat.reveals) ? beat.reveals.filter((item): item is string => typeof item === 'string') : [],
            endingHook: beat.endingHook,
            targetWordCount: typeof beat.targetWordCount === 'number' ? beat.targetWordCount : 2000,
            beatId: typeof beat.beatId === 'string' ? beat.beatId : undefined,
            childIndex: typeof beat.childIndex === 'number' ? beat.childIndex : undefined,
        }];
    });
    return {
        checkpointId,
        checkpointType: typeof payload.checkpointType === 'string' ? payload.checkpointType : undefined,
        title,
        question,
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
        options,
        allowFreeText: Boolean(payload.allowFreeText),
        freeTextPlaceholder: typeof payload.freeTextPlaceholder === 'string' ? payload.freeTextPlaceholder : undefined,
        stepId: typeof payload.stepId === 'string' ? payload.stepId : undefined,
        draftBatchId: typeof payload.draftBatchId === 'string' ? payload.draftBatchId : undefined,
        outlineRevision: typeof payload.outlineRevision === 'number' ? payload.outlineRevision : undefined,
        revisionCount: typeof payload.revisionCount === 'number' ? payload.revisionCount : undefined,
        maxRevisionCount: typeof payload.maxRevisionCount === 'number' ? payload.maxRevisionCount : undefined,
        revisionError: typeof payload.revisionError === 'string' ? payload.revisionError : undefined,
        beats: beats.length > 0 ? beats : undefined,
    };
}

function chapterBeatResponseFromEvent(event: ProjectedAgentRunEvent): ProjectedChapterBeatResponse | null {
    if (event.type !== 'message' || event.payload?.kind !== 'approval_submitted') return null;
    const response = event.payload.response;
    if (!response || typeof response !== 'object') return null;
    const item = response as Record<string, unknown>;
    if (item.checkpointType !== 'chapter_beats' || typeof item.checkpointId !== 'string') return null;
    return {
        checkpointId: item.checkpointId,
        selectedOptionIds: Array.isArray(item.selectedOptionIds)
            ? item.selectedOptionIds.filter((value): value is string => typeof value === 'string')
            : [],
        freeText: typeof item.freeText === 'string' ? item.freeText : '',
        summary: typeof item.summary === 'string' ? item.summary : undefined,
        sequence: event.sequence,
        createdAt: event.createdAt,
    };
}

function activitySegmentStatus(
    events: ProjectedAgentRunEvent[],
    runStatus: ProjectedAgentRunStatus,
    tail: boolean,
): ProjectedAgentRunStatus {
    if (events.some((event) => event.type === 'run_failed' || event.status === 'failed')) return 'failed';
    if (events.some((event) => event.type === 'run_cancelled' || event.status === 'cancelled')) return 'cancelled';
    return tail && ['running', 'cancelling'].includes(runStatus) ? runStatus : 'completed';
}

export function projectChapterBeatTimeline(run: ProjectedRun): ProjectedChapterBeatTimelineItem[] {
    const events = [...(run.events ?? [])].sort((left, right) => left.sequence - right.sequence);
    const approvals = events.flatMap((event) => {
        const approval = approvalFromRunEvent(event);
        return approval?.checkpointType === 'chapter_beats' ? [{ event, approval }] : [];
    });
    if (approvals.length === 0) return [];

    const latestEventByCheckpoint = new Map<string, string>();
    approvals.forEach(({ event, approval }) => latestEventByCheckpoint.set(approval.checkpointId, event.eventId));
    const responses = new Map<string, ProjectedChapterBeatResponse>();
    events.forEach((event) => {
        const response = chapterBeatResponseFromEvent(event);
        if (response) responses.set(response.checkpointId, response);
    });

    const items: ProjectedChapterBeatTimelineItem[] = [];
    let activityEvents: ProjectedAgentRunEvent[] = [];
    const flushActivity = (tail: boolean) => {
        if (activityEvents.length === 0) return;
        const first = activityEvents[0];
        const last = activityEvents[activityEvents.length - 1];
        items.push({
            kind: 'activity',
            key: `beat-activity:${first.eventId}:${last.eventId}`,
            events: activityEvents,
            status: activitySegmentStatus(activityEvents, run.status, tail),
        });
        activityEvents = [];
    };

    events.forEach((event, index) => {
        const approval = approvalFromRunEvent(event);
        if (approval?.checkpointType === 'chapter_beats') {
            if (latestEventByCheckpoint.get(approval.checkpointId) !== event.eventId) return;
            flushActivity(false);
            items.push({
                kind: 'checkpoint',
                key: `beat-checkpoint:${approval.checkpointId}`,
                event,
                approval,
                response: responses.get(approval.checkpointId),
                active: run.status === 'waiting_approval'
                    && run.pendingApproval?.checkpointId === approval.checkpointId,
            });
            return;
        }
        const response = chapterBeatResponseFromEvent(event);
        if (response) {
            flushActivity(false);
            if (response.freeText) {
                items.push({
                    kind: 'revision',
                    key: `beat-revision:${event.eventId}`,
                    response,
                });
            }
            return;
        }
        activityEvents.push(event);
        if (index === events.length - 1) flushActivity(true);
    });
    flushActivity(true);
    return items;
}

export function userInputFromRunEvent(event: ProjectedAgentRunEvent): ProjectedUserInputRequest | null {
    if (event.type !== 'user_input_required') return null;
    const payload = event.payload ?? {};
    if (
        payload.schemaVersion !== 'agent-user-input-v1'
        || typeof payload.requestId !== 'string'
        || typeof payload.conversationId !== 'string'
        || !['pre_plan', 'execution'].includes(String(payload.phase))
        || typeof payload.title !== 'string'
        || typeof payload.reason !== 'string'
        || !Array.isArray(payload.questions)
        || payload.questions.length < 1
        || payload.questions.length > 3
    ) return null;
    const questions = payload.questions.flatMap((rawQuestion) => {
        if (!rawQuestion || typeof rawQuestion !== 'object') return [];
        const question = rawQuestion as Record<string, unknown>;
        if (
            typeof question.questionId !== 'string'
            || typeof question.header !== 'string'
            || typeof question.prompt !== 'string'
            || typeof question.recommendedOptionId !== 'string'
            || typeof question.recommendationReason !== 'string'
            || !Array.isArray(question.options)
        ) return [];
        const options = question.options.flatMap((rawOption) => {
            if (!rawOption || typeof rawOption !== 'object') return [];
            const option = rawOption as Record<string, unknown>;
            return typeof option.optionId === 'string' && typeof option.label === 'string' && typeof option.description === 'string'
                ? [{ optionId: option.optionId, label: option.label, description: option.description }]
                : [];
        });
        if (options.length < 2 || options.length > 3 || question.recommendedOptionId !== options[0]?.optionId) return [];
        return [{
            questionId: question.questionId,
            header: question.header,
            prompt: question.prompt,
            options,
            recommendedOptionId: question.recommendedOptionId,
            recommendationReason: question.recommendationReason,
            allowCustom: true as const,
        }];
    });
    if (questions.length !== payload.questions.length) return null;
    const evidence = (Array.isArray(payload.evidence) ? payload.evidence : []).flatMap((rawEvidence) => {
        if (!rawEvidence || typeof rawEvidence !== 'object') return [];
        const item = rawEvidence as Record<string, unknown>;
        if (typeof item.evidenceId !== 'string' || typeof item.sourceKind !== 'string' || typeof item.sourceId !== 'string' || typeof item.title !== 'string') return [];
        return [{ evidenceId: item.evidenceId, sourceKind: item.sourceKind, sourceId: item.sourceId, title: item.title, coverage: typeof item.coverage === 'string' ? item.coverage : undefined }];
    });
    return {
        schemaVersion: 'agent-user-input-v1',
        requestId: payload.requestId,
        inputSessionId: typeof payload.inputSessionId === 'string' ? payload.inputSessionId : payload.requestId,
        conversationId: payload.conversationId,
        phase: payload.phase as 'pre_plan' | 'execution',
        round: payload.round === 3 ? 3 : payload.round === 2 ? 2 : 1,
        maxRounds: payload.maxRounds === 3 ? 3 : payload.maxRounds === 2 ? 2 : 1,
        previousRequestId: typeof payload.previousRequestId === 'string' ? payload.previousRequestId : undefined,
        title: payload.title,
        reason: payload.reason,
        questions,
        evidence,
        runId: typeof payload.runId === 'string' ? payload.runId : undefined,
        stepId: typeof payload.stepId === 'string' ? payload.stepId : undefined,
        createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : event.createdAt,
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

export function getActiveRunUserInput(run: ProjectedRun | null): ProjectedUserInputRequest | null {
    if (!run || run.status !== 'waiting_user_input') return null;
    if (run.pendingUserInput) return run.pendingUserInput;
    for (let index = run.events.length - 1; index >= 0; index -= 1) {
        const request = userInputFromRunEvent(run.events[index]);
        if (request) return request;
    }
    return null;
}

export function getRunRecoverySnapshot(run: ProjectedRun | null): {
    runId: string | null;
    lastSequence: number;
    isLive: boolean;
    draftSessionId: string | null;
    pendingApproval: ProjectedApprovalRequest | null;
    pendingUserInput: ProjectedUserInputRequest | null;
} {
    if (!run) return { runId: null, lastSequence: 0, isLive: false, draftSessionId: null, pendingApproval: null, pendingUserInput: null };
    return {
        runId: run.runId,
        lastSequence: Math.max(0, ...run.events.map((event) => Number(event.sequence) || 0)),
        isLive: ['running', 'cancelling', 'waiting_approval', 'waiting_user_input'].includes(run.status),
        draftSessionId: run.draftSessionId ?? null,
        pendingApproval: getActiveRunApproval(run),
        pendingUserInput: getActiveRunUserInput(run),
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
    const userInput = userInputFromRunEvent(event);
    const userInputResolved = event.type === 'user_input_resolved';
    const draftSessionId = event.type === 'draft_created' && typeof payload.draftSessionId === 'string'
        ? payload.draftSessionId
        : current.run.draftSessionId;
    const draftBatchId = typeof payload.draftBatchId === 'string'
        ? payload.draftBatchId
        : current.run.draftBatchId;
    const draftOperationId = typeof payload.operationId === 'string'
        ? payload.operationId
        : current.run.draftOperationId;
    const draftOperationKey = typeof payload.operationKey === 'string'
        ? payload.operationKey
        : current.run.draftOperationKey;
    const draftOperationStatus = typeof payload.operationStatus === 'string'
        ? payload.operationStatus
        : current.run.draftOperationStatus;
    const draftOperationVersion = typeof payload.operationVersion === 'number'
        ? payload.operationVersion
        : current.run.draftOperationVersion;
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
        draftOperationId,
        draftOperationKey,
        draftOperationStatus,
        draftOperationVersion,
        status: terminalStatus ?? (userInput ? 'waiting_user_input' : userInputResolved ? 'running' : approval ? 'waiting_approval' : approvalSubmitted ? 'running' : current.run.status),
        pendingApproval: approval ?? (approvalSubmitted ? null : current.run.pendingApproval),
        pendingUserInput: userInput ?? (userInputResolved ? null : current.run.pendingUserInput),
        currentStepId: terminalStatus ? undefined : (event.stepId ?? current.run.currentStepId),
        progress: terminalStatus === 'completed' ? 1 : current.run.progress,
        failureRevision: event.type === 'run_failed' && typeof payload.failureRevision === 'number'
            ? payload.failureRevision
            : current.run.failureRevision,
        completionKind: (payload.completionKind === 'complete' || payload.completionKind === 'partial')
            ? payload.completionKind
            : current.run.completionKind,
        recovery: payload.recovery && typeof payload.recovery === 'object' && !Array.isArray(payload.recovery)
            ? payload.recovery as ProjectedAgentRecovery
            : current.run.recovery,
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
