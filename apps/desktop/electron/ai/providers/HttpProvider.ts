import { AiGenerateRequest, AiGenerateResponse, AiHealthCheckResult, AiImageRequest, AiImageResponse, AiProvider, AiSettings } from '../types';
import { AiActionError, type AiErrorCode } from '../errors';
import { devLog, devLogError, redactForLog } from '../../debug/devLogger';
import { net } from 'electron';
import { consumeResponsesStream, extractResponsesOutput, ResponsesStreamError } from './responsesStream';

function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function resolveEndpointUrl(baseUrl: string, endpoint: 'chat/completions' | 'responses' | 'images/generations'): string {
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    if (endpoint === 'responses' && /\/responses$/u.test(normalized)) return normalized;
    if (endpoint === 'chat/completions' && /\/chat\/completions$/u.test(normalized)) return normalized;
    if (endpoint === 'images/generations' && /\/images\/generations$/u.test(normalized)) return normalized;
    return joinUrl(normalized, endpoint);
}

function resolveModelsUrl(baseUrl: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    const apiRoot = normalized
        .replace(/\/chat\/completions$/u, '')
        .replace(/\/responses$/u, '')
        .replace(/\/images\/generations$/u, '');
    return joinUrl(apiRoot, 'models');
}

function parseJsonSafe(text: string): any {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function describeNetworkError(error: any): string {
    const message = String(error?.message || 'unknown error');
    const causeCode = error?.cause?.code || error?.code;
    const causeMessage = error?.cause?.message;
    const parts = [message];
    if (causeCode) {
        parts.push(`code=${causeCode}`);
    }
    if (causeMessage && causeMessage !== message) {
        parts.push(`cause=${causeMessage}`);
    }
    return parts.join(' | ');
}

function summarizeGenerationBody(body: Record<string, any>): Record<string, any> {
    const summary = { ...body };
    if (typeof summary.instructions === 'string') {
        summary.instructions = `[${summary.instructions.length} chars]`;
    }
    if (typeof summary.input === 'string') {
        summary.input = `[${summary.input.length} chars]`;
    }
    if (Array.isArray(summary.messages)) {
        summary.messages = summary.messages.map((message: any) => ({
            role: message?.role,
            contentChars: typeof message?.content === 'string' ? message.content.length : undefined,
        }));
    }
    return summary;
}

function describeHttpError(response: Response, text: string, json: any): string {
    if (typeof json?.error?.message === 'string' && json.error.message.trim()) {
        return json.error.message.trim();
    }
    const htmlTitle = text.match(/<title[^>]*>([^<]+)<\/title>/iu)?.[1]?.replace(/\s+/gu, ' ').trim();
    if (htmlTitle) return `HTTP ${response.status}: ${htmlTitle}`;
    const preview = text.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240);
    return `HTTP ${response.status}${preview ? `: ${preview}` : response.statusText ? `: ${response.statusText}` : ''}`;
}

async function transportFetch(url: string, init: RequestInit): Promise<Response> {
    return net.fetch(url, init as any);
}

function providerHttpError(response: Response): AiActionError {
    const status = response.status;
    let code: AiErrorCode = 'INVALID_INPUT';
    let retryable = false;
    if (status === 401 || status === 403) {
        code = 'PROVIDER_AUTH';
    } else if (status === 408) {
        code = 'PROVIDER_TIMEOUT';
        retryable = true;
    } else if (status === 425 || status === 429) {
        code = 'PROVIDER_RATE_LIMITED';
        retryable = true;
    } else if (status >= 500) {
        code = 'PROVIDER_UNAVAILABLE';
        retryable = true;
    }
    return new AiActionError(
        code,
        retryable ? '模型服务暂时不可用。' : '模型服务拒绝了当前请求。',
        undefined,
        { httpStatus: status, retryable },
    );
}

