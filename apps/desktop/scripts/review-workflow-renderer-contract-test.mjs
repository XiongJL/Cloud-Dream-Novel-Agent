import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const workspace = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
const batchReview = await readFile(new URL('../src/components/AgentWorkspace/DraftBatchReviewPanel.tsx', import.meta.url), 'utf8');
const chapterBeatPreview = await readFile(new URL('../src/components/AgentWorkspace/ChapterBeatPreviewPanel.tsx', import.meta.url), 'utf8');
const paragraphReview = await readFile(new URL('../src/components/AgentWorkspace/DraftReviewComments.tsx', import.meta.url), 'utf8');
const diffView = await readFile(new URL('../src/components/AgentWorkspace/DraftDiffView.tsx', import.meta.url), 'utf8');
const diffHook = await readFile(new URL('../src/components/AgentWorkspace/useTextDiff.ts', import.meta.url), 'utf8');
const diffWorker = await readFile(new URL('../src/workers/textDiff.worker.ts', import.meta.url), 'utf8');
const textDiff = await readFile(new URL('../shared/textDiff.ts', import.meta.url), 'utf8');
const contextBuilder = await readFile(new URL('../electron/ai/context/ContextBuilder.ts', import.meta.url), 'utf8');
const reviewCommentTypes = await readFile(new URL('../shared/reviewComments.ts', import.meta.url), 'utf8');
const reviewStore = await readFile(new URL('../electron/automation/ReviewCommentStore.ts', import.meta.url), 'utf8');
const consolidatedReport = await readFile(new URL('../src/components/AgentWorkspace/ConsolidatedReportCard.tsx', import.meta.url), 'utf8');
const expertReportPanel = await readFile(new URL('../src/components/AgentWorkspace/ExpertReportPanel.tsx', import.meta.url), 'utf8');
const reportAvailabilitySource = await readFile(new URL('../src/components/AgentWorkspace/reportReviewAvailability.ts', import.meta.url), 'utf8');
const reportAvailabilityOutput = ts.transpileModule(reportAvailabilitySource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const reportAvailability = await import(`data:text/javascript;base64,${Buffer.from(reportAvailabilityOutput).toString('base64')}`);

assert.match(workspace, /type InspectorTab = 'context' \| 'artifacts' \| 'review' \| 'evidence' \| 'roles'/);
assert.match(workspace, /grid-cols-5/);
assert.doesNotMatch(workspace, /\{ id: 'tools', label:/);

assert.match(workspace, /onOpenReview=\{\(\) => openInspector\('review', 'draft', timelineRun\.runId\)\}/);
assert.match(workspace, /activeRun=\{selectedReviewRun\}/);
assert.match(workspace, /reviewComments\.unresolvedComments\.length > 0[\s\S]*?发送意见/);
assert.match(workspace, /disabled=\{!isDraft \|\| isSaving \|\| reviewComments\.unresolvedComments\.length > 0\}/);
assert.match(workspace, /<ReviewSubmitDialog/);
assert.match(workspace, /reviewAvailability=\{reportReviewAvailability\}/);
assert.match(workspace, /reportReviewAvailability=\{selectedReportReviewAvailability\}/);

assert.equal(reportAvailability.resolveReportReviewAvailability({ runStatus: 'running', workspaceBusy: true, runtimeRecoveryPending: false, planPending: false }), 'generating');
assert.equal(reportAvailability.resolveReportReviewAvailability({ runStatus: 'waiting_user_input', workspaceBusy: false, runtimeRecoveryPending: false, planPending: false }), 'waiting');
assert.equal(reportAvailability.resolveReportReviewAvailability({ runStatus: 'completed', workspaceBusy: false, runtimeRecoveryPending: false, planPending: false }), 'ready');
assert.equal(reportAvailability.resolveReportReviewAvailability({ runStatus: 'completed', workspaceBusy: true, runtimeRecoveryPending: false, planPending: false }), 'blocked');
assert.equal(reportAvailability.resolveReportReviewAvailability({ runStatus: 'failed', workspaceBusy: false, runtimeRecoveryPending: false, planPending: false }), 'ready');
assert.equal(reportAvailability.resolveReportReviewAvailability({ runStatus: 'cancelled', workspaceBusy: false, runtimeRecoveryPending: false, planPending: false }), 'ready');

assert.match(consolidatedReport, /审核生成中/);
assert.match(consolidatedReport, /结果仍可能增加或调整，完成后即可处理/);
assert.match(consolidatedReport, /disabled=\{!interactive \|\| isSubmitting\}/);
assert.match(consolidatedReport, /interactive \? `帮我修改 \$\{selectedCount\} 项` : availabilityLabel/);
assert.match(expertReportPanel, /已发现 \$\{report\.findings\.length\} 个问题/);
assert.match(expertReportPanel, /disabled=\{!interactive\}/);
assert.match(expertReportPanel, /disabled=\{!interactive \|\| isSubmitting \|\| Object\.keys\(decisions\)\.length === 0\}/);
assert.match(expertReportPanel, /报告已过期/);
assert.match(expertReportPanel, /审核未完成/);

assert.match(batchReview, /reviewComments\.unresolvedComments\.map\(\(comment\) => comment\.childIndex \?\? 0\)/);
assert.match(batchReview, /onRegenerate\(batch, earliestChildIndex, reviewComments\.unresolvedComments\)/);
assert.match(batchReview, /整批有 \$\{reviewComments\.pendingComments\.length\} 条审批意见待发送/);
assert.match(batchReview, /max-h-\[45%\] shrink-0 overflow-y-auto/);
assert.match(batchReview, /章节节拍[\s\S]*?grid-cols-1[\s\S]*?font-normal/);
assert.match(workspace, /`章节节拍预览 · v\$\{draftSelection\.outlineRevision\}`/);
assert.match(workspace, /draftSelection\?\.kind === 'draft_batch_interrupted'[\s\S]*?'章节生成未完成'/);
assert.match(workspace, /draftSelection\?\.kind === 'draft_batch_progress'[\s\S]*?`已生成内容 · \$\{selectedGeneratedCount\}\/\$\{selectedDraftBatch\?\.children\.length \?\? selectedGeneratedCount\}`[\s\S]*?'章节生成进度'/);
assert.match(workspace, /draftSelection\?\.kind === 'draft_batch_review'[\s\S]*?'多章节草稿审核'/);
assert.match(workspace, /<DraftBatchReviewPanel[\s\S]*?mode=\{draftSelection\?\.kind === 'draft_batch_progress'[\s\S]*?'progress'[\s\S]*?'interrupted'[\s\S]*?'review'\}/);
assert.doesNotMatch(workspace, /章节生成详情/);
assert.doesNotMatch(batchReview, /<h2\b/);
assert.doesNotMatch(chapterBeatPreview, /<h2\b/);
assert.match(batchReview, /const reviewInteractive = mode === 'review'/);
assert.match(batchReview, /disabled=\{!reviewInteractive \|\| selectedChild\?\.status !== 'draft' \|\| isMutating\}/);
assert.match(batchReview, /reviewInteractive && projection\.canCommit/);
assert.match(batchReview, /生成仍在继续，当前内容仅供只读查看/);
assert.match(batchReview, /const selectedHasDraft = Boolean\(selectedSession && chapterPayload\)/);
assert.match(batchReview, /selectedHasDraft && <div[\s\S]*?高亮差异[\s\S]*?完整原文[\s\S]*?完整草稿/);
assert.match(batchReview, /selectedChild\?\.error\?\.sideEffectUnknown \? reconciliationPane : selectedHasDraft \?/);
assert.match(batchReview, /只读预览 · 节拍确认在会话中完成/);
assert.match(batchReview, /需要确认时请在会话中的确认卡操作/);
assert.match(batchReview, /window\.db\.getChapter\(child\.targetChapterId\)/);
assert.match(batchReview, /restoreReadableTextStructure/);
assert.match(contextBuilder, /return extractReadableText\(content\)/);

assert.match(paragraphReview, /aria-label=\{`为第 \$\{paragraphIndex \+ 1\} 段添加审批意见`\}/);
assert.doesNotMatch(paragraphReview, /type="checkbox"/);
assert.doesNotMatch(reviewStore, /Review comments must belong to one review version/);

assert.match(diffView, /useTextDiff\(originalText, draftText\)/);
assert.match(diffView, /oldLine[\s\S]*?newLine/);
assert.match(diffView, /统一式[\s\S]*?双栏/);
assert.match(diffView, /getBoundingClientRect\(\)\.width >= 1000/);
assert.match(diffView, /展开 \{item\.hiddenCount\} 个未修改段落/);
assert.match(diffView, /审批意见定位已变化/);
assert.match(diffView, /diffVersion: TEXT_DIFF_VERSION/);
assert.match(diffHook, /WORKER_TIMEOUT_MS = 2_000/);
assert.match(diffHook, /new Worker\(new URL\('\.\.\/\.\.\/workers\/textDiff\.worker\.ts'/);
assert.match(diffHook, /event\.data\.requestId !== requestId/);
assert.match(diffHook, /computeCoarseTextDiff\(originalText, draftText, 'worker_timeout'\)/);
assert.match(diffWorker, /computeTextDiff\(originalText, draftText, options\)/);
assert.match(textDiff, /MAX_PAIRING_CELLS = 4_096/);
assert.match(textDiff, /LARGE_HUNK_BAND_RADIUS = 8/);
assert.match(textDiff, /granularity: 'grapheme'/);
assert.match(textDiff, /fallbackReason: TextDiffFallbackReason/);
assert.match(reviewCommentTypes, /diffVersion\?: number/);
assert.match(reviewCommentTypes, /side\?: 'old' \| 'new' \| 'both'/);

console.log('Review workflow renderer contract tests passed.');
