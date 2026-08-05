import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentWorkspaceAttention.ts', import.meta.url), 'utf8');
const workspaceSource = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
const editorSource = await readFile(new URL('../src/pages/editor/EditorWorkspace.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const attention = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const conversation = (id, run, extra = {}) => ({
    id,
    updatedAt: '2026-07-30T00:00:00.000Z',
    run,
    ...extra,
});

const summary = attention.projectAgentWorkspaceAttention([
    conversation('running', { runId: 'run-running', status: 'running', events: [] }),
    conversation('approval', {
        runId: 'run-approval',
        status: 'waiting_approval',
        pendingApproval: { checkpointId: 'checkpoint-1' },
        events: [{ type: 'approval_required', createdAt: '2026-07-30T00:03:00.000Z' }],
    }),
    conversation('input-later', {
        runId: 'run-input-later',
        status: 'waiting_user_input',
        pendingUserInput: { requestId: 'request-2' },
        events: [{ type: 'user_input_required', createdAt: '2026-07-30T00:02:00.000Z' }],
    }),
    conversation('input-first', {
        runId: 'run-input-first',
        status: 'waiting_user_input',
        pendingUserInput: { requestId: 'request-1' },
        events: [{ type: 'user_input_required', createdAt: '2026-07-30T00:01:00.000Z' }],
    }),
]);

assert.equal(summary.kind, 'waiting_user_input');
assert.equal(summary.count, 2);
assert.equal(summary.targetConversationId, 'input-first');
assert.deepEqual(summary.counts, {
    failed: 0,
    waiting_user_input: 2,
    waiting_approval: 1,
    review_ready: 0,
    running: 1,
});
assert.equal(summary.title, 'Agent：2 个任务待回答，1 个任务待审批，1 个任务运行中');

const failed = conversation('failed', {
    runId: 'run-failed',
    status: 'failed',
    events: [{ type: 'run_failed', createdAt: '2026-07-30T00:04:00.000Z' }],
});
assert.equal(attention.agentConversationAttentionKind(failed), 'failed');
assert.equal(attention.agentConversationAttentionKind({
    ...failed,
    attentionAcknowledgedRunId: 'run-failed',
}), 'idle');

const unreadReview = conversation('review', {
    runId: 'run-review',
    status: 'completed',
    artifacts: [{ status: 'ready', reviewStatus: 'unreviewed' }],
    events: [],
});
assert.equal(attention.agentConversationAttentionKind(unreadReview), 'review_ready');
assert.equal(attention.agentConversationAttentionKind({
    ...unreadReview,
    attentionAcknowledgedRunId: 'run-review',
}), 'idle');
assert.equal(attention.agentConversationAttentionKind({
    ...unreadReview,
    run: { ...unreadReview.run, artifacts: [{ status: 'committed', reviewStatus: 'reviewed' }] },
}), 'review_ready');

assert.equal(attention.projectAgentWorkspaceAttention([]).kind, 'idle');

const failedWithStaleBlockingState = conversation('failed-priority', {
    runId: 'run-failed-priority',
    status: 'failed',
    pendingUserInput: { requestId: 'stale-request' },
    events: [{ type: 'run_failed', createdAt: '2026-07-30T00:05:00.000Z' }],
});
assert.equal(attention.agentConversationAttentionKind(failedWithStaleBlockingState), 'failed');

const manyWaiting = attention.projectAgentWorkspaceAttention(Array.from({ length: 11 }, (_, index) => (
    conversation(`waiting-${index}`, {
        runId: `run-waiting-${index}`,
        status: 'waiting_user_input',
        pendingUserInput: { requestId: `request-${index}` },
        events: [{ type: 'user_input_required', createdAt: `2026-07-30T00:${String(index).padStart(2, '0')}:00.000Z` }],
    })
)));
assert.equal(manyWaiting.count, 11);
assert.equal(manyWaiting.counts.waiting_user_input, 11);

assert.match(workspaceSource, /export default memo\(AgentWorkspace\)/);
assert.match(editorSource, /productMode !== 'agent'\s*&&\s*'hidden'/);
assert.doesNotMatch(editorSource, /agentHasMounted/);
const agentWorkspaceInvocation = editorSource.match(/<AgentWorkspace\b[^>]*\/>/)?.[0] ?? '';
assert.match(agentWorkspaceInvocation, /getCurrentContentSnapshot=\{getAgentContentSnapshot\}/);
assert.match(agentWorkspaceInvocation, /currentChapter=\{agentChapterContext\}/);
assert.doesNotMatch(agentWorkspaceInvocation, /currentContent=/);
assert.doesNotMatch(agentWorkspaceInvocation, /currentChapter=\{currentChapter\}/);
assert.match(workspaceSource, /if \(!isVisible\) return null/);
assert.match(workspaceSource, /const activeTimeline = useMemo\(\(\) => isVisible \? buildAgentConversationTimeline/);
assert.match(workspaceSource, /setTimeout\([^]*flushComposerDrafts\(changed\)[^]*400\)/);
assert.match(workspaceSource, /addEventListener\('beforeunload', flushBeforeUnload\)/);
assert.match(workspaceSource, /setTimeout\(flushQueuedRunEvents, 120\)/);
assert.match(workspaceSource, /const attentionKind = agentConversationAttentionKind\(activeConversation\)/);
assert.match(workspaceSource, /\['failed', 'review_ready'\]\.includes\(attentionKind\)/);
for (const eventType of ['approval_required', 'user_input_required', 'run_completed', 'run_failed', 'run_cancelled']) {
    assert.match(workspaceSource, new RegExp(`'${eventType}'`));
}
assert.equal(
    workspaceSource.match(/window\.agent\.subscribeRun\(/g)?.length ?? 0,
    1,
    'All Run subscriptions must pass through the deduplicating subscribeRun helper.',
);

console.log('Agent workspace attention projection tests passed.');
