import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('../src/components/AgentWorkspace/RevisionTaskWorkspace.tsx', import.meta.url), 'utf8');
const agentWorkspace = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
const reviewStore = await readFile(new URL('../electron/agent/AgentReviewStore.ts', import.meta.url), 'utf8');

assert.match(workspace, /待改清单/);
assert.match(workspace, /col-start-2/);
assert.match(workspace, /max-\[1180px\]:col-start-1/);
assert.match(workspace, /max-w-\[960px\]/);
assert.doesNotMatch(workspace, /col-span-2/);
assert.doesNotMatch(workspace, /TaskStatusLabel/);
assert.doesNotMatch(workspace, /生成可审核计划/);
assert.doesNotMatch(workspace, /任务详情/);
assert.match(workspace, /继续处理/);
assert.match(workspace, /返回当前对话/);
assert.match(workspace, /稍后处理/);
assert.match(workspace, /执行中断/);
assert.match(workspace, /历史记录/);

assert.match(agentWorkspace, /sourceArtifactId: artifact\.artifactId/);
assert.match(agentWorkspace, /revision_task\.sync_run/);
assert.match(agentWorkspace, /hasCommittedRevisionDraft/);
assert.match(agentWorkspace, /\? 'committed' : 'completed'/);
assert.match(agentWorkspace, /candidate\.id === task\.sourceConversationId/);
assert.doesNotMatch(agentWorkspace, /已从修订任务池打开可审核计划/);
assert.doesNotMatch(agentWorkspace, /onOpenPlan=/);

assert.match(reviewStore, /syncRevisionTasksFromRun/);
assert.match(reviewStore, /input\.outcome === 'committed'/);
assert.match(reviewStore, /WHEN AgentRevisionTask\.status IN \('resolved', 'stale'\)/);
assert.match(reviewStore, /COALESCE\(task\.sourceConversationId, artifact\.conversationId\)/);

console.log('Agent pending-revision list layout and recovery contracts passed.');
