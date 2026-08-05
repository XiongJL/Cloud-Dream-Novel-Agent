export type AgentWorkspaceAttentionKind =
    | 'failed'
    | 'waiting_user_input'
    | 'waiting_approval'
    | 'review_ready'
    | 'running'
    | 'idle';

export type AgentWorkspaceAttentionCounts = Record<Exclude<AgentWorkspaceAttentionKind, 'idle'>, number>;

type AttentionEvent = {
    type?: string;
    createdAt?: string;
};

type AttentionArtifact = {
    status?: string;
    reviewStatus?: string;
};

type AttentionRun = {
    runId: string;
    status?: string;
    events?: AttentionEvent[];
    artifacts?: AttentionArtifact[];
    pendingApproval?: unknown;
    pendingUserInput?: unknown;
};

export type AgentWorkspaceAttentionConversation = {
    id: string;
    updatedAt?: string;
    run?: AttentionRun | null;
    pendingUserInput?: unknown;
    attentionAcknowledgedRunId?: string | null;
};

export type AgentWorkspaceAttentionSummary = {
    kind: AgentWorkspaceAttentionKind;
    count: number;
    counts: AgentWorkspaceAttentionCounts;
    targetConversationId: string | null;
    label: string;
    title: string;
};

const ATTENTION_PRIORITY: Exclude<AgentWorkspaceAttentionKind, 'idle'>[] = [
    'failed',
    'waiting_user_input',
    'waiting_approval',
    'review_ready',
    'running',
];

const ATTENTION_LABELS: Record<AgentWorkspaceAttentionKind, string> = {
    failed: '执行失败',
    waiting_user_input: '待回答',
    waiting_approval: '待审批',
    review_ready: '结果待处理',
    running: '运行中',
    idle: '空闲',
};

function artifactNeedsReview(artifact: AttentionArtifact): boolean {
    return artifact.status === 'ready'
        && artifact.reviewStatus !== 'reviewed';
}

export function agentConversationAttentionKind(
    conversation: AgentWorkspaceAttentionConversation,
): AgentWorkspaceAttentionKind {
    const run = conversation.run;
    if (run?.status === 'failed' && conversation.attentionAcknowledgedRunId !== run.runId) return 'failed';
    if (conversation.pendingUserInput || run?.status === 'waiting_user_input' || run?.pendingUserInput) {
        return 'waiting_user_input';
    }
    if (run?.status === 'waiting_approval' || run?.pendingApproval) return 'waiting_approval';
    const hasUnreadResult = run
        && conversation.attentionAcknowledgedRunId !== run.runId
        && (run.status === 'completed' || run.artifacts?.some(artifactNeedsReview));
    if (hasUnreadResult) return 'review_ready';
    if (run && ['running', 'cancelling'].includes(String(run.status))) return 'running';
    return 'idle';
}

function attentionTimestamp(
    conversation: AgentWorkspaceAttentionConversation,
    kind: AgentWorkspaceAttentionKind,
): number {
    const eventTypes = kind === 'failed'
        ? ['run_failed']
        : kind === 'waiting_user_input'
            ? ['user_input_required']
            : kind === 'waiting_approval'
                ? ['approval_required']
                : kind === 'review_ready'
                    ? ['run_completed', 'artifact_created', 'draft_created']
                    : ['run_started', 'step_started'];
    const event = [...(conversation.run?.events ?? [])]
        .reverse()
        .find((candidate) => eventTypes.includes(String(candidate.type)));
    const parsed = Date.parse(event?.createdAt || conversation.updatedAt || '');
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function summaryTitle(counts: AgentWorkspaceAttentionCounts): string {
    const parts: string[] = [];
    if (counts.failed) parts.push(`${counts.failed} 个任务失败`);
    if (counts.waiting_user_input) parts.push(`${counts.waiting_user_input} 个任务待回答`);
    if (counts.waiting_approval) parts.push(`${counts.waiting_approval} 个任务待审批`);
    if (counts.review_ready) parts.push(`${counts.review_ready} 个结果待处理`);
    if (counts.running) parts.push(`${counts.running} 个任务运行中`);
    return parts.length > 0 ? `Agent：${parts.join('，')}` : 'Agent 模式';
}

export function projectAgentWorkspaceAttention(
    conversations: AgentWorkspaceAttentionConversation[],
): AgentWorkspaceAttentionSummary {
    const counts: AgentWorkspaceAttentionCounts = {
        failed: 0,
        waiting_user_input: 0,
        waiting_approval: 0,
        review_ready: 0,
        running: 0,
    };
    const grouped = new Map<Exclude<AgentWorkspaceAttentionKind, 'idle'>, AgentWorkspaceAttentionConversation[]>();
    for (const kind of ATTENTION_PRIORITY) grouped.set(kind, []);

    for (const conversation of conversations) {
        const kind = agentConversationAttentionKind(conversation);
        if (kind === 'idle') continue;
        counts[kind] += 1;
        grouped.get(kind)?.push(conversation);
    }

    const kind = ATTENTION_PRIORITY.find((candidate) => counts[candidate] > 0) ?? 'idle';
    const candidates = kind === 'idle' ? [] : grouped.get(kind) ?? [];
    const target = [...candidates].sort((left, right) => (
        attentionTimestamp(left, kind) - attentionTimestamp(right, kind)
    ))[0];

    return {
        kind,
        count: kind === 'idle' ? 0 : counts[kind],
        counts,
        targetConversationId: target?.id ?? null,
        label: ATTENTION_LABELS[kind],
        title: summaryTitle(counts),
    };
}
