export type AgentPendingPhase = 'thinking' | 'understanding' | 'reading' | 'extending' | 'finalizing' | 'planning' | 'revising' | 'retrying';

export interface AgentPendingStatus {
    conversationId: string;
    phase: AgentPendingPhase;
    retryAttempt?: number;
    retryLimit?: number;
    detail?: string;
}
export function pendingAgentStatusLabel(status: AgentPendingStatus): string {
    if (status.phase === 'understanding') return '正在理解任务...';
    if (status.phase === 'planning') return '正在整理执行计划...';
    if (status.phase === 'reading') return status.detail ? `正在读取 ${status.detail}...` : '正在读取附件...';
    if (status.phase === 'extending') return '信息仍不足，正在继续读取...';
    if (status.phase === 'finalizing') return '正在汇总已读取内容...';
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
