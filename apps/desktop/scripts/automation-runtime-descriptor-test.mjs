import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const source = (await fs.readFile(new URL('../electron/automation/AutomationServer.ts', import.meta.url), 'utf8'))
    .replace(/^import .*? from '\.\/AutomationService';\r?\n/mu, '')
    .replace(/^import type .*? from '\.\/types';\r?\n/mu, '')
    .replace(/^import .*? from '\.\.\/debug\/devLogger';\r?\n/mu, '');
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
