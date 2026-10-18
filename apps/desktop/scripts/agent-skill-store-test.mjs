import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { PrismaClient } from '@novel-editor/core';

const hintsSource = await readFile(new URL('../shared/skillExecutionHints.ts', import.meta.url), 'utf8');
const hintsOutput = ts.transpileModule(hintsSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const hintsUrl = `data:text/javascript;base64,${Buffer.from(hintsOutput).toString('base64')}`;
const operationsSource = await readFile(new URL('../shared/agentOperationIds.ts', import.meta.url), 'utf8');
const operationsUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(operationsSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`;
const authoringSource = (await readFile(new URL('../electron/agentSkills/AgentSkillAuthoring.ts', import.meta.url), 'utf8'))
  .replace("'../../shared/skillExecutionHints'", JSON.stringify(hintsUrl))
  .replace("'../../shared/agentOperationIds'", JSON.stringify(operationsUrl));
const authoringOutput = ts.transpileModule(authoringSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const authoringUrl = `data:text/javascript;base64,${Buffer.from(authoringOutput).toString('base64')}`;
const source = (await readFile(new URL('../electron/agentSkills/AgentSkillStore.ts', import.meta.url), 'utf8'))
  .replace("'./AgentSkillAuthoring'", JSON.stringify(authoringUrl))
  .replace("'../../shared/skillExecutionHints'", JSON.stringify(hintsUrl));
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

function skillMarkdown({ stableId, title, description, instruction = '先识别目标，再按证据调整叙事方法。' }) {
  return `---
schemaVersion: novel-editor.agent-skill.v1
stableId: ${stableId}
version: 1.0.0
name: ${title}
description: ${description}
scope: user
skillType: prompt_method
category: style
guidanceMode: adaptive
semanticSelection: suggest
triggerHints:
  - 需要保持目标叙事风格
antiTriggerHints:
  - 只检查错别字
supportedOperations:
  - chapter.continuation
allowedRoles:
  - writer
outputType: none
constraints:
  - 不复制来源专名
---

## 方法

${instruction}
`;
}

const tempRoot = await mkdtemp(join(tmpdir(), 'noval-editor-agent-skill-'));
const databasePath = join(tempRoot, 'skills.sqlite');
const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });

try {
  // Agent Skill tables intentionally keep their production foreign keys. The
  // isolated store test only needs the referenced identity table.
  await client.$executeRawUnsafe('CREATE TABLE "Novel" ("id" TEXT NOT NULL PRIMARY KEY)');
  const store = new module.AgentSkillStore(client);
  const created = await store.upsertDraft({
    action: 'create',
    scope: 'user',
    status: 'ready_for_review',
    draft: {
      definition: {
        stableId: 'measured-suspense-style',
        title: '克制悬念风格',
        description: '用短句和分层揭示组织悬念。',
      },
      revision: {
        version: '1.0.0',
        manifest: {
          category: 'style',
          triggerHints: ['写紧张调查场景'],
          antiTriggerHints: ['百科式设定说明'],
          supportedOperations: ['chapter.continuation'],
        },
        instructions: '控制句长；每次揭示回答局部问题并扩大核心疑问。',
        constraints: ['不得复用来源专名'],
        examples: [],
      },
    },
    derivationReport: { sourceCoverage: { chapterCount: 2 }, warnings: [] },
  });
  assert.equal(created.status, 'ready_for_review');
  assert.equal(created.version, 1);

  await assert.rejects(
    () => store.upsertDraft({
      ...created,
      id: created.id,
      expectedVersion: 0,
      draft: created.draft,
    }),
    /AGENT_SKILL_DRAFT_VERSION_CONFLICT/,
  );

  const committed = await store.commitDraft({
    draftId: created.id,
    expectedVersion: created.version,
    confirmed: true,
  });
  assert.equal(committed.draft.status, 'committed');
  assert.equal(committed.revision.version, '1.0.0');
  assert.match(committed.revision.contentHash, /^[a-f0-9]{64}$/);

  const skills = await store.listSkills();
  assert.equal(skills.length, 1);
  assert.equal(skills[0].stableId, 'measured-suspense-style');
  assert.equal(skills[0].revisionId, committed.revision.id);

  await assert.rejects(
    () => store.commitDraft({ draftId: created.id, expectedVersion: created.version, confirmed: true }),
    /AGENT_SKILL_DRAFT_VERSION_CONFLICT/,
  );

  const packDraft = await store.upsertDraft({
    action: 'pack',
    scope: 'user',
    status: 'ready_for_review',
    draft: {
      kind: 'skill_pack',
      skills: [
        {
          draftKey: 'language_style',
          definition: { stableId: 'quiet-language', title: '克制语言', description: '控制叙述密度。' },
          revision: {
            version: '1.0.0', manifest: { supportedOperations: ['chapter.continuation'] },
            instructions: '使用短句与具体动作控制叙述距离。', constraints: ['不复制专名'], examples: [],
          },
        },
        {
          draftKey: 'suspense_release',
          definition: { stableId: 'layered-reveal', title: '分层揭示', description: '组织线索与揭示。' },
          revision: {
            version: '1.0.0', manifest: { supportedOperations: ['chapter.continuation'] },
            instructions: '每次揭示解决局部问题，同时扩大核心疑问。', constraints: ['不得无依据误导'], examples: [],
          },
        },
      ],
      pack: {
        definition: { stableId: 'quiet-suspense-pack', title: '克制悬念包', description: '组合语言与悬念方法。' },
        revision: {
          version: '1.0.0',
          bindings: [{
            operationId: 'chapter.continuation', roleId: 'writer',
            primaryDraftKey: 'language_style', auxiliaryDraftKey: 'suspense_release',
          }],
        },
      },
    },
  });
  const committedPack = await store.commitDraft({
    draftId: packDraft.id,
    expectedVersion: packDraft.version,
    confirmed: true,
  });
  assert.equal(committedPack.draft.status, 'committed');
  assert.equal(committedPack.skills.length, 2);
  assert.equal(committedPack.packRevision.bindings.length, 1);
  assert.match(committedPack.packRevision.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(await client.agentSkillPack.count(), 1);
  assert.equal(await client.agentSkillBinding.count(), 0, 'saving a pack must not opt into defaults');
  const packRead = await store.getPack({packId: committedPack.pack.id});
  assert.equal(packRead.members.length, 2);
  assert.equal(packRead.available, true);
  assert.equal(packRead.bindings[0].primary.revisionId, committedPack.skills[0].revisionId);
  await client.$executeRawUnsafe('INSERT INTO "Novel" ("id") VALUES (?)', 'pack-test-book');
  assert.equal((await store.getPackDefault({novelId: 'pack-test-book'})).packId, null);

  const preference = await store.setPackDefault({novelId: 'pack-test-book', packId: packRead.id, revisionId: packRead.revisionId, expectedVersion: 0});
  assert.equal(preference.version, 1);
  assert.equal((await store.getPackDefault({novelId: 'pack-test-book'})).packRevisionId, packRead.revisionId);
  await assert.rejects(store.setPackDefault({novelId: 'pack-test-book', packId: null, expectedVersion: 0}), /DEFAULT_CONFLICT/);
  await store.setPackDefault({novelId: 'pack-test-book', packId: null, expectedVersion: 1});
  assert.equal((await store.getPackDefault({novelId: 'pack-test-book'})).packId, null);

  const modernDraft = structuredClone(packDraft.draft);
  for (const member of modernDraft.skills) member.definition.stableId += '-modern';
  modernDraft.pack.definition.stableId += '-modern';
  modernDraft.pack.revision.coreDraftKey = 'language_style';
  modernDraft.pack.revision.bindings[0].allowedAuxiliaryDraftKeys = ['suspense_release'];
  const modernPending = await store.upsertDraft({action: 'pack', scope: 'user', draft: modernDraft});
  const modern = await store.commitDraft({draftId: modernPending.id,expectedVersion:modernPending.version,confirmed:true});
  const modernRead = await store.getPack({packId:modern.pack.id});
  assert.equal(modernRead.schemaVersion,2);
  assert.equal(modernRead.members.filter(m => m.slot === 'core').length,1);
  assert.deepEqual(modernRead.bindings[0].allowedAuxiliaryMemberKeys,['suspense_release']);
  await client.agentSkill.update({where:{id:modern.skills[0].skillId},data:{enabled:false}});
  assert.equal((await store.getPack({packId:modern.pack.id})).available,false);
  await assert.rejects(store.setPackDefault({novelId:'pack-test-book',packId:modern.pack.id,expectedVersion:2}),/UNAVAILABLE/);
  await client.agentSkill.update({where:{id:modern.skills[0].skillId},data:{enabled:true}});
  await client.agentSkillPack.update({where:{id:modern.pack.id},data:{scope:'novel',ownerNovelId:'pack-test-book'}});
  await assert.rejects(store.getPack({packId:modern.pack.id,novelId:'other-book'}),/NOT_VISIBLE/);
  await store.setPackDefault({novelId:'pack-test-book',packId:modern.pack.id,expectedVersion:2});
  await assert.rejects(store.setPackDefault({novelId:'pack-test-book',packId:packRead.id,expectedVersion:1}),/DEFAULT_CONFLICT/);
  await store.setPackDefault({novelId:'pack-test-book',packId:null,expectedVersion:3});
  assert.equal((await store.getPackDefault({novelId:'pack-test-book'})).version,4, 'cancel preserves the CAS generation');

  // Model the old commit format in a separate novel: exactly one complete
  // flat binding set migrates once and keeps its original member revisions.
  await client.$executeRawUnsafe('INSERT INTO "Novel" ("id") VALUES (?)','legacy-pack-book');
  await client.agentSkillPack.update({where:{id:committedPack.pack.id},data:{scope:'novel',ownerNovelId:'legacy-pack-book'}});
  for (const [member,kind,priority] of [[committedPack.skills[0],'pack_primary',100],[committedPack.skills[1],'pack_auxiliary',50]]) {
    await client.agentSkillBinding.create({data:{id:member.skillId+'-legacy',skillId:member.skillId,novelId:'legacy-pack-book',operationId:'chapter.continuation',roleId:'writer',bindingType:kind,priority}});
  }
  const migrated = await store.getPackDefault({novelId:'legacy-pack-book'});
  assert.equal(migrated.packId,committedPack.pack.id);
  assert.equal((await store.getPackDefault({novelId:'legacy-pack-book'})).version,1);
  assert.equal((await store.listBindings({novelId:'legacy-pack-book'})).length,0);
  // Existing PackRevision has RESTRICT semantics: domain deletion cleans
  // immutable revisions before deleting their owning novel.
  await client.$executeRawUnsafe('DELETE FROM "AgentSkillPackRevision" WHERE "packId"=?',committedPack.pack.id);
  await client.$executeRawUnsafe('DELETE FROM "Novel" WHERE "id"=?','legacy-pack-book');
  assert.equal((await store.getPackDefault({novelId:'legacy-pack-book'})).packId,null,'novel deletion must not be blocked by a default reference');


  const concurrentDraft = await store.upsertDraft({
    action: 'create', scope: 'user', draft: { marker: 'initial' },
  });
  const concurrentUpdates = await Promise.allSettled([
    store.upsertDraft({
      id: concurrentDraft.id, expectedVersion: concurrentDraft.version,
      action: concurrentDraft.action, scope: concurrentDraft.scope, draft: { marker: 'left' },
    }),
    store.upsertDraft({
      id: concurrentDraft.id, expectedVersion: concurrentDraft.version,
      action: concurrentDraft.action, scope: concurrentDraft.scope, draft: { marker: 'right' },
    }),
  ]);
  assert.equal(concurrentUpdates.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(concurrentUpdates.filter((item) => item.status === 'rejected').length, 1);
  assert.match(String(concurrentUpdates.find((item) => item.status === 'rejected').reason), /AGENT_SKILL_DRAFT_VERSION_CONFLICT/);

  const workspace = await store.createAuthoringWorkspace({ scope: 'user' });
  assert.equal(workspace.phase, 'authoring');
  assert.equal(workspace.documents[0].logicalPath, 'SKILL.md');
  const authoredText = skillMarkdown({
    stableId: 'layered-scene-pressure',
    title: '场景压力构建',
    description: '在续写冲突场景时逐层增加人物选择压力。',
  });
  const written = await store.writeAuthoringDocument({
    draftId: workspace.draftId,
    expectedVersion: workspace.version,
    logicalPath: 'SKILL.md',
    contentText: authoredText,
  });
  const read = await store.readAuthoringDocument({ draftId: workspace.draftId, logicalPath: 'SKILL.md' });
  assert.equal(read.contentText, authoredText);
  assert.equal(read.contentHash, written.documents[0].contentHash);
  await assert.rejects(
    () => store.patchAuthoringDocument({
      draftId: workspace.draftId,
      expectedVersion: written.version,
      logicalPath: 'SKILL.md',
      expectedContentHash: written.documents[0].contentHash,
      oldText: '不存在的文本',
      newText: '替换文本',
    }),
    /AGENT_SKILL_WORKSPACE_PATCH_CONFLICT/,
  );
  const patched = await store.patchAuthoringDocument({
    draftId: workspace.draftId,
    expectedVersion: written.version,
    logicalPath: 'SKILL.md',
    expectedContentHash: written.documents[0].contentHash,
    oldText: '逐层增加人物选择压力',
    newText: '逐层提高人物选择代价',
  });
  assert.equal(patched.validatedInputHash, undefined);
  const validated = await store.validateAuthoringWorkspace({
    draftId: workspace.draftId,
    expectedVersion: patched.version,
  });
  assert.equal(validated.validationReport.ok, true);
  assert.equal(validated.validatedInputHash, validated.authoringInputHash);
  const compiled = await store.compileAuthoringWorkspace({
    draftId: workspace.draftId,
    expectedVersion: validated.version,
  });
  assert.equal(compiled.status, 'ready_for_review');
  assert.equal(compiled.phase, 'compiled');
  assert.equal(compiled.compiledInputHash, compiled.authoringInputHash);
  const diff = await store.diffAuthoringWorkspace({ draftId: workspace.draftId });
  assert.equal(diff.stale, false);
  assert.equal(diff.documents[0].changeType, 'added');
  const committedAuthored = await store.commitDraft({
    draftId: workspace.draftId,
    expectedVersion: compiled.version,
    confirmed: true,
  });
  assert.equal(committedAuthored.draft.status, 'committed');
  assert.equal(committedAuthored.revision.version, '1.0.0');

  const staleWorkspace = await store.createAuthoringWorkspace({
    scope: 'user',
    contentText: skillMarkdown({
      stableId: 'stale-workspace-check',
      title: '失效检查',
      description: '验证编译后改动必须重新校验。',
    }),
  });
  const staleValidated = await store.validateAuthoringWorkspace({
    draftId: staleWorkspace.draftId,
    expectedVersion: staleWorkspace.version,
  });
  const staleCompiled = await store.compileAuthoringWorkspace({
    draftId: staleWorkspace.draftId,
    expectedVersion: staleValidated.version,
  });
  const staleRead = await store.readAuthoringDocument({ draftId: staleWorkspace.draftId, logicalPath: 'SKILL.md' });
  const staleEdited = await store.writeAuthoringDocument({
    draftId: staleWorkspace.draftId,
    expectedVersion: staleCompiled.version,
    logicalPath: 'SKILL.md',
    contentText: staleRead.contentText.replace('失效检查', '失效检查修订'),
  });
  assert.equal(staleEdited.status, 'editing');
  assert.equal(staleEdited.compiledInputHash, undefined);
  await assert.rejects(
    () => store.commitDraft({ draftId: staleWorkspace.draftId, expectedVersion: staleEdited.version, confirmed: true }),
    /AGENT_SKILL_WORKSPACE_STALE/,
  );

  const invalidWorkspace = await store.createAuthoringWorkspace({ scope: 'user', contentText: '没有 frontmatter' });
  const invalidValidation = await store.validateAuthoringWorkspace({
    draftId: invalidWorkspace.draftId,
    expectedVersion: invalidWorkspace.version,
  });
  assert.equal(invalidValidation.validationReport.ok, false);
  assert.equal(invalidValidation.phase, 'revising');
  assert.equal(invalidValidation.validationReport.diagnostics[0].path, 'SKILL.md');
  const attentionValidation = await store.validateAuthoringWorkspace({
    draftId: invalidWorkspace.draftId,
    expectedVersion: invalidValidation.version,
    finalAttempt: true,
  });
  assert.equal(attentionValidation.phase, 'needs_attention');

  const legacyStyle = await store.createAuthoringWorkspace({
    scope: 'user',
    contentText: skillMarkdown({
      stableId: 'legacy-invalid-style', title: '旧文风', description: '保留正文，整理无效输出格式。',
      instruction: '只保留有作用的细节，不在段尾总结。',
    }).replace('outputType: none', 'outputType: markdown'),
  });
  const countBeforePrepare = await client.agentSkill.count();
  const preparedStyle = await store.prepareAuthoringWorkspace({
    draftId: legacyStyle.draftId, expectedVersion: legacyStyle.version,
  });
  assert.equal(preparedStyle.validationReport.ok, true);
  assert.equal(preparedStyle.draft.status, 'ready_for_review');
  assert.equal(preparedStyle.draft.draft.authoring.phase, 'compiled');
  assert.equal(preparedStyle.draft.draft.revision.manifest.outputType, 'none');
  assert.equal(await client.agentSkill.count(), countBeforePrepare, 'prepare never publishes');
  assert.equal(preparedStyle.draft.committedRevisionId, undefined);
  assert.equal(preparedStyle.repairs[0].code, 'SKILL_STYLE_OUTPUT_TYPE_NORMALIZED');
  assert.deepEqual(preparedStyle.draft.draft.authoring.repairs, preparedStyle.repairs);
  await assert.rejects(() => store.prepareAuthoringWorkspace({
    draftId: legacyStyle.draftId, expectedVersion: legacyStyle.version,
  }), /AGENT_SKILL_DRAFT_VERSION_CONFLICT/);

  const referenced = await store.writeAuthoringDocument({
    draftId: legacyStyle.draftId, expectedVersion: preparedStyle.draft.version,
    logicalPath: 'references/sample.md', contentText: '这是参考片段，必须原样保留。',
  });
  const extraMetadata = preparedStyle.draft.draft.authoring.documents[0].contentText
    .replace('category: style', 'category: style\ncustomLabel: keep-me\ncontextNeeds:\n  - chapter.content');
  const customWritten = await store.writeAuthoringDocument({
    draftId: legacyStyle.draftId, expectedVersion: referenced.version,
    logicalPath: 'SKILL.md', contentText: extraMetadata,
  });
  const chineseBody = '---\nscope: novel\n---\n\n作者正文：过渡事件一句带过，保留这段示例格式。';
  const authorEdited = await store.prepareAuthoringWorkspace({
    draftId: legacyStyle.draftId, expectedVersion: customWritten.version,
    rules: { title: '作者修改文风', description: '作者填写的用途。', instructions: chineseBody },
  });
  assert.equal(authorEdited.validationReport.ok, true);
  assert.equal(authorEdited.draft.draft.definition.title, '作者修改文风');
  assert.equal(authorEdited.draft.draft.definition.description, '作者填写的用途。');
  assert.equal(authorEdited.draft.draft.revision.instructions, chineseBody, 'author body is never interpreted as metadata');
  assert.deepEqual(authorEdited.draft.draft.revision.constraints, ['不复制来源专名']);
  assert.deepEqual(authorEdited.draft.draft.revision.manifest.contextNeeds, ['chapter.content']);
  assert.equal(authorEdited.draft.scope, 'user');
  assert.match(authorEdited.draft.draft.authoring.documents[0].contentText, /customLabel: keep-me/);
  assert.equal(authorEdited.draft.draft.authoring.documents[1].contentText, '这是参考片段，必须原样保留。');
  const editedCommit = await store.commitDraft({
    draftId: legacyStyle.draftId, expectedVersion: authorEdited.draft.version, confirmed: true,
  });
  assert.equal(editedCommit.draft.status, 'committed');
  assert.equal(editedCommit.revision.instructions, chineseBody);
  await assert.rejects(() => store.prepareAuthoringWorkspace({
    draftId: legacyStyle.draftId, expectedVersion: editedCommit.draft.version,
    rules: { instructions: '尝试改动正式版本' },
  }), /AGENT_SKILL_DRAFT_NOT_EDITABLE/);

  const autoNormalize = await store.createAuthoringWorkspace({
    scope: 'user',
    contentText: '```markdown\n' + skillMarkdown({
      stableId: 'automatic-normalize-style', title: '自动整理', description: '创建循环也能整理格式。',
    }).replace('schemaVersion: novel-editor.agent-skill.v1\n', '').replace('outputType: none', 'outputType: text').trim() + '\n```',
  });
  const autoValidated = await store.validateAuthoringWorkspace({
    draftId: autoNormalize.draftId, expectedVersion: autoNormalize.version,
  });
  assert.equal(autoValidated.validationReport.ok, true, 'Creator validate shares deterministic normalization');
  assert.equal(autoValidated.repairs.length, 3);
  const autoPersisted = await store.getDraft(autoNormalize.draftId);
  assert.equal(autoPersisted.draft.authoring.repairs.length, 3);
  assert.match(autoPersisted.draft.authoring.documents[0].contentText, /schemaVersion: "novel-editor.agent-skill.v1"/);
  assert.equal(autoPersisted.status, 'editing', 'validate alone does not compile or publish');

  const missingIdentity = await store.createAuthoringWorkspace({
    scope: 'user', contentText: skillMarkdown({
      stableId: 'temporary-id', title: '软件维护标识', description: '标识不需要作者编写。',
    }).replace('stableId: temporary-id\n', '').replace('version: 1.0.0\n', ''),
  });
  const missingPrepared = await store.prepareAuthoringWorkspace({
    draftId: missingIdentity.draftId, expectedVersion: missingIdentity.version,
  });
  assert.equal(missingPrepared.validationReport.ok, true);
  assert.equal(missingPrepared.draft.draft.definition.stableId, `user.skill-${missingIdentity.draftId}`);
  assert.equal(missingPrepared.draft.draft.revision.version, '1.0.0');
  const updateWorkspace = await store.createAuthoringWorkspace({
    scope: 'user', targetSkillId: committed.revision.skillId,
  });
  const updateDoc = await store.readAuthoringDocument({ draftId: updateWorkspace.draftId, logicalPath: 'SKILL.md' });
  const updateWritten = await store.writeAuthoringDocument({
    draftId: updateWorkspace.draftId, expectedVersion: updateWorkspace.version, logicalPath: 'SKILL.md',
    contentText: updateDoc.contentText.replace(/^stableId:.*\n/m, '').replace(/^version:.*\n/m, ''),
  });
  const updatePrepared = await store.prepareAuthoringWorkspace({
    draftId: updateWorkspace.draftId, expectedVersion: updateWritten.version,
  });
  assert.equal(updatePrepared.validationReport.ok, true);
  assert.equal(updatePrepared.draft.draft.definition.stableId, 'measured-suspense-style');
  assert.equal(updatePrepared.draft.draft.revision.version, '1.0.1');
  const preparedRaces = await Promise.allSettled(['左边修改。', '右边修改。'].map((instructions) => (
    store.prepareAuthoringWorkspace({
      draftId: missingIdentity.draftId, expectedVersion: missingPrepared.draft.version, rules: { instructions },
    })
  )));
  assert.equal(preparedRaces.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(String(preparedRaces.find((result) => result.status === 'rejected').reason), /AGENT_SKILL_DRAFT_VERSION_CONFLICT/);

  const unknownStyle = await store.createAuthoringWorkspace({
    scope: 'user',
    contentText: skillMarkdown({
      stableId: 'unknown-invalid-style', title: '未知错误', description: '不能猜测用途与权限。',
    }).replace('outputType: none', 'outputType: arbitrary-format').replace('  - chapter.continuation', '  - bad operation')
      .replace('  - writer', '  - root_admin'),
  });
  const unknownPrepared = await store.prepareAuthoringWorkspace({
    draftId: unknownStyle.draftId, expectedVersion: unknownStyle.version,
    rules: { instructions: '作者只修改正文，系统不能猜测执行权限。' },
  });
  assert.equal(unknownPrepared.validationReport.ok, false);
  assert.equal(unknownPrepared.draft.draft.authoring.phase, 'needs_attention');
  assert.equal(unknownPrepared.draft.status, 'editing');
  assert.equal(unknownPrepared.draft.draft.revision, undefined);
  for (const code of ['SKILL_OUTPUT_TYPE_INVALID', 'SKILL_OPERATIONS_INVALID', 'SKILL_ROLES_INVALID']) {
    assert(unknownPrepared.validationReport.diagnostics.some((diagnostic) => diagnostic.code === code));
  }
  for (const rules of [{ scope: 'novel' }, { supportedOperations: ['chapter.continuation'] }, { rawcontent: 'replacement' }]) {
    await assert.rejects(() => store.prepareAuthoringWorkspace({
      draftId: unknownStyle.draftId, expectedVersion: unknownPrepared.draft.version, rules,
    }), /AGENT_SKILL_WORKSPACE_AUTHOR_RULES_INVALID/);
  }
  assert.equal((await store.getDraft(unknownStyle.draftId)).version, unknownPrepared.draft.version);
  await assert.rejects(() => store.commitDraft({
    draftId: unknownStyle.draftId, expectedVersion: unknownPrepared.draft.version, confirmed: true,
  }), /AGENT_SKILL_WORKSPACE_STALE/);
  const discarded = await store.discardDraft(unknownStyle.draftId, unknownPrepared.draft.version);
  await assert.rejects(() => store.prepareAuthoringWorkspace({
    draftId: discarded.id, expectedVersion: discarded.version,
  }), /AGENT_SKILL_DRAFT_NOT_EDITABLE/);

  const packWorkspace = await store.createAuthoringWorkspace({
    action: 'pack',
    scope: 'user',
    logicalPath: 'language-style/SKILL.md',
    derivationReport: { kind: 'style_skill_pack_extraction', qualityRequired: true, sourceCoverage: { chapterCount: 2 } },
  });
  const languageWritten = await store.writeAuthoringDocument({
    draftId: packWorkspace.draftId,
    expectedVersion: packWorkspace.version,
    logicalPath: 'language-style/SKILL.md',
    contentText: skillMarkdown({
      stableId: 'pack-language-style', title: '组合语言风格', description: '控制句式和叙述距离。',
    }),
  });
  const suspenseWritten = await store.writeAuthoringDocument({
    draftId: packWorkspace.draftId,
    expectedVersion: languageWritten.version,
    logicalPath: 'suspense-release/SKILL.md',
    contentText: skillMarkdown({
      stableId: 'pack-suspense-release', title: '组合悬念释放', description: '控制线索与答案的释放顺序。',
    }),
  });
  const packSet = await store.setAuthoringPack({
    draftId: packWorkspace.draftId,
    expectedVersion: suspenseWritten.version,
    pack: {
      definition: { stableId: 'authored-style-pack', title: '创作文风组合', description: '组合语言风格和悬念释放。' },
      revision: {
        version: '1.0.0',
        bindings: [{
          operationId: 'chapter.continuation', roleId: 'writer',
          primaryDraftKey: 'language-style', auxiliaryDraftKey: 'suspense-release',
        }],
      },
    },
  });
  let packValidated = await store.validateAuthoringWorkspace({
    draftId: packWorkspace.draftId,
    expectedVersion: packSet.version,
  });
  assert.equal(packValidated.validationReport.ok, true);
  const formatOnly = await store.prepareAuthoringWorkspace({ draftId: packWorkspace.draftId, expectedVersion: packValidated.version });
  assert.equal(formatOnly.validationReport.ok, true);
  assert.equal(formatOnly.draft.status, 'editing', 'Formatting cannot bypass required content/trial acceptance');
  assert.equal(formatOnly.draft.draft.authoring.phase, 'needs_attention');
  packValidated = await store.validateAuthoringWorkspace({ draftId: packWorkspace.draftId, expectedVersion: formatOnly.draft.version });
  await assert.rejects(() => store.compileAuthoringWorkspace({ draftId: packWorkspace.draftId,
    expectedVersion: packValidated.version }), /STYLE_SKILL_QUALITY_REVIEW_REQUIRED/);
  const documentChecks = Object.fromEntries(['task_fit', 'rule_calibration', 'evidence_trace', 'counterexamples', 'contamination', 'binding_fit'].map(key => [key, 'pass']));
  const trialChecks = Object.fromEntries(['task_completion', 'style_application', 'clarity', 'non_mechanical', 'non_contamination'].map(key => [key, 'pass']));
  const qualityReview = { status: 'passed', inputHash: packValidated.authoringInputHash,
    documentReviews: ['language_style', 'suspense_release'].map(draftKey => ({ draftKey, accepted: true, checks: documentChecks, issues: [] })),
    trials: Object.fromEntries(['baseline', 'language_style', 'suspense_release', 'pack'].map(key => [key, '原创完整场景。'.repeat(40)])),
    trialReviews: Object.fromEntries(['language_style', 'suspense_release', 'pack'].map(key => [key, { accepted: true, checks: trialChecks, issues: [] }])) };
  await assert.rejects(() => store.compileAuthoringWorkspace({ draftId: packWorkspace.draftId, expectedVersion: packValidated.version,
    qualityReview: { ...qualityReview, inputHash: 'outdated' } }), /STYLE_SKILL_QUALITY_REVIEW_REQUIRED/);
  const unverified = structuredClone(qualityReview);
  unverified.trialReviews.pack.checks.style_application = 'unverified';
  await assert.rejects(() => store.compileAuthoringWorkspace({ draftId: packWorkspace.draftId, expectedVersion: packValidated.version,
    qualityReview: unverified }), /STYLE_SKILL_QUALITY_REVIEW_REQUIRED/);
  const blocking = structuredClone(qualityReview);
  blocking.documentReviews[0].issues = [{ severity: 'blocking', message: '未核验的硬规则' }];
  await assert.rejects(() => store.compileAuthoringWorkspace({ draftId: packWorkspace.draftId,
    expectedVersion: packValidated.version, qualityReview: blocking }), /STYLE_SKILL_QUALITY_REVIEW_REQUIRED/);
  const legacyBlocking = structuredClone(qualityReview);
  legacyBlocking.documentReviews[0].issues = [{ message: '旧格式问题仍按阻塞处理' }];
  await assert.rejects(() => store.compileAuthoringWorkspace({ draftId: packWorkspace.draftId,
    expectedVersion: packValidated.version, qualityReview: legacyBlocking }), /STYLE_SKILL_QUALITY_REVIEW_REQUIRED/);
  qualityReview.documentReviews[0].issues = [{ severity: 'advisory', message: '可选润色' }];
  const packCompiled = await store.compileAuthoringWorkspace({
    draftId: packWorkspace.draftId,
    expectedVersion: packValidated.version,
    qualityReview,
  });
  // A source-derived language-only Pack needs both scenes and all seven trial checks.
  const single = await store.createAuthoringWorkspace({action: 'pack', scope: 'user', logicalPath: 'language-style/SKILL.md',
    derivationReport: {kind: 'style_skill_pack_extraction', qualityRequired: true, sourceCoverage: {chapterCount: 10, fidelityMode: 2}}});
  const singleWritten = await store.writeAuthoringDocument({draftId: single.draftId, expectedVersion: single.version, logicalPath: 'language-style/SKILL.md',
    contentText: skillMarkdown({stableId: 'single-source-language', title: '来源语言方法', description: '按来源和场景调整叙述节奏。'})});
  const singlePack = await store.setAuthoringPack({draftId: single.draftId, expectedVersion: singleWritten.version, pack: {
    definition: {stableId: 'single-source-pack', title: '来源语言包', description: '仅有语言成员。'},
    revision: {version: '1.0.0', bindings: [{operationId: 'chapter.continuation', roleId: 'writer', primaryDraftKey: 'language-style'}]},
  }});
  const singleValidated = await store.validateAuthoringWorkspace({draftId: single.draftId, expectedVersion: singlePack.version});
  assert.equal(singleValidated.validationReport.ok, true);
  const fidelityChecks = {...trialChecks, source_fidelity: 'pass', rhythm_variation: 'pass'};
  const sceneKeys = ['baseline', 'language_style', 'pack', 'transition.baseline', 'transition.language_style', 'transition.pack'];
  const singleReview = {status: 'passed', version: 2, sceneKeys: ['interaction', 'transition'], inputHash: singleValidated.authoringInputHash,
    documentReviews: [{draftKey: 'language_style', accepted: true, checks: documentChecks, issues: []}],
    trials: Object.fromEntries(sceneKeys.map(key => [key, '来源一致的原创场景。'.repeat(40)])),
    trialReviews: Object.fromEntries(sceneKeys.filter(key => !key.endsWith('baseline')).map(key => [key, {accepted: true, checks: fidelityChecks, issues: []}]))};
  const missingScene = structuredClone(singleReview);
  delete missingScene.trialReviews['transition.pack'];
  await assert.rejects(store.compileAuthoringWorkspace({draftId: single.draftId, expectedVersion: singleValidated.version, qualityReview: missingScene}), /STYLE_SKILL_QUALITY_REVIEW_REQUIRED/);
  const unsupportedSource = structuredClone(singleReview);
  unsupportedSource.trialReviews.pack.checks.source_fidelity = 'unverified';
  await assert.rejects(store.compileAuthoringWorkspace({draftId: single.draftId, expectedVersion: singleValidated.version, qualityReview: unsupportedSource}), /STYLE_SKILL_QUALITY_REVIEW_REQUIRED/);
  await assert.rejects(store.compileAuthoringWorkspace({draftId: single.draftId, expectedVersion: singleValidated.version, qualityReview: {...singleReview, version: 1}}), /STYLE_SKILL_QUALITY_REVIEW_REQUIRED/);
  const singleCompiled = await store.compileAuthoringWorkspace({draftId: single.draftId, expectedVersion: singleValidated.version, qualityReview: singleReview});
  assert.equal((await store.getDraft(single.draftId)).draft.skills.length, 1);
  const singleCommitted = await store.commitDraft({draftId: single.draftId, expectedVersion: singleCompiled.version, confirmed: true});
  assert.equal(singleCommitted.skills.length, 1);
  assert.equal((await store.getPack({packId: singleCommitted.pack.id})).members.length, 1);
  await client.$executeRawUnsafe('INSERT INTO Novel (id) VALUES (?)', 'publication-review-book');
  await store.setDraftPublication({draftId: packWorkspace.draftId, scope: 'novel', ownerNovelId: 'publication-review-book', expectedPublicationVersion: 1});
  const authoredPack = await store.commitDraft({
    draftId: packWorkspace.draftId,
    expectedVersion: packCompiled.version,
    confirmed: true,
  });
  assert.equal(authoredPack.skills.length, 2);
  assert.equal(authoredPack.draft.scope, 'novel');
  assert.equal(authoredPack.draft.draft.styleQualityReview.status, 'passed');
  assert.equal(authoredPack.draft.draft.styleQualityReview.visibilityOnlyRevalidation.previousInputHash, qualityReview.inputHash);
  assert.equal((await store.getPack({packId: authoredPack.pack.id, novelId: 'publication-review-book'})).ownerNovelId, 'publication-review-book');
  assert.equal(authoredPack.packRevision.bindings[0].primary.skillId.length > 0, true);
  console.log('Agent Skill store tests passed.');
} finally {
  await client.$disconnect();
  await rm(tempRoot, { recursive: true, force: true });
}
