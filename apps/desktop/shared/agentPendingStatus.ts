export type AgentPendingPhase = 'thinking' | 'understanding' | 'planning' | 'revising' | 'retrying';

export interface AgentPendingStatus {
    conversationId: string;
    phase: AgentPendingPhase;
    retryAttempt?: number;
    retryLimit?: number;
}
export function pendingAgentStatusLabel(status: AgentPendingStatus): string {
    if (status.phase === 'understanding') return '正在理解任务...';
    if (status.phase === 'planning') return '正在整理执行计划...';
    if (status.phase === 'revising') return '正在按意见调整计划...';
    if (status.phase === 'retrying') {
        const attempt = Number(status.retryAttempt);
        const limit = Number(status.retryLimit);
        return Number.isInteger(attempt) && attempt > 0 && Number.isInteger(limit) && limit >= attempt
            ? `网络波动，正在重试 ${attempt}/${limit}`
            : '网络波动，正在重试...';
    }
    return '思考中...';
}
