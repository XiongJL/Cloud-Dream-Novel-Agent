import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
async function loadTypeScript(path, overrides = {}, globals = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: (name) => overrides[name] ?? require(name), ...globals });
  return module.exports;
}

const projection = await loadTypeScript('../shared/agentSkillDraftReview.ts');
const { SkillDraftReviewCard } = await loadTypeScript('../src/components/AgentWorkspace/SkillDraftReviewCard.tsx', {
  '../../../shared/agentSkillDraftReview': projection,
  '../AssistantMarkdown': { __esModule: true, default: ({ content }) => React.createElement('div', {}, content) },
});
const id = 'aae770f4-ec2f-41da-a80b-56bece009649';
const notice = { role: 'assistant', kind: 'workflow_notice', content: `Skill 文档已保留为草稿；草稿 ID：\`${id}\`。` };
assert.equal(projection.skillDraftIdFromNotice(notice), id, 'Recover the existing needsAttention conversation');
assert.equal(projection.skillDraftIdFromNotice({ ...notice, content: '已生成可审核草稿。', skillDraftId: id }), id, 'New cards use a structured reference independently of notice wording');
assert.equal(projection.skillDraftIdFromNotice({ ...notice, role: 'user' }), null);
assert.equal(projection.skillDraftIdFromNotice({ ...notice, kind: 'chat' }), null);
assert.equal(projection.skillDraftIdFromNotice({ ...notice, content: `Skill ${id}` }), null);
assert.equal(projection.skillDraftIdFromNotice({ ...notice, content: 'Skill 草稿 ID：`unknown`' }), null);

const invalid = {
  id, version: 4, status: 'editing', action: 'create', scope: 'user',
  draft: { authoring: {
    phase: 'needs_attention', authoringInputHash: 'current',
    documents: [
      { logicalPath: 'SKILL.md', contentText: '---\nname: 文风1.0\ncategory: style\nsupportedOperations:\n  - chapter.continuation\n  - chapter.rewrite\nconstraints:\n  - "避免段尾升华"\noutputType: markdown\n---\n细节有取舍，只保留推动事件的细节。', deleted: false },
      { logicalPath: 'references/examples.md', contentText: '示例：过渡事件一句带过。', deleted: false },
      { logicalPath: 'references/removed.md', contentText: '已删除内容', deleted: true },
    ],
    validationReport: { ok: false, errorCount: 1, diagnostics: [{ code: 'SKILL_OUTPUT_TYPE_INVALID', path: 'SKILL.md', severity: 'error', line: 3, message: '不支持 outputType：markdown。', suggestion: '请选择 none、report、chapter_draft 或 creative_assets_draft。' }] },
  } },
};
assert.equal(projection.projectSkillDraftReview(invalid).canPublish, false);
assert.equal(projection.projectSkillDraftReview(invalid).title, '文风1.0', 'Invalid drafts display their authored name before compilation');
const renamed = structuredClone(invalid);
renamed.draft.authoring.documents[0].contentText = renamed.draft.authoring.documents[0].contentText.replace('name: 文风1.0', 'name: 文风1.0\ntitle: 改名后的规则');
assert.equal(projection.projectSkillDraftReview(renamed).title, '改名后的规则', 'Display uses the same title precedence as compilation');
assert.equal(projection.projectSkillDraftReview(invalid).instructions, '细节有取舍，只保留推动事件的细节。');
assert.deepEqual(Array.from(projection.projectSkillDraftReview(invalid).constraints), ['避免段尾升华']);
assert.deepEqual(Array.from(projection.projectSkillDraftReview(invalid).operationLabels), ['续写章节', '改写章节']);
const render = (draft) => renderToStaticMarkup(React.createElement(SkillDraftReviewCard, { draftId: id, embedded: draft, isDark: false, onPublished: async () => {} }));
const html = render(invalid);
assert.match(html, /细节有取舍，只保留推动事件的细节/);
assert.match(html, /references\/examples.md/);
assert.doesNotMatch(html, /已删除内容/);
assert.match(html, /SKILL_OUTPUT_TYPE_INVALID/);
assert.match(html, /不支持 outputType：markdown/);
assert.match(html, /第 3 行/);
assert.match(html, /请选择 none/);
assert.match(html, /修改规则/);
assert.match(html, /让 AI 修改/);
assert.match(html, /重试整理/);
assert.match(html, /我的技能库/);
assert.match(html, /适用：续写章节、改写章节/);
assert.match(html, /disabled=""[^>]*>.*?保存 Skill/);
const defaultHtml = html.slice(0, html.indexOf('aria-label="高级格式详情"'));
assert.doesNotMatch(defaultHtml, /outputType|SKILL_OUTPUT_TYPE_INVALID|chapter\.continuation|SKILL\.md/);
assert.match(defaultHtml, /细节有取舍/);
assert.match(defaultHtml, /避免段尾升华/);
assert.match(html, /格式详情（高级，只读）/);
assert.doesNotMatch(html, /<details[^>]*open=""/);
assert.doesNotMatch(html, /<textarea/);

