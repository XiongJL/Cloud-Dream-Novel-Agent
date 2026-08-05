import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

function splitSqlStatements(sql) {
    const statements = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    for (const char of sql) {
        if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
        if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
        if (char === ';' && !inSingleQuote && !inDoubleQuote) {
            if (current.trim()) statements.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) statements.push(current.trim());
    return statements;
}

async function transpiledUrl(relativePath, replacements = []) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    let output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const [from, to] of replacements) output = output.replace(from, to);
    return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

const stateUrl = await transpiledUrl('../shared/draftOperation.ts');
const coreModuleUrl = new URL('../../../packages/core/dist/index.js', import.meta.url).href;
const operationStoreUrl = await transpiledUrl('../electron/automation/DraftOperationStore.ts', [
    ["from '@novel-editor/core'", `from '${coreModuleUrl}'`],
    ["from '../../shared/draftOperation'", `from '${stateUrl}'`],
]);
const sessionStoreUrl = await transpiledUrl('../electron/automation/DraftSessionStore.ts');
const coordinatorUrl = await transpiledUrl('../electron/automation/DraftOperationCoordinator.ts', [
    ["from '../../shared/draftOperation'", `from '${stateUrl}'`],
    ["from './DraftOperationStore'", `from '${operationStoreUrl}'`],
]);
const { DraftOperationStore } = await import(operationStoreUrl);
const { DraftSessionStore } = await import(sessionStoreUrl);
const { DraftOperationCoordinator } = await import(coordinatorUrl);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-draft-atomic-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());
const dbPath = path.join(tempRoot, 'draft-atomic.db').replaceAll('\\', '/');
const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

const operationInput = (suffix, overrides = {}) => ({
    operationKey: `atomic-operation-${suffix}`,
    paramsHash: `atomic-params-${suffix}`,
    requestJson: JSON.stringify({ mode: suffix }),
    novelId: 'novel-atomic',
    chapterId: 'chapter-atomic',
    generationRevision: 1,
    sourceChapterVersion: 1,
    sourceContentHash: 'atomic-source-hash',
    operationDeadlineAt: '2099-07-29T00:00:00.000Z',
    ...overrides,
});

const preparedDraft = (operationId, overrides = {}) => ({
    kind: 'create',
    sessionInput: {
        workspace: 'chapter-editor',
        type: 'chapter-draft',
        source: 'internal-ai',
        origin: 'desktop-ui',
        novelId: 'novel-atomic',
        chapterId: 'chapter-atomic',
        sourceOperationId: operationId,
        generationRevision: 1,
        status: 'draft',
        payload: {
            chapterId: 'chapter-atomic',
            baseContent: '原文',
            generatedText: '原子草稿',
            content: '原文原子草稿',
            usedContext: [],
            consistency: { ok: true, issues: [] },
        },
        previewSummary: '原子草稿',
    },
    expectedGenerationRevision: 1,
    ...overrides,
});

async function advanceToCommitting(store, created, prepared) {
    let operation = await store.transition(created.operation.operationId, created.operation.version, {
        type: 'CLAIM',
        now: '2026-07-29T00:00:00.000Z',
        workerId: 'atomic-worker',
        leaseExpiresAt: '2099-07-29T00:00:00.000Z',
    });
    operation = await store.transition(operation.operationId, operation.version, {
        type: 'GENERATION_SUCCEEDED',
        now: '2026-07-29T00:00:01.000Z',
        generatedPayloadJson: JSON.stringify(prepared),
    });
    return store.transition(operation.operationId, operation.version, {
        type: 'POSTPROCESS_COMPLETED',
        now: '2026-07-29T00:00:02.000Z',
    });
}

