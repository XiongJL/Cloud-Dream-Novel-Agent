import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const workspaceUrl = new URL('../src/components/AgentWorkspace/', import.meta.url);
const files = (await readdir(workspaceUrl)).filter((file) => file.endsWith('.tsx'));
const source = (await Promise.all(files.map((file) => readFile(new URL(file, workspaceUrl), 'utf8')))).join('\n');

const deprecatedWarmNeutrals = [
  '#fbf9f6', '#faf8f5', '#f7f5f2', '#f5f3f0', '#f3f0eb', '#f1eee9',
  '#e9e5df', '#ede8e1', '#eeeae5', '#eeeae4', '#f1eeea', '#f0ede8',
  '#f2f0ed', '#fbfaf8', '#f8f6f3', '#faf9f7', '#f8f5f1', '#eee8e2',
  '#ebe7e2', '#fcfbf9', '#e5e0dd', '#ebe6e0', '#eee9e4', '#ded8d1',
  '#d8d0c8', '#cfc7bf', '#cfc8c1', '#d8d2cc', '#ddd7d0', '#ddd7d1',
];

for (const color of deprecatedWarmNeutrals) {
  assert.equal(source.includes(color), false, `Agent light UI still contains deprecated warm neutral ${color}`);
}

for (const token of [
  '--ui-canvas', '--ui-surface-subtle', '--ui-surface-muted', '--ui-border',
  '--ui-border-strong', '--ui-text-primary', '--ui-text-secondary', '--ui-text-muted',
  '--ui-text-disabled',
]) {
  assert.match(source, new RegExp(token), `Agent workspace does not consume ${token}`);
}

const themeSource = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
for (const token of [
  '--ui-canvas', '--ui-surface-subtle', '--ui-surface-muted', '--ui-surface-raised',
  '--ui-border', '--ui-border-strong', '--ui-text-primary', '--ui-text-secondary',
  '--ui-text-muted', '--ui-text-disabled', '--ui-primary', '--ui-primary-soft', '--ui-info',
]) {
  assert.match(themeSource, new RegExp(token), `Theme does not define ${token}`);
}
assert.match(themeSource, /\[data-theme='dark'\]/);
assert.match(themeSource, /--ui-canvas:\s*#ffffff/);
assert.match(themeSource, /--ui-canvas:\s*#0a0a0f/);

const editorSource = await readFile(new URL('../src/pages/editor/EditorWorkspace.tsx', import.meta.url), 'utf8');
assert.match(editorSource, /data-theme=\{preferences\.theme\}/);

console.log('Agent light color contract tests passed.');
