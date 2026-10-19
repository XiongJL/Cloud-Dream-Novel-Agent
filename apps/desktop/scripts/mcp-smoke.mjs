#!/usr/bin/env node
// Delegate diagnostics to the official Python MCP SDK client.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'novel-editor-mcp.mjs');
const child = spawn(process.execPath, [launcher, '--smoke', ...process.argv.slice(2)], {
  stdio: 'inherit', env: process.env, windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
