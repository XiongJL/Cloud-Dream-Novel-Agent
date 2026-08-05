import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('../src/components/AgentWorkspace/AgentWorkspace.tsx', import.meta.url), 'utf8');
const consolidatedReportCard = await readFile(new URL('../src/components/AgentWorkspace/ConsolidatedReportCard.tsx', import.meta.url), 'utf8');
const chapterBeatPreviewPanel = await readFile(new URL('../src/components/AgentWorkspace/ChapterBeatPreviewPanel.tsx', import.meta.url), 'utf8');
const draftBatchReviewPanel = await readFile(new URL('../src/components/AgentWorkspace/DraftBatchReviewPanel.tsx', import.meta.url), 'utf8');
const draftBatchProgressCard = await readFile(new URL('../src/components/AgentWorkspace/DraftBatchProgressCard.tsx', import.meta.url), 'utf8');
const draftBatchConversation = await readFile(new URL('../shared/agentDraftBatchConversation.ts', import.meta.url), 'utf8');
const assistantMarkdown = await readFile(new URL('../src/components/AssistantMarkdown/index.tsx', import.meta.url), 'utf8');
const aiService = await readFile(new URL('../electron/ai/AiService.ts', import.meta.url), 'utf8');
const contextCoordinator = await readFile(new URL('../electron/ai/context/AgentContextCompressionCoordinator.ts', import.meta.url), 'utf8');
const contextStateRefs = await readFile(new URL('../electron/ai/context/AgentContextStateRefs.ts', import.meta.url), 'utf8');
const aiErrors = await readFile(new URL('../electron/ai/errors.ts', import.meta.url), 'utf8');
const rendererTypes = await readFile(new URL('../src/vite-env.d.ts', import.meta.url), 'utf8');
const automationService = await readFile(new URL('../electron/automation/AutomationService.ts', import.meta.url), 'utf8');
const preload = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const main = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../../../agent_runtime/novel_agent_runtime/runtime.py', import.meta.url), 'utf8');
const runtimeClient = await readFile(new URL('../electron/agent/PythonRuntimeClient.ts', import.meta.url), 'utf8');

