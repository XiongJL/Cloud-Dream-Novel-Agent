export type ResponsesStreamResult = {
    text: string;
    model?: string;
    responseId?: string;
    eventCount: number;
};

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

export async function consumeResponsesStream(response: Response): Promise<ResponsesStreamResult> {
    if (!response.body) {
        throw new Error('Responses stream body is unavailable');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedText = '';
    let completedText = '';
    let completedResponse: any = null;
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
            throw new Error('Responses stream returned an invalid JSON event');
        }
        eventCount += 1;

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
                throw new Error(eventErrorMessage(event));
            }
            return;
        }
        if (event?.type === 'response.failed' || event?.type === 'response.incomplete' || event?.type === 'error') {
            throw new Error(eventErrorMessage(event));
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
            buffer += decoder.decode(value, { stream: true });
            consumeAvailableBlocks();
        }
        buffer += decoder.decode();
        consumeAvailableBlocks();
        if (buffer.trim()) consumeBlock(buffer.replace(/\r\n/gu, '\n'));
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }

    return {
        text: (streamedText || completedText || extractResponsesOutput(completedResponse)).trim(),
        model: typeof completedResponse?.model === 'string' ? completedResponse.model : undefined,
        responseId: typeof completedResponse?.id === 'string' ? completedResponse.id : undefined,
        eventCount,
    };
}
