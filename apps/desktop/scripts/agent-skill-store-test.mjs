import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { PrismaClient } from '@novel-editor/core';

const authoringSource = await readFile(new URL('../electron/agentSkills/AgentSkillAuthoring.ts', import.meta.url), 'utf8');
const authoringOutput = ts.transpileModule(authoringSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const authoringUrl = `data:text/javascript;base64,${Buffer.from(authoringOutput).toString('base64')}`;
const source = (await readFile(new URL('../electron/agentSkills/AgentSkillStore.ts', import.meta.url), 'utf8'))
  .replace("'./AgentSkillAuthoring'", JSON.stringify(authoringUrl));
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
  assert.equal(await client.agentSkillBinding.count(), 2);

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

  const packWorkspace = await store.createAuthoringWorkspace({
    action: 'pack',
    scope: 'user',
    logicalPath: 'language-style/SKILL.md',
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
  const packValidated = await store.validateAuthoringWorkspace({
    draftId: packWorkspace.draftId,
    expectedVersion: packSet.version,
  });
  assert.equal(packValidated.validationReport.ok, true);
  const packCompiled = await store.compileAuthoringWorkspace({
    draftId: packWorkspace.draftId,
    expectedVersion: packValidated.version,
  });
  const authoredPack = await store.commitDraft({
    draftId: packWorkspace.draftId,
    expectedVersion: packCompiled.version,
    confirmed: true,
  });
  assert.equal(authoredPack.skills.length, 2);
  assert.equal(authoredPack.packRevision.bindings[0].primary.skillId.length > 0, true);
  console.log('Agent Skill store tests passed.');
} finally {
  await client.$disconnect();
  await rm(tempRoot, { recursive: true, force: true });
}
