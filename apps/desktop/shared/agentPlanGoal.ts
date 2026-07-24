type PlanGoalHistoryMessage = {
    role: 'user' | 'assistant';
    content: string;
};

export function buildAgentPlanGoal(message: string, history: PlanGoalHistoryMessage[]): string {
    const current = String(message || '').trim();
    const recent = history
        .slice(-12)
        .map((item) => ({ role: item.role, content: String(item.content || '').trim() }))
        .filter((item) => item.content);
    if (!recent.length) return current;
    const context = recent
        .map((item) => `${item.role === 'user' ? '用户' : 'Agent'}：${item.content}`)
        .join('\n');
    return `${current}\n\n会话背景（仅用于理解当前任务）：\n${context}`;
}