const valid = structuredClone(invalid);
valid.status = 'ready_for_review';
Object.assign(valid.draft.authoring, { phase: 'compiled', validatedInputHash: 'current', compiledInputHash: 'current', validationReport: { ok: true, diagnostics: [] } });
valid.draft.definition = { title: '克制文风', description: '正文文风方法' };
assert.equal(projection.projectSkillDraftReview(valid).canPublish, true);
assert.match(render(valid), /文风1.0/);
assert.match(render(valid), /aria-label="草稿保存范围"/, 'Current features must remain visible without a health capability probe');
assert.equal(projection.projectSkillDraftReview(valid).title, '文风1.0', 'The actual document name takes priority over a stale compiled definition');
const stale = structuredClone(valid);
stale.draft.authoring.compiledInputHash = 'old';
assert.equal(projection.projectSkillDraftReview(stale).canPublish, false);
const unchecked = structuredClone(valid);
unchecked.draft.authoring.validationReport = { ok: false, diagnostics: [] };
assert.equal(projection.projectSkillDraftReview(unchecked).canPublish, false);
const pack = { ...valid, action: 'pack', draft: { ...valid.draft, pack: { definition: { title: '本书文风包', description: '多个方法组合' } } } };
const publishedPack = render({...pack, status: 'committed', committedPackId: 'pack'});
assert.match(publishedPack, /本次使用/);
assert.match(publishedPack, /设为本书默认/);
assert.match(publishedPack, /设置可见范围/);
assert.equal(projection.projectSkillDraftReview(pack).isPack, true);
assert.equal(projection.projectSkillDraftReview(pack).description, '多个方法组合');
assert.match(render(pack), /本书文风包/);
assert.match(render(pack), /Skill 组合/);
for (const status of ['committed', 'discarded']) {
  assert.equal(projection.projectSkillDraftReview({ ...valid, status }).canPublish, false);
  assert.doesNotMatch(render({ ...valid, status }), /保存 Skill/);
}
const legacy = { id, version: 1, status: 'ready_for_review', action: 'create', draft: { definition: { title: '旧 Skill' }, revision: { instructions: '减少心理解释', constraints: ['避免段尾升华'], examples: [{ input: '原句', output: '改句' }] } } };
assert.equal(projection.projectSkillDraftReview(legacy).canPublish, true);
assert.match(render(legacy), /减少心理解释/);
assert.match(render(legacy), /避免段尾升华/);
assert.match(render(legacy), /示例/);
assert.match(render(legacy), /原文：原句/);
assert.match(render(legacy), /示范：改句/);

// Preparation is shared between chat and artifact cards. A completed but still invalid
// draft must not cause an automatic loop as its new version is read again.
const coordinator = projection.createSkillDraftPreparationCoordinator();
let prepareCalls = 0;
const preparedInvalid = { ...invalid, version: 5 };
const invokePrepare = async () => { prepareCalls += 1; return { draft: preparedInvalid, repairs: [] }; };
const [first, second] = await Promise.all([coordinator.prepare(invalid, invokePrepare), coordinator.prepare(invalid, invokePrepare)]);
assert.equal(prepareCalls, 1);
assert.equal(first.draft.version, 5);
assert.equal(second.draft.version, 5);
assert.equal(await coordinator.prepare(preparedInvalid, invokePrepare), null);
assert.equal(prepareCalls, 1);
assert.equal((await coordinator.prepare(invalid, invokePrepare)).draft.version, 5, 'Late readers get the prepared version, not their stale saved snapshot');
await coordinator.prepare(preparedInvalid, invokePrepare, true);
assert.equal(prepareCalls, 2, 'Explicit retry is allowed');
const failedCoordinator = projection.createSkillDraftPreparationCoordinator();
await assert.rejects(failedCoordinator.prepare(invalid, async () => { throw new Error('offline'); }), /offline/);
assert.equal(await failedCoordinator.prepare(invalid, invokePrepare), null);
await failedCoordinator.prepare(invalid, invokePrepare, true);
assert.equal(await coordinator.prepare({ ...valid, status: 'committed' }, invokePrepare), null);

