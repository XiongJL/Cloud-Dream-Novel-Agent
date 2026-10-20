import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { PrismaClient } from '@novel-editor/core';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-backup-test-'));
await fs.mkdir(new URL('../node_modules/.cache/', import.meta.url), { recursive: true });
const compileRoot = await fs.mkdtemp(new URL('../node_modules/.cache/backup-test-', import.meta.url));
await build({ entryPoints: [new URL('../electron/backup/BackupEngine.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(compileRoot, 'engine.cjs') });
await build({ entryPoints: [new URL('../electron/backup/DatasetManager.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(compileRoot, 'dataset.cjs') });
await build({ entryPoints: [new URL('../electron/backup/BackupArchive.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(compileRoot, 'archive.cjs') });
const { BackupEngine } = require(path.join(compileRoot, 'engine.cjs'));
const { DatasetManager } = require(path.join(compileRoot, 'dataset.cjs'));
const { zipFiles, openArchive, safeChild } = require(path.join(compileRoot, 'archive.cjs'));
const create = file => new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
const clients = [];
const file = path.join(root, 'novel_editor.db');
const database = create(file); clients.push(database);
const schema = await fs.readFile(new URL('../../../packages/core/generated/client/schema-init.sql', import.meta.url), 'utf8');
const statement = sql => database.$executeRawUnsafe(sql);
const escape = name => `"${name}"`;
const tableNames = [...schema.matchAll(/CREATE TABLE "([^"]+)"/g)].map(value => value[1]);
const ids = new Map(tableNames.map(table => [table, `fixture-${table}`]));
const dataset = new DatasetManager(root, file);
let cancelPhase = '';
const engine = new BackupEngine({ dataset, database, createDatabase: create, appVersion: '0.2.0', schemaVersion: 2, progress: value => { if (value.phase === cancelPhase) engine.cancel(); } });

try {
    for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await statement(sql);
    await statement('PRAGMA user_version = 2');
    await statement('CREATE TABLE AppSchemaMigration (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, appliedAt TEXT)');
    await statement('CREATE TABLE rag_vector_chunks (id TEXT PRIMARY KEY, secret_cache TEXT)');
    await statement("INSERT INTO rag_vector_chunks VALUES ('cached', 'cache-should-not-be-backed-up')");
    await database.$transaction(async tx => {
        await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');
        for (const table of tableNames.filter(table => table !== 'SyncState')) {
            const columns = await tx.$queryRawUnsafe(`PRAGMA table_info(${escape(table)})`);
            const relations = await tx.$queryRawUnsafe(`PRAGMA foreign_key_list(${escape(table)})`);
            const row = {};
            for (const col of columns) {
                if (col.dflt_value !== null && !col.pk) continue;
                if (!col.notnull && !col.pk) continue;
                let value = /INT|REAL|NUMERIC/i.test(col.type) ? 1 : /BOOL/i.test(col.type) ? false : /DATE/i.test(col.type) ? new Date('2026-10-08T00:00:00Z') : col.pk ? ids.get(table) : `fixture-${col.name}`;
                const relation = relations.find(fk => fk.from === col.name);
                if (relation) value = ids.get(relation.table);
                if (col.name === 'novelId' || col.name === 'ownerNovelId' || col.name === 'sourceNovelId') value = ids.get('Novel');
                if (['chapterId', 'targetChapterId', 'anchorChapterId'].includes(col.name)) value = ids.get('Chapter');
                if (col.name === 'volumeId') value = ids.get('Volume');
                if (col.name === 'sourceOperationId' || col.name === 'operationId') value = ids.get('DraftGenerationOperation');
                if (col.name === 'sourceArtifactId') value = ids.get('AgentArtifact');
                if (col.name === 'requestId') value = 'request-one';
                if (col.name === 'status') value = table === 'AgentRun' ? 'completed' : table === 'DraftGenerationOperation' ? 'succeeded' : 'draft';
                if (col.name.endsWith('Json')) value = '{}';
                if (table === 'Chapter' && col.name === 'content') value = JSON.stringify({ root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: ids.get('Novel') }, { type: 'mention', mentionId: ids.get('Character'), mentionName: '人物' }, { type: 'plot-anchor', ids: [ids.get('PlotPointAnchor')], children: [] }] }] } });
                if (['DraftSession', 'DraftBatch', 'DraftBatchChild'].includes(table) && col.name === 'payloadJson') value = JSON.stringify({ draftSessionId: ids.get('DraftSession'), draftBatchId: ids.get('DraftBatch'), novelId: ids.get('Novel'), chapterId: ids.get('Chapter'), status: 'draft', version: 1, payload: { content: '历史草稿' }, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' });
                row[col.name] = value;
            }
            const fields = Object.keys(row);
            await tx.$executeRawUnsafe(`INSERT INTO ${escape(table)} (${fields.map(escape).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...Object.values(row));
        }
    }, { timeout: 60000 });
    await database.character.update({ where: { id: ids.get('Character') }, data: { avatar: 'characters/portrait.png' } });
    const originalChapter = await database.chapter.findUnique({ where: { id: ids.get('Chapter') } });
    const contentFormats = new Map([
        ['empty', ''], ['whitespace', ' \r\n\t'],
        ['plain', '旧版第一段。\r\n\r\n第二段，原始换行必须保留。'],
        ['json-prose', JSON.stringify({ chapterId: ids.get('Chapter'), text: '正文里的 JSON 示例，不是编辑器状态' })],
        ['json-string', JSON.stringify('正文里的 JSON 字符串')],
        ['truncated-json', '{"root":{"children":[旧版正文'],
        ['mixed', originalChapter.content + '\r\n旧版尾部正文。'],
    ]);
    await database.chapter.createMany({ data: [...contentFormats].map(([name, content], order) => ({ id: `format-${name}`, title: `format-${name}`, volumeId: ids.get('Volume'), order: order + 2, content })) });
    await database.idea.createMany({ data: Array.from({ length: 210 }, (_, index) => ({ id: `bulk-idea-${index}`, novelId: ids.get('Novel'), content: '大记录分页验收'.repeat(4096), quote: 'characters/portrait.png' })) });
    await fs.mkdir(path.join(root, 'characters'), { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5MsAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(root, 'characters', 'portrait.png'), png);
    await fs.mkdir(path.join(root, 'automation'), { recursive: true });
    await fs.writeFile(path.join(root, 'automation', 'review-comments.json'), JSON.stringify({ comments: [{ commentId: 'comment-one', novelId: ids.get('Novel'), sourceConversationId: ids.get('AgentConversation'), sourceRunId: ids.get('AgentRun'), draftSessionId: ids.get('DraftSession'), reviewVersionId: ids.get('DraftSession'), anchor: { kind: 'paragraph', targetId: ids.get('Chapter') }, body: '保留审批意见', status: 'local_draft' }] }));
    await fs.writeFile(path.join(root, 'ai-settings.json'), JSON.stringify({ apiKey: 'CREDENTIAL-SENTINEL-NEVER-EXPORT' }));
    await fs.mkdir(path.join(root, 'agent'));
    const runtime = create(path.join(root, 'agent', 'agent_state.db')); clients.push(runtime);
    await runtime.$executeRawUnsafe('CREATE TABLE tool_invocations (invocation_key TEXT PRIMARY KEY, request_id TEXT, run_id TEXT, status TEXT, result_json TEXT)');
    await runtime.$executeRawUnsafe("INSERT INTO tool_invocations VALUES ('historical-call', 'request-one', 'fixture-AgentRun', 'unknown', '{\"evidence\":\"keep-this-ledger\"}')");
    await runtime.$disconnect();
    const baseline = await engine.fingerprint();
    const originalNovel = await database.novel.findUnique({ where: { id: ids.get('Novel') } });
    const plain = path.join(root, 'plain.nebak'), encrypted = path.join(root, 'encrypted.nebak');
    await engine.export(plain);
    await engine.export(encrypted, 'test-password');
    await assert.rejects(engine.inspect(encrypted, 'wrong'), error => error.code === 'DECRYPTION_FAILED');
    const inspected = await engine.inspect(encrypted, 'test-password');
    assert.equal(inspected.completeness, 'complete');
    assert.equal(inspected.resources, 1);
    assert.equal(inspected.novels.length, 1);
    const opened = await openArchive(plain, path.join(root, 'unpacked'));
    const bundle = JSON.parse(await fs.readFile(path.join(opened.payload, 'bundle-manifest.json'), 'utf8'));
    assert.equal(Object.keys(bundle.domains).length, 41);
    assert.ok(bundle.domains.AgentSkillPackPreference);
    assert.ok(bundle.domains.AgentMessage && bundle.domains.DraftSession && bundle.domains._IdeaToTag);
    assert.ok(!bundle.domains.rag_vector_chunks && !bundle.domains.SyncState);
    assert.ok(!JSON.stringify(bundle).includes('CREDENTIAL-SENTINEL'));
    const corruptRoot = path.join(root, 'corrupt'); await fs.mkdir(corruptRoot);
    await fs.copyFile(path.join(opened.outer, 'manifest.json'), path.join(corruptRoot, 'manifest.json'));
    const corruptPayload = await fs.readFile(path.join(opened.outer, 'payload.zip')); corruptPayload[Math.floor(corruptPayload.length / 2)] ^= 0xff;
    await fs.writeFile(path.join(corruptRoot, 'payload.zip'), corruptPayload);
    const corruptArchive = path.join(root, 'corrupt.nebak');
    await zipFiles(corruptArchive, ['manifest.json', 'payload.zip'].map(name => ({ name, file: path.join(corruptRoot, name) })), false);
    await assert.rejects(engine.inspect(corruptArchive), error => error.code === 'CORRUPT_ARCHIVE');
    for (const domain of Object.values(bundle.domains)) assert.ok(!(await fs.readFile(path.join(opened.payload, domain.name), 'utf8')).includes('CREDENTIAL-SENTINEL'));
    await statement('CREATE TABLE FutureFeature (id TEXT PRIMARY KEY)');
    await assert.rejects(engine.export(path.join(root, 'future.nebak')), error => error.code === 'UNREGISTERED_DOMAIN');
    await statement('DROP TABLE FutureFeature');
    await fs.rename(path.join(root, 'characters', 'portrait.png'), path.join(root, 'characters', 'missing.png'));
    await assert.rejects(engine.export(path.join(root, 'missing.nebak')), error => error.code === 'RESOURCE_MISSING');
    await fs.rename(path.join(root, 'characters', 'missing.png'), path.join(root, 'characters', 'portrait.png'));
    assert.equal(await fs.stat(path.join(root, 'missing.nebak')).catch(() => null), null);
    engine.begin(); cancelPhase = 'packaging';
    await assert.rejects(engine.export(path.join(root, 'cancelled.nebak')), error => error.code === 'CANCELLED' || error.name === 'AbortError');
    assert.equal(await fs.stat(path.join(root, 'cancelled.nebak')).catch(() => null), null);
    engine.begin(); cancelPhase = '';
    await database.novel.update({ where: { id: ids.get('Novel') }, data: { title: '预览后的修改' } });
    await assert.rejects(engine.restore(inspected.inspectionId, 'replace_all'), error => error.code === 'PLAN_STALE');
    await database.novel.update({ where: { id: ids.get('Novel') }, data: { title: originalNovel.title, updatedAt: originalNovel.updatedAt } });
    const copyPlan = await engine.inspect(plain);
    const result = await engine.restore(copyPlan.inspectionId, 'copy');
    const copied = create(result.location.databasePath); clients.push(copied);
    assert.equal(await copied.novel.count(), 2);
    assert.equal(await copied.agentMessage.count(), 2);
    assert.equal(await copied.draftSession.count(), 2);
    assert.equal(await copied.idea.count(), 422, 'keyset pagination and byte-bounded batches preserve every record');
    assert.equal((await copied.idea.findFirst({ where: { id: { not: 'bulk-idea-0' }, quote: 'characters/portrait.png' } })).quote, 'characters/portrait.png', 'free text resembling a resource path is preserved');
    assert.equal(await copied.$queryRawUnsafe('SELECT COUNT(*) AS count FROM _IdeaToTag').then(value => Number(value[0].count)), 2);
    const newChapter = await copied.chapter.findFirst({ where: { id: { not: ids.get('Chapter') }, title: originalChapter.title } });
    const tree = JSON.parse(newChapter.content);
    assert.equal(tree.root.children[0].children[0].text, ids.get('Novel'), 'free text must not be rewritten');
    assert.notEqual(tree.root.children[0].children[1].mentionId, ids.get('Character'));
    assert.notEqual(tree.root.children[0].children[2].ids[0], ids.get('PlotPointAnchor'));
    for (const [name, content] of contentFormats) {
        const chapters = await copied.chapter.findMany({ where: { title: `format-${name}` } });
        assert.equal(chapters.length, 2);
        for (const chapter of chapters) assert.equal(chapter.content, content, `copy preserves ${name} bytes without normalizing or rewriting prose`);
    }
    const newCharacter = await copied.character.findFirst({ where: { id: { not: ids.get('Character') } } });
    assert.deepEqual(await fs.readFile(path.join(result.location.root, newCharacter.avatar)), png);
    const opinions = JSON.parse(await fs.readFile(path.join(result.location.root, 'automation', 'review-comments.json'), 'utf8'));
    assert.equal(opinions.comments.length, 2);
    assert.notEqual(opinions.comments[1].sourceConversationId, ids.get('AgentConversation'));
    const copiedEngine = new BackupEngine({ dataset, database: copied, createDatabase: create, appVersion: '0.2.0', schemaVersion: 2 });
    const secondBackup = path.join(root, 'second-generation.nebak');
    await copiedEngine.export(secondBackup);
    const secondOpened = await openArchive(secondBackup, path.join(root, 'second-unpacked'));
    const ledger = await fs.readFile(path.join(secondOpened.payload, 'files', 'runtime-history.ndjson'), 'utf8');
    assert.equal(ledger.trim().split('\n').length, 1, 'restored history remains portable without duplicates');
    assert.ok(ledger.includes('keep-this-ledger'));
    // Failure between activation and acknowledgement: corrupt next generation,
    // startup must return to the original generation rather than creating a blank DB.
    await copied.$disconnect();
    await fs.writeFile(result.location.databasePath, 'broken candidate');
    await dataset.recover((location, activationCheck) => engine.validateDataset(location, activationCheck));
    assert.equal(dataset.current().id, null);
    await dataset.finishRecovery();
    assert.equal(await engine.fingerprint(), baseline, 'original database must stay unchanged');
    assert.equal(await database.novel.count(), 1);
    const fullPlan = await engine.inspect(plain);
    const full = await engine.restore(fullPlan.inspectionId, 'replace_all');
    const restored = create(full.location.databasePath); clients.push(restored);
    assert.equal(await restored.agentMessage.count(), 1);
    assert.equal(await restored.item.count(), 1);
    assert.equal(await restored.mapCanvas.count(), 1);
    assert.equal(await restored.draftSession.count(), 1);
    assert.equal((await restored.chapter.findFirst()).content, (await database.chapter.findFirst()).content, 'full restore preserves the exact source JSON');
    for (const [name, content] of contentFormats) assert.equal((await restored.chapter.findUnique({ where: { id: `format-${name}` } })).content, content, `full restore preserves ${name} bytes`);
    assert.equal((await restored.character.findFirst()).avatar, 'characters/portrait.png', 'full restore preserves resource references');
    assert.equal(await restored.$queryRawUnsafe('SELECT deliveryStatus FROM DraftOperationOutbox').then(v => v[0].deliveryStatus), 'restored_archive');
    assert.ok(await fs.stat(full.rollbackPath));
    assert.equal(await fs.readFile(path.join(root, 'ai-settings.json'), 'utf8').then(v => v.includes('CREDENTIAL-SENTINEL')), true);
    // Legacy importer may only make copies, never overwrite current data.
    const legacyRoot = path.join(root, 'legacy'); await fs.mkdir(legacyRoot);
    const legacyData = { novels: await database.novel.findMany(), volumes: await database.volume.findMany(), chapters: await database.chapter.findMany(), characters: await database.character.findMany(), ideas: await database.idea.findMany(), tags: await database.tag.findMany() };
    await fs.writeFile(path.join(legacyRoot, 'manifest.json'), JSON.stringify({ version: 1, createdAt: '2026-10-08T00:00:00Z', encrypted: false }));
    await fs.writeFile(path.join(legacyRoot, 'data.json'), JSON.stringify(legacyData));
    const legacyFile = path.join(root, 'legacy.nebak');
    await zipFiles(legacyFile, ['manifest.json', 'data.json'].map(name => ({ name, file: path.join(legacyRoot, name) })));
    const legacyPlan = await engine.inspect(legacyFile);
    assert.deepEqual(legacyPlan.allowedModes, ['copy']);
    await assert.rejects(engine.restore(legacyPlan.inspectionId, 'replace_all'), error => error.code === 'INCOMPLETE_LEGACY');
    assert.throws(() => safeChild(root, '../escape'), error => error.code === 'CORRUPT_ARCHIVE');
    assert.throws(() => safeChild(root, 'C:/escape'), error => error.code === 'CORRUPT_ARCHIVE');
    assert.throws(() => safeChild(root, 'images/CON.png'), error => error.code === 'CORRUPT_ARCHIVE');
    assert.throws(() => safeChild(root, 'images/name. '), error => error.code === 'CORRUPT_ARCHIVE');
    await dataset.finishRecovery();
    const activeEngine = new BackupEngine({ dataset, database: restored, createDatabase: create, appVersion: '0.2.0', schemaVersion: 2 });
    const legacyCopyPlan = await activeEngine.inspect(legacyFile);
    const legacyCopy = await activeEngine.restore(legacyCopyPlan.inspectionId, 'copy');
    const legacyDatabase = create(legacyCopy.location.databasePath); clients.push(legacyDatabase);
    assert.equal(await legacyDatabase.novel.count(), 2);
    const legacyCharacter = await legacyDatabase.character.findFirst({ where: { id: { not: ids.get('Character') } } });
    assert.ok(legacyCharacter.avatar.includes('missing-'), 'legacy image must not silently bind to another local image');
console.log('Backup integration passed: all 41 domains including pack defaults, empty/legacy/mixed content bytes, JSON prose isolation, implicit edges, encryption, resources, messages/drafts/reviews, future-table guard, stale plans, copy identity, safe activation/rollback and legacy overwrite rejection.');
} finally {
    await Promise.allSettled(clients.map(client => client.$disconnect()));
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(compileRoot, { recursive: true, force: true });
}
