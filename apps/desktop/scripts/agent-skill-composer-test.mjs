import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../shared/agentSkillComposer.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

assert.deepEqual(module.findAgentSkillSlashQuery('/'), { start: 0, end: 1, query: '' });
assert.deepEqual(module.findAgentSkillSlashQuery('请帮我 /悬念'), { start: 4, end: 7, query: '悬念' });
assert.equal(module.findAgentSkillSlashQuery('https://example.com/a'), null);
assert.equal(module.findAgentSkillSlashQuery('路径/a/b'), null);
const firstSlashQuery = module.findAgentSkillSlashQuery('/');
assert.equal(module.shouldOpenAgentSkillSlashMenu(firstSlashQuery, null), true);
assert.equal(module.shouldOpenAgentSkillSlashMenu(firstSlashQuery, firstSlashQuery), false);
assert.equal(module.shouldOpenAgentSkillSlashMenu(null, firstSlashQuery), false);
const secondSlashQuery = module.findAgentSkillSlashQuery('/');
assert.equal(module.shouldOpenAgentSkillSlashMenu(secondSlashQuery, firstSlashQuery), true);
assert.equal(module.agentSkillShortcutSeed('builtin.novel-bootstrap'), '新建小说');
const packEntry={id:'pack-a',stableId:'pack.a',title:'文风包 A',description:'语言与悬念',scope:'novel',version:'1.0.0',revisionId:'pack-rev-a',enabled:true,available:true,entryType:'pack',members:[]};
assert.deepEqual(module.agentSkillEntryHint({kind:'skill.pack.use',pack:packEntry,auxiliaryMode:'member',auxiliaryMemberKey:'ensemble'}),{
  actionId:'skill.pack.use',kind:'skill.pack.use',packId:'pack-a',requestedPackRevisionId:'pack-rev-a',auxiliaryMode:'member',auxiliaryMemberKey:'ensemble',
});
assert.equal(module.buildAgentSkillMenuItems([], '文风', [packEntry])[2].kind,'pack');
assert.equal(module.buildAgentSkillMenuItems([], '', [{...packEntry,available:false}]).length,2);
assert.match(module.agentSkillShortcutSeed('builtin.style-skill-extractor'), /文风 Skill Pack/);
assert.equal(
  module.removeAgentSkillSlashQuery('请帮我 /悬念', { start: 4, end: 7, query: '悬念' }),
  '请帮我 ',
);

const skills = [
  { id: 'user.style', stableId: 'style.mine', title: '我的文风', description: '个人文风', scope: 'user', version: '1.0.0', revisionId: 'rev-user', enabled: true },
  { id: 'builtin.review', stableId: 'continuity-review', title: '连续性审校', description: '检查一致性', scope: 'builtin', version: '1.0.0', revisionId: 'rev-builtin', enabled: true },
  { id: 'novel.suspense', stableId: 'suspense-release', title: '悬念释放', description: '控制信息释放', scope: 'novel', version: '2.0.0', revisionId: 'rev-novel', enabled: true },
  { id: 'disabled', stableId: 'disabled', title: '已停用', description: '不可用', scope: 'builtin', version: '1.0.0', revisionId: 'rev-disabled', enabled: false },
];

assert.deepEqual(
  module.filterAgentSkillEntries(skills, '').map((skill) => skill.id),
  ['builtin.review', 'novel.suspense', 'user.style'],
);
assert.deepEqual(module.filterAgentSkillEntries(skills, '悬念').map((skill) => skill.id), ['novel.suspense']);
assert.equal(module.buildAgentSkillMenuItems(skills, '')[0].kind, 'author');
assert.equal(module.buildAgentSkillMenuItems(skills, '')[1].kind, 'none');
assert.deepEqual(module.agentSkillEntryHint({ kind: 'skill.author' }), {
  actionId: 'skill.author',
  kind: 'skill.author',
});
assert.deepEqual(module.agentSkillEntryHint({kind: 'skill.author', publicationScope: 'novel'}), {
  actionId: 'skill.author', kind: 'skill.author', publicationScope: 'novel',
});
assert.equal(module.agentSkillEntryHint({kind: 'skill.use', skill: skills[0], publicationScope: 'user'}).publicationScope, 'user');
assert.deepEqual(module.agentSkillEntryHint({ kind: 'skill.none' }), {
  actionId: 'skill.none',
  kind: 'skill.none',
});
assert.deepEqual(module.agentSkillEntryHint({ kind: 'skill.use', skill: skills[2] }), {
  actionId: 'skill.use',
  kind: 'skill.use',
  skillId: 'novel.suspense',
  requestedRevisionId: 'rev-novel',
});

let selected = module.selectAgentSkillMode(undefined, {kind:'skill', skill:skills[0]});
selected = module.selectAgentSkillMode(selected, {kind:'skill', skill:skills[1]});
selected = module.selectAgentSkillMode(selected, {kind:'skill', skill:skills[2]});
assert.deepEqual(module.selectedAgentSkills(selected).map(skill => skill.id), skills.slice(0,3).map(skill => skill.id));
assert.deepEqual(module.agentSkillEntryHint(selected).skills, skills.slice(0,3).map(skill => ({skillId:skill.id, requestedRevisionId:skill.revisionId})));
assert.equal(module.agentSkillEntryHint(selected).skillId, undefined, 'Multi-selection cannot masquerade as a single selection');
selected = module.removeSelectedAgentSkill(selected, skills[0].id);
assert.equal(selected.skill.id, skills[1].id);
assert.deepEqual(module.selectedAgentSkills(selected).map(skill => skill.id), [skills[1].id, skills[2].id]);
selected = module.selectAgentSkillMode(selected, {kind:'skill',skill:skills[2]});
assert.deepEqual(module.selectedAgentSkills(selected).map(skill => skill.id), [skills[1].id], 'Selecting an already selected item toggles it off');
assert.equal(module.selectAgentSkillMode(selected, {kind:'skill',skill:skills[1]}), undefined);
assert.equal(module.selectAgentSkillMode(selected, {kind:'none',id:'skill.none'}).kind, 'skill.none');
assert.equal(module.selectAgentSkillMode(selected, {kind:'pack',pack:packEntry}).kind, 'skill.pack.use');
console.log('Agent Skill composer tests passed: multi-selection, independent removal, toggle, locked revisions and legacy modes.');
