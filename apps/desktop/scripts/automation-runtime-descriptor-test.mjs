import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import Ajv from 'ajv';

globalThis.__mcpAjv = Ajv;
const catalog = JSON.parse(await fs.readFile(new URL('../../../contracts/tools/catalog.json', import.meta.url), 'utf8'));
const validatorSource = (await fs.readFile(new URL('../electron/automation/mcpToolContracts.ts', import.meta.url), 'utf8'))
    .replace(/^import Ajv .*?;\r?\n/mu, 'const Ajv = globalThis.__mcpAjv;\n')
    .replace(/^import catalog .*?;\r?\n/mu, `const catalog = ${JSON.stringify(catalog)};\n`);
const validatorOutput = ts.transpileModule(validatorSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const validator = await import(`data:text/javascript;base64,${Buffer.from(validatorOutput).toString('base64')}`);
globalThis.__mcpValidate = validator.validateExternalMcpCall;

const source = (await fs.readFile(new URL('../electron/automation/AutomationServer.ts', import.meta.url), 'utf8'))
    .replace(/^import .*? from '\.\/AutomationService';\r?\n/mu, '')
    .replace(/^import type .*? from '\.\/types';\r?\n/mu, '')
    .replace(/^import .*? from '\.\.\/debug\/devLogger';\r?\n/mu, '')
    .replace(/^import .*? from '\.\/mcpToolContracts';\r?\n/mu, 'const validateExternalMcpCall = globalThis.__mcpValidate;\n');
const output = ts.transpileModule(`const devLog = () => {}; const devLogError = () => {}; const redactForLog = value => value;\n${source}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { AutomationServer } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-automation-descriptor-'));
const descriptorPath = path.join(directory, 'automation', 'runtime.json');
const service = { shutdown: async () => {}, invoke: async () => [] };
const retiring = new AutomationServer(service, () => directory);
const current = new AutomationServer(service, () => directory);
const inactive = new AutomationServer(service, () => directory);
try {
    await retiring.start();
    await current.start();
    const latest = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
    const invoke = (method, params, origin = 'desktop-ui') => fetch(`http://127.0.0.1:${latest.port}/mcp/invoke`, {
        method: 'POST', headers: { Authorization: `Bearer ${latest.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params, origin }),
    }).then(response => response.json());
    assert.equal((await invoke('agent.generate_chat', {})).code, 'TOOL_NOT_ALLOWED', 'external route rejects hidden actions even with forged origin');
    assert.equal((await invoke('chapter.get', { chapterId: 123 })).code, 'INVALID_INPUT');
    assert.equal((await invoke('chapter.get', { chapterId: 'chapter' })).ok, true);
    current.setExternalMcpEnabled(false);
    assert.equal((await invoke('chapter.get', { chapterId: 'chapter' })).code, 'MCP_DISABLED', 'closing MCP also blocks existing stdio gateways');
    const internal = await fetch(`http://127.0.0.1:${latest.port}/invoke`, {
        method: 'POST', headers: { Authorization: `Bearer ${latest.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'agent.generate_chat', params: {}, origin: 'internal-agent' }),
    }).then(response => response.json());
    assert.equal(internal.ok, true, 'MCP switch does not disable internal Agent traffic');
    current.setExternalMcpEnabled(true);
    assert.equal((await invoke('chapter.get', { chapterId: 'chapter' })).ok, true, 'enabling restores external access');
    const started = new Map();
    const waiting = new Map();
    service.invoke = async (_method, params, context) => new Promise((resolve, reject) => {
        waiting.set(params.chapterId, { signal: context.signal, resolve });
        context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        started.get(params.chapterId)?.();
    });
    const externalStarted = new Promise(resolve => started.set('external-slow', resolve));
    const internalStarted = new Promise(resolve => started.set('internal-slow', resolve));
    const externalPending = invoke('chapter.get', { chapterId: 'external-slow' });
    const internalPending = fetch(`http://127.0.0.1:${latest.port}/invoke`, {
        method: 'POST', headers: { Authorization: `Bearer ${latest.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'chapter.get', params: { chapterId: 'internal-slow' }, origin: 'internal-agent' }),
    }).then(response => response.json());
    await Promise.all([externalStarted, internalStarted]);
    current.setExternalMcpEnabled(false);
    assert.equal(waiting.get('external-slow').signal.aborted, true, 'active external request receives cancellation');
    assert.equal(waiting.get('internal-slow').signal.aborted, false, 'active internal Agent is not cancelled');
    waiting.get('internal-slow').resolve([]);
    assert.equal((await internalPending).ok, true);
    assert.equal((await externalPending).ok, false);
    await retiring.stop();
    assert.deepEqual(JSON.parse(await fs.readFile(descriptorPath, 'utf8')), latest, 'retiring processes must leave their successor descriptor');
    await inactive.stop();
    assert.deepEqual(JSON.parse(await fs.readFile(descriptorPath, 'utf8')), latest, 'a server that never started must not delete an active descriptor');
    await fs.unlink(descriptorPath);
    await current.ensureRuntimeDescriptor();
    assert.deepEqual(JSON.parse(await fs.readFile(descriptorPath, 'utf8')), latest, 'a live server repairs a missing descriptor');
    await fs.writeFile(descriptorPath, '{', 'utf8');
    await current.ensureRuntimeDescriptor();
    assert.deepEqual(JSON.parse(await fs.readFile(descriptorPath, 'utf8')), latest, 'a live server repairs a truncated descriptor');
    assert.deepEqual(await fs.readdir(path.dirname(descriptorPath)), ['runtime.json'], 'atomic publishing must leave no temporary file');
    await current.stop();
    await assert.rejects(fs.access(descriptorPath), { code: 'ENOENT' }, 'owner shutdown removes its descriptor');
    console.log('Automation runtime descriptor passed: successor ownership, inactive shutdown, missing/truncated repair and atomic publishing.');
} finally {
    await retiring.stop(); await current.stop();
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true });
}
