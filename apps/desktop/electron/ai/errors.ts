export type AiErrorCode =
    | 'INVALID_INPUT'
    | 'CONTEXT_INPUT_TOO_LARGE'
    | 'CONTEXT_PROTECTED_INPUT_TOO_LARGE'
    | 'CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH'
    | 'CONTEXT_TOKEN_COUNTER_UNAVAILABLE'
    | 'CONTEXT_COMPACTION_TIMEOUT'
    | 'CONTEXT_COMPACTION_ABORTED'
    | 'CONTEXT_COMPACTION_INVALID'
    | 'CONTEXT_COMPACTION_CONFLICT'
    | 'CONTEXT_REBUILD_IN_PROGRESS'
    | 'CONTEXT_PRECOMPRESSION_IN_PROGRESS'
    | 'CONTEXT_COMPACTION_REBUILD_LIMIT'
    | 'CONTEXT_COMPACTION_CIRCUIT_OPEN'
    | 'CONTEXT_BUDGET_UNSATISFIABLE'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PROVIDER_AUTH'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_RATE_LIMITED'
    | 'PROVIDER_UNAVAILABLE'
    | 'PROVIDER_FILTERED'
    | 'NETWORK_ERROR'
    | 'PERSISTENCE_ERROR'
    | 'MODEL_OUTPUT_INVALID'
    | 'MODEL_OUTPUT_TRUNCATED'
    | 'MODEL_RESULT_TOO_LARGE'
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

const AI_ERROR_CODES = new Set<AiErrorCode>([
    'INVALID_INPUT',
    'CONTEXT_INPUT_TOO_LARGE',
    'CONTEXT_PROTECTED_INPUT_TOO_LARGE',
    'CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH',
    'CONTEXT_TOKEN_COUNTER_UNAVAILABLE',
    'CONTEXT_COMPACTION_TIMEOUT',
    'CONTEXT_COMPACTION_ABORTED',
    'CONTEXT_COMPACTION_INVALID',
    'CONTEXT_COMPACTION_CONFLICT',
    'CONTEXT_REBUILD_IN_PROGRESS',
    'CONTEXT_PRECOMPRESSION_IN_PROGRESS',
    'CONTEXT_COMPACTION_REBUILD_LIMIT',
    'CONTEXT_COMPACTION_CIRCUIT_OPEN',
    'CONTEXT_BUDGET_UNSATISFIABLE',
    'NOT_FOUND',
    'CONFLICT',
    'PROVIDER_AUTH',
    'PROVIDER_TIMEOUT',
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_FILTERED',
    'NETWORK_ERROR',
    'PERSISTENCE_ERROR',
    'MODEL_OUTPUT_INVALID',
    'MODEL_OUTPUT_TRUNCATED',
    'MODEL_RESULT_TOO_LARGE',
    'CANCELLED',
    'UNKNOWN',
]);

function isAiErrorCode(value: unknown): value is AiErrorCode {
    return typeof value === 'string' && AI_ERROR_CODES.has(value as AiErrorCode);
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

    if (error && typeof error === 'object') {
        const structured = error as {
            code?: unknown;
            message?: unknown;
            detail?: unknown;
            details?: unknown;
        };
        if (isAiErrorCode(structured.code)) {
            const message = typeof structured.message === 'string'
                ? structured.message
                : String(structured.message ?? structured.code);
            const detail = typeof structured.detail === 'string' ? structured.detail : undefined;
            const details = structured.details && typeof structured.details === 'object' && !Array.isArray(structured.details)
                ? structured.details as Record<string, unknown>
                : undefined;
            return new AiActionError(structured.code, message, detail, details);
        }
    }

    const msg = error instanceof Error ? error.message : String(error ?? 'unknown error');
    return fromMessage(msg);
}

export function formatAiErrorForDisplay(code: AiErrorCode, fallback?: string): string {
    switch (code) {
        case 'INVALID_INPUT':
            return '参数不完整或格式错误，请检查输入。';
        case 'CONTEXT_INPUT_TOO_LARGE':
            return '当前消息超过模型可用上下文，请改用附件、缩小范围或分批发送。';
        case 'CONTEXT_PROTECTED_INPUT_TOO_LARGE':
            return '当前任务的必要状态超过模型可用上下文，请缩小章节范围或减少活动任务。';
        case 'CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH':
            return '当前消息与已保存会话不一致，请刷新会话后重试。';
        case 'CONTEXT_TOKEN_COUNTER_UNAVAILABLE':
            return '当前模型缺少可靠的上下文计数档案，请切换受支持模型或配置模型窗口。';
        case 'CONTEXT_COMPACTION_TIMEOUT':
            return '上下文摘要超时，已保留原摘要。';
        case 'CONTEXT_COMPACTION_ABORTED':
            return '上下文摘要已取消。';
        case 'CONTEXT_COMPACTION_INVALID':
            return '上下文摘要校验失败，已保留原摘要。';
        case 'CONTEXT_COMPACTION_CONFLICT':
            return '会话上下文已被其他请求更新，请重试。';
        case 'CONTEXT_REBUILD_IN_PROGRESS':
            return '会话上下文正在后台重建，本次将使用受限但可信的上下文。';
        case 'CONTEXT_PRECOMPRESSION_IN_PROGRESS':
            return '会话上下文正在后台预压缩，本次继续使用当前可信摘要。';
        case 'CONTEXT_COMPACTION_REBUILD_LIMIT':
            return '会话上下文重建已达到分块或耗时上限，旧摘要保持不变。';
        case 'CONTEXT_COMPACTION_CIRCUIT_OPEN':
            return '上下文摘要连续失败，已暂停自动重试并使用受限上下文。';
        case 'CONTEXT_BUDGET_UNSATISFIABLE':
            return '当前窗口无法同时容纳必要能力描述、任务上下文和回复空间，请减少能力范围或改用更大窗口。';
        case 'NOT_FOUND':
            return '目标数据不存在，可能已被删除。';
        case 'CONFLICT':
            return '当前操作与现有数据冲突，请调整后重试。';
        case 'MODEL_OUTPUT_INVALID':
            return '模型返回的结构不符合要求，已保存结果并可尝试修复。';
        case 'MODEL_OUTPUT_TRUNCATED':
            return '生成达到本次输出额度，尚未形成完整草稿。';
        case 'MODEL_RESULT_TOO_LARGE':
            return '模型结果超过可恢复存储上限，请缩小任务范围后重试。';
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
