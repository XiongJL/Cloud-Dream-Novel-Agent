#!/usr/bin/env node
// Compatibility launcher for old node + .mjs configurations. Protocol lives in Python.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packaged = path.resolve(scriptDir, '../agent-runtime', process.platform === 'win32' ? 'novel-agent-runtime.exe' : 'novel-agent-runtime');
const runtimeRoot = path.resolve(scriptDir, '../../../agent_runtime');
const python = process.env.NOVEL_EDITOR_PYTHON_EXE || path.join(runtimeRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const bundled = existsSync(packaged);
if (!bundled && !existsSync(python)) {
  console.error('[novel-editor-mcp] Python runtime missing; sync agent_runtime/.venv or set NOVEL_EDITOR_PYTHON_EXE.');
  process.exit(1);
}
const child = spawn(bundled ? packaged : python, [
  ...(bundled ? ['--mode', 'mcp-stdio'] : ['-m', 'novel_mcp']), ...process.argv.slice(2),
], { cwd: bundled ? path.dirname(packaged) : runtimeRoot, env: process.env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(`[novel-editor-mcp] ${error.message}`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
