type TerminalRunStatus = {
    runId: string;
    status: string;
};

/** Only authoritative terminal responses may stop a live UI task. */
export function reconcileTerminalRunStatus<T extends TerminalRunStatus>(current: T, status: TerminalRunStatus & Partial<T>): T {
    if (current.runId !== status.runId
        || !['running', 'cancelling', 'waiting_approval', 'waiting_user_input'].includes(current.status)
        || !['completed', 'failed', 'cancelled'].includes(status.status)) return current;
    return { ...current, ...status };
}
