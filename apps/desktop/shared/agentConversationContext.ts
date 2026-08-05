export type AgentConversationMessageKind = 'chat' | 'role_status' | 'workflow_notice' | 'context_compression';

export type AgentConversationContextMessage = {
    id?: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt?: string;
    kind?: AgentConversationMessageKind;
};

export type AgentConversationHistoryMessage = {
    role: 'user' | 'assistant';
    content: string;
    messageId?: string;
    createdAt?: string;
};

const CONTEXT_COMPRESSION_MESSAGE_KIND = 'agent_context_compression_v1';
const LEGACY_ROLE_STATUS_PATTERN = /^已切换到(?:团队|作者|编辑|读者|世界观|考据)模式。当前工作模式决定是否形成计划草稿和调用工具。$/;
const CURRENT_ROLE_STATUS_PATTERN = /^当前角色：(团队|作者|编辑|读者|世界观|考据)。后续响应与工具链将按此角色执行。$/;
const LEGACY_WORKFLOW_NOTICE_PATTERNS = [
    /^你可以直接讨论创作问题。当前工作模式为“需要用户审核”：我可以先读取项目上下文；生成草稿或写回前会提供可修改计划供你确认。$/,
    /^这里适合讨论卷纲、章节目标和情节推进。当前版本先保留为本地会话占位。$/,
    /^这里可以沉淀角色讨论记录，后续会接入真实历史会话。$/,
    /^世界观会话用于约束设定和术语，避免跨章节冲突。$/,
    /^读者模式适合模拟普通读者的理解成本、情绪反馈和追读动力。$/,
    /^已生成计划草稿：[\s\S]+。你可以忽略、提交修改意见，或选择“实施此计划”。$/,
    /^已忽略当前计划草稿，回到普通会话。$/,
    /^计划已按意见修订：[\s\S]+$/,
];

function isSerializedContextCompression(content: string): boolean {
    const trimmed = String(content || '').trim();
    if (!trimmed.startsWith('{') || !trimmed.includes(CONTEXT_COMPRESSION_MESSAGE_KIND)) return false;
    try {
        const parsed = JSON.parse(trimmed) as { kind?: unknown };
        return parsed.kind === CONTEXT_COMPRESSION_MESSAGE_KIND;
    } catch {
        return false;
    }
}

export function isLegacyRoleStatusNotice(content: string): boolean {
    const normalized = String(content || '').trim();
    return LEGACY_ROLE_STATUS_PATTERN.test(normalized) || CURRENT_ROLE_STATUS_PATTERN.test(normalized);
}

export function isLegacyWorkflowNotice(content: string): boolean {
    const normalized = String(content || '').trim();
    return LEGACY_WORKFLOW_NOTICE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function inferAgentConversationMessageKind(
    message: Pick<AgentConversationContextMessage, 'role' | 'content' | 'kind'>,
): AgentConversationMessageKind {
    if (message.kind) return message.kind;
    if (message.role === 'system' && isSerializedContextCompression(message.content)) return 'context_compression';
    if (message.role === 'assistant' && isLegacyRoleStatusNotice(message.content)) return 'role_status';
    if (message.role === 'assistant' && isLegacyWorkflowNotice(message.content)) return 'workflow_notice';
    return 'chat';
}

export function isAgentConversationUiNotice(
    message: Pick<AgentConversationContextMessage, 'role' | 'content' | 'kind'>,
): boolean {
    const kind = inferAgentConversationMessageKind(message);
    return kind === 'role_status' || kind === 'workflow_notice';
}

export function selectAgentConversationHistory(
    messages: AgentConversationContextMessage[],
    limit?: number,
): AgentConversationHistoryMessage[] {
    const eligible = messages.flatMap((message) => {
        if (message.role !== 'user' && message.role !== 'assistant') return [];
        if (isAgentConversationUiNotice(message)) return [];
        const content = String(message.content || '').trim();
        if (!content) return [];
        return [{
            role: message.role,
            content,
            ...(message.id ? { messageId: message.id } : {}),
            ...(message.createdAt ? { createdAt: message.createdAt } : {}),
        }];
    });
    return typeof limit === 'number' && Number.isFinite(limit)
        ? eligible.slice(-Math.max(0, Math.floor(limit)))
        : eligible;
}
