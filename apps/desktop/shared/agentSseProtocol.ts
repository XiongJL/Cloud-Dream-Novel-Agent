export type RecoverableAgentRunStatus =
    | 'idle'
    | 'waiting_approval'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'cancelling';

export type ParsedSseFrame = {
    eventName: string;
    data: string;
};

const TERMINAL_EVENT_TYPES = new Set(['run_completed', 'run_failed', 'run_cancelled']);
const LIVE_RUN_STATUSES = new Set<RecoverableAgentRunStatus>(['running', 'cancelling', 'waiting_approval']);

export function parseSseFrame(frame: string): ParsedSseFrame | null {
    const lines = frame.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim();
            continue;
        }
        if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
        }
    }
    if (dataLines.length === 0) return null;
    return { eventName, data: dataLines.join('\n') };
}

export function consumeSseChunk(buffer: string, chunk: string): { buffer: string; frames: ParsedSseFrame[] } {
    const normalized = `${buffer}${chunk}`.replace(/\r\n/g, '\n');
    const rawFrames = normalized.split('\n\n');
    const remaining = rawFrames.pop() || '';
    return {
        buffer: remaining,
        frames: rawFrames.map(parseSseFrame).filter((frame): frame is ParsedSseFrame => frame !== null),
    };
}

export function isTerminalRunEvent(type: string): boolean {
    return TERMINAL_EVENT_TYPES.has(type);
}

export function shouldApplyRunSequence(sequence: number, lastSequence: number): boolean {
    return Number.isFinite(sequence) && sequence > lastSequence;
}

export function shouldResubscribeRun(
    status: RecoverableAgentRunStatus,
    localLastSequence: number,
    remoteLastSequence: number,
): boolean {
    return LIVE_RUN_STATUSES.has(status) || localLastSequence < remoteLastSequence;
}
