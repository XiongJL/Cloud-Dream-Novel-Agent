import { net } from 'electron';
import type { AiEmbeddingSettings } from '../types';
import { devLog, devLogError, redactForLog } from '../../debug/devLogger';

export interface EmbeddingClientResult {
    embeddings: number[][];
    model: string;
    dimensions: number;
    provider: 'openai-compatible';
}

function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function transportFetch(url: string, init: RequestInit): Promise<Response> {
    try {
        return await net.fetch(url, init as any);
    } catch {
        return await fetch(url, init);
    }
}

function normalizeEmbedding(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function resolveEmbeddingUrl(baseUrl: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    if (normalized.endsWith('/embeddings')) return normalized;
    if (normalized.endsWith('/v1')) return joinUrl(normalized, 'embeddings');
    return joinUrl(normalized, 'v1/embeddings');
}

export class EmbeddingClient {
    constructor(private readonly settings: AiEmbeddingSettings) { }

    isEnabled(): boolean {
        return Boolean(this.settings.enabled && this.settings.baseUrl.trim() && this.settings.model.trim());
    }

    async embed(input: string[]): Promise<EmbeddingClientResult> {
        if (!this.isEnabled()) {
            throw new Error('Embedding API is disabled or incomplete.');
        }
        const texts = input.map((item) => String(item || '').trim()).filter(Boolean);
        if (texts.length === 0) {
            return {
                embeddings: [],
                model: this.settings.model,
                dimensions: this.settings.dimensions || 0,
                provider: 'openai-compatible',
            };
        }

        const controller = new AbortController();
        const timeout = Math.max(1000, this.settings.timeoutMs || 60000);
        let didTimeout = false;
        const timer = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeout);
        const url = resolveEmbeddingUrl(this.settings.baseUrl);
        const body: Record<string, unknown> = {
            model: this.settings.model,
            input: texts,
        };
        if (this.settings.dimensions && Number.isFinite(this.settings.dimensions)) {
            body.dimensions = this.settings.dimensions;
        }
        const startedAt = Date.now();

        try {
            devLog('INFO', 'EmbeddingClient.embed.request', 'Embedding request', {
                url,
                timeoutMs: timeout,
                body: redactForLog(body),
                inputCount: texts.length,
            });
            const res = await transportFetch(url, {
                method: 'POST',
                headers: {
                    ...(this.settings.apiKey.trim() ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            const raw = await res.text();
            let json: any = null;
            try {
                json = JSON.parse(raw);
            } catch {
                json = null;
            }
            if (!res.ok) {
                throw new Error(json?.error?.message || `Embedding API rejected: ${res.status} ${raw.slice(0, 240)}`);
            }

            const data = Array.isArray(json?.data) ? json.data : [];
            const embeddings = data
                .sort((a: any, b: any) => Number(a?.index || 0) - Number(b?.index || 0))
                .map((item: any) => normalizeEmbedding(item?.embedding))
                .filter((item: number[]) => item.length > 0);
            const dimensions = embeddings[0]?.length || this.settings.dimensions || 0;
            if (embeddings.length !== texts.length) {
                throw new Error(`Embedding API returned ${embeddings.length} vectors for ${texts.length} inputs.`);
            }

            devLog('INFO', 'EmbeddingClient.embed.response', 'Embedding response ok', {
                url,
                elapsedMs: Date.now() - startedAt,
                inputCount: texts.length,
                dimensions,
                model: json?.model || this.settings.model,
            });
            return {
                embeddings,
                model: json?.model || this.settings.model,
                dimensions,
                provider: 'openai-compatible',
            };
        } catch (error) {
            devLogError('EmbeddingClient.embed.error', error, {
                url,
                elapsedMs: Date.now() - startedAt,
                didTimeout,
                requestBody: redactForLog(body),
            });
            if (didTimeout) {
                throw new Error(`Embedding API timeout after ${timeout}ms`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}
