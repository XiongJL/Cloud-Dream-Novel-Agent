export type ActivityRunStatus = 'idle' | 'waiting_approval' | 'waiting_user_input' | 'running' | 'completed' | 'failed' | 'cancelled' | 'cancelling';

export type ActivityEvent = {
    eventId: string;
    sequence: number;
    stepId?: string;
    type: string;
    toolName?: string;
    status?: string;
    payload: Record<string, unknown>;
    createdAt: string;
};

export type ActivityDetail = {
    eventId: string;
    sequence: number;
    kind: 'status' | 'step' | 'tool' | 'approval' | 'artifact' | 'error' | 'model' | 'command';
    title: string;
    summary?: string;
    status: 'running' | 'completed' | 'failed' | 'waiting' | 'cancelled' | 'info';
    createdAt: string;
    metadata: Array<{ label: string; value: string; mono?: boolean }>;
};

export type AgentActivityProjection = {
    summary: string;
    tone: 'running' | 'completed' | 'failed' | 'waiting' | 'cancelled' | 'idle';
    details: ActivityDetail[];
    toolCount: number;
    draftCount: number;
    elapsedMs: number | null;
    retry: RetryActivityState | null;
};

export type ChatActivityEvent = {
    eventId: string;
    sequence: number;
    requestId: string;
    callId?: string;
    type: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    displayName: string;
    createdAt: string;
    toolName?: string;
    elapsedMs?: number;
    details?: Record<string, unknown>;
};

export type ChatActivityProjection = Pick<AgentActivityProjection, 'summary' | 'tone' | 'details'>;

export type RetryActivityState = {
    phase: 'scheduled' | 'started' | 'succeeded' | 'exhausted' | 'resuming';
    retryAttempt: number;
    retryLimit: number;
    stage: string;
    httpStatus: number | null;
    diagnosticRef: string;
    retryable: boolean;
};

type ChatTerminalStatus = 'completed' | 'failed' | 'cancelled';

const SENSITIVE_KEY = /(?:authorization|api[-_]?key|token|secret|password|cookie)/iu;
const MAX_VALUE_LENGTH = 1200;

function sanitizeUnknown(value: unknown, depth = 0): unknown {
    if (depth > 5) return '[内容过深]';
    if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeUnknown(item, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .slice(0, 50)
                .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[已脱敏]' : sanitizeUnknown(item, depth + 1)]),
        );
    }
    return value;
}

