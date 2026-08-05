import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 };
const contextSource = await readFile(new URL('../shared/agentConversationContext.ts', import.meta.url), 'utf8');
const contextOutput = ts.transpileModule(contextSource, {
    compilerOptions,
}).outputText;
const contextUrl = `data:text/javascript;base64,${Buffer.from(contextOutput).toString('base64')}`;
const source = await readFile(new URL('../shared/agentPlanGoal.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace("'./agentConversationContext'", JSON.stringify(contextUrl));
const { buildAgentPlanGoal, splitAgentPlanGoal } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);
const { inferAgentConversationMessageKind, selectAgentConversationHistory } = await import(contextUrl);

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
assert.deepEqual(splitAgentPlanGoal(goal), {
    currentGoal: '按刚才方案继续',
    conversationContext: goal.split('会话背景（仅用于理解当前任务）：\n')[1],
});
assert.deepEqual(splitAgentPlanGoal('检查一致性'), {
    currentGoal: '检查一致性',
    conversationContext: '',
});

const roleNotice = '已切换到团队模式。当前工作模式决定是否形成计划草稿和调用工具。';
assert.equal(inferAgentConversationMessageKind({ role: 'assistant', content: roleNotice }), 'role_status');
assert.equal(inferAgentConversationMessageKind({ role: 'user', content: roleNotice }), 'chat');
const filteredGoal = buildAgentPlanGoal('感受这两章', [
    { id: 'notice', role: 'assistant', content: roleNotice },
    { id: 'real', role: 'assistant', content: '前一轮确认了按阅读顺序反馈。' },
]);
assert.equal(filteredGoal.includes('团队模式'), false);
assert.match(filteredGoal, /Agent：前一轮确认了按阅读顺序反馈。/);

const filterBeforeLimit = [
    { id: 'older-real', role: 'user', content: '需要保留的较早消息' },
    ...Array.from({ length: 12 }, (_, index) => ({
        id: `notice-${index}`,
        role: 'assistant',
        kind: 'workflow_notice',
        content: `界面通知 ${index}`,
    })),
    { id: 'latest-real', role: 'assistant', content: '需要保留的最新回复' },
];
assert.deepEqual(
    selectAgentConversationHistory(filterBeforeLimit, 12).map((item) => item.messageId),
    ['older-real', 'latest-real'],
);

console.log('Agent plan goal tests passed.');