function outputTruncatedError(input: {
    partialText: string;
    terminationReason: string;
    responseId?: string;
    usage?: Record<string, unknown>;
    model?: string;
    requestedMaxTokens: number;
    elapsedMs: number;
}): AiActionError {
    return new AiActionError(
        'MODEL_OUTPUT_TRUNCATED',
        'Model generation reached the configured output limit before completing.',
        undefined,
        {
            retryable: false,
            safeToRetryBeforePublish: true,
            partialText: input.partialText,
            terminationReason: input.terminationReason,
            responseId: input.responseId,
            modelResultRef: input.responseId,
            usage: input.usage,
            model: input.model,
            requestedMaxTokens: input.requestedMaxTokens,
            elapsedMs: input.elapsedMs,
        },
    );
}

export class HttpProvider implements AiProvider {
    public readonly name = 'http' as const;

    constructor(private readonly settings: AiSettings) { }

    async healthCheck(): Promise<AiHealthCheckResult> {
        const { baseUrl, apiKey, timeoutMs } = this.settings.http;
        if (!baseUrl.trim()) {
            return { ok: false, detail: 'HTTP baseUrl is empty' };
        }

        try {
            new URL(baseUrl);
        } catch {
            return { ok: false, detail: 'HTTP baseUrl is invalid' };
        }

        if (!apiKey.trim()) {
            return { ok: false, detail: 'API key is empty' };
        }

        const controller = new AbortController();
        let didTimeout = false;
        const effectiveTimeout = Math.max(1000, timeoutMs);
        const timer = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, effectiveTimeout);
        const url = resolveModelsUrl(baseUrl);
        const startedAt = Date.now();

