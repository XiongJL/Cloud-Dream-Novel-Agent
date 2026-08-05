import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { PrismaClient } from '@novel-editor/core';

const source = await readFile(new URL('../electron/agentSkills/AgentSkillStore.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

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
  console.log('Agent Skill store tests passed.');
} finally {
  await client.$disconnect();
  await rm(tempRoot, { recursive: true, force: true });
}
