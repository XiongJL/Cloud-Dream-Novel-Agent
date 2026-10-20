import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real report method up to the model boundary; no provider call.
const source = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AiService.ts', source, ts.ScriptTarget.Latest, true);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AiService');
const method = service.members.find(member => member.name?.getText(ast) === 'generateAgentReport').getText(ast);
const compiled = ts.transpileModule(`class Harness { ${method} }; exports.Harness = Harness;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {
    exports, AiActionError: Error,
    trimText: (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '',
});
const boundary = new Error('Model boundary');
let assembled;
const harness = Object.assign(new exports.Harness(), {
    settingsCache: { http: { temperature: 0.3, timeoutMs: 120000 } },
    resolveGenerationBudget: () => ({ initialTokens: 4096, recoveryTokens: 8192 }),
    assembleAgentPrompt: input => { assembled = input; return JSON.stringify(input); },
    generateStructuredWithBudgetRecovery: async () => { throw boundary; },
});
const manifest = [{ artifactId: 'artifact_skill', type: 'agent_skill_pack_draft', status: 'ready',
    reference: { skillDraftId: 'skill_draft' }, skillDelivery: { memberCount: 2, authoredMemberCount: 2, chaptersRead: 0 } }];
for (const locale of ['zh-CN', 'en-US']) {
    await assert.rejects(harness.generateAgentReport({ goal: '提炼文风', locale,
        draftSessionId: '', artifacts: manifest,
        findings: [{ data: { summary: '规划尚未编写 SKILL.md 正文。' } }],
    }), error => error === boundary);
    const delivery = assembled.sections.find(item => item.id === 'delivered-artifacts');
    assert.equal(delivery.priority, 'required');
    assert.deepEqual(delivery.value, manifest);
    assert.match(assembled.systemPrompt, /reference\.skillDraftId/);
    assert.match(assembled.systemPrompt, /authoredMemberCount/);
    assert.match(assembled.systemPrompt, /chaptersRead/);
}
await assert.rejects(harness.generateAgentReport({ goal: '审阅章节' }), error => error === boundary);
assert.equal(assembled.sections.find(item => item.id === 'delivered-artifacts').value.length, 0);
console.log('agent report delivery tests passed');
