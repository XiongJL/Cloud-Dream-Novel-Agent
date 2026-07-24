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

export type AgentConversationTimelineEntry =
    | { kind: 'message'; key: string; timestamp: number; message: TimelineMessage }
    | { kind: 'task'; key: string; timestamp: number; plan: TimelinePlan; run: TimelineRun | null };

function timestamp(value: string | undefined, fallback: number): number {
    const parsed = value ? Date.parse(value) : Number.NaN;
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
    updatedAt,
}: {
    messages: TimelineMessage[];
    runs?: TimelineRun[];
    currentRun: TimelineRun | null;
    currentPlan: TimelinePlan | null;
    updatedAt: string;
}): AgentConversationTimelineEntry[] {
    const fallback = timestamp(updatedAt, Date.now());
    const runMap = new Map<string, TimelineRun>();
    for (const run of runs ?? []) runMap.set(run.runId, run);
    if (currentRun) runMap.set(currentRun.runId, currentRun);

    const entries: Array<AgentConversationTimelineEntry & { order: number }> = messages.map((message, order) => ({
        kind: 'message',
        key: `message:${message.id}`,
        timestamp: timestamp(message.createdAt, fallback),
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
            timestamp: timestamp(started?.createdAt, fallback),
            plan,
            run,
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
            order: entries.length,
        });
    }

    return entries
        .sort((left, right) => left.timestamp - right.timestamp || left.order - right.order)
        .map(({ order: _order, ...entry }) => entry);
}
