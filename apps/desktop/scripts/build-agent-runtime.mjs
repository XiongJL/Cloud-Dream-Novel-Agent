import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const runtimeRoot = path.join(repoRoot, 'agent_runtime');
const venvPython = path.join(
  runtimeRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const python = process.env.NOVEL_AGENT_PYTHON
  || (existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3');
const buildScript = path.join(runtimeRoot, 'scripts', 'build_runtime.py');

const result = spawnSync(python, [buildScript, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[agent-runtime] failed to start ${python}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
