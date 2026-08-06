import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { PrismaClient } from '@novel-editor/core';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-database-lifecycle-'));
const sourcePath = new URL('../electron/database/DatabaseLifecycle.ts', import.meta.url);
const modulePath = path.join(tempRoot, 'DatabaseLifecycle.mjs');
const source = await fs.readFile(sourcePath, 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
await fs.writeFile(modulePath, output, 'utf8');
const lifecycle = await import(pathToFileURL(modulePath).href);
const migrationsSource = await fs.readFile(new URL('../electron/database/DatabaseMigrations.ts', import.meta.url), 'utf8');
const migrationsModulePath = path.join(tempRoot, 'DatabaseMigrations.mjs');
const migrationsOutput = ts.transpileModule(migrationsSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
await fs.writeFile(migrationsModulePath, migrationsOutput, 'utf8');
const { DATABASE_MIGRATIONS } = await import(pathToFileURL(migrationsModulePath).href);

const dbPath = path.join(tempRoot, 'novel_editor.db');
const dbUrl = `file:${dbPath}`;
const createClient = () => new PrismaClient({ datasources: { db: { url: dbUrl } } });

try {
    let client = createClient();
    await client.$executeRawUnsafe('CREATE TABLE Novel (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    await client.$executeRawUnsafe('PRAGMA user_version = 0');
    await client.$disconnect();

    const resetResult = await lifecycle.prepareDatabaseForSchema({
        databasePath: dbPath,
        userDataPath: tempRoot,
        expectedVersion: 2,
        createProbeClient: createClient,
    });
    assert.equal(resetResult.reset, true);
    assert.equal(resetResult.reason, 'incompatible');
    assert.ok(resetResult.archiveDirectory);
    assert.equal(await fs.stat(dbPath).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(resetResult.archiveDirectory, 'novel_editor.db')).then(() => true, () => false), true);

    client = createClient();
    await client.$executeRawUnsafe('CREATE TABLE AgentMessage (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, sequence INTEGER NOT NULL)');
    const migration = DATABASE_MIGRATIONS[0];
    const firstRun = await lifecycle.runDatabaseMigrations({
        database: client,
        databasePath: dbPath,
        userDataPath: tempRoot,
        migrations: [migration],
        expectedVersion: 2,
        initialDatabase: true,
    });
    assert.deepEqual(firstRun.applied, ['2:agent-message-sequence-unique-index']);
    assert.ok(firstRun.snapshotPath);
    assert.equal(await fs.stat(firstRun.snapshotPath).then(() => true, () => false), true);
    await lifecycle.finalizeDatabaseSchema(client, 2);
    await client.$disconnect();

    client = createClient();
    const repeatRun = await lifecycle.runDatabaseMigrations({
        database: client,
        databasePath: dbPath,
        userDataPath: tempRoot,
        migrations: [migration],
        expectedVersion: 2,
        initialDatabase: false,
    });
    assert.deepEqual(repeatRun.applied, []);

    const futureRun = await lifecycle.runDatabaseMigrations({
        database: client,
        databasePath: dbPath,
        userDataPath: tempRoot,
        migrations: [
            migration,
            {
                version: 3,
                name: 'test-future-migration',
                checksum: 'test-future-migration-v1',
                up: async (database) => {
                    await database.$executeRawUnsafe('CREATE TABLE FutureMigrationCheck (id TEXT PRIMARY KEY)');
                },
            },
        ],
        expectedVersion: 3,
        initialDatabase: false,
    });
    assert.deepEqual(futureRun.applied, ['3:test-future-migration']);
    await lifecycle.finalizeDatabaseSchema(client, 3);
    const versionRows = await client.$queryRawUnsafe('PRAGMA user_version');
    assert.equal(Number(versionRows[0].user_version), 3);
    await assert.rejects(
        lifecycle.runDatabaseMigrations({
            database: client,
            databasePath: dbPath,
            userDataPath: tempRoot,
            migrations: [
                { ...migration, checksum: 'changed-after-release' },
                {
                    version: 3,
                    name: 'test-future-migration',
                    checksum: 'test-future-migration-v1',
                    up: async () => undefined,
                },
            ],
            expectedVersion: 3,
            initialDatabase: false,
        }),
        /migration ledger mismatch/i,
    );
    await client.$disconnect();

    await assert.rejects(
        lifecycle.prepareDatabaseForSchema({
            databasePath: dbPath,
            userDataPath: tempRoot,
            expectedVersion: 2,
            createProbeClient: createClient,
        }),
        /newer than this app supports/i,
    );
    assert.equal(await fs.stat(dbPath).then(() => true, () => false), true);

    const duplicateDbPath = path.join(tempRoot, 'duplicate.db');
    const duplicateDbUrl = `file:${duplicateDbPath}`;
    const duplicateClient = new PrismaClient({ datasources: { db: { url: duplicateDbUrl } } });
    await duplicateClient.$executeRawUnsafe(
        'CREATE TABLE AgentMessage (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, sequence INTEGER NOT NULL)',
    );
    await duplicateClient.$executeRawUnsafe(
        "INSERT INTO AgentMessage (id, conversationId, sequence) VALUES ('a', 'conversation-1', 1), ('b', 'conversation-1', 1)",
    );
    await duplicateClient.$executeRawUnsafe('PRAGMA user_version = 1');
    await assert.rejects(
        lifecycle.runDatabaseMigrations({
            database: duplicateClient,
            databasePath: duplicateDbPath,
            userDataPath: tempRoot,
            migrations: DATABASE_MIGRATIONS,
            expectedVersion: 2,
            initialDatabase: false,
        }),
        /duplicate sequence/i,
    );
    const duplicateVersionRows = await duplicateClient.$queryRawUnsafe('PRAGMA user_version');
    assert.equal(Number(duplicateVersionRows[0].user_version), 1);
    await duplicateClient.$disconnect();
    console.log('database lifecycle tests passed');
} finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
}
