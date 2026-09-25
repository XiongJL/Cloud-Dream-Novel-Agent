import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
const preload = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');

assert.match(preload, /retryRun:\s*\(payload: any\).*agent\.retry_run/s);
assert.match(workspace, /window\.agent\.retryRun\(\{/);
assert.match(workspace, /failedRun\.recovery\?\.retryStrategy/);
assert.match(workspace, /conversation\.run\.recovery\?\.failureKind === 'local_transform_failed'/);
assert.match(workspace, /recovery: latestStatus\.recovery/);
assert.match(workspace, /response\.intentDecision\?\.route === 'retry_failed_run'/);
assert.match(workspace, /activeConversation\.runs\?\.find\(\(run\) => run\.runId === recovery\.failedRunId\)/);
assert.match(workspace, /!recovery && !response\.pendingUserInput \? \[\{/);
assert.match(workspace, /重试失败步骤/);
assert.match(workspace, /调整并重新规划/);
assert.match(workspace, /conversationId: activeConversation\.runtimeConversationId/);
assert.match(workspace, /suggestedGoal: goal/);
assert.match(workspace, /目标章节解析可恢复/);
assert.match(workspace, /重新生成计划草稿/);
assert.match(workspace, /isChapterTargetUnresolvedError\(activeError\)/);
const planCardStart = workspace.indexOf('function PlanCard({');
const planCardEnd = workspace.indexOf('function AgentActivityStream(', planCardStart);
assert.ok(planCardStart >= 0 && planCardEnd > planCardStart, 'PlanCard block should exist');
const planCard = workspace.slice(planCardStart, planCardEnd);
assert.match(planCard, /run\?\.status === 'cancelled'/);
assert.doesNotMatch(planCard, /run\?\.status === 'failed' \|\| run\?\.status === 'cancelled'/);

console.log('Agent retry Renderer contract tests passed.');
