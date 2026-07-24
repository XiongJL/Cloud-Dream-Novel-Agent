import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const panel = await readFile(new URL('../src/components/AgentWorkspace/CreativeAssetsReviewPanel.tsx', import.meta.url), 'utf8');
const workspace = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
const automation = await readFile(new URL('../electron/automation/AutomationService.ts', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../../../agent_runtime/novel_agent_runtime/runtime.py', import.meta.url), 'utf8');
const manifest = await readFile(new URL('../../../agent_runtime/novel_agent_runtime/tool_manifest.py', import.meta.url), 'utf8');

assert.match(workspace, /session\.type === 'creative-assets'/);
assert.match(workspace, /<CreativeAssetsReviewPanel/);
assert.match(workspace, /isCreativeAssets \? 'creative_assets_draft' : 'chapter_draft'/);
assert.match(panel, /情节线/);
assert.match(panel, /情节点/);
assert.match(panel, /角色/);
assert.match(panel, /物品与设定/);
assert.match(panel, /技能/);
assert.match(panel, /地图与地点/);
assert.match(panel, /kind: 'asset_item'/);
assert.match(panel, /selection: selectWholePackage\(draft\)/);
assert.match(panel, /整包入库/);
assert.match(panel, /撤销整包入库/);
assert.match(panel, /window\.automation\.invoke\('draft\.undo'/);
assert.match(panel, /const blockingComments = isDraft \? reviewComments\.activeComments : \[\]/);
assert.match(panel, /blockingComments\.length > 0/);
assert.doesNotMatch(panel, /type="checkbox"/);

assert.match(automation, /async reviseCreativeAssetsDraftSession/);
assert.match(automation, /case 'creative_assets\.revise_draft'/);
assert.match(automation, /revisionOfDraftSessionId: source\.draftSessionId/);
assert.match(automation, /undoCreativeAssetsWriteback/);
assert.match(runtime, /revision_tool = "creative_assets\.revise_draft"/);
assert.match(runtime, /deliverable="creative_assets_draft" if is_creative_assets else "chapter_draft"/);
assert.match(manifest, /"creative_assets\.revise_draft"/);

console.log('Creative assets Inspector review and revision contracts passed.');
