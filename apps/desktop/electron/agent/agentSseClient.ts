import http from 'node:http';
import { consumeSseChunk, isTerminalRunEvent } from '../../shared/agentSseProtocol';

export type AgentRunEvent = {
    eventId: string;
    sequence: number;
    runId: string;
    type: string;
    agent?: string;
    toolName?: string;
    status?: string;
    payload?: Record<string, unknown>;
};

export type AgentSseClientOptions = {
    port: number;
    token: string;
    runId: string;
    afterSequence?: number;
    onEvent: (event: AgentRunEvent) => void;
    onDisconnect: (payload: { runId: string; message: string }) => void;
    onParseError?: (error: unknown) => void;
};

export function subscribeAgentRunEventsHttp(options: AgentSseClientOptions): () => void {
    const afterSequence = Number.isFinite(options.afterSequence) ? Number(options.afterSequence) : 0;
    const pathName = `/events/${encodeURIComponent(options.runId)}?afterSequence=${encodeURIComponent(String(afterSequence))}`;
    let closed = false;
    let disconnectNotified = false;
    let request: http.ClientRequest | null = null;

    const notifyDisconnect = (message: string) => {
        if (closed || disconnectNotified) return;
        disconnectNotified = true;
        options.onDisconnect({ runId: options.runId, message });
    };

    request = http.request(
        {
            hostname: '127.0.0.1',
            port: options.port,
            path: pathName,
            method: 'GET',
            headers: {
                Accept: 'text/event-stream',
                Authorization: `Bearer ${options.token}`,
            },
        },
        (response) => {
            if (response.statusCode && response.statusCode >= 400) {
                const message = `Agent event stream failed with status ${response.statusCode}`;
                notifyDisconnect(message);
                response.resume();
                return;
            }

            response.setEncoding('utf8');
            let buffer = '';
            response.on('data', (chunk: string) => {
                const consumed = consumeSseChunk(buffer, chunk);
                buffer = consumed.buffer;
                for (const parsed of consumed.frames) {
                    if (parsed.eventName !== 'agent_run_event') continue;
                    try {
                        const event = JSON.parse(parsed.data) as AgentRunEvent;
                        options.onEvent(event);
                        if (isTerminalRunEvent(event.type)) {
                            closed = true;
                            request?.destroy();
                        }
                    } catch (error) {
                        options.onParseError?.(error);
                    }
                }
            });
            response.on('end', () => {
                notifyDisconnect('Agent event stream ended');
            });
            response.on('error', (error) => {
                notifyDisconnect(error.message || 'Agent event stream error');
            });
        },
    );

    request.on('error', (error) => {
        notifyDisconnect(error.message || 'Agent event stream error');
    });
    request.end();

    return () => {
        closed = true;
        request?.destroy();
    };
}