async function waitForStatus(coordinator, operationId, statuses, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const view = await coordinator.get(operationId);
        if (statuses.has(view.status)) return view;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${operationId}`);
}

try {
    const schemaSql = await readFile(
        new URL('../../../packages/core/generated/client/schema-init.sql', import.meta.url),
        'utf8',
    );
    for (const statement of splitSqlStatements(schemaSql)) {
        await client.$executeRawUnsafe(statement);
    }

    const operationStore = new DraftOperationStore(client);
    const sessionStore = new DraftSessionStore(client);
    await operationStore.ensureSchema();
    await sessionStore.list({ includeInactive: true });

    // Concurrent starts collapse to one durable identity.
    const concurrent = await Promise.all(
        Array.from({ length: 12 }, () => operationStore.createOrGet(operationInput('concurrent'))),
    );
    assert.equal(new Set(concurrent.map((item) => item.operation.operationId)).size, 1);
    assert.equal(concurrent.filter((item) => !item.existing).length, 1);

    // A crash after the entity insert but before the Operation CAS must roll
    // back the DraftSession and outbox together.
    const crashCreated = await operationStore.createOrGet(operationInput('crash-boundary'));
    const crashPrepared = preparedDraft(crashCreated.operation.operationId);
    let crashOperation = await advanceToCommitting(operationStore, crashCreated, crashPrepared);
    await assert.rejects(
        operationStore.commitSucceeded(crashOperation.operationId, crashOperation.version, async (tx, current) => {
            await sessionStore.persistPreparedChapterDraft(tx, current, crashPrepared);
            throw Object.assign(new Error('injected crash before operation CAS'), { code: 'INJECTED_CRASH' });
        }),
        (error) => error?.code === 'INJECTED_CRASH',
    );
    assert.equal(await client.draftSession.count({ where: { sourceOperationId: crashOperation.operationId } }), 0);
    assert.equal((await operationStore.get(crashOperation.operationId)).status, 'committing');
    assert.equal((await operationStore.listPendingOutbox()).length, 0);

    crashOperation = await operationStore.commitSucceeded(
        crashOperation.operationId,
        crashOperation.version,
        (tx, current) => sessionStore.persistPreparedChapterDraft(tx, current, crashPrepared),
    );
    sessionStore.invalidateCache();
    assert.equal(crashOperation.status, 'succeeded');
    assert.equal(crashOperation.generatedPayloadJson, undefined);
    assert.equal(await client.draftSession.count({ where: { sourceOperationId: crashOperation.operationId } }), 1);
    assert.equal((await operationStore.listPendingOutbox()).length, 1);

    // Duplicate completion with an old version cannot execute its persistence callback.
    let duplicateCallbackRan = false;
    await assert.rejects(
        operationStore.commitSucceeded(crashOperation.operationId, crashOperation.version - 1, async () => {
            duplicateCallbackRan = true;
            throw new Error('must not run');
        }),
        (error) => error?.code === 'VERSION_CONFLICT',
    );
    assert.equal(duplicateCallbackRan, false);
    assert.equal(await client.draftSession.count({ where: { sourceOperationId: crashOperation.operationId } }), 1);
    assert.equal((await operationStore.listPendingOutbox()).length, 1);

    // Out-of-order completion is rejected before any side effect executes.
    const outOfOrderCreated = await operationStore.createOrGet(operationInput('out-of-order'));
    const outOfOrderRunning = await operationStore.transition(
        outOfOrderCreated.operation.operationId,
        outOfOrderCreated.operation.version,
        {
            type: 'CLAIM',
            now: '2026-07-29T00:00:00.000Z',
            workerId: 'atomic-worker',
            leaseExpiresAt: '2099-07-29T00:00:00.000Z',
        },
    );
    let outOfOrderCallbackRan = false;
    await assert.rejects(
        operationStore.commitSucceeded(outOfOrderRunning.operationId, outOfOrderRunning.version, async () => {
            outOfOrderCallbackRan = true;
            throw new Error('must not run');
        }),
        (error) => error?.code === 'INVALID_OPERATION_TRANSITION',
    );
    assert.equal(outOfOrderCallbackRan, false);
    const concurrentOperation = await operationStore.get(concurrent[0].operation.operationId);
    await operationStore.transition(concurrentOperation.operationId, concurrentOperation.version, {
        type: 'CANCEL_REQUEST',
        now: '2026-07-29T00:00:03.000Z',
    });
    await operationStore.transition(outOfOrderRunning.operationId, outOfOrderRunning.version, {
        type: 'TERMINAL_FAILURE',
        now: '2026-07-29T00:00:03.000Z',
        errorCode: 'TEST_COMPLETE',
        errorJson: '{"code":"TEST_COMPLETE"}',
    });

    // A prepared payload in running_postprocess is enough for a restarted
    // coordinator to finish the atomic commit without invoking the model again.
    const recoveryCreated = await operationStore.createOrGet(operationInput('prepared-recovery'));
    const recoveryPrepared = preparedDraft(recoveryCreated.operation.operationId);
    let recoveryOperation = await operationStore.transition(
        recoveryCreated.operation.operationId,
        recoveryCreated.operation.version,
        {
            type: 'CLAIM',
            now: '2026-07-29T00:00:00.000Z',
            workerId: 'dead-worker',
            leaseExpiresAt: '2099-07-29T00:00:00.000Z',
        },
    );
    recoveryOperation = await operationStore.transition(recoveryOperation.operationId, recoveryOperation.version, {
        type: 'GENERATION_SUCCEEDED',
        now: '2026-07-29T00:00:01.000Z',
        generatedPayloadJson: JSON.stringify(recoveryPrepared),
    });
    let recoveryExecuteCount = 0;
    const recoveryCoordinator = new DraftOperationCoordinator(operationStore, {
        execute: async () => {
            recoveryExecuteCount += 1;
            throw new Error('model must not be called during prepared-result recovery');
        },
        commitPrepared: async (operation, prepared) => {
            const updated = await operationStore.commitSucceeded(
                operation.operationId,
                operation.version,
                (tx, current) => sessionStore.persistPreparedChapterDraft(tx, current, prepared),
            );
            sessionStore.invalidateCache();
            return updated;
        },
        findExistingResult: async () => null,
        getProvider: () => ({ providerType: 'http', model: 'test-model' }),
    });
    await recoveryCoordinator.initialize();
    const recovered = await waitForStatus(
        recoveryCoordinator,
        recoveryOperation.operationId,
        new Set(['succeeded']),
    );
    assert.equal(recoveryExecuteCount, 0);
    assert.equal(recovered.result.generationRevision, 1);
    await recoveryCoordinator.shutdown();

    // A late revision-1 result cannot attach after regeneration advanced the
    // batch child to revision 2.
    const batch = await sessionStore.createBatch({
        novelId: 'novel-atomic',
        volumeId: 'volume-atomic',
        anchorChapterId: 'chapter-atomic',
        mode: 'sequence_continuation',
        beats: [{
            title: '迟到结果测试',
            chapterGoal: '验证修订围栏',
            coreConflict: '旧结果与新修订竞争',
            keyEvents: ['启动修订'],
            reveals: ['旧结果迟到'],
            endingHook: '新修订继续',
            targetWordCount: 1200,
        }],
    });
    const approved = await sessionStore.approveBatchOutline(
        batch.draftBatchId,
        batch.version,
        batch.outline.revision,
        'atomic-test',
    );
    const lateCreated = await operationStore.createOrGet(operationInput('late-revision', {
        draftBatchId: batch.draftBatchId,
        childIndex: 0,
        generationRevision: 1,
    }));
    const latePrepared = preparedDraft(lateCreated.operation.operationId, {
        draftBatchId: batch.draftBatchId,
        childIndex: 0,
        expectedGenerationRevision: 1,
    });
    const lateCommitting = await advanceToCommitting(operationStore, lateCreated, latePrepared);
    const regenerated = await sessionStore.prepareBatchRegeneration(
        batch.draftBatchId,
        approved.version,
        0,
        'regeneration-run',
    );
    assert.equal(regenerated.batch.children[0].generationRevision, 2);
    await assert.rejects(
        operationStore.commitSucceeded(
            lateCommitting.operationId,
            lateCommitting.version,
            (tx, current) => sessionStore.persistPreparedChapterDraft(tx, current, latePrepared),
        ),
        (error) => error?.code === 'VERSION_CONFLICT',
    );
    assert.equal(await client.draftSession.count({ where: { sourceOperationId: lateCommitting.operationId } }), 0);
    assert.equal((await operationStore.get(lateCommitting.operationId)).status, 'committing');
    const child = await client.draftBatchChild.findUnique({
        where: { draftBatchId_childIndex: { draftBatchId: batch.draftBatchId, childIndex: 0 } },
    });
    assert.equal(child.generationRevision, 2);
    assert.equal(child.draftSessionId, null);

    let lateExecuteCount = 0;
    const lateCoordinator = new DraftOperationCoordinator(operationStore, {
        execute: async () => {
            lateExecuteCount += 1;
            throw new Error('late prepared result must not regenerate');
        },
        commitPrepared: (operation, prepared) => operationStore.commitSucceeded(
            operation.operationId,
            operation.version,
            (tx, current) => sessionStore.persistPreparedChapterDraft(tx, current, prepared),
        ),
        findExistingResult: async () => null,
        getProvider: () => ({ providerType: 'http', model: 'test-model' }),
    });
    await lateCoordinator.initialize();
    const rejectedLateResult = await waitForStatus(
        lateCoordinator,
        lateCommitting.operationId,
        new Set(['definitive_failed']),
    );
    assert.equal(lateExecuteCount, 0);
    assert.equal(rejectedLateResult.error.code, 'VERSION_CONFLICT');
    assert.equal(await client.draftSession.count({ where: { sourceOperationId: lateCommitting.operationId } }), 0);
    await lateCoordinator.shutdown();
} finally {
    await client.$disconnect();
    await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log('Draft operation atomic commit and race tests passed.');
