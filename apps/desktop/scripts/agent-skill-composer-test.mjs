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

console.log('Agent Skill composer tests passed.');
