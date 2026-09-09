export type ResponsesStreamResult = {
    text: string;
    model?: string;
    responseId?: string;
    usage?: Record<string, unknown>;
    finishReason?: string;
    eventCount: number;
};

export type ResponsesStreamErrorKind = 'output_truncated' | 'response_failed' | 'invalid_event' | 'stream_incomplete';

/**
 * A provider response failure is not a transport failure. Keep the partial
 * result and provider evidence attached so the caller can checkpoint it and
 * choose the correct recovery path.
 */
export class ResponsesStreamError extends Error {
    public readonly kind: ResponsesStreamErrorKind;
    public readonly partialText: string;
    public readonly terminationReason?: string;
    public readonly responseId?: string;
    public readonly model?: string;
    public readonly usage?: Record<string, unknown>;
    public readonly providerErrorCode?: string;

    constructor(input: {
        kind: ResponsesStreamErrorKind;
        message: string;
        partialText?: string;
        terminationReason?: string;
        responseId?: string;
        model?: string;
        usage?: Record<string, unknown>;
        providerErrorCode?: string;
    }) {
        super(input.message);
        this.name = 'ResponsesStreamError';
        this.kind = input.kind;
        this.partialText = input.partialText || '';
        this.terminationReason = input.terminationReason;
        this.responseId = input.responseId;
        this.model = input.model;
        this.usage = input.usage;
        this.providerErrorCode = input.providerErrorCode;
    }
}

export function extractResponsesOutput(json: any): string {
    if (typeof json?.output_text === 'string') return json.output_text;
    if (!Array.isArray(json?.output)) return '';

    const parts: string[] = [];
    for (const item of json.output) {
        if (typeof item?.content === 'string') {
            parts.push(item.content);
            continue;
        }
        if (!Array.isArray(item?.content)) continue;
        for (const content of item.content) {
            if (typeof content?.text === 'string') {
                parts.push(content.text);
            } else if (typeof content?.content === 'string') {
                parts.push(content.content);
            }
        }
    }
    return parts.join('\n').trim();
}

function eventErrorMessage(event: any): string {
    return String(
        event?.error?.message
        || event?.response?.error?.message
        || event?.message
        || event?.response?.incomplete_details?.reason
        || 'Responses stream failed',
    );
}

function responseEvidence(response: any): {
    responseId?: string;
    model?: string;
    usage?: Record<string, unknown>;
    terminationReason?: string;
    providerErrorCode?: string;
} {
    const usage = response?.usage && typeof response.usage === 'object' && !Array.isArray(response.usage)
        ? response.usage as Record<string, unknown>
        : undefined;
    return {
        responseId: typeof response?.id === 'string' ? response.id : undefined,
        model: typeof response?.model === 'string' ? response.model : undefined,
        usage,
        terminationReason: typeof response?.incomplete_details?.reason === 'string'
            ? response.incomplete_details.reason
            : typeof response?.status === 'string' && response.status !== 'completed'
                ? response.status
                : undefined,
        providerErrorCode: typeof response?.error?.code === 'string' ? response.error.code : undefined,
    };
}

export type ResponsesStreamOptions = {
    onActivity?: () => void;
};

export async function consumeResponsesStream(
    response: Response,
    options: ResponsesStreamOptions = {},
): Promise<ResponsesStreamResult> {
    if (!response.body) {
        throw new Error('Responses stream body is unavailable');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedText = '';
    let completedText = '';
    let completedResponse: any = null;
    let latestResponse: any = null;
    let receivedCompletion = false;
    let eventCount = 0;

    const consumeBlock = (block: string) => {
        const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();
        if (!data || data === '[DONE]') return;

        let event: any;
        try {
            event = JSON.parse(data);
        } catch {
            throw new ResponsesStreamError({
                kind: 'invalid_event',
                message: 'Responses stream returned an invalid JSON event',
                partialText: streamedText || completedText,
                ...responseEvidence(latestResponse),
            });
        }
        eventCount += 1;
        if (event?.response && typeof event.response === 'object') latestResponse = event.response;

        if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            streamedText += event.delta;
            return;
        }
        if (event?.type === 'response.output_text.done' && typeof event.text === 'string') {
            completedText = event.text;
            return;
        }
        if (event?.type === 'response.completed') {
            completedResponse = event.response;
            if (event.response?.status && event.response.status !== 'completed') {
                const evidence = responseEvidence(event.response);
                throw new ResponsesStreamError({
                    kind: evidence.terminationReason === 'max_output_tokens' ? 'output_truncated' : 'response_failed',
                    message: eventErrorMessage(event),
                    partialText: streamedText || completedText || extractResponsesOutput(event.response),
                    ...evidence,
                });
            }
            receivedCompletion = true;
            return;
        }
        if (event?.type === 'response.failed' || event?.type === 'response.incomplete' || event?.type === 'error') {
            const responseValue = event.response && typeof event.response === 'object' ? event.response : {};
            const evidence = responseEvidence(responseValue);
            const terminationReason = evidence.terminationReason
                || (typeof event?.reason === 'string' ? event.reason : undefined);
            throw new ResponsesStreamError({
                kind: event.type === 'response.incomplete' && terminationReason === 'max_output_tokens'
                    ? 'output_truncated'
                    : 'response_failed',
                message: eventErrorMessage(event),
                partialText: streamedText || completedText || extractResponsesOutput(responseValue),
                ...evidence,
                terminationReason,
                providerErrorCode: evidence.providerErrorCode
                    || (typeof event?.error?.code === 'string' ? event.error.code : undefined)
                    || (terminationReason?.toLowerCase().includes('content_filter') ? terminationReason : undefined),
            });
        }

        const compatibilityDelta = event?.choices?.[0]?.delta?.content;
        if (typeof compatibilityDelta === 'string') {
            streamedText += compatibilityDelta;
        }
    };

    const consumeAvailableBlocks = () => {
        buffer = buffer.replace(/\r\n/gu, '\n');
        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex >= 0) {
            const block = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            consumeBlock(block);
            separatorIndex = buffer.indexOf('\n\n');
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength > 0) options.onActivity?.();
            buffer += decoder.decode(value, { stream: true });
            consumeAvailableBlocks();
        }
        buffer += decoder.decode();
        consumeAvailableBlocks();
        if (buffer.trim()) consumeBlock(buffer.replace(/\r\n/gu, '\n'));
        // EOF (including a gateway's [DONE]) is not proof that generation
        // completed. Never publish partial prose without the Responses terminal event.
        if (!receivedCompletion) {
            throw new ResponsesStreamError({
                kind: 'stream_incomplete',
                message: 'Responses stream ended before response.completed',
                partialText: streamedText || completedText || extractResponsesOutput(latestResponse),
                ...responseEvidence(latestResponse),
                terminationReason: 'missing_completion_event',
            });
        }
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }

    const evidence = responseEvidence(completedResponse || latestResponse);
    return {
        text: (streamedText || completedText || extractResponsesOutput(completedResponse)).trim(),
        model: evidence.model,
        responseId: evidence.responseId,
        usage: evidence.usage,
        finishReason: evidence.terminationReason || 'completed',
        eventCount,
    };
}
