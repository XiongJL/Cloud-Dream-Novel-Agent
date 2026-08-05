export type UiAiErrorCode =
    | 'INVALID_INPUT'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PROVIDER_AUTH'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_UNAVAILABLE'
    | 'PROVIDER_FILTERED'
    | 'NETWORK_ERROR'
    | 'PERSISTENCE_ERROR'
    | 'UNKNOWN';

const AI_ERROR_CODES: UiAiErrorCode[] = [
    'INVALID_INPUT',
    'NOT_FOUND',
    'CONFLICT',
    'PROVIDER_AUTH',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_FILTERED',
    'NETWORK_ERROR',
    'PERSISTENCE_ERROR',
    'UNKNOWN',
];

function normalizeCode(code?: string): UiAiErrorCode | undefined {
    if (!code) return undefined;
    const upper = code.toUpperCase();
    return AI_ERROR_CODES.find((item) => item === upper);
}

function toMessage(error: unknown): string {
    if (error instanceof Error) return String(error.message || '');
    return String(error ?? '');
}

function cleanInvokePrefix(message: string): string {
    return message
        .replace(/^Error invoking remote method '[^']+':\s*/i, '')
        .replace(/^Error:\s*/i, '')
        .trim();
}

function hasLikelyMojibake(message: string): boolean {
    if (message.includes('\uFFFD')) return true;
    const suspiciousCharacters = message.match(/[妯鏈闇瑕浣缁鍖棰銆锛鈿馃]/gu) ?? [];
    return suspiciousCharacters.length >= 2 || message.includes('â€') || message.includes('Ã');
}

export function inferAiErrorCode(error: unknown): UiAiErrorCode | undefined {
    const maybeCode = normalizeCode((error as any)?.code);
    if (maybeCode) return maybeCode;

    const message = toMessage(error);
    const codeHit = message.match(/\b(INVALID_INPUT|NOT_FOUND|CONFLICT|PROVIDER_AUTH|PROVIDER_TIMEOUT|PROVIDER_UNAVAILABLE|PROVIDER_FILTERED|NETWORK_ERROR|PERSISTENCE_ERROR|UNKNOWN)\b/i);
    if (codeHit?.[1]) {
        return normalizeCode(codeHit[1]);
    }

    const lower = message.toLowerCase();
    if (lower.includes('timeout') || lower.includes('timed out')) return 'PROVIDER_TIMEOUT';
    if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('api key')) return 'PROVIDER_AUTH';
    if (lower.includes('content_filter') || lower.includes('filtered') || lower.includes('safety')) return 'PROVIDER_FILTERED';
    if (lower.includes('429') || lower.includes('503') || lower.includes('unavailable') || lower.includes('model')) return 'PROVIDER_UNAVAILABLE';
    if (lower.includes('fetch') || lower.includes('network') || lower.includes('econn') || lower.includes('socket')) return 'NETWORK_ERROR';
    if (lower.includes('not found')) return 'NOT_FOUND';
    if (lower.includes('required') || lower.includes('invalid')) return 'INVALID_INPUT';
    return undefined;
}

export function formatAiError(code?: string, t?: (key: string) => string, fallback?: string): string {
    const normalized = normalizeCode(code);
    if (t && normalized) {
        return t('aiError.' + normalized);
    }
    if (t) {
        return t('aiError.UNKNOWN');
    }
    // Fallback when t is not provided (e.g. non-React contexts)
    switch (normalized) {
        case 'INVALID_INPUT': return 'Input is incomplete or invalid.';
        case 'NOT_FOUND': return 'Target data not found.';
        case 'CONFLICT': return 'Operation conflicts with existing data.';
        case 'PROVIDER_AUTH': return 'Authentication failed.';
        case 'PROVIDER_TIMEOUT': return 'Request timed out.';
        case 'PROVIDER_UNAVAILABLE': return 'Model is currently unavailable.';
        case 'PROVIDER_FILTERED': return 'Request was filtered by content policy.';
        case 'NETWORK_ERROR': return 'Network connection failed.';
        case 'PERSISTENCE_ERROR': return 'Write failed.';
        default: return fallback || 'Unknown error.';
    }
}

export function formatAiErrorFromUnknown(error: unknown, t?: (key: string) => string, fallback?: string): string {
    const code = inferAiErrorCode(error);
    if (code) {
        return formatAiError(code, t, fallback);
    }
    const cleaned = cleanInvokePrefix(toMessage(error));
    if (cleaned && !hasLikelyMojibake(cleaned)) return cleaned;
    if (t) return t('aiError.UNKNOWN');
    return fallback || '请求处理失败，请重试。详细错误已写入日志。';
}
