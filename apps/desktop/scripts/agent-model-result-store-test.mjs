import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-model-result-'));
const modulePath = path.join(tempRoot, 'AgentModelResultStore.mjs');
const source = await fs.readFile(new URL('../electron/automation/AgentModelResultStore.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
await fs.writeFile(modulePath, output, 'utf8');
const { AgentModelResultStore } = await import(pathToFileURL(modulePath).href);

const dbPath = path.join(tempRoot, 'model-results.db').replaceAll('\\', '/');
const dbUrl = `file:${dbPath}`;
const contract = {
    contractId: 'agent.scope_audit.response',
    version: '1.0.0',
    schema: { type: 'object' },
};
let client = new PrismaClient({ datasources: { db: { url: dbUrl } } });

try {
    let store = new AgentModelResultStore(client);
    const rawText = '{"experts":["editor"],"recommendations":[{"priority":"high"}]}';
    const original = await store.save('request-1', 'agent.generate_scope_audit', contract, rawText);
    assert.equal(original.revision, 1);
    assert.equal(original.rawText, rawText);
    assert.equal(original.resultHash.length, 64);

    await client.$disconnect();
    client = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    store = new AgentModelResultStore(client);
    const restored = await store.getLatest('request-1');
    assert.equal(restored.rawText, rawText);
    assert.equal(restored.contractId, contract.contractId);

    const firstClaim = await store.claimRepairAttempt('repair-attempt-1', 'request-1', 1);
    assert.equal(firstClaim.status, 'claimed');
    const repairedText = '{"experts":[],"recommendations":["修订第二章"],"findings":[],"conflicts":[]}';
    const repaired = await store.save('request-1', 'agent.generate_scope_audit', contract, repairedText, {
        repairAttemptId: 'repair-attempt-1',
        repairedFromRevision: 1,
    });
    assert.equal(repaired.revision, 2);

    // Simulate a lost IPC response after the repaired payload was checkpointed
    // but before the attempt ledger was marked completed.
    const reconciled = await store.claimRepairAttempt('repair-attempt-1', 'request-1', 1);
    assert.equal(reconciled.status, 'completed');
    assert.equal(reconciled.result.revision, 2);
    assert.equal(reconciled.result.rawText, repairedText);

    const duplicate = await store.save('request-1', 'agent.generate_scope_audit', contract, '{"ignored":true}', {
        repairAttemptId: 'repair-attempt-1',
        repairedFromRevision: 1,
    });
    assert.equal(duplicate.revision, 2);
    assert.equal((await store.getLatest('request-1')).revision, 2);

    await assert.rejects(
        store.save('request-too-large', 'agent.generate_scope_audit', contract, 'x'.repeat(4 * 1024 * 1024 + 1)),
        (error) => error?.code === 'MODEL_RESULT_TOO_LARGE',
    );

    console.log('agent model result checkpoint and repair ledger tests passed');
} finally {
    await client.$disconnect().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
}
