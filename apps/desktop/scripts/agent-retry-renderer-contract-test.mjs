import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
const preload = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');

assert.match(preload, /retryRun:\s*\(payload: any\).*agent\.retry_run/s);
assert.match(workspace, /window\.agent\.retryRun\(\{/);
assert.match(workspace, /response\.intentDecision\?\.route === 'retry_failed_run'/);
assert.match(workspace, /!recovery \? \[\{/);
assert.match(workspace, /重试失败步骤/);
assert.match(workspace, /调整并重新规划/);
assert.match(workspace, /run\?\.status === 'cancelled'/);
assert.doesNotMatch(workspace, /run\?\.status === 'failed' \|\| run\?\.status === 'cancelled'/);

console.log('Agent retry Renderer contract tests passed.');
