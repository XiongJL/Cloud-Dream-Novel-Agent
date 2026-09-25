import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../electron/automation/AutomationService.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AutomationService.ts', source, ts.ScriptTarget.Latest, true);
const owner = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AutomationService');
const method = owner.members.find(node => node.name?.getText(ast) === 'reviseCreativeAssetsDraftSession').getText(ast);
const js = ts.transpileModule(`
const assertRequiredString = value => value;
const assertRequiredNumber = value => value;
const createAutomationError = (code, text) => new Error(text);
const sanitizeGeneratedDraft = value => value;
const normalizeCreativeDraft = value => value;
const createSelectionFromDraft = () => ({});
const summarizeCreativeDraft = () => '';
const randomUUID = () => 'revision';
export class Harness { ${method} }
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { Harness } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

for (const originalImage of ['', 'aW1hZ2U=', '[保留原图片数据]']) {
    const service = new Harness();
    const sourceDraft = { maps: [{ name: '灯塔', imageBase64: originalImage }] };
    service.draftStore = {
        getById: async () => ({ draftSessionId: 'source', version: 1, type: 'creative-assets', status: 'draft', payload: sourceDraft }),
        create: async value => value,
    };
    service.invokeAgentStructured = async (method, context, generate) => generate();
    service.aiService = { generateCreativeAssets: async request => {
        assert.equal(request.overrideUserPrompt.includes('"imageBase64": "[保留原图片数据]"'), Boolean(originalImage));
        return { draft: { maps: [{ name: '灯塔', imageBase64: '[保留原图片数据]' }] } };
    } };
    const result = await service.reviseCreativeAssetsDraftSession({
        sourceDraftSessionId: 'source', sourceDraftVersion: 1,
        comments: [{ reviewVersionId: 'source', anchor: { targetId: 'map-0' }, body: 'Keep map' }],
    }, {});
    assert.equal(result.payload.maps[0].imageBase64, originalImage === 'aW1hZ2U=' ? originalImage : '');
}
console.log('Creative asset revision preserves real images and removes redaction markers.');
