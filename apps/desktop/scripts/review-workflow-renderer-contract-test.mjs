import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
const batchReview = await readFile(new URL('../src/components/AgentWorkspace/DraftBatchReviewPanel.tsx', import.meta.url), 'utf8');
const paragraphReview = await readFile(new URL('../src/components/AgentWorkspace/DraftReviewComments.tsx', import.meta.url), 'utf8');
const reviewStore = await readFile(new URL('../electron/automation/ReviewCommentStore.ts', import.meta.url), 'utf8');

assert.match(workspace, /type InspectorTab = 'context' \| 'artifacts' \| 'review' \| 'evidence' \| 'roles'/);
assert.match(workspace, /grid-cols-5/);
assert.doesNotMatch(workspace, /\{ id: 'tools', label:/);

assert.match(workspace, /onOpenReview=\{\(\) => openInspector\('review', 'draft', timelineRun\.runId\)\}/);
assert.match(workspace, /activeRun=\{selectedReviewRun\}/);
assert.match(workspace, /reviewComments\.unresolvedComments\.length > 0[\s\S]*?发送意见/);
assert.match(workspace, /disabled=\{!isDraft \|\| isSaving \|\| reviewComments\.unresolvedComments\.length > 0\}/);
assert.match(workspace, /<ReviewableParagraphs/);
assert.match(workspace, /<ReviewSubmitDialog/);

assert.match(batchReview, /reviewComments\.unresolvedComments\.map\(\(comment\) => comment\.childIndex \?\? 0\)/);
assert.match(batchReview, /onRegenerate\(batch, earliestChildIndex, reviewComments\.unresolvedComments\)/);
assert.match(batchReview, /整批有 \$\{reviewComments\.pendingComments\.length\} 条审批意见待发送/);

assert.match(paragraphReview, /aria-label=\{`为第 \$\{paragraphIndex \+ 1\} 段添加审批意见`\}/);
assert.doesNotMatch(paragraphReview, /type="checkbox"/);
assert.doesNotMatch(reviewStore, /Review comments must belong to one review version/);

console.log('Review workflow renderer contract tests passed.');