function asText(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null || value === undefined) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function safeValue(label: string, value: unknown): string {
    if (SENSITIVE_KEY.test(label)) return '[已脱敏]';
    const text = asText(sanitizeUnknown(value))
        .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, '$1[已脱敏]')
        .replace(/((?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s,"'}]+/giu, '$1[已脱敏]');
    return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}...` : text;
}

function payloadText(payload: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const text = safeValue(key, payload[key]);
        if (text) return text;
    }
    return '';
}

function metadataFromPayload(payload: Record<string, unknown>): ActivityDetail['metadata'] {
    const fields: Array<[string, string, boolean?]> = [
        ['传输', 'transport', true],
        ['参数', 'args', true],
        ['命令', 'command', true],
        ['工作目录', 'cwd', true],
        ['退出码', 'exitCode', true],
        ['任务编号', 'operationId', true],
        ['任务状态', 'operationStatus'],
        ['阶段', 'phase'],
        ['尝试次数', 'attempt'],
        ['耗时', 'durationMs'],
        ['标准输出', 'stdout', true],
        ['错误输出', 'stderr', true],
    ];
    return fields.flatMap(([label, key, mono]) => {
        const value = safeValue(key, payload[key]);
        if (!value) return [];
        return [{ label, value: key === 'durationMs' ? `${value} ms` : value, mono }];
    });
}

function chatDetailFromEvent(event: ChatActivityEvent): ActivityDetail {
    const kind: ActivityDetail['kind'] = event.type.startsWith('tool_')
        ? 'tool'
        : event.type.startsWith('model_')
            ? 'model'
            : event.status === 'failed' ? 'error' : 'status';
    const metadata: ActivityDetail['metadata'] = [
        ...(typeof event.elapsedMs === 'number'
            ? [{ label: '耗时', value: `${Math.max(0, Math.round(event.elapsedMs))} ms` }]
            : []),
        ...(event.details?.errorCode
            ? [{ label: '错误码', value: safeValue('errorCode', event.details.errorCode), mono: true }]
            : []),
    ];
    return {
        eventId: event.eventId,
        sequence: event.sequence,
        kind,
        title: event.displayName,
        ...(event.toolName ? { summary: event.toolName } : {}),
        status: event.status,
        createdAt: event.createdAt,
        metadata,
    };
}

function completedChatTitle(title: string): string {
    return title.startsWith('正在') ? `已${title.slice(2)}` : title;
}

function cancelledChatTitle(title: string): string {
    return title.startsWith('正在') ? `${title.slice(2)}已取消` : title;
}

function chatCallFamily(type: string): 'tool' | 'model' | null {
    if (type.startsWith('tool_')) return 'tool';
    if (type.startsWith('model_')) return 'model';
    return null;
}

function chatCallKey(event: ChatActivityEvent): string | null {
    const family = chatCallFamily(event.type);
    return family && event.callId ? `${family}\u0000${event.callId}` : null;
}

function isChatCallStarted(event: ChatActivityEvent): boolean {
    return event.type === 'tool_started' || event.type === 'model_started';
}

function isChatCallTerminal(event: ChatActivityEvent): boolean {
    return event.type === 'tool_completed' || event.type === 'tool_failed' || event.type === 'model_completed';
}

function coalesceChatActivityDetails(
    events: ChatActivityEvent[],
    live: boolean,
    requestTerminalStatus: ChatTerminalStatus | null,
): ActivityDetail[] {
    const details: ActivityDetail[] = [];
    const runningCalls = new Map<string, number>();

    for (const event of events) {
        const detail = chatDetailFromEvent(event);
        const key = chatCallKey(event);
        if (isChatCallStarted(event) && key) {
            runningCalls.set(key, details.length);
            details.push(detail);
            continue;
        }
        if (isChatCallTerminal(event) && key) {
            const index = runningCalls.get(key);
            if (index !== undefined) {
                const started = details[index];
                details[index] = {
                    ...started,
                    kind: detail.kind,
                    title: detail.title,
                    summary: detail.summary || started.summary,
                    status: detail.status,
                    metadata: mergeMetadata(started.metadata, detail.metadata),
                };
                runningCalls.delete(key);
                continue;
            }
        }
        details.push(detail);
    }

    if (live || !requestTerminalStatus) return details;
    const fallbackStatus = requestTerminalStatus === 'cancelled' ? 'cancelled' : 'completed';
    return details.map((detail) => detail.status === 'running'
        ? {
            ...detail,
            title: fallbackStatus === 'completed'
                ? completedChatTitle(detail.title)
                : cancelledChatTitle(detail.title),
            status: fallbackStatus,
        }
        : detail);
}

export function projectChatActivity(events: ChatActivityEvent[], live = false): ChatActivityProjection {
    const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
    const latest = orderedEvents.at(-1);
    if (!latest) {
        return { summary: '等待处理请求', tone: live ? 'running' : 'idle', details: [] };
    }
    const requestTerminal = [...orderedEvents].reverse().find((event) => [
        'request_completed',
        'request_failed',
        'request_cancelled',
    ].includes(event.type));
    const terminalStatus = requestTerminal?.status === 'completed'
        || requestTerminal?.status === 'failed'
        || requestTerminal?.status === 'cancelled'
        ? requestTerminal.status
        : null;
    const finalEvent = requestTerminal ?? latest;
    const tone: ChatActivityProjection['tone'] = live
        ? 'running'
        : finalEvent.status === 'failed'
            ? 'failed'
            : finalEvent.status === 'cancelled'
                ? 'cancelled'
                : finalEvent.status === 'completed' ? 'completed' : 'running';
    const summary = live
        ? latest.displayName
        : finalEvent.status === 'failed'
            ? '请求处理失败'
            : finalEvent.status === 'cancelled' ? '请求已取消' : '请求处理完成';
    const details = coalesceChatActivityDetails(orderedEvents, live, terminalStatus);
    return { summary, tone, details };
}

function numberFromPayload(payload: Record<string, unknown>, key: string): number | null {
    const value = payload[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requestStage(payload: Record<string, unknown>): string {
    const nodeId = payloadText(payload, 'nodeId');
    const method = payloadText(payload, 'method');
    if (nodeId === 'final_report' || method === 'agent.generate_report') return '整理最终回答';
    if (nodeId === 'creative_direction.detect') return '确认创作方向';
    if (method === 'agent.generate_plan') return '整理计划';
    if (method === 'agent.revise_plan') return '修订计划';
    if (method.startsWith('agent.generate_')) return '生成任务结果';
    if (method) return '读取项目资料';
    return '当前步骤';
}

function retryMetadata(payload: Record<string, unknown>): ActivityDetail['metadata'] {
    const retryAttempt = numberFromPayload(payload, 'retryAttempt');
    const retryLimit = numberFromPayload(payload, 'retryLimit');
    const httpStatus = numberFromPayload(payload, 'httpStatus');
    const diagnosticRef = payloadText(payload, 'diagnosticRef');
    return [
        ...(retryAttempt !== null && retryLimit !== null
            ? [{ label: '重试', value: `${retryAttempt}/${retryLimit}` }]
            : []),
        ...(httpStatus !== null ? [{ label: 'HTTP 状态', value: String(httpStatus), mono: true }] : []),
        ...(diagnosticRef ? [{ label: '诊断编号', value: diagnosticRef, mono: true }] : []),
    ];
}

function retryStateFromEvent(event: ActivityEvent | undefined): RetryActivityState | null {
    if (!event) return null;
    const phase = ({
        request_retry_scheduled: 'scheduled',
        request_retry_started: 'started',
        request_retry_succeeded: 'succeeded',
        request_retry_exhausted: 'exhausted',
        run_retry_started: 'resuming',
    } as const)[event.type as 'request_retry_scheduled' | 'request_retry_started' | 'request_retry_succeeded' | 'request_retry_exhausted' | 'run_retry_started'];
    if (!phase) return null;
    const payload = event.payload ?? {};
    const resumedFrom = payload.resumedFrom && typeof payload.resumedFrom === 'object'
        ? payload.resumedFrom as Record<string, unknown>
        : {};
    return {
        phase,
        retryAttempt: numberFromPayload(payload, 'retryAttempt') ?? 0,
        retryLimit: numberFromPayload(payload, 'retryLimit') ?? 3,
        stage: requestStage(Object.keys(resumedFrom).length > 0 ? resumedFrom : payload),
        httpStatus: numberFromPayload(payload, 'httpStatus'),
        diagnosticRef: payloadText(payload, 'diagnosticRef') || payloadText(resumedFrom, 'diagnosticRef'),
        retryable: payload.retryable === true || phase === 'resuming',
    };
}

function detailFromEvent(event: ActivityEvent): ActivityDetail | null {
    const payload = event.payload ?? {};
    const summary = payloadText(payload, 'summary', 'message', 'reason', 'content');
    const base = {
        eventId: event.eventId,
        sequence: event.sequence,
        createdAt: event.createdAt,
        metadata: metadataFromPayload(payload),
    };
    switch (event.type) {
        case 'run_started': return { ...base, kind: 'status', title: '开始执行任务', summary, status: 'running' };
        case 'plan_approved': return { ...base, kind: 'status', title: '计划已批准', summary, status: 'completed' };
        case 'step_started': return { ...base, kind: 'step', title: payloadText(payload, 'title') || '开始执行步骤', status: 'running' };
        case 'step_completed': return { ...base, kind: 'step', title: payloadText(payload, 'title') || '步骤已完成', status: 'completed' };
        case 'step_failed': return { ...base, kind: 'error', title: payloadText(payload, 'title') || '步骤失败', summary, status: 'failed' };
        case 'tool_call': return { ...base, kind: payload.command ? 'command' : 'tool', title: event.toolName || '调用工具', summary, status: 'running' };
        case 'tool_result': return { ...base, kind: payload.command ? 'command' : 'tool', title: event.toolName || '工具结果', summary, status: event.status === 'failed' ? 'failed' : event.status === 'skipped' ? 'cancelled' : 'completed' };
        case 'toolchain_started': return { ...base, kind: 'step', title: payloadText(payload, 'title') || '开始执行工具链', summary: payloadText(payload, 'toolchainId'), status: 'running' };
        case 'toolchain_node_started': return { ...base, kind: payload.kind === 'model' ? 'model' : 'tool', title: payloadText(payload, 'nodeId') || '工具链节点', summary, status: 'running' };
        case 'toolchain_node_completed': return { ...base, kind: event.status === 'failed' ? 'error' : payload.kind === 'model' ? 'model' : 'tool', title: payloadText(payload, 'nodeId') || '工具链节点', summary, status: event.status === 'failed' ? 'failed' : event.status === 'partial' ? 'info' : event.status === 'skipped' ? 'cancelled' : 'completed' };
        case 'toolchain_completed': return { ...base, kind: 'step', title: payloadText(payload, 'title') || '工具链已完成', summary: payloadText(payload, 'toolchainId'), status: 'completed' };
        case 'toolchain_failed': return { ...base, kind: 'error', title: '工具链执行失败', summary, status: 'failed' };
        case 'approval_required': return { ...base, kind: 'approval', title: payloadText(payload, 'title') || '需要你确认', summary: payloadText(payload, 'question', 'reason'), status: 'waiting' };
        case 'user_input_required': return { ...base, kind: 'approval', title: payloadText(payload, 'title') || '需要你决定', summary: payloadText(payload, 'reason'), status: 'waiting' };
        case 'user_input_resolved': return { ...base, kind: 'approval', title: '已提交决定', summary: payloadText(payload, 'understandingSummary'), status: 'completed' };
        case 'draft_created': return { ...base, kind: 'artifact', title: '已生成可审核草稿', summary: payloadText(payload, 'previewSummary'), status: 'completed' };
        case 'draft_operation_started': return { ...base, kind: 'tool', title: '草稿任务已受理', summary: '正在后台生成，可安全重连', status: 'running' };
        case 'draft_operation_progress': {
            const operationStatus = payloadText(payload, 'operationStatus');
            const title = operationStatus === 'retry_wait' ? '草稿任务等待重试'
                : operationStatus === 'running_postprocess' ? '正在整理草稿'
                    : operationStatus === 'committing' ? '正在保存草稿'
                        : operationStatus === 'succeeded' ? '后台草稿任务已完成'
                            : operationStatus === 'definitive_failed' ? '后台草稿任务失败'
                                : operationStatus === 'reconcile_required' ? '草稿任务需要核对'
                                    : operationStatus === 'cancelled' ? '草稿任务已取消'
                                        : '正在后台生成草稿';
            const status = operationStatus === 'succeeded' ? 'completed'
                : operationStatus === 'definitive_failed' || operationStatus === 'reconcile_required' ? 'failed'
                    : operationStatus === 'cancelled' ? 'cancelled'
                        : 'running';
            return { ...base, kind: status === 'failed' ? 'error' : 'tool', title, status };
        }
        case 'artifact_created': {
            const artifact = payload.artifact && typeof payload.artifact === 'object' ? payload.artifact as Record<string, unknown> : {};
            return { ...base, kind: 'artifact', title: `已生成产物：${String(artifact.title || artifact.type || '未命名产物')}`, summary: typeof artifact.summary === 'string' ? artifact.summary : undefined, status: 'completed' };
        }
        case 'error': return { ...base, kind: 'error', title: '执行出现错误', summary, status: 'failed' };
        case 'run_completed': return { ...base, kind: 'status', title: '任务已完成', summary, status: 'completed' };
        case 'run_failed': return { ...base, kind: 'error', title: '任务执行失败', summary, status: 'failed' };
        case 'run_cancelled': return { ...base, kind: 'status', title: '任务已取消', summary, status: 'cancelled' };
        case 'request_retry_scheduled': {
            const attempt = numberFromPayload(payload, 'retryAttempt') ?? 1;
            const limit = numberFromPayload(payload, 'retryLimit') ?? 3;
            return { ...base, kind: 'model', title: `网络波动，准备重试 ${attempt}/${limit}`, summary: requestStage(payload), status: 'waiting', metadata: retryMetadata(payload) };
        }
        case 'request_retry_started': {
            const attempt = numberFromPayload(payload, 'retryAttempt') ?? 1;
            const limit = numberFromPayload(payload, 'retryLimit') ?? 3;
            return { ...base, kind: 'model', title: `正在重试 ${attempt}/${limit}`, summary: requestStage(payload), status: 'running', metadata: retryMetadata(payload) };
        }
        case 'request_retry_succeeded': return { ...base, kind: 'model', title: '连接已恢复', summary: `${requestStage(payload)}将继续`, status: 'completed', metadata: retryMetadata(payload) };
        case 'request_retry_exhausted': return { ...base, kind: 'error', title: '自动重试未能恢复', summary: requestStage(payload), status: 'failed', metadata: retryMetadata(payload) };
        case 'run_retry_started': return { ...base, kind: 'status', title: '正在从失败步骤继续', summary: '已保留原计划与完成结果', status: 'running' };
        case 'message': {
            if (payload.kind === 'approval_submitted') return { ...base, kind: 'approval', title: '已提交确认', summary: payloadText(payload, 'summary', 'content'), status: 'completed' };
            if (payload.kind === 'final_report') return { ...base, kind: 'model', title: '已整理最终回答', status: 'completed' };
            return null;
        }
        default: return null;
    }
}

function mergeMetadata(
    current: ActivityDetail['metadata'],
    incoming: ActivityDetail['metadata'],
): ActivityDetail['metadata'] {
    const merged = new Map(current.map((item) => [item.label, item]));
    for (const item of incoming) merged.set(item.label, item);
    return [...merged.values()];
}

function operationKey(event: ActivityEvent): string {
    return `${event.stepId || ''}\u0000${event.toolName || ''}\u0000${safeValue('nodeId', event.payload?.nodeId)}`;
}

function coalesceActivityDetails(events: ActivityEvent[]): ActivityDetail[] {
    const details: ActivityDetail[] = [];
    const runningSteps = new Map<string, number>();
    const runningTools = new Map<string, number>();
    const runningToolchainNodes = new Map<string, number>();
    const runningToolchains = new Map<string, number>();

    for (const event of events) {
        const detail = detailFromEvent(event);
        if (!detail) continue;
        if (event.type === 'step_started') {
            const key = event.stepId || `title:${detail.title}`;
            runningSteps.set(key, details.length);
            details.push(detail);
            continue;
        }
        if (event.type === 'step_completed' || event.type === 'step_failed') {
            const key = event.stepId || `title:${detail.title}`;
            const index = runningSteps.get(key);
            if (index !== undefined) {
                const current = details[index];
                details[index] = {
                    ...current,
                    kind: event.type === 'step_failed' ? 'error' : current.kind,
                    status: detail.status,
                    summary: detail.summary || current.summary,
                    metadata: mergeMetadata(current.metadata, detail.metadata),
                };
                runningSteps.delete(key);
                continue;
            }
        }
        if (event.type === 'tool_call') {
            runningTools.set(operationKey(event), details.length);
            details.push(detail);
            continue;
        }
        if (event.type === 'toolchain_started') {
            const key = `${event.stepId || ''}\u0000${safeValue('toolchainId', event.payload?.toolchainId)}`;
            runningToolchains.set(key, details.length);
            details.push(detail);
            continue;
        }
        if (event.type === 'toolchain_completed' || event.type === 'toolchain_failed') {
            const key = `${event.stepId || ''}\u0000${safeValue('toolchainId', event.payload?.toolchainId)}`;
            const index = runningToolchains.get(key);
            if (index !== undefined) {
                const current = details[index];
                details[index] = { ...current, kind: detail.kind, status: detail.status, summary: detail.summary || current.summary };
                runningToolchains.delete(key);
                continue;
            }
        }
        if (event.type === 'toolchain_node_started') {
            runningToolchainNodes.set(operationKey(event), details.length);
            details.push(detail);
            continue;
        }
        if (event.type === 'toolchain_node_completed') {
            const key = operationKey(event);
            const index = runningToolchainNodes.get(key);
            if (index !== undefined) {
                const current = details[index];
                details[index] = { ...current, kind: detail.kind, status: detail.status, summary: detail.summary || current.summary };
                runningToolchainNodes.delete(key);
                continue;
            }
        }
        if (event.type === 'tool_result') {
            const key = operationKey(event);
            const index = runningTools.get(key);
            if (index !== undefined) {
                const current = details[index];
                details[index] = {
                    ...current,
                    kind: detail.kind,
                    status: detail.status,
                    summary: detail.summary || current.summary,
                    metadata: mergeMetadata(current.metadata, detail.metadata),
                };
                runningTools.delete(key);
                continue;
            }
        }
        details.push(detail);
    }
    return details;
}

function elapsedBetween(events: ActivityEvent[]): number | null {
    if (events.length < 2) return null;
    const first = Date.parse(events[0].createdAt);
    const last = Date.parse(events[events.length - 1].createdAt);
    return Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first : null;
}

function formatElapsed(milliseconds: number | null): string {
    if (milliseconds === null) return '';
    if (milliseconds < 1000) return `${milliseconds} 毫秒`;
    if (milliseconds < 60000) return `${Math.max(1, Math.round(milliseconds / 1000))} 秒`;
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.round((milliseconds % 60000) / 1000);
    return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

export function projectAgentActivity(run: { status: ActivityRunStatus; events: ActivityEvent[] }): AgentActivityProjection {
    const events = [...(run.events || [])].sort((left, right) => left.sequence - right.sequence);
    const details = coalesceActivityDetails(events);
    const toolCount = events.filter((event) => event.type === 'tool_result' && event.status !== 'skipped').length;
    const draftCount = events.filter((event) => event.type === 'draft_created').length;
    const elapsedMs = elapsedBetween(events);
    const latest = [...events].reverse().find((event) => detailFromEvent(event));
    const latestPayload = latest?.payload ?? {};
    const retryEvent = [...events].reverse().find((event) => [
        'request_retry_scheduled',
        'request_retry_started',
        'request_retry_succeeded',
        'request_retry_exhausted',
        'run_retry_started',
    ].includes(event.type));
    const retry = retryStateFromEvent(retryEvent);

    if (run.status === 'completed') {
        const parts = ['已完成'];
        if (toolCount) parts.push(`调用 ${toolCount} 项工具`);
        if (draftCount) parts.push(`生成 ${draftCount} 份草稿`);
        const elapsed = formatElapsed(elapsedMs);
        if (elapsed) parts.push(elapsed);
        return { summary: parts.join(' · '), tone: 'completed', details, toolCount, draftCount, elapsedMs, retry };
    }
    if (run.status === 'failed') return { summary: payloadText(latestPayload, 'message', 'reason') || '任务执行失败', tone: 'failed', details, toolCount, draftCount, elapsedMs, retry };
    if (run.status === 'cancelled') return { summary: '任务已取消', tone: 'cancelled', details, toolCount, draftCount, elapsedMs, retry };
    if (run.status === 'cancelling') return { summary: '正在取消任务', tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (run.status === 'waiting_approval') return { summary: `需要你确认：${payloadText(latestPayload, 'title') || '执行选项'}`, tone: 'waiting', details, toolCount, draftCount, elapsedMs, retry };
    if (run.status === 'waiting_user_input') return { summary: `需要你决定：${payloadText(latestPayload, 'title') || '关键方向'}`, tone: 'waiting', details, toolCount, draftCount, elapsedMs, retry };

    if (latest?.type === 'request_retry_scheduled' || latest?.type === 'request_retry_started') {
        const attempt = retry?.retryAttempt || 1;
        const limit = retry?.retryLimit || 3;
        return { summary: `网络波动，正在重试 ${attempt}/${limit}`, tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    }
    if (latest?.type === 'request_retry_succeeded') return { summary: '连接已恢复，正在继续', tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'run_retry_started') return { summary: '正在从失败步骤继续', tone: 'running', details, toolCount, draftCount, elapsedMs, retry };

    if (latest?.type === 'draft_operation_started') return { summary: '草稿任务已受理，正在后台生成', tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'draft_operation_progress') {
        const operationStatus = payloadText(latestPayload, 'operationStatus');
        const summary = operationStatus === 'retry_wait' ? '生成暂时中断，后台将自动重试'
            : operationStatus === 'running_postprocess' ? '正文已生成，正在整理草稿'
                : operationStatus === 'committing' ? '正在安全保存草稿'
                    : operationStatus === 'succeeded' ? '草稿生成完成，正在读取结果'
                        : '正在后台生成草稿';
        return { summary, tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    }

    if (latest?.type === 'tool_call') return { summary: `正在调用 ${latest.toolName || '工具'}`, tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'toolchain_started') return { summary: `正在执行${payloadText(latestPayload, 'title') || '工具链'}`, tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'toolchain_node_started') return { summary: `正在处理${payloadText(latestPayload, 'nodeId') || '工具链节点'}`, tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'toolchain_node_completed') return { summary: '当前节点已完成，正在继续', tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'toolchain_completed') return { summary: '工具链已完成，正在整理结果', tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'step_started') return { summary: `正在${payloadText(latestPayload, 'title') || '执行下一步'}`, tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'draft_created') return { summary: '已生成可审核草稿，正在整理结果', tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'message' && latestPayload.kind === 'final_report') return { summary: '正在完成任务', tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'step_completed') return { summary: '当前步骤已完成，正在继续', tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    if (latest?.type === 'tool_result') return { summary: `${latest.toolName || '工具'} 已返回，正在继续`, tone: 'running', details, toolCount, draftCount, elapsedMs, retry };
    return { summary: events.length ? '正在执行任务' : '等待执行', tone: events.length ? 'running' : 'idle', details, toolCount, draftCount, elapsedMs, retry };
}
