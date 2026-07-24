import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentPlanGoal.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildAgentPlanGoal } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

assert.equal(buildAgentPlanGoal('检查一致性', []), '检查一致性');
const history = Array.from({ length: 14 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `消息 ${index}`,
}));
const goal = buildAgentPlanGoal('按刚才方案继续', history);
assert.match(goal, /^按刚才方案继续/);
assert.equal(goal.includes('消息 0'), false);
assert.equal(goal.includes('消息 2'), true);
assert.match(goal, /用户：消息 12/);
assert.match(goal, /Agent：消息 13/);

console.log('Agent plan goal tests passed.');
