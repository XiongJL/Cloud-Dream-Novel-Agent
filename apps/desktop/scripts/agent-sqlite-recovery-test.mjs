import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-agent-sqlite-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());
const transpileModule = async (sourceUrl, outputPath, transform = (value) => value) => {
    const source = await fs.readFile(sourceUrl, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, transform(output), 'utf8');
};
const summaryModulePath = path.join(tempRoot, 'electron', 'ai', 'context', 'AgentConversationSummaryV2.mjs');
const storeModulePath = path.join(tempRoot, 'electron', 'agent', 'AgentConversationStore.mjs');
await transpileModule(
    new URL('../electron/ai/context/AgentConversationSummaryV2.ts', import.meta.url),
    summaryModulePath,
);
await transpileModule(
    new URL('../electron/agent/AgentConversationStore.ts', import.meta.url),
    storeModulePath,
    (output) => output.replace(
        /(['"])\.\.\/ai\/context\/AgentConversationSummaryV2\1/,
        "'../ai/context/AgentConversationSummaryV2.mjs'",
    ),
);
const { AgentConversationStore } = await import(pathToFileURL(storeModulePath).href);
const { buildDependencyHash, buildMessageSourceHash, emptySemanticProjection } = await import(pathToFileURL(summaryModulePath).href);

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

const pendingUserInput = {
    schemaVersion: 'agent-user-input-v1',
    requestId: 'input-sqlite-1',
    inputSessionId: 'input-session-sqlite-1',
    conversationId: 'runtime-conversation-1',
    phase: 'pre_plan',
    round: 2,
    maxRounds: 2,
    previousRequestId: 'input-sqlite-round-1',
    title: '确认两个方向',
    reason: '答案会改变计划。',
    questions: [{
        questionId: 'direction',
        header: '方向',
        prompt: '选择方向。',
        options: [
            { optionId: 'recommended', label: '推荐方向', description: '保持当前节奏。', evidenceIds: [] },
            { optionId: 'alternative', label: '备选方向', description: '改变当前节奏。', evidenceIds: [] },
        ],
        recommendedOptionId: 'recommended',
        recommendationReason: '更符合当前正文。',
        evidenceIds: [],
        allowCustom: true,
    }],
    evidence: [],
    createdAt: '2026-07-11T00:00:01.000Z',
};

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

    let conversationSchemaCreates = 0;
    let throwNextRunEventLock = false;
    let runEventInsertAttempts = 0;
    const instrumentedClient = new Proxy(client, {
        get(target, property, receiver) {
            if (property === '$executeRawUnsafe') {
                return async (...args) => {
                    const sql = String(args[0]);
                    if (sql.includes('CREATE TABLE IF NOT EXISTS AgentConversation')) {
                        conversationSchemaCreates += 1;
                    }
                    if (sql.includes('INSERT INTO AgentRunEvent')) {
                        runEventInsertAttempts += 1;
                        if (throwNextRunEventLock) {
                            throwNextRunEventLock = false;
                            throw Object.assign(new Error('database is locked'), {
                                code: 'P2010',
                                meta: { code: '5', message: 'database is locked' },
                            });
                        }
                    }
                    return target.$executeRawUnsafe(...args);
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const store = new AgentConversationStore(instrumentedClient);
    await Promise.all(Array.from({ length: 16 }, () => store.ensureSchema()));
    assert.equal(conversationSchemaCreates, 1);
    const baseConversation = {
        id: 'conversation-1',
        novelId: 'novel-1',
        title: '恢复测试',
        description: '真实 SQLite 恢复',
        role: 'team',
        runtimeConversationId: 'runtime-conversation-1',
        updatedAt: '2026-07-11T00:00:02.000Z',
        chapterScope: {
            kind: 'selected_chapters',
            chapterIds: ['chapter-1', 'chapter-2'],
            anchorChapterId: 'chapter-2',
            processingMode: 'detailed',
            experts: ['reader'],
        },
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
        pendingUserInput,
        composerDraft: '请继续分析第 3 章',
        attentionAcknowledgedRunId: 'run-acknowledged',
        userInputResolutions: [{
            requestId: 'input-resolved-1',
            inputSessionId: 'input-session-resolved-1',
            round: 1,
            phase: 'pre_plan',
            status: 'resolved',
            answers: [{ questionId: 'older-direction', answerKind: 'option', selectedOptionId: 'keep' }],
            effectiveAnswers: [{ questionId: 'older-direction', answerKind: 'option', selectedOptionId: 'keep', source: 'user' }],
            understandingSummary: '保留原方向。',
            resolvedAt: '2026-07-10T00:00:00.000Z',
            nextAction: 'plan_created',
        }],
        error: '',
        messages: [
            {
                id: 'message-1', role: 'user', content: '生成草稿', createdAt: '2026-07-11T00:00:00.000Z',
                chapterScopeSnapshot: {
                    kind: 'selected_chapters', chapterIds: ['chapter-1', 'chapter-2'], anchorChapterId: 'chapter-2',
                    processingMode: 'detailed', experts: ['reader'],
                },
            },
            { id: 'message-compression', role: 'system', content: '{"kind":"agent_context_compression_v1"}', createdAt: '2026-07-11T00:00:00.500Z' },
            {
                id: 'message-assistant',
                role: 'assistant',
                kind: 'chat',
                content: '已完成分析。',
                createdAt: '2026-07-11T00:00:00.750Z',
                contextReads: [{ toolName: 'chapter.get', status: 'completed' }],
                attachmentIds: ['attachment-1'],
                contextDiagnostics: {
                    contextVersion: 'agent-context-v1',
                    model: 'test-model',
                    inputBudgetTokens: 8192,
                    estimatedInputTokens: 4096,
                },
                activities: [{
                    eventId: 'activity-1', sequence: 1, requestId: 'request-1', callId: 'call-1',
                    type: 'tool_completed', stage: 'context_read', toolName: 'chapter.get',
                    displayName: '已读取《第一章》', status: 'completed', elapsedMs: 12,
                    createdAt: '2026-07-11T00:00:00.700Z',
                }],
                evidenceSnapshotId: 'evidence-snapshot-1',
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
        draftBatchId: 'draft-batch-1',
        draftOperationId: 'draft-operation-1',
        draftOperationKey: 'draftop_stable_key',
        draftOperationStatus: 'running_generation',
        draftOperationVersion: 3,
        pendingApproval: null,
        approvalResponses: [{ checkpointId: 'scope-1', selectedOptionIds: ['current_chapter'] }],
        pendingUserInput: { ...pendingUserInput, phase: 'execution', runId: 'run-sqlite-recovery', stepId: 'step-1' },
        userInputResponses: [{
            requestId: 'input-run-resolved-1',
            answers: [{ questionId: 'scope', answerKind: 'option', selectedOptionId: 'current_chapter' }],
            effectiveAnswers: [{ questionId: 'scope', answerKind: 'option', selectedOptionId: 'current_chapter', source: 'user' }],
            understandingSummary: '只分析当前章。',
        }],
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
        events: [event(1, 'run_started'), event(2, 'draft_created', { draftSessionId: 'draft-session-1', details: { draftBatchId: 'draft-batch-1' } })],
    };
    throwNextRunEventLock = true;
    await store.upsert({ ...baseConversation, run: runningRun });
    assert.equal(throwNextRunEventLock, false);
    assert.equal(runEventInsertAttempts, 3);
    await client.$executeRawUnsafe(
        'UPDATE AgentConversation SET contextSummaryJson = ? WHERE id = ?',
        JSON.stringify(baseConversation.contextSummary),
        baseConversation.id,
    );
    const pendingRoundTrip = await store.list('novel-1');
    assert.equal(pendingRoundTrip[0].pendingUserInput.requestId, 'input-sqlite-1');
    assert.equal(pendingRoundTrip[0].composerDraft, '请继续分析第 3 章');
    assert.equal(pendingRoundTrip[0].attentionAcknowledgedRunId, 'run-acknowledged');
    assert.equal(pendingRoundTrip[0].pendingUserInput.round, 2);
    assert.equal(pendingRoundTrip[0].pendingUserInput.inputSessionId, 'input-session-sqlite-1');
    assert.equal(pendingRoundTrip[0].userInputResolutions[0].requestId, 'input-resolved-1');
    assert.equal(pendingRoundTrip[0].run.pendingUserInput.requestId, 'input-sqlite-1');
    assert.equal(pendingRoundTrip[0].run.userInputResponses[0].requestId, 'input-run-resolved-1');
    assert.equal(pendingRoundTrip[0].run.userInputResponses[0].effectiveAnswers[0].source, 'user');
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
            status: 'failed',
            currentStepId: null,
            progress: 1,
            pendingUserInput: null,
            retryOfRunId: 'run-original-failure',
            retryRootRunId: 'run-original-failure',
            retryAttempt: 1,
            failureRevision: 2,
            resumedFrom: { phase: 'toolchain', nodeId: 'audit.synthesize' },
            completionKind: 'partial',
            recovery: {
                failureKind: 'model_output_invalid',
                failedAtPhase: 'normalizing',
                retryStrategy: 'repair_model_output',
                canRecover: true,
                recoveryRevision: 2,
                actionLabel: '修复结果并继续',
                completedArtifactIds: ['artifact-draft-1'],
                affectedArtifactIds: [],
                diagnosticRef: 'diagnostic-sqlite-recovery',
            },
            events: [...runningRun.events, event(3, 'run_failed')],
        },
    });

    await client.$disconnect();
    client = createClient();
    const restoredStore = new AgentConversationStore(client);
    const restored = await restoredStore.list('novel-1');
    assert.equal(restored.length, 1);
    assert.equal(restored[0].messages.length, 3);
    assert.equal(restored[0].messages[0].content, '生成草稿');
    assert.deepEqual(restored[0].chapterScope.chapterIds, ['chapter-1', 'chapter-2']);
    assert.deepEqual(restored[0].messages[0].chapterScopeSnapshot.chapterIds, ['chapter-1', 'chapter-2']);
    assert.equal(restored[0].messages[1].role, 'system');
    assert.deepEqual(restored[0].messages[2].contextReads, [{ toolName: 'chapter.get', status: 'completed' }]);
    assert.equal(restored[0].messages[2].kind, 'chat');
    assert.equal(restored[0].messages[2].contextDiagnostics.model, 'test-model');
    assert.equal(restored[0].messages[2].activities[0].callId, 'call-1');
    assert.equal(restored[0].messages[2].evidenceSnapshotId, 'evidence-snapshot-1');
    assert.equal(restored[0].contextSummary.version, 'agent-conversation-summary-v1');
    assert.equal(restored[0].contextSummary.revision, 2);
    assert.deepEqual(restored[0].contextSummary.coveredMessageIds, ['message-1']);
    assert.equal(restored[0].contextSummary.artifactRefs[0].artifactId, 'artifact-draft-1');
    assert.equal(restored[0].pendingUserInput.requestId, 'input-sqlite-1');
    assert.equal(restored[0].composerDraft, '请继续分析第 3 章');
    assert.equal(restored[0].attentionAcknowledgedRunId, 'run-acknowledged');
    assert.equal(restored[0].userInputResolutions[0].understandingSummary, '保留原方向。');
    assert.deepEqual(
        await client.$queryRawUnsafe("SELECT id FROM AgentMessage WHERE id = 'message-leaked-step'"),
        [],
    );
    assert.equal(restored[0].runs.length, 1);
    assert.equal(restored[0].run.status, 'failed');
    assert.equal(restored[0].run.progress, 1);
    assert.equal(restored[0].run.draftSessionId, 'draft-session-1');
    assert.equal(restored[0].run.draftBatchId, 'draft-batch-1');
    assert.equal(restored[0].run.draftOperationId, 'draft-operation-1');
    assert.equal(restored[0].run.draftOperationKey, 'draftop_stable_key');
    assert.equal(restored[0].run.draftOperationStatus, 'running_generation');
    assert.equal(restored[0].run.draftOperationVersion, 3);
    assert.equal(restored[0].run.retryOfRunId, 'run-original-failure');
    assert.equal(restored[0].run.retryRootRunId, 'run-original-failure');
    assert.equal(restored[0].run.retryAttempt, 1);
    assert.equal(restored[0].run.failureRevision, 2);
    assert.equal(restored[0].run.resumedFrom.nodeId, 'audit.synthesize');
    assert.equal(restored[0].run.completionKind, 'partial');
    assert.equal(restored[0].run.recovery.retryStrategy, 'repair_model_output');
    assert.equal(restored[0].run.recovery.actionLabel, '修复结果并继续');
    assert.equal(restored[0].run.artifacts.length, 1);
    assert.equal(restored[0].run.artifacts[0].artifactId, 'artifact-draft-1');
    assert.deepEqual(restored[0].run.artifacts[0].reference, { draftSessionId: 'draft-session-1' });
    assert.deepEqual(restored[0].run.approvalResponses, [{ checkpointId: 'scope-1', selectedOptionIds: ['current_chapter'] }]);
    assert.equal(restored[0].run.pendingUserInput, null);
    assert.equal(restored[0].run.userInputResponses[0].understandingSummary, '只分析当前章。');
    assert.equal(restored[0].run.planSnapshot.title, '恢复计划');
    assert.deepEqual(restored[0].run.events.map((item) => [item.sequence, item.type]), [
        [1, 'run_started'],
        [2, 'draft_created'],
        [3, 'run_failed'],
    ]);
    assert.equal(restored[0].run.events[1].payload.draftSessionId, 'draft-session-1');
    assert.equal(restored[0].run.events[1].payload.details.draftBatchId, 'draft-batch-1');

    await client.$executeRawUnsafe("UPDATE AgentRun SET draftBatchId = NULL WHERE runId = 'run-sqlite-recovery'");
    const recoveredLegacyBatch = await restoredStore.list('novel-1');
    assert.equal(recoveredLegacyBatch[0].run.draftBatchId, 'draft-batch-1');

    await restoredStore.updateComposerDraft('conversation-1', '恢复后的独立草稿');
    await restoredStore.acknowledgeRun('conversation-1', 'run-sqlite-recovery');
    const lightweightUpdates = await restoredStore.list('novel-1');
    assert.equal(lightweightUpdates[0].composerDraft, '恢复后的独立草稿');
    assert.equal(lightweightUpdates[0].attentionAcknowledgedRunId, 'run-sqlite-recovery');

    const compressionSnapshot = await restoredStore.readCompressionSnapshot('conversation-1');
    assert.equal(compressionSnapshot.summaryCasToken.version, 'agent-conversation-summary-v1');
    assert.deepEqual(compressionSnapshot.messages.map((message) => message.sequence), [1, 3]);
    assert.deepEqual(compressionSnapshot.messages[1].contextReads, [{ toolName: 'chapter.get', status: 'completed' }]);
    assert.deepEqual(compressionSnapshot.messages[1].attachmentIds, ['attachment-1']);
    assert.equal(compressionSnapshot.messages[1].evidenceSnapshotId, 'evidence-snapshot-1');
    const firstCoverage = compressionSnapshot.messages.slice(0, 1);
    const summaryV2 = {
        version: 'agent-conversation-summary-v2',
        revision: 1,
        previousRevision: 0,
        generation: 1,
        coverage: {
            startMessageId: 'message-1',
            endMessageId: 'message-1',
            messageCount: 1,
            sourceHash: buildMessageSourceHash(firstCoverage),
        },
        semanticProjection: emptySemanticProjection(),
        sourceIndex: {
            userMessageLedger: [{
                messageId: 'message-1',
                gist: '生成草稿',
                classification: 'semantic',
            }],
            sourceFingerprints: [],
            dependencyHash: buildDependencyHash([]),
        },
        updatedAt: '2026-07-11T00:00:05.000Z',
        compactor: { providerType: 'http', model: 'test-model', promptVersion: 'test-v1' },
    };
    const firstCas = await restoredStore.compareAndSwapContextSummary(
        'conversation-1',
        compressionSnapshot.summaryCasToken,
        summaryV2,
    );
    assert.equal(firstCas.ok, true);
    const staleCas = await restoredStore.compareAndSwapContextSummary(
        'conversation-1',
        compressionSnapshot.summaryCasToken,
        { ...summaryV2, updatedAt: '2026-07-11T00:00:06.000Z' },
    );
    assert.deepEqual(staleCas, { ok: false, reason: 'conflict' });
    const generationOneSnapshot = await restoredStore.readCompressionSnapshot('conversation-1');
    assert.equal(generationOneSnapshot.summaryCasToken.generation, 1);
    await client.$executeRawUnsafe(
        'UPDATE AgentMessage SET content = ? WHERE id = ?',
        '生成修改后的草稿',
        'message-1',
    );
    const editedSourceCas = await restoredStore.compareAndSwapContextSummary(
        'conversation-1',
        generationOneSnapshot.summaryCasToken,
        {
            ...summaryV2,
            revision: 2,
            previousRevision: 1,
            updatedAt: '2026-07-11T00:00:06.500Z',
        },
    );
    assert.deepEqual(editedSourceCas, { ok: false, reason: 'conflict' });
    await client.$executeRawUnsafe(
        'UPDATE AgentMessage SET content = ? WHERE id = ?',
        '生成草稿',
        'message-1',
    );
    const rebuildCas = await restoredStore.compareAndSwapContextSummary(
        'conversation-1',
        generationOneSnapshot.summaryCasToken,
        {
            ...summaryV2,
            revision: 2,
            previousRevision: 1,
            generation: 2,
            rebuild: { previousGeneration: 1, reason: 'source_changed' },
            updatedAt: '2026-07-11T00:00:07.000Z',
        },
    );
    assert.equal(rebuildCas.ok, true);
    assert.equal(rebuildCas.summaryCasToken.generation, 2);

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
    assert.equal(afterArchive[0].contextSummary.version, 'agent-conversation-summary-v2');
    assert.equal(afterArchive[0].contextSummary.revision, 2);
    assert.equal(afterArchive[0].contextSummary.generation, 2);

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