// Drive the actual card button handlers with state hooks, including CAS and failed saves.
const states = [valid, false, '', '', [], 0, null, null, null];
let hookIndex = 0;
const fakeReact = { ...React, useEffect: () => {}, useState: (initial) => {
  const index = hookIndex++;
  if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
  return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
} };
const calls = [];
let failSave = false;
const fakeWindow = {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  dispatchEvent: () => {}, confirm: () => { throw new Error('Skill actions must not open a blocking native dialog'); },
  automation: { invoke: async (method, params) => {
    calls.push({ method, params });
    if (failSave) throw new Error('AGENT_SKILL_DRAFT_VERSION_CONFLICT');
    return { draft: { ...valid, version: params.expectedVersion + 1 }, repairs: [] };
  } },
  agent: { reviseSkill: async (params) => { calls.push({ method: 'reviseSkill', params }); return { draft: { ...valid, version: params.expectedVersion + 1 }, repairs: [] }; },
    discardSkillDraft: async (params) => { calls.push({ method: 'discardSkillDraft', params }); return { ...valid, status: 'discarded' }; },
    commitSkillDraft: async (params) => { calls.push({ method: 'commitSkillDraft', params }); return { draft: { ...valid, status: 'committed' } }; } },
};
const { SkillDraftReviewCard: InteractiveCard } = await loadTypeScript('../src/components/AgentWorkspace/SkillDraftReviewCard.tsx', {
  react: fakeReact, '../../../shared/agentSkillDraftReview': projection, sonner: { toast: { success: () => {}, error: () => {} } },
  '../AssistantMarkdown': { __esModule: true, default: ({ content }) => React.createElement('div', {}, content) },
}, { window: fakeWindow, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
const tree = () => { hookIndex = 0; return InteractiveCard({ draftId: id, isDark: false, onPublished: async () => {} }); };
function findElement(element, predicate) {
  if (!element || typeof element !== 'object') return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props?.children)) {
    const found = findElement(child, predicate); if (found) return found;
  }
  return null;
}
const button = (label) => findElement(tree(), (element) => element.type === 'button' && React.Children.toArray(element.props.children).includes(label));
button('修改规则').props.onClick();
const editor = tree();
assert.equal(findElement(editor, (element) => element.props?.['aria-label'] === '技能内容').props.value, '细节有取舍，只保留推动事件的细节。');
assert.equal(findElement(editor, (element) => element.props?.['aria-label'] === '附加限制').props.value, '避免段尾升华');
findElement(editor, (element) => element.props?.['aria-label'] === '附加限制').props.onChange({ target: { value: '减少环境描写\n保留必要空间关系' } });
const editVersion = states[7].version;
states[0] = { ...valid, version: editVersion + 8 }; // another card advances the saved version
failSave = true;
await button('保留修改并整理').props.onClick();
assert.equal(calls.at(-1).method, 'agent_skill.workspace.prepare');
assert.equal(calls.at(-1).params.expectedVersion, editVersion, 'The opened edit keeps its CAS version');
assert.deepEqual(Array.from(calls.at(-1).params.rules.constraints), ['减少环境描写', '保留必要空间关系']);
assert.equal(states[7].constraintsText, '减少环境描写\n保留必要空间关系', 'Failed saves preserve the author input');
assert.doesNotMatch(calls.at(-1).params.rules.instructions, /outputType|name:/);
assert.equal(calls.some((call) => call.method === 'commitSkillDraft'), false);
states[1] = false; states[6] = null; failSave = false;
button('保留我的输入，继续编辑').props.onClick();
await button('保留修改并整理').props.onClick();
assert.equal(states[7], null);
states[1] = false; states[6] = null;
button('让 AI 修改').props.onClick();
findElement(tree(), (element) => element.props?.['aria-label'] === 'AI 修改要求').props.onChange({ target: { value: '再减少环境描写' } });
await button('按要求修改').props.onClick();
assert.equal(calls.at(-1).method, 'reviseSkill');
assert.equal(calls.at(-1).params.goal, '再减少环境描写');
assert.equal(calls.some((call) => call.method === 'commitSkillDraft'), false, 'AI revision does not publish');
states[1] = false; states[6] = null;
const callsBeforeConfirmation = calls.length;
button('保存 Skill').props.onClick();
assert.equal(calls.length, callsBeforeConfirmation, 'Opening inline confirmation does not publish or block the window');
button('取消').props.onClick();
assert.equal(calls.length, callsBeforeConfirmation, 'Cancelling confirmation keeps the Skill draft');
button('保存 Skill').props.onClick();
states[0] = { ...states[0], version: states[0].version + 1 };
await button('确认保存').props.onClick();
assert.equal(calls.length, callsBeforeConfirmation, 'A changed draft requires a new explicit confirmation');
button('保存 Skill').props.onClick();
await button('确认保存').props.onClick();
assert.equal(calls.at(-1).method, 'commitSkillDraft', 'Only explicit saving publishes');
states[0] = valid; states[1] = false; states[6] = null;
button('放弃草稿').props.onClick();
await button('确认放弃').props.onClick();
assert.equal(calls.at(-1).method, 'discardSkillDraft', 'Discard also uses inline confirmation without a native dialog');
assert.match(render({ ...valid, status: 'committed' }), /在输入框输入 \/，选择/);
console.log('Agent Skill draft review tests passed (author-friendly preview, controlled rules/AI edits, CAS preservation, preparation deduplication/retry, and explicit publishing).');
