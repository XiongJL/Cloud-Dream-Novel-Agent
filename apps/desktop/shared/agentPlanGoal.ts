import {
    selectAgentConversationHistory,
    type AgentConversationContextMessage,
} from './agentConversationContext';

const PLAN_CONTEXT_SEPARATOR = '\n\n会话背景（仅用于理解当前任务）：\n';

export type AgentPlanGoalParts = {
    currentGoal: string;
    conversationContext: string;
};

export function buildAgentPlanGoal(message: string, history: AgentConversationContextMessage[]): string {
    const current = String(message || '').trim();
    const recent = selectAgentConversationHistory(history, 12);
    if (!recent.length) return current;
    const context = recent
        .map((item) => `${item.role === 'user' ? '用户' : 'Agent'}：${item.content}`)
        .join('\n');
    return `${current}${PLAN_CONTEXT_SEPARATOR}${context}`;
}

export function splitAgentPlanGoal(goal: string): AgentPlanGoalParts {
    const value = String(goal || '');
    const separatorIndex = value.indexOf(PLAN_CONTEXT_SEPARATOR);
    if (separatorIndex < 0) {
        return { currentGoal: value.trim(), conversationContext: '' };
    }
    return {
        currentGoal: value.slice(0, separatorIndex).trim(),
        conversationContext: value.slice(separatorIndex + PLAN_CONTEXT_SEPARATOR.length).trim(),
    };
}
