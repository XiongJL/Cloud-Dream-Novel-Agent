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
const storeUrl = await transpiledUrl('../electron/automation/DraftOperationStore.ts', [
    ["from '@novel-editor/core'", `from '${coreModuleUrl}'`],
    ["from '../../shared/draftOperation'", `from '${stateUrl}'`],
]);
const coordinatorUrl = await transpiledUrl('../electron/automation/DraftOperationCoordinator.ts', [
    ["from '../../shared/draftOperation'", `from '${stateUrl}'`],
    ["from './DraftOperationStore'", `from '${storeUrl}'`],
]);
const { DraftOperationStore } = await import(storeUrl);
const { DraftOperationCoordinator } = await import(coordinatorUrl);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-draft-coordinator-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());
const dbPath = path.join(tempRoot, 'draft-coordinator.db').replaceAll('\\', '/');
const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

const input = (suffix, payload = {}) => ({
    operationKey: `operation-key-${suffix}`,
    paramsHash: `params-hash-${suffix}`,
    requestJson: JSON.stringify({ mode: suffix, ...payload }),
    novelId: 'novel-1',
    chapterId: 'chapter-1',
    generationRevision: 1,
    sourceChapterVersion: 1,
    sourceContentHash: 'content-hash',
    operationDeadlineAt: '2099-07-29T00:00:00.000Z',
});

async function waitForStatus(coordinator, operationId, terminal, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const view = await coordinator.get(operationId);
        if (terminal.has(view.status)) return view;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${operationId}`);
}

async function persistDraftResult(operation, draftSessionId) {
    await client.draftSession.create({
        data: {
            draftSessionId,
            workspace: 'chapter-editor',
            type: 'chapter-draft',
            source: 'internal-ai',
            origin: 'desktop-ui',
            novelId: operation.novelId,
            chapterId: operation.chapterId,
            sourceOperationId: operation.operationId,
            generationRevision: operation.generationRevision,
            status: 'draft',
            payloadJson: '{}',
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
    });
}

try {
    const schemaSql = await readFile(
        new URL('../../../packages/core/generated/client/schema-init.sql', import.meta.url),
        'utf8',
    );
    for (const statement of splitSqlStatements(schemaSql)) {
        await client.$executeRawUnsafe(statement);
    }

    const store = new DraftOperationStore(client);
    const attempts = new Map();
    const coordinator = new DraftOperationCoordinator(store, {
        execute: async (operation, payload, signal) => {
            const count = (attempts.get(operation.operationId) || 0) + 1;
            attempts.set(operation.operationId, count);
            if (payload.mode === 'retry' && count === 1) {
                throw Object.assign(new Error('temporary network failure'), {
                    code: 'NETWORK_ERROR',
                    details: { retryable: true },
                });
            }
            if (payload.mode === 'cancel') {
                await new Promise((resolve, reject) => {
                    if (signal.aborted) {
                        reject(signal.reason);
                        return;
                    }
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            }
            const draftSessionId = `draft-${payload.mode}`;
            await persistDraftResult(operation, draftSessionId);
            return {
                draftSessionId,
                generationRevision: operation.generationRevision,
            };
        },
        findExistingResult: async () => null,
        getProvider: () => ({ providerType: 'http', model: 'test-model' }),
    });
    await coordinator.initialize();

    const started = await coordinator.start(input('success'));
    const succeeded = await waitForStatus(coordinator, started.operation.operationId, new Set(['succeeded']));
    assert.equal(succeeded.result.draftSessionId, 'draft-success');
    assert.equal(succeeded.attempt, 1);
    const reused = await coordinator.start(input('success'));
    assert.equal(reused.existing, true);
    assert.equal(reused.operation.operationId, started.operation.operationId);

    const retryStarted = await coordinator.start(input('retry'));
    const retrySucceeded = await waitForStatus(
        coordinator,
        retryStarted.operation.operationId,
        new Set(['succeeded']),
        5000,
    );
    assert.equal(retrySucceeded.attempt, 2);
    assert.equal(attempts.get(retryStarted.operation.operationId), 2);

    const cancelStarted = await coordinator.start(input('cancel'));
    const running = await waitForStatus(
        coordinator,
        cancelStarted.operation.operationId,
        new Set(['running_generation']),
    );
    await coordinator.cancel(running.operationId, 1);
    const cancelled = await waitForStatus(coordinator, running.operationId, new Set(['cancelled']));
    assert.equal(cancelled.status, 'cancelled');

    await coordinator.shutdown();

    const recoveredCreated = await store.createOrGet(input('restart'));
    await store.transition(recoveredCreated.operation.operationId, recoveredCreated.operation.version, {
        type: 'CLAIM',
        now: '2026-07-29T00:00:00.000Z',
        workerId: 'dead-worker',
        leaseExpiresAt: '2099-07-29T00:00:00.000Z',
    });
    const restarted = new DraftOperationCoordinator(store, {
        execute: async (operation, payload) => {
            const draftSessionId = `draft-${payload.mode}`;
            await persistDraftResult(operation, draftSessionId);
            return {
                draftSessionId,
                generationRevision: operation.generationRevision,
            };
        },
        findExistingResult: async () => null,
        getProvider: () => ({ providerType: 'http', model: 'test-model' }),
    });
    await restarted.initialize();
    const recovered = await waitForStatus(
        restarted,
        recoveredCreated.operation.operationId,
        new Set(['succeeded']),
        5000,
    );
    assert.equal(recovered.result.draftSessionId, 'draft-restart');
    assert.equal(recovered.attempt, 2);
    await restarted.shutdown();

    const outbox = await store.listPendingOutbox();
    assert.equal(outbox.filter((item) => item.eventType === 'draft.operation.completed').length, 4);

    const delivered = [];
    const dispatcher = new DraftOperationCoordinator(store, {
        execute: async () => {
            throw new Error('No recoverable operation should execute during outbox delivery');
        },
        findExistingResult: async () => null,
        getProvider: () => ({ providerType: 'http', model: 'test-model' }),
        deliverCompletion: async (event) => {
            delivered.push(event);
        },
    });
    await dispatcher.initialize();
    const deliveryDeadline = Date.now() + 2000;
    while ((await store.listPendingOutbox()).length > 0 && Date.now() < deliveryDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(delivered.length, 4);
    assert.equal(new Set(delivered.map((item) => item.outboxId)).size, 4);
    assert.ok(delivered.every((item) => item.payload.operationId === item.operationId));
    assert.equal((await store.listPendingOutbox()).length, 0);
    await dispatcher.shutdown();

    let lockedDrainAttempts = 0;
    const lockedDispatcher = new DraftOperationCoordinator({
        ensureSchema: async () => undefined,
        listRecoverable: async () => [],
        listPendingOutbox: async () => {
            lockedDrainAttempts += 1;
            throw Object.assign(new Error('database is locked'), { code: 'P2010' });
        },
    }, {
        execute: async () => undefined,
        findExistingResult: async () => null,
        getProvider: () => ({ providerType: 'http', model: 'test-model' }),
        deliverCompletion: async () => undefined,
    });
    await lockedDispatcher.drainCompletionOutbox();
    assert.equal(lockedDrainAttempts, 1);
    await lockedDispatcher.shutdown();
} finally {
    await client.$disconnect();
    await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log('Draft operation coordinator tests passed.');
