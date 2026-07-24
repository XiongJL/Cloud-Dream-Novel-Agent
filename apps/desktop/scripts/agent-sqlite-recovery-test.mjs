import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

const source = await readFile(new URL('../electron/agent/AgentConversationStore.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { AgentConversationStore } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-agent-sqlite-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());
const dbPath = path.join(tempRoot, 'agent-recovery.db').replaceAll('\\', '/');
const dbUrl = `file:${dbPath}`;

const createClient = () => new PrismaClient({ datasources: { db: { url: dbUrl } } });
let client = createClient();

const event = (sequence, type, payload = {}) => ({
    eventId: `event-${sequence}`,
    sequence,
    runId: 'run-sqlite-recovery',
    planId: 'plan-1',
    threadId: 'thread-1',
    type,
    payload,
    createdAt: `2026-07-11T00:00:0${sequence}.000Z`,
});

try {
    await client.$executeRawUnsafe(`
        CREATE TABLE Novel (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, coverUrl TEXT,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
            wordCount INTEGER NOT NULL DEFAULT 0, formatting TEXT NOT NULL DEFAULT '{}'
        )
    `);
    await client.$executeRawUnsafe("INSERT INTO Novel (id, title) VALUES ('novel-1', '测试小说')");
    await client.$executeRawUnsafe(`
        CREATE TABLE AgentConversation (
            id TEXT PRIMARY KEY, novelId TEXT NOT NULL, title TEXT NOT NULL,
            description TEXT, role TEXT NOT NULL, runtimeConversationId TEXT,
            suggestedGoal TEXT, planJson TEXT, runJson TEXT, error TEXT,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const store = new AgentConversationStore(client);
    const baseConversation = {
        id: 'conversation-1',
        novelId: 'novel-1',
        title: '恢复测试',
        description: '真实 SQLite 恢复',
        role: 'team',
        runtimeConversationId: 'runtime-conversation-1',
        updatedAt: '2026-07-11T00:00:02.000Z',
        suggestedGoal: null,
        plan: { planId: 'plan-1', steps: [] },
        contextSummary: {
            version: 'agent-conversation-summary-v1',
            revision: 2,
            coveredMessageIds: ['message-1'],
            coverage: { startMessageId: 'message-1', endMessageId: 'message-1', messageCount: 1 },
            facts: [{ id: 'fact-1', text: '用户要生成草稿', sourceMessageIds: ['message-1'], sourceRole: 'user' }],
            userDecisions: [],
            unresolvedQuestions: [],
            outcomes: [],
            artifactRefs: [{ artifactId: 'artifact-draft-1', title: '章节修改草稿', type: 'chapter_draft' }],
            updatedAt: '2026-07-11T00:00:02.000Z',
        },
        error: '',
        messages: [
            { id: 'message-1', role: 'user', content: '生成草稿', createdAt: '2026-07-11T00:00:00.000Z' },
            { id: 'message-compression', role: 'system', content: '{"kind":"agent_context_compression_v1"}', createdAt: '2026-07-11T00:00:00.500Z' },
            {
                id: 'message-assistant',
                role: 'assistant',
                content: '已完成分析。',
                createdAt: '2026-07-11T00:00:00.750Z',
                contextReads: [{ toolName: 'chapter.get', status: 'completed' }],
                contextDiagnostics: {
                    contextVersion: 'agent-context-v1',
                    model: 'test-model',
                    inputBudgetTokens: 8192,
                    estimatedInputTokens: 4096,
                },
            },
        ],
    };
    const runningRun = {
        runId: 'run-sqlite-recovery',
        threadId: 'thread-1',
        planId: 'plan-1',
        status: 'running',
        currentStepId: 'step-1',
        progress: 0.5,
        draftSessionId: 'draft-session-1',
        pendingApproval: null,
        approvalResponses: [{ checkpointId: 'scope-1', selectedOptionIds: ['current_chapter'] }],
        planSnapshot: {
            planId: 'plan-1', threadId: 'thread-1', title: '恢复计划', goal: '恢复任务', requiresApproval: true,
            steps: [{ stepId: 'step-1', agent: 'writer', title: '读取当前章节上下文', tools: ['chapter.get'] }],
        },
        artifacts: [{
            artifactId: 'artifact-draft-1',
            runId: 'run-sqlite-recovery',
            planId: 'plan-1',
            type: 'chapter_draft',
            title: '章节修改草稿',
            status: 'ready',
            summary: '已生成草稿',
            content: null,
            reference: { draftSessionId: 'draft-session-1' },
            metadata: { toolName: 'chapter.generate_draft' },
            createdAt: '2026-07-11T00:00:02.000Z',
        }],
        events: [event(1, 'run_started'), event(2, 'draft_created', { draftSessionId: 'draft-session-1' })],
    };
    await store.upsert({ ...baseConversation, run: runningRun });
    await store.upsert({
        ...baseConversation,
        messages: [
            ...baseConversation.messages,
            { id: 'message-leaked-step', role: 'assistant', content: '读取当前章节上下文', createdAt: '2026-07-11T00:00:01.000Z' },
        ],
        run: runningRun,
    });
    await store.upsert({
        ...baseConversation,
        updatedAt: '2026-07-11T00:00:03.000Z',
        run: {
            ...runningRun,
            status: 'completed',
            currentStepId: null,
            progress: 1,
            events: [...runningRun.events, event(3, 'run_completed')],
        },
    });

    await client.$disconnect();
    client = createClient();
    const restoredStore = new AgentConversationStore(client);
    const restored = await restoredStore.list('novel-1');
    assert.equal(restored.length, 1);
    assert.equal(restored[0].messages.length, 3);
    assert.equal(restored[0].messages[0].content, '生成草稿');
    assert.equal(restored[0].messages[1].role, 'system');
    assert.deepEqual(restored[0].messages[2].contextReads, [{ toolName: 'chapter.get', status: 'completed' }]);
    assert.equal(restored[0].messages[2].contextDiagnostics.model, 'test-model');
    assert.equal(restored[0].contextSummary.version, 'agent-conversation-summary-v1');
    assert.equal(restored[0].contextSummary.revision, 2);
    assert.deepEqual(restored[0].contextSummary.coveredMessageIds, ['message-1']);
    assert.equal(restored[0].contextSummary.artifactRefs[0].artifactId, 'artifact-draft-1');
    assert.deepEqual(
        await client.$queryRawUnsafe("SELECT id FROM AgentMessage WHERE id = 'message-leaked-step'"),
        [],
    );
    assert.equal(restored[0].runs.length, 1);
    assert.equal(restored[0].run.status, 'completed');
    assert.equal(restored[0].run.progress, 1);
    assert.equal(restored[0].run.draftSessionId, 'draft-session-1');
    assert.equal(restored[0].run.artifacts.length, 1);
    assert.equal(restored[0].run.artifacts[0].artifactId, 'artifact-draft-1');
    assert.deepEqual(restored[0].run.artifacts[0].reference, { draftSessionId: 'draft-session-1' });
    assert.deepEqual(restored[0].run.approvalResponses, [{ checkpointId: 'scope-1', selectedOptionIds: ['current_chapter'] }]);
    assert.equal(restored[0].run.planSnapshot.title, '恢复计划');
    assert.deepEqual(restored[0].run.events.map((item) => [item.sequence, item.type]), [
        [1, 'run_started'],
        [2, 'draft_created'],
        [3, 'run_completed'],
    ]);
    assert.equal(restored[0].run.events[1].payload.draftSessionId, 'draft-session-1');

    await restoredStore.upsert({
        ...baseConversation,
        updatedAt: '2026-07-11T00:00:04.000Z',
        plan: null,
        run: null,
    });
    const afterArchive = await restoredStore.list('novel-1');
    assert.equal(afterArchive[0].run, null);
    assert.equal(afterArchive[0].runs.length, 1);
    assert.equal(afterArchive[0].runs[0].planSnapshot.title, '恢复计划');

    await restoredStore.delete('conversation-1');
    assert.deepEqual(await restoredStore.list('novel-1'), []);
    const orphanEvents = await client.$queryRawUnsafe('SELECT eventId FROM AgentRunEvent');
    assert.deepEqual(orphanEvents, []);
    const orphanArtifacts = await client.$queryRawUnsafe('SELECT artifactId FROM AgentArtifact');
    assert.deepEqual(orphanArtifacts, []);
    console.log('Agent SQLite persistence, terminal replay, and reload tests passed.');
} finally {
    await client.$disconnect().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
}
