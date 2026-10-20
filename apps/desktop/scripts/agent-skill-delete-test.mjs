import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {PrismaClient} from '@novel-editor/core';

const url = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText).toString('base64')}`;
const hints = url(await readFile(new URL('../shared/skillExecutionHints.ts', import.meta.url), 'utf8'));
const ops = url(await readFile(new URL('../shared/agentOperationIds.ts', import.meta.url), 'utf8'));
const author = url((await readFile(new URL('../electron/agentSkills/AgentSkillAuthoring.ts', import.meta.url), 'utf8')).replace("'../../shared/skillExecutionHints'", JSON.stringify(hints)).replace("'../../shared/agentOperationIds'", JSON.stringify(ops)));
const {AgentSkillStore} = await import(url((await readFile(new URL('../electron/agentSkills/AgentSkillStore.ts', import.meta.url), 'utf8')).replace("'./AgentSkillAuthoring'", JSON.stringify(author)).replace("'../../shared/skillExecutionHints'", JSON.stringify(hints))));
const root = await mkdtemp(join(tmpdir(), 'skill-delete-'));
const db = new PrismaClient({datasources: {db: {url: `file:${join(root, 'test.db')}`}}});
try {
  await db.$executeRawUnsafe('CREATE TABLE Novel (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  await db.$executeRawUnsafe("INSERT INTO Novel VALUES ('a','小说 A'),('b','小说 B')");
  await db.$executeRawUnsafe('CREATE TABLE AgentRun (runId TEXT PRIMARY KEY, status TEXT NOT NULL, planJson TEXT)');
  await db.$executeRawUnsafe('CREATE TABLE DraftGenerationOperation (operationId TEXT PRIMARY KEY, status TEXT NOT NULL, requestJson TEXT NOT NULL)');
  await db.$executeRawUnsafe('CREATE TABLE DraftSession (id TEXT PRIMARY KEY, payloadJson TEXT NOT NULL)');
  await db.$executeRawUnsafe("INSERT INTO DraftSession VALUES ('draft-prose','{\"text\":\"已生成的正文\"}')");
  const store = new AgentSkillStore(db); await store.ensureSchema();
  const member = key => ({draftKey: key, definition: {stableId: 'method-' + key, title: key, description: '独立方法'},
    revision: {version: '1.0.0', manifest: {supportedOperations: ['chapter.continuation'], allowedRoles: ['writer']}, instructions: '按人物目标组织正文。', constraints: [], examples: []}});
  const draft = await store.upsertDraft({action: 'pack', scope: 'user', sourceNovelId: 'a', status: 'ready_for_review', draft: {
    skills: [member('language'), member('suspense')], pack: {definition: {stableId: 'delete-pack', title: '测试包', description: '两个成员'},
      revision: {version: '1.0.0', coreDraftKey: 'language', bindings: [{operationId: 'chapter.continuation', roleId: 'writer', primaryDraftKey: 'language', auxiliaryDraftKey: 'suspense'}]}}}});
  const published = await store.commitDraft({draftId: draft.id, expectedVersion: draft.version, confirmed: true});
  const packId = published.pack.id, skillId = published.skills[0].skillId;
  const beforeRevision = await db.agentSkillPackRevision.findUnique({where: {id: published.packRevision.id}});
  const beforeDraft = await db.agentSkillDraft.findUnique({where: {id: draft.id}});
  const deletion = async (type, id, preview) => {
    const p = preview || await store.previewDeletion({targetType: type, targetId: id});
    return store.deleteTarget({targetType: type, targetId: id, expectedVisibilityVersion: p.visibilityVersion, previewToken: p.previewToken, confirmed: true});
  };

  await db.agentSkill.create({data: {id: 'builtin', stableId: 'builtin', scope: 'builtin', title: '内置', description: '内置方法'}});
  await assert.rejects(() => store.previewDeletion({targetType: 'skill', targetId: 'builtin'}), /内置.*不能删除/);
  await assert.rejects(() => store.deleteTarget({targetType: 'pack', targetId: packId, confirmed: false}), /确认/);
  const managed = await store.previewDeletion({targetType: 'skill', targetId: skillId});
  assert.equal(managed.canDelete, false); assert.equal(managed.managedBy[0].id, packId);
  await assert.rejects(() => deletion('skill', skillId, managed), /文风包引用/);

  await store.setPackDefault({novelId: 'a', packId, expectedVersion: 0});
  await store.setPackDefault({novelId: 'b', packId, expectedVersion: 0});
  const stale = await store.previewDeletion({targetType: 'pack', targetId: packId});
  await store.setPackDefault({novelId: 'b', packId, expectedVersion: 1});
  await assert.rejects(() => deletion('pack', packId, stale), /关联已变化/);
  const skillPlan = JSON.stringify({steps: [{skills: [{skillId, revisionId: published.skills[0].revisionId}]}]});
  await db.$executeRawUnsafe("INSERT INTO AgentRun VALUES ('active','running',?)", skillPlan);
  assert.equal((await store.previewDeletion({targetType: 'skill', targetId: skillId})).activeUseCount, 1);
  await db.$executeRawUnsafe("UPDATE AgentRun SET planJson=? WHERE runId='active'", JSON.stringify({skillPackRequest: {packId}}));
  await assert.rejects(() => deletion('pack', packId), /正在执行/);
  await db.$executeRawUnsafe("UPDATE AgentRun SET status='failed' WHERE runId='active'");
  await db.$executeRawUnsafe("INSERT INTO DraftGenerationOperation VALUES ('operation','queued',?)", JSON.stringify({agentSkill: {sections: [{skill: {skillId}}]}}));
  await assert.rejects(() => deletion('pack', packId), /正在执行/);
  await db.$executeRawUnsafe("UPDATE DraftGenerationOperation SET status='succeeded' WHERE operationId='operation'");

  const snapshot = await store.previewDeletion({targetType: 'pack', targetId: packId});
  assert.equal(snapshot.canDelete, true); assert.equal(snapshot.retainedMemberCount, 2); assert.equal(snapshot.affectedDefaults.length, 2);
  await deletion('pack', packId, snapshot);
  assert.equal((await store.listPacks({novelId: 'a'})).length, 0);
  assert.equal((await store.getPackDefault({novelId: 'a'})).packId, null);
  assert.equal((await store.getPackDefault({novelId: 'b'})).source, 'cleared');
  assert.deepEqual(await db.agentSkillPackRevision.findUnique({where: {id: published.packRevision.id}}), beforeRevision);
  assert.ok(await db.agentSkillRevision.findUnique({where: {id: published.skills[0].revisionId}}));
  assert.equal((await store.listSkills({novelId: 'a'})).length, 2, 'Pack deletion retains both persisted members');
  await assert.rejects(() => store.getPack({packId, novelId: 'a'}), /NOT_VISIBLE/);

  const oldSkill = await store.getSkill({skillId});
  await db.agentSkillBinding.create({data: {id: 'binding', skillId, novelId: 'a', bindingType: 'preset'}});
  const single = await store.previewDeletion({targetType: 'skill', targetId: skillId});
  assert.equal(single.managedBy.length, 0, 'Cleared defaults and archived packs do not block deleting a member');
  assert.equal(single.affectedBindingCount, 1);
  await deletion('skill', skillId, single);
  const deleted = await store.getSkill({skillId, revisionId: oldSkill.revision.id});
  assert.ok(deleted.archivedAt); assert.equal(deleted.enabled, false); assert.deepEqual(deleted.revision, oldSkill.revision);
  assert.equal((await db.agentSkillBinding.findUnique({where: {id: 'binding'}})).enabled, false);
  assert.ok(!(await store.listSkills({novelId: 'a'})).some(skill => skill.id === skillId));
  await assert.rejects(() => store.checkVisibility({novelId: 'a', skills: [{skillId, revisionId: oldSkill.revision.id, contentHash: oldSkill.revision.contentHash}]}), /不可用|可见范围/);
  await assert.rejects(() => deletion('skill', skillId), /已删除/);
  assert.deepEqual(await db.agentSkillDraft.findUnique({where: {id: draft.id}}), beforeDraft, 'Published authoring draft remains available');
  assert.equal((await db.$queryRawUnsafe("SELECT payloadJson FROM DraftSession WHERE id='draft-prose'"))[0].payloadJson, '{"text":"已生成的正文"}');
  assert.equal((await db.$queryRawUnsafe("SELECT status FROM AgentRun WHERE runId='active'"))[0].status, 'failed');
  // Only the default's older revision contains the retained suspense member.
  const extra = await store.upsertDraft({action: 'create', scope: 'user', status: 'ready_for_review', draft: member('extra')});
  const created = await store.commitDraft({draftId: extra.id, expectedVersion: extra.version, confirmed: true});
  await db.agentSkillPack.create({data: {id: 'pinned-pack', stableId: 'pinned-pack', scope: 'user', title: '固定旧版本的包', description: '历史默认引用', currentRevisionId: 'current-pack-revision'}});
  const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => JSON.stringify(k)+':'+canonical(x)).join(',')}}` : JSON.stringify(v);
  for (const [id, version, ref] of [['old-pack-revision','0.9.0',published.skills[1]], ['current-pack-revision','1.0.0',created.revision]]) {
    const bindings = [{operationId: 'chapter.continuation', roleId: 'writer', primary: {skillId: ref.skillId, revisionId: ref.id || ref.revisionId}, auxiliary: null}];
    await db.agentSkillPackRevision.create({data: {id, packId: 'pinned-pack', version, bindingsJson: JSON.stringify(bindings), contentHash: createHash('sha256').update(canonical({stableId: 'pinned-pack', version, bindings})).digest('hex')}});
  }
  const preference = await store.getPackDefault({novelId: 'a'});
  await store.setPackDefault({novelId: 'a', packId: 'pinned-pack', revisionId: 'old-pack-revision', expectedVersion: preference.version});
  const pinnedMember = await store.previewDeletion({targetType: 'skill', targetId: published.skills[1].skillId});
  assert.equal(pinnedMember.managedBy[0].id, 'pinned-pack', 'Old default references prevent orphaning members');
  await assert.rejects(() => deletion('skill', published.skills[1].skillId, pinnedMember), /文风包引用/);
  await deletion('pack', 'pinned-pack');
  assert.equal((await store.previewDeletion({targetType: 'skill', targetId: published.skills[1].skillId})).canDelete, true);
  console.log('Skill deletion: dependency checks, concurrent changes, active tasks, defaults, bindings and retained history passed.');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  await db.$disconnect();
  await rm(root, {recursive: true, force: true});
}
