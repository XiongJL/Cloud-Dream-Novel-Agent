import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-context-state-refs-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());

try {
    const source = await fs.readFile(
        new URL('../electron/ai/context/AgentContextStateRefs.ts', import.meta.url),
        'utf8',
    );
    const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const modulePath = path.join(tempRoot, 'AgentContextStateRefs.mjs');
    await fs.writeFile(modulePath, output, 'utf8');
    const { buildAgentContextStateRefs } = await import(pathToFileURL(modulePath).href);

    const snapshot = {
        storageConversationId: 'conversation-1',
        novelId: 'novel-1',
        messages: [
            {
                messageId: 'message-1',
                sequence: 1,
                role: 'user',
                content: '开始任务',
                createdAt: '2026-07-30T00:00:00.000Z',
                attachmentIds: ['attachment-1'],
            },
            {
                messageId: 'message-2',
                sequence: 2,
                role: 'assistant',
                content: '已读取上下文',
                createdAt: '2026-07-30T00:00:01.000Z',
                contextReads: [{ toolName: 'chapter.get', status: 'completed' }],
                evidenceSnapshotId: 'evidence-1',
            },
        ],
        artifacts: [{
            artifactId: 'artifact-shared',
            reference: { nested: { sourceMessageId: 'message-2' } },
            metadata: {},
        }, {
            artifactId: 'artifact-unanchored',
            reference: {},
            metadata: {},
        }],
        authoritativeContext: {
            currentPlan: null,
            pendingUserInput: {
                requestId: 'request-1',
                request: { sourceMessageId: 'message-1' },
            },
            userInputResolutions: [{
                requestId: 'request-resolved',
                details: { messageId: 'message-2' },
            }],
            activeRun: {
                runId: 'run-1',
                status: 'running',
                pendingUserInput: {
                    requestId: 'request-1',
                    sourceMessageIds: ['message-1', 'message-2'],
                },
                pendingApproval: {
                    checkpointId: 'checkpoint-1',
                    request: { sourceMessageId: 'message-2' },
                },
                approvalResponses: [{
                    checkpointId: 'checkpoint-resolved',
                    nested: { sourceMessageId: 'message-1' },
                }],
                userInputResponses: [{
                    requestId: 'run-input-resolved',
                    nested: { sourceMessageIds: ['message-1'] },
                }],
                planSnapshot: { provenance: { sourceMessageId: 'message-1' } },
                events: [{
                    eventId: 'event-anchored',
                    payload: { details: { sourceMessageIds: ['message-1', 'message-2'] } },
                }, {
                    eventId: 'event-unanchored',
                    payload: {},
                }],
                artifacts: [{
                    artifactId: 'artifact-shared',
                    reference: { sourceMessageId: 'message-1' },
                    metadata: {},
                }],
            },
        },
        contextSummary: null,
        summaryCasToken: {},
    };

    const refs = buildAgentContextStateRefs(snapshot);
    assert.deepEqual(
        refs.map((ref) => `${ref.kind}:${ref.id}`),
        [...refs.map((ref) => `${ref.kind}:${ref.id}`)].sort((left, right) => left.localeCompare(right)),
    );
    const byKey = new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref]));
    assert.deepEqual(byKey.get('attachment:attachment-1').messageIds, ['message-1']);
    assert.deepEqual(byKey.get('tool_result:message-2:chapter.get:0').messageIds, ['message-2']);
    assert.deepEqual(byKey.get('tool_result:evidence-1').messageIds, ['message-2']);
    assert.deepEqual(byKey.get('user_input:request-1'), {
        kind: 'user_input',
        id: 'request-1',
        status: 'open',
        messageIds: ['message-1', 'message-2'],
    });
    assert.deepEqual(byKey.get('input_resolution:request-resolved').messageIds, ['message-2']);
    assert.deepEqual(byKey.get('approval:checkpoint-1').messageIds, ['message-2']);
    assert.deepEqual(byKey.get('approval_response:checkpoint-resolved').messageIds, ['message-1']);
    assert.deepEqual(byKey.get('input_resolution:run-input-resolved').messageIds, ['message-1']);
    assert.deepEqual(byKey.get('run:run-1').messageIds, ['message-1', 'message-2']);
    assert.deepEqual(byKey.get('run_event:event-anchored').messageIds, ['message-1', 'message-2']);
    assert.equal(byKey.get('run_event:event-unanchored').messageIds, undefined);
    assert.deepEqual(byKey.get('artifact:artifact-shared').messageIds, ['message-1', 'message-2']);
    assert.equal(byKey.get('artifact:artifact-unanchored').messageIds, undefined);
    assert.equal(refs.filter((ref) => ref.kind === 'artifact' && ref.id === 'artifact-shared').length, 1);

    console.log('Agent context state reference tests passed.');
} finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
}
