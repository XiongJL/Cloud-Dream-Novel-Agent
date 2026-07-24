export type AgentRuntimeAvailability = 'starting' | 'ready' | 'slow' | 'recovering' | 'failed';

export type RuntimeHealthPolicyState = {
    consecutiveFailures: number;
    activeInvocations: number;
    autoRestartAttempted: boolean;
};

export type RuntimeHealthFailureDecision = {
    availability: 'slow' | 'recovering';
    consecutiveFailures: number;
    shouldAutoRestart: boolean;
};

export const AGENT_RUNTIME_HEALTH_FAILURE_THRESHOLD = 3;
export const AGENT_RUNTIME_RECOVERY_BACKOFF_MS = 1_000;

export function recordRuntimeHealthFailure(
    state: RuntimeHealthPolicyState,
): RuntimeHealthFailureDecision {
    const consecutiveFailures = state.consecutiveFailures + 1;
    const shouldAutoRestart = consecutiveFailures >= AGENT_RUNTIME_HEALTH_FAILURE_THRESHOLD
        && state.activeInvocations === 0
        && !state.autoRestartAttempted;
    return {
        availability: shouldAutoRestart ? 'recovering' : 'slow',
        consecutiveFailures,
        shouldAutoRestart,
    };
}
