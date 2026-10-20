import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const source = await fs.readFile(new URL('../electron/automation/McpServerManager.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { McpServerManager } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-mcp-manager-'));
const runtimeRoot = fileURLToPath(new URL('../../../agent_runtime', import.meta.url));
const configPath = path.join(directory, 'mcp/settings.json');
const token = randomBytes(32).toString('hex');
const occupier = net.createServer(socket => socket.destroy());
await new Promise(resolve => occupier.listen(0, '127.0.0.1', resolve));
const port = occupier.address().port;
await fs.mkdir(path.dirname(configPath), { recursive: true });
await fs.writeFile(configPath, JSON.stringify({ enabled: false, port, token }));
const changes = [];
const frozen = process.env.NOVEL_MCP_PACKAGED_EXE;
const options = {
    userDataPath: directory, runtimePath: path.join(directory, 'automation/runtime.json'),
    command: frozen || path.join(runtimeRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    argsPrefix: frozen ? ['--mode', 'mcp-http'] : ['-m', 'novel_mcp'], cwd: runtimeRoot,
    onEnabledChanged: enabled => changes.push(enabled),
};
const manager = new McpServerManager(options);
let restored;
try {
    assert.equal((await manager.configure(false)).state, 'disabled');
    const conflict = await manager.configure(true);
    assert.equal(conflict.state, 'error', 'a busy port must fail visibly, not silently change the URL');
    assert.equal(conflict.token, undefined);
    await new Promise(resolve => occupier.close(resolve));
    const ready = await manager.configure(true);
    assert.equal(ready.state, 'running', ready.error);
    assert.equal(ready.url, `http://127.0.0.1:${port}/mcp`);
    assert.equal(ready.token, token);
    assert.equal((await fetch(ready.url)).status, 401);
    const healthUrl = ready.url.replace('/mcp', '/health');
    assert.equal((await fetch(healthUrl, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await manager.configure(false)).state, 'disabled');
    await assert.rejects(fetch(healthUrl), 'disabled must close the listener');
    assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).enabled, false);
    // A new desktop process must retain the choice and avoid starting a child.
    restored = new McpServerManager({ ...options, command: 'missing-command-should-never-be-started' });
    assert.equal((await restored.configure(false)).state, 'disabled');
    assert.equal(restored.status().port, port);
    assert.equal((await manager.configure(true)).state, 'running');
    assert.equal(manager.status().token, token, 'token and URL remain stable across toggles');
    const reserve = net.createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const alternatePort = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const moved = await manager.configure(true, alternatePort);
    assert.equal(moved.state, 'running', moved.error);
    assert.equal(moved.url, `http://127.0.0.1:${alternatePort}/mcp`);
    await assert.rejects(fetch(healthUrl), 'changing ports releases the old listener');
    assert.equal((await manager.configure(false, port)).state, 'disabled');
    // Disable during an in-flight start, then reopen. Superseded starts must not win.
    await manager.configure(false);
    const starting = manager.configure(true);
    const closing = manager.configure(false);
    await Promise.all([starting, closing]);
    assert.equal(manager.status().state, 'disabled');
    await assert.rejects(fetch(healthUrl));
    const startAgain = manager.configure(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    const stopDuringStart = manager.configure(false);
    await Promise.all([startAgain, stopDuringStart]);
    assert.equal(manager.status().state, 'disabled');
    assert.equal(changes.at(-1), false);
    await assert.rejects(manager.configure(true, 80));
    assert.equal(manager.status().enabled, false);
    console.log('MCP manager passed: real HTTP lifecycle, auth, occupied port, persistence, stable credentials and start/stop races.');
} finally {
    await manager.stop(); await restored?.stop();
    if (occupier.listening) await new Promise(resolve => occupier.close(resolve));
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true });
}
