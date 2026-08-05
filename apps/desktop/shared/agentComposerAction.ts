export type AgentComposerRunStatus =
    | 'idle'
    | 'waiting_approval'
    | 'waiting_user_input'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'cancelling';

export type AgentComposerAction = {
    mode: 'send' | 'stop' | 'stopping' | 'saving';
    target: 'chat' | 'run' | null;
    disabled: boolean;
    label: string;
};

const ACTIVE_RUN_STATUSES = new Set<AgentComposerRunStatus>([
    'running',
    'waiting_approval',
    'waiting_user_input',
    'cancelling',
]);

export function resolveAgentComposerAction(input: {
    activeChatRequestId?: string | null;
    stoppingChatRequestId?: string | null;
    runStatus?: AgentComposerRunStatus | null;
    draftOperationStatus?: string | null;
}): AgentComposerAction {
    const hasActiveRun = Boolean(input.runStatus && ACTIVE_RUN_STATUSES.has(input.runStatus));

    // Once the draft transaction starts committing, cancelling cannot safely undo it.
    if (hasActiveRun && input.draftOperationStatus === 'committing') {
        return { mode: 'saving', target: 'run', disabled: true, label: '正在保存' };
    }

    if (hasActiveRun) {
        if (input.runStatus === 'cancelling') {
            return { mode: 'stopping', target: 'run', disabled: true, label: '正在停止' };
        }
        return { mode: 'stop', target: 'run', disabled: false, label: '停止任务' };
    }

    if (input.activeChatRequestId) {
        if (input.stoppingChatRequestId === input.activeChatRequestId) {
            return { mode: 'stopping', target: 'chat', disabled: true, label: '正在停止' };
        }
        return { mode: 'stop', target: 'chat', disabled: false, label: '停止任务' };
    }

    return { mode: 'send', target: null, disabled: false, label: '发送' };
}
