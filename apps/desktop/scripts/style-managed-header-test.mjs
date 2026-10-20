import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const url = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const hints = url(compile(await readFile(new URL('../shared/skillExecutionHints.ts', import.meta.url), 'utf8')));
const operations = url(compile(await readFile(new URL('../shared/agentOperationIds.ts', import.meta.url), 'utf8')));
const source = (await readFile(new URL('../electron/agentSkills/AgentSkillAuthoring.ts', import.meta.url), 'utf8'))
    .replace("'../../shared/skillExecutionHints'", JSON.stringify(hints)).replace("'../../shared/agentOperationIds'", JSON.stringify(operations));
const { compileAgentSkillMarkdown, validateAgentSkillWorkspace, hashAgentSkillDocument, invalidateAgentSkillAuthoringState } = await import(url(compile(source)));
const broken = compileAgentSkillMarkdown({ logicalPath: 'language-style/SKILL.md',
    contentText: '---\nschemaVersion: novel-editor.agent-skill.v1\nstableId: sample.style\n## 正文\n应用方法', expectedScope: 'novel', origin: 'derived' });
assert.deepEqual(broken.diagnostics.map(d => d.code), ['SKILL_FRONTMATTER_UNCLOSED'], 'one framing cause must not become ten missing fields');
if (process.argv[2]) {
    const documents = JSON.parse(await readFile(process.argv[2], 'utf8'));
    for (const doc of documents) {
        const result = compileAgentSkillMarkdown({ ...doc, expectedScope: 'novel', origin: 'derived' });
        assert.deepEqual(result.diagnostics, [], doc.logicalPath);
        assert(result.projection.revision.instructions);
    }
    if (process.argv[3]) {
        const snapshot = JSON.parse(await readFile(process.argv[3], 'utf8'));
        const authoring = invalidateAgentSkillAuthoringState({ ...snapshot.draftJson.authoring,
            documents: documents.map(doc => ({ ...doc, mediaType: 'text/markdown',
                contentHash: hashAgentSkillDocument(doc.contentText), deleted: false })) }, snapshot.draftJson.pack);
        const result = validateAgentSkillWorkspace({ draft: { ...snapshot.draftJson, authoring }, action: 'pack', scope: 'novel' });
        assert.equal(result.report.ok, true, JSON.stringify(result.report.diagnostics));
        console.log('The saved Pack workspace and all bindings pass actual Native validation.');
    }
    console.log(`Managed headers: ${documents.length} offline documents compile in Native without changing bodies.`);
} else console.log('Managed header framing diagnostics passed.');