        try {
            devLog('INFO', 'HttpProvider.healthCheck.request', 'HTTP health check request', {
                url,
                timeoutMs: effectiveTimeout,
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            const res = await transportFetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
                signal: controller.signal,
            });

            if (!res.ok) {
                devLog('WARN', 'HttpProvider.healthCheck.response', 'HTTP health check rejected', {
                    url,
                    status: res.status,
                    elapsedMs: Date.now() - startedAt,
                });
                if ((this.settings.http.apiMode ?? 'chat-completions') === 'responses' && (res.status === 404 || res.status === 405)) {
                    return {
                        ok: true,
                        detail: `Models endpoint is unavailable (${res.status}); use test generate to verify the Responses endpoint.`,
                    };
                }
                return { ok: false, detail: `HTTP provider rejected: ${res.status}` };
            }
            devLog('INFO', 'HttpProvider.healthCheck.response', 'HTTP health check ok', {
                url,
                status: res.status,
                elapsedMs: Date.now() - startedAt,
            });
            return { ok: true, detail: 'HTTP provider is reachable' };
        } catch (error: any) {
            devLogError('HttpProvider.healthCheck.error', error, {
                url,
                elapsedMs: Date.now() - startedAt,
                didTimeout,
            });
            if (didTimeout) {
                return { ok: false, detail: `HTTP health check timed out after ${effectiveTimeout}ms` };
            }
            return { ok: false, detail: `HTTP health check failed: ${describeNetworkError(error)} | url=${url}` };
        } finally {
            clearTimeout(timer);
        }
    }

    async generate(req: AiGenerateRequest): Promise<AiGenerateResponse> {
        const prompt = req.prompt.trim();
        if (!prompt) {
            return { text: '', model: this.settings.http.model };
        }

        const controller = new AbortController();
        const abortFromCaller = () => controller.abort(req.signal?.reason);
        if (req.signal?.aborted) abortFromCaller();
        else req.signal?.addEventListener('abort', abortFromCaller, { once: true });
        let didTimeout = false;
        let timeoutKind: 'operation' | 'first_byte' | 'stream_idle' | undefined;
        const timeout = Math.max(1000, req.timeoutMs ?? this.settings.http.timeoutMs);
        const firstByteTimeout = Math.max(1000, Math.min(timeout, req.firstByteTimeoutMs ?? timeout));
        const streamIdleTimeout = Math.max(1000, Math.min(timeout, req.streamIdleTimeoutMs ?? timeout));
        const abortForTimeout = (kind: typeof timeoutKind) => {
            didTimeout = true;
            timeoutKind = kind;
            controller.abort();
        };
        const operationTimer = setTimeout(() => abortForTimeout('operation'), timeout);
        operationTimer.unref?.();
        let activityTimer: NodeJS.Timeout | undefined = setTimeout(
            () => abortForTimeout('first_byte'),
            firstByteTimeout,
        );
        activityTimer.unref?.();
        let receivedFirstByte = false;
        const markStreamActivity = () => {
            if (activityTimer) clearTimeout(activityTimer);
            activityTimer = setTimeout(() => abortForTimeout('stream_idle'), streamIdleTimeout);
            activityTimer.unref?.();
            req.onActivity?.(receivedFirstByte ? 'chunk' : 'first_byte');
            receivedFirstByte = true;
        };
        const stopActivityTimeout = () => {
            if (activityTimer) clearTimeout(activityTimer);
            activityTimer = undefined;
        };

        const apiMode = this.settings.http.apiMode ?? 'chat-completions';
        const requestedMaxTokens = Math.max(1, Math.floor(req.maxTokens ?? this.settings.http.maxTokens));
        const body = apiMode === 'responses'
            ? {
                model: this.settings.http.model,
                ...(req.systemPrompt ? { instructions: req.systemPrompt } : {}),
                input: prompt,
                max_output_tokens: requestedMaxTokens,
                temperature: req.temperature ?? this.settings.http.temperature,
                stream: true,
            }
            : {
                model: this.settings.http.model,
                messages: [
                    ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
                    { role: 'user', content: prompt },
                ],
                max_tokens: requestedMaxTokens,
                temperature: req.temperature ?? this.settings.http.temperature,
            };
        const url = resolveEndpointUrl(
            this.settings.http.baseUrl,
            apiMode === 'responses' ? 'responses' : 'chat/completions',
        );
        const startedAt = Date.now();

        try {
            devLog('INFO', 'HttpProvider.generate.request', 'AI text generation request', {
                url,
                timeoutMs: timeout,
                firstByteTimeoutMs: firstByteTimeout,
                streamIdleTimeoutMs: streamIdleTimeout,
                body: redactForLog(summarizeGenerationBody(body)),
            });
            const res = await transportFetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.settings.http.apiKey}`,
                    'Content-Type': 'application/json',
                    ...(apiMode === 'responses' ? { Accept: 'text/event-stream' } : {}),
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const contentType = res.headers.get('content-type') || '';
            if (res.ok && apiMode === 'responses' && contentType.includes('text/event-stream')) {
                const streamed = await consumeResponsesStream(res, { onActivity: markStreamActivity });
                stopActivityTimeout();
                devLog('INFO', 'HttpProvider.generate.response', 'AI text generation stream completed', {
                    url,
                    status: res.status,
                    elapsedMs: Date.now() - startedAt,
                    responseId: streamed.responseId,
                    model: streamed.model,
                    eventCount: streamed.eventCount,
                    outputChars: streamed.text.length,
                });
                if (!streamed.text) {
                    throw new Error('Responses stream completed without output text');
                }
                return {
                    text: streamed.text,
                    model: streamed.model || this.settings.http.model,
                    responseId: streamed.responseId,
                    usage: streamed.usage,
                    finishReason: streamed.finishReason,
                    requestedMaxTokens,
                    elapsedMs: Date.now() - startedAt,
                };
            }

            markStreamActivity();
            const text = await res.text();
            stopActivityTimeout();
            const json = parseJsonSafe(text);
            devLog('INFO', 'HttpProvider.generate.response', 'AI text generation response', {
                url,
                status: res.status,
                elapsedMs: Date.now() - startedAt,
                contentType,
                outputChars: text.length,
                responsePreview: text.slice(0, 1000),
            });

            if (!res.ok) {
                const diagnosticMessage = describeHttpError(res, text, json);
                devLog('WARN', 'HttpProvider.generate.rejected', 'AI text generation rejected', {
                    url,
                    status: res.status,
                    diagnosticMessage,
                });
                throw providerHttpError(res);
            }

            if (!json || typeof json !== 'object') {
                throw new AiActionError('MODEL_OUTPUT_INVALID', 'Model service returned an invalid JSON response.', undefined, {
                    retryable: false,
                    partialText: text,
                    requestedMaxTokens,
                    elapsedMs: Date.now() - startedAt,
                });
            }

            const output =
                json?.choices?.[0]?.message?.content ||
                json?.output_text ||
                extractResponsesOutput(json) ||
                json?.content?.[0]?.text ||
                '';

            const responseStatus = typeof json?.status === 'string' ? json.status : undefined;
            const incompleteReason = typeof json?.incomplete_details?.reason === 'string'
                ? json.incomplete_details.reason
                : undefined;
            const finishReason = typeof json?.choices?.[0]?.finish_reason === 'string'
                ? json.choices[0].finish_reason
                : incompleteReason || responseStatus;
            const outputText = typeof output === 'string' ? output : JSON.stringify(output);
            if (finishReason === 'length' || finishReason === 'max_output_tokens') {
                throw outputTruncatedError({
                    partialText: outputText,
                    terminationReason: finishReason || 'incomplete',
                    responseId: typeof json?.id === 'string' ? json.id : undefined,
                    usage: json?.usage && typeof json.usage === 'object' ? json.usage : undefined,
                    model: typeof json?.model === 'string' ? json.model : this.settings.http.model,
                    requestedMaxTokens,
                    elapsedMs: Date.now() - startedAt,
                });
            }
            if (responseStatus === 'incomplete') {
                const filtered = String(incompleteReason || '').toLowerCase().includes('content_filter');
                throw new AiActionError(
                    filtered ? 'PROVIDER_FILTERED' : 'MODEL_OUTPUT_INVALID',
                    filtered
                        ? 'Model response was interrupted by the provider content filter.'
                        : `Model response was incomplete: ${incompleteReason || 'unknown reason'}`,
                    undefined,
                    {
                        retryable: false,
                        partialText: outputText,
                        terminationReason: incompleteReason || 'incomplete',
                        responseId: typeof json?.id === 'string' ? json.id : undefined,
                        modelResultRef: typeof json?.id === 'string' ? json.id : undefined,
                        usage: json?.usage && typeof json.usage === 'object' ? json.usage : undefined,
                        requestedMaxTokens,
                        elapsedMs: Date.now() - startedAt,
                    },
                );
            }
            if (responseStatus === 'failed') {
                const providerErrorCode = String(json?.error?.code || 'response_failed');
                const filtered = /content_filter|safety/iu.test(providerErrorCode);
                throw new AiActionError(
                    filtered ? 'PROVIDER_FILTERED' : 'PROVIDER_UNAVAILABLE',
                    String(json?.error?.message || 'Model response failed.'),
                    undefined,
                    {
                        retryable: !filtered,
                        providerErrorCode,
                        responseId: typeof json?.id === 'string' ? json.id : undefined,
                        usage: json?.usage && typeof json.usage === 'object' ? json.usage : undefined,
                        requestedMaxTokens,
                        elapsedMs: Date.now() - startedAt,
                    },
                );
            }

            return {
                text: outputText,
                model: json?.model || this.settings.http.model,
                responseId: typeof json?.id === 'string' ? json.id : undefined,
                usage: json?.usage && typeof json.usage === 'object' ? json.usage : undefined,
                finishReason,
                requestedMaxTokens,
                elapsedMs: Date.now() - startedAt,
            };
        } catch (error: any) {
            devLogError('HttpProvider.generate.error', error, {
                url,
                elapsedMs: Date.now() - startedAt,
                didTimeout,
                timeoutKind,
                requestBody: redactForLog(summarizeGenerationBody(body)),
            });
            if (req.signal?.aborted && !didTimeout) {
                throw new AiActionError('CANCELLED', 'AI request cancelled', undefined, { retryable: false });
            }
            if (didTimeout || error?.name === 'AbortError') {
                throw new AiActionError(
                    'PROVIDER_TIMEOUT',
                    '模型请求超时。',
                    undefined,
                    {
                        retryable: true,
                        timeoutKind: timeoutKind ?? 'operation',
                        timeoutMs: timeoutKind === 'first_byte'
                            ? firstByteTimeout
                            : timeoutKind === 'stream_idle'
                                ? streamIdleTimeout
                                : timeout,
                    },
                );
            }
            if (error instanceof AiActionError) {
                throw error;
            }
            if (error instanceof ResponsesStreamError) {
                if (error.kind === 'stream_incomplete') {
                    throw new AiActionError('NETWORK_ERROR', '模型响应流提前结束，未收到生成完成标记。', undefined, {
                        retryable: true,
                        partialText: error.partialText,
                        terminationReason: error.terminationReason,
                        responseId: error.responseId,
                        usage: error.usage,
                        model: error.model || this.settings.http.model,
                        requestedMaxTokens,
                        elapsedMs: Date.now() - startedAt,
                    });
                }
                if (error.kind === 'output_truncated') {
                    throw outputTruncatedError({
                        partialText: error.partialText,
                        terminationReason: error.terminationReason || 'max_output_tokens',
                        responseId: error.responseId,
                        usage: error.usage,
                        model: error.model || this.settings.http.model,
                        requestedMaxTokens,
                        elapsedMs: Date.now() - startedAt,
                    });
                }
                if (error.kind === 'invalid_event') {
                    throw new AiActionError('MODEL_OUTPUT_INVALID', error.message, undefined, {
                        retryable: false,
                        partialText: error.partialText,
                        responseId: error.responseId,
                        modelResultRef: error.responseId,
                        usage: error.usage,
                        requestedMaxTokens,
                        elapsedMs: Date.now() - startedAt,
                    });
                }
                const providerCode = String(error.providerErrorCode || '').toLowerCase();
                const code: AiErrorCode = /auth|api.?key|unauthori[sz]ed|forbidden/iu.test(providerCode)
                    ? 'PROVIDER_AUTH'
                    : providerCode.includes('content_filter') || providerCode.includes('safety')
                        ? 'PROVIDER_FILTERED'
                        : 'PROVIDER_UNAVAILABLE';
                throw new AiActionError(code, error.message, undefined, {
                    retryable: code === 'PROVIDER_UNAVAILABLE',
                    partialText: error.partialText,
                    terminationReason: error.terminationReason,
                    responseId: error.responseId,
                    modelResultRef: error.responseId,
                    usage: error.usage,
                    providerErrorCode: error.providerErrorCode,
                    requestedMaxTokens,
                    elapsedMs: Date.now() - startedAt,
                });
            }
            throw new AiActionError(
                'NETWORK_ERROR',
                '无法连接模型服务。',
                undefined,
                { retryable: true },
            );
        } finally {
            clearTimeout(operationTimer);
            stopActivityTimeout();
            req.signal?.removeEventListener('abort', abortFromCaller);
        }
    }

    async generateImage(req: AiImageRequest): Promise<AiImageResponse> {
        const prompt = req.prompt.trim();
        if (!prompt) {
            return {};
        }

        const controller = new AbortController();
        let didTimeout = false;
        const timeout = Math.max(1000, this.settings.http.timeoutMs);
        const timer = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeout);
        const body = {
            model: req.model || this.settings.http.model,
            prompt,
            size: req.size || '1024x1024',
            output_format: req.outputFormat || 'png',
            watermark: req.watermark ?? true,
        };
        const url = resolveEndpointUrl(this.settings.http.baseUrl, 'images/generations');
        const startedAt = Date.now();

        try {
            devLog('INFO', 'HttpProvider.generateImage.request', 'AI image generation request', {
                url,
                timeoutMs: timeout,
                body: redactForLog(body),
            });
            const res = await transportFetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.settings.http.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const text = await res.text();
            const json = parseJsonSafe(text);
            devLog('INFO', 'HttpProvider.generateImage.response', 'AI image generation response', {
                url,
                status: res.status,
                elapsedMs: Date.now() - startedAt,
                text,
            });

            if (!res.ok) {
                throw new Error(json?.error?.message || `HTTP ${res.status}: ${text.slice(0, 300)}`);
            }

            const first = json?.data?.[0] || {};
            return {
                imageUrl: first.url,
                imageBase64: first.b64_json,
                mimeType: 'image/png',
            };
        } catch (error: any) {
            devLogError('HttpProvider.generateImage.error', error, {
                url,
                elapsedMs: Date.now() - startedAt,
                didTimeout,
                requestBody: redactForLog(body),
            });
            if (didTimeout || error?.name === 'AbortError') {
                throw new Error(`HTTP request timeout after ${timeout}ms`);
            }
            throw new Error(`HTTP request failed: ${describeNetworkError(error)} | url=${url}`);
        } finally {
            clearTimeout(timer);
        }
    }
}
