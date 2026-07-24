export type AiErrorCode =
    | 'INVALID_INPUT'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PROVIDER_AUTH'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_RATE_LIMITED'
    | 'PROVIDER_UNAVAILABLE'
    | 'PROVIDER_FILTERED'
    | 'NETWORK_ERROR'
    | 'PERSISTENCE_ERROR'
    | 'CANCELLED'
    | 'UNKNOWN';

export class AiActionError extends Error {
    public readonly code: AiErrorCode;
    public readonly detail?: string;
    public readonly details?: Record<string, unknown>;

    constructor(
        code: AiErrorCode,
        message: string,
        detail?: string,
        details?: Record<string, unknown>,
    ) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.details = details;
        this.name = 'AiActionError';
    }
}

function fromMessage(message: string): AiActionError {
    const text = message.toLowerCase();
    if (text.includes('cancelled') || text.includes('canceled')) {
        return new AiActionError('CANCELLED', message);
    }
    if (text.includes('timed out') || text.includes('timeout') || text.includes('aborterror') || text.includes('aborted')) {
        return new AiActionError('PROVIDER_TIMEOUT', message);
    }
    if (text.includes('401') || text.includes('403') || text.includes('unauthorized') || text.includes('forbidden') || text.includes('api key')) {
        return new AiActionError('PROVIDER_AUTH', message);
    }
    if (text.includes('content_filter') || text.includes('safety') || text.includes('filtered')) {
        return new AiActionError('PROVIDER_FILTERED', message);
    }
    if (text.includes('429') || text.includes('503') || text.includes('model') || text.includes('unavailable')) {
        return new AiActionError('PROVIDER_UNAVAILABLE', message);
    }
    if (text.includes('fetch') || text.includes('network') || text.includes('econn')) {
        return new AiActionError('NETWORK_ERROR', message);
    }
    return new AiActionError('UNKNOWN', message);
}

export function normalizeAiError(error: unknown): AiActionError {
    if (error instanceof AiActionError) {
        return error;
    }

    const msg = error instanceof Error ? error.message : String(error ?? 'unknown error');
    return fromMessage(msg);
}

export function formatAiErrorForDisplay(code: AiErrorCode, fallback?: string): string {
    switch (code) {
        case 'INVALID_INPUT':
            return '参数不完整或格式错误，请检查输入。';
        case 'NOT_FOUND':
            return '目标数据不存在，可能已被删除。';
        case 'CONFLICT':
            return '当前操作与现有数据冲突，请调整后重试。';
        case 'PROVIDER_AUTH':
            return '模型鉴权失败，请检查 API Key 或权限。';
        case 'PROVIDER_TIMEOUT':
            return '模型请求超时，请稍后重试。';
        case 'PROVIDER_RATE_LIMITED':
            return '模型服务请求较多，请稍后重试。';
        case 'PROVIDER_UNAVAILABLE':
            return '模型暂不可用，请稍后重试或切换模型。';
        case 'PROVIDER_FILTERED':
            return '请求触发内容策略限制，请调整提示词。';
        case 'NETWORK_ERROR':
            return '网络连接失败，请检查网络或代理设置。';
        case 'PERSISTENCE_ERROR':
            return '写入失败，数据未成功保存。';
        case 'CANCELLED':
            return '请求已取消。';
        case 'UNKNOWN':
        default:
            return fallback || '未知错误，请稍后重试。';
    }
}
