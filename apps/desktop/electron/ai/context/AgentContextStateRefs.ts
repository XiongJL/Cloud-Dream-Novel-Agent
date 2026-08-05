import type { AgentConversationCompressionSnapshot } from '../../agent/AgentConversationStore';
import type { ContextAtomicStateRef } from './ContextAtomicUnitBuilder';

function messageIdsFrom(...values: unknown[]): string[] {
    const ids = new Set<string>();
    const visited = new WeakSet<object>();
    const visit = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        if (visited.has(value)) return;
        visited.add(value);
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        const record = value as Record<string, unknown>;
        for (const key of ['sourceMessageId', 'messageId']) {
            const id = String(record[key] || '').trim();
            if (id) ids.add(id);
        }
        if (Array.isArray(record.sourceMessageIds)) {
            for (const item of record.sourceMessageIds) {
                const id = String(item || '').trim();
                if (id) ids.add(id);
            }
        }
        Object.values(record).forEach(visit);
    };
    values.forEach(visit);
    return [...ids].sort();
}

export function buildAgentContextStateRefs(
    snapshot: AgentConversationCompressionSnapshot,
): ContextAtomicStateRef[] {
    const refs = new Map<string, ContextAtomicStateRef>();
    const addRef = (
        kind: ContextAtomicStateRef['kind'],
        id: string,
        status: ContextAtomicStateRef['status'],
        ...sources: unknown[]
    ) => {
        const normalizedId = id.trim();
        if (!normalizedId) return;
        const key = `${kind}:${normalizedId}`;
        const existing = refs.get(key);
        const messageIds = [...new Set([
            ...(existing?.messageIds || []),
            ...messageIdsFrom(...sources),
        ])].sort();
        refs.set(key, {
            kind,
            id: normalizedId,
            status: existing?.status === 'open' || status === 'open' ? 'open' : 'closed',
            ...(messageIds.length ? { messageIds } : {}),
        });
    };

    for (const message of snapshot.messages) {
        for (const [index, read] of (message.contextReads || []).entries()) {
            addRef('tool_result', `${message.messageId}:${read.toolName}:${index}`, 'closed', {
                sourceMessageId: message.messageId,
            });
        }
        for (const attachmentId of message.attachmentIds || []) {
            addRef('attachment', attachmentId, 'closed', { sourceMessageId: message.messageId });
        }
        if (message.evidenceSnapshotId) {
            addRef('tool_result', message.evidenceSnapshotId, 'closed', { sourceMessageId: message.messageId });
        }
    }

    const pending = snapshot.authoritativeContext.pendingUserInput;
    addRef('user_input', String(pending?.requestId || ''), 'open', pending);
    for (const resolution of snapshot.authoritativeContext.userInputResolutions) {
        addRef('input_resolution', String(resolution.requestId || ''), 'closed', resolution);
    }

    const run = snapshot.authoritativeContext.activeRun;
    if (run) {
        addRef('user_input', String(run.pendingUserInput?.requestId || ''), 'open', run.pendingUserInput);
        addRef('approval', String(run.pendingApproval?.checkpointId || ''), 'open', run.pendingApproval);
        for (const response of run.approvalResponses || []) {
            addRef('approval_response', String(response.checkpointId || ''), 'closed', response);
        }
        for (const response of run.userInputResponses || []) {
            addRef('input_resolution', String(response.requestId || ''), 'closed', response);
        }
        addRef(
            'run',
            run.runId,
            ['completed', 'failed', 'cancelled'].includes(run.status) ? 'closed' : 'open',
            run,
            run.planSnapshot,
        );
        for (const event of run.events || []) {
            addRef('run_event', event.eventId, 'closed', event.payload);
        }
        for (const artifact of run.artifacts || []) {
            addRef('artifact', artifact.artifactId, 'closed', artifact.reference, artifact.metadata);
        }
    }
    for (const artifact of snapshot.artifacts) {
        addRef('artifact', artifact.artifactId, 'closed', artifact.reference, artifact.metadata);
    }

    return [...refs.values()].sort((left, right) => (
        `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)
    ));
}
