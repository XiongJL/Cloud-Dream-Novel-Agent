import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

const scratch = path.resolve('../../tmp');
await fs.mkdir(scratch, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(scratch, 'model-checkpoint-lock-'));
const modulePath = path.join(tempRoot, 'AgentModelResultStore.mjs');
const source = await fs.readFile(new URL('../electron/automation/AgentModelResultStore.ts', import.meta.url), 'utf8');
await fs.writeFile(modulePath, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText, 'utf8');
const { AgentModelResultStore } = await import(pathToFileURL(modulePath).href);
const dbPath = path.join(tempRoot, 'checkpoint.db');
const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath.replaceAll('\\', '/')}?connection_limit=1` } } });
const contract = { contractId: 'test.analysis', version: '1.0.0', schema: { type: 'object' } };
let holder;
try {
    const store = new AgentModelResultStore(client);
    await store.ensureSchema();
    await client.$queryRawUnsafe('PRAGMA busy_timeout = 20');
    // POSIX file locks are process-scoped: another SQLite connection closing
    // in this process can release them. Hold the real lock in a separate process.
    holder = spawn(process.execPath, ['--input-type=module', '-e', `
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(process.argv[1]);
        database.exec('BEGIN EXCLUSIVE');
        process.send('locked');
        process.once('message', () => {
            database.exec('COMMIT');
            database.close();
            process.send('released', () => process.disconnect());
        });
    `, dbPath], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    assert.equal((await once(holder, 'message'))[0], 'locked');
    const captured = '{"summary":"Captured once","findings":[]}';
    let settled = false;
    const saving = store.save('response-once', 'agent.analyze_skill_work_unit', contract, captured);
    saving.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(settled, false, 'checkpoint persistence must wait while another process holds the SQLite lock');
    const released = once(holder, 'message');
    holder.send('release');
    assert.equal((await released)[0], 'released');
    const saved = await saving;
    assert.equal(saved.rawText, captured);
    assert.equal(saved.revision, 1);
    assert.equal((await store.getLatest('response-once')).rawText, captured);

    const otherStore = new AgentModelResultStore(client);
    await otherStore.ensureSchema();
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? store : otherStore).save('same-request', 'test', contract, `{"revision":${i}}`)));
    assert.deepEqual(concurrent.map(item => item.revision), [1, 2, 3, 4, 5, 6, 7, 8], 'stores sharing a client must allocate revisions without races');

    function wrappedDatabase(error) {
        let attempts = 0;
        let currentError = error;
        const database = new Proxy(client, { get(target, key) {
            if (key === '$executeRawUnsafe') return async (sql, ...params) => {
                if (sql.includes('INSERT INTO "AgentModelResultCheckpoint"')) {
                    attempts += 1;
                    if (currentError) throw currentError;
                }
                return target.$executeRawUnsafe(sql, ...params);
            };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        return { store: new AgentModelResultStore(database), attempts: () => attempts, clear: () => { currentError = null; } };
    }
    const busy = wrappedDatabase(Object.assign(new Error('database is locked'), { code: 'P2010', meta: { code: '5' } }));
    await assert.rejects(busy.store.save('held-lock', 'test', contract, captured), error =>
        error.code === 'STORAGE_BUSY' && error.checkpointPersisted === false && error.retryable === false);
    assert.equal(busy.attempts(), 5, 'persistent locks must fail after a finite number of local write attempts');
    assert.equal(await store.getLatest('held-lock'), null);
    const fullError = Object.assign(new Error('database or disk is full'), { code: 'P2010', meta: { code: '13' } });
    const full = wrappedDatabase(fullError);
    await assert.rejects(full.store.save('disk-full', 'test', contract, captured), error => error === fullError);
    assert.equal(full.attempts(), 1, 'disk full is not a transient lock and must not be retried');
    busy.clear();
    const afterFailure = await busy.store.save('queue-released', 'test', contract, captured);
    assert.equal(afterFailure.rawText, captured, 'the failed queue must release subsequent writes');
    console.log('Checkpoint real SQLite lock recovery, bounded failure, revision serialization and non-busy isolation passed.');
} finally {
    holder?.kill();
    await client.$disconnect();
    assert.ok(path.resolve(tempRoot).startsWith(scratch + path.sep));
    await fs.rm(tempRoot, { recursive: true, force: true });
}