assert.match(preload, /ensureReady: \(\) => ipcRenderer\.invoke\('agent:ensure-ready'\)/);
assert.match(preload, /restart: \(\) => ipcRenderer\.invoke\('agent:restart'\)/);
assert.match(preload, /submitUserInput: \(payload: any\) => ipcRenderer\.invoke\('agent:invoke', \{ method: 'agent\.submit_user_input'/);
assert.match(preload, /dismissUserInput: \(payload: any\) => ipcRenderer\.invoke\('agent:invoke', \{ method: 'agent\.dismiss_user_input'/);
assert.match(preload, /retryChatSummary: \(payload: any, options\?[\s\S]*?invokeAgentWithStructuredError\('agent\.retry_chat_summary'/);
assert.match(preload, /recoverChat: \(payload: any, options\?[\s\S]*?invokeAgentWithStructuredError\('agent\.recover_chat'/);
assert.match(preload, /preserveErrorDetails: true/);
assert.match(main, /ipcMain\.handle\('agent:ensure-ready'/);
assert.match(main, /ipcMain\.handle\('agent:restart'/);
assert.match(main, /preserveErrorDetails[\s\S]*?__agentInvokeResult/);
assert.match(automationService, /case 'agent\.generate_chat':[\s\S]*?generateAgentChat\(params, signal\), true/);
assert.match(automationService, /autoRepair: async[\s\S]*?repairStructuredOutput/);
assert.match(aiService, /invocation\.autoRepair[\s\S]*?invocation\.autoRepairAttempted/);

const sendStart = workspace.indexOf('const sendChat = async (');
const sendEnd = workspace.indexOf('const submitApproval = async', sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, 'sendChat block should exist');
const sendChat = workspace.slice(sendStart, sendEnd);
const ensureIndex = sendChat.indexOf('await ensureRuntimeReady()');
const responseIndex = sendChat.indexOf('const response = recoveryOptions?.repair');
const appendIndex = sendChat.indexOf('appendMessage(');
const clearIndex = sendChat.indexOf('setComposerDrafts((current) => {', appendIndex);
const persistRequestIndex = sendChat.indexOf('await window.db.upsertAgentConversation(conversationForPersistence({');
assert.ok(ensureIndex >= 0, 'sendChat should ensure Runtime readiness');
assert.ok(responseIndex > ensureIndex, 'Agent chat should only start after Runtime recovery succeeds');
assert.ok(appendIndex > ensureIndex, 'user message must only be appended after Runtime recovery succeeds');
assert.ok(clearIndex > appendIndex && clearIndex < persistRequestIndex, 'the composer must clear after the user message enters the timeline and before persistence');
assert.ok(persistRequestIndex > appendIndex && persistRequestIndex < responseIndex, 'current user message must be persisted before Agent chat starts');
assert.match(sendChat.slice(persistRequestIndex, responseIndex), /composerDraft: messageOverride === undefined[\s\S]*?composerDraftsRef\.current\[conversationId\]/);
assert.match(sendChat.slice(ensureIndex, responseIndex), /if \(!runtime\.ok\)[\s\S]*?return;/);
assert.match(sendChat, /storageConversationId: conversationId/);
assert.match(sendChat, /messageId: userMessageId/);
assert.doesNotMatch(sendChat, /\bhistory:/);
assert.doesNotMatch(sendChat, /persistentSummary:/);
assert.doesNotMatch(sendChat, /contextSummary: response\.conversationSummary/);
assert.match(sendChat, /chapterScopeSnapshot/);
assert.match(sendChat, /deadlineAt/);
assert.match(sendChat, /editorSelection,/);
assert.match(sendChat, /chapterCatalog,/);
assert.match(sendChat, /buildAgentPlanGoal\(message, activeConversation\.messages\)/);
assert.doesNotMatch(sendChat, /history: activeConversation\.messages\.flatMap/);
assert.match(workspace, /function conversationForPersistence\(conversation: AgentConversation\)/);
assert.match(workspace, /const \{ contextSummary: _contextSummary, \.\.\.persistentConversation \} = conversation/);
assert.match(sendChat, /upsertAgentConversation\(conversationForPersistence\(\{/);

assert.match(main, /new AiService\(\(\) => app\.getPath\('userData'\), agentConversationStore\)/);
assert.match(main, /chcp\.com 65001/);
assert.match(runtimeClient, /PYTHONIOENCODING: 'utf-8'/);
assert.match(runtimeClient, /PYTHONUTF8: '1'/);
assert.match(aiService, /new AgentContextCompressionCoordinator\(contextCompressionStore, \(\) => this\.getProvider\(\)\)/);
assert.match(preload, /rebuildAgentContextSummary: \(storageConversationId: string\) => ipcRenderer\.invoke\([\s\S]*?'ai:rebuild-agent-context-summary'/);
assert.match(main, /ipcMain\.handle\('ai:rebuild-agent-context-summary'[\s\S]*?aiService\.rebuildAgentContextSummary\(storageConversationId\)/);
assert.match(aiService, /async rebuildAgentContextSummary\(storageConversationId: string\)/);
assert.match(workspace, /window\.ai\.rebuildAgentContextSummary\(conversationId\)/);
assert.match(workspace, /onRebuildContextSummary=\{rebuildContextSummary\}/);
assert.match(workspace, /quality rebuild|质量重建/);
assert.match(workspace, /const refreshFromStore = async \(\) => \{[\s\S]*?window\.db\.getAgentConversations\(novelId\)[\s\S]*?contextSummary: authoritative\.contextSummary \?\? null/);
assert.match(aiService, /if \(diagnostics\.wouldRetriggerNextTurn\) \{[\s\S]*?scheduleAgentContextPrecompression\(\{/);
assert.match(aiService, /currentRequest: \{ maintenanceAction: 'background_precompression' \}[\s\S]*?background: true/);
const generateAgentChatStart = aiService.indexOf('async generateAgentChat(');
const generateAgentChatEnd = aiService.indexOf('\n    async ', generateAgentChatStart + 1);
assert.ok(generateAgentChatStart >= 0 && generateAgentChatEnd > generateAgentChatStart, 'generateAgentChat block should exist');
const generateAgentChat = aiService.slice(generateAgentChatStart, generateAgentChatEnd);
assert.match(generateAgentChat, /readCompressionSnapshot\(storageConversationId\)/);
assert.match(generateAgentChat, /agentContextCompressionCoordinator\.prepare\(\{/);
assert.match(generateAgentChat, /const snapshot = coordinatorResult\.snapshot \|\| initialSnapshot/);
assert.match(generateAgentChat, /persistentSummary: authoritativeSummary/);
assert.match(generateAgentChat, /adaptOutputReserve\(\{/);
assert.match(generateAgentChat, /minimumDynamicCount\.contextTokens \+ AGENT_CHAT_DYNAMIC_CONTEXT_HEADROOM_TOKENS/);
assert.match(generateAgentChat, /outputReserveTokens: outputTokens/);
assert.match(generateAgentChat, /maxTokens: outputTokens/);
assert.match(generateAgentChat, /selectionRef: 'protectedContext\.selectionContext'/);
assert.match(generateAgentChat, /contextPath: 'protectedContext\.selectionContext'/);
assert.match(generateAgentChat, /chapter\.continuation 表示补写该已有章节/);
assert.match(generateAgentChat, /chapter\.create 表示以该章为锚点新建下一章/);
assert.match(generateAgentChat, /返回一个 inputRequest 让用户确认/);
assert.doesNotMatch(generateAgentChat, /payload\.history|payload\.persistentSummary/);
assert.doesNotMatch(generateAgentChat, /conversationSummary\s*:/);

const runtimeModelCallStart = runtime.indexOf('        async def model_call(graph_state: ExplorationState)');
const runtimeModelCallEnd = runtime.indexOf('        async def tool_call(', runtimeModelCallStart);
assert.ok(runtimeModelCallStart >= 0 && runtimeModelCallEnd > runtimeModelCallStart, 'Runtime model_call block should exist');
const runtimeModelCall = runtime.slice(runtimeModelCallStart, runtimeModelCallEnd);
assert.match(runtimeModelCall, /"storageConversationId": storage_conversation_id/);
assert.match(runtimeModelCall, /"messageId": str\(params\.get\("messageId"\) or ""\)/);
assert.doesNotMatch(runtimeModelCall, /"history"\s*:/);
assert.doesNotMatch(runtimeModelCall, /"persistentSummary"\s*:/);

assert.match(workspace, /kind: 'role_status'/);
assert.match(workspace, /kind: 'workflow_notice'/);
assert.match(workspace, /content: roleStatusContent\(role\)/);
assert.match(workspace, /chapterScopeSelectionFromPlan\(candidate\.plan\)/);
assert.match(workspace, /hydratedChapterScopeKeyRef/);
assert.match(workspace, /activeConversation\.chapterScope[\s\S]*?recovered\?\.scope/);
assert.match(workspace, /function ChatActivityCard\(/);
const chatActivityStart = workspace.indexOf('function ChatActivityCard(');
const chatActivityEnd = workspace.indexOf('function AttachmentViewer(', chatActivityStart);
const chatActivityCard = workspace.slice(chatActivityStart, chatActivityEnd);
assert.match(chatActivityCard, /const \[expanded, setExpanded\] = useState\(false\)/);
assert.match(chatActivityCard, /projectChatActivity\(activities, live\)/);
assert.match(chatActivityCard, /<ActivityStreamShell/);
assert.match(chatActivityCard, /<ActivityDetails/);
assert.match(chatActivityCard, /\{expanded && \(/);
assert.doesNotMatch(chatActivityCard, /<details|open=\{live\}/);
const messageBubbleStart = workspace.indexOf('function MessageBubble(');
const messageBubbleEnd = workspace.indexOf('function ChatActivityCard(', messageBubbleStart);
const messageBubble = workspace.slice(messageBubbleStart, messageBubbleEnd);
assert.doesNotMatch(messageBubble, /<ChatActivityCard/);
assert.match(messageBubble, /inferAgentConversationMessageKind\(message\) === 'chat'/);
assert.match(messageBubble, /<AssistantMarkdown[\s\S]*?variant="chat"[\s\S]*?ariaLabel="助手回复"/);
assert.match(messageBubble, /<div className="whitespace-pre-wrap">\{message\.content\}<\/div>/);
const timelineMessageStart = workspace.indexOf("if (entry.kind === 'message') {");
const timelineMessageEnd = workspace.indexOf('const timelineRun =', timelineMessageStart);
const timelineMessage = workspace.slice(timelineMessageStart, timelineMessageEnd);
assert.ok(timelineMessage.indexOf('<MessageBubble') < timelineMessage.indexOf('<ChatActivityCard'), 'assistant text should render before its activity stream');
assert.match(timelineMessage, /message\.role === 'assistant'/);
const timelineTaskStart = workspace.indexOf('const timelineRun =', timelineMessageEnd);
const timelineTaskEnd = workspace.indexOf("{activeUserInput?.phase === 'pre_plan'", timelineTaskStart);
const timelineTask = workspace.slice(timelineTaskStart, timelineTaskEnd);
const prePlanResolutionIndex = timelineTask.indexOf('prePlanResolutions.map');
const planCardInvocationIndex = timelineTask.indexOf('<PlanCard');
const executionResolutionIndex = timelineTask.indexOf('executionResolutions.map');
const activityStreamInvocationIndex = timelineTask.indexOf('<AgentActivityStream');
assert.ok(prePlanResolutionIndex >= 0 && prePlanResolutionIndex < planCardInvocationIndex, 'pre-plan decisions should render before their plan');
assert.ok(planCardInvocationIndex < executionResolutionIndex, 'execution decisions should render after the approved plan');
assert.ok(executionResolutionIndex < activityStreamInvocationIndex, 'submitted execution decisions should render before resumed task activity');
assert.doesNotMatch(timelineTask, /activeConversation\?\.userInputResolutions[\s\S]*?\.map/);
const activityShellStart = workspace.indexOf('function ActivityStreamShell(');
const activityShellEnd = workspace.indexOf('function ActivityDetails(', activityShellStart);
const activityShell = workspace.slice(activityShellStart, activityShellEnd);
assert.match(activityShell, /aria-controls=\{detailPanelId\}/);
const agentActivityStart = workspace.indexOf('function AgentActivityStream(');
const activityDetailRowStart = workspace.indexOf('function ActivityDetailRow(', agentActivityStart);
const agentActivityStream = workspace.slice(agentActivityStart, activityDetailRowStart);
assert.match(agentActivityStream, /<ActivityStreamShell/);
assert.match(agentActivityStream, /<ActivityDetails/);
const chatResponseIndex = sendChat.indexOf('const response = recoveryOptions?.repair');
const clearLiveActivityIndex = sendChat.indexOf('setLiveChatActivities((current) => current?.conversationId === conversationId ? null : current);', chatResponseIndex);
const shouldDraftPlanIndex = sendChat.indexOf('const shouldDraftPlan =', chatResponseIndex);
assert.ok(chatResponseIndex >= 0 && clearLiveActivityIndex > chatResponseIndex && clearLiveActivityIndex < shouldDraftPlanIndex, 'completed live activities should clear before planning starts');
assert.match(workspace, /仅重试总结/);
assert.match(workspace, /window\.agent\.retryChatSummary\(/);
assert.match(workspace, /window\.agent\.recoverChat\(/);
assert.match(workspace, /修复 JSON 并继续/);
assert.match(workspace, /recoveryRef/);
assert.doesNotMatch(workspace, /modelResultRef/);
assert.match(workspace, /activities: response\.activities/);

const createPlanStart = workspace.indexOf('const createPlan = useCallback(');
const createPlanEnd = workspace.indexOf('const beginRetryRun = useCallback', createPlanStart);
assert.ok(createPlanStart >= 0 && createPlanEnd > createPlanStart, 'createPlan block should exist');
const createPlan = workspace.slice(createPlanStart, createPlanEnd);
assert.doesNotMatch(createPlan, /window\.agent\.executePlan\(/, 'creating a plan must not start it automatically');
assert.match(createPlan, /已生成计划草稿：[\s\S]*?选择“实施此计划”/);
const submitPlanRevisionStart = workspace.indexOf('const submitPlanRevision = useCallback(');
const submitPlanRevisionEnd = workspace.indexOf('useEffect(() => {', submitPlanRevisionStart);
assert.ok(submitPlanRevisionStart >= 0 && submitPlanRevisionEnd > submitPlanRevisionStart, 'submitPlanRevision block should exist');
const submitPlanRevision = workspace.slice(submitPlanRevisionStart, submitPlanRevisionEnd);
assert.match(submitPlanRevision, /window\.agent\.revisePlan\(/);
assert.doesNotMatch(submitPlanRevision, /window\.agent\.executePlan\(/, 'revising a plan must not start it automatically');
assert.match(aiService, /if \(currentEditorContent && toolObservations\.length === 0\)/);

const createChapterDraftStart = automationService.indexOf('async createChapterDraftSession(');
const createChapterDraftEnd = automationService.indexOf("const sourceOperationId", createChapterDraftStart);
const createChapterDraftValidation = automationService.slice(createChapterDraftStart, createChapterDraftEnd);
assert.match(createChapterDraftValidation, /payload\?\.mode === 'new_chapter'/);
assert.match(createChapterDraftValidation, /typeof payload\.currentContent !== 'string'/);
assert.match(createChapterDraftValidation, /assertRequiredString\(payload\?\.currentContent, 'currentContent'\)/);

const planCardStart = workspace.indexOf('function PlanCard({');
const planCardEnd = workspace.indexOf('function AgentActivityStream(', planCardStart);
assert.ok(planCardStart >= 0 && planCardEnd > planCardStart, 'PlanCard block should exist');
const planCard = workspace.slice(planCardStart, planCardEnd);
assert.match(planCard, /const \[isRevising, setIsRevising\] = useState\(false\)/);
assert.match(planCard, /const \[isContextExpanded, setIsContextExpanded\] = useState\(false\)/);
assert.match(planCard, /isContextExpanded \? '收起会话背景' : '查看会话背景'/);
assert.match(planCard, /\{isContextExpanded && \(/);
assert.doesNotMatch(planCard, /planDecision|aria-pressed/);
assert.match(planCard, /<AgentDecisionCard[\s\S]*?title="实施此计划？"/);
assert.match(planCard, /label: '是，实施此计划', recommended: true/);
assert.match(planCard, /customLabel="否，并告诉我如何做得不同"/);
assert.match(planCard, /onSelect=\{executePlan\}/);
assert.match(planCard, /onDismiss=\{ignorePlan\}/);
assert.match(planCard, /onCustomSubmit=\{submitRevision\}/);
assert.match(planCard, /onSkip=\{ignorePlan\}/);

const decisionCardStart = workspace.indexOf('function AgentDecisionCard({');
assert.ok(decisionCardStart >= 0 && decisionCardStart < planCardStart, 'shared AgentDecisionCard should exist');
const decisionCard = workspace.slice(decisionCardStart, planCardStart);
assert.match(decisionCard, /rounded-2xl border p-2\.5/);
assert.match(decisionCard, /min-h-11[\s\S]*?h-8 w-8/);
assert.match(decisionCard, /aria-label="关闭问题"/);
assert.match(decisionCard, /event\.key === 'Escape'/);
assert.match(decisionCard, /event\.key === 'Enter' && \(event\.ctrlKey \|\| event\.metaKey\)/);
assert.match(decisionCard, /customActive \? onCustomSubmit\(\) : onSkip\(\)/);

const userInputStart = workspace.indexOf('function UserInputRequiredCard({');
const userInputEnd = workspace.indexOf('function UserInputResolutionCard(', userInputStart);
assert.ok(userInputStart >= 0 && userInputEnd > userInputStart, 'multi-question user input card should exist');
const userInputCard = workspace.slice(userInputStart, userInputEnd);
assert.doesNotMatch(userInputCard, /question\.options\[0\]\?\.optionId/);
assert.match(userInputCard, /<AgentDecisionCard/);
assert.match(userInputCard, /customActionLabel=\{isLast \? \(isWorking \? '提交中' : '提交'\) : '下一步'\}/);
assert.match(userInputCard, /answerKind: 'skipped'/);
assert.match(userInputCard, /if \(isLast\) \{[\s\S]*?nextAnswer\.answerKind !== 'custom'[\s\S]*?submitCompleteAnswers\(nextAnswers\)/);
assert.ok(
    userInputCard.indexOf("nextAnswer.answerKind !== 'custom'") < userInputCard.indexOf('submitCompleteAnswers(nextAnswers)'),
    'the final custom answer should stay visible while its submission is pending',
);
assert.match(userInputCard, /onPrevious=/);
assert.match(userInputCard, /onDismiss=\{onDismiss\}/);
assert.match(workspace, /window\.agent\.submitUserInput\(/);
assert.match(workspace, /window\.agent\.dismissUserInput\(/);
assert.match(workspace, /AI 理解：\{resolution\.understandingSummary\}/);
assert.match(rendererTypes, /round: 1 \| 2 \| 3/);
assert.match(rendererTypes, /maxRounds: 1 \| 2 \| 3/);
assert.match(aiService, /decisionHistory\?: Array<Record<string, unknown>>/);
assert.match(aiService, /DecisionHistory=\$\{JSON\.stringify\(decisionHistory\)/);
assert.match(runtime, /"decisionHistory": decision_history/);
assert.match(runtime, /max_rounds=\([\s\S]*?operation\.type == "novel\.bootstrap"/);
assert.doesNotMatch(runtime, /def _build_novel_bootstrap_follow_up_request/);
const userInputResolutionStart = userInputEnd;
const userInputResolutionEnd = workspace.indexOf('function ApprovalRequiredCard(', userInputResolutionStart);
assert.ok(userInputResolutionEnd > userInputResolutionStart, 'submitted user input card should exist');
const userInputResolutionCard = workspace.slice(userInputResolutionStart, userInputResolutionEnd);
assert.match(userInputResolutionCard, /item\.answerKind === 'custom'\) return item\.customText/);
assert.match(userInputResolutionCard, /visibleAnswerPreview/);
assert.match(userInputResolutionCard, /已提交 \$\{resolution\.answers\.length\} 个决定 · 第 \$\{resolution\.round \?\? 1\} 轮/);

assert.match(consolidatedReportCard, /const report = useMemo\(\(\) => getExpertReport\(artifact\), \[artifact\]\)/);
assert.match(workspace, /const reportReviewAvailability = resolveReportReviewAvailability\(\{[\s\S]*?runtimeRecoveryPending: isRuntimeRecoveryPending/);
const consolidatedInvocationStart = workspace.indexOf('<ConsolidatedReportCard');
const consolidatedInvocationEnd = workspace.indexOf('/>', consolidatedInvocationStart);
assert.ok(consolidatedInvocationStart >= 0 && consolidatedInvocationEnd > consolidatedInvocationStart, 'ConsolidatedReportCard invocation should exist');
const consolidatedInvocation = workspace.slice(consolidatedInvocationStart, consolidatedInvocationEnd);
assert.match(consolidatedInvocation, /reviewAvailability=\{reportReviewAvailability\}/);
assert.doesNotMatch(consolidatedInvocation, /interactive=\{/);
assert.match(workspace, /const runs = \(conversation\.runs \?\? \[\]\)\.map\(\(item\) => updateRun\(item\) \?\? item\)/);

const revisionProgressStart = workspace.indexOf('function RevisionProgressCard({');
const revisionProgressEnd = workspace.indexOf('type AgentDecisionOption = {', revisionProgressStart);
assert.ok(revisionProgressStart >= 0 && revisionProgressEnd > revisionProgressStart, 'RevisionProgressCard block should exist');
const revisionProgressCard = workspace.slice(revisionProgressStart, revisionProgressEnd);
assert.match(revisionProgressCard, /\{plan\.revisionItems\.length\} 项建议批量修订/);
assert.match(revisionProgressCard, /const suggestionStatus = run\?\.status === 'completed'/);
assert.match(revisionProgressCard, /pendingChapterBeatApproval/);
assert.match(revisionProgressCard, /待确认 · \$\{pendingChapterBeatCount\} 章节拍/);
assert.match(revisionProgressCard, /正文尚未生成，确认章节拍后开始批量修订/);
assert.match(revisionProgressCard, /重试失败步骤/);
assert.match(revisionProgressCard, /onClick=\{onRetry\}/);
assert.doesNotMatch(revisionProgressCard, /progressRatio|itemIndex/);
assert.match(workspace, /onRetry=\{\(\) => \{ if \(timelineRun\) void retryFailedRun\(timelineRun\); \}\}/);

assert.match(workspace, /Runtime 响应较慢/);
assert.match(workspace, /正在恢复 Runtime/);
assert.match(workspace, /Runtime 不可用/);
assert.match(workspace, /title="重试 Runtime"/);
assert.match(workspace, /setInput\(initialGoal\)[\s\S]*?Runtime 不可用，请重试后发送/);

const artifactPanelStart = workspace.indexOf('function ArtifactPanel({');
const artifactPanelEnd = workspace.indexOf('function RoleSkillPanel(', artifactPanelStart);
assert.ok(artifactPanelStart >= 0 && artifactPanelEnd > artifactPanelStart, 'ArtifactPanel block should exist');
const artifactPanel = workspace.slice(artifactPanelStart, artifactPanelEnd);
assert.match(workspace, /class ArtifactPanelErrorBoundary extends Component/);
assert.match(workspace, /产物查看器暂时无法显示这份内容/);
assert.match(artifactPanel, /preferredArtifact\(artifacts, preferredRunId\)/);
assert.match(artifactPanel, /artifact\.type === 'report' \? '最终交付'/);
assert.match(artifactPanel, /分析明细（\{expertReport\.findings\.length\}）/);
assert.match(artifactPanel, /查看原始分析/);
assert.match(artifactPanel, /<AssistantMarkdown/);
assert.match(artifactPanel, /variant="document"/);
assert.doesNotMatch(artifactPanel, /max-h-64/);

assert.match(assistantMarkdown, /variant: 'chat' \| 'document'/);
assert.match(assistantMarkdown, /editable: false/);
assert.match(assistantMarkdown, /\$convertFromMarkdownString\(content, TRANSFORMERS, root\)/);
assert.match(assistantMarkdown, /HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode/);
assert.match(assistantMarkdown, /renderFailed/);
assert.match(assistantMarkdown, /whitespace-pre-wrap/);
assert.match(assistantMarkdown, /window\.electron\.openExternal\(href\)/);
assert.doesNotMatch(assistantMarkdown, /ToolbarPlugin|HistoryPlugin|OnChangePlugin|dangerouslySetInnerHTML/);
assert.match(preload, /openExternal: \(url: string\) => ipcRenderer\.invoke\('app:open-external', url\)/);
assert.match(main, /ipcMain\.handle\('app:open-external'/);
assert.match(main, /url\.protocol !== 'http:' && url\.protocol !== 'https:'/);
assert.match(main, /shell\.openExternal\(url\.toString\(\)\)/);

assert.match(workspace, /aria-label=\{t\('agentWorkspace\.inspector\.resize'\)\}/);
assert.match(workspace, /setPointerCapture/);
assert.match(workspace, /INSPECTOR_ARTIFACT_WIDTH = 640/);
assert.match(workspace, /inspectorLayoutStorageKey/);
assert.match(workspace, /aria-label=\{expanded[\s\S]*?t\('agentWorkspace\.inspector\.restoreSidebar'\)[\s\S]*?: t\('agentWorkspace\.inspector\.enlarge'\)\}/);
assert.match(workspace, /\{!expanded && \([\s\S]*?aria-label=\{t\('agentWorkspace\.inspector\.resize'\)\}/);
assert.doesNotMatch(workspace, /isDraftReview && !expanded && 'absolute inset-y-0 right-0/);
assert.match(workspace, /!followsLatest && !inspectorExpanded && !draftReviewInspectorVisible/);
assert.match(workspace, /\{!inspectorVisible && \([\s\S]*?aria-label=\{t\('agentWorkspace\.inspector\.open'\)\}[\s\S]*?<PanelRightOpen/);
assert.doesNotMatch(workspace, /aria-label=\{inspectorOpen \? '收起 Inspector' : '打开 Inspector'\}/);

const approvalCardStart = workspace.indexOf('function ApprovalRequiredCard({');
const approvalCardEnd = workspace.indexOf('function DraftCard(', approvalCardStart);
assert.ok(approvalCardStart >= 0 && approvalCardEnd > approvalCardStart, 'ApprovalRequiredCard block should exist');
const approvalCard = workspace.slice(approvalCardStart, approvalCardEnd);
assert.match(approvalCard, /title=\{approval\.title \|\| '需要你确认'\}/);
assert.match(approvalCard, /context=\{approvalContext\}/);
assert.doesNotMatch(approvalCard, /title=\{approval\.question/);

assert.doesNotMatch(workspace, /function ChapterBeatConfirmationCard\(/);
assert.doesNotMatch(workspace, /function ChapterBeatRunTimeline\(/);
assert.doesNotMatch(workspace, /function DraftBatchCard\(/);
assert.match(workspace, /activeApproval\.checkpointType !== 'chapter_beats'/);
assert.match(workspace, /projectChapterBeatTimeline\(timelineRun\)/);
assert.equal((workspace.match(/<DraftBatchProgressCard/g) ?? []).length, 1, 'the timeline should render one unified batch card');
assert.match(workspace, /projectDraftBatchConversationState\(\{[\s\S]*?run: timelineRun,[\s\S]*?batch: draftBatchRecord,[\s\S]*?chapterBeatTimeline/);
assert.match(workspace, /key=\{draftBatchConversationState\.stableKey\}/);
assert.match(workspace, /timelineRun\?\.pendingApproval\?\.draftBatchId[\s\S]*?latestChapterBeatCheckpoint/);
assert.match(workspace, /window\.automation\.invoke\('draft\.batch\.get', \{ draftBatchId \}, 'desktop-ui'\)/);
assert.match(workspace, /draftOperationVersion \|\| 0/);
assert.match(workspace, /window\.setInterval\([\s\S]*?activeIds[\s\S]*?1500/);
assert.match(workspace, /onDraftBatchLoaded=\{rememberDraftBatch\}/);

assert.match(draftBatchProgressCard, /const \[expanded, setExpanded\] = useState\(draft\?\.expanded \?\? Boolean\(activeCheckpoint\)\)/);
assert.match(draftBatchProgressCard, /确认并生成/);
assert.match(draftBatchProgressCard, /maxLength=\{4000\}/);
assert.match(draftBatchProgressCard, /aria-label="节拍调整意见"/);
assert.equal((draftBatchProgressCard.match(/查看章节拍/g) ?? []).length, 1, 'the card should expose one current beat view action');
assert.equal((draftBatchProgressCard.match(/onClick=\{openPrimaryView\}/g) ?? []).length, 1, 'the card header should own the single primary view action');
assert.match(draftBatchProgressCard, /const \[historyExpanded, setHistoryExpanded\] = useState\(false\)/);
assert.match(draftBatchProgressCard, /节拍记录（\{state\.beatHistory\.length\}）/);
assert.match(draftBatchProgressCard, /查看 v\{snapshot\.outlineRevision\} 节拍/);
assert.match(draftBatchProgressCard, /修订建议（\{revisionItems\.length\}）/);
assert.match(draftBatchProgressCard, /活动详情/);
assert.doesNotMatch(draftBatchProgressCard, /\{draftBatchId\}/);
assert.doesNotMatch(draftBatchProgressCard, /font-mono/);

assert.match(draftBatchConversation, /export type DraftInspectorSelection[\s\S]*?kind: 'chapter_beat_snapshot'[\s\S]*?kind: 'draft_batch_progress' \| 'draft_batch_interrupted' \| 'draft_batch_review'/);
assert.match(draftBatchConversation, /stableKey: `draft-batch:\$\{run\.runId\}:\$\{effectiveDraftBatchId/);
assert.match(draftBatchConversation, /new Set\(batch\.children\.flatMap/);
assert.doesNotMatch(draftBatchConversation, /draft_created/);
assert.match(workspace, /setDraftInspectorSelection\(\{[\s\S]*?kind: 'chapter_beat_snapshot'/);
assert.match(workspace, /setDraftInspectorSelection\(\{ kind, runId, draftBatchId \}\)/);
assert.doesNotMatch(workspace, /beatPreviewSelection|setBeatPreviewSelection|preserveBeatPreview/);
assert.match(draftBatchReviewPanel, /\['outline_draft', 'ready_to_generate', 'generating'\]\.includes\(batch\.status\)/);
assert.match(draftBatchReviewPanel, /window\.setInterval\([\s\S]*?loadBatch\(\)[\s\S]*?1500/);
assert.match(draftBatchReviewPanel, /onBatchLoaded\?\.\(nextBatch\)/);
assert.match(chapterBeatPreviewPanel, /historical \? ' · 历史版本' : ''/);
assert.match(chapterBeatPreviewPanel, /只读预览 · 节拍确认和调整在会话中完成/);

assert.match(aiService, /scoreScale: 100/);
assert.match(aiService, /不得使用十分制/);
assert.match(aiService, /2–4 个最影响阅读体验的发现/);
assert.match(automationService, /const controller = new AbortController\(\)/);
assert.match(automationService, /controller\.abort\(createAutomationError\('UPSTREAM_TIMEOUT'/);
assert.match(automationService, /task\(controller\.signal\)/);

assert.match(aiService, /stateRefs: buildAgentContextStateRefs\(initialSnapshot\)/);
assert.match(contextStateRefs, /\['sourceMessageId', 'messageId'\]/);
assert.match(contextStateRefs, /record\.sourceMessageIds/);
assert.match(contextStateRefs, /addRef\('run_event', event\.eventId, 'closed', event\.payload\)/);
assert.match(contextStateRefs, /addRef\('artifact', artifact\.artifactId, 'closed', artifact\.reference, artifact\.metadata\)/);
for (const field of [
    'operationKind',
    'triggerReason',
    'currentRequestIdentityStatus',
    'currentRequestPayloadOccurrences',
    'preCompressionContextTokens',
    'postCompressionContextTokens',
    'preCompressionProviderInputTokens',
    'postCompressionProviderInputTokens',
    'hardTokenCountMethod',
    'hardTokenCountProfileId',
    'rebuildTaskId',
    'rebuildCompletedChunks',
    'rebuildMaxChunks',
    'rebuildElapsedMs',
    'rebuildMaxDurationMs',
    'statusCodes',
    'errorCode',
]) {
    assert.ok(contextCoordinator.includes(field), `Coordinator diagnostics should include ${field}`);
    assert.ok(aiService.includes(field), `AiService response should preserve ${field}`);
    assert.ok(rendererTypes.includes(field), `Renderer types should preserve ${field}`);
    assert.ok(workspace.includes(field), `Inspector should render ${field}`);
}
for (const field of [
    'coverageStartMessageId',
    'coverageEndMessageId',
    'blockingSequenceStart',
    'blockingSequenceEnd',
    'recentTailContextTokens',
    'recentTailUnitCount',
    'sourceIndexLedgerEntries',
    'semanticLedgerEntries',
    'transientLedgerEntries',
    'unprojectedSemanticMessageCount',
    'invalidatedSourceCount',
    'qualitySample',
]) {
    assert.ok(contextCoordinator.includes(field), `Coordinator diagnostics should include ${field}`);
    assert.ok(rendererTypes.includes(field), `Renderer types should preserve ${field}`);
    assert.ok(workspace.includes(field), `Inspector should render ${field}`);
}
for (const code of [
    'CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH',
    'CONTEXT_REBUILD_IN_PROGRESS',
    'CONTEXT_PRECOMPRESSION_IN_PROGRESS',
    'CONTEXT_COMPACTION_REBUILD_LIMIT',
    'CONTEXT_COMPACTION_CIRCUIT_OPEN',
]) {
    assert.ok(aiErrors.includes(code), `AiErrorCode should include ${code}`);
}

console.log('Agent Runtime Renderer contract tests passed.');
