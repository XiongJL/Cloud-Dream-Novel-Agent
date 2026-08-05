import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../electron/agent/DurableDraftCutover.ts', import.meta.url), 'utf8');
const automationServiceSource = await readFile(
    new URL('../electron/automation/AutomationService.ts', import.meta.url),
    'utf8',
);
const automationServerSource = await readFile(
    new URL('../electron/automation/AutomationServer.ts', import.meta.url),
    'utf8',
);
const mcpBridgeSource = await readFile(new URL('./novel-editor-mcp.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(automationServiceSource, /case 'chapter\.generate_draft'/u);
assert.doesNotMatch(automationServerSource, /^\s*'chapter\.generate_draft',\s*$/mu);
assert.doesNotMatch(mcpBridgeSource, /name: 'chapter\.generate_draft'/u);
assert.match(mcpBridgeSource, /name: 'chapter\.draft\.start'/u);
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { applyDurableDraftCutover, DURABLE_DRAFT_CUTOVER_VERSION } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-cutover-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());

const calls = [];
const names = [
    'draftOperationOutbox',
    'draftGenerationAttempt',
    'draftGenerationOperation',
    'draftBatchChild',
    'draftSession',
    'draftBatch',
    'agentRunEvent',
    'agentArtifact',
    'agentRun',
    'agentAttachment',
    'agentMessage',
    'agentConversation',
    'agentRevisionTask',
];
const transaction = Object.fromEntries(names.map((name, index) => [name, {
    deleteMany: async () => {
        calls.push(name);
        return { count: index + 1 };
    },
}]));
transaction.$executeRawUnsafe = async (query) => {
    assert.match(query, /DROP TABLE IF EXISTS "DraftWorkspaceState"/u);
    calls.push('dropDraftWorkspaceState');
    return 0;
};
const database = {
    $transaction: async (callback) => callback(transaction),
    $queryRawUnsafe: async (query) => {
        if (query.includes('COUNT(*) FROM Novel')) {
            return [{ novelCount: 1, volumeCount: 2, chapterCount: 3 }];
        }
        if (query.includes('SELECT id, content, deleted FROM Chapter')) {
            return [
                { id: 'chapter-1', content: '正式正文一', deleted: false },
                { id: 'chapter-2', content: '正式正文二', deleted: false },
                { id: 'chapter-3', content: '已删除章节', deleted: true },
            ];
        }
        throw new Error(`Unexpected query: ${query}`);
    },
};

try {
    await fs.mkdir(path.join(tempRoot, 'agent'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'automation'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'covers'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'agent', 'agent_state.db'), 'legacy-agent');
    await fs.writeFile(path.join(tempRoot, 'automation', 'draft-sessions.json'), '{"sessions":[]}');
    await fs.writeFile(path.join(tempRoot, 'automation', 'review-comments.json'), '{"threads":[]}');
    await fs.writeFile(path.join(tempRoot, 'novel_editor.db'), 'protected-content-db');
    await fs.writeFile(path.join(tempRoot, 'covers', 'novel-cover.png'), 'protected-cover');

    const result = await applyDurableDraftCutover(tempRoot, database);
    assert.equal(result.applied, true);
    assert.equal(result.version, DURABLE_DRAFT_CUTOVER_VERSION);
    assert.deepEqual(calls, [...names, 'dropDraftWorkspaceState']);
    await assert.rejects(fs.access(path.join(tempRoot, 'agent', 'agent_state.db')));
    await assert.rejects(fs.access(path.join(tempRoot, 'automation', 'draft-sessions.json')));
    await assert.rejects(fs.access(path.join(tempRoot, 'automation', 'review-comments.json')));
    assert.equal(await fs.readFile(path.join(tempRoot, 'novel_editor.db'), 'utf8'), 'protected-content-db');
    assert.equal(await fs.readFile(path.join(tempRoot, 'covers', 'novel-cover.png'), 'utf8'), 'protected-cover');

    const markerPath = path.join(
        tempRoot,
        'automation',
        `durable-draft-cutover-v${DURABLE_DRAFT_CUTOVER_VERSION}.json`,
    );
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    assert.equal(marker.version, DURABLE_DRAFT_CUTOVER_VERSION);
    assert.deepEqual(marker.preservedDomains, ['Novel', 'Volume', 'Chapter']);
    assert.equal(marker.protectedContentSnapshot.chapterCount, '3');
    assert.equal(typeof marker.protectedContentSnapshot.chapterContentHash, 'string');

    await fs.mkdir(path.join(tempRoot, 'agent'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'agent', 'new-runtime.db'), 'new-state');
    const callCount = calls.length;
    const skipped = await applyDurableDraftCutover(tempRoot, database);
    assert.equal(skipped.applied, false);
    assert.equal(calls.length, callCount);
    assert.equal(await fs.readFile(path.join(tempRoot, 'agent', 'new-runtime.db'), 'utf8'), 'new-state');
} finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log('Durable draft cutover safety tests passed.');
