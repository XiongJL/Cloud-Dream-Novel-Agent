import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { jsonrepair } from 'jsonrepair';
import ts from 'typescript';

const source = await readFile(new URL('../electron/automation/AgentStructuredOutputContracts.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const contracts = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const parserSource = await readFile(new URL('../shared/agentJson.ts', import.meta.url), 'utf8');
const parserOutput = ts.transpileModule(parserSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseRepairableJsonObject } = await import(
    `data:text/javascript;base64,${Buffer.from(parserOutput).toString('base64')}`
);

const scopeContract = contracts.getAgentStructuredOutputContract('agent.generate_scope_audit');
assert.ok(scopeContract);

const invalidIssues = contracts.validateAgentStructuredOutput({
    summary: '综合结论',
    experts: ['editor', 'worldbuilding'],
    findings: [],
    conflicts: [],
    recommendations: [{ priority: 'high', item: '修订第二章' }],
}, scopeContract);
assert.ok(invalidIssues.some((issue) => issue.path === '$.experts[0]' && issue.message.includes('object')));
assert.ok(invalidIssues.some((issue) => issue.path === '$.recommendations[0]' && issue.message.includes('string')));

const missingIssues = contracts.validateAgentStructuredOutput({ summary: '缺少字段' }, scopeContract);
assert.ok(missingIssues.some((issue) => issue.path === '$.findings'));
assert.ok(missingIssues.some((issue) => issue.path === '$.conflicts'));

const validIssues = contracts.validateAgentStructuredOutput({
    summary: '综合结论',
    experts: [{ expert: 'editor', artifactId: 'artifact-1', artifactType: 'editor_range_review' }],
    findings: [],
    conflicts: [],
    recommendations: ['修订第二章'],
    warnings: [],
}, scopeContract);
assert.deepEqual(validIssues, []);

const chatContract = contracts.getAgentStructuredOutputContract('agent.generate_chat');
assert.ok(chatContract);
assert.deepEqual(contracts.validateAgentStructuredOutput({
    content: '普通对话回答',
    shouldPlan: false,
    requestedOperations: [],
    toolCalls: [],
    inputRequest: null,
}, chatContract), []);
const invalidChatIssues = contracts.validateAgentStructuredOutput({
    content: '错误的澄清请求',
    shouldPlan: false,
    requestedOperations: [],
    toolCalls: [],
    inputRequest: 'not-an-object',
}, chatContract);
assert.ok(invalidChatIssues.some((issue) => (
    issue.path === '$.inputRequest'
    && issue.message.includes('object or null')
)));
assert.ok(contracts.validateAgentStructuredOutput({
    content: '',
    shouldPlan: false,
    requestedOperations: [],
    toolCalls: [],
    inputRequest: null,
}, chatContract).some((issue) => issue.path === '$.content' && issue.message.includes('at least 1')));

const followupContract = contracts.getAgentStructuredOutputContract('agent.generate_user_input_followup');
assert.ok(followupContract);
assert.deepEqual(contracts.validateAgentStructuredOutput({
    needsFollowUp: false,
    inputRequest: null,
}, followupContract), []);

const reportContract = contracts.getAgentStructuredOutputContract('agent.generate_report');
assert.ok(reportContract);
const repairedReport = parseRepairableJsonObject(
    '{"content":"第一行\n第二行","conversationSummary":"摘要",}',
    jsonrepair,
);
assert.equal(repairedReport?.repaired, true);
assert.deepEqual(contracts.validateAgentStructuredOutput(repairedReport.value, reportContract), []);

const repairedButContractInvalid = parseRepairableJsonObject(
    '{"content":"报告","conversationSummary":3,}',
    jsonrepair,
);
assert.equal(repairedButContractInvalid?.repaired, true);
assert.ok(contracts.validateAgentStructuredOutput(
    repairedButContractInvalid.value,
    reportContract,
).some((issue) => issue.path === '$.conversationSummary'));

console.log('agent structured output contract tests passed');
