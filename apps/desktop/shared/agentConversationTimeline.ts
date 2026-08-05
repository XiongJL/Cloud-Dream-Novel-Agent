export type TimelineMessage = {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string;
    attachmentIds?: string[];
};

export type TimelinePlan = {
    planId: string;
    threadId: string;
    title: string;
    goal: string;
    requiresApproval: boolean;
    steps: unknown[];
};

export type TimelineRun = {
    runId: string;
    events: Array<{ type: string; createdAt: string }>;
    planSnapshot?: TimelinePlan;
};

export type TimelineUserInputResolution = {
    requestId: string;
    phase: 'pre_plan' | 'execution';
    resolvedAt: string;
    request?: { runId?: string };
    plan?: { planId: string };
    run?: { runId: string };
};

export type AgentConversationTimelineEntry =
    | { kind: 'message'; key: string; timestamp: number; message: TimelineMessage }
    | { kind: 'task'; key: string; timestamp: number; plan: TimelinePlan; run: TimelineRun | null; resolutions: TimelineUserInputResolution[] }
    | { kind: 'resolution'; key: string; timestamp: number; resolution: TimelineUserInputResolution };

export function agentDateTimestamp(value: unknown, fallback: number): number {
    if (value instanceof Date) {
        const parsed = value.getTime();
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : fallback;
    }
    const parsed = typeof value === 'string' && value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function mergeAgentRunHistory<T extends { runId: string }>(runs: T[] | undefined, run: T): T[] {
    return [run, ...(runs ?? []).filter((item) => item.runId !== run.runId)];
}

export function buildAgentConversationTimeline({
    messages,
    runs,
    currentRun,
    currentPlan,
    resolutions,
    updatedAt,
}: {
    messages: TimelineMessage[];
    runs?: TimelineRun[];
    currentRun: TimelineRun | null;
    currentPlan: TimelinePlan | null;
    resolutions?: TimelineUserInputResolution[];
    updatedAt: string;
}): AgentConversationTimelineEntry[] {
    const fallback = agentDateTimestamp(updatedAt, Date.now());
    const runMap = new Map<string, TimelineRun>();
    for (const run of runs ?? []) runMap.set(run.runId, run);
    if (currentRun) runMap.set(currentRun.runId, currentRun);

    const entries: Array<AgentConversationTimelineEntry & { order: number }> = messages.map((message, order) => ({
        kind: 'message',
        key: `message:${message.id}`,
        timestamp: agentDateTimestamp(message.createdAt, fallback),
        message,
        order,
    }));

    for (const run of runMap.values()) {
        const plan = run.planSnapshot ?? (currentRun?.runId === run.runId ? currentPlan : null);
        if (!plan) continue;
        const started = run.events.find((event) => event.type === 'run_started') ?? run.events[0];
        entries.push({
            kind: 'task',
            key: `run:${run.runId}`,
            timestamp: agentDateTimestamp(started?.createdAt, fallback),
            plan,
            run,
            resolutions: [],
            order: entries.length,
        });
    }

    if (currentPlan && !currentRun) {
        entries.push({
            kind: 'task',
            key: `plan:${currentPlan.planId}`,
            timestamp: fallback,
            plan: currentPlan,
            run: null,
            resolutions: [],
            order: entries.length,
        });
    }

    for (const resolution of resolutions ?? []) {
        const runId = resolution.request?.runId || resolution.run?.runId;
        const planId = resolution.plan?.planId;
        const task = entries.find((entry) => entry.kind === 'task' && (
            (runId && entry.run?.runId === runId)
            || (planId && entry.plan.planId === planId)
        ));
        if (task?.kind === 'task') {
            task.resolutions.push(resolution);
            continue;
        }
        entries.push({
            kind: 'resolution',
            key: `resolution:${resolution.requestId}`,
            timestamp: agentDateTimestamp(resolution.resolvedAt, fallback),
            resolution,
            order: entries.length,
        });
    }

    for (const entry of entries) {
        if (entry.kind !== 'task') continue;
        entry.resolutions.sort((left, right) => (
            agentDateTimestamp(left.resolvedAt, fallback) - agentDateTimestamp(right.resolvedAt, fallback)
        ));
    }

    return entries
        .sort((left, right) => left.timestamp - right.timestamp || left.order - right.order)
        .map(({ order: _order, ...entry }) => entry);
}
