import { Component, Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ErrorInfo, type ReactNode, type RefObject, type SetStateAction } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  Bot,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  CircleHelp,
  ClipboardList,
  FileDiff,
  FileText,
  ListChecks,
  Loader2,
  MessageSquare,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Save,
  RotateCcw,
  Play,
  Plus,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { Chapter, Novel, Volume } from '../../types';
import { shouldApplyRunSequence, shouldResubscribeRun } from '../../../shared/agentSseProtocol';
import {
  applyAgentRunEvent,
  getActiveRunApproval,
  getActiveRunUserInput,
  getRunRecoverySnapshot,
  projectChapterBeatTimeline,
} from '../../../shared/agentRunProjection';
import {
  projectDraftBatchConversationState,
  type ChapterBeatCheckpointSnapshot,
  type DraftInspectorSelection,
} from '../../../shared/agentDraftBatchConversation';
import {
  agentDateTimestamp,
  buildAgentConversationTimeline,
  mergeAgentRunHistory,
} from '../../../shared/agentConversationTimeline';
import { buildAgentPlanGoal, splitAgentPlanGoal } from '../../../shared/agentPlanGoal';
import {
    inferAgentConversationMessageKind,
  type AgentConversationMessageKind,
} from '../../../shared/agentConversationContext';
import {
  projectAgentActivity,
  projectChatActivity,
  type ActivityDetail,
} from '../../../shared/agentActivityProjection';
import { appendPlainTextToLexical, extractReadableText } from '../../../shared/lexicalDocument';
import {
  chapterScopePayload,
  chapterScopeSelectionFromPlan,
  createDefaultChapterScope,
  isChapterScopeSelectionValid,
  normalizeChapterScopeSelection,
  type AgentChapterScopeSelection,
} from '../../../shared/agentChapterScopeSelection';
import { ChapterScopeSelector } from './ChapterScopeSelector';
import { ConsolidatedReportCard } from './ConsolidatedReportCard';
import { DraftBatchReviewPanel } from './DraftBatchReviewPanel';
import { ChapterBeatPreviewPanel } from './ChapterBeatPreviewPanel';
import {
  DraftBatchProgressCard,
  type DraftBatchProgressCardDraft,
} from './DraftBatchProgressCard';
import { DraftDiffView } from './DraftDiffView';
import { DraftMoreMenu } from './DraftMoreMenu';
import { useReviewComments } from './DraftReviewComments';
import { ReviewSubmitDialog } from './ReviewSubmitDialog';
import { CreativeAssetsReviewPanel } from './CreativeAssetsReviewPanel';
import AssistantMarkdown from '../AssistantMarkdown';
import { ExpertReportPanel } from './ExpertReportPanel';
import { RevisionTaskWorkspace } from './RevisionTaskWorkspace';
import {
  resolveReportReviewAvailability,
  type ReportReviewAvailability,
} from './reportReviewAvailability';
import type {
  AgentRevisionTask,
  ArtifactReviewSubmitResult,
  RevisionTaskSyncRunInput,
} from '../../../shared/expertReport';
import { getExpertReport, selectConsolidatedReportArtifact } from '../../../shared/agentExpertReportProjection';
import type { DraftBatchRecord } from '../../../shared/draftBatch';
import { resolveDraftBatchChapterDisplay } from '../../../shared/draftBatchChapterLabel';
import type { ReviewCommentRecord } from '../../../shared/reviewComments';
import type { AgentAttachmentContent, AgentAttachmentRecord } from '../../../shared/agentAttachment';
import { formatReviewCommentsForConversation } from '../../../shared/reviewComments';
import {
  pendingAgentStatusLabel,
  type AgentPendingPhase,
  type AgentPendingStatus,
} from '../../../shared/agentPendingStatus';
import { resolveAgentComposerAction } from '../../../shared/agentComposerAction';
import {
  agentSkillEntryHint,
  agentSkillShortcutSeed,
  buildAgentSkillMenuItems,
  findAgentSkillSlashQuery,
  removeAgentSkillSlashQuery,
  shouldOpenAgentSkillSlashMenu,
  type AgentSkillComposerMode,
  type AgentSkillMenuItem,
  type AgentSkillSlashQuery,
} from '../../../shared/agentSkillComposer';
import { formatAiErrorFromUnknown } from '../../utils/aiError';
import {
  agentConversationAttentionKind,
  projectAgentWorkspaceAttention,
  type AgentWorkspaceAttentionSummary,
} from '../../../shared/agentWorkspaceAttention';
import { AgentSkillSlashMenu } from './AgentSkillSlashMenu';

export type AgentEditorContentSnapshot = {
  novelId: string;
  chapterId: string | null;
  content: string;
  capturedAt: string;
};

export type AgentChapterContext = Pick<Chapter, 'id' | 'title' | 'volumeId' | 'wordCount'>;

type Props = {
  novel: Novel | null;
  novelId: string;
  currentChapter: AgentChapterContext | null;
  getCurrentContentSnapshot: () => AgentEditorContentSnapshot;
  locale: string;
  theme: 'dark' | 'light';
  isVisible: boolean;
  isFullScreen: boolean;
  attentionRequestId: number;
  attentionTargetConversationId: string | null;
  onAttentionChange: (summary: AgentWorkspaceAttentionSummary) => void;
  initialGoal?: string;
  onInitialGoalConsumed: () => void;
};

type AgentRoleMode = 'team' | 'writer' | 'editor' | 'reader' | 'worldbuilding' | 'research_rag';
type InspectorTab = 'context' | 'artifacts' | 'review' | 'evidence' | 'roles';
type ApprovalMode = 'review_required' | 'chat_only' | 'full_control';
type WorkspaceView = 'conversation' | 'revision_tasks';
type UserInputCardDraft = {
  questionIndex: number;
  answers: Record<string, AgentUserInputAnswer>;
  customQuestionId: string | null;
  customDrafts: Record<string, string>;
};
type ApprovalCardDraft = {
  customActive: boolean;
  freeText: string;
};
type ChapterBeatCardDraft = DraftBatchProgressCardDraft;
type RevisionBatchItem = {
  findingId: string;
  title: string;
  summary: string;
  chapterIds: string[];
};
type RevisionBatchPlan = AgentPlan & {
  interactionMode: 'revision_batch';
  revisionItems: RevisionBatchItem[];
  sourceArtifactId: string;
  sourceConversationId: string;
};
type RoleOption = {
  id: AgentRoleMode;
  label: string;
  desc: string;
  tools: string[];
  skills: string[];
  presets: AgentPresetTask[];
};

type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  kind?: AgentConversationMessageKind;
  contextReads?: Array<{ toolName: string; status: 'completed' | 'failed'; message?: string }>;
  contextDiagnostics?: AgentContextDiagnostics;
  attachmentIds?: string[];
  chapterScopeSnapshot?: AgentChapterScopeSelection;
  activities?: AgentChatActivityEvent[];
  failure?: AgentChatFailure;
  evidenceSnapshotId?: string;
};

const CONTEXT_COMPRESSION_MESSAGE_KIND = 'agent_context_compression_v1';

function inspectorVisibilityStorageKey(novelId: string): string {
  return `novel_editor_agent_inspector_open:${novelId}`;
}

const INSPECTOR_DEFAULT_WIDTH = 360;
const INSPECTOR_ARTIFACT_WIDTH = 640;

function inspectorLayoutStorageKey(novelId: string): string {
  return `novel_editor_agent_inspector_layout:${novelId}`;
}

function activeConversationStorageKey(novelId: string): string {
  return `novel_editor_agent_active_conversation:${novelId}`;
}

function readActiveConversationId(novelId: string): string | null {
  try {
    return localStorage.getItem(activeConversationStorageKey(novelId));
  } catch {
    return null;
  }
}

function readInspectorLayout(novelId: string): { width: number; manuallyResized: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(inspectorLayoutStorageKey(novelId)) || '{}') as Record<string, unknown>;
    const width = typeof value.width === 'number' && Number.isFinite(value.width)
      ? Math.min(900, Math.max(INSPECTOR_DEFAULT_WIDTH, Math.round(value.width)))
      : INSPECTOR_DEFAULT_WIDTH;
    return { width, manuallyResized: value.manuallyResized === true };
  } catch {
    return { width: INSPECTOR_DEFAULT_WIDTH, manuallyResized: false };
  }
}

function readInspectorVisibilityPreference(novelId: string): boolean | null {
  try {
    const value = localStorage.getItem(inspectorVisibilityStorageKey(novelId));
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function requestedChapterCount(message: string): 2 | 3 | null {
  if (/(?:这|那|前|后|选中|当前|连续|相邻)?(?<!第)(?:三|3)\s*(?:个)?章/.test(message)) return 3;
  if (/(?:这|那|前|后|选中|当前|连续|相邻)?(?<!第)(?:两|二|2)\s*(?:个)?章/.test(message)) return 2;
  return null;
}

function isRevisionBatchPlan(plan: AgentPlan): plan is RevisionBatchPlan {
  const candidate = plan as Partial<RevisionBatchPlan>;
  return candidate.interactionMode === 'revision_batch' && Array.isArray(candidate.revisionItems);
}

function hasRevisionBatchSource(plan: RevisionBatchPlan): boolean {
  return typeof plan.sourceArtifactId === 'string'
    && plan.sourceArtifactId.length > 0
    && typeof plan.sourceConversationId === 'string'
    && plan.sourceConversationId.length > 0;
}

function hasCommittedRevisionDraft(run: AgentRun): boolean {
  const draftArtifacts = (run.artifacts ?? []).filter((artifact) => (
    artifact.type === 'chapter_draft'
    || artifact.type === 'chapter_draft_batch'
    || artifact.type === 'creative_assets_draft'
  ));
  return draftArtifacts.length > 0 && draftArtifacts.every((artifact) => artifact.status === 'committed');
}

const RUNTIME_PHASE_LABELS: Record<NonNullable<AgentHealthResult['data']>['phase'] & string, string> = {
  idle: '准备 Runtime',
  starting_python: '启动 Python Runtime',
  loading_modules: '加载 Agent 模块',
  loading_web_server: '加载本地服务框架',
  loading_graph_engine: '加载任务图引擎',
  loading_tool_protocol: '加载工具协议',
  loading_runtime: '加载 Agent Runtime',
  initializing_state: '初始化本地状态',
  loading_tools: '加载工具链',
  restoring_state: '恢复任务状态',
  starting_server: '启动 Runtime 服务',
  ready: 'Runtime 可用',
  failed: 'Runtime 不可用',
};

function runtimeHealthPresentation(health: AgentHealthResult | null): {
  text: string;
  tone: 'loading' | 'ready' | 'slow' | 'failed';
} {
  const availability = health?.data?.availability;
  if (availability === 'slow') return { text: 'Runtime 响应较慢', tone: 'slow' };
  if (availability === 'recovering') return { text: '正在恢复 Runtime', tone: 'loading' };
  if (availability === 'failed') return { text: 'Runtime 不可用', tone: 'failed' };
  if (availability === 'ready' || health?.ok) return { text: 'Runtime 可用', tone: 'ready' };
  const phase = health?.data?.phase;
  if (phase === 'failed' || health?.code === 'AGENT_RUNTIME_UNAVAILABLE') {
    return { text: 'Runtime 不可用', tone: 'failed' };
  }
  const label = phase ? RUNTIME_PHASE_LABELS[phase] : '连接 Runtime';
  const elapsedMs = Number(health?.data?.elapsedMs || 0);
  const elapsed = elapsedMs >= 1000 ? ` · ${Math.floor(elapsedMs / 1000)}s` : '';
  return { text: `${label}${elapsed}`, tone: 'loading' };
}

function serializeContextCompression(compression: AgentContextCompression): string {
  return JSON.stringify({ kind: CONTEXT_COMPRESSION_MESSAGE_KIND, compression });
}

function parseContextCompression(message: ConversationMessage): AgentContextCompression | null {
  if (message.role !== 'system') return null;
  try {
    const parsed = JSON.parse(message.content) as { kind?: unknown; compression?: unknown };
    if (parsed.kind !== CONTEXT_COMPRESSION_MESSAGE_KIND || !parsed.compression || typeof parsed.compression !== 'object') return null;
    const compression = parsed.compression as AgentContextCompression;
    const numericFields = [
      compression.contextWindowTokens,
      compression.inputBudgetTokens,
      compression.estimatedInputTokens,
      compression.historyMessagesTotal,
      compression.historyMessagesKept,
      compression.historyMessagesSummarized,
      compression.historyMessagesOmitted,
      compression.historyMessagesCompacted,
    ];
    if (compression.applied !== true || typeof compression.model !== 'string' || !numericFields.every(Number.isFinite)) return null;
    return {
      ...compression,
      mode: ['none', 'projection', 'micro', 'semantic', 'degraded'].includes(compression.mode)
        ? compression.mode
        : 'micro',
      persistentSummaryRevision: Number.isFinite(compression.persistentSummaryRevision) ? compression.persistentSummaryRevision : 0,
      persistentSummaryMessageCount: Number.isFinite(compression.persistentSummaryMessageCount) ? compression.persistentSummaryMessageCount : 0,
      recalledMessageCount: Number.isFinite(compression.recalledMessageCount) ? compression.recalledMessageCount : 0,
      recalledArtifactCount: Number.isFinite(compression.recalledArtifactCount) ? compression.recalledArtifactCount : 0,
      compressedSectionIds: Array.isArray(compression.compressedSectionIds) ? compression.compressedSectionIds : [],
      omittedSectionIds: Array.isArray(compression.omittedSectionIds) ? compression.omittedSectionIds : [],
    };
  } catch {
    return null;
  }
}

function normalizeContextDiagnostics(value: unknown): AgentContextDiagnostics | null {
  if (!value || typeof value !== 'object') return null;
  const diagnostics = value as AgentContextDiagnostics;
  const numericFields = [
    diagnostics.contextWindowTokens,
    diagnostics.outputTokens,
    diagnostics.safetyTokens,
    diagnostics.systemTokens,
    diagnostics.inputBudgetTokens,
    diagnostics.estimatedInputTokens,
    diagnostics.historyMessagesTotal,
    diagnostics.historyMessagesKept,
    diagnostics.historyMessagesSummarized,
    diagnostics.historyMessagesOmitted,
    diagnostics.historyMessagesCompacted,
    diagnostics.persistentConstraintsCount,
  ];
  if (!['agent-context-v1', 'agent-context-v2'].includes(diagnostics.contextVersion)
    || typeof diagnostics.model !== 'string'
    || !numericFields.every(Number.isFinite)) return null;
  return {
    ...diagnostics,
    compressionApplied: diagnostics.compressionApplied === true,
    currentRequestCompressed: diagnostics.currentRequestCompressed === true,
    currentRequestMode: diagnostics.currentRequestMode === 'compressed' ? 'compressed' : 'raw',
    historySources: Array.isArray(diagnostics.historySources) ? diagnostics.historySources : [],
    sectionSources: Array.isArray(diagnostics.sectionSources) ? diagnostics.sectionSources : [],
    compressedSectionIds: Array.isArray(diagnostics.compressedSectionIds) ? diagnostics.compressedSectionIds : [],
    omittedSectionIds: Array.isArray(diagnostics.omittedSectionIds) ? diagnostics.omittedSectionIds : [],
    persistentSummaryRevision: Number.isFinite(diagnostics.persistentSummaryRevision) ? diagnostics.persistentSummaryRevision : 0,
    persistentSummaryMessageCount: Number.isFinite(diagnostics.persistentSummaryMessageCount) ? diagnostics.persistentSummaryMessageCount : 0,
    recalledMessageIds: Array.isArray(diagnostics.recalledMessageIds) ? diagnostics.recalledMessageIds : [],
    recalledArtifactIds: Array.isArray(diagnostics.recalledArtifactIds) ? diagnostics.recalledArtifactIds : [],
    warnings: Array.isArray(diagnostics.warnings) ? diagnostics.warnings : [],
  };
}

type AgentConversation = {
  id: string;
  novelId: string;
  title: string;
  description: string;
  role: AgentRoleMode;
  runtimeConversationId: string | null;
  updatedAt: string;
  chapterScope?: AgentChapterScopeSelection | null;
  messages: ConversationMessage[];
  suggestedGoal: string | null;
  plan: AgentPlan | null;
  run: AgentRun | null;
  runs?: AgentRun[];
  contextSummary?: AgentConversationSummary | AgentConversationSummaryV2 | null;
  pendingUserInput?: AgentUserInputRequest | null;
  userInputResolutions?: AgentUserInputResolution[];
  composerDraft?: string;
  attentionAcknowledgedRunId?: string | null;
  error: string;
};

function conversationForPersistence(conversation: AgentConversation): Omit<AgentConversation, 'contextSummary'> {
  const { contextSummary: _contextSummary, ...persistentConversation } = conversation;
  return persistentConversation;
}

const ROLE_OPTIONS: RoleOption[] = [
  { id: 'team', label: '团队', desc: '统筹多个专家完成复杂任务', tools: ['chapter.get', 'rag.ask', 'chapter.generate_draft'], skills: ['任务拆解', '多角色协同', '结果汇总'], presets: [{ id: 'team-project-audit', label: '项目全局审计', description: '检查情节、角色、设定与章节的一致性。', goal: '读取当前项目资料，进行全局一致性审计，按严重程度列出问题、证据和修改建议。', deliverable: 'report' }] },
  { id: 'writer', label: '作者', desc: '正文续写、改写和场景扩展', tools: ['chapter.get', 'chapter.generate_draft'], skills: ['章节续写', '场景改写', '风格保持'], presets: [{ id: 'writer-continue-chapter', label: '续写当前章节', description: '基于已有正文和设定生成可审核草稿。', goal: '读取当前章节、相关情节、角色和设定，续写当前章节并生成可审核的正文草稿。', deliverable: 'chapter_draft' }] },
  { id: 'editor', label: '编辑', desc: '结构、节奏、逻辑和文字审校', tools: ['chapter.get', 'rag.ask'], skills: ['节奏质检', '一致性检查', '结构建议'], presets: [{ id: 'editor-chapter-audit', label: '章节质量审校', description: '输出按优先级排序的问题与修改建议。', goal: '读取当前章节和必要上下文，从结构、节奏、人物动机、设定一致性和文字表达五方面审校，列出证据与修改建议。', deliverable: 'report' }] },
  { id: 'reader', label: '读者', desc: '理解、情绪和追更动力评估', tools: ['chapter.get', 'rag.ask'], skills: ['读者盲测', '弃读风险', '追更欲望'], presets: [{ id: 'reader-blind-test', label: '读者盲测', description: '按真实阅读顺序反馈困惑与情绪变化。', goal: '以首次阅读者视角阅读当前章节，按阅读顺序记录理解障碍、情绪变化、有效悬念和出戏点。', deliverable: 'report' }] },
  { id: 'worldbuilding', label: '世界观', desc: '维护世界规则、角色和空间设定', tools: ['character.list', 'worldsetting.list', 'rag.ask'], skills: ['设定一致性', '术语校验', '关系梳理'], presets: [{ id: 'worldbuilding-consistency', label: '设定一致性检查', description: '核对正文与现有世界规则。', goal: '读取当前章节及世界观、角色、物品和地图资料，检查设定冲突、遗漏规则和需要补充说明之处。', deliverable: 'report' }] },
  { id: 'research_rag', label: '考据', desc: '检索资料并整理可追溯证据', tools: ['rag.ask', 'search.query'], skills: ['证据整理', '引用来源', '事实核对'], presets: [{ id: 'research-fact-check', label: '事实核对', description: '检查正文中的可验证陈述。', goal: '读取当前章节，识别需要核验的现实事实或专业细节，检索证据并逐项给出结论和来源。', deliverable: 'report' }] },
];

const AGENT_ROLE_IDS = new Set<AgentRoleMode>(ROLE_OPTIONS.map((role) => role.id));

function normalizeRoleOptions(roles: AgentRoleDefinition[]): RoleOption[] {
  const normalized = roles
    .filter((role) => AGENT_ROLE_IDS.has(role.id as AgentRoleMode))
    .map((role) => ({
      id: role.id as AgentRoleMode,
      label: role.label,
      desc: role.description,
      tools: Array.isArray(role.tools) ? role.tools : [],
      skills: Array.isArray(role.skills) ? role.skills : [],
      presets: Array.isArray(role.presets) ? role.presets : [],
    }));
  return normalized.length === ROLE_OPTIONS.length ? normalized : ROLE_OPTIONS;
}

const APPROVAL_OPTIONS: Array<{ id: ApprovalMode; label: string; desc: string; disabled?: boolean }> = [
  { id: 'full_control', label: '自动工作', desc: '自动读取、分析并生成可回退草稿；正式写回仍需确认。' },
  { id: 'review_required', label: '逐步审核', desc: '生成前展示计划，并保留创作方向和章节拍确认。' },
  { id: 'chat_only', label: '只讨论不执行', desc: '保留交流和建议，不生成计划或调用工具。' },
];

function createSeedConversations(novelId: string, currentChapter?: AgentChapterContext | null): AgentConversation[] {
  const chapterTitle = currentChapter?.title || '当前章';
  const seedId = (kind: 'conv' | 'msg', name: string) => `${novelId}:${kind}:${name}`;
  const defaultScope = createDefaultChapterScope(currentChapter?.id, currentChapter?.volumeId);
  const conversations: AgentConversation[] = [
    {
      id: seedId('conv', 'current-chapter-review'),
      novelId,
      title: `${chapterTitle}节奏质检`,
      description: '检查当前章节节奏、钩子和追更欲望',
      role: 'team',
      runtimeConversationId: null,
      updatedAt: new Date().toISOString(),
      suggestedGoal: null,
      plan: null,
      run: null,
      error: '',
      messages: [
        {
          id: seedId('msg', 'welcome'),
          role: 'assistant',
          kind: 'workflow_notice',
          content: '你可以直接讨论创作问题。当前工作模式为“自动工作”：我会按需读取项目并生成可回退草稿；正式写回前仍由你确认。',
          createdAt: new Date().toISOString(),
        },
      ],
    },
  {
    id: seedId('conv', 'outline'),
    novelId,
    title: '大纲设计',
    description: '长线结构、卷纲、章节推进',
    role: 'writer',
    runtimeConversationId: null,
    updatedAt: minutesAgo(24 * 60),
    suggestedGoal: null,
    plan: null,
    run: null,
    error: '',
    messages: [
      {
        id: seedId('msg', 'outline'),
        role: 'assistant',
        kind: 'workflow_notice',
        content: '这里适合讨论卷纲、章节目标和情节推进。当前版本先保留为本地会话占位。',
        createdAt: new Date().toISOString(),
      },
    ],
  },
  {
    id: seedId('conv', 'character'),
    novelId,
    title: '主角人设重构',
    description: '动机、关系、成长弧线',
    role: 'editor',
    runtimeConversationId: null,
    updatedAt: minutesAgo(2 * 24 * 60),
    suggestedGoal: null,
    plan: null,
    run: null,
    error: '',
    messages: [
      {
        id: seedId('msg', 'character'),
        role: 'assistant',
        kind: 'workflow_notice',
        content: '这里可以沉淀角色讨论记录，后续会接入真实历史会话。',
        createdAt: new Date().toISOString(),
      },
    ],
  },
  {
    id: seedId('conv', 'world'),
    novelId,
    title: '世界观规则整理',
    description: '设定一致性、术语、地图与物品',
    role: 'worldbuilding',
    runtimeConversationId: null,
    updatedAt: minutesAgo(3 * 24 * 60),
    suggestedGoal: null,
    plan: null,
    run: null,
    error: '',
    messages: [
      {
        id: seedId('msg', 'world'),
        role: 'assistant',
        kind: 'workflow_notice',
        content: '世界观会话用于约束设定和术语，避免跨章节冲突。',
        createdAt: new Date().toISOString(),
      },
    ],
  },
  {
    id: seedId('conv', 'reader'),
    novelId,
    title: '读者反馈模拟',
    description: '读者困惑、期待和弃读风险',
    role: 'reader',
    runtimeConversationId: null,
    updatedAt: minutesAgo(7 * 24 * 60),
    suggestedGoal: null,
    plan: null,
    run: null,
    error: '',
    messages: [
      {
        id: seedId('msg', 'reader'),
        role: 'assistant',
        kind: 'workflow_notice',
        content: '读者模式适合模拟普通读者的理解成本、情绪反馈和追读动力。',
        createdAt: new Date().toISOString(),
      },
    ],
  },
  ];
  return conversations.map((conversation) => ({
    ...conversation,
    chapterScope: { ...defaultScope, chapterIds: [...defaultScope.chapterIds], experts: [...defaultScope.experts] },
  }));
}

function toErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error || '');
  if (rawMessage.includes('CHAPTER_TARGET_UNRESOLVED')) {
    return '暂时无法确定目标章节。章节目录或上一步解析结果可能尚未就绪，请点击“重新生成计划草稿”继续。';
  }
  const timeout = rawMessage.match(/HTTP request timeout after (\d+)ms/i);
  if (timeout) {
    return `模型响应超时（${Math.round(Number(timeout[1]) / 1000)} 秒）。本次消息未生成回复，请重试。`;
  }
  return formatAiErrorFromUnknown(error, undefined, '请求处理失败，请重试。');
}

function isChapterTargetUnresolvedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  return code === 'CHAPTER_TARGET_UNRESOLVED'
    || message.includes('CHAPTER_TARGET_UNRESOLVED')
    || message.includes('暂时无法确定目标章节');
}

function isCancelledError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'CANCELLED') return true;
  return /cancelled|canceled|已取消/i.test(error instanceof Error ? error.message : String(error || ''));
}

function chatFailureFromError(error: unknown): AgentChatFailure {
  const record = error && typeof error === 'object' ? error as { code?: unknown; details?: unknown } : {};
  const details = record.details && typeof record.details === 'object' && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : {};
  const code = String(record.code || details.code || 'UNKNOWN');
  const recoveryRef = typeof details.recoveryRef === 'string' ? details.recoveryRef.trim() : '';
  const recovery: AgentChatRecoveryDescriptor | undefined = code === 'MODEL_OUTPUT_INVALID' && recoveryRef
    ? {
      recoveryRef,
      recoveryAction: 'repair_model_output',
    }
    : undefined;
  return {
    code,
    message: toErrorMessage(error),
    retryable: true,
    ...(recovery ? { recovery } : {}),
  };
}

function nowId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function formatConversationTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value || '刚刚';
  const diffMinutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} 天前`;
  return new Date(time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function getConversationPreview(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 28);
}

function buildConversationTitle(message: string, role: AgentRoleMode): string {
  const preview = getConversationPreview(message);
  if (!preview) return `${roleLabel(role)}新会话`;
  return preview.length >= 28 ? `${preview}...` : preview;
}

function buildConversationDescription(message: string, role: AgentRoleMode): string {
  const preview = getConversationPreview(message);
  return preview ? `${roleLabel(role)}模式 · ${preview}` : `${roleLabel(role)}模式 · 新的小说创作讨论`;
}

function isStarterConversation(conversation: AgentConversation): boolean {
  return conversation.title.endsWith('新会话') && conversation.messages.filter((message) => message.role === 'user').length === 0;
}

function roleLabel(role: AgentRoleMode): string {
  return ROLE_OPTIONS.find((item) => item.id === role)?.label ?? role;
}

function roleStatusContent(role: AgentRoleMode): string {
  return `当前角色：${roleLabel(role)}。后续响应与工具链将按此角色执行。`;
}

function eventSummary(event: AgentRunEvent): string {
  const payload = event.payload ?? {};
  if (typeof payload.summary === 'string') return payload.summary;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.content === 'string') return payload.content;
  if (event.toolName) return event.toolName;
  return event.type;
}

function getActiveApproval(run: AgentRun | null): AgentApprovalRequest | null {
  return getActiveRunApproval(run) as AgentApprovalRequest | null;
}

function getActiveUserInput(run: AgentRun | null): AgentUserInputRequest | null {
  return getActiveRunUserInput(run) as AgentUserInputRequest | null;
}

function isTerminalRun(run: AgentRun | null): boolean {
  return Boolean(run && ['completed', 'failed', 'cancelled'].includes(run.status));
}

function withCurrentRun(conversation: AgentConversation, run: AgentRun): AgentConversation {
  return {
    ...conversation,
    run,
    runs: mergeAgentRunHistory(conversation.runs, run),
  };
}

function AgentWorkspace({
  novel,
  novelId,
  currentChapter,
  getCurrentContentSnapshot,
  locale,
  theme,
  isVisible,
  isFullScreen,
  attentionRequestId,
  attentionTargetConversationId,
  onAttentionChange,
  initialGoal,
  onInitialGoalConsumed,
}: Props) {
  const { t } = useTranslation();
  const isDark = theme === 'dark';
  const initialConversations = useMemo(
    () => createSeedConversations(novelId, currentChapter),
    [currentChapter, novelId],
  );
  const [conversationSearch, setConversationSearch] = useState('');
  const [selectedRole, setSelectedRole] = useState<AgentRoleMode>('team');
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>(ROLE_OPTIONS);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('full_control');
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [chapterScope, setChapterScope] = useState<AgentChapterScopeSelection>(() => (
    createDefaultChapterScope(currentChapter?.id, currentChapter?.volumeId)
  ));
  const [aiSettings, setAiSettings] = useState<AISettings | null>(null);
  const [modelDraft, setModelDraft] = useState('');
  const [isModelSaving, setIsModelSaving] = useState(false);
  const [modelError, setModelError] = useState('');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('context');
  const [reviewTarget, setReviewTarget] = useState<'draft' | 'report'>('report');
  const [selectedReviewRunId, setSelectedReviewRunId] = useState<string | null>(null);
  const [draftInspectorSelection, setDraftInspectorSelection] = useState<DraftInspectorSelection | null>(null);
  const [draftBatchRecords, setDraftBatchRecords] = useState<Record<string, DraftBatchRecord>>({});
  const draftBatchRecordsRef = useRef<Record<string, DraftBatchRecord>>({});
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('conversation');
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(false);
  // null means the user has not chosen yet, so fullscreen supplies the default.
  const inspectorVisibilityPreferenceRef = useRef<boolean | null>(readInspectorVisibilityPreference(novelId));
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(() => inspectorVisibilityPreferenceRef.current ?? isFullScreen);
  const [inspectorOpen, setInspectorOpen] = useState(() => inspectorVisibilityPreferenceRef.current ?? isFullScreen);
  const [inspectorWidth, setInspectorWidth] = useState(() => readInspectorLayout(novelId).width);
  const [inspectorManuallyResized, setInspectorManuallyResized] = useState(() => readInspectorLayout(novelId).manuallyResized);
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [activeConversationId, setActiveConversationId] = useState(
    () => readActiveConversationId(novelId) ?? initialConversations[0]?.id ?? 'conv-current-chapter-review',
  );
  const [conversations, setConversations] = useState<AgentConversation[]>(initialConversations);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>(() => (
    Object.fromEntries(initialConversations.map((conversation) => [conversation.id, conversation.composerDraft ?? '']))
  ));
  const [agentSkills, setAgentSkills] = useState<AgentSkillIndexEntry[]>([]);
  const [agentSkillModes, setAgentSkillModes] = useState<Record<string, AgentSkillComposerMode | undefined>>({});
  const [dismissedSkillSlashQuery, setDismissedSkillSlashQuery] = useState<AgentSkillSlashQuery | null>(null);
  const [activeSkillMenuIndex, setActiveSkillMenuIndex] = useState(0);
  const [userInputCardDrafts, setUserInputCardDrafts] = useState<Record<string, UserInputCardDraft>>({});
  const [approvalCardDrafts, setApprovalCardDrafts] = useState<Record<string, ApprovalCardDraft>>({});
  const [chapterBeatCardDrafts, setChapterBeatCardDrafts] = useState<Record<string, ChapterBeatCardDraft>>({});
  const [isConversationsLoading, setIsConversationsLoading] = useState(true);
  const [health, setHealth] = useState<AgentHealthResult | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [contextSummaryRebuildConversationId, setContextSummaryRebuildConversationId] = useState<string | null>(null);
  const [isRuntimeRecoveryPending, setIsRuntimeRecoveryPending] = useState(false);
  const [pendingRevisionBatch, setPendingRevisionBatch] = useState<{ conversationId: string; plan: RevisionBatchPlan } | null>(null);
  const [revisionTaskCount, setRevisionTaskCount] = useState(0);
  const [revisionTaskRefreshKey, setRevisionTaskRefreshKey] = useState(0);
  const [pendingAgentStatus, setPendingAgentStatus] = useState<AgentPendingStatus | null>(null);
  const [liveChatActivities, setLiveChatActivities] = useState<{ conversationId: string; events: AgentChatActivityEvent[] } | null>(null);
  const [activeChatRequestId, setActiveChatRequestId] = useState<string | null>(null);
  const [stoppingChatRequestId, setStoppingChatRequestId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AgentAttachmentRecord[]>([]);
  const [isAddingAttachment, setIsAddingAttachment] = useState(false);
  const [viewingAttachment, setViewingAttachment] = useState<AgentAttachmentContent | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const disconnectRecoveryRunIdsRef = useRef(new Set<string>());
  const runtimeRecoveryRequestRef = useRef<Promise<AgentHealthResult> | null>(null);
  const sendInFlightRef = useRef(false);
  const activeChatRequestRef = useRef<{ requestId: string; conversationId: string; cancelled: boolean } | null>(null);
  const liveChatActivitiesRef = useRef<typeof liveChatActivities>(null);
  const subscribedRunIdRef = useRef<string | null>(null);
  const backgroundSubscribedRunIdsRef = useRef(new Set<string>());
  const runSubscriptionGenerationRef = useRef(0);
  const lastSequenceRef = useRef(0);
  const lastSequenceByRunRef = useRef(new Map<string, number>());
  const queuedRunEventsRef = useRef<AgentRunEvent[]>([]);
  const runEventFlushTimerRef = useRef<number | null>(null);
  const consumedInitialGoalRef = useRef<string | null>(null);
  const conversationsLoadedRef = useRef(false);
  const loadedConversationNovelIdRef = useRef<string | null>(null);
  const composerDraftsRef = useRef(composerDrafts);
  const persistedComposerDraftsRef = useRef<Record<string, string>>({});
  const lastAttentionRequestIdRef = useRef(0);
  const wasVisibleRef = useRef(false);
  const hydratedChapterScopeKeyRef = useRef<string | null>(null);
  const conversationsRef = useRef<AgentConversation[]>(initialConversations);
  const revisionSyncInFlightRef = useRef(new Set<string>());
  const revisionSyncCompletedRef = useRef(new Set<string>());
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const conversationScrollStateRef = useRef(new Map<string, { scrollTop: number; followsLatest: boolean }>());
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const followsLatestRef = useRef(true);
  const [followsLatest, setFollowsLatest] = useState(true);
  const input = composerDrafts[activeConversationId] ?? '';
  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setComposerDrafts((current) => {
      const previous = current[activeConversationId] ?? '';
      const value = typeof next === 'function' ? next(previous) : next;
      if (value === previous) return current;
      const updated = { ...current, [activeConversationId]: value };
      composerDraftsRef.current = updated;
      return updated;
    });
  }, [activeConversationId]);
  const activeAgentSkillMode = agentSkillModes[activeConversationId];
  const agentSkillSlashQuery = useMemo(
    () => findAgentSkillSlashQuery(input),
    [activeConversationId, input],
  );
  const agentSkillMenuItems = useMemo(
    () => buildAgentSkillMenuItems(agentSkills, agentSkillSlashQuery?.query ?? ''),
    [agentSkillSlashQuery?.query, agentSkills],
  );
  const agentSkillMenuOpen = Boolean(
    shouldOpenAgentSkillSlashMenu(agentSkillSlashQuery, dismissedSkillSlashQuery)
    && !isWorking
    && !isRuntimeRecoveryPending,
  );

  useEffect(() => {
    setActiveSkillMenuIndex(0);
  }, [activeConversationId, agentSkillSlashQuery?.query]);

  const selectAgentSkillMenuItem = useCallback((item: AgentSkillMenuItem) => {
    if (!agentSkillSlashQuery) return;
    const withoutSlash = removeAgentSkillSlashQuery(input, agentSkillSlashQuery);
    const shortcutSeed = item.kind === 'skill'
      ? agentSkillShortcutSeed(item.skill.id)
      : item.kind === 'author'
        ? '创建一个 Skill：'
        : '';
    const nextInput = withoutSlash.trim() || !shortcutSeed ? withoutSlash : shortcutSeed;
    setInput(nextInput);
    setAgentSkillModes((current) => ({
      ...current,
      [activeConversationId]: item.kind === 'none'
        ? { kind: 'skill.none' }
        : item.kind === 'author'
          ? { kind: 'skill.author' }
          : { kind: 'skill.use', skill: item.skill },
    }));
    setDismissedSkillSlashQuery(null);
    window.setTimeout(() => {
      const inputNode = chatInputRef.current;
      if (!inputNode) return;
      inputNode.focus();
      const cursor = shortcutSeed && !withoutSlash.trim()
        ? nextInput.length
        : Math.min(agentSkillSlashQuery.start, nextInput.length);
      inputNode.setSelectionRange(cursor, cursor);
    }, 0);
  }, [activeConversationId, agentSkillSlashQuery, input, setInput]);

  const clearActiveAgentSkillMode = useCallback(() => {
    setAgentSkillModes((current) => ({ ...current, [activeConversationId]: undefined }));
    chatInputRef.current?.focus();
  }, [activeConversationId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    composerDraftsRef.current = composerDrafts;
  }, [composerDrafts]);

  const flushComposerDrafts = useCallback(async (drafts = composerDraftsRef.current) => {
    const changed = Object.entries(drafts).filter(([conversationId, draft]) => (
      persistedComposerDraftsRef.current[conversationId] !== draft
    ));
    if (changed.length === 0) return;
    await Promise.all(changed.map(async ([conversationId, composerDraft]) => {
      await window.db.updateAgentConversationDraft({ conversationId, composerDraft });
      if (composerDraftsRef.current[conversationId] === composerDraft) {
        persistedComposerDraftsRef.current[conversationId] = composerDraft;
      }
    }));
  }, []);

  useEffect(() => {
    const flushBeforeUnload = () => {
      void flushComposerDrafts().catch((error) => {
        console.warn('[AgentWorkspace] Failed to flush composer drafts:', error);
      });
    };
    window.addEventListener('beforeunload', flushBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', flushBeforeUnload);
      flushBeforeUnload();
    };
  }, [flushComposerDrafts, novelId]);

  useEffect(() => {
    try {
      localStorage.setItem(activeConversationStorageKey(novelId), activeConversationId);
    } catch (error) {
      console.warn('[AgentWorkspace] Failed to persist active conversation:', error);
    }
  }, [activeConversationId, novelId]);

  useEffect(() => {
    if (isVisible) return;
    setRoleMenuOpen(false);
    setApprovalMenuOpen(false);
    setModelMenuOpen(false);
    setScopeMenuOpen(false);
    setConversationDrawerOpen(false);
    setInspectorDrawerOpen(false);
    setViewingAttachment(null);
    setDraftInspectorSelection(null);
    setInspectorExpanded(false);
  }, [isVisible]);

  useEffect(() => {
    setDraftInspectorSelection(null);
  }, [activeConversationId]);

  useEffect(() => {
    const preference = readInspectorVisibilityPreference(novelId);
    inspectorVisibilityPreferenceRef.current = preference;
    const open = preference ?? isFullScreen;
    const layout = readInspectorLayout(novelId);
    setInspectorOpen(open);
    setInspectorDrawerOpen(open);
    setInspectorWidth(layout.width);
    setInspectorManuallyResized(layout.manuallyResized);
    setInspectorExpanded(false);
  }, [novelId]);

  useEffect(() => {
    if (inspectorVisibilityPreferenceRef.current !== null) return;
    setInspectorOpen(isFullScreen);
    setInspectorDrawerOpen(isFullScreen);
    if (!isFullScreen) setInspectorExpanded(false);
  }, [isFullScreen, novelId]);

  useEffect(() => {
    if (!isVisible) return undefined;
    setViewportWidth(window.innerWidth);
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isVisible]);

  const setInspectorVisibility = useCallback((open: boolean) => {
    inspectorVisibilityPreferenceRef.current = open;
    setInspectorOpen(open);
    setInspectorDrawerOpen(open);
    try {
      localStorage.setItem(inspectorVisibilityStorageKey(novelId), String(open));
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }, [novelId]);

  const closeInspector = useCallback(() => {
    setInspectorExpanded(false);
    setInspectorVisibility(false);
  }, [setInspectorVisibility]);

  const openInspector = useCallback((tab: InspectorTab, target?: 'draft' | 'report', runId?: string) => {
    setDraftInspectorSelection(null);
    if (target) setReviewTarget(target);
    if (tab === 'review' || tab === 'artifacts') setSelectedReviewRunId(runId ?? null);
    setInspectorTab(tab);
    if (!inspectorManuallyResized) {
      setInspectorWidth(tab === 'artifacts' || tab === 'review' ? INSPECTOR_ARTIFACT_WIDTH : INSPECTOR_DEFAULT_WIDTH);
    }
    setConversationDrawerOpen(false);
    setInspectorVisibility(true);
  }, [inspectorManuallyResized, setInspectorVisibility]);

  const openBeatSnapshot = useCallback((
    runId: string,
    snapshot: ChapterBeatCheckpointSnapshot,
    historical: boolean,
  ) => {
    setDraftInspectorSelection({
      kind: 'chapter_beat_snapshot',
      runId,
      checkpointId: snapshot.checkpointId,
      draftBatchId: snapshot.draftBatchId,
      outlineRevision: snapshot.outlineRevision,
      beats: snapshot.beats,
      historical,
      statusLabel: snapshot.statusLabel,
    });
    setReviewTarget('draft');
    setSelectedReviewRunId(runId);
    setInspectorTab('review');
    if (!inspectorManuallyResized) setInspectorWidth(INSPECTOR_ARTIFACT_WIDTH);
    setConversationDrawerOpen(false);
    setInspectorVisibility(true);
  }, [inspectorManuallyResized, setInspectorVisibility]);

  const openDraftBatchInspector = useCallback((
    runId: string,
    draftBatchId: string,
    kind: Exclude<DraftInspectorSelection['kind'], 'chapter_beat_snapshot'>,
  ) => {
    setDraftInspectorSelection({ kind, runId, draftBatchId });
    setReviewTarget('draft');
    setSelectedReviewRunId(runId);
    setInspectorTab('review');
    if (!inspectorManuallyResized) setInspectorWidth(INSPECTOR_ARTIFACT_WIDTH);
    setConversationDrawerOpen(false);
    setInspectorVisibility(true);
  }, [inspectorManuallyResized, setInspectorVisibility]);

  const persistInspectorLayout = useCallback((width: number, manuallyResized: boolean) => {
    try {
      localStorage.setItem(inspectorLayoutStorageKey(novelId), JSON.stringify({ width, manuallyResized }));
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }, [novelId]);

  const beginInspectorResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (inspectorExpanded || window.innerWidth < 1040) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const leftRailWidth = window.innerWidth > 1180 ? 300 : 0;
    const maxWidth = Math.max(
      INSPECTOR_DEFAULT_WIDTH,
      Math.min(900, Math.floor(window.innerWidth * 0.65), window.innerWidth - leftRailWidth - 420),
    );
    let nextWidth = startWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onPointerMove = (moveEvent: PointerEvent) => {
      nextWidth = Math.min(maxWidth, Math.max(INSPECTOR_DEFAULT_WIDTH, Math.round(startWidth + startX - moveEvent.clientX)));
      setInspectorWidth(nextWidth);
    };
    const finishResize = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', finishResize);
      document.removeEventListener('pointercancel', finishResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setInspectorManuallyResized(true);
      persistInspectorLayout(nextWidth, true);
    };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', finishResize, { once: true });
    document.addEventListener('pointercancel', finishResize, { once: true });
  }, [inspectorExpanded, inspectorWidth, persistInspectorLayout]);

  const resetInspectorWidth = useCallback(() => {
    const width = inspectorTab === 'artifacts' || inspectorTab === 'review'
      ? INSPECTOR_ARTIFACT_WIDTH
      : INSPECTOR_DEFAULT_WIDTH;
    setInspectorWidth(width);
    setInspectorManuallyResized(false);
    persistInspectorLayout(width, false);
  }, [inspectorTab, persistInspectorLayout]);

  const selectInspectorTab = useCallback((tab: InspectorTab) => {
    setInspectorTab(tab);
    if (!inspectorManuallyResized) {
      setInspectorWidth(tab === 'artifacts' || tab === 'review' ? INSPECTOR_ARTIFACT_WIDTH : INSPECTOR_DEFAULT_WIDTH);
    }
  }, [inspectorManuallyResized]);

  useEffect(() => {
    if (!isVisible) return undefined;
    let cancelled = false;
    void window.db.getVolumes(novelId).then((nextVolumes) => {
      if (cancelled) return;
      const orderedVolumes = [...nextVolumes]
        .sort((a, b) => a.order - b.order)
        .map((volume) => ({ ...volume, chapters: [...volume.chapters].sort((a, b) => a.order - b.order) }));
      const orderedChapterIds = orderedVolumes.flatMap((volume) => volume.chapters.map((chapter) => chapter.id));
      setVolumes(orderedVolumes);
      setChapterScope((current) => normalizeChapterScopeSelection(
        current,
        orderedChapterIds,
        currentChapter?.id,
        currentChapter?.volumeId,
      ));
    }).catch((error) => {
      console.warn('[AgentWorkspace] Failed to load chapter scope tree:', error);
      if (!cancelled) setVolumes([]);
    });
    return () => {
      cancelled = true;
    };
  }, [currentChapter?.id, currentChapter?.volumeId, novelId]);

  useEffect(() => {
    if (chapterScope.kind !== 'current_chapter') return;
    const nextScope: AgentChapterScopeSelection = {
      ...chapterScope,
      volumeId: currentChapter?.volumeId,
      chapterIds: currentChapter?.id ? [currentChapter.id] : [],
      anchorChapterId: currentChapter?.id,
    };
    setChapterScope(nextScope);
    setConversations((current) => current.map((conversation) => (
      conversation.id === activeConversationId
        ? { ...conversation, chapterScope: nextScope, updatedAt: new Date().toISOString() }
        : conversation
    )));
  }, [activeConversationId, chapterScope.kind, currentChapter?.id, currentChapter?.volumeId]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0],
    [activeConversationId, conversations],
  );
  const pendingAttachments = useMemo(
    () => attachments.filter((attachment) => !attachment.messageId),
    [attachments],
  );

  useEffect(() => {
    const conversationId = activeConversation?.id;
    if (!conversationId) {
      setAttachments([]);
      return;
    }
    let cancelled = false;
    void window.agentAttachments.list({ novelId, conversationId })
      .then((records) => {
        if (!cancelled) setAttachments(records);
      })
      .catch((error) => {
        console.warn('[AgentWorkspace] Failed to load attachments:', error);
        if (!cancelled) setAttachments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversation?.id, novelId]);

  const addAttachment = useCallback(async () => {
    if (!activeConversation || isAddingAttachment || isWorking) return;
    if (pendingAttachments.length >= 5) {
      toast.error('单次最多添加 5 个附件。');
      return;
    }
    setIsAddingAttachment(true);
    try {
      await window.db.upsertAgentConversation(conversationForPersistence(activeConversation));
      const attachment = await window.agentAttachments.select({
        novelId,
        conversationId: activeConversation.id,
      });
      if (attachment) {
        setAttachments((current) => [...current.filter((item) => item.id !== attachment.id), attachment]);
      }
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setIsAddingAttachment(false);
    }
  }, [activeConversation, isAddingAttachment, isWorking, novelId, pendingAttachments.length]);

  const removePendingAttachment = useCallback(async (attachmentId: string) => {
    if (!activeConversation) return;
    try {
      await window.agentAttachments.removePending({ novelId, conversationId: activeConversation.id, attachmentId });
      setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }, [activeConversation, novelId]);

  const openAttachment = useCallback(async (attachmentId: string) => {
    if (!activeConversation) return;
    try {
      const content = await window.agentAttachments.get({ novelId, conversationId: activeConversation.id, attachmentId });
      setViewingAttachment(content);
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }, [activeConversation, novelId]);

  useEffect(() => {
    setSelectedReviewRunId(null);
  }, [activeConversation?.id]);

  const filteredConversations = useMemo(() => {
    const keyword = conversationSearch.trim().toLowerCase();
    if (!keyword) return conversations;
    return conversations.filter((conversation) => (
      conversation.title.toLowerCase().includes(keyword)
      || conversation.description.toLowerCase().includes(keyword)
      || roleLabel(conversation.role).toLowerCase().includes(keyword)
    ));
  }, [conversationSearch, conversations]);

  const activePlan = activeConversation?.plan ?? null;
  const activeRun = activeConversation?.run ?? null;
  const composerAction = resolveAgentComposerAction({
    activeChatRequestId,
    stoppingChatRequestId,
    runStatus: activeRun?.status,
    draftOperationStatus: activeRun?.draftOperationStatus,
  });
  const composerTaskActive = composerAction.mode !== 'send';
  const conversationRuns = useMemo(() => (
    activeRun
      ? mergeAgentRunHistory(activeConversation?.runs, activeRun)
      : activeConversation?.runs ?? []
  ), [activeConversation?.runs, activeRun]);
  const selectedReviewRun = selectedReviewRunId
    ? conversationRuns.find((run) => run.runId === selectedReviewRunId) ?? activeRun
    : activeRun;
  const activeApproval = getActiveApproval(activeRun);
  const activeUserInput = activeConversation?.pendingUserInput ?? getActiveUserInput(activeRun);
  const activeError = activeConversation?.error ?? '';
  const recoverablePlanGoal = useMemo(() => {
    if (activeConversation?.suggestedGoal) return activeConversation.suggestedGoal;
    if (!activeConversation || !isChapterTargetUnresolvedError(activeError) || activePlan) return null;
    for (let index = activeConversation.messages.length - 1; index >= 0; index -= 1) {
      const message = activeConversation.messages[index];
      if (message.role !== 'user' || !message.content.trim()) continue;
      return buildAgentPlanGoal(message.content, activeConversation.messages.slice(0, index));
    }
    return null;
  }, [activeConversation, activeError, activePlan]);
  const recoverableChatMessage = useMemo(() => {
    if (!activeConversation || !activeError || recoverablePlanGoal || activeRun) return null;
    for (let index = activeConversation.messages.length - 1; index >= 0; index -= 1) {
      const message = activeConversation.messages[index];
      if (message.role !== 'user' || !message.content.trim()) continue;
      if (message.failure) return message;
      if (activePlan) return null;
      const hasAssistantResponse = activeConversation.messages.slice(index + 1).some((item) => (
        item.role === 'assistant' && item.kind !== 'role_status'
      ));
      return hasAssistantResponse ? null : message;
    }
    return null;
  }, [activeConversation, activeError, activePlan, activeRun, recoverablePlanGoal]);
  const isAwaitingChatResponse = pendingAgentStatus?.conversationId === activeConversation?.id;
  const pendingStatusLabel = pendingAgentStatus ? pendingAgentStatusLabel(pendingAgentStatus) : '';
  const chapterScopeReady = isChapterScopeSelectionValid(chapterScope);
  const activeTimeline = useMemo(() => isVisible ? buildAgentConversationTimeline({
    messages: activeConversation?.messages ?? [],
    runs: activeConversation?.runs,
    currentRun: activeRun,
    currentPlan: activePlan,
    resolutions: activeConversation?.userInputResolutions,
    updatedAt: activeConversation?.updatedAt ?? new Date().toISOString(),
  }) : [], [activeConversation?.messages, activeConversation?.runs, activeConversation?.updatedAt, activeConversation?.userInputResolutions, activePlan, activeRun, isVisible]);

  const timelineDraftBatches = useMemo(() => {
    const byId = new Map<string, { draftBatchId: string; live: boolean; refreshKey: string }>();
    activeTimeline.forEach((entry) => {
      if (entry.kind !== 'task' || !entry.run) return;
      const timelineRun = entry.run as AgentRun;
      const chapterBeatTimeline = projectChapterBeatTimeline(timelineRun);
      const latestCheckpoint = [...chapterBeatTimeline].reverse().find((item) => item.kind === 'checkpoint');
      const checkpointBatchId = latestCheckpoint?.kind === 'checkpoint' ? latestCheckpoint.approval.draftBatchId : undefined;
      const draftBatchId = timelineRun.draftBatchId || timelineRun.pendingApproval?.draftBatchId || checkpointBatchId;
      if (!draftBatchId) return;
      const operationLive = ['queued', 'running_generation', 'retry_wait', 'running_postprocess', 'committing', 'cancel_requested']
        .includes(timelineRun.draftOperationStatus || '');
      const live = operationLive || ['running', 'waiting_approval', 'waiting_user_input', 'cancelling'].includes(timelineRun.status);
      byId.set(draftBatchId, {
        draftBatchId,
        live,
        refreshKey: `${timelineRun.status}:${timelineRun.draftOperationStatus || ''}:${timelineRun.draftOperationVersion || 0}:${timelineRun.events.length}`,
      });
    });
    return [...byId.values()];
  }, [activeTimeline]);

  const rememberDraftBatch = useCallback((batch: DraftBatchRecord) => {
    draftBatchRecordsRef.current = { ...draftBatchRecordsRef.current, [batch.draftBatchId]: batch };
    setDraftBatchRecords((current) => current[batch.draftBatchId]?.version === batch.version
      && current[batch.draftBatchId]?.updatedAt === batch.updatedAt
      ? current
      : { ...current, [batch.draftBatchId]: batch });
  }, []);

  useEffect(() => {
    if (!draftInspectorSelection || draftInspectorSelection.kind === 'chapter_beat_snapshot') return;
    const batch = draftBatchRecords[draftInspectorSelection.draftBatchId];
    if (!batch) return;
    const selectedRun = conversationRuns.find((run) => run.runId === draftInspectorSelection.runId);
    const selectedConversationState = selectedRun ? projectDraftBatchConversationState({
      run: selectedRun,
      batch,
      chapterBeatTimeline: projectChapterBeatTimeline(selectedRun),
    }) : null;
    const nextKind: Exclude<DraftInspectorSelection['kind'], 'chapter_beat_snapshot'> = selectedConversationState?.primaryView === 'draft_batch_review'
      || selectedConversationState?.primaryView === 'draft_batch_interrupted'
      || selectedConversationState?.primaryView === 'draft_batch_progress'
      ? selectedConversationState.primaryView
      : draftInspectorSelection.kind;
    if (draftInspectorSelection.kind !== nextKind) {
      setDraftInspectorSelection({ ...draftInspectorSelection, kind: nextKind });
    }
  }, [conversationRuns, draftBatchRecords, draftInspectorSelection]);

  useEffect(() => {
    if (!isVisible || timelineDraftBatches.length === 0) return undefined;
    let cancelled = false;
    const load = async (draftBatchIds: string[]) => {
      await Promise.all(draftBatchIds.map(async (draftBatchId) => {
        try {
          const batch = await window.automation.invoke('draft.batch.get', { draftBatchId }, 'desktop-ui') as DraftBatchRecord | null;
          if (!cancelled && batch) rememberDraftBatch(batch);
        } catch (error) {
          if (!cancelled && !draftBatchRecordsRef.current[draftBatchId]) {
            console.warn('[AgentWorkspace] Failed to load draft batch summary:', error);
          }
        }
      }));
    };
    void load(timelineDraftBatches.map((item) => item.draftBatchId));
    const intervalId = window.setInterval(() => {
      const activeIds = timelineDraftBatches.flatMap((item) => {
        const batch = draftBatchRecordsRef.current[item.draftBatchId];
        const batchLive = batch && ['outline_draft', 'ready_to_generate', 'generating'].includes(batch.status);
        return item.live || batchLive ? [item.draftBatchId] : [];
      });
      if (activeIds.length > 0) void load(activeIds);
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeConversation?.id, isVisible, rememberDraftBatch, timelineDraftBatches]);

  useEffect(() => {
    if (isConversationsLoading || !activeConversation || volumes.length === 0) return;
    const planCandidates: Array<{ planId?: string; plan: unknown }> = [
      { planId: activePlan?.planId, plan: activePlan },
      { planId: activeRun?.planSnapshot?.planId, plan: activeRun?.planSnapshot },
      ...conversationRuns.map((run) => ({ planId: run.planSnapshot?.planId ?? run.planId, plan: run.planSnapshot })),
    ];
    const recovered = planCandidates
      .map((candidate) => ({ ...candidate, scope: chapterScopeSelectionFromPlan(candidate.plan) }))
      .find((candidate) => candidate.scope);
    const hydrationKey = `${novelId}:${activeConversation.id}:${JSON.stringify(activeConversation.chapterScope ?? null)}:${recovered?.planId ?? 'default'}`;
    if (hydratedChapterScopeKeyRef.current === hydrationKey) return;
    hydratedChapterScopeKeyRef.current = hydrationKey;
    const orderedChapterIds = volumes.flatMap((volume) => volume.chapters.map((chapter) => chapter.id));
    const selection = activeConversation.chapterScope
      ?? recovered?.scope
      ?? createDefaultChapterScope(currentChapter?.id, currentChapter?.volumeId);
    setChapterScope(normalizeChapterScopeSelection(
      selection,
      orderedChapterIds,
      currentChapter?.id,
      currentChapter?.volumeId,
    ));
  }, [activeConversation, activePlan, activeRun, conversationRuns, currentChapter?.id, currentChapter?.volumeId, isConversationsLoading, novelId, volumes]);
  const timelineActivityKey = useMemo(() => [
    activeConversation?.id ?? '',
    activeTimeline[activeTimeline.length - 1]?.key ?? '',
    activeConversation?.messages.length ?? 0,
    activeRun?.events.length ?? 0,
    activeRun?.status ?? '',
    activeRun?.pendingApproval?.checkpointId ?? '',
    activeRun?.pendingUserInput?.requestId ?? '',
    activeConversation?.pendingUserInput?.requestId ?? '',
    activePlan?.steps.map((step) => `${step.stepId}:${step.status}`).join('|') ?? '',
    isAwaitingChatResponse ? `awaiting-chat-response:${pendingAgentStatus?.phase}` : '',
    activeError,
  ].join(':'), [activeConversation?.id, activeConversation?.messages.length, activeConversation?.pendingUserInput?.requestId, activeError, activePlan?.steps, activeRun?.events.length, activeRun?.pendingApproval?.checkpointId, activeRun?.pendingUserInput?.requestId, activeRun?.status, activeTimeline, isAwaitingChatResponse, pendingAgentStatus?.phase]);

  const setPendingPhase = useCallback((conversationId: string, phase: AgentPendingPhase) => {
    setPendingAgentStatus({ conversationId, phase });
  }, []);

  const clearPendingStatus = useCallback((conversationId: string) => {
    setPendingAgentStatus((current) => current?.conversationId === conversationId ? null : current);
  }, []);

  useEffect(() => {
    liveChatActivitiesRef.current = liveChatActivities;
  }, [liveChatActivities]);

  useEffect(() => window.agent.onChatProgress((progress) => {
    const active = activeChatRequestRef.current;
    if (!active || progress.requestId !== active.requestId || active.cancelled) return;
    if (progress.type && progress.eventId && progress.stage && progress.displayName && progress.status && progress.createdAt) {
      const event = progress as AgentChatActivityEvent & { requestId: string };
      setLiveChatActivities((current) => ({
        conversationId: active.conversationId,
        events: [
          ...(current?.conversationId === active.conversationId ? current.events : []).filter((item) => item.eventId !== event.eventId),
          event,
        ].sort((left, right) => left.sequence - right.sequence),
      }));
    }
    if (progress.phase === 'cancelled') {
      clearPendingStatus(active.conversationId);
      return;
    }
    const phase = progress.phase as AgentPendingPhase;
    const selector = progress.selector && typeof progress.selector === 'object'
      ? progress.selector as { kind?: string; title?: string }
      : null;
    const detail = selector?.kind === 'section' && selector.title
      ? `“${selector.title}”`
      : progress.attachmentId || undefined;
    setPendingAgentStatus({ conversationId: active.conversationId, phase, detail });
  }), [clearPendingStatus]);

  useEffect(() => {
    if (pendingAgentStatus?.phase !== 'thinking') return;
    const { conversationId } = pendingAgentStatus;
    const timer = window.setTimeout(() => {
      setPendingAgentStatus((current) => (
        current?.conversationId === conversationId && current.phase === 'thinking'
          ? { ...current, phase: 'understanding' }
          : current
      ));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [pendingAgentStatus]);

  const scrollToLatest = useCallback(() => {
    followsLatestRef.current = true;
    setFollowsLatest(true);
    requestAnimationFrame(() => {
      const container = conversationScrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
        conversationScrollStateRef.current.set(activeConversationId, {
          scrollTop: container.scrollTop,
          followsLatest: true,
        });
      }
    });
  }, [activeConversationId]);

  const handleConversationScroll = useCallback(() => {
    const container = conversationScrollRef.current;
    if (!container) return;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 96;
    followsLatestRef.current = isNearBottom;
    setFollowsLatest(isNearBottom);
    conversationScrollStateRef.current.set(activeConversationId, {
      scrollTop: container.scrollTop,
      followsLatest: isNearBottom,
    });
  }, [activeConversationId]);

  useLayoutEffect(() => {
    if (!isVisible || !followsLatestRef.current) return;
    const container = conversationScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [isVisible, timelineActivityKey]);

  useLayoutEffect(() => {
    if (!isVisible || !activeConversation?.id) return undefined;
    const conversationId = activeConversation.id;
    const saved = conversationScrollStateRef.current.get(conversationId);
    const shouldFollowLatest = saved?.followsLatest ?? true;
    followsLatestRef.current = shouldFollowLatest;
    setFollowsLatest(shouldFollowLatest);
    const frame = requestAnimationFrame(() => {
      const container = conversationScrollRef.current;
      if (!container) return;
      container.scrollTop = shouldFollowLatest ? container.scrollHeight : saved?.scrollTop ?? 0;
    });
    return () => {
      cancelAnimationFrame(frame);
      const container = conversationScrollRef.current;
      if (!container) return;
      conversationScrollStateRef.current.set(conversationId, {
        scrollTop: container.scrollTop,
        followsLatest: followsLatestRef.current,
      });
    };
  }, [activeConversation?.id, isVisible]);

  const explicitChapterScope = useMemo(() => chapterScopePayload(chapterScope), [chapterScope]);

  const chapterCatalog = useMemo(() => [...volumes]
    .sort((a, b) => a.order - b.order)
    .flatMap((volume) => [...volume.chapters]
      .sort((a, b) => a.order - b.order)
      .map((chapter) => ({
        chapterId: chapter.id,
        title: chapter.title,
        chapterOrder: chapter.order,
        volumeId: volume.id,
        volumeTitle: volume.title,
        volumeOrder: volume.order,
      }))), [volumes]);

  const editorSelection = useMemo(() => ({
    chapterId: currentChapter?.id,
    volumeId: currentChapter?.volumeId,
    chapterTitle: currentChapter?.title,
  }), [currentChapter?.id, currentChapter?.title, currentChapter?.volumeId]);

  const contextPayload = useMemo(() => ({
    novelId,
    novelTitle: novel?.title,
    volumeId: currentChapter?.volumeId,
    chapterId: currentChapter?.id,
    chapterTitle: currentChapter?.title,
    locale,
    origin: 'desktop-ui',
    editorSelection,
    chapterCatalog,
    chapterScope: explicitChapterScope,
  }), [chapterCatalog, currentChapter?.id, currentChapter?.title, currentChapter?.volumeId, editorSelection, explicitChapterScope, locale, novel?.title, novelId]);

  useEffect(() => {
    let cancelled = false;
    const shouldShowLoader = loadedConversationNovelIdRef.current !== novelId;
    conversationsLoadedRef.current = false;
    if (shouldShowLoader) setIsConversationsLoading(true);
    setConversationSearch('');
    setUserInputCardDrafts({});
    setApprovalCardDrafts({});
    setChapterBeatCardDrafts({});
    const previousSubscriptions = new Set(backgroundSubscribedRunIdsRef.current);
    if (subscribedRunIdRef.current) previousSubscriptions.add(subscribedRunIdRef.current);
    runSubscriptionGenerationRef.current += 1;
    previousSubscriptions.forEach((runId) => void window.agent.unsubscribeRun(runId));
    activeRunIdRef.current = null;
    subscribedRunIdRef.current = null;
    backgroundSubscribedRunIdsRef.current.clear();
    lastSequenceRef.current = 0;
    lastSequenceByRunRef.current.clear();

    void (async () => {
      try {
        const stored = await window.db.getAgentConversations(novelId);
        const nextConversations = stored.length > 0
          ? stored.map((conversation) => ({ ...conversation, novelId }))
          : createSeedConversations(novelId, currentChapter);
        if (cancelled) return;
        const nextDrafts = Object.fromEntries(nextConversations.map((conversation) => [
          conversation.id,
          conversation.composerDraft ?? '',
        ]));
        const storedActiveConversationId = readActiveConversationId(novelId);
        const nextActiveConversationId = storedActiveConversationId
          && nextConversations.some((conversation) => conversation.id === storedActiveConversationId)
          ? storedActiveConversationId
          : nextConversations[0]?.id ?? 'conv-current-chapter-review';
        setConversations(nextConversations);
        persistedComposerDraftsRef.current = nextDrafts;
        setComposerDrafts(nextDrafts);
        setActiveConversationId(nextActiveConversationId);
      } catch (err) {
        console.warn('[AgentWorkspace] Failed to load agent conversations:', err);
        const fallback = createSeedConversations(novelId, currentChapter);
        if (cancelled) return;
        const fallbackDrafts = Object.fromEntries(fallback.map((conversation) => [conversation.id, '']));
        setConversations(fallback);
        persistedComposerDraftsRef.current = fallbackDrafts;
        setComposerDrafts(fallbackDrafts);
        setActiveConversationId(readActiveConversationId(novelId) ?? fallback[0]?.id ?? 'conv-current-chapter-review');
      } finally {
        if (!cancelled) {
          conversationsLoadedRef.current = true;
          loadedConversationNovelIdRef.current = novelId;
          if (shouldShowLoader) setIsConversationsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [novelId]);

  useEffect(() => {
    if (!conversationsLoadedRef.current) return;
    void (async () => {
      try {
        await Promise.all(conversations.map((conversation) => (
          window.db.upsertAgentConversation(conversationForPersistence({
            ...conversation,
            novelId: conversation.novelId || novelId,
            composerDraft: composerDraftsRef.current[conversation.id] ?? conversation.composerDraft ?? '',
          }))
        )));
      } catch (err) {
        console.warn('[AgentWorkspace] Failed to save agent conversations:', err);
      }
    })();
  }, [conversations, novelId]);

  useEffect(() => {
    if (!conversationsLoadedRef.current) return undefined;
    const changed = Object.fromEntries(Object.entries(composerDrafts).filter(([conversationId, draft]) => (
      persistedComposerDraftsRef.current[conversationId] !== draft
    )));
    if (Object.keys(changed).length === 0) return undefined;
    const timer = window.setTimeout(() => {
      void flushComposerDrafts(changed).catch((error) => {
        console.warn('[AgentWorkspace] Failed to persist composer drafts:', error);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [composerDrafts, flushComposerDrafts]);

  const updateConversation = useCallback((
    conversationId: string,
    updater: (conversation: AgentConversation) => AgentConversation,
  ) => {
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId ? updater(conversation) : conversation
    )));
  }, []);

  const updateActiveConversation = useCallback((
    updater: (conversation: AgentConversation) => AgentConversation,
  ) => {
    updateConversation(activeConversationId, updater);
  }, [activeConversationId, updateConversation]);

  const rebuildContextSummary = useCallback(async (conversationId: string) => {
    if (!conversationId || contextSummaryRebuildConversationId) return;
    const currentSummary = conversationsRef.current.find((item) => item.id === conversationId)?.contextSummary;
    const previousGeneration = currentSummary?.version === 'agent-conversation-summary-v2'
      ? currentSummary.generation
      : 0;
    const refreshFromStore = async () => {
      const stored = await window.db.getAgentConversations(novelId);
      const authoritative = stored.find((item) => item.id === conversationId);
      if (!authoritative) return null;
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        contextSummary: authoritative.contextSummary ?? null,
      }));
      return authoritative.contextSummary ?? null;
    };
    setContextSummaryRebuildConversationId(conversationId);
    try {
      const result = await window.ai.rebuildAgentContextSummary(conversationId);
      if (!result.ok) throw new Error(result.diagnostics.failureCode || '上下文摘要重建失败');
      if (result.status === 'completed') {
        await refreshFromStore();
        setContextSummaryRebuildConversationId(null);
        toast.success(`上下文摘要已重建为 generation ${result.generation}`);
        return;
      }
      toast.success('上下文摘要已进入后台质量重建');
      void (async () => {
        const deadline = Date.now() + 180_000;
        try {
          while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
            const summary = await refreshFromStore();
            if (summary?.version === 'agent-conversation-summary-v2'
              && summary.generation > previousGeneration) {
              toast.success(`上下文摘要已重建为 generation ${summary.generation}`);
              return;
            }
          }
          toast.error('上下文摘要后台重建未在时限内完成');
        } catch (error) {
          toast.error(toErrorMessage(error));
        } finally {
          setContextSummaryRebuildConversationId((current) => current === conversationId ? null : current);
        }
      })();
    } catch (error) {
      setContextSummaryRebuildConversationId(null);
      toast.error(toErrorMessage(error));
    }
  }, [contextSummaryRebuildConversationId, novelId, updateConversation]);

  const attentionSummary = useMemo(
    () => projectAgentWorkspaceAttention(conversations),
    [conversations],
  );

  useEffect(() => {
    onAttentionChange(attentionSummary);
  }, [attentionSummary, onAttentionChange]);

  useEffect(() => {
    if (!isVisible || attentionRequestId <= lastAttentionRequestIdRef.current) return;
    lastAttentionRequestIdRef.current = attentionRequestId;
    const current = conversations.find((conversation) => conversation.id === activeConversationId);
    const currentKind = current ? agentConversationAttentionKind(current) : 'idle';
    const currentHasBlockingDecision = currentKind === 'waiting_user_input' || currentKind === 'waiting_approval';
    const targetConversationId = currentHasBlockingDecision
      ? current?.id
      : attentionTargetConversationId;
    if (!targetConversationId || targetConversationId === activeConversationId) {
      requestAnimationFrame(scrollToLatest);
      return;
    }
    const target = conversations.find((conversation) => conversation.id === targetConversationId);
    if (!target) return;
    setActiveConversationId(target.id);
    setSelectedRole(target.role);
    setInspectorTab(target.run?.draftSessionId || target.run?.draftBatchId ? 'review' : 'context');
    setWorkspaceView('conversation');
    requestAnimationFrame(scrollToLatest);
  }, [activeConversationId, attentionRequestId, attentionTargetConversationId, conversations, isVisible, scrollToLatest]);

  useEffect(() => {
    if (!isVisible || !activeConversation?.run) return;
    const run = activeConversation.run;
    const attentionKind = agentConversationAttentionKind(activeConversation);
    if (!['failed', 'review_ready'].includes(attentionKind)) return;
    if (activeConversation.attentionAcknowledgedRunId === run.runId) return;
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      attentionAcknowledgedRunId: run.runId,
    }));
    void window.db.acknowledgeAgentConversationRun({
      conversationId: activeConversation.id,
      runId: run.runId,
    }).catch((error) => {
      console.warn('[AgentWorkspace] Failed to acknowledge Agent run:', error);
    });
  }, [activeConversation?.attentionAcknowledgedRunId, activeConversation?.id, activeConversation?.run, isVisible, updateConversation]);

  useEffect(() => {
    const enteringAgent = isVisible && !wasVisibleRef.current;
    wasVisibleRef.current = isVisible;
    if (!enteringAgent || !conversationsLoadedRef.current) return;
    const liveRuns = conversationsRef.current
      .filter((conversation) => conversation.run && (
        ['running', 'cancelling', 'waiting_approval', 'waiting_user_input'].includes(conversation.run.status)
        || (
          conversation.run.status === 'failed'
          && conversation.run.recovery?.failureKind === 'local_transform_failed'
        )
      ))
      .map((conversation) => ({ conversationId: conversation.id, run: conversation.run as AgentRun }));
    if (liveRuns.length === 0) return;
    void Promise.all(liveRuns.map(async ({ conversationId, run }) => ({
      conversationId,
      run,
      status: await window.agent.runStatus({ runId: run.runId }),
    }))).then((results) => {
      setConversations((current) => current.map((conversation) => {
        const result = results.find((candidate) => candidate.conversationId === conversation.id);
        if (!result || !conversation.run || conversation.run.runId !== result.run.runId) return conversation;
        const { status } = result;
        const nextRun: AgentRun = {
          ...conversation.run,
          status: status.status,
          currentStepId: status.currentStepId,
          progress: status.totalSteps > 0 ? status.completedSteps / status.totalSteps : conversation.run.progress,
          draftSessionId: status.draftSessionId,
          draftBatchId: status.draftBatchId,
          draftOperationId: status.draftOperationId,
          draftOperationKey: status.draftOperationKey,
          draftOperationStatus: status.draftOperationStatus,
          draftOperationVersion: status.draftOperationVersion,
          artifacts: status.artifacts,
          pendingApproval: status.pendingApproval
            ?? (status.status === 'waiting_approval' ? conversation.run.pendingApproval : null),
          pendingUserInput: status.pendingUserInput
            ?? (status.status === 'waiting_user_input' ? conversation.run.pendingUserInput : null),
          retryOfRunId: status.retryOfRunId,
          retryRootRunId: status.retryRootRunId,
          retryAttempt: status.retryAttempt,
          failureRevision: status.failureRevision,
          completionKind: status.completionKind,
          recovery: status.recovery,
        };
        return {
          ...withCurrentRun(conversation, nextRun),
          pendingUserInput: status.pendingUserInput
            ?? (status.status === 'waiting_user_input' ? conversation.pendingUserInput : null),
        };
      }));
    }).catch((error) => {
      console.warn('[AgentWorkspace] Failed to reconcile live Agent runs:', error);
    });
  }, [isVisible]);

  const changeChapterScope = useCallback((selection: AgentChapterScopeSelection) => {
    const snapshot: AgentChapterScopeSelection = {
      ...selection,
      chapterIds: [...selection.chapterIds],
      experts: [...selection.experts],
    };
    setChapterScope(snapshot);
    updateConversation(activeConversationId, (conversation) => ({
      ...conversation,
      chapterScope: snapshot,
      updatedAt: new Date().toISOString(),
    }));
  }, [activeConversationId, updateConversation]);

  const updateArtifactStatus = useCallback((draftSessionId: string, status: AgentArtifact['status']) => {
    updateActiveConversation((conversation) => {
      if (!conversation.run) return conversation;
      const run: AgentRun = {
        ...conversation.run,
        artifacts: (conversation.run.artifacts ?? []).map((artifact) => (
          artifact.reference?.draftSessionId === draftSessionId ? { ...artifact, status } : artifact
        )),
      };
      return {
        ...withCurrentRun(conversation, run),
        updatedAt: new Date().toISOString(),
      };
    });
  }, [updateActiveConversation]);

  const updateDraftBatchArtifactStatus = useCallback((draftBatchId: string, status: AgentArtifact['status']) => {
    updateActiveConversation((conversation) => {
      if (!conversation.run) return conversation;
      const run: AgentRun = {
        ...conversation.run,
        artifacts: (conversation.run.artifacts ?? []).map((artifact) => (
          artifact.reference?.draftBatchId === draftBatchId ? { ...artifact, status } : artifact
        )),
      };
      return { ...withCurrentRun(conversation, run), updatedAt: new Date().toISOString() };
    });
  }, [updateActiveConversation]);

  const updateArtifactReview = useCallback((artifactId: string, result: ArtifactReviewSubmitResult) => {
    updateActiveConversation((conversation) => {
      const updateRun = (run: AgentRun | null): AgentRun | null => {
        if (!run) return null;
        const hasArtifact = (run.artifacts ?? []).some((artifact) => artifact.artifactId === artifactId);
        if (!hasArtifact) return run;
        return {
          ...run,
          artifacts: (run.artifacts ?? []).map((artifact) => (
            artifact.artifactId === artifactId
              ? {
                ...artifact,
                reviewStatus: result.review.reviewStatus,
                reviewRevision: result.review.reviewRevision,
                reviewDecisions: result.review.decisions,
                reviewStaleChapterIds: result.review.staleChapterIds,
                reviewedAt: result.review.reviewedAt,
              }
              : artifact
          )),
        };
      };
      const run = updateRun(conversation.run);
      const runs = (conversation.runs ?? []).map((item) => updateRun(item) ?? item);
      return {
        ...conversation,
        run,
        runs: run ? mergeAgentRunHistory(runs, run) : runs,
        updatedAt: new Date().toISOString(),
      };
    });
    setRevisionTaskRefreshKey((current) => current + 1);
  }, [updateActiveConversation]);

  const syncRevisionPlanOutcome = useCallback(async (
    conversationId: string,
    plan: RevisionBatchPlan,
    outcome: RevisionTaskSyncRunInput['outcome'],
    sourceRunId?: string,
  ) => {
    await window.automation.invoke('revision_task.sync_run', {
      novelId,
      sourceArtifactId: plan.sourceArtifactId,
      sourceConversationId: conversationId || plan.sourceConversationId,
      ...(sourceRunId ? { sourceRunId } : {}),
      findingIds: plan.revisionItems.map((item) => item.findingId),
      outcome,
    }, 'desktop-ui');
    setRevisionTaskRefreshKey((current) => current + 1);
  }, [novelId]);

  useEffect(() => {
    const candidates = conversations.flatMap((conversation) => {
      const runs = conversation.run
        ? mergeAgentRunHistory(conversation.runs, conversation.run)
        : (conversation.runs ?? []);
      return runs.map((run) => ({ conversation, run }));
    });
    for (const { conversation, run } of candidates) {
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) continue;
      const plan = (run.planSnapshot ?? (conversation.run?.runId === run.runId ? conversation.plan : null)) as AgentPlan | null;
      if (!plan || !isRevisionBatchPlan(plan) || !hasRevisionBatchSource(plan)) continue;
      const outcome: RevisionTaskSyncRunInput['outcome'] = run.status === 'completed'
        ? (hasCommittedRevisionDraft(run) ? 'committed' : 'completed')
        : run.status === 'cancelled' ? 'cancelled' : 'failed';
      const syncKey = `${run.runId}:${outcome}`;
      if (revisionSyncCompletedRef.current.has(syncKey) || revisionSyncInFlightRef.current.has(syncKey)) continue;
      revisionSyncInFlightRef.current.add(syncKey);
      void syncRevisionPlanOutcome(conversation.id, plan, outcome, run.runId)
        .then(() => revisionSyncCompletedRef.current.add(syncKey))
        .catch((syncError) => console.warn('[AgentWorkspace] Failed to sync revision task outcome:', syncError))
        .finally(() => revisionSyncInFlightRef.current.delete(syncKey));
    }
  }, [conversations, syncRevisionPlanOutcome]);

  useEffect(() => {
    let cancelled = false;
    void window.automation.invoke('revision_task.list', { novelId }, 'desktop-ui')
      .then((result) => {
        if (cancelled || !Array.isArray(result)) return;
        setRevisionTaskCount((result as AgentRevisionTask[]).filter((task) => ['open', 'deferred'].includes(task.status)).length);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [novelId, revisionTaskRefreshKey]);

  const appendMessage = useCallback((
    conversationId: string,
    message: Omit<ConversationMessage, 'id' | 'createdAt'>,
    options?: { startNewTurnAfterTerminal?: boolean; messageId?: string; createdAt?: string },
  ) => {
    updateConversation(conversationId, (conversation) => {
      const startsNewTurn = Boolean(options?.startNewTurnAfterTerminal && isTerminalRun(conversation.run));
      const archivedRun = startsNewTurn && conversation.run
        ? { ...conversation.run, planSnapshot: conversation.plan ?? conversation.run.planSnapshot }
        : null;
      return {
        ...conversation,
        title: message.role === 'user' && isStarterConversation(conversation)
          ? buildConversationTitle(message.content, conversation.role)
          : conversation.title,
        description: message.role === 'user' && isStarterConversation(conversation)
          ? buildConversationDescription(message.content, conversation.role)
          : conversation.description,
        updatedAt: new Date().toISOString(),
        suggestedGoal: startsNewTurn ? null : conversation.suggestedGoal,
        plan: startsNewTurn ? null : conversation.plan,
        run: startsNewTurn ? null : conversation.run,
        runs: archivedRun ? mergeAgentRunHistory(conversation.runs, archivedRun) : conversation.runs,
        messages: [
          ...conversation.messages,
          {
            ...message,
            id: options?.messageId || nowId('msg'),
            createdAt: options?.createdAt || new Date().toISOString(),
          },
        ],
      };
    });
  }, [updateConversation]);

  const selectRoleMode = useCallback((role: AgentRoleMode) => {
    setSelectedRole(role);
    setRoleMenuOpen(false);
    updateActiveConversation((conversation) => {
      const updatedAt = new Date().toISOString();
      const roleStatusIndex = conversation.messages.findIndex((message) => (
        inferAgentConversationMessageKind(message) === 'role_status'
      ));
      const roleStatus: ConversationMessage = {
        id: roleStatusIndex >= 0 ? conversation.messages[roleStatusIndex].id : nowId('msg'),
        role: 'assistant',
        kind: 'role_status',
        content: roleStatusContent(role),
        createdAt: updatedAt,
      };
      return {
        ...conversation,
        role,
        updatedAt,
        messages: roleStatusIndex >= 0
          ? conversation.messages.map((message, index) => index === roleStatusIndex ? roleStatus : message)
          : [...conversation.messages, roleStatus],
      };
    });
  }, [updateActiveConversation]);

  const refreshHealth = useCallback(async (): Promise<AgentHealthResult> => {
    try {
      const result = await window.agent.health();
      setHealth(result);
      return result;
    } catch (err) {
      const result = { ok: false, code: 'AGENT_RUNTIME_UNAVAILABLE', message: toErrorMessage(err) };
      setHealth(result);
      return result;
    }
  }, []);

  const refreshRoles = useCallback(async () => {
    try {
      const roles = await window.agent.roles({ locale, context: contextPayload });
      setRoleOptions(normalizeRoleOptions(roles));
    } catch (err) {
      console.warn('[AgentWorkspace] Failed to load runtime roles; using local fallback:', err);
      setRoleOptions(ROLE_OPTIONS);
    }
  }, [contextPayload, locale]);

  const refreshAgentSkills = useCallback(async () => {
    try {
      const skills = await window.agent.skills({ novelId, locale, context: contextPayload });
      setAgentSkills(skills.filter((skill) => skill.enabled));
    } catch (err) {
      console.warn('[AgentWorkspace] Failed to load Agent Skills:', err);
      setAgentSkills([]);
    }
  }, [contextPayload, locale, novelId]);

  const ensureRuntimeReady = useCallback(async (forceRestart = false): Promise<AgentHealthResult> => {
    if (runtimeRecoveryRequestRef.current) return runtimeRecoveryRequestRef.current;
    setIsRuntimeRecoveryPending(true);
    setHealth((current) => ({
      ok: false,
      code: 'AGENT_RUNTIME_RECOVERING',
      message: 'Agent runtime is recovering',
      data: {
        ...(current?.data || {}),
        availability: 'recovering',
        recovering: true,
        canManualRetry: false,
      },
    }));
    const request = (async (): Promise<AgentHealthResult> => {
      try {
        const result = forceRestart
          ? await window.agent.restart()
          : await window.agent.ensureReady();
        setHealth(result);
        return result;
      } catch (err) {
        const result: AgentHealthResult = {
          ok: false,
          code: 'AGENT_RUNTIME_UNAVAILABLE',
          message: toErrorMessage(err),
          data: {
            availability: 'failed',
            recovering: false,
            canManualRetry: true,
          },
        };
        setHealth(result);
        return result;
      }
    })();
    runtimeRecoveryRequestRef.current = request;
    try {
      return await request;
    } finally {
      if (runtimeRecoveryRequestRef.current === request) runtimeRecoveryRequestRef.current = null;
      setIsRuntimeRecoveryPending(false);
    }
  }, []);

  const retryRuntime = useCallback(async () => {
    if (isRuntimeRecoveryPending) return;
    const result = await ensureRuntimeReady(true);
    if (result.ok) {
      toast.success('Runtime 已恢复');
      void refreshRoles();
      void refreshAgentSkills();
      return;
    }
    toast.error(result.message || 'Runtime 恢复失败');
  }, [ensureRuntimeReady, isRuntimeRecoveryPending, refreshAgentSkills, refreshRoles]);

  const refreshAiSettings = useCallback(async () => {
    try {
      const settings = await window.ai.getSettings();
      setAiSettings(settings);
      setModelDraft(settings.providerType === 'http' ? settings.http.model : '');
      setModelError('');
    } catch (err) {
      setModelError(toErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const result = await refreshHealth();
      if (cancelled) return;
      const availability = result.data?.availability;
      const delayMs = availability === 'ready'
        ? 10_000
        : availability === 'failed'
          ? 3_000
          : 750;
      timer = setTimeout(poll, delayMs);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isVisible, refreshHealth]);

  useEffect(() => {
    if (!isVisible) return;
    void refreshRoles();
    void refreshAgentSkills();
    void refreshAiSettings();
  }, [isVisible, refreshAgentSkills, refreshAiSettings, refreshRoles]);

  const usePresetTask = useCallback((role: AgentRoleMode, preset: AgentPresetTask) => {
    selectRoleMode(role);
    setInput(preset.goal);
    setInspectorTab('context');
    setRoleMenuOpen(false);
    scrollToLatest();
  }, [scrollToLatest, selectRoleMode]);

  const saveAgentModel = useCallback(async () => {
    if (!aiSettings || aiSettings.providerType !== 'http') return;
    const model = modelDraft.trim();
    if (!model) {
      setModelError('模型名称不能为空');
      return;
    }
    setIsModelSaving(true);
    setModelError('');
    try {
      const saved = await window.ai.updateSettings({
        http: { ...aiSettings.http, model, contextWindowTokens: 0 },
      });
      setAiSettings(saved);
      setModelDraft(saved.http.model);
      setModelMenuOpen(false);
      toast.success(`Agent 模型已切换为 ${saved.http.model}`);
    } catch (err) {
      const message = toErrorMessage(err);
      setModelError(message);
      toast.error(message);
    } finally {
      setIsModelSaving(false);
    }
  }, [aiSettings, modelDraft]);

  const subscribeRun = useCallback(async (runId: string, afterSequence = 0) => {
    if (subscribedRunIdRef.current === runId) return;
    if (backgroundSubscribedRunIdsRef.current.has(runId)) {
      if (activeRunIdRef.current === runId) {
        const previous = subscribedRunIdRef.current;
        if (previous && previous !== runId) backgroundSubscribedRunIdsRef.current.add(previous);
        subscribedRunIdRef.current = runId;
        backgroundSubscribedRunIdsRef.current.delete(runId);
      }
      return;
    }
    const generation = runSubscriptionGenerationRef.current;
    if (activeRunIdRef.current === runId) {
      const previous = subscribedRunIdRef.current;
      if (previous && previous !== runId) backgroundSubscribedRunIdsRef.current.add(previous);
      subscribedRunIdRef.current = runId;
      backgroundSubscribedRunIdsRef.current.delete(runId);
    } else {
      backgroundSubscribedRunIdsRef.current.add(runId);
    }
    try {
      await window.agent.subscribeRun(runId, { afterSequence });
      if (generation !== runSubscriptionGenerationRef.current) {
        void window.agent.unsubscribeRun(runId);
      }
    } catch (error) {
      if (generation !== runSubscriptionGenerationRef.current) return;
      if (subscribedRunIdRef.current === runId) subscribedRunIdRef.current = null;
      backgroundSubscribedRunIdsRef.current.delete(runId);
      throw error;
    }
  }, []);

  const applyRunEventImmediately = useCallback((event: AgentRunEvent) => {
    const previousSequence = lastSequenceByRunRef.current.get(event.runId) ?? 0;
    if (!shouldApplyRunSequence(event.sequence, previousSequence)) return;
    lastSequenceByRunRef.current.set(event.runId, event.sequence);
    const affectsActiveRun = event.runId === activeRunIdRef.current;
    if (affectsActiveRun) lastSequenceRef.current = event.sequence;
    setConversations((current) => current.map((conversation) => {
      if (!conversation.run || conversation.run.runId !== event.runId) return conversation;

      const projected = applyAgentRunEvent({
        run: conversation.run,
        plan: conversation.plan,
        messages: conversation.messages,
        error: conversation.error,
      }, event, () => ({ id: nowId('msg'), createdAt: new Date().toISOString() }));
      const suppressReportMessage = event.type === 'message'
        && event.payload?.kind === 'final_report'
        && (conversation.run.artifacts ?? []).some((artifact) => getExpertReport(artifact));

      const projectedRun = {
        ...projected.run,
        planSnapshot: (projected.plan as AgentPlan | null) ?? conversation.run.planSnapshot,
      } as AgentRun;
      return {
        ...conversation,
        updatedAt: new Date().toISOString(),
        messages: (suppressReportMessage ? conversation.messages : projected.messages) as ConversationMessage[],
        plan: projected.plan as AgentPlan | null,
        run: projectedRun,
        runs: mergeAgentRunHistory(conversation.runs, projectedRun),
        error: projected.error,
      };
    }));

    if (affectsActiveRun && event.type === 'draft_created') {
      setReviewTarget('draft');
      setInspectorTab('review');
    }

    if (affectsActiveRun && (event.type === 'approval_required' || event.type === 'user_input_required')) {
      setIsWorking(false);
    }

    if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') {
      if (affectsActiveRun) setIsWorking(false);
      if (subscribedRunIdRef.current === event.runId) {
        subscribedRunIdRef.current = null;
      }
      backgroundSubscribedRunIdsRef.current.delete(event.runId);
      void window.agent.unsubscribeRun(event.runId);
    }
  }, []);

  const flushQueuedRunEvents = useCallback(() => {
    if (runEventFlushTimerRef.current !== null) {
      window.clearTimeout(runEventFlushTimerRef.current);
      runEventFlushTimerRef.current = null;
    }
    const queued = queuedRunEventsRef.current;
    queuedRunEventsRef.current = [];
    queued.forEach(applyRunEventImmediately);
  }, [applyRunEventImmediately]);

  const applyRunEvent = useCallback((event: AgentRunEvent) => {
    const immediate = [
      'approval_required',
      'user_input_required',
      'run_completed',
      'run_failed',
      'run_cancelled',
    ].includes(event.type);
    if (immediate) {
      flushQueuedRunEvents();
      applyRunEventImmediately(event);
      return;
    }
    queuedRunEventsRef.current.push(event);
    if (runEventFlushTimerRef.current !== null) return;
    runEventFlushTimerRef.current = window.setTimeout(flushQueuedRunEvents, 120);
  }, [applyRunEventImmediately, flushQueuedRunEvents]);

  const finishDisconnectedRun = useCallback((runId: string, message: string) => {
    if (subscribedRunIdRef.current === runId) subscribedRunIdRef.current = null;
    backgroundSubscribedRunIdsRef.current.delete(runId);
    if (activeRunIdRef.current === runId) setIsWorking(false);
    setConversations((current) => current.map((conversation) => {
      if (!conversation.run || conversation.run.runId !== runId || isTerminalRun(conversation.run)) return conversation;
      const failedStepId = conversation.run.currentStepId;
      const failCurrentStep = <T extends AgentPlan | null | undefined,>(plan: T): T => {
        if (!plan || !failedStepId) return plan;
        return {
          ...plan,
          steps: plan.steps.map((step) => step.stepId === failedStepId ? { ...step, status: 'failed' as const } : step),
        } as T;
      };
      const plan = failCurrentStep(conversation.plan);
      const run: AgentRun = {
        ...conversation.run,
        status: 'failed',
        cancelRequested: false,
        pendingApproval: null,
        pendingUserInput: null,
        planSnapshot: failCurrentStep(conversation.run.planSnapshot),
      };
      return {
        ...withCurrentRun({
          ...conversation,
          plan,
          pendingUserInput: conversation.pendingUserInput?.runId === runId ? null : conversation.pendingUserInput,
        }, run),
        updatedAt: new Date().toISOString(),
        error: message,
      };
    }));
  }, []);

  useEffect(() => {
    const unsubscribeEvent = window.agent.onRunEvent(applyRunEvent);
    const unsubscribeDisconnected = window.agent.onRunDisconnected((payload) => {
      const interruptedConversation = conversationsRef.current.find((conversation) => conversation.run?.runId === payload.runId);
      if (!interruptedConversation) return;
      if (subscribedRunIdRef.current === payload.runId) subscribedRunIdRef.current = null;
      backgroundSubscribedRunIdsRef.current.delete(payload.runId);
      disconnectRecoveryRunIdsRef.current.add(payload.runId);
      updateConversation(interruptedConversation.id, (conversation) => ({
        ...conversation,
        error: `事件流已断开：${payload.message}`,
      }));
      void (async () => {
        try {
          const afterSequence = lastSequenceByRunRef.current.get(payload.runId) ?? 0;
          const status = await window.agent.runStatus({ runId: payload.runId });
          setConversations((current) => current.map((conversation) => {
            if (conversation.run?.runId !== payload.runId) return conversation;
            return {
              ...withCurrentRun(conversation, {
                  ...conversation.run,
                  status: status.status,
                  currentStepId: status.currentStepId,
                  draftSessionId: status.draftSessionId,
                  draftBatchId: status.draftBatchId,
                  draftOperationId: status.draftOperationId,
                  draftOperationKey: status.draftOperationKey,
                  draftOperationStatus: status.draftOperationStatus,
                  draftOperationVersion: status.draftOperationVersion,
                  artifacts: status.artifacts,
                  pendingApproval: status.pendingApproval
                    ?? (status.status === 'waiting_approval' ? conversation.run.pendingApproval : null),
                  pendingUserInput: status.pendingUserInput
                    ?? (status.status === 'waiting_user_input' ? conversation.run.pendingUserInput : null),
                  retryOfRunId: status.retryOfRunId,
                  retryRootRunId: status.retryRootRunId,
                  retryAttempt: status.retryAttempt,
                  failureRevision: status.failureRevision,
                  completionKind: status.completionKind,
                  recovery: status.recovery,
              }),
              pendingUserInput: status.pendingUserInput
                ?? (status.status === 'waiting_user_input' ? conversation.pendingUserInput : null),
            };
          }));
          if (shouldResubscribeRun(status.status, afterSequence, status.lastSequence)) {
            await subscribeRun(payload.runId, afterSequence);
            updateConversation(interruptedConversation.id, (conversation) => ({ ...conversation, error: '' }));
          } else {
            if (subscribedRunIdRef.current === payload.runId) {
              subscribedRunIdRef.current = null;
            }
            backgroundSubscribedRunIdsRef.current.delete(payload.runId);
            if (activeRunIdRef.current === payload.runId) setIsWorking(false);
          }
        } catch (err) {
          const interruptedPlan = interruptedConversation?.run?.planSnapshot ?? interruptedConversation?.plan;
          if (interruptedConversation && interruptedPlan && isRevisionBatchPlan(interruptedPlan) && hasRevisionBatchSource(interruptedPlan)) {
            void syncRevisionPlanOutcome(interruptedConversation.id, interruptedPlan, 'interrupted', payload.runId)
              .catch((syncError) => console.warn('[AgentWorkspace] Failed to recover interrupted revision tasks:', syncError));
          }
          finishDisconnectedRun(payload.runId, `事件流已断开：${payload.message || toErrorMessage(err)}`);
        } finally {
          disconnectRecoveryRunIdsRef.current.delete(payload.runId);
        }
      })();
    });
    return () => {
      runSubscriptionGenerationRef.current += 1;
      unsubscribeEvent();
      unsubscribeDisconnected();
      if (runEventFlushTimerRef.current !== null) {
        window.clearTimeout(runEventFlushTimerRef.current);
        runEventFlushTimerRef.current = null;
      }
      queuedRunEventsRef.current = [];
      const runIds = new Set(backgroundSubscribedRunIdsRef.current);
      if (subscribedRunIdRef.current) runIds.add(subscribedRunIdRef.current);
      runIds.forEach((runId) => void window.agent.unsubscribeRun(runId));
      backgroundSubscribedRunIdsRef.current.clear();
      subscribedRunIdRef.current = null;
    };
  }, [applyRunEvent, finishDisconnectedRun, subscribeRun, syncRevisionPlanOutcome, updateConversation]);

  useEffect(() => {
    if (
      !activeRun
      || isTerminalRun(activeRun)
      || disconnectRecoveryRunIdsRef.current.has(activeRun.runId)
      || (!activeError.startsWith('事件流已断开：') && !activeError.startsWith('恢复事件流失败：'))
    ) return;
    finishDisconnectedRun(activeRun.runId, activeError);
  }, [activeError, activeRun, finishDisconnectedRun]);

  useEffect(() => {
    const run = activeConversation?.run;
    const runId = run?.runId ?? null;
    if (!run || !runId) {
      const previous = subscribedRunIdRef.current;
      const previousRun = conversationsRef.current.find((conversation) => conversation.run?.runId === previous)?.run;
      if (previous && previousRun && getRunRecoverySnapshot(previousRun).isLive) {
        backgroundSubscribedRunIdsRef.current.add(previous);
      } else if (previous) {
        void window.agent.unsubscribeRun(previous);
      }
      activeRunIdRef.current = null;
      subscribedRunIdRef.current = null;
      lastSequenceRef.current = 0;
      setIsWorking(false);
      return;
    }

    activeRunIdRef.current = runId;
    const recovery = getRunRecoverySnapshot(run);
    lastSequenceRef.current = recovery.lastSequence;
    lastSequenceByRunRef.current.set(runId, recovery.lastSequence);
    if (!recovery.isLive) {
      if (subscribedRunIdRef.current === runId) {
        void window.agent.unsubscribeRun(runId);
        subscribedRunIdRef.current = null;
      }
      if (backgroundSubscribedRunIdsRef.current.delete(runId)) {
        void window.agent.unsubscribeRun(runId);
      }
      setIsWorking(false);
      return;
    }

    setIsWorking(run.status === 'running' || run.status === 'cancelling');
    if (subscribedRunIdRef.current === runId) return;
    const previous = subscribedRunIdRef.current;
    if (previous) {
      const previousRun = conversationsRef.current.find((conversation) => conversation.run?.runId === previous)?.run;
      if (previousRun && getRunRecoverySnapshot(previousRun).isLive) {
        backgroundSubscribedRunIdsRef.current.add(previous);
      } else {
        void window.agent.unsubscribeRun(previous);
      }
    }
    const afterSequence = lastSequenceRef.current;
    void subscribeRun(runId, afterSequence).catch((err) => {
      finishDisconnectedRun(runId, `恢复事件流失败：${toErrorMessage(err)}`);
    });
  }, [activeConversation?.id, activeConversation?.run?.runId, activeConversation?.run?.status, finishDisconnectedRun, subscribeRun]);

  const liveRunSubscriptionKey = useMemo(() => conversations
    .map((conversation) => {
      const run = conversation.run;
      if (!run || !getRunRecoverySnapshot(run).isLive) return '';
      return `${run.runId}:${run.status}:${getRunRecoverySnapshot(run).lastSequence}`;
    })
    .filter(Boolean)
    .sort()
    .join('|'), [conversations]);

  useEffect(() => {
    const liveRuns = conversationsRef.current
      .map((conversation) => conversation.run)
      .filter((run): run is AgentRun => Boolean(run && getRunRecoverySnapshot(run).isLive));
    const liveRunIds = new Set(liveRuns.map((run) => run.runId));

    for (const subscribedRunId of [...backgroundSubscribedRunIdsRef.current]) {
      if (liveRunIds.has(subscribedRunId)) continue;
      backgroundSubscribedRunIdsRef.current.delete(subscribedRunId);
      void window.agent.unsubscribeRun(subscribedRunId);
    }

    for (const run of liveRuns) {
      if (run.runId === subscribedRunIdRef.current || backgroundSubscribedRunIdsRef.current.has(run.runId)) continue;
      const recovery = getRunRecoverySnapshot(run);
      lastSequenceByRunRef.current.set(run.runId, recovery.lastSequence);
      void subscribeRun(run.runId, recovery.lastSequence).catch((error) => {
        finishDisconnectedRun(run.runId, `恢复事件流失败：${toErrorMessage(error)}`);
      });
    }
  }, [finishDisconnectedRun, liveRunSubscriptionKey, subscribeRun]);

  const createConversation = () => {
    const initialChapterScope = createDefaultChapterScope(currentChapter?.id, currentChapter?.volumeId);
    const conversation: AgentConversation = {
      id: nowId('conv'),
      novelId,
      title: `${roleLabel(selectedRole)}新会话`,
      description: '新的小说创作讨论',
      role: selectedRole,
      runtimeConversationId: null,
      updatedAt: new Date().toISOString(),
      chapterScope: initialChapterScope,
      messages: [
        {
          id: nowId('msg'),
          role: 'assistant',
          kind: 'role_status',
          content: roleStatusContent(selectedRole),
          createdAt: new Date().toISOString(),
        },
      ],
      suggestedGoal: null,
      plan: null,
      run: null,
      composerDraft: '',
      error: '',
    };
    setConversations((current) => [conversation, ...current]);
    setComposerDrafts((current) => ({ ...current, [conversation.id]: '' }));
    setActiveConversationId(conversation.id);
    setInspectorTab('context');
    setWorkspaceView('conversation');
  };

  const continueRevisionTask = useCallback(async (task: AgentRevisionTask) => {
    const conversation = conversations.find((candidate) => (
      (task.planId && (candidate.plan?.planId === task.planId || candidate.run?.planId === task.planId))
      || candidate.id === task.sourceConversationId
    ));
    if (!conversation) throw new Error('来源对话已不存在，无法恢复这项修订。');
    const orderedIds = volumes.flatMap((volume) => volume.chapters.map((chapter) => chapter.id));
    const targetIds = [...new Set(task.targetChapterIds)]
      .filter((chapterId) => orderedIds.includes(chapterId))
      .sort((left, right) => orderedIds.indexOf(left) - orderedIds.indexOf(right));
    if (targetIds.length > 0) {
      const anchorChapterId = targetIds[0];
      const targetVolume = volumes.find((volume) => volume.chapters.some((chapter) => chapter.id === anchorChapterId));
      const restoredScope: AgentChapterScopeSelection = {
        kind: targetIds.length === 1 ? 'current_chapter' : 'selected_chapters',
        ...(targetVolume ? { volumeId: targetVolume.id } : {}),
        chapterIds: targetIds,
        anchorChapterId,
        processingMode: 'detailed',
        experts: ['editor'],
      };
      setChapterScope(restoredScope);
      setConversations((current) => current.map((candidate) => (
        candidate.id === conversation.id
          ? { ...candidate, chapterScope: restoredScope, updatedAt: new Date().toISOString() }
          : candidate
      )));
    }
    setSelectedRole(conversation.role);
    setActiveConversationId(conversation.id);
    setWorkspaceView('conversation');
    setConversationDrawerOpen(false);
    requestAnimationFrame(scrollToLatest);
  }, [conversations, scrollToLatest, volumes]);

  const deleteConversation = async (conversationId: string) => {
    if (conversations.length <= 1) return;
    const deletedConversation = conversations.find((conversation) => conversation.id === conversationId);
    const nextConversations = conversations.filter((conversation) => conversation.id !== conversationId);
    setConversations(nextConversations);
    setComposerDrafts((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    delete persistedComposerDraftsRef.current[conversationId];
    if (activeConversationId === conversationId) {
      setActiveConversationId(nextConversations[0]?.id ?? '');
      setInspectorTab(nextConversations[0]?.run?.draftSessionId || nextConversations[0]?.run?.draftBatchId ? 'review' : 'context');
    }
    try {
      await window.db.deleteAgentConversation(conversationId);
      if (deletedConversation) {
        await window.agent.deleteChatContext({
          conversationId: deletedConversation.runtimeConversationId || deletedConversation.id,
          storageConversationId: deletedConversation.id,
        });
      }
    } catch (err) {
      console.warn('[AgentWorkspace] Failed to delete agent conversation:', err);
    }
  };

  const createPlan = useCallback(async (
    goal: string,
    intentDecision?: AgentIntentDecision,
    initialization?: { bootstrapArtifactId: string; bootstrapDraft: Record<string, unknown> },
  ): Promise<boolean> => {
    if (!goal.trim() || !activeConversation) return false;
    const conversationId = activeConversation.id;
    if (!chapterScopeReady) {
      clearPendingStatus(conversationId);
      updateConversation(conversationId, (conversation) => ({ ...conversation, error: '请先完成章节范围选择。' }));
      return false;
    }
    if (approvalMode === 'chat_only') {
      clearPendingStatus(conversationId);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: '当前权限为“只讨论不执行”。请切换为“需要用户审核”后再生成计划。',
      }));
      return false;
    }
    setPendingPhase(conversationId, 'planning');
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '', suggestedGoal: null }));
    const currentContent = getCurrentContentSnapshot().content;
    try {
      const nextPlan = await window.agent.plan({
        novelId,
        conversationId: activeConversation.runtimeConversationId ?? undefined,
        chapterId: currentChapter?.id,
        goal,
        currentContent,
        locale,
        role: activeConversation.role,
        approvalMode,
        chapterScope: explicitChapterScope,
        editorSelection,
        chapterCatalog,
        context: contextPayload,
        intentDecision,
        ...(initialization ? initialization : {}),
      });
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: new Date().toISOString(),
        plan: nextPlan,
        run: null,
        messages: [
          ...conversation.messages,
          {
            id: nowId('msg'),
            role: 'assistant',
            kind: 'workflow_notice',
            content: `已生成计划草稿：${nextPlan.title}。你可以忽略、提交修改意见，或选择“实施此计划”。`,
            createdAt: new Date().toISOString(),
          },
        ],
      }));
      return false;
    } catch (err) {
      setIsWorking(false);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(err),
        suggestedGoal: goal,
      }));
      return false;
    } finally {
      clearPendingStatus(conversationId);
      setIsWorking(false);
    }
  }, [activeConversation, approvalMode, chapterCatalog, chapterScopeReady, clearPendingStatus, contextPayload, currentChapter?.id, editorSelection, explicitChapterScope, getCurrentContentSnapshot, locale, novelId, setPendingPhase, updateConversation]);

  const beginRetryRun = useCallback(async (
    conversationId: string,
    failedRun: AgentRun,
    recovery?: AgentIntentDecision['recovery'],
  ) => {
    const nextRun = await window.agent.retryRun({
      failedRunId: recovery?.failedRunId ?? failedRun.runId,
      expectedFailureRevision: recovery?.expectedFailureRevision ?? failedRun.failureRevision,
      mode: recovery?.mode ?? 'failed_node',
      ...(failedRun.recovery?.retryStrategy && failedRun.recovery.retryStrategy !== 'none'
        ? { strategy: failedRun.recovery.retryStrategy }
        : {}),
      context: contextPayload,
    });
    activeRunIdRef.current = nextRun.runId;
    lastSequenceRef.current = 0;
    lastSequenceByRunRef.current.set(nextRun.runId, 0);
    updateConversation(conversationId, (conversation) => {
      const planSnapshot = failedRun.planSnapshot ?? conversation.plan ?? undefined;
      const updated = withCurrentRun(conversation, {
        ...nextRun,
        events: [],
        ...(planSnapshot ? { planSnapshot } : {}),
      });
      return { ...updated, updatedAt: new Date().toISOString(), error: '' };
    });
    await subscribeRun(nextRun.runId);
    scrollToLatest();
  }, [contextPayload, scrollToLatest, subscribeRun, updateConversation]);

  const retryFailedRun = useCallback(async (failedRun: AgentRun) => {
    if (
      !activeConversation
      || isWorking
      || failedRun.status !== 'failed'
      || !failedRun.failureRevision
      || (failedRun.recovery && !failedRun.recovery.canRecover)
    ) return;
    const conversationId = activeConversation.id;
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    try {
      await beginRetryRun(conversationId, failedRun);
    } catch (error) {
      setIsWorking(false);
      let latestStatus: AgentRunStatusResult | null = null;
      try {
        latestStatus = await window.agent.runStatus({ runId: failedRun.runId });
      } catch {
        // Keep the existing failed run when status refresh is unavailable.
      }
      updateConversation(conversationId, (conversation) => {
        const currentRun = conversation.run;
        const refreshedRun = latestStatus && currentRun?.runId === failedRun.runId
          ? {
              ...currentRun,
              status: latestStatus.status,
              failureRevision: latestStatus.failureRevision,
              completionKind: latestStatus.completionKind,
              recovery: latestStatus.recovery,
              artifacts: latestStatus.artifacts,
            }
          : currentRun;
        return {
          ...(refreshedRun ? withCurrentRun(conversation, refreshedRun) : conversation),
          error: toErrorMessage(error),
        };
      });
    }
  }, [activeConversation, beginRetryRun, isWorking, updateConversation]);

  const prepareFailedRunReplan = useCallback((plan: AgentPlan) => {
    setInput(`请调整原计划：${plan.goal}\n\n调整要求：`);
    requestAnimationFrame(() => {
      const inputNode = chatInputRef.current;
      inputNode?.focus();
      inputNode?.setSelectionRange(inputNode.value.length, inputNode.value.length);
    });
  }, []);

  const ignorePlan = useCallback(() => {
    if (!activeConversation || !activePlan || activeRun) return;
    const conversationId = activeConversation.id;
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      updatedAt: new Date().toISOString(),
      plan: null,
      suggestedGoal: null,
      messages: [
        ...conversation.messages,
        {
          id: nowId('msg'),
          role: 'assistant',
          kind: 'workflow_notice',
          content: '已忽略当前计划草稿，回到普通会话。',
          createdAt: new Date().toISOString(),
        },
      ],
    }));
  }, [activeConversation, activePlan, activeRun, updateConversation]);

  const submitPlanRevision = useCallback(async (revision: string) => {
    if (!activeConversation || !activePlan || activeRun || isWorking) return;
    const trimmed = revision.trim();
    if (!trimmed) return;
    const conversationId = activeConversation.id;
    setPendingPhase(conversationId, 'revising');
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    try {
      const revisedPlan = await window.agent.revisePlan({
        planId: activePlan.planId,
        revision: trimmed,
        role: activeConversation.role,
        locale,
        approvalMode,
        chapterScope: explicitChapterScope,
        context: contextPayload,
      });
      const revisionNotice: ConversationMessage = {
        id: nowId('msg'),
        role: 'assistant',
        kind: 'workflow_notice',
        content: `计划已按意见修订：${trimmed}`,
        createdAt: new Date().toISOString(),
      };
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: new Date().toISOString(),
        plan: revisedPlan,
        messages: [...conversation.messages, revisionNotice],
      }));
    } catch (err) {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(err),
      }));
    } finally {
      clearPendingStatus(conversationId);
      setIsWorking(false);
    }
  }, [activeConversation, activePlan, activeRun, approvalMode, clearPendingStatus, contextPayload, explicitChapterScope, isWorking, locale, setPendingPhase, updateConversation]);

  useEffect(() => {
    if (!initialGoal) return;
    if (consumedInitialGoalRef.current === initialGoal) return;
    consumedInitialGoalRef.current = initialGoal;
    const conversationId = activeConversationId;
    void (async () => {
      const runtime = await ensureRuntimeReady();
      if (!runtime.ok) {
        setInput(initialGoal);
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          error: runtime.message || 'Runtime 不可用，请重试后发送。',
        }));
        onInitialGoalConsumed();
        return;
      }
      appendMessage(conversationId, { role: 'user', kind: 'chat', content: initialGoal });
      setPendingPhase(conversationId, 'thinking');
      void createPlan(initialGoal);
      onInitialGoalConsumed();
    })();
  }, [activeConversationId, appendMessage, createPlan, ensureRuntimeReady, initialGoal, onInitialGoalConsumed, setPendingPhase, updateConversation]);

  const sendChat = async (
    messageOverride?: string,
    recoveryOptions?: { sourceMessage: ConversationMessage; repair?: AgentChatRecoveryDescriptor },
    activation?: {
      entryHint: Record<string, unknown>;
      initialization?: { bootstrapArtifactId: string; bootstrapDraft: Record<string, unknown> };
    },
  ) => {
    if (!activeConversation) return;
    if (activeUserInput) {
      updateConversation(activeConversation.id, (conversation) => ({ ...conversation, error: '请先完成当前问答卡。' }));
      return;
    }
    const recoveryMessage = recoveryOptions?.sourceMessage;
    const rawMessage = (messageOverride ?? input).trim();
    if ((!rawMessage && pendingAttachments.length === 0) || isWorking || isRuntimeRecoveryPending || sendInFlightRef.current) return;
    const message = rawMessage || '请读取并分析附件。';
    const conversationId = activeConversation.id;
    const selectedSkillMode = !activation && !recoveryMessage && messageOverride === undefined
      ? agentSkillModes[conversationId]
      : undefined;
    const entryHint = activation?.entryHint ?? agentSkillEntryHint(selectedSkillMode);
    const sourceScope = recoveryMessage?.chapterScopeSnapshot ?? chapterScope;
    const chapterScopeSnapshot: AgentChapterScopeSelection = {
      ...sourceScope,
      chapterIds: [...sourceScope.chapterIds],
      experts: [...sourceScope.experts],
    };
    const chapterScopeRequestPayload = chapterScopePayload(chapterScopeSnapshot);
    if (!isChapterScopeSelectionValid(chapterScopeSnapshot)) {
      updateConversation(conversationId, (conversation) => ({ ...conversation, error: '请先完成章节范围选择。' }));
      setScopeMenuOpen(true);
      return;
    }
    const declaredChapterCount = requestedChapterCount(message);
    if (declaredChapterCount !== null && chapterScopeSnapshot.chapterIds.length !== declaredChapterCount) {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: `SCOPE_CONFLICT：请求提到 ${declaredChapterCount} 章，但当前范围包含 ${chapterScopeSnapshot.chapterIds.length} 章。请重新选择章节范围。`,
      }));
      setScopeMenuOpen(true);
      return;
    }
    sendInFlightRef.current = true;
    const runtime = await ensureRuntimeReady();
    if (!runtime.ok) {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: runtime.message || 'Runtime 不可用，请重试后发送。',
      }));
      sendInFlightRef.current = false;
      return;
    }
    const runtimeConversationId = activeConversation.runtimeConversationId;
    const userMessageId = recoveryMessage?.id ?? nowId('msg');
    const userCreatedAt = recoveryMessage?.createdAt ?? new Date().toISOString();
    let sentAttachments: AgentAttachmentRecord[] = recoveryMessage
      ? attachments.filter((attachment) => recoveryMessage.attachmentIds?.includes(attachment.id))
      : [];
    if (!recoveryMessage && pendingAttachments.length) {
      try {
        sentAttachments = await window.agentAttachments.bind({
          novelId,
          conversationId,
          messageId: userMessageId,
          attachmentIds: pendingAttachments.map((attachment) => attachment.id),
        });
        setAttachments((current) => current.map((attachment) => (
          sentAttachments.find((sent) => sent.id === attachment.id) ?? attachment
        )));
      } catch (error) {
        updateConversation(conversationId, (conversation) => ({ ...conversation, error: toErrorMessage(error) }));
        sendInFlightRef.current = false;
        return;
      }
    }
    scrollToLatest();
    if (!recoveryMessage) {
      appendMessage(conversationId, {
        role: 'user',
        kind: 'chat',
        content: message,
        attachmentIds: sentAttachments.map((attachment) => attachment.id),
        chapterScopeSnapshot,
      }, {
        startNewTurnAfterTerminal: true,
        messageId: userMessageId,
        createdAt: userCreatedAt,
      });
    }
    if (!recoveryMessage && messageOverride === undefined) {
      setComposerDrafts((current) => {
        const updated = { ...current, [conversationId]: '' };
        composerDraftsRef.current = updated;
        return updated;
      });
      setAgentSkillModes((current) => ({ ...current, [conversationId]: undefined }));
    }
    setIsWorking(true);
    setPendingPhase(conversationId, 'thinking');
    const chatRequestId = nowId('chat_request');
    const deadlineAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    activeChatRequestRef.current = { requestId: chatRequestId, conversationId, cancelled: false };
    setActiveChatRequestId(chatRequestId);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    let startedRun = false;
    const currentContent = getCurrentContentSnapshot().content;
    const currentContentText = extractReadableText(currentContent);
    try {
      const availableAttachments = [
        ...attachments.filter((attachment) => Boolean(attachment.messageId)),
        ...sentAttachments,
      ].filter((attachment, index, items) => items.findIndex((item) => item.id === attachment.id) === index);
      if (!recoveryMessage) {
        await window.db.upsertAgentConversation(conversationForPersistence({
          ...activeConversation,
          composerDraft: messageOverride === undefined
            ? ''
            : composerDraftsRef.current[conversationId] ?? activeConversation.composerDraft ?? '',
          updatedAt: userCreatedAt,
          messages: [
            ...activeConversation.messages,
            {
              id: userMessageId,
              role: 'user' as const,
              kind: 'chat' as const,
              content: message,
              attachmentIds: sentAttachments.map((attachment) => attachment.id),
              chapterScopeSnapshot,
              createdAt: userCreatedAt,
            },
          ],
        }));
        if (messageOverride === undefined) persistedComposerDraftsRef.current[conversationId] = '';
      }
      if (selectedSkillMode?.kind === 'skill.author') {
        const novelScoped = /(?:本小说|当前小说|本项目|novel[- ]?scoped)/iu.test(message);
        const authored = await window.agent.authorSkill({
          goal: message.replace(/^创建一个\s*Skill\s*[：:]?\s*/iu, '').trim() || message,
          scope: novelScoped ? 'novel' : 'user',
          ...(novelScoped ? { novelId } : {}),
          locale,
          context: contextPayload,
        }) as { draft?: { id?: string; version?: number }; proposal?: { definition?: { title?: string; stableId?: string } } };
        const title = authored.proposal?.definition?.title || '未命名 Skill';
        const stableId = authored.proposal?.definition?.stableId;
        appendMessage(conversationId, {
          role: 'assistant',
          kind: 'workflow_notice',
          content: `已生成“${title}”的可审核草稿${stableId ? `（\`${stableId}\`）` : ''}。当前尚未发布，也不会参与任务；确认后才会创建不可变 Revision。草稿 ID：\`${authored.draft?.id || 'unknown'}\`。`,
        });
        clearPendingStatus(conversationId);
        return;
      }
      const chatPayload = {
        novelId,
        novelTitle: novel?.title,
        volumeId: currentChapter?.volumeId,
        chapterId: currentChapter?.id,
        chapterTitle: currentChapter?.title,
        message,
        deadlineAt,
        conversationId: runtimeConversationId,
        agentConversationId: conversationId,
        storageConversationId: conversationId,
        attachments: availableAttachments.map((attachment) => ({
          attachmentId: attachment.id,
          fileName: attachment.originalFileName,
          characterCount: attachment.characterCount,
        })),
        currentContent,
        currentContentText,
        locale,
        role: activeConversation.role,
        approvalMode,
        source: entryHint ? 'shortcut' : 'chat',
        ...(entryHint ? { entryHint } : {}),
        chapterScope: chapterScopeRequestPayload,
        editorSelection,
        chapterCatalog,
        messageId: userMessageId,
        conversationContext: {
          currentPlan: activeConversation.plan,
          pendingUserInput: activeConversation.pendingUserInput ?? null,
          userInputResolutions: activeConversation.userInputResolutions ?? [],
          activeRun: activeConversation.run ? {
            runId: activeConversation.run.runId,
            planId: activeConversation.run.planId,
            status: activeConversation.run.status,
            progress: activeConversation.run.progress,
            currentStepId: activeConversation.run.currentStepId,
            pendingApproval: activeConversation.run.pendingApproval,
            approvalResponses: activeConversation.run.approvalResponses,
            pendingUserInput: activeConversation.run.pendingUserInput,
            userInputResponses: activeConversation.run.userInputResponses,
            draftSessionId: activeConversation.run.draftSessionId,
            draftBatchId: activeConversation.run.draftBatchId,
            draftOperationId: activeConversation.run.draftOperationId,
            draftOperationKey: activeConversation.run.draftOperationKey,
            draftOperationStatus: activeConversation.run.draftOperationStatus,
            draftOperationVersion: activeConversation.run.draftOperationVersion,
            artifacts: activeConversation.run.artifacts,
          } : null,
          priorRuns: (activeConversation.runs ?? []).map((run) => ({
            runId: run.runId,
            status: run.status,
            planSnapshot: run.planSnapshot,
            approvalResponses: run.approvalResponses,
            draftSessionId: run.draftSessionId,
            draftBatchId: run.draftBatchId,
            artifacts: run.artifacts,
          })),
        },
        context: contextPayload,
        ...(recoveryOptions?.repair ? { recovery: recoveryOptions.repair } : {}),
      };
      const response = recoveryOptions?.repair
        ? await window.agent.recoverChat(chatPayload, { requestId: chatRequestId })
        : await window.agent.chat(chatPayload, { requestId: chatRequestId });
      setLiveChatActivities((current) => current?.conversationId === conversationId ? null : current);
      const shouldDraftPlan = !response.awaitingUserInput
        && (response.suggestedActions?.some((action) => action.method === 'agent.plan') ?? false);
      const recovery = response.intentDecision?.route === 'retry_failed_run'
        ? response.intentDecision.recovery
        : undefined;
      const assistantTimestamp = Date.parse(response.assistantMessage.createdAt);
      const compressionCreatedAt = Number.isFinite(assistantTimestamp)
        ? new Date(Math.max(0, assistantTimestamp - 1)).toISOString()
        : new Date().toISOString();
      const compressionMessage: ConversationMessage | null = response.contextCompression ? {
        id: nowId('msg'),
        role: 'system',
        kind: 'context_compression',
        content: serializeContextCompression(response.contextCompression),
        createdAt: compressionCreatedAt,
      } : null;
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        runtimeConversationId: response.conversationId,
        pendingUserInput: response.pendingUserInput ?? null,
        suggestedGoal: null,
        messages: [
          ...conversation.messages.map((item) => item.id === userMessageId
            ? { ...item, failure: undefined }
            : item),
          ...(compressionMessage ? [compressionMessage] : []),
          ...(!recovery && !response.pendingUserInput ? [{
            id: response.assistantMessage.messageId || nowId('msg'),
            role: 'assistant' as const,
            kind: 'chat' as const,
            content: response.assistantMessage.content,
            createdAt: response.assistantMessage.createdAt,
            contextReads: response.contextReads,
            contextDiagnostics: response.contextDiagnostics,
            activities: response.activities,
            failure: response.failure,
            evidenceSnapshotId: response.evidenceSnapshotId,
          }] : []),
        ],
      }));
      if (recovery && activeConversation.run) {
        await beginRetryRun(conversationId, activeConversation.run, recovery);
        startedRun = true;
        clearPendingStatus(conversationId);
      } else if (shouldDraftPlan) {
        const planGoal = activeConversation.plan && !activeConversation.run
          ? `${activeConversation.plan.goal}\n\n用户修改意见：${message}`
          : buildAgentPlanGoal(message, activeConversation.messages);
        startedRun = await createPlan(planGoal, response.intentDecision, activation?.initialization);
      } else {
        clearPendingStatus(conversationId);
      }
    } catch (err) {
      clearPendingStatus(conversationId);
      setLiveChatActivities((current) => current?.conversationId === conversationId ? null : current);
      if (!activeChatRequestRef.current?.cancelled && !isCancelledError(err)) {
        const failure = chatFailureFromError(err);
        const exhaustedManualRepair = Boolean(recoveryOptions?.repair);
        const errorCode = err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code || '')
          : '';
        const errorDetails = err && typeof err === 'object' && 'details' in err
          && (err as { details?: unknown }).details
          && typeof (err as { details?: unknown }).details === 'object'
          ? (err as { details: Record<string, unknown> }).details
          : {};
        const mustRetryOriginalRequest = errorDetails.recoveryAction === 'retry_request'
          || errorCode === 'MODEL_REPAIR_ATTEMPT_EXHAUSTED';
        const isNewRecovery = Boolean(
          failure.recovery
          && failure.recovery.recoveryRef !== recoveryOptions?.repair?.recoveryRef,
        );
        const retainedRecovery = mustRetryOriginalRequest
          ? undefined
          : isNewRecovery
            ? failure.recovery
            : recoveryOptions?.repair;
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          error: toErrorMessage(err),
          messages: conversation.messages.map((item) => item.id === userMessageId
            ? {
              ...item,
              failure: exhaustedManualRepair
                ? { ...failure, recovery: retainedRecovery }
                : failure,
            }
            : item),
        }));
      }
    } finally {
      clearPendingStatus(conversationId);
      if (!startedRun) setIsWorking(false);
      sendInFlightRef.current = false;
      if (activeChatRequestRef.current?.requestId === chatRequestId) activeChatRequestRef.current = null;
      setActiveChatRequestId((current) => current === chatRequestId ? null : current);
      setStoppingChatRequestId((current) => current === chatRequestId ? null : current);
    }
  };

  const initializeNovelProject = (artifact: AgentArtifact) => {
    const rawDraft = artifact.metadata?.draft;
    if (!rawDraft || typeof rawDraft !== 'object' || Array.isArray(rawDraft)) {
      toast.error('当前小说项目蓝图缺少可初始化的数据。');
      return;
    }
    void sendChat(
      '基于已确认的小说项目蓝图，为当前项目生成故事线、情节点、角色、物品、技能、世界设定和地图的可审核初始化草稿。',
      undefined,
      {
        entryHint: {
          actionId: 'novel.project_initialize',
          kind: 'operation',
          operationIds: ['novel.project_initialize'],
          deliverable: 'creative_assets_draft',
          suggestedToolchainId: 'novel.project_initialize',
        },
        initialization: {
          bootstrapArtifactId: artifact.artifactId,
          bootstrapDraft: rawDraft as Record<string, unknown>,
        },
      },
    );
  };

  const cancelActiveChat = useCallback(async () => {
    const active = activeChatRequestRef.current;
    if (!active || active.cancelled) return;
    active.cancelled = true;
    setStoppingChatRequestId(active.requestId);
    clearPendingStatus(active.conversationId);
    try {
      await window.agent.cancelChat({ requestId: active.requestId });
      const existing = liveChatActivitiesRef.current?.conversationId === active.conversationId
        ? liveChatActivitiesRef.current.events
        : [];
      const activities = existing.some((event) => event.type === 'request_cancelled') ? existing : [...existing, {
        eventId: nowId('activity'),
        sequence: (existing.at(-1)?.sequence ?? 0) + 1,
        requestId: active.requestId,
        type: 'request_cancelled' as const,
        stage: 'finalization' as const,
        displayName: '请求已取消',
        status: 'cancelled' as const,
        createdAt: new Date().toISOString(),
      }];
      appendMessage(active.conversationId, {
        role: 'assistant',
        kind: 'workflow_notice',
        content: '请求已取消。',
        activities,
      });
      setLiveChatActivities((current) => current?.conversationId === active.conversationId ? null : current);
    } catch (error) {
      if (!isCancelledError(error)) toast.error(toErrorMessage(error));
    }
  }, [appendMessage, clearPendingStatus]);

  const retryChatSummary = useCallback(async (message: ConversationMessage) => {
    if (!activeConversation || !message.evidenceSnapshotId || isWorking || sendInFlightRef.current) return;
    const conversationId = activeConversation.id;
    const requestId = nowId('chat_summary_retry');
    const deadlineAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    sendInFlightRef.current = true;
    activeChatRequestRef.current = { requestId, conversationId, cancelled: false };
    setActiveChatRequestId(requestId);
    setIsWorking(true);
    setPendingPhase(conversationId, 'finalizing');
    setLiveChatActivities({ conversationId, events: [] });
    try {
      const response = await window.agent.retryChatSummary({
        evidenceSnapshotId: message.evidenceSnapshotId,
        storageConversationId: conversationId,
        deadlineAt,
        context: contextPayload,
      }, { requestId });
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: new Date().toISOString(),
        messages: [...conversation.messages, {
          id: response.assistantMessage.messageId || nowId('msg'),
          role: 'assistant',
          kind: 'chat',
          content: response.assistantMessage.content,
          createdAt: response.assistantMessage.createdAt,
          contextReads: response.contextReads,
          contextDiagnostics: response.contextDiagnostics,
          activities: response.activities,
          failure: response.failure,
          evidenceSnapshotId: response.evidenceSnapshotId,
        }],
      }));
    } catch (error) {
      if (!activeChatRequestRef.current?.cancelled) {
        updateConversation(conversationId, (conversation) => ({ ...conversation, error: toErrorMessage(error) }));
      }
    } finally {
      clearPendingStatus(conversationId);
      setLiveChatActivities((current) => current?.conversationId === conversationId ? null : current);
      setIsWorking(false);
      sendInFlightRef.current = false;
      if (activeChatRequestRef.current?.requestId === requestId) activeChatRequestRef.current = null;
      setActiveChatRequestId((current) => current === requestId ? null : current);
      setStoppingChatRequestId((current) => current === requestId ? null : current);
    }
  }, [activeConversation, clearPendingStatus, contextPayload, isWorking, setPendingPhase, updateConversation]);

  const submitApproval = async (approval: { checkpointId: string }, selectedOptionIds: string[], freeText: string) => {
    if (!activeConversation || !activeRun) return;
    const conversationId = activeConversation.id;
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    try {
      const nextRun = await window.agent.submitApproval({
        runId: activeRun.runId,
        checkpointId: approval.checkpointId,
        selectedOptionIds,
        freeText,
        context: contextPayload,
      });
      updateConversation(conversationId, (conversation) => (
        conversation.run?.runId === nextRun.runId
          ? withCurrentRun(conversation, {
            ...conversation.run,
            status: nextRun.status,
            pendingApproval: nextRun.pendingApproval ?? null,
            approvalResponses: nextRun.approvalResponses ?? conversation.run.approvalResponses,
          })
          : conversation
      ));
      const draftKey = `${activeRun.runId}:${approval.checkpointId}`;
      setApprovalCardDrafts((current) => {
        if (!(draftKey in current)) return current;
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
      setChapterBeatCardDrafts((current) => {
        if (!(draftKey in current)) return current;
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
    } catch (err) {
      setIsWorking(false);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(err),
      }));
    }
  };

  const submitUserInput = async (request: AgentUserInputRequest, answers: AgentUserInputAnswer[]) => {
    if (!activeConversation) return;
    const conversationId = activeConversation.id;
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    try {
      const resolution = await window.agent.submitUserInput({
        requestId: request.requestId,
        conversationId: request.conversationId,
        runId: request.runId,
        answers,
        context: contextPayload,
      });
      updateConversation(conversationId, (conversation) => {
        const resolutions = conversation.userInputResolutions ?? [];
        const nextResolutions = resolutions.some((item) => item.requestId === resolution.requestId)
          ? resolutions
          : [...resolutions, resolution];
        let next: AgentConversation = {
          ...conversation,
          pendingUserInput: resolution.pendingUserInput
            ?? (conversation.pendingUserInput?.requestId === request.requestId
              ? null
              : conversation.pendingUserInput),
          userInputResolutions: nextResolutions,
          updatedAt: new Date().toISOString(),
        };
        if (resolution.plan) {
          next = {
            ...next,
            plan: resolution.plan,
            run: null,
            messages: [
              ...next.messages,
              {
                id: nowId('msg'),
                role: 'assistant',
                kind: 'workflow_notice',
                content: `已根据你的回答生成计划草稿：${resolution.plan.title}。`,
                createdAt: new Date().toISOString(),
              },
            ],
          };
        } else if (resolution.run && conversation.run?.runId === resolution.run.runId) {
          next = withCurrentRun(next, {
            ...conversation.run,
            ...resolution.run,
            events: conversation.run.events,
            pendingUserInput: null,
          });
        }
        return next;
      });
      setUserInputCardDrafts((current) => {
        const keys = Object.keys(current).filter((key) => key.endsWith(`:${request.requestId}`));
        if (keys.length === 0) return current;
        const next = { ...current };
        keys.forEach((key) => delete next[key]);
        return next;
      });
      setIsWorking(resolution.nextAction === 'run_resumed');
    } catch (err) {
      setIsWorking(false);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(err),
      }));
    }
  };

  const dismissUserInput = async (request: AgentUserInputRequest) => {
    if (!activeConversation || isWorking) return;
    const conversationId = activeConversation.id;
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    try {
      const resolution = await window.agent.dismissUserInput({
        requestId: request.requestId,
        conversationId: request.conversationId,
        runId: request.runId,
        context: contextPayload,
      });
      updateConversation(conversationId, (conversation) => {
        const resolutions = conversation.userInputResolutions ?? [];
        const nextResolutions = resolutions.some((item) => item.requestId === resolution.requestId)
          ? resolutions
          : [...resolutions, resolution];
        let next: AgentConversation = {
          ...conversation,
          pendingUserInput: conversation.pendingUserInput?.requestId === request.requestId
            ? null
            : conversation.pendingUserInput,
          userInputResolutions: nextResolutions,
          updatedAt: new Date().toISOString(),
        };
        if (resolution.run && conversation.run?.runId === resolution.run.runId) {
          next = withCurrentRun(next, {
            ...conversation.run,
            ...resolution.run,
            events: conversation.run.events,
            pendingUserInput: null,
          });
        }
        return next;
      });
      setUserInputCardDrafts((current) => {
        const keys = Object.keys(current).filter((key) => key.endsWith(`:${request.requestId}`));
        if (keys.length === 0) return current;
        const next = { ...current };
        keys.forEach((key) => delete next[key]);
        return next;
      });
      setIsWorking(false);
    } catch (err) {
      setIsWorking(false);
      updateConversation(conversationId, (conversation) => ({ ...conversation, error: toErrorMessage(err) }));
    }
  };

  const startRevisionBatch = async (artifact: AgentArtifact, findingIds: string[]) => {
    if (!activeConversation || isWorking) throw new Error('当前已有任务执行中，请稍后再试。');
    const report = getExpertReport(artifact);
    if (!report) throw new Error('综合审核报告已失效，请重新生成后再试。');
    const selected = report.findings.filter((finding) => findingIds.includes(finding.findingId));
    if (!selected.length) throw new Error('请至少选择一项修改建议。');

    const orderedChapterIds = volumes.flatMap((volume) => volume.chapters.map((chapter) => chapter.id));
    const targetChapterIds = [...new Set(selected.flatMap((finding) => finding.chapterIds))]
      .filter((chapterId) => orderedChapterIds.includes(chapterId))
      .sort((left, right) => orderedChapterIds.indexOf(left) - orderedChapterIds.indexOf(right));
    if (targetChapterIds.length === 0 && currentChapter?.id) targetChapterIds.push(currentChapter.id);
    if (targetChapterIds.length === 0) throw new Error('所选建议没有可用的目标章节。');
    if (targetChapterIds.length > 5) throw new Error('当前对话一次最多修改 5 章，请减少所选建议后重试。');

    const anchorChapterId = targetChapterIds[0];
    const targetVolume = volumes.find((volume) => volume.chapters.some((chapter) => chapter.id === anchorChapterId));
    const nextScope: AgentChapterScopeSelection = {
      kind: 'selected_chapters',
      ...(targetVolume ? { volumeId: targetVolume.id } : {}),
      chapterIds: targetChapterIds,
      anchorChapterId,
      processingMode: 'detailed',
      experts: ['editor'],
    };
    const nextScopePayload = chapterScopePayload(nextScope);
    const goal = [
      '根据综合审核中已确认的建议，在当前对话执行多章节批量改写并生成可审核草稿。',
      '这是完整替换改写，不要再次要求普通计划审批；正文写回仍必须等待用户最终确认。',
      ...selected.map((finding, index) => (
        `${index + 1}. ${finding.title}：${finding.recommendation || finding.summary}`
      )),
      `目标章节：${targetChapterIds.join('、')}`,
    ].join('\n');
    const conversationId = activeConversation.id;
    const revisionItems = selected.map((finding) => ({
      findingId: finding.findingId,
      title: finding.title,
      summary: finding.recommendation || finding.summary,
      chapterIds: finding.chapterIds,
    }));
    setPendingRevisionBatch({
      conversationId,
      plan: {
        planId: `pending_revision_${Date.now()}`,
        threadId: activeConversation.runtimeConversationId || activeConversation.id,
        title: '当前对话修订',
        goal,
        requiresApproval: false,
        preferredRole: 'writer',
        deliverable: targetChapterIds.length > 1 ? 'chapter_draft_batch' : 'chapter_draft',
        interactionMode: 'revision_batch',
        revisionItems,
        sourceArtifactId: artifact.artifactId,
        sourceConversationId: conversationId,
        steps: [{
          stepId: 'prepare_revision',
          agent: 'writer',
          title: '正在整理修订步骤',
          tools: [],
          status: 'pending',
        }],
      },
    });
    const nextContext = {
      ...contextPayload,
      ...(targetVolume ? { volumeId: targetVolume.id } : {}),
      chapterId: anchorChapterId,
      chapterScope: nextScopePayload,
    };

    setIsWorking(true);
    setChapterScope(nextScope);
    setSelectedRole('writer');
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    const currentContent = getCurrentContentSnapshot().content;
    try {
      const generatedPlan = await window.agent.plan({
        novelId,
        chapterId: anchorChapterId,
        goal,
        currentContent,
        locale,
        role: 'writer',
        approvalMode,
        chapterScope: nextScopePayload,
        context: nextContext,
      });
      const hasDraftStep = generatedPlan.steps.some((step) => step.toolchain?.id === 'chapter.batch_rewrite');
      if (!hasDraftStep) {
        throw new Error('未能生成可执行的章节改写计划，请缩小范围或调整建议后重试。');
      }
      const revisionPlan: RevisionBatchPlan = {
        ...generatedPlan,
        interactionMode: 'revision_batch',
        revisionItems,
        sourceArtifactId: artifact.artifactId,
        sourceConversationId: conversationId,
      };
      setPendingRevisionBatch(null);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: new Date().toISOString(),
        plan: revisionPlan,
        run: null,
      }));

      const nextRun = await window.agent.executePlan({
        planId: revisionPlan.planId,
        threadId: revisionPlan.threadId,
        novelId,
        ...(targetVolume ? { volumeId: targetVolume.id } : {}),
        chapterId: anchorChapterId,
        currentContent,
        locale,
        approval: { approved: true, approvedStepIds: revisionPlan.steps.map((step) => step.stepId) },
        approvalMode,
        context: nextContext,
      });
      activeRunIdRef.current = nextRun.runId;
      lastSequenceRef.current = 0;
      lastSequenceByRunRef.current.set(nextRun.runId, 0);
      updateConversation(conversationId, (conversation) => withCurrentRun(conversation, {
        ...nextRun,
        events: [],
        planSnapshot: revisionPlan,
      }));
      await subscribeRun(nextRun.runId);
      scrollToLatest();
    } catch (error) {
      const message = toErrorMessage(error);
      setPendingRevisionBatch(null);
      updateConversation(conversationId, (conversation) => ({ ...conversation, error: message }));
      setIsWorking(false);
      await syncRevisionPlanOutcome(conversationId, {
        planId: `failed_revision_${Date.now()}`,
        threadId: activeConversation.runtimeConversationId || activeConversation.id,
        title: '当前对话修订',
        goal,
        requiresApproval: false,
        preferredRole: 'writer',
        steps: [],
        interactionMode: 'revision_batch',
        revisionItems,
        sourceArtifactId: artifact.artifactId,
        sourceConversationId: conversationId,
      }, 'failed').catch((syncError) => {
        console.warn('[AgentWorkspace] Failed to recover revision tasks after startup failure:', syncError);
      });
      throw error;
    }
  };

  const executePlan = async () => {
    if (!activeConversation || !activePlan || isWorking) return;
    const conversationId = activeConversation.id;
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    const currentContent = getCurrentContentSnapshot().content;
    try {
      const nextRun = await window.agent.executePlan({
        planId: activePlan.planId,
        threadId: activePlan.threadId,
        novelId,
        volumeId: currentChapter?.volumeId,
        chapterId: currentChapter?.id,
        currentContent,
        locale,
        approval: { approved: true, approvedStepIds: activePlan.steps.map((step) => step.stepId) },
        approvalMode,
        context: contextPayload,
      });
      activeRunIdRef.current = nextRun.runId;
      lastSequenceRef.current = 0;
      lastSequenceByRunRef.current.set(nextRun.runId, 0);
      updateConversation(conversationId, (conversation) => withCurrentRun(conversation, {
        ...nextRun,
        events: [],
        planSnapshot: activePlan,
      }));
      await subscribeRun(nextRun.runId);
    } catch (err) {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(err),
      }));
      setIsWorking(false);
    }
  };

  const regenerateDraftBatch = async (
    batch: DraftBatchRecord,
    fromChildIndex: number,
    reviewComments: ReviewCommentRecord[] = [],
  ) => {
    if (!activeConversation || isWorking) return;
    const conversationId = activeConversation.id;
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    const currentContent = getCurrentContentSnapshot().content;
    const regenerationChapterLabel = resolveDraftBatchChapterDisplay(batch, fromChildIndex, volumes).shortLabel;
    try {
      const nextRun = await window.agent.regenerateBatch({
        draftBatchId: batch.draftBatchId,
        version: batch.version,
        fromChildIndex,
        confirmed: true,
        threadId: activeRun?.threadId ?? activePlan?.threadId,
        currentContent,
        locale,
        ...(reviewComments.length ? {
          goal: [
            `从${regenerationChapterLabel}开始重新生成，并保留此前已审核草稿。`,
            '必须逐条落实以下审批意见；未被指出的内容尽量保持：',
            formatReviewCommentsForConversation(reviewComments),
          ].join('\n'),
        } : {}),
        context: contextPayload,
      });
      const approvedStepIds = nextRun.events.flatMap((event) => (
        event.type === 'plan_approved' && Array.isArray(event.payload.approvedStepIds)
          ? event.payload.approvedStepIds.filter((value): value is string => typeof value === 'string')
          : []
      ));
      const stepId = approvedStepIds[0] ?? nextRun.currentStepId ?? nowId('step');
      const isRewriteBatch = batch.mode === 'batch_rewrite';
      const regenerationLabel = isRewriteBatch ? '多章节改写草稿' : '多章节草稿';
      const regenerationPlan: AgentPlan = {
        planId: nextRun.planId,
        threadId: nextRun.threadId,
        title: `重新生成${regenerationLabel}（从${regenerationChapterLabel}）`,
        goal: reviewComments.length
          ? `根据 ${reviewComments.length} 条审批意见，从${regenerationChapterLabel}开始重新生成。`
          : `从${regenerationChapterLabel}开始重新生成，并保留此前已审核草稿。`,
        requiresApproval: true,
        preferredRole: 'writer',
        deliverable: 'chapter_draft_batch',
        steps: [{
          stepId,
          agent: 'writer',
          title: `从${regenerationChapterLabel}重新生成${isRewriteBatch ? '改写' : '批次'}草稿`,
          tools: [],
          toolchain: {
            id: isRewriteBatch ? 'chapter.batch_rewrite' : 'chapter.sequence_continuation',
            version: '1.0.0',
            input: {
              resumeBatchId: batch.draftBatchId,
              resumeBatchVersion: batch.version,
              startChildIndex: fromChildIndex,
              ...(isRewriteBatch ? {
                kind: 'selected_chapters',
                chapterIds: batch.children
                  .map((child) => child.targetChapterId)
                  .filter((chapterId): chapterId is string => Boolean(chapterId)),
              } : {}),
            },
          },
          status: 'pending',
        }],
      };
      activeRunIdRef.current = nextRun.runId;
      lastSequenceRef.current = 0;
      lastSequenceByRunRef.current.set(nextRun.runId, 0);
      updateConversation(conversationId, (conversation) => {
        const previousHistory = conversation.run
          ? mergeAgentRunHistory(conversation.runs, {
            ...conversation.run,
            planSnapshot: conversation.plan ?? conversation.run.planSnapshot,
          })
          : conversation.runs;
        const nextConversation = {
          ...conversation,
          plan: regenerationPlan,
          runs: previousHistory,
          updatedAt: new Date().toISOString(),
        };
        return withCurrentRun(nextConversation, {
          ...nextRun,
          events: [],
          planSnapshot: regenerationPlan,
        });
      });
      await subscribeRun(nextRun.runId);
    } catch (err) {
      setIsWorking(false);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(err),
      }));
      throw err;
    }
  };

  const discussReviewComments = async (comments: ReviewCommentRecord[]) => {
    if (!comments.length) return;
    await sendChat(formatReviewCommentsForConversation(comments));
  };

  const regenerateDraftFromReview = async (
    session: DraftSessionRecord,
    comments: ReviewCommentRecord[],
  ) => {
    if (!activeConversation || isWorking || !comments.length) return;
    const conversationId = activeConversation.id;
    const sourceArtifactId = selectedReviewRun?.artifacts?.find((artifact) => (
      artifact.reference?.draftSessionId === session.draftSessionId
    ))?.artifactId;
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    try {
      const reviewRequestId = nowId('review');
      const nextRun = await window.agent.reviseDraft({
        sourceDraftSessionId: session.draftSessionId,
        sourceDraftVersion: session.version,
        sourceArtifactId,
        reviewRequestId,
        comments,
        threadId: selectedReviewRun?.threadId ?? activePlan?.threadId,
        locale,
        context: contextPayload,
      });
      const approvedStepIds = nextRun.events.flatMap((event) => (
        event.type === 'plan_approved' && Array.isArray(event.payload.approvedStepIds)
          ? event.payload.approvedStepIds.filter((value): value is string => typeof value === 'string')
          : []
      ));
      const stepId = approvedStepIds[0] ?? nextRun.currentStepId ?? nowId('step');
      const isCreativeAssets = session.type === 'creative-assets';
      const regenerationPlan: AgentPlan = {
        planId: nextRun.planId,
        threadId: nextRun.threadId,
        title: isCreativeAssets ? '重新生成创作素材审核包' : '重新生成待审核版本',
        goal: `根据 ${comments.length} 条审批意见生成新的待审核版本。`,
        requiresApproval: true,
        preferredRole: 'writer',
        deliverable: isCreativeAssets ? 'creative_assets_draft' : 'chapter_draft',
        steps: [{
          stepId,
          agent: 'writer',
          title: isCreativeAssets ? '根据审批意见重新生成创作素材' : '根据审批意见重新生成草稿',
          tools: [isCreativeAssets ? 'creative_assets.revise_draft' : 'chapter.revise_draft'],
          status: 'pending',
        }],
      };
      activeRunIdRef.current = nextRun.runId;
      lastSequenceRef.current = 0;
      lastSequenceByRunRef.current.set(nextRun.runId, 0);
      updateConversation(conversationId, (conversation) => {
        const previousHistory = conversation.run
          ? mergeAgentRunHistory(conversation.runs, {
            ...conversation.run,
            planSnapshot: conversation.plan ?? conversation.run.planSnapshot,
          })
          : conversation.runs;
        return withCurrentRun({
          ...conversation,
          plan: regenerationPlan,
          runs: previousHistory,
          updatedAt: new Date().toISOString(),
        }, {
          ...nextRun,
          events: [],
          planSnapshot: regenerationPlan,
        });
      });
      setSelectedReviewRunId(null);
      await subscribeRun(nextRun.runId);
    } catch (error) {
      setIsWorking(false);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(error),
      }));
      throw error;
    }
  };

  const cancelRun = async (): Promise<boolean> => {
    const runId = activeRunIdRef.current;
    if (
      !runId
      || !activeConversation
      || !activeRun
      || !['running', 'waiting_approval', 'waiting_user_input'].includes(activeRun.status)
      || activeRun.draftOperationStatus === 'committing'
    ) return false;
    const conversationId = activeConversation.id;
    const previousStatus = activeRun.status;
    updateConversation(conversationId, (conversation) => (
      conversation.run?.runId === runId
        ? withCurrentRun(conversation, { ...conversation.run, status: 'cancelling', cancelRequested: true })
        : conversation
    ));
    try {
      const nextRun = await window.agent.cancel({ runId });
      updateConversation(conversationId, (conversation) => (
        conversation.run?.runId === runId
          ? withCurrentRun(conversation, {
            ...conversation.run,
            status: nextRun.status,
            cancelRequested: nextRun.status === 'cancelling' || nextRun.status === 'cancelled',
          })
          : conversation
      ));
      return true;
    } catch (err) {
      updateConversation(conversationId, (conversation) => {
        const restored = conversation.run?.runId === runId
          ? withCurrentRun(conversation, { ...conversation.run, status: previousStatus, cancelRequested: false })
          : conversation;
        return { ...restored, error: `无法取消，请稍后重试：${toErrorMessage(err)}` };
      });
      return false;
    }
  };

  const stopActiveTask = () => {
    if (composerAction.disabled) return;
    if (composerAction.target === 'run') {
      void cancelRun();
      return;
    }
    if (composerAction.target === 'chat') void cancelActiveChat();
  };

  const renderStepStatus = (status: AgentStepStatus) => {
    const label = status === 'completed' ? '完成'
      : status === 'running' ? '执行中'
        : status === 'failed' ? '失败'
          : status === 'skipped' ? '跳过'
            : '待执行';
    return (
      <span className={clsx(
        'text-[11px] px-1.5 py-0.5 rounded',
        status === 'completed'
          ? 'bg-[#e8f2ff] text-[#2f80ed]'
          : status === 'running'
            ? 'bg-[#fff7e6] text-[#ad6800]'
            : status === 'failed'
              ? 'bg-red-50 text-red-700'
              : (isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]'),
      )}>
        {label}
      </span>
    );
  };

  const runtimeHealth = isRuntimeRecoveryPending
    ? { text: '正在恢复 Runtime', tone: 'loading' as const }
    : runtimeHealthPresentation(health);
  const selectedReportReviewAvailability = resolveReportReviewAvailability({
    runStatus: selectedReviewRun?.status,
    workspaceBusy: isWorking,
    runtimeRecoveryPending: isRuntimeRecoveryPending,
    planPending: Boolean(activePlan && !activeRun),
  });
  const inspectorVisible = inspectorOpen && workspaceView === 'conversation';
  const draftReviewInspectorVisible = inspectorVisible
    && inspectorTab === 'review'
    && reviewTarget === 'draft'
    && Boolean(selectedReviewRun?.draftSessionId || selectedReviewRun?.draftBatchId);
  const inspectorLeftRailWidth = viewportWidth > 1180 ? 300 : 0;
  const effectiveInspectorWidth = Math.max(
    INSPECTOR_DEFAULT_WIDTH,
    Math.min(inspectorWidth, 900, Math.floor(viewportWidth * 0.65), viewportWidth - inspectorLeftRailWidth - 420),
  );

  if (!isVisible) return null;

  return (
    <div
      style={{ '--agent-inspector-width': `${effectiveInspectorWidth}px` } as React.CSSProperties}
      className={clsx(
      'relative h-full min-h-0 grid overflow-hidden max-[1040px]:grid-cols-1',
      inspectorVisible
        ? inspectorExpanded
          ? 'grid-cols-[300px_0_minmax(0,1fr)] max-[1180px]:grid-cols-[0_minmax(0,1fr)]'
          : 'grid-cols-[300px_minmax(0,1fr)_var(--agent-inspector-width)] max-[1180px]:grid-cols-[minmax(0,1fr)_var(--agent-inspector-width)]'
        : 'grid-cols-[300px_minmax(0,1fr)] max-[1180px]:grid-cols-1',
      isDark ? 'bg-[#0a0a0f] text-neutral-100' : 'bg-[var(--ui-canvas)] text-[var(--ui-text-primary)]',
      )}
    >
      {conversationDrawerOpen && (
        <button
          type="button"
          className="absolute inset-0 z-30 bg-black/20 min-[1181px]:hidden"
          onClick={() => setConversationDrawerOpen(false)}
          aria-label="关闭会话导航"
        />
      )}
      <aside className={clsx(
        'border-r flex flex-col min-h-0 min-w-0 max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:left-0 max-[1180px]:z-40 max-[1180px]:w-[300px] max-[1180px]:shadow-[16px_0_40px_rgba(17,24,39,0.12)]',
        !conversationDrawerOpen && 'max-[1180px]:hidden',
        isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]',
      )}>
        <div className="p-4 border-b border-inherit">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className={clsx('h-8 w-8 rounded-md grid place-items-center shrink-0', isDark ? 'bg-white/10' : 'bg-white border border-[var(--ui-border)]')}>
                <Bot className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">Agent 创作</div>
                <div
                  className={clsx(
                    'flex items-center gap-1 text-xs min-w-0',
                    runtimeHealth.tone === 'ready'
                      ? 'text-[#2f80ed]'
                      : runtimeHealth.tone === 'failed'
                        ? 'text-red-500'
                        : (isDark ? 'text-amber-300' : 'text-amber-700'),
                  )}
                  title={runtimeHealth.tone === 'failed' ? health?.message : runtimeHealth.text}
                >
                  {runtimeHealth.tone === 'loading' && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
                  <span className="truncate">{runtimeHealth.text}</span>
                  {runtimeHealth.tone === 'failed' && health?.data?.canManualRetry && (
                    <button
                      type="button"
                      className={clsx(
                        'h-5 w-5 shrink-0 rounded grid place-items-center disabled:opacity-40',
                        isDark ? 'hover:bg-white/10' : 'hover:bg-red-100',
                      )}
                      onClick={() => void retryRuntime()}
                      disabled={isRuntimeRecoveryPending}
                      title="重试 Runtime"
                      aria-label="重试 Runtime"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={createConversation}
                disabled={isConversationsLoading}
                className={clsx('h-8 w-8 rounded-md grid place-items-center border', isDark ? 'border-white/10 hover:bg-white/5' : 'border-[var(--ui-border)] bg-white hover:bg-[var(--ui-surface-subtle)]')}
                title="新建会话"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setConversationDrawerOpen(false)}
                className={clsx('hidden h-8 w-8 place-items-center rounded-md max-[1180px]:grid', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white')}
                title="收起会话导航"
                aria-label="收起会话导航"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className={clsx('mt-4 h-9 rounded-md border px-2 flex items-center gap-2', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
            <Search className={clsx('h-4 w-4 shrink-0', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')} />
            <input
              value={conversationSearch}
              onChange={(event) => setConversationSearch(event.target.value)}
              placeholder="搜索会话"
              className={clsx('min-w-0 flex-1 bg-transparent text-sm outline-none', isDark ? 'placeholder:text-neutral-600' : 'placeholder:text-[var(--ui-text-disabled)]')}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setWorkspaceView('revision_tasks');
              setConversationDrawerOpen(false);
            }}
            className={clsx(
              'mt-3 h-9 w-full rounded-md px-2.5 flex items-center gap-2 text-sm transition-colors',
              workspaceView === 'revision_tasks'
                ? (isDark ? 'bg-white/10 text-white' : 'bg-white text-[var(--ui-text-primary)] shadow-[0_1px_4px_rgba(0,0,0,0.06)]')
                : (isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white/60'),
            )}
          >
            <ClipboardList className="h-4 w-4 text-[#2f80ed]" />
             <span className="min-w-0 flex-1 text-left">待改清单</span>
             {revisionTaskCount > 0 && (
               <span className={clsx('min-w-5 rounded px-1.5 py-0.5 text-center text-[10px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[#e8f2ff] text-[#2f80ed]')}>
                 {revisionTaskCount > 99 ? '99+' : revisionTaskCount}
               </span>
             )}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
          {isConversationsLoading ? (
            <div className={clsx('flex items-center justify-center gap-2 px-3 py-5 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-disabled)]')} role="status" aria-live="polite">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span>加载会话</span>
            </div>
          ) : filteredConversations.map((conversation) => (
            <div
              key={conversation.id}
              className={clsx(
                'w-full rounded-lg border p-3 text-left transition-colors',
                activeConversationId === conversation.id
                  ? (isDark ? 'border-white/15 bg-white/10' : 'border-[var(--ui-border-strong)] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.04)]')
                  : (isDark ? 'border-transparent hover:bg-white/5' : 'border-transparent hover:bg-white/60'),
              )}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setActiveConversationId(conversation.id);
                    setSelectedRole(conversation.role);
                     setInspectorTab(conversation.run?.draftSessionId || conversation.run?.draftBatchId ? 'review' : 'context');
                     setWorkspaceView('conversation');
                     setConversationDrawerOpen(false);
                   }}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium truncate">{conversation.title}</div>
                    <span className={clsx('shrink-0 rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
                      {roleLabel(conversation.role)}
                    </span>
                  </div>
                  <div className={clsx('mt-1 text-xs leading-5 line-clamp-2', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{conversation.description}</div>
                  <div className={clsx('mt-2 text-[11px]', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>{formatConversationTime(conversation.updatedAt)}</div>
                </button>
                <button
                  type="button"
                  onClick={() => void deleteConversation(conversation.id)}
                  disabled={conversations.length <= 1}
                  className={clsx('h-7 w-7 rounded-md grid place-items-center shrink-0 disabled:opacity-30', isDark ? 'text-neutral-500 hover:bg-white/5 hover:text-neutral-200' : 'text-[var(--ui-text-disabled)] hover:bg-[var(--ui-surface-muted)] hover:text-[var(--ui-text-primary)]')}
                  title="删除会话"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
          {!isConversationsLoading && filteredConversations.length === 0 && (
            <div className={clsx('rounded-lg border p-3 text-sm leading-6', isDark ? 'border-white/10 text-neutral-500' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-muted)]')}>
              没有匹配的会话。
            </div>
          )}
        </div>

        <div className={clsx('border-t p-4 text-xs space-y-1.5', isDark ? 'border-white/10 text-neutral-500' : 'border-[var(--ui-border)] text-[var(--ui-text-muted)]')}>
          <div className="truncate">小说：<span className={isDark ? 'text-neutral-200' : 'text-[var(--ui-text-primary)]'}>{novel?.title || '未命名小说'}</span></div>
          <div className="truncate">章节：<span className={isDark ? 'text-neutral-200' : 'text-[var(--ui-text-primary)]'}>{currentChapter?.title || '未选择章节'}</span></div>
        </div>
      </aside>

      {workspaceView === 'revision_tasks' ? (
        <RevisionTaskWorkspace
          novelId={novelId}
          volumes={volumes}
          isDark={isDark}
          refreshKey={revisionTaskRefreshKey}
          onContinue={continueRevisionTask}
          onReturnToConversation={() => setWorkspaceView('conversation')}
          onOpenNavigation={() => setConversationDrawerOpen(true)}
          onPendingCountChange={setRevisionTaskCount}
        />
      ) : (
      <>
      <main className="min-h-0 min-w-0 flex flex-col">
        <div className={clsx('h-14 border-b px-6 flex items-center justify-between', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          <div className="min-w-0 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setInspectorDrawerOpen(false);
                setConversationDrawerOpen(true);
              }}
              className={clsx('hidden h-8 w-8 shrink-0 place-items-center rounded-md max-[1180px]:grid', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white')}
              title="打开会话导航"
              aria-label="打开会话导航"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{activeConversation?.title}</div>
              <div className={clsx('text-xs truncate', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                {roleLabel(activeConversation?.role ?? 'team')}模式 · 计划和执行记录保留在当前会话流中
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isWorking && <Loader2 className="h-4 w-4 animate-spin text-[#2f80ed]" />}
            {!inspectorVisible && (
              <button
                type="button"
                onClick={() => setInspectorVisibility(true)}
                className={clsx('grid h-8 w-8 place-items-center rounded-md', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white')}
                title={t('agentWorkspace.inspector.open')}
                aria-label={t('agentWorkspace.inspector.open')}
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="relative flex-1 min-h-0">
          <div
            ref={conversationScrollRef}
            onScroll={handleConversationScroll}
            className="h-full overflow-y-auto px-8 py-6"
          >
            <div className="mx-auto w-full max-w-[880px] space-y-4">
            {activeTimeline.map((entry) => {
              if (entry.kind === 'resolution') {
                return (
                  <UserInputResolutionCard
                    key={entry.key}
                    resolution={entry.resolution as AgentUserInputResolution}
                    isDark={isDark}
                  />
                );
              }
              if (entry.kind === 'message') {
                const message = entry.message as ConversationMessage;
                return (
                  <Fragment key={entry.key}>
                    <MessageBubble
                      message={message}
                      attachments={attachments.filter((attachment) => message.attachmentIds?.includes(attachment.id))}
                      isDark={isDark}
                      onOpenAttachment={openAttachment}
                      onRetrySummary={(targetMessage) => void retryChatSummary(targetMessage)}
                      onReread={(targetMessage) => {
                        const messages = activeConversation?.messages ?? [];
                        const messageIndex = messages.findIndex((candidate) => candidate.id === targetMessage.id);
                        const source = [...messages.slice(0, messageIndex)].reverse().find((candidate) => candidate.role === 'user');
                        if (source) void sendChat(source.content);
                      }}
                    />
                    {message.role === 'assistant' && message.activities && message.activities.length > 0 && (
                      <ChatActivityCard activities={message.activities} isDark={isDark} />
                    )}
                  </Fragment>
                );
              }
              const timelineRun = entry.run as AgentRun | null;
              const timelinePlan = entry.plan as AgentPlan;
              const supportingArtifacts = (timelineRun?.artifacts ?? []).filter((artifact) => !getExpertReport(artifact));
              const consolidatedReportArtifact = timelineRun?.artifacts
                ? selectConsolidatedReportArtifact(timelineRun.artifacts)
                : null;
              const isRevisionBatch = isRevisionBatchPlan(timelinePlan);
              const chapterBeatTimeline = timelineRun ? projectChapterBeatTimeline(timelineRun) : [];
              const latestChapterBeatCheckpoint = [...chapterBeatTimeline].reverse().find((item) => item.kind === 'checkpoint');
              const effectiveDraftBatchId = timelineRun?.draftBatchId
                || timelineRun?.pendingApproval?.draftBatchId
                || (latestChapterBeatCheckpoint?.kind === 'checkpoint' ? latestChapterBeatCheckpoint.approval.draftBatchId : undefined);
              const draftBatchRecord = effectiveDraftBatchId ? draftBatchRecords[effectiveDraftBatchId] ?? null : null;
              const draftBatchConversationState = timelineRun ? projectDraftBatchConversationState({
                run: timelineRun,
                batch: draftBatchRecord,
                chapterBeatTimeline,
              }) : null;
              const batchActivity = timelineRun ? projectAgentActivity(timelineRun) : null;
              const isActiveTask = timelineRun
                ? activeRun?.runId === timelineRun.runId
                : activePlan?.planId === timelinePlan.planId && !activeRun;
              const reportReviewAvailability = resolveReportReviewAvailability({
                runStatus: timelineRun?.status,
                workspaceBusy: isWorking,
                runtimeRecoveryPending: isRuntimeRecoveryPending,
                planPending: Boolean(activePlan && !activeRun),
              });
              const timelineResolutions = entry.resolutions as AgentUserInputResolution[];
              const prePlanResolutions = timelineResolutions.filter((resolution) => resolution.phase === 'pre_plan');
              const executionResolutions = timelineResolutions.filter((resolution) => resolution.phase === 'execution');
              return (
                <Fragment key={entry.key}>
                  {prePlanResolutions.map((resolution) => (
                    <UserInputResolutionCard
                      key={resolution.requestId}
                      resolution={resolution}
                      isDark={isDark}
                    />
                  ))}
                  {isRevisionBatch ? (
                    !draftBatchConversationState ? (
                      <RevisionProgressCard
                        plan={timelinePlan}
                        run={timelineRun}
                        isDark={isDark}
                        interactive={isActiveTask}
                        isWorking={isWorking}
                        onRetry={() => { if (timelineRun) void retryFailedRun(timelineRun); }}
                      />
                    ) : null
                  ) : (
                    <PlanCard
                      plan={timelinePlan}
                      run={timelineRun}
                      interactive={isActiveTask}
                      isDark={isDark}
                      isWorking={isWorking}
                      renderStepStatus={renderStepStatus}
                      onExecute={() => void executePlan()}
                      onIgnore={ignorePlan}
                      onSubmitRevision={(revision) => void submitPlanRevision(revision)}
                    />
                  )}
                  {executionResolutions.map((resolution) => (
                    <UserInputResolutionCard
                      key={resolution.requestId}
                      resolution={resolution}
                      isDark={isDark}
                    />
                  ))}
                  {timelineRun && draftBatchConversationState ? (
                    <DraftBatchProgressCard
                      key={draftBatchConversationState.stableKey}
                      state={draftBatchConversationState}
                      batch={draftBatchRecord}
                      volumes={volumes}
                      runStatus={timelineRun.status}
                      isDark={isDark}
                      interactive={isActiveTask}
                      isWorking={isWorking}
                      draft={chapterBeatCardDrafts[draftBatchConversationState.stableKey]}
                      revisionItems={isRevisionBatch ? timelinePlan.revisionItems.map((item) => ({ id: item.findingId, title: item.title })) : undefined}
                      activitySummary={batchActivity?.summary}
                      activityDetails={batchActivity?.details}
                      onDraftChange={(draft) => setChapterBeatCardDrafts((current) => ({
                        ...current,
                        [draftBatchConversationState.stableKey]: draft,
                      }))}
                      onSubmit={(approval, selectedOptionIds, freeText) => void submitApproval(approval, selectedOptionIds, freeText)}
                      onDismiss={() => void cancelRun()}
                      onOpenSnapshot={(snapshot, historical) => openBeatSnapshot(timelineRun.runId, snapshot, historical)}
                      onOpenCurrent={(view) => {
                        if (draftBatchConversationState.draftBatchId) {
                          openDraftBatchInspector(timelineRun.runId, draftBatchConversationState.draftBatchId, view);
                        }
                      }}
                      onRetry={() => void retryFailedRun(timelineRun)}
                    />
                  ) : timelineRun && !isRevisionBatch ? (
                    <AgentActivityStream
                      run={timelineRun}
                      plan={timelinePlan}
                      isDark={isDark}
                      interactive={isActiveTask}
                      isWorking={isWorking}
                      onRetry={() => void retryFailedRun(timelineRun)}
                      onReplan={() => prepareFailedRunReplan(timelinePlan)}
                    />
                  ) : null}
                  {timelineRun?.artifacts && consolidatedReportArtifact && (
                    <ConsolidatedReportCard
                      artifacts={timelineRun.artifacts}
                      isDark={isDark}
                      reviewAvailability={reportReviewAvailability}
                      onOpenDetails={() => openInspector('review', 'report', timelineRun.runId)}
                      onModifySelected={startRevisionBatch}
                      onReviewSubmitted={updateArtifactReview}
                    />
                  )}
                  {timelineRun && !isRevisionBatch && supportingArtifacts.length > 0 && (
                    <RunArtifactsCard
                      artifacts={supportingArtifacts}
                      isDark={isDark}
                      onOpen={() => openInspector('artifacts', undefined, timelineRun.runId)}
                    />
                  )}
                  {isActiveTask && activeApproval && activeApproval.checkpointType !== 'chapter_beats' && (
                    <ApprovalRequiredCard
                      approval={activeApproval}
                      isDark={isDark}
                      isWorking={isWorking}
                      draft={approvalCardDrafts[`${timelineRun?.runId ?? 'plan'}:${activeApproval.checkpointId}`]}
                      onDraftChange={(draft) => setApprovalCardDrafts((current) => ({
                        ...current,
                        [`${timelineRun?.runId ?? 'plan'}:${activeApproval.checkpointId}`]: draft,
                      }))}
                      onSubmit={(selectedOptionIds, freeText) => void submitApproval(activeApproval, selectedOptionIds, freeText)}
                      onDismiss={() => void cancelRun()}
                    />
                  )}
                  {isActiveTask && activeUserInput?.phase === 'execution' && activeUserInput.runId === timelineRun?.runId && (
                    <UserInputRequiredCard
                      request={activeUserInput}
                      isDark={isDark}
                      isWorking={isWorking}
                      draft={userInputCardDrafts[`${timelineRun?.runId ?? activeConversation.id}:${activeUserInput.requestId}`]}
                      onDraftChange={(draft) => setUserInputCardDrafts((current) => ({
                        ...current,
                        [`${timelineRun?.runId ?? activeConversation.id}:${activeUserInput.requestId}`]: draft,
                      }))}
                      onSubmit={(answers) => void submitUserInput(activeUserInput, answers)}
                      onDismiss={() => void dismissUserInput(activeUserInput)}
                    />
                  )}
                  {!timelineRun?.draftBatchId && timelineRun?.draftSessionId && (
                    <DraftCard
                      draftSessionId={timelineRun.draftSessionId}
                      kind={timelineRun.artifacts?.some((artifact) => (
                        artifact.type === 'creative_assets_draft'
                        && artifact.reference?.draftSessionId === timelineRun.draftSessionId
                      )) ? 'creative-assets' : 'chapter'}
                      isDark={isDark}
                      onOpenReview={() => openInspector('review', 'draft', timelineRun.runId)}
                    />
                  )}
                </Fragment>
              );
            })}

            {activeUserInput?.phase === 'pre_plan' && (
              <UserInputRequiredCard
                request={activeUserInput}
                isDark={isDark}
                isWorking={isWorking}
                draft={userInputCardDrafts[`${activeConversation?.id ?? 'conversation'}:${activeUserInput.requestId}`]}
                onDraftChange={(draft) => setUserInputCardDrafts((current) => ({
                  ...current,
                  [`${activeConversation?.id ?? 'conversation'}:${activeUserInput.requestId}`]: draft,
                }))}
                onSubmit={(answers) => void submitUserInput(activeUserInput, answers)}
                onDismiss={() => void dismissUserInput(activeUserInput)}
              />
            )}

            {pendingRevisionBatch?.conversationId === activeConversation?.id && (
              <RevisionProgressCard
                plan={pendingRevisionBatch.plan}
                run={null}
                isDark={isDark}
                interactive={false}
                isWorking={isWorking}
                onRetry={() => undefined}
              />
            )}

            {isAwaitingChatResponse && !(liveChatActivities?.conversationId === activeConversation?.id && liveChatActivities.events.length > 0) && (
              <ThinkingIndicator isDark={isDark} label={pendingStatusLabel} />
            )}
            {isAwaitingChatResponse && liveChatActivities?.conversationId === activeConversation?.id && liveChatActivities.events.length > 0 && (
              <ChatActivityCard activities={liveChatActivities.events} isDark={isDark} live />
            )}

            {recoverablePlanGoal && !activePlan && (
              <ActionCard
                isDark={isDark}
                title={isChapterTargetUnresolvedError(activeError) ? '目标章节解析可恢复' : '需要形成计划草稿吗？'}
                description={isChapterTargetUnresolvedError(activeError)
                  ? '聊天阶段的回答和章节目标均已保留。点击后会刷新章节目录并继续生成计划，不会重新请求刚才的聊天回答。'
                  : '当前回复可以使用只读项目上下文。形成计划草稿后可继续修改；确认后才会生成草稿或执行写回。'}
                actionLabel={activeError ? '重新生成计划草稿' : '生成计划草稿'}
                onAction={() => void createPlan(recoverablePlanGoal)}
                disabled={isWorking}
              />
            )}

            {recoverableChatMessage && (
              <ActionCard
                isDark={isDark}
                title={recoverableChatMessage.failure?.recovery ? '模型回答可安全恢复' : '本次对话可直接重试'}
                description={recoverableChatMessage.failure?.recovery
                  ? '先重新校验已保存结果；若仍不合格，只让模型修复 JSON 后继续，不会重新执行原问题。'
                  : '这条失败记录没有可用的模型结果引用。点击后会重新请求回答，但不会重复追加用户消息或要求你发送“重试”。'}
                actionLabel={recoverableChatMessage.failure?.recovery ? '修复 JSON 并继续' : '重新生成回答'}
                onAction={() => void sendChat(recoverableChatMessage.content, {
                  sourceMessage: recoverableChatMessage,
                  repair: recoverableChatMessage.failure?.recovery,
                })}
                disabled={isWorking}
              />
            )}

              {activeError && !(activeRun?.status === 'failed' && activeRun.events.some((event) => event.type === 'run_failed')) && (
                <div className={clsx('rounded-lg border px-3 py-2 text-sm flex gap-2', isDark ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700')}>
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{toErrorMessage(activeError)}</span>
                </div>
              )}
            </div>
          </div>
          {!followsLatest && !inspectorExpanded && !draftReviewInspectorVisible && (
            <button
              type="button"
              onClick={scrollToLatest}
              className={clsx(
                'absolute bottom-4 left-1/2 z-10 h-9 -translate-x-1/2 rounded-md border px-3 inline-flex items-center gap-2 text-sm shadow-md',
                isDark
                  ? 'border-white/15 bg-[#1b1b21] text-neutral-200 hover:bg-[#24242b] shadow-black/30'
                  : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)] shadow-black/10',
              )}
            >
              <ArrowDown className="h-4 w-4" />
              查看最新
            </button>
          )}
        </div>

        <div className={clsx('border-t p-4', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          <div className={clsx('relative mx-auto max-w-[880px] rounded-lg border p-2', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
            {agentSkillMenuOpen && agentSkillSlashQuery && (
              <AgentSkillSlashMenu
                skills={agentSkills}
                query={agentSkillSlashQuery.query}
                activeItem={agentSkillMenuItems[activeSkillMenuIndex]}
                isDark={isDark}
                onSelect={selectAgentSkillMenuItem}
              />
            )}
            {pendingAttachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5 px-1">
                {pendingAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className={clsx(
                      'inline-flex h-7 max-w-full items-center gap-1.5 rounded border px-2 text-xs',
                      isDark ? 'border-white/10 bg-white/5 text-neutral-300' : 'border-[var(--ui-border)] bg-[var(--ui-surface-muted)] text-[var(--ui-text-secondary)]',
                    )}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <button type="button" className="truncate" onClick={() => void openAttachment(attachment.id)}>
                      {attachment.originalFileName}
                    </button>
                    <span className="shrink-0 opacity-60">{attachment.characterCount.toLocaleString()} 字</span>
                    <button
                      type="button"
                      className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-black/10"
                      onClick={() => void removePendingAttachment(attachment.id)}
                      title="移除附件"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {activeAgentSkillMode && (
              <div className="mb-1.5 flex flex-wrap gap-1.5 px-1">
                <div className={clsx(
                  'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs',
                  activeAgentSkillMode.kind === 'skill.none'
                    ? isDark ? 'border-amber-400/20 bg-amber-400/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-800'
                    : isDark ? 'border-[#2f80ed]/30 bg-[#2f80ed]/10 text-[#9cc8ff]' : 'border-[#b8d7ff] bg-[#eef6ff] text-[#1f6fca]',
                )}>
                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    {activeAgentSkillMode.kind === 'skill.none'
                      ? '本次不使用 Skill'
                      : activeAgentSkillMode.kind === 'skill.author'
                        ? '创建 Skill · 生成审核草稿'
                        : `${activeAgentSkillMode.skill.title} · v${activeAgentSkillMode.skill.version}`}
                  </span>
                  <button
                    type="button"
                    className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-black/10"
                    onClick={clearActiveAgentSkillMode}
                    title="移除 Skill"
                    aria-label="移除 Skill"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )}
            <textarea
              ref={chatInputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (agentSkillMenuOpen && agentSkillMenuItems.length > 0) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setActiveSkillMenuIndex((current) => (current + 1) % agentSkillMenuItems.length);
                    return;
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActiveSkillMenuIndex((current) => (current - 1 + agentSkillMenuItems.length) % agentSkillMenuItems.length);
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setDismissedSkillSlashQuery(agentSkillSlashQuery);
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    const item = agentSkillMenuItems[activeSkillMenuIndex];
                    if (item) selectAgentSkillMenuItem(item);
                    return;
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (!composerTaskActive) void sendChat();
                }
              }}
              rows={3}
              disabled={composerTaskActive || isWorking || isRuntimeRecoveryPending || Boolean(activeUserInput)}
              placeholder={activeUserInput ? '请先完成上方问答卡。' : approvalMode === 'chat_only' ? '只讨论不执行：保留交流和建议，不读取项目或生成计划。' : approvalMode === 'full_control' ? '直接描述创作任务；分析和可回退草稿会自动执行。' : '直接描述创作任务；执行前会展示计划和关键创作选择。'}
              className={clsx('block w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none', isDark ? 'placeholder:text-neutral-600' : 'placeholder:text-[var(--ui-text-disabled)]')}
            />
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
              <div className="min-w-0 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void addAttachment()}
                  disabled={composerTaskActive || isWorking || isRuntimeRecoveryPending || Boolean(activeUserInput) || isAddingAttachment}
                  title="添加文档"
                  className={clsx(
                    'grid h-8 w-8 shrink-0 place-items-center rounded-md border disabled:opacity-40',
                    isDark ? 'border-white/10 text-neutral-400 hover:bg-white/10' : 'border-[var(--ui-border)] text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]',
                  )}
                >
                  {isAddingAttachment ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                </button>
                <ChapterScopeSelector
                  isDark={isDark}
                  value={chapterScope}
                  volumes={volumes}
                  currentChapterId={currentChapter?.id}
                  currentVolumeId={currentChapter?.volumeId}
                  teamMode={(activeConversation?.role ?? selectedRole) === 'team'}
                  open={scopeMenuOpen}
                  disabled={composerTaskActive || isWorking || isRuntimeRecoveryPending || Boolean(activeUserInput)}
                  onChange={changeChapterScope}
                  onToggle={() => {
                    setScopeMenuOpen((current) => !current);
                    setModelMenuOpen(false);
                    setRoleMenuOpen(false);
                    setApprovalMenuOpen(false);
                  }}
                  onClose={() => setScopeMenuOpen(false)}
                />
                <ModelSelector
                  isDark={isDark}
                  settings={aiSettings}
                  modelDraft={modelDraft}
                  open={modelMenuOpen}
                  isSaving={isModelSaving}
                  error={modelError}
                  onDraftChange={setModelDraft}
                  onToggle={() => {
                    const nextOpen = !modelMenuOpen;
                    setModelMenuOpen(nextOpen);
                    setRoleMenuOpen(false);
                    setApprovalMenuOpen(false);
                    setScopeMenuOpen(false);
                    if (nextOpen) void refreshAiSettings();
                  }}
                  onCancel={() => {
                    setModelMenuOpen(false);
                    setModelDraft(aiSettings?.providerType === 'http' ? aiSettings.http.model : '');
                    setModelError('');
                  }}
                  onSave={() => void saveAgentModel()}
                />
                <RoleSelector
                  isDark={isDark}
                  value={activeConversation?.role ?? selectedRole}
                  options={roleOptions}
                  open={roleMenuOpen}
                  onToggle={() => {
                    setRoleMenuOpen((current) => !current);
                    setModelMenuOpen(false);
                    setApprovalMenuOpen(false);
                    setScopeMenuOpen(false);
                  }}
                  onSelect={selectRoleMode}
                  onOpenDetail={() => {
                    setRoleMenuOpen(false);
                    openInspector('roles');
                  }}
                />
                <ApprovalSelector
                  isDark={isDark}
                  value={approvalMode}
                  open={approvalMenuOpen}
                  onToggle={() => {
                    setApprovalMenuOpen((current) => !current);
                    setModelMenuOpen(false);
                    setRoleMenuOpen(false);
                    setScopeMenuOpen(false);
                  }}
                  onSelect={(mode) => {
                    setApprovalMode(mode);
                    setApprovalMenuOpen(false);
                  }}
                />
                <span className={clsx('hidden xl:inline text-xs', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>Enter 发送，Shift + Enter 换行</span>
              </div>
              <button
                type="button"
                onClick={() => composerTaskActive ? stopActiveTask() : void sendChat()}
                disabled={composerTaskActive
                  ? composerAction.disabled
                  : isWorking || isRuntimeRecoveryPending || Boolean(activeUserInput) || (!input.trim() && pendingAttachments.length === 0) || !chapterScopeReady}
                title={composerTaskActive ? composerAction.label : !chapterScopeReady ? '请先完成章节范围选择' : '发送'}
                aria-label={composerTaskActive ? composerAction.label : '发送'}
                className={clsx(
                  'shrink-0 whitespace-nowrap inline-flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-55',
                  composerTaskActive
                    ? clsx(
                      'h-10 w-10 rounded-full p-0',
                      isDark ? 'bg-neutral-100 text-neutral-950 hover:bg-white' : 'bg-[#202124] text-white hover:bg-black',
                    )
                    : clsx(
                      'h-8 min-w-[64px] gap-1.5 rounded-md px-2.5 text-xs text-white max-[640px]:w-8 max-[640px]:min-w-8 max-[640px]:px-0',
                      isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600',
                    ),
                )}
              >
                {composerTaskActive
                  ? composerAction.mode === 'saving'
                    ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                    : <Square className="h-3.5 w-3.5 fill-current" />
                  : <Send className="h-4 w-4" />}
                <span className={composerTaskActive ? 'sr-only' : 'max-[640px]:sr-only'}>{composerAction.label}</span>
              </button>
            </div>
          </div>
        </div>
      </main>

      {inspectorVisible && inspectorDrawerOpen && (
        <button
          type="button"
          className="absolute inset-0 z-30 bg-black/20 min-[1041px]:hidden"
          onClick={closeInspector}
          aria-label={t('agentWorkspace.inspector.close')}
        />
      )}
      {viewingAttachment && (
        <AttachmentViewer
          attachment={viewingAttachment}
          isDark={isDark}
          onClose={() => setViewingAttachment(null)}
        />
      )}
      {inspectorVisible && <InspectorPanel
        isDark={isDark}
        narrowOpen={inspectorDrawerOpen}
        onClose={closeInspector}
        activeTab={inspectorTab}
        onTabChange={selectInspectorTab}
        expanded={inspectorExpanded}
        onToggleExpanded={() => setInspectorExpanded((value) => !value)}
        onResizeStart={beginInspectorResize}
        onResizeReset={resetInspectorWidth}
        novel={novel}
        currentChapter={currentChapter}
        novelId={novelId}
        sourceConversationId={activeConversation?.id ?? ''}
        messages={activeConversation?.messages ?? []}
        contextSummary={activeConversation?.contextSummary ?? null}
        contextSummaryRebuilding={contextSummaryRebuildConversationId === activeConversation?.id}
        activeRun={selectedReviewRun}
        reportReviewAvailability={selectedReportReviewAvailability}
        conversationRuns={conversationRuns}
        activeRole={activeConversation?.role ?? selectedRole}
        roleOptions={roleOptions}
        volumes={volumes}
        reviewTarget={reviewTarget}
        draftSelection={draftInspectorSelection}
        draftBatchRecords={draftBatchRecords}
        onReviewTargetChange={setReviewTarget}
        onRebuildContextSummary={rebuildContextSummary}
        onUsePreset={usePresetTask}
        onArtifactStatusChange={updateArtifactStatus}
        onDraftBatchStatusChange={updateDraftBatchArtifactStatus}
        onArtifactReviewChange={updateArtifactReview}
        onRegenerateDraftBatch={regenerateDraftBatch}
        onDiscussReviewComments={discussReviewComments}
        onRegenerateDraft={regenerateDraftFromReview}
        onDraftBatchLoaded={rememberDraftBatch}
        onSelectReviewRun={setSelectedReviewRunId}
        onSkillPublished={refreshAgentSkills}
        onInitializeNovelProject={initializeNovelProject}
      />}
      </>
      )}
    </div>
  );
}

export default memo(AgentWorkspace);

function MessageBubble({
  message,
  attachments,
  isDark,
  onOpenAttachment,
  onRetrySummary,
  onReread,
}: {
  message: ConversationMessage;
  attachments: AgentAttachmentRecord[];
  isDark: boolean;
  onOpenAttachment: (attachmentId: string) => void;
  onRetrySummary: (message: ConversationMessage) => void;
  onReread: (message: ConversationMessage) => void;
}) {
  if (message.role === 'system') {
    return <ContextCompressionNotice message={message} isDark={isDark} />;
  }
  const isUser = message.role === 'user';
  const renderAsMarkdown = message.role === 'assistant'
    && inferAgentConversationMessageKind(message) === 'chat';
  return (
    <div className={clsx('flex gap-3', isUser && 'justify-end')}>
      {!isUser && (
        <div className={clsx('mt-1 h-8 w-8 rounded-md grid place-items-center shrink-0', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')}>
          <Bot className="h-4 w-4" />
        </div>
      )}
      <div className={clsx('max-w-[78%] rounded-lg border px-4 py-3 text-sm leading-6', isUser
        ? (isDark ? 'border-white/10 bg-white/10' : 'border-[var(--ui-border)] bg-white')
        : (isDark ? 'border-white/10 bg-[#111827]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-muted)]'))}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                onClick={() => onOpenAttachment(attachment.id)}
                className={clsx(
                  'inline-flex max-w-full items-center gap-1.5 rounded border px-2 py-1 text-xs',
                  isDark ? 'border-white/10 bg-black/15 text-neutral-300' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-secondary)]',
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{attachment.originalFileName}</span>
              </button>
            ))}
          </div>
        )}
        {!isUser && (!message.activities || message.activities.length === 0) && message.contextReads && message.contextReads.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {message.contextReads.map((read, index) => (
              <span
                key={`${read.toolName}-${index}`}
                title={read.message || read.toolName}
                className={clsx(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono',
                  read.status === 'failed'
                    ? (isDark ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-700')
                    : (isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]'),
                )}
              >
                <Search className="h-3 w-3" />
                {read.toolName}
              </span>
            ))}
          </div>
        )}
        {renderAsMarkdown ? (
          <AssistantMarkdown
            content={message.content}
            isDark={isDark}
            variant="chat"
            ariaLabel="助手回复"
          />
        ) : (
          <div className="whitespace-pre-wrap">{message.content}</div>
        )}
        {!isUser && message.failure?.code === 'MODEL_SUMMARY_TIMEOUT' && message.evidenceSnapshotId && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onRetrySummary(message)}
              className={clsx(
                'rounded-md px-3 py-1.5 text-xs font-medium',
                isDark ? 'bg-white text-black hover:bg-neutral-200' : 'bg-[var(--ui-text-primary)] text-white hover:opacity-90',
              )}
            >
              仅重试总结
            </button>
            <span className={clsx('text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>基于请求时快照，不会重新读取章节</span>
            <button
              type="button"
              onClick={() => onReread(message)}
              className={clsx('rounded-md border px-3 py-1.5 text-xs', isDark ? 'border-white/15 hover:bg-white/5' : 'border-[var(--ui-border)] hover:bg-[var(--ui-surface-subtle)]')}
            >
              重新读取并分析
            </button>
          </div>
        )}
      </div>
      {isUser && (
        <div className={clsx('mt-1 h-8 w-8 rounded-md grid place-items-center shrink-0', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')}>
          <UserRound className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}

function ChatActivityCard({
  activities,
  isDark,
  live = false,
}: {
  activities: AgentChatActivityEvent[];
  isDark: boolean;
  live?: boolean;
}) {
  const projection = useMemo(() => projectChatActivity(activities, live), [activities, live]);
  const [expanded, setExpanded] = useState(false);
  const latest = activities.at(-1);
  const detailPanelId = `chat-activity-${latest?.requestId.replace(/[^a-zA-Z0-9_-]/g, '-') ?? 'pending'}`;
  if (!latest) return null;
  const activitySubline = expanded
    ? '收起操作明细'
    : `${projection.details.length} 项操作 · 查看明细`;
  return (
    <ActivityStreamShell
      isDark={isDark}
      toneClass={activityToneClass(projection.tone, isDark)}
      statusIcon={activityStatusIcon(projection.tone)}
      title={projection.summary}
      subline={activitySubline}
      expanded={expanded}
      detailPanelId={detailPanelId}
      onToggle={() => setExpanded((current) => !current)}
    >
      {expanded && (
        <ActivityDetails
          id={detailPanelId}
          details={projection.details}
          isDark={isDark}
          ariaLabel="请求操作明细"
          emptyLabel="等待第一条请求事件。"
        />
      )}
    </ActivityStreamShell>
  );
}

function AttachmentViewer({
  attachment,
  isDark,
  onClose,
}: {
  attachment: AgentAttachmentContent;
  isDark: boolean;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={attachment.originalFileName}>
      <div className={clsx(
        'flex h-[min(82vh,760px)] w-[min(880px,94vw)] flex-col overflow-hidden rounded-lg border shadow-2xl',
        isDark ? 'border-white/10 bg-[#17171c] text-neutral-200' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-primary)]',
      )}>
        <div className={clsx('flex items-center gap-3 border-b px-4 py-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          <FileText className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{attachment.originalFileName}</div>
            <div className={clsx('text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
              {attachment.extension.toUpperCase()} · {attachment.characterCount.toLocaleString()} 字
              {attachment.pageCount ? ` · ${attachment.pageCount} 页` : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} title="关闭" className="grid h-8 w-8 place-items-center rounded-md hover:bg-black/10">
            <X className="h-4 w-4" />
          </button>
        </div>
        {attachment.warnings.length > 0 && (
          <div className={clsx('border-b px-4 py-2 text-xs', isDark ? 'border-white/10 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-800')}>
            {attachment.warnings.map((warning) => warning.message).join('；')}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">{attachment.plainText}</pre>
        </div>
      </div>
    </div>
  );
}

function ThinkingIndicator({ isDark, label }: { isDark: boolean; label: string }) {
  return (
    <div className="flex min-h-8 items-center gap-3" role="status" aria-live="polite">
      <div className={clsx('h-8 w-8 rounded-md grid place-items-center shrink-0', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')}>
        <Bot className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className={clsx('inline-flex items-center gap-2 text-sm', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span>{label || '思考中...'}</span>
      </div>
    </div>
  );
}

function ContextCompressionNotice({ message, isDark }: { message: ConversationMessage; isDark: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const compression = parseContextCompression(message);
  if (!compression) return null;
  const compressedHistory = compression.historyMessagesSummarized
    + compression.historyMessagesOmitted
    + compression.historyMessagesCompacted;
  const title = compression.mode === 'degraded'
    ? '上下文摘要暂时不可用'
    : compression.mode === 'semantic'
      ? '已完成语义压缩'
      : compression.mode === 'projection'
        ? '已使用持久摘要'
        : compressedHistory > 0 ? '已压缩较早上下文' : '已微压缩本次上下文';
  const summary = compression.mode === 'degraded'
    ? `已使用受限上下文${compression.historyMessagesOmitted > 0 ? ` · 省略 ${compression.historyMessagesOmitted} 条` : ''}`
    : compression.historyMessagesSummarized > 0
    ? `${compression.persistentSummaryRevision > 0 ? `持久摘要 v${compression.persistentSummaryRevision} · ` : ''}摘要 ${compression.historyMessagesSummarized} 条消息`
    : compression.historyMessagesCompacted > 0
      ? `精简 ${compression.historyMessagesCompacted} 条消息`
      : '精简长资料以适配模型窗口';

  return (
    <div className={clsx('mx-11 border-y py-2 text-xs', isDark ? 'border-white/10 text-neutral-400' : 'border-[var(--ui-border)] text-[var(--ui-text-muted)]')}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className={clsx('flex w-full items-center gap-2 text-left transition-colors', isDark ? 'hover:text-neutral-200' : 'hover:text-[var(--ui-text-primary)]')}
      >
        <Minimize2 className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{title}</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDown className={clsx('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className={clsx('mt-2 grid grid-cols-1 gap-1 border-l pl-5 leading-5 sm:grid-cols-2', isDark ? 'border-white/10' : 'border-[var(--ui-border-strong)]')}>
          <span>保留原文 {compression.historyMessagesKept} / {compression.historyMessagesTotal} 条</span>
          <span>摘要表示 {compression.historyMessagesSummarized} 条</span>
          {compression.persistentSummaryRevision > 0 && (
            <span>
              持久摘要 v{compression.persistentSummaryRevision}
              {compression.summaryGeneration ? ` · generation ${compression.summaryGeneration}` : ''}
              {' · '}覆盖 {compression.persistentSummaryMessageCount} 条
            </span>
          )}
          {compression.rebuildReason && <span>重建原因：{compression.rebuildReason}</span>}
          {compression.rebuildStatus && (
            <span>
              重建状态：{compression.rebuildStatus}
              {compression.rebuildChunkCount
                ? ` · ${compression.rebuildChunksCompleted ?? 0}/${compression.rebuildChunkCount} 块`
                : ''}
            </span>
          )}
          {compression.sourceHashStatus && <span>消息来源：{compression.sourceHashStatus}</span>}
          {compression.dependencyHashStatus && <span>项目依赖：{compression.dependencyHashStatus}</span>}
          {compression.failureCode && <span className="sm:col-span-2">降级原因：{compression.failureCode}</span>}
          {compression.circuitOpen && <span>摘要熔断已开启</span>}
          {compression.casConflict && <span>摘要提交发生并发冲突</span>}
          {(compression.recalledMessageCount > 0 || compression.recalledArtifactCount > 0) && (
            <span>按引用召回 {compression.recalledMessageCount} 条消息 / {compression.recalledArtifactCount} 个产物</span>
          )}
          {compression.historyMessagesOmitted > 0 && <span>本次未纳入 {compression.historyMessagesOmitted} 条</span>}
          {compression.historyMessagesCompacted > 0 && <span>精简长消息 {compression.historyMessagesCompacted} 条</span>}
          <span>输入估算 {compression.estimatedInputTokens.toLocaleString()} / {compression.inputBudgetTokens.toLocaleString()} Token</span>
          <span>模型窗口 {compression.contextWindowTokens.toLocaleString()} Token</span>
          <span className="sm:col-span-2">模型 {compression.model}</span>
          {compression.compressedSectionIds.length > 0 && (
            <span className="break-words sm:col-span-2">已压缩资料：{compression.compressedSectionIds.join('、')}</span>
          )}
          {compression.omittedSectionIds.length > 0 && (
            <span className="break-words sm:col-span-2">本次省略资料：{compression.omittedSectionIds.join('、')}</span>
          )}
        </div>
      )}
    </div>
  );
}

function ActionCard({
  isDark,
  title,
  description,
  actionLabel,
  disabled,
  onAction,
}: {
  isDark: boolean;
  title: string;
  description: string;
  actionLabel: string;
  disabled: boolean;
  onAction: () => void;
}) {
  return (
    <div className={clsx('rounded-lg border p-4', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white')}>
      <div className="flex items-start gap-3">
        <div className={clsx('h-8 w-8 rounded-md grid place-items-center shrink-0', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')}>
          <ClipboardList className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          <p className={clsx('mt-1 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{description}</p>
          <button
            type="button"
            onClick={onAction}
            disabled={disabled}
            className={clsx('mt-3 h-9 px-3 rounded-md inline-flex items-center gap-2 text-sm text-white disabled:opacity-50', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}
          >
            {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function RevisionProgressCard({
  plan,
  run,
  isDark,
  interactive,
  isWorking,
  onRetry,
}: {
  plan: RevisionBatchPlan;
  run: AgentRun | null;
  isDark: boolean;
  interactive: boolean;
  isWorking: boolean;
  onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const completedStepCount = plan.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
  const currentStepIndex = plan.steps.findIndex((step) => step.stepId === run?.currentStepId);
  const failedStepIndex = plan.steps.findIndex((step) => step.status === 'failed');
  const pendingStepIndex = plan.steps.findIndex((step) => step.status === 'pending' || step.status === 'running');
  const activeStepIndex = currentStepIndex >= 0
    ? currentStepIndex
    : failedStepIndex >= 0
      ? failedStepIndex
      : pendingStepIndex >= 0
        ? pendingStepIndex
        : Math.max(0, Math.min(plan.steps.length - 1, completedStepCount));
  const currentStep = plan.steps[activeStepIndex] ?? plan.steps[0];
  const isRunning = run?.status === 'running' || run?.status === 'cancelling';
  const pendingApproval = getActiveApproval(run);
  const pendingChapterBeatApproval = pendingApproval?.checkpointType === 'chapter_beats' ? pendingApproval : null;
  const pendingChapterBeatCount = pendingChapterBeatApproval?.beats?.length ?? 0;
  const canRetry = Boolean(
    interactive
    && run?.status === 'failed'
    && run.failureRevision
    && (!run.recovery || run.recovery.canRecover),
  );
  const failedEvent = run?.status === 'failed'
    ? [...run.events].reverse().find((event) => event.type === 'tool_result' && event.status === 'failed')
      ?? [...run.events].reverse().find((event) => event.type === 'run_failed')
    : null;
  const failureCode = typeof failedEvent?.payload?.code === 'string' ? failedEvent.payload.code : '';
  const failureMessage = typeof failedEvent?.payload?.summary === 'string'
    ? failedEvent.payload.summary
    : typeof failedEvent?.payload?.message === 'string'
      ? failedEvent.payload.message
      : '本次批量修订未完成，可以从失败步骤重试。';
  const isApplyingSuggestions = isRunning && currentStep?.toolchain?.id === 'chapter.batch_rewrite';
  const suggestionStatus = run?.status === 'completed'
    ? '已应用'
    : run?.status === 'failed' || run?.status === 'cancelled'
      ? '未完成'
      : pendingChapterBeatApproval
        ? '待确认'
      : isApplyingSuggestions
        ? '处理中'
        : '待应用';
  const statusLabel = !run
    ? '正在准备修订'
    : pendingChapterBeatApproval
      ? `待确认 · ${pendingChapterBeatCount} 章节拍`
    : run.status === 'completed'
      ? '修订草稿已完成'
      : run.status === 'failed'
        ? '修订未完成'
        : run.status === 'cancelled'
          ? '修订已停止'
          : run.status === 'cancelling'
            ? '正在停止修订'
          : currentStep?.title || '正在生成修订草稿';

  return (
    <section className={clsx('overflow-hidden rounded-lg border', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white')}>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-md', isDark ? 'bg-white/10' : 'bg-[#edf5ff]')}>
          {isRunning || !run
            ? <Loader2 className="h-4 w-4 animate-spin text-[#2f80ed] motion-reduce:animate-none" />
            : pendingChapterBeatApproval
              ? <ListChecks className="h-4 w-4 text-amber-600" />
            : run.status === 'completed'
              ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              : <AlertCircle className="h-4 w-4 text-amber-600" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {plan.revisionItems.length} 项建议批量修订
          </div>
          <p className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>
            {currentStep ? `第 ${activeStepIndex + 1} / ${plan.steps.length} 步 · ` : ''}{statusLabel}
          </p>
          {currentStep && run?.status !== 'completed' && (
            <p className={clsx('mt-1 truncate text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-disabled)]')}>{currentStep.title}</p>
          )}
          {pendingChapterBeatApproval && (
            <p className={clsx('mt-1 text-xs leading-5', isDark ? 'text-amber-300/80' : 'text-amber-700')}>正文尚未生成，确认章节拍后开始批量修订。</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => setExpanded((value) => !value)} className={clsx('grid h-8 w-8 place-items-center rounded-md', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')} aria-expanded={expanded} title={expanded ? '收起步骤' : '展开步骤'} aria-label={expanded ? '收起修订步骤' : '展开修订步骤'}>
            <ChevronDown className={clsx('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      </div>
      {run?.status === 'failed' && (
        <div className={clsx('border-t px-4 py-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          <div className={clsx('rounded-md border px-3 py-2.5', isDark ? 'border-red-400/20 bg-red-500/[0.06]' : 'border-red-200 bg-red-50')}>
            <div className={clsx('text-xs font-medium', isDark ? 'text-red-300' : 'text-red-700')}>
              失败于第 {activeStepIndex + 1} 步{failedEvent?.toolName ? ` · ${failedEvent.toolName}` : ''}{failureCode ? ` · ${failureCode}` : ''}
            </div>
            <p className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{failureMessage}</p>
            {canRetry && (
              <button
                type="button"
                onClick={onRetry}
                disabled={isWorking}
                className={clsx('mt-2 inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs text-white disabled:opacity-50', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}
              >
                {isWorking ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <RotateCcw className="h-3.5 w-3.5" />}
                {run.recovery?.actionLabel || '重试失败步骤'}
              </button>
            )}
          </div>
        </div>
      )}
      {expanded && (
        <div className={clsx('border-t px-4 py-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          <div className="space-y-2">
            {plan.revisionItems.map((item, index) => {
              return (
                <div key={item.findingId} className="flex items-start gap-2 text-xs leading-5">
                  <span className={clsx(
                    'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px]',
                    suggestionStatus === '已应用'
                      ? 'bg-emerald-100 text-emerald-700'
                      : suggestionStatus === '处理中'
                        ? 'bg-blue-100 text-blue-700'
                        : suggestionStatus === '待确认'
                          ? 'bg-amber-100 text-amber-700'
                        : suggestionStatus === '未完成'
                          ? 'bg-red-100 text-red-700'
                          : isDark ? 'bg-white/10 text-neutral-500' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-disabled)]',
                  )}>{suggestionStatus === '已应用' ? '✓' : index + 1}</span>
                  <span className="min-w-0 flex-1">{item.title}</span>
                  <span className={clsx('shrink-0', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-disabled)]')}>{suggestionStatus}</span>
                </div>
              );
            })}
          </div>
          <div className={clsx('mt-3 border-t pt-3 text-[11px] leading-5', isDark ? 'border-white/10 text-neutral-500' : 'border-[var(--ui-border)] text-[var(--ui-text-disabled)]')}>
            {plan.steps.map((step, index) => (
              <div key={step.stepId}>{index + 1}. {step.title}</div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

type AgentDecisionOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

function AgentDecisionCard({
  title,
  context,
  options,
  selectedOptionId,
  isDark,
  isWorking,
  currentIndex,
  total,
  canNavigateNext = false,
  customAllowed = true,
  customActive,
  customValue,
  customLabel = '都不是，告诉我如何做',
  customPlaceholder = '输入具体要求……',
  customActionLabel,
  skipLabel = '跳过',
  onSelect,
  onPrevious,
  onNext,
  onDismiss,
  onActivateCustom,
  onCustomChange,
  onCustomSubmit,
  onCustomEscape,
  onSkip,
}: {
  title: string;
  context?: string;
  options: AgentDecisionOption[];
  selectedOptionId?: string;
  isDark: boolean;
  isWorking: boolean;
  currentIndex?: number;
  total?: number;
  canNavigateNext?: boolean;
  customAllowed?: boolean;
  customActive: boolean;
  customValue: string;
  customLabel?: string;
  customPlaceholder?: string;
  customActionLabel: string;
  skipLabel?: string;
  onSelect: (optionId: string) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onDismiss: () => void;
  onActivateCustom: () => void;
  onCustomChange: (value: string) => void;
  onCustomSubmit: () => void;
  onCustomEscape: () => void;
  onSkip: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!customActive || !input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 32), 144)}px`;
  }, [customActive, customValue]);
  const showNavigation = typeof currentIndex === 'number' && typeof total === 'number' && total > 1;
  return (
    <section className={clsx('rounded-2xl border p-2.5 shadow-sm sm:p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
      <header className="flex items-start justify-between gap-2 px-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-6 sm:text-base">{title}</h3>
          {context && <p className={clsx('mt-1 whitespace-pre-wrap text-xs font-normal leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{context}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showNavigation && (
            <>
              <button type="button" aria-label="上一个问题" onClick={onPrevious} disabled={isWorking || currentIndex === 0} className={clsx('grid h-7 w-7 place-items-center rounded-full disabled:opacity-25', isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]')}><ChevronLeft className="h-4 w-4" /></button>
              <span className={clsx('px-0.5 text-xs tabular-nums', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{currentIndex + 1} / {total}</span>
              <button type="button" aria-label="下一个问题" onClick={onNext} disabled={isWorking || currentIndex >= total - 1 || !canNavigateNext} className={clsx('grid h-7 w-7 place-items-center rounded-full disabled:opacity-25', isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-muted)]')}><ChevronRight className="h-4 w-4" /></button>
            </>
          )}
          <button type="button" aria-label="关闭问题" onClick={onDismiss} disabled={isWorking} className={clsx('grid h-8 w-8 place-items-center rounded-full disabled:opacity-40', isDark ? 'text-neutral-500 hover:bg-white/5' : 'text-[var(--ui-text-disabled)] hover:bg-[var(--ui-surface-muted)]')}><X className="h-4 w-4" /></button>
        </div>
      </header>

      <div className="mt-2 space-y-1">
        {options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onSelect(option.id)}
            disabled={isWorking}
            className={clsx(
              'group flex min-h-11 w-full items-start gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:px-3',
              selectedOptionId === option.id
                ? (isDark ? 'border-[#2f80ed] bg-[#2f80ed]/10' : 'border-[#2f80ed] bg-[var(--ui-surface-muted)]')
                : (isDark ? 'border-transparent hover:bg-white/[0.07]' : 'border-transparent hover:bg-[var(--ui-surface-muted)]'),
            )}
          >
            <span className={clsx('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-semibold', isDark ? 'border-white/15 bg-white/5 text-neutral-400' : 'border-[var(--ui-border-strong)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-muted)]')}>{index + 1}</span>
            <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                {option.label}
                {option.recommended && <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>推荐</span>}
              </span>
              {option.description && <span className={clsx('mt-0.5 block text-xs leading-4 sm:mt-0', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{option.description}</span>}
            </span>
            {isWorking && selectedOptionId === option.id ? <Loader2 className="mt-1.5 h-4 w-4 shrink-0 animate-spin opacity-60" /> : <ArrowRight className="mt-1.5 h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60" />}
          </button>
        ))}

        <div className={clsx('flex min-h-11 items-center gap-2 rounded-xl border px-2.5 py-2 transition-colors sm:px-3', customActive ? (isDark ? 'border-[#2f80ed] bg-[#2f80ed]/10' : 'border-[#2f80ed] bg-[var(--ui-surface-muted)]') : (isDark ? 'border-transparent hover:bg-white/[0.07]' : 'border-transparent hover:bg-[var(--ui-surface-muted)]'))}>
          <span className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-full border', isDark ? 'border-white/15 bg-white/5 text-neutral-400' : 'border-[var(--ui-border-strong)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-muted)]')}><Pencil className="h-3.5 w-3.5" /></span>
          {customActive ? (
            <textarea
              ref={inputRef}
              autoFocus
              value={customValue}
              onChange={(event) => onCustomChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onCustomEscape();
                } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  onCustomSubmit();
                }
              }}
              rows={1}
              maxLength={4000}
              disabled={isWorking}
              placeholder={customPlaceholder}
              aria-label="自定义回答"
              className={clsx('max-h-32 min-h-7 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent py-0.5 text-sm leading-5 outline-none disabled:opacity-50', isDark ? 'placeholder:text-neutral-600' : 'placeholder:text-[var(--ui-text-disabled)]')}
            />
          ) : (
            <button type="button" onClick={customAllowed ? onActivateCustom : onSkip} disabled={isWorking} className={clsx('min-w-0 flex-1 py-0.5 text-left text-sm disabled:opacity-50', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{customAllowed ? customLabel : '按推荐方案继续'}</button>
          )}
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); customActive ? onCustomSubmit() : onSkip(); }}
            disabled={isWorking || (customActive && !customValue.trim())}
            className={clsx('inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:text-sm', isDark ? 'border-white/15 bg-white/5 text-neutral-200 hover:bg-white/10' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}
          >
            {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {customActive ? customActionLabel : skipLabel}
          </button>
        </div>
      </div>
    </section>
  );
}

function PlanCard({
  plan,
  run,
  interactive,
  isDark,
  isWorking,
  renderStepStatus,
  onExecute,
  onIgnore,
  onSubmitRevision,
}: {
  plan: AgentPlan;
  run: AgentRun | null;
  interactive: boolean;
  isDark: boolean;
  isWorking: boolean;
  renderStepStatus: (status: AgentStepStatus) => JSX.Element;
  onExecute: () => void;
  onIgnore: () => void;
  onSubmitRevision: (revision: string) => void;
}) {
  const canRetry = interactive && run?.status === 'cancelled';
  const hasStarted = Boolean(run);
  const [isRevising, setIsRevising] = useState(false);
  const [revision, setRevision] = useState('');
  const [isContextExpanded, setIsContextExpanded] = useState(false);
  const { currentGoal, conversationContext } = splitAgentPlanGoal(plan.goal);
  useEffect(() => {
    setIsRevising(false);
    setRevision('');
    setIsContextExpanded(false);
  }, [plan.planId, plan.goal]);
  const executePlan = () => {
    if (isWorking) return;
    setIsRevising(false);
    setRevision('');
    onExecute();
  };
  const ignorePlan = () => {
    if (isWorking) return;
    onIgnore();
  };
  const submitRevision = () => {
    const nextRevision = revision.trim();
    if (isWorking || !nextRevision) return;
    onSubmitRevision(nextRevision);
  };
  const scopedInput = plan.steps.find((step) => step.toolchain && typeof step.toolchain.input?.kind === 'string')?.toolchain?.input;
  const scopeKind = typeof scopedInput?.kind === 'string' ? scopedInput.kind : '';
  const scopeChapterIds = Array.isArray(scopedInput?.chapterIds) ? scopedInput.chapterIds.filter((id): id is string => typeof id === 'string') : [];
  const scopeExperts = Array.isArray(scopedInput?.experts) ? scopedInput.experts.filter((id): id is string => typeof id === 'string') : [];
  const scopeLabel = ({
    current_chapter: '当前章',
    selected_chapters: `已选 ${scopeChapterIds.length} 章`,
    chapter_range: '章节区间',
    current_volume: '当前卷',
    novel: '整本小说',
  } as Record<string, string>)[scopeKind];
  return (
    <div className={clsx('rounded-lg border p-4', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList className="h-4 w-4 text-[#2f80ed]" />
            <span className={clsx('rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
              {hasStarted ? '执行计划' : '计划草稿'}
            </span>
            {plan.title}
          </div>
          {currentGoal && <p className={clsx('mt-1 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{currentGoal}</p>}
          {conversationContext && (
            <div className="mt-1.5">
              <button
                type="button"
                aria-expanded={isContextExpanded}
                aria-controls={`plan-context-${plan.planId}`}
                onClick={() => setIsContextExpanded((expanded) => !expanded)}
                className={clsx('inline-flex items-center gap-1 text-xs transition-colors', isDark ? 'text-neutral-500 hover:text-neutral-300' : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-secondary)]')}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                {isContextExpanded ? '收起会话背景' : '查看会话背景'}
                <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', isContextExpanded && 'rotate-180')} />
              </button>
              {isContextExpanded && (
                <div
                  id={`plan-context-${plan.planId}`}
                  className={clsx('mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-xs leading-5', isDark ? 'border-white/10 bg-black/20 text-neutral-500' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-muted)]')}
                >
                  {conversationContext}
                </div>
              )}
            </div>
          )}
          {scopeLabel && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className={clsx('rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[#eef6ff] text-[#1f6fca]')}>初始上下文：{scopeLabel}</span>
              <span className={clsx('rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>{scopedInput?.processingMode === 'batched' ? '分批处理' : '详细处理'}</span>
              {scopeExperts.map((expert) => <span key={expert} className={clsx('rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>{expert}</span>)}
            </div>
          )}
        </div>
        {run && (
          <span className={clsx('rounded px-2 py-1 text-xs', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
            {run.status}
          </span>
        )}
      </div>
      <div className="mt-4 space-y-2">
        {plan.steps.map((step, index) => {
          const resolvedTarget = step.toolchain?.input?._resolvedTarget;
          const targetRecord = resolvedTarget && typeof resolvedTarget === 'object' && !Array.isArray(resolvedTarget)
            ? resolvedTarget as Record<string, unknown>
            : null;
          const targetLabel = typeof targetRecord?.label === 'string'
            ? targetRecord.label
            : typeof targetRecord?.title === 'string'
              ? targetRecord.title
              : null;
          return <div key={step.stepId} className={clsx('rounded-md border p-3 flex gap-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
            <div className={clsx('h-7 w-7 rounded-md grid place-items-center text-xs font-mono shrink-0', isDark ? 'bg-white/10' : 'bg-white border border-[var(--ui-border)]')}>{index + 1}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{step.title}</span>
                <span className={clsx('text-[11px] px-1.5 py-0.5 rounded', isDark ? 'bg-white/10 text-neutral-300' : 'bg-white text-[var(--ui-text-muted)] border border-[var(--ui-border)]')}>{step.agent}</span>
                {renderStepStatus(step.status)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {step.tools.map((tool) => (
                  <span key={tool} className={clsx('rounded px-1.5 py-0.5 text-[11px] font-mono', isDark ? 'bg-white/10 text-neutral-400' : 'bg-white text-[var(--ui-text-muted)] border border-[var(--ui-border)]')}>{tool}</span>
                ))}
                {step.toolchain && (
                  <span className={clsx('rounded px-1.5 py-0.5 text-[11px] font-mono', isDark ? 'bg-[#2f80ed]/15 text-[#7db4ff]' : 'border border-[#b8d7ff] bg-[#eef6ff] text-[#1f6fca]')}>
                    {step.toolchain.id}@{step.toolchain.version}
                  </span>
                )}
                {step.skills?.map((skill) => (
                  <span
                    key={`${skill.skillId}:${skill.revisionId}`}
                    title={`Skill revision: ${skill.revisionId}\nHash: ${skill.contentHash}`}
                    className={clsx(
                      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono',
                      isDark ? 'bg-violet-400/10 text-violet-300' : 'border border-violet-200 bg-violet-50 text-violet-700',
                    )}
                  >
                    <Sparkles className="h-3 w-3" />
                    {skill.stableId}@{skill.version}
                    <span className="opacity-65">· {skill.selectionSource}</span>
                  </span>
                ))}
              </div>
              {targetLabel && (
                <div className={clsx('mt-2 text-xs', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>
                  写作目标：{targetLabel}
                </div>
              )}
            </div>
            {step.status === 'completed' && <CheckCircle2 className="h-4 w-4 text-[#2f80ed]" />}
          </div>
        })}
      </div>
      {!hasStarted && interactive && (
        <div className="mt-3">
          <AgentDecisionCard
            title="实施此计划？"
            options={[{ id: 'execute', label: '是，实施此计划', recommended: true }]}
            isDark={isDark}
            isWorking={isWorking}
            customActive={isRevising}
            customValue={revision}
            customLabel="否，并告诉我如何做得不同"
            customPlaceholder="告诉我应该如何调整计划……"
            customActionLabel="提交"
            onSelect={executePlan}
            onDismiss={ignorePlan}
            onActivateCustom={() => setIsRevising(true)}
            onCustomChange={setRevision}
            onCustomSubmit={submitRevision}
            onCustomEscape={() => setIsRevising(false)}
            onSkip={ignorePlan}
          />
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        {canRetry && (
          <button
            type="button"
            onClick={onExecute}
            disabled={isWorking}
            className={clsx('h-9 px-3 rounded-md inline-flex items-center gap-2 text-sm text-white disabled:opacity-50', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}
          >
            {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            重新实施
          </button>
        )}
      </div>
    </div>
  );
}

type ActivityTone = 'running' | 'completed' | 'failed' | 'waiting' | 'cancelled' | 'idle';

function activityToneClass(tone: ActivityTone, isDark: boolean): string {
  return tone === 'failed'
    ? (isDark ? 'text-red-300' : 'text-red-700')
    : tone === 'waiting'
      ? (isDark ? 'text-amber-300' : 'text-amber-700')
      : tone === 'completed'
        ? (isDark ? 'text-emerald-300' : 'text-emerald-700')
        : (isDark ? 'text-neutral-300' : 'text-[var(--ui-text-muted)]');
}

function activityStatusIcon(tone: ActivityTone): ReactNode {
  return tone === 'running'
    ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
    : tone === 'completed'
      ? <CheckCircle2 className="h-4 w-4" />
      : tone === 'failed'
        ? <AlertCircle className="h-4 w-4" />
        : tone === 'waiting'
          ? <MessageSquare className="h-4 w-4" />
          : <Square className="h-4 w-4" />;
}

function ActivityStreamShell({
  isDark,
  toneClass,
  statusIcon,
  title,
  subline,
  expanded,
  detailPanelId,
  onToggle,
  failure = false,
  children,
}: {
  isDark: boolean;
  toneClass: string;
  statusIcon: ReactNode;
  title: string;
  subline: string;
  expanded: boolean;
  detailPanelId: string;
  onToggle: () => void;
  failure?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={clsx(
      'overflow-hidden rounded-md border',
      failure
        ? isDark ? 'border-red-400/25 bg-red-500/[0.04]' : 'border-[#e9c8c4] bg-white'
        : isDark ? 'border-white/10 bg-black/15' : 'border-[var(--ui-border)] bg-white',
    )}>
      <div className="flex min-h-12 w-full items-center gap-3 px-3 py-2.5">
        <span className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-md', toneClass, isDark ? 'bg-white/5' : 'bg-[var(--ui-surface-muted)]')}>
          {statusIcon}
        </span>
        <span className="min-w-0 flex-1">
          <span aria-live="polite" className={clsx('block text-sm font-medium', toneClass)}>{title}</span>
          <span className={clsx('mt-0.5 block text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
            {subline}
          </span>
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={detailPanelId}
          className={clsx('inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')}
        >
          <span className="max-[520px]:sr-only">{expanded ? '收起详情' : '查看详情'}</span>
          <ChevronDown className={clsx('h-4 w-4 transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
        </button>
      </div>
      {children}
    </div>
  );
}

function ActivityDetails({
  id,
  details,
  isDark,
  ariaLabel,
  emptyLabel,
  scrollRef,
  onScroll,
}: {
  id: string;
  details: ActivityDetail[];
  isDark: boolean;
  ariaLabel: string;
  emptyLabel: string;
  scrollRef?: RefObject<HTMLDivElement>;
  onScroll?: () => void;
}) {
  return (
    <div
      id={id}
      ref={scrollRef}
      role="region"
      aria-label={ariaLabel}
      onScroll={onScroll}
      className={clsx('max-h-80 overflow-y-auto border-t px-3 py-2', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}
    >
      {details.length > 0 ? (
        <div className="space-y-0">
          {details.map((detail, index) => (
            <ActivityDetailRow key={detail.eventId} detail={detail} isDark={isDark} isLast={index === details.length - 1} />
          ))}
        </div>
      ) : (
        <div className={clsx('px-1 py-3 text-sm', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{emptyLabel}</div>
      )}
    </div>
  );
}

function AgentActivityStream({
  run,
  plan,
  activityId,
  isDark,
  interactive,
  isWorking,
  onRetry,
  onReplan,
}: {
  run: AgentRun;
  plan: AgentPlan;
  activityId?: string;
  isDark: boolean;
  interactive: boolean;
  isWorking: boolean;
  onRetry: () => void;
  onReplan: () => void;
}) {
  const projection = useMemo(() => projectAgentActivity(run), [run]);
  const [expanded, setExpanded] = useState(false);
  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  const followsDetailRef = useRef(true);
  const detailPanelId = `agent-activity-${(activityId || run.runId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const scrollDetailsToLatest = useCallback(() => {
    const node = detailScrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    followsDetailRef.current = true;
  }, []);

  useLayoutEffect(() => {
    if (!expanded || !followsDetailRef.current) return;
    scrollDetailsToLatest();
  }, [expanded, projection.details.length, scrollDetailsToLatest]);

  const handleDetailScroll = useCallback(() => {
    const node = detailScrollRef.current;
    if (!node) return;
    followsDetailRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 32;
  }, []);

  const toggleExpanded = () => {
    setExpanded((current) => {
      const next = !current;
      if (next) followsDetailRef.current = true;
      return next;
    });
  };

  const toneClass = activityToneClass(projection.tone, isDark);
  const statusIcon = activityStatusIcon(projection.tone);

  const descriptorRecovery = run.status === 'failed'
    && run.recovery?.canRecover
    && run.recovery.retryStrategy !== 'none';
  const retryableFailure = run.status === 'failed'
    && Boolean(run.failureRevision)
    && Boolean(
      descriptorRecovery
      || (projection.retry?.phase === 'exhausted' && projection.retry.retryable)
    );
  const canRetry = retryableFailure && interactive;
  const retryActionLabel = run.recovery?.actionLabel || '重试失败步骤';
  const completedSteps = plan.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
  const totalActivitySteps = plan.steps.length + (projection.retry?.stage === '整理最终回答' ? 1 : 0);
  const activityTitle = retryableFailure ? '任务已暂停' : projection.summary;
  const activitySubline = retryableFailure
    ? projection.summary
    : run.status === 'running' && projection.retry?.phase === 'resuming'
      ? '已保留原计划与完成结果'
      : expanded
        ? '收起操作明细'
        : `${projection.details.length} 项操作 · 查看明细`;

  return (
    <ActivityStreamShell
      isDark={isDark}
      toneClass={toneClass}
      statusIcon={statusIcon}
      title={activityTitle}
      subline={activitySubline}
      expanded={expanded}
      detailPanelId={detailPanelId}
      onToggle={toggleExpanded}
      failure={retryableFailure}
    >
      {retryableFailure && (
        <div className={clsx('border-t px-3 pb-3 pt-2.5', isDark ? 'border-white/10' : 'border-[#f0dedb]')}>
          <p className={clsx('text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>
            已完成的检查结果会保留，继续时将从失败步骤恢复。
          </p>
          <div className={clsx('mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md px-2.5 py-2 text-xs', isDark ? 'bg-black/20 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
            <span>已完成 {completedSteps}/{totalActivitySteps}</span>
            <span className={isDark ? 'text-red-300' : 'text-[#9b4a42]'}>失败于{projection.retry?.stage || '当前步骤'}</span>
          </div>
          {canRetry && (
            <div className="mt-3 grid grid-cols-2 gap-2 max-[640px]:grid-cols-1">
              <button
                type="button"
                onClick={onRetry}
                disabled={isWorking}
                className={clsx('inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-sm text-white disabled:opacity-50', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}
              >
                {isWorking ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RotateCcw className="h-4 w-4" />}
                {retryActionLabel}
              </button>
              <button
                type="button"
                onClick={onReplan}
                disabled={isWorking}
                className={clsx('min-h-9 rounded-md border px-3 text-sm disabled:opacity-50', isDark ? 'border-white/15 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border-strong)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}
              >
                调整并重新规划
              </button>
            </div>
          )}
        </div>
      )}

      {expanded && (
        <ActivityDetails
          id={detailPanelId}
          details={projection.details}
          isDark={isDark}
          ariaLabel="Agent 操作明细"
          emptyLabel="等待第一条执行事件。"
          scrollRef={detailScrollRef}
          onScroll={handleDetailScroll}
        />
      )}
    </ActivityStreamShell>
  );
}

function ActivityDetailRow({ detail, isDark, isLast }: { detail: ActivityDetail; isDark: boolean; isLast: boolean }) {
  const icon = detail.kind === 'tool' || detail.kind === 'command'
    ? <Wrench className="h-3.5 w-3.5" />
    : detail.kind === 'approval'
      ? <MessageSquare className="h-3.5 w-3.5" />
      : detail.kind === 'artifact'
        ? <FileText className="h-3.5 w-3.5" />
        : detail.kind === 'error'
          ? <AlertCircle className="h-3.5 w-3.5" />
          : detail.kind === 'model'
            ? <Bot className="h-3.5 w-3.5" />
            : <CheckCircle2 className="h-3.5 w-3.5" />;
  const statusClass = detail.status === 'failed'
    ? (isDark ? 'text-red-300' : 'text-red-700')
    : detail.status === 'waiting'
      ? (isDark ? 'text-amber-300' : 'text-amber-700')
      : detail.status === 'running'
        ? 'text-[#2f80ed]'
        : (isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]');
  const createdAt = Number.isNaN(Date.parse(detail.createdAt))
    ? ''
    : new Date(detail.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="relative flex gap-3 pb-3 last:pb-1">
      {!isLast && <div className={clsx('absolute left-[15px] top-7 h-[calc(100%-16px)] w-px', isDark ? 'bg-white/10' : 'bg-[var(--ui-border)]')} />}
      <div className={clsx('relative z-[1] mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md', statusClass, isDark ? 'bg-[#17171c]' : 'bg-[var(--ui-surface-muted)]')}>
        {detail.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : icon}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-start justify-between gap-3">
          <span className="text-sm font-medium leading-5">{detail.title}</span>
          <span className={clsx('shrink-0 text-[11px] tabular-nums', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>{createdAt}</span>
        </div>
        {detail.summary && <p className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{detail.summary}</p>}
        {detail.metadata.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {detail.metadata.map((item) => (
              <div key={item.label} className={clsx('rounded px-2 py-1.5 text-xs', isDark ? 'bg-white/5' : 'bg-[var(--ui-surface-muted)]')}>
                <div className={clsx('mb-0.5 text-[10px]', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>{item.label}</div>
                <div className={clsx('max-h-28 overflow-auto whitespace-pre-wrap break-all', item.mono && 'font-mono')}>{item.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type LegacyUserInputDraftAnswer = {
  answerKind: 'option' | 'custom';
  selectedOptionId: string;
  customText: string;
};

function legacyDefaultUserInputAnswers(request: AgentUserInputRequest): Record<string, LegacyUserInputDraftAnswer> {
  return Object.fromEntries(request.questions.map((question) => [question.questionId, {
    answerKind: 'option' as const,
    selectedOptionId: question.options[0]?.optionId ?? '',
    customText: '',
  }]));
}

function LegacyUserInputRequiredCard({
  request,
  isDark,
  isWorking,
  onSubmit,
}: {
  request: AgentUserInputRequest;
  isDark: boolean;
  isWorking: boolean;
  onSubmit: (answers: AgentUserInputAnswer[]) => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, LegacyUserInputDraftAnswer>>(() => legacyDefaultUserInputAnswers(request));
  useEffect(() => {
    setQuestionIndex(0);
    setAnswers(legacyDefaultUserInputAnswers(request));
  }, [request.requestId]);

  const question = request.questions[questionIndex];
  if (!question) return null;
  const answer = answers[question.questionId] ?? {
    answerKind: 'option' as const,
    selectedOptionId: question.options[0]?.optionId ?? '',
    customText: '',
  };
  const currentValid = answer.answerKind === 'custom'
    ? Boolean(answer.customText.trim())
    : Boolean(answer.selectedOptionId);
  const allValid = request.questions.every((item) => {
    const value = answers[item.questionId];
    return value?.answerKind === 'custom' ? Boolean(value.customText.trim()) : Boolean(value?.selectedOptionId);
  });
  const isLast = questionIndex === request.questions.length - 1;
  const selectOption = (optionId: string) => {
    setAnswers((current) => ({
      ...current,
      [question.questionId]: { answerKind: 'option', selectedOptionId: optionId, customText: '' },
    }));
  };
  const selectCustom = () => {
    setAnswers((current) => ({
      ...current,
      [question.questionId]: { answerKind: 'custom', selectedOptionId: '', customText: current[question.questionId]?.customText ?? '' },
    }));
  };
  const submit = () => {
    if (!allValid || isWorking) return;
    onSubmit(request.questions.map((item): AgentUserInputAnswer => {
      const value = answers[item.questionId];
      return value.answerKind === 'custom'
        ? { questionId: item.questionId, answerKind: 'custom', customText: value.customText.trim() }
        : { questionId: item.questionId, answerKind: 'option', selectedOptionId: value.selectedOptionId };
    }));
  };

  return (
    <div className={clsx('rounded-lg border p-4', isDark ? 'border-[#2f80ed]/40 bg-[#2f80ed]/10' : 'border-[#b8d7ff] bg-[#f3f8ff]')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={clsx('inline-flex items-center gap-2 rounded-full px-2 py-1 text-xs font-semibold text-white', isDark ? 'bg-[#1f2328]' : 'bg-indigo-600')}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            需要你决定
          </div>
          <div className="mt-3 text-base font-semibold">{request.title}</div>
          <p className={clsx('mt-1 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{request.reason}</p>
          {request.evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {request.evidence.map((item) => (
                <span key={item.evidenceId} className={clsx('rounded px-2 py-1 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'border border-[#d8e8ff] bg-white text-[var(--ui-text-muted)]')}>
                  已读取：{item.title}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className={clsx('shrink-0 rounded px-2 py-1 text-xs tabular-nums', isDark ? 'bg-white/10 text-neutral-300' : 'border border-[#d8e8ff] bg-white text-[var(--ui-text-muted)]')}>
          {questionIndex + 1} / {request.questions.length}
        </span>
      </div>

      <div className="mt-4">
        <div className={clsx('text-xs font-semibold', isDark ? 'text-[#76b7ff]' : 'text-indigo-600')}>{question.header}</div>
        <p className="mt-1 text-sm font-medium leading-6">{question.prompt}</p>
        <p className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
          推荐理由：{question.recommendationReason}
        </p>
      </div>

      <div className="mt-3 space-y-2">
        {question.options.map((option, optionIndex) => {
          const selected = answer.answerKind === 'option' && answer.selectedOptionId === option.optionId;
          return (
            <button
              key={option.optionId}
              type="button"
              onClick={() => selectOption(option.optionId)}
              className={clsx(
                'w-full rounded-md border px-3 py-2 text-left transition-colors',
                selected
                  ? (isDark ? 'border-[#2f80ed] bg-[#2f80ed]/20' : 'border-[#2f80ed] bg-white')
                  : (isDark ? 'border-white/10 bg-black/20 hover:bg-white/5' : 'border-[#d8e8ff] bg-white/70 hover:bg-white'),
              )}
            >
              <div className="flex items-start gap-3">
                <span className={clsx('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs', selected ? (isDark ? 'bg-[#2f80ed] text-white' : 'bg-indigo-600 text-white') : (isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]'))}>
                  {optionIndex + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {option.label}
                    {option.optionId === question.recommendedOptionId && (
                      <span className={clsx('rounded px-1.5 py-0.5 text-[10px]', isDark ? 'bg-[#2f80ed]/30 text-[#9dccff]' : 'bg-indigo-50 text-indigo-700')}>推荐</span>
                    )}
                  </span>
                  <span className={clsx('mt-0.5 block text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{option.description}</span>
                </span>
              </div>
            </button>
          );
        })}

        <div className={clsx('rounded-md border px-3 py-2', answer.answerKind === 'custom' ? (isDark ? 'border-[#2f80ed] bg-[#2f80ed]/20' : 'border-[#2f80ed] bg-white') : (isDark ? 'border-white/10 bg-black/20' : 'border-[#d8e8ff] bg-white/70'))}>
          <button type="button" onClick={selectCustom} className="flex w-full items-center gap-3 text-left">
            <span className={clsx('grid h-6 w-6 place-items-center rounded-full text-xs', answer.answerKind === 'custom' ? (isDark ? 'bg-[#2f80ed] text-white' : 'bg-indigo-600 text-white') : (isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]'))}>○</span>
            <span className="text-sm font-medium">都不是，告诉我如何做</span>
          </button>
          {answer.answerKind === 'custom' && (
            <textarea
              autoFocus
              value={answer.customText}
              onChange={(event) => setAnswers((current) => ({
                ...current,
                [question.questionId]: { answerKind: 'custom', selectedOptionId: '', customText: event.target.value },
              }))}
              rows={3}
              maxLength={4000}
              placeholder="输入具体要求……"
              className={clsx('mt-2 block w-full resize-none rounded-md border px-3 py-2 text-sm leading-6 outline-none', isDark ? 'border-white/10 bg-black/20 placeholder:text-neutral-600' : 'border-[#d8e8ff] bg-white placeholder:text-[var(--ui-text-disabled)]')}
            />
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setQuestionIndex((current) => Math.max(0, current - 1))}
          disabled={isWorking || questionIndex === 0}
          className={clsx('h-9 rounded-md border px-3 text-sm disabled:opacity-40', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[#d8e8ff] bg-white text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-subtle)]')}
        >
          上一个问题
        </button>
        <button
          type="button"
          onClick={() => isLast ? submit() : setQuestionIndex((current) => Math.min(request.questions.length - 1, current + 1))}
          disabled={isWorking || !currentValid || (isLast && !allValid)}
          className={clsx('inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm text-white disabled:opacity-50', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}
        >
          {isWorking && isLast ? <Loader2 className="h-4 w-4 animate-spin" /> : isLast ? <Send className="h-4 w-4" /> : null}
          {isLast ? '提交回答' : '下一个问题'}
        </button>
      </div>
    </div>
  );
}

function LegacyUserInputResolutionCard({ resolution, isDark }: { resolution: AgentUserInputResolution; isDark: boolean }) {
  const request = resolution.request;
  return (
    <div className={clsx('rounded-lg border p-4', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white')}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <CheckCircle2 className={clsx('h-4 w-4', isDark ? 'text-[#76b7ff]' : 'text-indigo-600')} />
        已提交 {resolution.answers.length} 个决定
      </div>
      <div className="mt-3 space-y-2">
        {resolution.answers.map((answer, index) => {
          const question = request?.questions.find((item) => item.questionId === answer.questionId);
          const selected = answer.answerKind === 'custom'
            ? answer.customText
            : answer.answerKind === 'skipped'
              ? '已跳过'
              : question?.options.find((item) => item.optionId === answer.selectedOptionId)?.label ?? answer.selectedOptionId;
          return (
            <div key={answer.questionId} className={clsx('text-sm leading-6', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-primary)]')}>
              {index + 1}. {question?.header ?? answer.questionId}：{selected}
            </div>
          );
        })}
      </div>
      <div className={clsx('mt-3 rounded-md px-3 py-2 text-sm leading-6', isDark ? 'bg-black/20 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
        AI 理解：{resolution.understandingSummary}
      </div>
    </div>
  );
}

function LegacyApprovalRequiredCard({
  approval,
  isDark,
  isWorking,
  onSubmit,
}: {
  approval: AgentApprovalRequest;
  isDark: boolean;
  isWorking: boolean;
  onSubmit: (selectedOptionIds: string[], freeText: string) => void;
}) {
  const [selectedOptionId, setSelectedOptionId] = useState(approval.options[0]?.id ?? '');
  const [freeText, setFreeText] = useState('');
  useEffect(() => {
    setSelectedOptionId(approval.options[0]?.id ?? '');
    setFreeText('');
  }, [approval.checkpointId]);

  return (
    <div className={clsx('rounded-lg border p-4', isDark ? 'border-[#2f80ed]/40 bg-[#2f80ed]/10' : 'border-[#b8d7ff] bg-[#f3f8ff]')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={clsx('inline-flex items-center gap-2 rounded-full px-2 py-1 text-xs font-semibold text-white', isDark ? 'bg-[#1f2328]' : 'bg-indigo-600')}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            需要你确认
          </div>
          <div className="mt-3 text-base font-semibold">{approval.title}</div>
          <p className={clsx('mt-1 text-sm leading-6', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-primary)]')}>{approval.question}</p>
          {approval.reason && (
            <p className={clsx('mt-2 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{approval.reason}</p>
          )}
        </div>
        <span className={clsx('rounded px-2 py-1 text-xs', isDark ? 'bg-white/10 text-neutral-300' : 'bg-white text-[var(--ui-text-muted)] border border-[#d8e8ff]')}>
          等待回答
        </span>
      </div>
      <div className="mt-4 space-y-2">
        {approval.options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setSelectedOptionId(option.id)}
            className={clsx(
              'w-full rounded-md border px-3 py-2 text-left transition-colors',
              selectedOptionId === option.id
                ? (isDark ? 'border-[#2f80ed] bg-[#2f80ed]/20' : 'border-[#2f80ed] bg-white')
                : (isDark ? 'border-white/10 bg-black/20 hover:bg-white/5' : 'border-[#d8e8ff] bg-white/70 hover:bg-white'),
            )}
          >
            <div className="flex items-start gap-3">
              <span className={clsx('mt-0.5 grid h-6 w-6 place-items-center rounded-full text-xs', selectedOptionId === option.id ? (isDark ? 'bg-[#1f2328] text-white' : 'bg-indigo-600 text-white') : (isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]'))}>
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.label}</span>
                {option.description && (
                  <span className={clsx('mt-0.5 block text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{option.description}</span>
                )}
              </span>
            </div>
          </button>
        ))}
      </div>
      {approval.allowFreeText && (
        <textarea
          value={freeText}
          onChange={(event) => setFreeText(event.target.value)}
          rows={2}
          placeholder="或者输入其他想法..."
          className={clsx('mt-3 block w-full resize-none rounded-md border px-3 py-2 text-sm leading-6 outline-none', isDark ? 'border-white/10 bg-black/20 placeholder:text-neutral-600' : 'border-[#d8e8ff] bg-white placeholder:text-[var(--ui-text-disabled)]')}
        />
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onSubmit([], '忽略该确认，按默认方案继续')}
          disabled={isWorking}
          className={clsx('h-9 px-3 rounded-md text-sm border disabled:opacity-50', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[#d8e8ff] bg-white text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-subtle)]')}
        >
          忽略
        </button>
        <button
          type="button"
          onClick={() => onSubmit(selectedOptionId ? [selectedOptionId] : [], freeText)}
          disabled={isWorking || (!selectedOptionId && !freeText.trim())}
          className={clsx('h-9 px-3 rounded-md inline-flex items-center gap-2 text-sm text-white disabled:opacity-50', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}
        >
          {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          提交
        </button>
      </div>
    </div>
  );
}

// Kept as source-level read compatibility while persisted legacy cards remain
// loadable; all live decision flows below use AgentDecisionCard.
void LegacyUserInputRequiredCard;
void LegacyUserInputResolutionCard;
void LegacyApprovalRequiredCard;

function UserInputRequiredCard({
  request,
  isDark,
  isWorking,
  draft,
  onDraftChange,
  onSubmit,
  onDismiss,
}: {
  request: AgentUserInputRequest;
  isDark: boolean;
  isWorking: boolean;
  draft?: UserInputCardDraft;
  onDraftChange: (draft: UserInputCardDraft) => void;
  onSubmit: (answers: AgentUserInputAnswer[]) => void;
  onDismiss: () => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(draft?.questionIndex ?? 0);
  const [answers, setAnswers] = useState<Record<string, AgentUserInputAnswer>>(draft?.answers ?? {});
  const [customQuestionId, setCustomQuestionId] = useState<string | null>(draft?.customQuestionId ?? null);
  const [customDrafts, setCustomDrafts] = useState<Record<string, string>>(draft?.customDrafts ?? {});
  const submittingRef = useRef(false);
  useEffect(() => {
    setQuestionIndex(draft?.questionIndex ?? 0);
    setAnswers(draft?.answers ?? {});
    setCustomQuestionId(draft?.customQuestionId ?? null);
    setCustomDrafts(draft?.customDrafts ?? {});
    submittingRef.current = false;
  }, [request.requestId]);
  useEffect(() => {
    onDraftChange({ questionIndex, answers, customQuestionId, customDrafts });
  }, [answers, customDrafts, customQuestionId, questionIndex]);
  useEffect(() => {
    if (!isWorking) submittingRef.current = false;
  }, [isWorking]);

  const question = request.questions[questionIndex];
  if (!question) return null;
  const answer = answers[question.questionId];
  const isLast = questionIndex === request.questions.length - 1;
  const customActive = customQuestionId === question.questionId;
  const customValue = customDrafts[question.questionId] ?? '';
  const submitCompleteAnswers = (nextAnswers: Record<string, AgentUserInputAnswer>) => {
    const ordered = request.questions.map((item) => nextAnswers[item.questionId]);
    if (isWorking || submittingRef.current || ordered.some((item) => !item)) return;
    submittingRef.current = true;
    onSubmit(ordered);
  };
  const saveAndAdvance = (nextAnswer: AgentUserInputAnswer) => {
    const nextAnswers = { ...answers, [question.questionId]: nextAnswer };
    setAnswers(nextAnswers);
    if (isLast) {
      if (nextAnswer.answerKind !== 'custom') setCustomQuestionId(null);
      submitCompleteAnswers(nextAnswers);
      return;
    }
    setCustomQuestionId(null);
    setQuestionIndex((current) => Math.min(request.questions.length - 1, current + 1));
  };
  const submitCustom = () => {
    const value = customValue.trim();
    if (!value) return;
    saveAndAdvance({ questionId: question.questionId, answerKind: 'custom', customText: value });
  };

  return (
    <AgentDecisionCard
      title={question.prompt}
      context={`${request.title} · 第 ${request.round ?? 1} 轮 · ${request.reason}${request.evidence.length ? ` · 已读取 ${request.evidence.length} 项上下文` : ''} · 推荐理由：${question.recommendationReason}`}
      options={question.options.map((option) => ({
        id: option.optionId,
        label: option.label,
        description: option.description,
        recommended: option.optionId === question.recommendedOptionId,
      }))}
      selectedOptionId={answer?.answerKind === 'option' ? answer.selectedOptionId : undefined}
      isDark={isDark}
      isWorking={isWorking}
      currentIndex={questionIndex}
      total={request.questions.length}
      canNavigateNext={Boolean(answer)}
      customActive={customActive}
      customValue={customValue}
      customActionLabel={isLast ? (isWorking ? '提交中' : '提交') : '下一步'}
      onSelect={(optionId) => saveAndAdvance({ questionId: question.questionId, answerKind: 'option', selectedOptionId: optionId })}
      onPrevious={() => {
        setCustomQuestionId(null);
        setQuestionIndex((current) => Math.max(0, current - 1));
      }}
      onNext={() => {
        if (!answer) return;
        setCustomQuestionId(null);
        setQuestionIndex((current) => Math.min(request.questions.length - 1, current + 1));
      }}
      onDismiss={onDismiss}
      onActivateCustom={() => setCustomQuestionId(question.questionId)}
      onCustomChange={(value) => setCustomDrafts((current) => ({ ...current, [question.questionId]: value }))}
      onCustomSubmit={submitCustom}
      onCustomEscape={() => setCustomQuestionId(null)}
      onSkip={() => saveAndAdvance({ questionId: question.questionId, answerKind: 'skipped' })}
    />
  );
}

function UserInputResolutionCard({ resolution, isDark }: { resolution: AgentUserInputResolution; isDark: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const request = resolution.request;
  const answerLabels = resolution.answers.map((item) => {
    const question = request?.questions.find((candidate) => candidate.questionId === item.questionId);
    const effective = resolution.effectiveAnswers?.find((candidate) => candidate.questionId === item.questionId);
    if (item.answerKind === 'custom') return item.customText;
    if (item.answerKind === 'skipped') {
      const recommended = question?.options.find((option) => option.optionId === effective?.selectedOptionId)?.label
        ?? effective?.selectedOptionId
        ?? '';
      return `已跳过；采用推荐项：${recommended}`;
    }
    return question?.options.find((option) => option.optionId === item.selectedOptionId)?.label ?? item.selectedOptionId;
  });
  const answerPreview = answerLabels.filter(Boolean).join('；');
  const visibleAnswerPreview = answerPreview.length > 160 ? `${answerPreview.slice(0, 157)}...` : answerPreview;
  const label = resolution.status === 'dismissed'
    ? `已关闭问题 · 第 ${resolution.round ?? 1} 轮`
    : `已提交 ${resolution.answers.length} 个决定 · 第 ${resolution.round ?? 1} 轮`;
  return (
    <section className={clsx('rounded-2xl border', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white')}>
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <CircleHelp className={clsx('h-4 w-4 shrink-0', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')} />
        <span className="min-w-0 flex-1">
          <span className={clsx('block text-sm', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{label}</span>
          {visibleAnswerPreview && (
            <span className={clsx('mt-0.5 block break-words text-sm leading-5', isDark ? 'text-neutral-200' : 'text-[var(--ui-text-primary)]')}>
              {visibleAnswerPreview}
            </span>
          )}
        </span>
        <ChevronDown className={clsx('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className={clsx('border-t px-4 py-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          <div className="space-y-2">
            {resolution.answers.map((item, index) => {
              const question = request?.questions.find((candidate) => candidate.questionId === item.questionId);
              return <p key={item.questionId} className="text-sm leading-6">{index + 1}. {question?.header ?? item.questionId}：{answerLabels[index]}</p>;
            })}
          </div>
          {resolution.understandingSummary && <p className={clsx('mt-3 rounded-xl px-3 py-2 text-sm leading-6', isDark ? 'bg-black/20 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>AI 理解：{resolution.understandingSummary}</p>}
        </div>
      )}
    </section>
  );
}

function ApprovalRequiredCard({
  approval,
  isDark,
  isWorking,
  draft,
  onDraftChange,
  onSubmit,
  onDismiss,
}: {
  approval: AgentApprovalRequest;
  isDark: boolean;
  isWorking: boolean;
  draft?: ApprovalCardDraft;
  onDraftChange: (draft: ApprovalCardDraft) => void;
  onSubmit: (selectedOptionIds: string[], freeText: string) => void;
  onDismiss: () => void;
}) {
  const [customActive, setCustomActive] = useState(draft?.customActive ?? false);
  const [freeText, setFreeText] = useState(draft?.freeText ?? '');
  useEffect(() => {
    setCustomActive(draft?.customActive ?? false);
    setFreeText(draft?.freeText ?? '');
  }, [approval.checkpointId]);
  useEffect(() => {
    onDraftChange({ customActive, freeText });
  }, [customActive, freeText]);
  const submitCustom = () => {
    const value = freeText.trim();
    if (value) onSubmit([], value);
  };
  const defaultOptionId = approval.options[0]?.id;
  const approvalContext = [
    approval.question !== approval.title ? approval.question : '',
    approval.reason !== approval.question && approval.reason !== approval.title ? approval.reason : '',
  ].filter(Boolean).join('\n');
  return (
    <AgentDecisionCard
      title={approval.title || '需要你确认'}
      context={approvalContext}
      options={approval.options.map((option, index) => ({ ...option, recommended: index === 0 }))}
      isDark={isDark}
      isWorking={isWorking}
      customAllowed={approval.allowFreeText}
      customActive={customActive}
      customValue={freeText}
      customActionLabel="提交"
      onSelect={(optionId) => onSubmit([optionId], '')}
      onDismiss={onDismiss}
      onActivateCustom={() => setCustomActive(true)}
      onCustomChange={setFreeText}
      onCustomSubmit={submitCustom}
      onCustomEscape={() => setCustomActive(false)}
      onSkip={() => defaultOptionId && onSubmit([defaultOptionId], '')}
    />
  );
}

function DraftCard({ draftSessionId, kind, isDark, onOpenReview }: { draftSessionId: string; kind: 'chapter' | 'creative-assets'; isDark: boolean; onOpenReview: () => void }) {
  const isCreativeAssets = kind === 'creative-assets';
  return (
    <div className={clsx('rounded-lg border p-4', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white')}>
      <div className="flex items-start gap-3">
        <div className={clsx('h-8 w-8 rounded-md grid place-items-center shrink-0', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')}>
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{isCreativeAssets ? '已生成创作素材审核包' : '已生成 Agent 草稿'}</div>
          <p className={clsx('mt-1 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>
            {isCreativeAssets
              ? '素材包已进入审核流程。可以在右侧检查器逐条添加审批意见或整包入库。'
              : '草稿进入审核流程。可以在右侧检查器查看差异、编辑反馈并确认写回。'}
          </p>
          <div className={clsx('mt-2 rounded border px-2 py-1 text-xs font-mono', isDark ? 'border-white/10 bg-black/20 text-neutral-400' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-muted)]')}>
            {draftSessionId}
          </div>
          <button
            type="button"
            onClick={onOpenReview}
            className={clsx('mt-3 h-9 px-3 rounded-md text-sm border', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}
          >
            {isCreativeAssets ? '打开素材审核' : '打开审核'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelSelector({
  settings,
  modelDraft,
  open,
  isSaving,
  error,
  isDark,
  onDraftChange,
  onToggle,
  onCancel,
  onSave,
}: {
  settings: AISettings | null;
  modelDraft: string;
  open: boolean;
  isSaving: boolean;
  error: string;
  isDark: boolean;
  onDraftChange: (value: string) => void;
  onToggle: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const isHttp = settings?.providerType === 'http';
  const label = !settings ? '读取模型...' : isHttp ? settings.http.model : 'MCP CLI';
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={clsx(
          'h-8 max-w-[190px] rounded-md px-2 inline-flex items-center gap-1.5 text-xs border truncate',
          isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border-strong)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]',
        )}
        title={label}
        aria-expanded={open}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-[#2f80ed]" />
        <span className="truncate">{label}</span>
        <ChevronDown className={clsx('h-3.5 w-3.5 shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className={clsx(
          'absolute bottom-10 left-0 z-40 w-[320px] rounded-lg border p-3 shadow-lg',
          isDark ? 'border-white/10 bg-[#1b1b21]' : 'border-[var(--ui-border-strong)] bg-white',
        )}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold">Agent 模型</div>
            <span className={clsx('rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
              {settings?.providerType === 'mcp-cli' ? 'MCP CLI' : settings ? 'HTTP' : '加载中'}
            </span>
          </div>

          {isHttp && settings ? (
            <div className="mt-3 space-y-3">
              <div>
                <label htmlFor="agent-model-name" className={clsx('text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>模型名称</label>
                <input
                  id="agent-model-name"
                  value={modelDraft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onSave();
                    if (event.key === 'Escape') onCancel();
                  }}
                  disabled={isSaving}
                  className={clsx(
                    'mt-1 h-9 w-full rounded-md border px-2 text-sm outline-none',
                    isDark ? 'border-white/10 bg-black/20 text-neutral-200 focus:border-[#2f80ed]' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)] focus:border-[#2f80ed]',
                  )}
                />
              </div>
              <div className={clsx('grid grid-cols-[72px_1fr] gap-y-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                <span>接口模式</span>
                <span className={isDark ? 'text-neutral-300' : 'text-[var(--ui-text-primary)]'}>{settings.http.apiMode === 'responses' ? 'Responses' : 'Chat Completions'}</span>
                <span>服务地址</span>
                <span className={clsx('truncate', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-primary)]')} title={settings.http.baseUrl}>{settings.http.baseUrl}</span>
              </div>
            </div>
          ) : (
            <div className={clsx('mt-3 rounded-md border px-3 py-2 text-xs leading-5', isDark ? 'border-white/10 text-neutral-400' : 'border-[var(--ui-border)] text-[var(--ui-text-muted)]')}>
              {settings ? settings.mcpCli.cliPath || '尚未配置 CLI 路径' : '正在读取 AI 设置...'}
            </div>
          )}

          {error && <div className={clsx('mt-3 text-xs', isDark ? 'text-red-300' : 'text-red-700')}>{error}</div>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onCancel} className={clsx('h-8 rounded-md px-3 text-xs', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')}>取消</button>
            {isHttp && (
              <button type="button" onClick={onSave} disabled={isSaving || !modelDraft.trim()} className={clsx('h-8 rounded-md px-3 text-xs text-white disabled:opacity-45', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}>
                {isSaving ? '应用中...' : '应用'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RoleSelector({
  value,
  options,
  open,
  isDark,
  onToggle,
  onSelect,
  onOpenDetail,
}: {
  value: AgentRoleMode;
  options: RoleOption[];
  open: boolean;
  isDark: boolean;
  onToggle: () => void;
  onSelect: (role: AgentRoleMode) => void;
  onOpenDetail: () => void;
}) {
  const current = options.find((role) => role.id === value) ?? options[0] ?? ROLE_OPTIONS[0];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={clsx(
          'h-8 max-w-[150px] rounded-md px-2 inline-flex items-center gap-1.5 text-xs border truncate',
          isDark ? 'border-white/10 text-neutral-200 hover:bg-white/5' : 'border-[var(--ui-border-strong)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]',
        )}
      >
        <UserRound className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{current.label}</span>
        <ChevronDown className={clsx('h-3.5 w-3.5 shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className={clsx(
          'absolute bottom-10 left-0 z-30 w-[260px] rounded-lg border p-1 shadow-lg',
          isDark ? 'border-white/10 bg-[#17171d] shadow-black/40' : 'border-[var(--ui-border-strong)] bg-white shadow-black/10',
        )}>
          {options.map((role) => (
            <button
              key={role.id}
              type="button"
              onClick={() => onSelect(role.id)}
              className={clsx(
                'w-full rounded-md px-2 py-2 text-left transition-colors',
                value === role.id
                  ? (isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')
                  : (isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-subtle)]'),
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{role.label}</span>
                {value === role.id && <CheckCircle2 className="h-4 w-4 text-[#2f80ed]" />}
              </div>
              <div className={clsx('mt-0.5 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{role.desc}</div>
            </button>
          ))}
          <div className={clsx('my-1 h-px', isDark ? 'bg-white/10' : 'bg-[var(--ui-border)]')} />
          <button
            type="button"
            onClick={onOpenDetail}
            className={clsx('w-full rounded-md px-2 py-2 text-left text-sm transition-colors', isDark ? 'text-neutral-300 hover:bg-white/5' : 'text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}
          >
            角色能力说明
            <div className={clsx('mt-0.5 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>查看角色职责、能力标签和工具权限</div>
          </button>
        </div>
      )}
    </div>
  );
}

function ApprovalSelector({
  value,
  open,
  isDark,
  onToggle,
  onSelect,
}: {
  value: ApprovalMode;
  open: boolean;
  isDark: boolean;
  onToggle: () => void;
  onSelect: (mode: ApprovalMode) => void;
}) {
  const current = APPROVAL_OPTIONS.find((option) => option.id === value) ?? APPROVAL_OPTIONS[0];
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={onToggle}
        title={`工作模式：${current.label}。${current.desc}`}
        className={clsx(
          'h-8 whitespace-nowrap rounded-md px-2 inline-flex items-center gap-1.5 text-xs border',
          isDark ? 'border-white/10 text-neutral-200 hover:bg-white/5' : 'border-[var(--ui-border-strong)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]',
        )}
      >
        <span>工作模式</span>
        <ChevronDown className={clsx('h-3.5 w-3.5 shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className={clsx(
          'absolute bottom-10 left-0 z-30 w-[260px] rounded-lg border p-1 shadow-lg',
          isDark ? 'border-white/10 bg-[#17171d] shadow-black/40' : 'border-[var(--ui-border-strong)] bg-white shadow-black/10',
        )}>
          {APPROVAL_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={option.disabled}
              onClick={() => onSelect(option.id)}
              className={clsx(
                'w-full rounded-md px-2 py-2 text-left transition-colors disabled:opacity-45 disabled:cursor-not-allowed',
                value === option.id
                  ? (isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')
                  : (isDark ? 'hover:bg-white/5' : 'hover:bg-[var(--ui-surface-subtle)]'),
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{option.label}</span>
                {value === option.id && <CheckCircle2 className="h-4 w-4 text-[#2f80ed]" />}
              </div>
              <div className={clsx('mt-0.5 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{option.desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function InspectorPanel({
  isDark,
  narrowOpen,
  onClose,
  activeTab,
  onTabChange,
  expanded,
  onToggleExpanded,
  onResizeStart,
  onResizeReset,
  novel,
  currentChapter,
  novelId,
  sourceConversationId,
  messages,
  contextSummary,
  contextSummaryRebuilding,
  activeRun,
  reportReviewAvailability,
  conversationRuns,
  activeRole,
  roleOptions,
  volumes,
  reviewTarget,
  draftSelection,
  draftBatchRecords,
  onReviewTargetChange,
  onRebuildContextSummary,
  onUsePreset,
  onArtifactStatusChange,
  onDraftBatchStatusChange,
  onArtifactReviewChange,
  onRegenerateDraftBatch,
  onDiscussReviewComments,
  onRegenerateDraft,
  onDraftBatchLoaded,
  onSelectReviewRun,
  onSkillPublished,
  onInitializeNovelProject,
}: {
  isDark: boolean;
  narrowOpen: boolean;
  onClose: () => void;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeReset: () => void;
  novel: Novel | null;
  currentChapter: AgentChapterContext | null;
  novelId: string;
  sourceConversationId: string;
  messages: ConversationMessage[];
  contextSummary: AgentConversationSummary | AgentConversationSummaryV2 | null;
  contextSummaryRebuilding: boolean;
  activeRun: AgentRun | null;
  reportReviewAvailability: ReportReviewAvailability;
  conversationRuns: AgentRun[];
  activeRole: AgentRoleMode;
  roleOptions: RoleOption[];
  volumes: Volume[];
  reviewTarget: 'draft' | 'report';
  draftSelection: DraftInspectorSelection | null;
  draftBatchRecords: Record<string, DraftBatchRecord>;
  onReviewTargetChange: (target: 'draft' | 'report') => void;
  onRebuildContextSummary: (conversationId: string) => void;
  onUsePreset: (role: AgentRoleMode, preset: AgentPresetTask) => void;
  onArtifactStatusChange: (draftSessionId: string, status: AgentArtifact['status']) => void;
  onDraftBatchStatusChange: (draftBatchId: string, status: AgentArtifact['status']) => void;
  onArtifactReviewChange: (artifactId: string, result: ArtifactReviewSubmitResult) => void;
  onRegenerateDraftBatch: (batch: DraftBatchRecord, fromChildIndex: number, comments?: ReviewCommentRecord[]) => Promise<void>;
  onDiscussReviewComments: (comments: ReviewCommentRecord[]) => Promise<void>;
  onRegenerateDraft: (session: DraftSessionRecord, comments: ReviewCommentRecord[]) => Promise<void>;
  onDraftBatchLoaded: (batch: DraftBatchRecord) => void;
  onSelectReviewRun: (runId: string | null) => void;
  onSkillPublished: () => Promise<void>;
  onInitializeNovelProject: (artifact: AgentArtifact) => void;
}) {
  const { t } = useTranslation();
  const tabs: Array<{ id: InspectorTab; label: string }> = [
    { id: 'context', label: '上下文' },
    { id: 'artifacts', label: '产物' },
    { id: 'review', label: '审核' },
    { id: 'evidence', label: '证据' },
    { id: 'roles', label: '角色' },
  ];
  const hasExpertReport = Boolean(activeRun?.artifacts?.some((artifact) => getExpertReport(artifact)));
  const hasCreativeAssetsReview = Boolean(activeRun?.artifacts?.some((artifact) => artifact.type === 'creative_assets_draft'));
  const isReview = activeTab === 'review';
  const selectedDraftBatchId = draftSelection?.kind === 'chapter_beat_snapshot'
    ? draftSelection.draftBatchId
    : draftSelection?.draftBatchId || activeRun?.draftBatchId;
  const selectedDraftBatch = selectedDraftBatchId ? draftBatchRecords[selectedDraftBatchId] : null;
  const selectedGeneratedCount = selectedDraftBatch
    ? new Set(selectedDraftBatch.children.flatMap((child) => child.draftSessionId && ['draft', 'stale', 'committed'].includes(child.status) ? [child.childIndex] : [])).size
    : 0;
  const hasDraftReview = Boolean(activeRun?.draftSessionId || selectedDraftBatchId);
  const showsReportReview = reviewTarget === 'report' && hasExpertReport;
  const isDraftReview = isReview && !showsReportReview && hasDraftReview;
  const reviewTitle = isDraftReview
    ? draftSelection?.kind === 'chapter_beat_snapshot'
      ? `章节节拍预览 · v${draftSelection.outlineRevision}`
      : draftSelection?.kind === 'draft_batch_interrupted'
        ? '章节生成未完成'
        : draftSelection?.kind === 'draft_batch_progress'
          ? selectedGeneratedCount > 0
            ? `已生成内容 · ${selectedGeneratedCount}/${selectedDraftBatch?.children.length ?? selectedGeneratedCount}`
            : '章节生成进度'
          : draftSelection?.kind === 'draft_batch_review' || selectedDraftBatchId
            ? '多章节草稿审核'
            : hasCreativeAssetsReview ? '创作素材审核' : '草稿审核中心'
    : '报告审核';
  return (
    <aside className={clsx(
      'relative border-l min-h-0 min-w-0 overflow-hidden flex flex-col max-[1040px]:absolute max-[1040px]:inset-y-0 max-[1040px]:right-0 max-[1040px]:z-40 max-[1040px]:w-[calc(100vw-16px)] max-[1040px]:shadow-[-16px_0_40px_rgba(17,24,39,0.12)]',
      !narrowOpen && 'max-[1040px]:hidden',
      isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]',
    )}>
      {!expanded && (
        <div
          role="separator"
          aria-label={t('agentWorkspace.inspector.resize')}
          aria-orientation="vertical"
          onPointerDown={onResizeStart}
          onDoubleClick={onResizeReset}
          className="absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize touch-none min-[1041px]:block"
        >
          <div className={clsx('mx-auto h-full w-px transition-colors', isDark ? 'bg-white/10 hover:bg-blue-400' : 'bg-[var(--ui-border)] hover:bg-[#2f80ed]')} />
        </div>
      )}
      <div className="p-4 border-b border-inherit">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {isReview ? <FileText className="h-4 w-4 text-[#2f80ed]" /> : <MessageSquare className="h-4 w-4" />}
            {isReview ? reviewTitle : t('agentWorkspace.inspector.title')}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onToggleExpanded}
              className={clsx('hidden h-8 w-8 place-items-center rounded-md min-[1041px]:grid', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white')}
              title={expanded ? '恢复侧栏' : '放大阅读'}
              aria-label={expanded
                ? t('agentWorkspace.inspector.restoreSidebar')
                : t('agentWorkspace.inspector.enlarge')}
              aria-pressed={expanded}
            >
              {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={clsx('grid h-8 w-8 place-items-center rounded-md', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white')}
              title={t('agentWorkspace.inspector.collapse')}
              aria-label={t('agentWorkspace.inspector.collapse')}
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="mt-3 overflow-x-auto rounded-md border border-inherit p-1">
          <div className="grid min-w-[320px] grid-cols-5 gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  if (tab.id === 'review') onReviewTargetChange(hasExpertReport ? 'report' : 'draft');
                  onTabChange(tab.id);
                }}
                className={clsx(
                  'h-8 min-w-0 whitespace-nowrap rounded px-1 text-xs',
                  activeTab === tab.id
                    ? (isDark ? 'bg-white/10 text-white' : 'bg-white text-[var(--ui-text-primary)] shadow-[0_1px_4px_rgba(0,0,0,0.04)]')
                    : (isDark ? 'text-neutral-500 hover:text-neutral-300' : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'),
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className={clsx(
        'flex-1 min-h-0',
        isDraftReview || activeTab === 'artifacts' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto p-4',
      )}>
        {activeTab === 'context' && (
          <div className="space-y-3">
            <InspectorItem label="当前小说" value={novel?.title || '未命名小说'} isDark={isDark} />
            <InspectorItem label="编辑器当前章" value={currentChapter?.title || '未选择'} isDark={isDark} />
            <InspectorItem label="编辑器章节字数" value={String(currentChapter?.wordCount ?? 0)} isDark={isDark} />
            <InspectorItem label="当前能力" value="RAG、搜索、章节草稿、创作素材草稿" isDark={isDark} />
            <PersistentContextSummaryCard
              isDark={isDark}
              summary={contextSummary}
              rebuilding={contextSummaryRebuilding}
              onRebuild={() => onRebuildContextSummary(sourceConversationId)}
            />
            <ContextDiagnosticsPanel isDark={isDark} messages={messages} />
            <RoleMatrix isDark={isDark} roleOptions={roleOptions} />
          </div>
        )}
        {activeTab === 'review' && (
          showsReportReview ? (
            <ExpertReportPanel
              isDark={isDark}
              artifacts={activeRun?.artifacts ?? []}
              volumes={volumes}
              reviewAvailability={reportReviewAvailability}
              onReviewSubmitted={onArtifactReviewChange}
            />
          ) : draftSelection?.kind === 'chapter_beat_snapshot' ? (
            <ChapterBeatPreviewPanel
              isDark={isDark}
              beats={draftSelection.beats as DraftBatchRecord['outline']['beats']}
              revision={draftSelection.outlineRevision}
              historical={draftSelection.historical}
              statusLabel={draftSelection.statusLabel}
              chapterLabels={draftSelection.beats.map((beat, index) => (
                selectedDraftBatch
                  ? resolveDraftBatchChapterDisplay(selectedDraftBatch, beat.childIndex ?? index, volumes).shortLabel
                  : `批次第 ${index + 1} 章`
              ))}
            />
          ) : selectedDraftBatchId ? (
            <DraftBatchReviewPanel
              isDark={isDark}
              draftBatchId={selectedDraftBatchId}
              mode={draftSelection?.kind === 'draft_batch_progress'
                ? 'progress'
                : draftSelection?.kind === 'draft_batch_interrupted'
                  ? 'interrupted'
                  : 'review'}
              reviewContext={{
                novelId,
                sourceConversationId,
                sourceRunId: draftSelection?.runId || activeRun?.runId || '',
                sourceArtifactId: activeRun?.artifacts?.find((artifact) => artifact.reference?.draftBatchId === selectedDraftBatchId)?.artifactId,
              }}
              volumes={volumes}
              onBatchStatusChange={onDraftBatchStatusChange}
              onRegenerate={onRegenerateDraftBatch}
              onDiscuss={onDiscussReviewComments}
              onBatchLoaded={onDraftBatchLoaded}
            />
          ) : (
            <ReviewPanel
              isDark={isDark}
              activeRun={activeRun}
              novelId={novelId}
              sourceConversationId={sourceConversationId}
              volumes={volumes}
              onArtifactStatusChange={onArtifactStatusChange}
              onDiscuss={onDiscussReviewComments}
              onRegenerate={onRegenerateDraft}
            />
          )
        )}
        {activeTab === 'artifacts' && (
          <ArtifactPanelErrorBoundary key={`${sourceConversationId}:${activeRun?.runId ?? 'all'}`} isDark={isDark}>
            <ArtifactPanel
              isDark={isDark}
              runs={conversationRuns}
              preferredRunId={activeRun?.runId ?? null}
              onSkillPublished={onSkillPublished}
              onInitializeNovelProject={onInitializeNovelProject}
              onOpenReview={(target, artifact) => {
                onSelectReviewRun(artifact.runId);
                onReviewTargetChange(target);
                onTabChange('review');
              }}
            />
          </ArtifactPanelErrorBoundary>
        )}
        {activeTab === 'evidence' && (
          <EvidencePanel isDark={isDark} activeRun={activeRun} />
        )}
        {activeTab === 'roles' && (
          <RoleSkillPanel isDark={isDark} activeRole={activeRole} roleOptions={roleOptions} onUsePreset={onUsePreset} />
        )}
      </div>
    </aside>
  );
}

function contextSectionLabel(id: string): string {
  const labels: Record<string, string> = {
    'available-read-tools': '可用只读工具',
    'tool-observations': '本轮工具结果',
    'conversation-state': '计划、审批与产物状态',
    'chapter-context': '章节上下文',
    'context-references': '上下文引用',
  };
  return labels[id] || id;
}

function contextSourceModeLabel(mode: AgentContextHistorySource['mode'] | AgentContextSectionSource['mode']): string {
  if (mode === 'summary') return '摘要';
  if (mode === 'compressed') return '已精简';
  if (mode === 'omitted') return '未纳入';
  return '原文';
}

function PersistentContextSummaryCard({
  isDark,
  summary,
  rebuilding,
  onRebuild,
}: {
  isDark: boolean;
  summary: AgentConversationSummary | AgentConversationSummaryV2 | null;
  rebuilding: boolean;
  onRebuild: () => void;
}) {
  if (!summary) return null;
  const isV2 = summary.version === 'agent-conversation-summary-v2';
  const decisions = isV2 ? summary.semanticProjection.confirmedDecisions : summary.userDecisions;
  const questions = isV2 ? summary.semanticProjection.unresolvedQuestions : summary.unresolvedQuestions;
  const artifactRefs = isV2 ? summary.semanticProjection.artifactRefs : summary.artifactRefs;
  const facts = isV2
    ? [...summary.semanticProjection.canonFacts, ...summary.semanticProjection.creativeContinuity]
    : summary.facts;
  const pending = isV2
    ? [...summary.semanticProjection.activeIntent, ...summary.semanticProjection.pendingWork]
    : [];
  const summaryGroups: Array<[
    string,
    Array<AgentConversationSummaryEntry | AgentConversationSummaryEntryV2>,
  ]> = [
    ['当前意图与工作', pending],
    ['用户决策', decisions],
    ['来源事实', facts],
    ['未决问题', questions],
  ];
  return (
    <details className={clsx('rounded-lg border overflow-hidden', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
      <summary className="cursor-pointer list-none p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Save className="h-4 w-4 shrink-0 text-[#2f80ed]" />
              持久上下文摘要
            </div>
            <div className={clsx('mt-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
              覆盖 {summary.coverage.messageCount} 条消息 · {artifactRefs.length} 个产物引用
              {isV2 ? ` · ${summary.sourceIndex.userMessageLedger.length} 条用户来源` : ''}
            </div>
          </div>
          <span className={clsx('shrink-0 rounded px-2 py-1 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
            v{summary.revision}{isV2 ? ` · g${summary.generation}` : ''}
          </span>
        </div>
      </summary>
      <div className={clsx('border-t px-3 py-3 space-y-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onRebuild}
            disabled={rebuilding}
            className={clsx(
              'inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-55',
              isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-subtle)]',
            )}
            title="从完整权威消息重新生成上下文摘要"
          >
            {rebuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            {rebuilding ? '重建中' : '质量重建'}
          </button>
        </div>
        {summaryGroups.map(([label, values]) => {
          if (!values.length) return null;
          return (
            <div key={String(label)}>
              <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>{label}</div>
              <div className="mt-1.5 space-y-1.5">
                {values.slice(-4).map((entry) => (
                  <div key={entry.id} className="text-xs leading-5 break-words">
                    {entry.text}
                    <span className={clsx('ml-2 text-[10px]', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>
                      {(entry.sourceMessageIds || []).length} 个来源
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {artifactRefs.length > 0 && (
          <div>
            <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>产物引用</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {artifactRefs.slice(-6).map((artifact) => (
                <span key={artifact.artifactId} className={clsx('max-w-full truncate rounded px-1.5 py-1 text-[11px]', isDark ? 'bg-white/5 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-secondary)]')} title={artifact.artifactId}>
                  {artifact.title}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function ContextDiagnosticsPanel({ isDark, messages }: { isDark: boolean; messages: ConversationMessage[] }) {
  const records = messages.flatMap((message) => {
    if (message.role !== 'assistant') return [];
    const diagnostics = normalizeContextDiagnostics(message.contextDiagnostics);
    return diagnostics ? [{ message, diagnostics }] : [];
  });
  const latest = records[records.length - 1];
  if (!latest) {
    return (
      <section className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardList className="h-4 w-4 text-[#2f80ed]" />
          本次模型上下文
        </div>
        <p className={clsx('mt-2 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
          下一次 Agent 回复后，这里会显示实际输入预算、原文、摘要和省略来源。
        </p>
      </section>
    );
  }

  const { diagnostics, message } = latest;
  const budgetRatio = diagnostics.inputBudgetTokens > 0
    ? Math.min(100, Math.round((diagnostics.estimatedInputTokens / diagnostics.inputBudgetTokens) * 100))
    : 0;
  const createdAt = Number.isNaN(Date.parse(message.createdAt))
    ? ''
    : new Date(message.createdAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const includedSections = diagnostics.sectionSources.filter((source) => source.mode !== 'omitted');
  const omittedSections = diagnostics.sectionSources.filter((source) => source.mode === 'omitted');

  return (
    <section className={clsx('rounded-lg border overflow-hidden', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList className="h-4 w-4 shrink-0 text-[#2f80ed]" />
            本次模型上下文
          </div>
          <div className={clsx('mt-1 truncate text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
            {diagnostics.model} · {createdAt}
          </div>
        </div>
        <span className={clsx(
          'shrink-0 rounded px-2 py-1 text-[11px] font-medium',
          diagnostics.compressionApplied
            ? (isDark ? 'bg-amber-400/10 text-amber-300' : 'bg-amber-50 text-amber-700')
            : (isDark ? 'bg-emerald-400/10 text-emerald-300' : 'bg-emerald-50 text-emerald-700'),
        )}>
          {diagnostics.compressionApplied ? '已压缩' : '完整纳入'}
        </span>
      </div>

      <div className={clsx('border-y px-3 py-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className={isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]'}>输入预算</span>
          <span className="tabular-nums">
            {diagnostics.estimatedInputTokens.toLocaleString()} / {diagnostics.inputBudgetTokens.toLocaleString()} Token
          </span>
        </div>
        <div className={clsx('mt-2 h-1.5 overflow-hidden rounded-sm', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')}>
          <div
            className={clsx('h-full rounded-sm', budgetRatio >= 90 ? 'bg-amber-500' : 'bg-[#2f80ed]')}
            style={{ width: `${Math.max(2, budgetRatio)}%` }}
          />
        </div>
        <div className={clsx('mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
          <span>窗口 {diagnostics.contextWindowTokens.toLocaleString()}</span>
          <span>输出预留 {diagnostics.outputTokens.toLocaleString()}</span>
          <span>安全余量 {diagnostics.safetyTokens.toLocaleString()}</span>
          {diagnostics.providerReserveTokens !== undefined && <span>Provider 余量 {diagnostics.providerReserveTokens.toLocaleString()}</span>}
          {diagnostics.fixedProviderInputTokens !== undefined && <span>固定输入 {diagnostics.fixedProviderInputTokens.toLocaleString()}</span>}
          <span>{diagnostics.contextWindowSource === 'configured'
            ? '手动配置'
            : diagnostics.contextWindowSource === 'compatibility-fallback'
              ? '兼容能力'
              : '模型档案'}</span>
        </div>
      </div>

      <div className="grid grid-cols-4 divide-x divide-inherit border-b border-inherit">
        {[
          ['原文', diagnostics.historyMessagesKept],
          ['摘要', diagnostics.historyMessagesSummarized],
          ['精简', diagnostics.historyMessagesCompacted],
          ['省略', diagnostics.historyMessagesOmitted],
        ].map(([label, value]) => (
          <div key={String(label)} className="px-2 py-3 text-center">
            <div className="text-sm font-semibold tabular-nums">{value}</div>
            <div className={clsx('mt-0.5 text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{label}</div>
          </div>
        ))}
      </div>

      <div className="p-3 space-y-3">
        <div>
          <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>会话来源</div>
          <div className="mt-1.5 space-y-1">
            <ContextSourceRow label="当前请求" mode={diagnostics.currentRequestMode} isDark={isDark} />
            {diagnostics.persistentConstraintsCount > 0 && (
              <ContextSourceRow label={`长期约束 ${diagnostics.persistentConstraintsCount} 项`} mode="raw" isDark={isDark} />
            )}
            {diagnostics.persistentSummaryRevision > 0 && (
              <ContextSourceRow
                label={`持久摘要 v${diagnostics.persistentSummaryRevision}`}
                detail={`${diagnostics.persistentSummaryMessageCount} 条消息`}
                mode="summary"
                isDark={isDark}
              />
            )}
            {diagnostics.recalledMessageIds.length > 0 && (
              <ContextSourceRow label={`按引用召回消息 ${diagnostics.recalledMessageIds.length} 条`} mode="raw" isDark={isDark} />
            )}
            {diagnostics.recalledArtifactIds.length > 0 && (
              <ContextSourceRow label={`按引用召回产物 ${diagnostics.recalledArtifactIds.length} 个`} mode="raw" isDark={isDark} />
            )}
            {diagnostics.historySources.map((source, index) => (
              <ContextSourceRow
                key={`${source.mode}-${source.startMessageIndex}-${source.endMessageIndex}-${index}`}
                label={source.startMessageIndex === source.endMessageIndex
                  ? `历史消息 #${source.startMessageIndex + 1}`
                  : `历史消息 #${source.startMessageIndex + 1}-${source.endMessageIndex + 1}`}
                mode={source.mode}
                isDark={isDark}
              />
            ))}
          </div>
        </div>

        {(includedSections.length > 0 || omittedSections.length > 0) && (
          <div>
            <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>项目资料</div>
            <div className="mt-1.5 space-y-1">
              {[...includedSections, ...omittedSections].map((source) => (
                <ContextSourceRow
                  key={`${source.id}-${source.mode}`}
                  label={contextSectionLabel(source.id)}
                  detail={source.estimatedTokens > 0 ? `约 ${source.estimatedTokens.toLocaleString()} Token` : undefined}
                  mode={source.mode}
                  isDark={isDark}
                />
              ))}
            </div>
          </div>
        )}

        {diagnostics.coordinator && (
          <div>
            <div className={clsx('text-[11px] font-medium', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>语义压缩</div>
            <div className={clsx('mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
              <span>模式 {diagnostics.coordinator.mode}</span>
              <span>操作 {diagnostics.coordinator.operationKind || 'none'}</span>
              <span>触发 {diagnostics.coordinator.triggerReason || 'none'}</span>
              <span>generation {diagnostics.coordinator.summaryGeneration}</span>
              <span>覆盖 {diagnostics.coordinator.coverageMessageCount} 条</span>
              <span>近期原文 {diagnostics.coordinator.recentTailMessageCount} 条</span>
              <span>近期尾部 {(diagnostics.coordinator.recentTailContextTokens ?? 0).toLocaleString()} Token / {diagnostics.coordinator.recentTailUnitCount ?? 0} 回合</span>
              <span>消息来源 {diagnostics.coordinator.sourceHashStatus}</span>
              <span>项目依赖 {diagnostics.coordinator.dependencyHashStatus}</span>
              <span className="col-span-2">
                当前请求 {diagnostics.coordinator.currentRequestIdentityStatus || 'not_applicable'}
                {` · payload ${diagnostics.coordinator.currentRequestPayloadOccurrences ?? 0} 次`}
              </span>
              {(diagnostics.coordinator.coverageStartMessageId || diagnostics.coordinator.coverageEndMessageId) && (
                <span className="col-span-2 break-all">
                  边界 {diagnostics.coordinator.coverageStartMessageId || 'none'} → {diagnostics.coordinator.coverageEndMessageId || 'none'}
                </span>
              )}
              {diagnostics.coordinator.blockingUnitId && (
                <span className="col-span-2 break-all">
                  阻断 {diagnostics.coordinator.blockingUnitId} · sequence {diagnostics.coordinator.blockingSequenceStart ?? '?'}-{diagnostics.coordinator.blockingSequenceEnd ?? '?'}
                </span>
              )}
              <span>上下文 {(diagnostics.coordinator.preCompressionContextTokens ?? 0).toLocaleString()} → {(diagnostics.coordinator.postCompressionContextTokens ?? 0).toLocaleString()}</span>
              <span>Provider {(diagnostics.coordinator.preCompressionProviderInputTokens ?? 0).toLocaleString()} → {(diagnostics.coordinator.postCompressionProviderInputTokens ?? 0).toLocaleString()}</span>
              <span className="col-span-2 break-all">
                计数 {diagnostics.coordinator.hardTokenCountMethod || diagnostics.hardTokenCountMethod || 'unknown'} · {diagnostics.coordinator.hardTokenCountProfileId || diagnostics.tokenCounterProfileId || 'unknown'}
              </span>
              {diagnostics.coordinator.rebuildStatus && diagnostics.coordinator.rebuildStatus !== 'idle' && (
                <span className="col-span-2">
                  重建 {diagnostics.coordinator.rebuildStatus}
                  {` · ${diagnostics.coordinator.rebuildCompletedChunks ?? diagnostics.coordinator.rebuildChunksCompleted ?? 0}/${diagnostics.coordinator.rebuildMaxChunks ?? diagnostics.coordinator.rebuildChunkCount ?? 0} 块`}
                  {diagnostics.coordinator.rebuildMaxDurationMs
                    ? ` · ${Math.round((diagnostics.coordinator.rebuildElapsedMs || 0) / 1000)}/${Math.round(diagnostics.coordinator.rebuildMaxDurationMs / 1000)} 秒`
                    : ''}
                </span>
              )}
              {diagnostics.coordinator.rebuildTaskId && (
                <span className="col-span-2 break-all">任务 {diagnostics.coordinator.rebuildTaskId}</span>
              )}
              {(diagnostics.coordinator.statusCodes?.length || 0) > 0 && (
                <span className="col-span-2 break-all">状态码 {diagnostics.coordinator.statusCodes.join(', ')}</span>
              )}
              {!diagnostics.coordinator.statusCodes?.length && diagnostics.coordinator.failureCode && !diagnostics.coordinator.errorCode && (
                <span className="col-span-2 break-all">状态码 {diagnostics.coordinator.failureCode}</span>
              )}
              {diagnostics.coordinator.errorCode && (
                <span className="col-span-2 break-all">错误码 {diagnostics.coordinator.errorCode}</span>
              )}
              <span className="col-span-2">
                ledger {diagnostics.coordinator.sourceIndexLedgerEntries ?? 0} 条 / {(diagnostics.coordinator.sourceIndexBytes ?? 0).toLocaleString()} B
                {` · semantic ${diagnostics.coordinator.semanticLedgerEntries ?? 0}`}
                {` · transient ${diagnostics.coordinator.transientLedgerEntries ?? 0}`}
                {` · 可召回 ${diagnostics.coordinator.unprojectedSemanticMessageCount ?? 0}`}
                {` · 失效来源 ${diagnostics.coordinator.invalidatedSourceCount ?? 0}`}
              </span>
              {diagnostics.coordinator.qualitySample && (
                <span className="col-span-2">
                  质量采样 {diagnostics.coordinator.qualitySample.reason}
                  {` · revision ${diagnostics.coordinator.qualitySample.revision}`}
                  {` · 投影 ${diagnostics.coordinator.qualitySample.projectionEntryCount}`}
                  {` · semantic ${diagnostics.coordinator.qualitySample.directlyProjectedSemanticEntries}/${diagnostics.coordinator.qualitySample.semanticLedgerEntries}`}
                </span>
              )}
              {diagnostics.coordinator.compactor && (
                <span className="col-span-2 break-all">
                  Compactor {diagnostics.coordinator.compactor.providerType || diagnostics.providerType}/{diagnostics.coordinator.compactor.model || diagnostics.model}
                  {` · ${(diagnostics.coordinator.compactor.inputTokens ?? diagnostics.coordinator.compactor.inputBytes ?? 0).toLocaleString()}→${(diagnostics.coordinator.compactor.outputTokens ?? diagnostics.coordinator.compactor.outputBytes ?? 0).toLocaleString()} Token`}
                  {` · ${diagnostics.coordinator.compactor.elapsedMs}ms · retry ${diagnostics.coordinator.compactor.retries}`}
                </span>
              )}
            </div>
          </div>
        )}

        <div className={clsx('text-[11px]', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>
          已记录本会话最近 {records.length} 次模型上下文诊断
        </div>
      </div>
    </section>
  );
}

function ContextSourceRow({
  label,
  detail,
  mode,
  isDark,
}: {
  label: string;
  detail?: string;
  mode: AgentContextHistorySource['mode'] | AgentContextSectionSource['mode'];
  isDark: boolean;
}) {
  const isOmitted = mode === 'omitted';
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
      <span className={clsx('min-w-0 truncate', isOmitted && (isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]'))}>{label}</span>
      <span className="flex shrink-0 items-center gap-2">
        {detail && <span className={clsx('tabular-nums', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')}>{detail}</span>}
        <span className={clsx(
          'rounded px-1.5 py-0.5 text-[10px]',
          isOmitted
            ? (isDark ? 'bg-white/5 text-neutral-500' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')
            : mode === 'raw'
              ? (isDark ? 'bg-emerald-400/10 text-emerald-300' : 'bg-emerald-50 text-emerald-700')
              : (isDark ? 'bg-amber-400/10 text-amber-300' : 'bg-amber-50 text-amber-700'),
        )}>
          {contextSourceModeLabel(mode)}
        </span>
      </span>
    </div>
  );
}

function InspectorItem({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  return (
    <div className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
      <div className={clsx('text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{label}</div>
      <div className="mt-1 text-sm leading-5">{value}</div>
    </div>
  );
}

function artifactTypeLabel(type: AgentArtifact['type']): string {
  if (type === 'novel_bootstrap_draft') return '小说项目蓝图';
  if (type === 'chapter_draft') return '章节草稿';
  if (type === 'chapter_draft_batch') return '多章节草稿批次';
  if (type === 'creative_assets_draft') return '创作素材草稿';
  if (type === 'context_bundle') return '上下文包';
  if (type === 'chapter_scope_context') return '多章节范围上下文';
  if (type === 'consistency_review') return '一致性审核';
  if (type === 'plotline_analysis') return '情节线分析';
  if (type === 'writer_revision_plan') return '作者修订计划';
  if (type === 'chapter_range_review') return '编辑范围审核';
  if (type === 'reader_journey') return '读者旅程';
  if (type === 'worldbuilding_consistency') return '世界观一致性';
  if (type === 'research_fact_check') return '事实核查';
  if (type === 'scope_audit') return '团队综合审计';
  return '最终报告';
}

function RunArtifactsCard({ artifacts, isDark, onOpen }: { artifacts: AgentArtifact[]; isDark: boolean; onOpen?: () => void }) {
  const novelBlueprint = artifacts.find((artifact) => artifact.type === 'novel_bootstrap_draft');
  const blueprintDraft = novelBlueprint?.metadata?.draft && typeof novelBlueprint.metadata.draft === 'object'
    ? novelBlueprint.metadata.draft as Record<string, unknown>
    : null;
  const firstTitle = Array.isArray(blueprintDraft?.titleCandidates) && typeof blueprintDraft.titleCandidates[0] === 'string'
    ? blueprintDraft.titleCandidates[0]
    : null;
  const targetChapterCount = typeof blueprintDraft?.targetChapterCount === 'number'
    ? `${blueprintDraft.targetChapterCount} 章`
    : null;
  const writingMode = typeof blueprintDraft?.writingModeRecommendation === 'string'
    ? blueprintDraft.writingModeRecommendation
    : null;
  const artifactSummary = novelBlueprint
    ? [firstTitle, targetChapterCount, writingMode].filter(Boolean).join(' · ')
    : artifacts.map((artifact) => artifact.title).join(' · ');
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      title={onOpen ? '在检查器中查看产物' : '历史任务产物'}
      className={clsx(
        'w-full rounded-lg border px-4 py-3 text-left flex items-center gap-3 disabled:cursor-default',
        isDark ? 'border-white/10 bg-black/20 enabled:hover:bg-white/5' : 'border-[var(--ui-border)] bg-white enabled:hover:bg-[var(--ui-surface-subtle)]',
      )}
    >
      <FileText className="h-4 w-4 shrink-0 text-[#2f80ed]" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{novelBlueprint ? '小说项目蓝图已就绪' : '本次产物'}</div>
        <div className={clsx('mt-1 text-xs truncate', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
          {artifactSummary}
        </div>
      </div>
      <span className={clsx('shrink-0 rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
        {artifacts.length}
      </span>
    </button>
  );
}

function preferredArtifact(artifacts: AgentArtifact[], runId: string | null): AgentArtifact | null {
  const inPreferredRun = runId ? artifacts.filter((artifact) => artifact.runId === runId) : artifacts;
  return inPreferredRun.find((artifact) => artifact.type === 'report')
    ?? inPreferredRun[0]
    ?? artifacts.find((artifact) => artifact.type === 'report')
    ?? artifacts[0]
    ?? null;
}

class ArtifactPanelErrorBoundary extends Component<{
  children: ReactNode;
  isDark: boolean;
}, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ArtifactPanel]', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-4">
        <div className={clsx('rounded-lg border p-4 text-sm', this.props.isDark ? 'border-red-400/20 bg-red-500/5 text-red-200' : 'border-red-200 bg-red-50 text-red-800')}>
          <div className="font-medium">产物查看器暂时无法显示这份内容</div>
          <div className="mt-1 text-xs opacity-75">其他会话和任务数据没有受到影响。</div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className={clsx('mt-3 h-8 rounded-md border px-3 text-xs', this.props.isDark ? 'border-white/10 hover:bg-white/5' : 'border-red-200 bg-white hover:bg-red-100')}
          >
            重试显示
          </button>
        </div>
      </div>
    );
  }
}

type SkillDraftReviewRecord = {
  id: string;
  version: number;
  status: 'editing' | 'ready_for_review' | 'committed' | 'discarded';
  action?: 'create' | 'update' | 'derive' | 'pack';
  draft?: Record<string, unknown>;
};

function SkillDraftReviewCard({ artifact, isDark, onPublished }: { artifact: AgentArtifact; isDark: boolean; onPublished: () => Promise<void> }) {
  const embedded = artifact.metadata?.skillDraft as SkillDraftReviewRecord | undefined;
  const draftId = typeof artifact.reference?.skillDraftId === 'string'
    ? artifact.reference.skillDraftId
    : embedded?.id;
  const [draft, setDraft] = useState<SkillDraftReviewRecord | null>(embedded ?? null);
  const [pending, setPending] = useState<'commit' | 'discard' | null>(null);

  useEffect(() => {
    if (!draftId) return;
    let active = true;
    window.agent.skillDraft({ draftId })
      .then((value) => {
        if (active && value) setDraft(value as SkillDraftReviewRecord);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [draftId]);

  if (!draftId) return null;
  const statusLabel = draft?.status === 'committed'
    ? '已发布'
    : draft?.status === 'discarded'
      ? '已放弃'
      : draft?.status === 'editing'
        ? '编辑中'
        : '待审核';
  const reviewable = Boolean(draft && (draft.status === 'ready_for_review' || draft.status === 'editing'));

  const commit = async () => {
    if (!draft || !window.confirm('确认发布这个 Skill Pack？成员 Skill、Pack Revision 与绑定会作为一个事务写入。')) return;
    setPending('commit');
    try {
      const result = await window.agent.commitSkillDraft({
        draftId: draft.id,
        expectedVersion: draft.version,
        confirmed: true,
      }) as { draft?: SkillDraftReviewRecord };
      if (result.draft) setDraft(result.draft);
      await onPublished();
      toast.success(draft.action === 'pack' ? 'Skill Pack 已发布' : 'Skill Revision 已发布');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Skill 草稿发布失败');
    } finally {
      setPending(null);
    }
  };

  const discard = async () => {
    if (!draft || !window.confirm('确定放弃这个 Skill 草稿吗？已提炼内容会保留在任务产物中，但不会进入 Skill 列表。')) return;
    setPending('discard');
    try {
      const result = await window.agent.discardSkillDraft({ draftId: draft.id, expectedVersion: draft.version });
      setDraft(result as SkillDraftReviewRecord);
      toast.success('Skill 草稿已放弃');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Skill 草稿放弃失败');
    } finally {
      setPending(null);
    }
  };

  return (
    <section className={clsx('mt-4 rounded-lg border p-4', isDark ? 'border-blue-400/20 bg-blue-500/5' : 'border-blue-100 bg-blue-50/50')} aria-label="Skill 草稿审核">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Skill Pack 审核</div>
          <p className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>
            检查成员 Skill、来源覆盖、污染警告与 Operation/Role 绑定。确认后原子发布，失败不会留下部分 Skill。
          </p>
        </div>
        <span className={clsx('shrink-0 rounded px-2 py-1 text-[10px]', draft?.status === 'committed' ? 'bg-emerald-500/10 text-emerald-600' : draft?.status === 'discarded' ? 'bg-neutral-500/10 text-neutral-500' : 'bg-amber-500/10 text-amber-700')}>
          {statusLabel}
        </span>
      </div>
      {reviewable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={Boolean(pending)} onClick={commit} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#2f80ed] px-3 text-xs font-medium text-white hover:bg-[#246fce] disabled:opacity-50">
            {pending === 'commit' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            确认发布
          </button>
          <button type="button" disabled={Boolean(pending)} onClick={discard} className={clsx('h-9 rounded-md border px-3 text-xs disabled:opacity-50', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}>
            放弃草稿
          </button>
        </div>
      )}
    </section>
  );
}

function NovelBootstrapInitializeCard({
  artifact,
  isDark,
  onInitialize,
}: {
  artifact: AgentArtifact;
  isDark: boolean;
  onInitialize: (artifact: AgentArtifact) => void;
}) {
  const draft = artifact.metadata?.draft;
  const canInitialize = Boolean(draft && typeof draft === 'object' && !Array.isArray(draft));
  return (
    <section className={clsx('mt-4 border p-4', isDark ? 'border-blue-400/20 bg-blue-500/5' : 'border-blue-100 bg-blue-50/50')} aria-label="小说项目初始化">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[#2f80ed]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">生成项目初始化草稿</div>
          <p className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>
            将已确认蓝图映射为故事线、情节点、角色、物品、技能、世界设定和地图；每项都会先进入审核，不会直接写入项目。
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled={!canInitialize}
        onClick={() => onInitialize(artifact)}
        className={clsx(
          'mt-3 h-9 w-full border px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50',
          isDark ? 'border-blue-400/30 text-blue-200 hover:bg-blue-400/10' : 'border-blue-200 bg-white text-blue-700 hover:bg-blue-50',
        )}
      >
        生成可审核素材
      </button>
    </section>
  );
}

function ArtifactPanel({
  isDark,
  runs,
  preferredRunId,
  onOpenReview,
  onSkillPublished,
  onInitializeNovelProject,
}: {
  isDark: boolean;
  runs: AgentRun[];
  preferredRunId: string | null;
  onOpenReview: (target: 'draft' | 'report', artifact: AgentArtifact) => void;
  onSkillPublished: () => Promise<void>;
  onInitializeNovelProject: (artifact: AgentArtifact) => void;
}) {
  const artifacts = useMemo(() => runs
    .flatMap((run) => run.artifacts ?? [])
    .sort((left, right) => agentDateTimestamp(right.createdAt, 0) - agentDateTimestamp(left.createdAt, 0)), [runs]);
  const artifactSignature = artifacts.map((artifact) => `${artifact.artifactId}:${agentDateTimestamp(artifact.createdAt, 0)}`).join('|');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(() => preferredArtifact(artifacts, preferredRunId)?.artifactId ?? null);
  const previousPreferredRunRef = useRef<string | null>(preferredRunId);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const preferredChanged = previousPreferredRunRef.current !== preferredRunId;
    const selectedExists = artifacts.some((artifact) => artifact.artifactId === selectedArtifactId);
    if (preferredChanged || !selectedExists) {
      setSelectedArtifactId(preferredArtifact(artifacts, preferredRunId)?.artifactId ?? null);
    }
    previousPreferredRunRef.current = preferredRunId;
  }, [artifactSignature, artifacts, preferredRunId, selectedArtifactId]);

  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 520));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!viewerRef.current || !selectedArtifactId) return;
    viewerRef.current.scrollTop = scrollPositionsRef.current.get(selectedArtifactId) ?? 0;
  }, [selectedArtifactId]);

  const selectArtifact = (artifactId: string) => {
    if (viewerRef.current && selectedArtifactId) {
      scrollPositionsRef.current.set(selectedArtifactId, viewerRef.current.scrollTop);
    }
    setSelectedArtifactId(artifactId);
  };

  if (artifacts.length === 0) {
    return (
      <div className="p-4">
        <div className={clsx('rounded-lg border p-3 text-sm leading-6', isDark ? 'border-white/10 bg-black/20 text-neutral-400' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-muted)]')}>
          当前任务还没有结构化产物。任务完成前至少会生成一份最终报告；生成型任务还必须包含对应草稿。
        </div>
      </div>
    );
  }

  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? preferredArtifact(artifacts, preferredRunId);
  const expertReport = selectedArtifact ? getExpertReport(selectedArtifact) : null;
  const isDraftArtifact = selectedArtifact
    ? selectedArtifact.type === 'chapter_draft' || selectedArtifact.type === 'chapter_draft_batch' || selectedArtifact.type === 'creative_assets_draft'
    : false;
  const groupedRuns = runs
    .map((run) => ({
      run,
      artifacts: artifacts.filter((artifact) => artifact.runId === run.runId),
    }))
    .filter((group) => group.artifacts.length > 0)
    .sort((left, right) => {
      if (left.run.runId === preferredRunId) return -1;
      if (right.run.runId === preferredRunId) return 1;
      return agentDateTimestamp(right.artifacts[0]?.createdAt, 0) - agentDateTimestamp(left.artifacts[0]?.createdAt, 0);
    });

  return (
    <div ref={panelRef} className={clsx('grid h-full min-h-0', compact ? 'grid-rows-[auto_minmax(0,1fr)]' : 'grid-cols-[190px_minmax(0,1fr)]')}>
      <nav className={clsx(
        'min-h-0 overflow-auto p-3',
        compact ? 'border-b' : 'border-r',
        isDark ? 'border-white/10 bg-black/10' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]',
      )} aria-label="产物索引">
        <div className={clsx(compact ? 'flex gap-2 overflow-x-auto' : 'space-y-4')}>
          {groupedRuns.map(({ run, artifacts: runArtifacts }) => (
            <div key={run.runId} className={clsx(compact && 'flex shrink-0 items-center gap-2')}>
              <div className={clsx('mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide', compact && 'mb-0 shrink-0', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                {run.runId === preferredRunId ? '当前任务' : run.planSnapshot?.title || '历史任务'}
              </div>
              <div className={clsx(compact ? 'flex gap-1.5' : 'space-y-1')}>
                {runArtifacts.map((artifact) => (
                  <button
                    key={artifact.artifactId}
                    type="button"
                    onClick={() => selectArtifact(artifact.artifactId)}
                    className={clsx(
                      'min-w-0 rounded-md px-2.5 py-2 text-left transition-colors',
                      compact ? 'w-44 shrink-0' : 'w-full',
                      artifact.artifactId === selectedArtifact?.artifactId
                        ? isDark ? 'bg-white/10 text-white' : 'bg-white text-[var(--ui-text-primary)] shadow-sm'
                        : isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-secondary)] hover:bg-white/70',
                    )}
                    aria-current={artifact.artifactId === selectedArtifact?.artifactId ? 'true' : undefined}
                  >
                    <div className="flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-[#2f80ed]" />
                      <span className="truncate text-xs font-medium">{artifact.title}</span>
                    </div>
                    <div className={clsx('mt-1 truncate pl-5 text-[10px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                      {artifact.type === 'report' ? '最终交付' : artifactTypeLabel(artifact.type)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div
        ref={viewerRef}
        className={clsx('min-h-0 overflow-y-auto p-5', isDark ? 'bg-[#0f0f13]' : 'bg-white')}
        aria-label="产物阅读区"
      >
        {selectedArtifact && (
          <article className="mx-auto w-full max-w-3xl pb-10">
            <header className={clsx('border-b pb-4', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className={clsx('rounded px-1.5 py-0.5', selectedArtifact.type === 'report' ? 'bg-blue-500/10 text-[#2f80ed]' : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
                  {selectedArtifact.type === 'report' ? '最终交付' : '分析依据'}
                </span>
                <span className={isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]'}>{artifactTypeLabel(selectedArtifact.type)} · {selectedArtifact.status}</span>
              </div>
              <h2 className="mt-2 text-lg font-semibold leading-7">{selectedArtifact.title}</h2>
            </header>

            {selectedArtifact.type === 'report' ? (
              <div className="mt-5">
                <AssistantMarkdown
                  key={selectedArtifact.artifactId}
                  content={selectedArtifact.content || selectedArtifact.summary || '该报告没有正文。'}
                  isDark={isDark}
                  variant="document"
                  ariaLabel="报告正文"
                />
              </div>
            ) : (
              <>
                {selectedArtifact.summary && (
                  <p className={clsx('mt-4 whitespace-pre-wrap text-sm leading-7', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>
                    {selectedArtifact.summary}
                  </p>
                )}
                {selectedArtifact.type === 'agent_skill_pack_draft' && (
                  <SkillDraftReviewCard artifact={selectedArtifact} isDark={isDark} onPublished={onSkillPublished} />
                )}
                {selectedArtifact.type === 'novel_bootstrap_draft' && (
                  <NovelBootstrapInitializeCard
                    artifact={selectedArtifact}
                    isDark={isDark}
                    onInitialize={onInitializeNovelProject}
                  />
                )}
                {expertReport && (
                  <div className={clsx('mt-4 rounded-lg border p-4', isDark ? 'border-white/10 bg-white/5' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span>{expertReport.findings.length} 个结构化问题</span>
                      <span className={clsx('rounded px-1.5 py-0.5 text-[10px]', selectedArtifact.reviewStatus === 'reviewed' ? 'bg-emerald-50 text-emerald-700' : selectedArtifact.reviewStatus === 'stale' ? 'bg-red-50 text-red-700' : isDark ? 'bg-white/10 text-neutral-400' : 'bg-white text-[var(--ui-text-muted)]')}>
                        {selectedArtifact.reviewStatus === 'reviewed' ? '已审核' : selectedArtifact.reviewStatus === 'stale' ? '已过期' : selectedArtifact.reviewStatus === 'in_review' ? '审核中' : '待审核'}
                      </span>
                    </div>
                    {expertReport.coverage && (
                      <div className={clsx('mt-2 text-[11px] leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                        覆盖 {expertReport.coverage.contextChapterCount}/{expertReport.coverage.totalChapterCount} 章
                        {expertReport.coverage.omittedChapterCount > 0 ? ` · 省略 ${expertReport.coverage.omittedChapterCount} 章` : ''}
                      </div>
                    )}
                    <button type="button" onClick={() => onOpenReview('report', selectedArtifact)} className={clsx('mt-3 h-9 w-full rounded-md border px-3 text-xs', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}>
                      审核报告
                    </button>
                  </div>
                )}

                {expertReport && expertReport.findings.length > 0 && (
                  <details className={clsx('mt-4 rounded-lg border', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                    <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
                      分析明细（{expertReport.findings.length}）
                    </summary>
                    <div className={clsx('divide-y border-t px-4', isDark ? 'divide-white/10 border-white/10' : 'divide-[var(--ui-border)] border-[var(--ui-border)]')}>
                      {expertReport.findings.map((finding) => (
                        <div key={finding.findingId} className="py-3">
                          <div className="flex items-start gap-2">
                            <span className={clsx('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase', finding.severity === 'critical' || finding.severity === 'high' ? 'bg-red-500/10 text-red-600' : finding.severity === 'medium' ? 'bg-amber-500/10 text-amber-700' : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
                              {finding.severity}
                            </span>
                            <div className="min-w-0 text-sm font-medium leading-5">{finding.title}</div>
                          </div>
                          <div className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>{finding.summary}</div>
                          {finding.recommendation && <div className={clsx('mt-1 text-xs leading-5', isDark ? 'text-blue-300/80' : 'text-[#285b91]')}>建议：{finding.recommendation}</div>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {selectedArtifact.content && selectedArtifact.content !== selectedArtifact.summary && (
                  <details className={clsx('mt-4 rounded-lg border', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                    <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">查看原始分析</summary>
                    <div className={clsx('border-t p-4', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                      <AssistantMarkdown
                        content={selectedArtifact.content}
                        isDark={isDark}
                        variant="document"
                        ariaLabel="原始分析"
                      />
                    </div>
                  </details>
                )}
              </>
            )}

            {isDraftArtifact && (typeof selectedArtifact.reference?.draftSessionId === 'string' || typeof selectedArtifact.reference?.draftBatchId === 'string') && (
              <button type="button" onClick={() => onOpenReview('draft', selectedArtifact)} className={clsx('mt-4 h-9 rounded-md border px-3 text-xs', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border-strong)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}>
                {selectedArtifact.type === 'chapter_draft_batch' ? '打开批次审核' : selectedArtifact.type === 'creative_assets_draft' ? '打开素材审核' : '打开草稿审核'}
              </button>
            )}
          </article>
        )}
      </div>
    </div>
  );
}

function RoleSkillPanel({
  isDark,
  activeRole,
  roleOptions,
  onUsePreset,
}: {
  isDark: boolean;
  activeRole: AgentRoleMode;
  roleOptions: RoleOption[];
  onUsePreset: (role: AgentRoleMode, preset: AgentPresetTask) => void;
}) {
  const currentRole = roleOptions.find((role) => role.id === activeRole) ?? roleOptions[0] ?? ROLE_OPTIONS[0];
  return (
    <div className="space-y-3">
      <div className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <UserRound className="h-4 w-4 text-[#2f80ed]" />
          {currentRole.label}模式
        </div>
        <p className={clsx('mt-2 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{currentRole.desc}</p>
      </div>
      {currentRole.presets.length > 0 && (
        <div className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Sparkles className="h-3.5 w-3.5 text-[#2f80ed]" />
            预置任务
          </div>
          <div className="mt-3 space-y-2">
            {currentRole.presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onUsePreset(currentRole.id, preset)}
                className={clsx(
                  'w-full rounded-md border px-3 py-2 text-left transition-colors',
                  isDark ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] hover:bg-[var(--ui-surface-muted)]',
                )}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Play className="h-3.5 w-3.5 shrink-0 text-[#2f80ed]" />
                  <span>{preset.label}</span>
                </div>
                {preset.description && (
                  <p className={clsx('mt-1 pl-5.5 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                    {preset.description}
                  </p>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
        <div className="text-xs font-semibold">能力标签</div>
        <div className="mt-3 space-y-2">
          {currentRole.skills.map((skill) => (
            <div key={skill} className={clsx('rounded-md px-2 py-2 text-sm', isDark ? 'bg-white/5 text-neutral-300' : 'bg-[var(--ui-surface-subtle)] text-[var(--ui-text-primary)]')}>
              {skill}
            </div>
          ))}
        </div>
      </div>
      <div className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
        <div className="text-xs font-semibold">工具范围</div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {currentRole.tools.map((tool) => (
            <span key={tool} className={clsx('rounded px-1.5 py-0.5 text-[11px] font-mono', isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
              {tool}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function RoleMatrix({ isDark, roleOptions }: { isDark: boolean; roleOptions: RoleOption[] }) {
  return (
    <div className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Users className="h-4 w-4 text-[#2f80ed]" />
        创作专家团
      </div>
      <div className="mt-3 space-y-2">
        {roleOptions.filter((role) => role.id !== 'team').map((role) => (
          <div key={role.id} className="grid grid-cols-[56px_1fr] gap-2 text-xs">
            <span className={isDark ? 'text-neutral-300' : 'text-[var(--ui-text-primary)]'}>{role.label}</span>
            <span className={isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]'}>{role.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewPanel({
  isDark,
  activeRun,
  novelId,
  sourceConversationId,
  volumes,
  onArtifactStatusChange,
  onDiscuss,
  onRegenerate,
}: {
  isDark: boolean;
  activeRun: AgentRun | null;
  novelId: string;
  sourceConversationId: string;
  volumes: Volume[];
  onArtifactStatusChange: (draftSessionId: string, status: AgentArtifact['status']) => void;
  onDiscuss: (comments: ReviewCommentRecord[]) => Promise<void>;
  onRegenerate: (session: DraftSessionRecord, comments: ReviewCommentRecord[]) => Promise<void>;
}) {
  const draftSessionId = activeRun?.draftSessionId;
  const [session, setSession] = useState<DraftSessionRecord | null>(null);
  const [generatedText, setGeneratedText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [reviewMode, setReviewMode] = useState<'diff' | 'original' | 'draft'>('diff');
  const [showContextDetails, setShowContextDetails] = useState(false);
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!draftSessionId) {
      setSession(null);
      setGeneratedText('');
      setError('');
      return () => { cancelled = true; };
    }
    setIsLoading(true);
    setError('');
    void window.automation.invoke('draft.get', { draftSessionId }, 'desktop-ui')
      .then((result) => {
        if (cancelled) return;
        const next = result as DraftSessionRecord | null;
        setSession(next);
        const payload = next?.type === 'chapter-draft' ? next.payload as ChapterDraftPayload : null;
        setGeneratedText(payload?.generatedText ?? '');
        if (!next) setError('草稿不存在或已经被清理。');
      })
      .catch((err) => {
        if (!cancelled) setError(toErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [draftSessionId]);

  const chapterPayload = session?.type === 'chapter-draft' ? session.payload as ChapterDraftPayload : null;
  const sourceArtifactId = activeRun?.artifacts?.find((artifact) => artifact.reference?.draftSessionId === draftSessionId)?.artifactId;
  const reviewCommentContext = session && activeRun && sourceConversationId ? {
    novelId,
    sourceConversationId,
    sourceRunId: activeRun.runId,
    sourceArtifactId,
    reviewVersionId: session.draftSessionId,
    draftSessionId: session.draftSessionId,
  } : null;
  const reviewComments = useReviewComments(reviewCommentContext);
  const normalizedContent = useMemo(
    () => chapterPayload ? appendPlainTextToLexical(chapterPayload.baseContent, generatedText) : '',
    [chapterPayload, generatedText],
  );
  const isDirty = Boolean(chapterPayload && (
    generatedText !== chapterPayload.generatedText
    || normalizedContent !== chapterPayload.content
  ));
  const originalText = useMemo(
    () => extractReadableText(chapterPayload?.baseContent ?? ''),
    [chapterPayload?.baseContent],
  );
  const originalLength = Array.from(originalText).length;
  const draftLength = Array.from(generatedText).length;
  const contextSources = chapterPayload?.contextSnapshot?.chapterSources ?? [];
  const previousContextSources = contextSources.filter((source) => source.chapterId !== chapterPayload?.chapterId);
  const fullContextCount = previousContextSources.filter((source) => source.contentMode === 'full' || source.contentMode === 'truncated').length;
  const summaryContextCount = previousContextSources.filter((source) => source.contentMode === 'summary').length;
  const hasEditorBuffer = contextSources.some((source) => source.source === 'editor_buffer');
  const displayChapterLabel = useMemo(() => {
    const targetChapterId = chapterPayload?.chapterId || session?.chapterId || '';
    const snapshotSource = contextSources.find((source) => source.chapterId === targetChapterId);
    const catalogMatch = volumes.flatMap((volume) => (
      volume.chapters.map((chapter) => ({ volume, chapter }))
    )).find(({ chapter }) => chapter.id === targetChapterId);
    const volumeOrder = Number(snapshotSource?.volumeOrder ?? catalogMatch?.volume.order ?? 0);
    const chapterOrder = Number(snapshotSource?.order ?? catalogMatch?.chapter.order ?? 0);
    const title = String(snapshotSource?.title || catalogMatch?.chapter.title || '').trim();
    const parts = [
      volumeOrder > 0 ? `第${volumeOrder}卷` : '',
      chapterOrder > 0 ? `第${chapterOrder}章` : '',
      title,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : '目标章节';
  }, [chapterPayload?.chapterId, contextSources, session?.chapterId, volumes]);

  const saveChanges = async (): Promise<DraftSessionRecord> => {
    if (!session || !chapterPayload) throw new Error('当前草稿不可编辑');
    if (!isDirty) return session;
    const updated = await window.automation.invoke('draft.update', {
      draftSessionId: session.draftSessionId,
      version: session.version,
      payload: {
        ...chapterPayload,
        generatedText,
        content: normalizedContent,
      },
    }, 'desktop-ui') as DraftSessionRecord;
    setSession(updated);
    return updated;
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError('');
    try {
      await saveChanges();
      toast.success('草稿修改已保存');
    } catch (err) {
      const message = toErrorMessage(err);
      setError(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCommit = async () => {
    if (!session) return;
    if (reviewComments.unresolvedComments.length > 0) {
      setError('请先处理仍未解决的审批意见，再确认写回。');
      return;
    }
    setIsSaving(true);
    setError('');
    try {
      const current = await saveChanges();
      const response = await window.automation.invoke('draft.commit', {
        draftSessionId: current.draftSessionId,
        version: current.version,
      }, 'desktop-ui') as { session: DraftSessionRecord };
      setSession(response.session);
      onArtifactStatusChange(current.draftSessionId, 'committed');
      toast.success('草稿已写回正文');
    } catch (err) {
      const message = toErrorMessage(err);
      setError(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscard = async () => {
    if (!session) return;
    setIsSaving(true);
    setError('');
    try {
      const discarded = await window.automation.invoke('draft.discard', {
        draftSessionId: session.draftSessionId,
        version: session.version,
      }, 'desktop-ui') as DraftSessionRecord;
      setSession(discarded);
      onArtifactStatusChange(session.draftSessionId, 'discarded');
      toast.success('草稿已丢弃');
    } catch (err) {
      const message = toErrorMessage(err);
      setError(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const latestWriteback = useMemo(
    () => [...(session?.writebacks ?? [])].reverse().find((item) => item.status === 'committed') ?? null,
    [session?.writebacks],
  );

  const handleUndo = async () => {
    if (!session || !latestWriteback) return;
    setIsSaving(true);
    setError('');
    try {
      const response = await window.automation.invoke('draft.undo', {
        draftSessionId: session.draftSessionId,
        version: session.version,
        writebackId: latestWriteback.writebackId,
      }, 'desktop-ui') as { session: DraftSessionRecord };
      setSession(response.session);
      onArtifactStatusChange(session.draftSessionId, 'ready');
      toast.success('已撤销本次写回，草稿可继续调整');
    } catch (err) {
      const message = toErrorMessage(err);
      setError(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscussComments = async () => {
    if (!reviewComments.pendingComments.length) return;
    setIsSaving(true);
    setError('');
    try {
      await onDiscuss(reviewComments.pendingComments);
      await reviewComments.markSent('discuss');
      setSubmitDialogOpen(false);
      toast.success('审批意见已发送到来源会话');
    } catch (nextError) {
      const message = toErrorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRegenerateFromComments = async () => {
    if (!session || !reviewComments.unresolvedComments.length || isDirty) return;
    setIsSaving(true);
    setError('');
    try {
      await onRegenerate(session, reviewComments.unresolvedComments);
      await reviewComments.markSent('regenerate');
      setSubmitDialogOpen(false);
      toast.success('已开始生成新的待审核版本');
    } catch (nextError) {
      const message = toErrorMessage(nextError);
      setError(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const hasDraft = Boolean(draftSessionId);
  const isDraft = session?.status === 'draft';
  const statusLabel = session?.status === 'committed' ? '已写回'
    : session?.status === 'discarded' ? '已丢弃'
      : session?.status === 'failed' ? '失败'
        : session?.status === 'stale' ? '历史版本'
        : '待审核';

  const originalPane = (
    <section className={clsx('flex min-h-0 flex-1 flex-col', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
      <div className={clsx('flex h-11 shrink-0 items-center justify-between border-b px-5', isDark ? 'border-white/10 bg-white/[0.02]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
        <span className="text-sm font-semibold">当前原文</span>
        <span className={clsx('text-xs tabular-nums', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{originalLength} 字</span>
      </div>
      <div className={clsx('min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-6 py-5 font-serif text-[15px] leading-8', isDark ? 'bg-[#111116] text-neutral-300' : 'bg-[var(--ui-canvas)] text-[var(--ui-text-secondary)]')}>
        {originalText || '原文为空'}
      </div>
    </section>
  );

  const draftPane = (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className={clsx('flex h-11 shrink-0 items-center justify-between border-b px-5', isDark ? 'border-white/10 bg-white/[0.02]' : 'border-[var(--ui-border)] bg-white')}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Agent 草稿</span>
          {isDirty && <span className="rounded bg-[#fff4d8] px-1.5 py-0.5 text-[11px] text-[#8a5a00]">已修改</span>}
        </div>
        <span className={clsx('text-xs tabular-nums', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{draftLength} 字</span>
      </div>
      <textarea
        id="agent-draft-text"
        aria-label="Agent 草稿"
        value={generatedText}
        onChange={(event) => setGeneratedText(event.target.value)}
        disabled={!isDraft || isSaving}
        className={clsx(
          'min-h-0 flex-1 resize-none border-0 px-6 py-5 font-serif text-[15px] leading-8 outline-none',
          isDark ? 'bg-[#0f0f13] text-neutral-200 disabled:text-neutral-500' : 'bg-white text-[var(--ui-text-primary)] disabled:text-[var(--ui-text-muted)]',
        )}
      />
    </section>
  );
  const reviewStats = [
    { key: 'original', label: '原文', value: `${originalLength} 字` },
    { key: 'draft', label: '草稿', value: `${draftLength} 字` },
    { key: 'delta', label: '新增', value: `${Math.max(0, draftLength - originalLength)} 字` },
  ];

  if (isLoading || !hasDraft || (!session && !error)) {
    return (
      <div className="grid h-full place-items-center px-8 text-center">
        <div>
          {isLoading ? <Loader2 className="mx-auto h-5 w-5 animate-spin text-[#2f80ed]" /> : <FileText className={clsx('mx-auto h-6 w-6', isDark ? 'text-neutral-600' : 'text-[var(--ui-text-disabled)]')} />}
          <p className={clsx('mt-3 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>
            {isLoading ? '正在读取草稿...' : '当前会话还没有可审核的草稿。'}
          </p>
        </div>
      </div>
    );
  }

  if (session && session.type !== 'chapter-draft') {
    if (session.type === 'creative-assets') {
      return (
        <CreativeAssetsReviewPanel
          isDark={isDark}
          session={session}
          reviewComments={reviewComments}
          onSessionChange={setSession}
          onArtifactStatusChange={onArtifactStatusChange}
          onDiscuss={onDiscuss}
          onRegenerate={onRegenerate}
        />
      );
    }
    return (
      <div className="grid h-full place-items-center px-8 text-center">
        <div>
          <FileText className="mx-auto h-6 w-6 text-[#2f80ed]" />
          <p className="mt-3 text-sm font-medium">{session.previewSummary}</p>
          <p className={clsx('mt-1 text-sm leading-6', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>当前产物类型为 {session.type}，请在对应工作台审核。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={clsx('shrink-0 border-b px-5 py-4', isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold">{displayChapterLabel}</h2>
              <span className={clsx('shrink-0 rounded px-2 py-0.5 text-[11px]', isDraft ? 'bg-[#e8f2ff] text-[#2f80ed]' : (isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]'))}>{statusLabel}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {reviewStats.map((stat) => (
                <span
                  key={stat.key}
                  className={clsx(
                    'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 whitespace-nowrap',
                    isDark ? 'border-white/10 bg-white/[0.03] text-neutral-400' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-muted)]',
                  )}
                >
                  <span className="font-medium text-current">{stat.label}</span>
                  <span className="tabular-nums">{stat.value}</span>
                </span>
              ))}
              {chapterPayload?.usedContext?.length ? (
                <span
                  className={clsx(
                    'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 whitespace-nowrap',
                    isDark ? 'border-white/10 bg-white/[0.03] text-neutral-400' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-muted)]',
                  )}
                >
                  <span className="font-medium text-current">参考</span>
                  <span className="tabular-nums">{chapterPayload.usedContext.length} 项上下文</span>
                </span>
              ) : null}
              {chapterPayload?.contextPolicy && (
                <button
                  type="button"
                  onClick={() => setShowContextDetails((value) => !value)}
                  className={clsx(
                    'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 whitespace-nowrap hover:bg-black/5',
                    isDark ? 'border-white/10 text-neutral-400 hover:bg-white/[0.04]' : 'border-[var(--ui-border)] text-[var(--ui-text-muted)]',
                  )}
                >
                  前文 {previousContextSources.length} 章 · 正文 {fullContextCount} · 摘要 {summaryContextCount}
                  <ChevronDown className={clsx('h-3 w-3 transition-transform', showContextDetails && 'rotate-180')} />
                </button>
              )}
            </div>
          </div>
          <div className={clsx('flex w-full shrink-0 overflow-x-auto rounded-md border p-1 xl:w-auto', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
            {([
              { id: 'diff', label: '高亮差异', icon: FileDiff },
              { id: 'original', label: '完整原文', icon: FileText },
              { id: 'draft', label: '完整草稿', icon: Save },
            ] as const).map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setReviewMode(option.id)}
                  className={clsx('inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs', reviewMode === option.id ? (isDark ? 'bg-white/10 text-white' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-primary)]') : (isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]'))}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        {showContextDetails && chapterPayload?.contextPolicy && (
          <div className={clsx('mt-3 border-t pt-3 text-xs', isDark ? 'border-white/10 text-neutral-400' : 'border-[var(--ui-border-strong)] text-[var(--ui-text-muted)]')}>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>策略 {chapterPayload.contextPolicy.version}</span>
              <span>摘要窗口 {chapterPayload.contextPolicy.summaryChapterCount} 章</span>
              <span>全文窗口 {chapterPayload.contextPolicy.fullTextChapterCount} 章</span>
              <span>{hasEditorBuffer ? '已包含未保存编辑内容' : '使用已保存正文'}</span>
            </div>
            <div className="mt-2 max-h-28 overflow-y-auto border-l pl-3">
              {contextSources.map((source) => (
                <div key={source.chapterId} className="flex min-w-0 items-center justify-between gap-3 py-1">
                  <span className="truncate">{source.title || source.chapterId}</span>
                  <span className="shrink-0 tabular-nums">
                    {source.chapterId === chapterPayload.chapterId ? '当前章' : source.contentMode === 'summary' ? '摘要' : source.contentMode === 'excerpt' ? '摘录' : source.contentMode === 'truncated' ? '正文（裁剪）' : '正文'} · v{source.version}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {chapterPayload && !chapterPayload.consistency.ok && (
          <div className={clsx('mt-3 flex gap-2 rounded-md px-3 py-2 text-xs leading-5', isDark ? 'bg-amber-500/10 text-amber-200' : 'bg-[#fff6df] text-[#76520b]')}>
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{chapterPayload.consistency.issues.join('；')}</span>
          </div>
        )}
        {(error || reviewComments.error) && (
          <div className={clsx('mt-3 rounded-md px-3 py-2 text-xs', isDark ? 'bg-red-500/10 text-red-200' : 'bg-red-50 text-red-700')}>{error || reviewComments.error}</div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {reviewMode === 'diff' && session && (
          <DraftDiffView
            originalText={originalText}
            draftText={generatedText}
            isDark={isDark}
            reviewVersionId={session.draftSessionId}
            comments={reviewComments.comments}
            disabled={!isDraft}
            isMutating={reviewComments.isMutating}
            onSave={reviewComments.save}
            onDelete={reviewComments.remove}
          />
        )}
        {reviewMode === 'original' && originalPane}
        {reviewMode === 'draft' && draftPane}
      </div>

      <div className={clsx('flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3', isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
        <div className={clsx('min-w-[220px] flex-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
          {reviewComments.unresolvedComments.length > 0
            ? reviewComments.pendingComments.length > 0
              ? `有 ${reviewComments.pendingComments.length} 条审批意见待发送，处理前不能写回正文`
              : `有 ${reviewComments.unresolvedComments.length} 条意见已发到会话，需重新生成或调整后才能写回`
            : latestWriteback
            ? '写回后可撤销本次操作；若正文已再次修改，撤销会被拒绝。'
            : isDraft ? (isDirty ? '修改尚未保存' : '草稿已保存，可确认写回正文') : `该草稿${statusLabel}`}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <DraftMoreMenu isDark={isDark} disabled={!isDraft || isSaving} discardLabel="丢弃草稿" onDiscard={() => void handleDiscard()} />
          {latestWriteback && <button type="button" disabled={isSaving} onClick={() => void handleUndo()} className={clsx('inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-white/10 text-neutral-200' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}><RotateCcw className="h-4 w-4" />撤销本次写回</button>}
          {isDraft && reviewMode !== 'draft' && <button type="button" disabled={isSaving} onClick={() => setReviewMode('draft')} className={clsx('h-9 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-white/10 text-neutral-300' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}>继续调整</button>}
          <button type="button" disabled={!isDraft || !isDirty || isSaving} onClick={() => void handleSave()} className={clsx('inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-white/10 text-neutral-300' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)]')}><Save className="h-4 w-4" />保存调整</button>
          {reviewComments.unresolvedComments.length > 0 && (
            <button type="button" disabled={isSaving || reviewComments.isMutating} onClick={() => setSubmitDialogOpen(true)} className={clsx('inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-45', isDark ? 'border-sky-400/30 text-sky-200' : 'border-[#9dbbd8] bg-white text-[#355b7d]')}><Send className="h-4 w-4" />{reviewComments.pendingComments.length > 0 ? '发送意见' : '处理意见'} ({reviewComments.unresolvedComments.length})</button>
          )}
          <button type="button" disabled={!isDraft || isSaving || reviewComments.unresolvedComments.length > 0} onClick={() => void handleCommit()} className={clsx('h-9 rounded-md px-4 text-sm text-white disabled:opacity-45', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}>{isSaving ? '处理中...' : '确认写回'}</button>
        </div>
      </div>
      <ReviewSubmitDialog
        open={submitDialogOpen}
        comments={reviewComments.unresolvedComments}
        isDark={isDark}
        isSubmitting={isSaving || reviewComments.isMutating}
        regenerateDisabled={isDirty}
        regenerateDisabledReason={isDirty ? '当前草稿有尚未保存的手动修改。请先保存调整，再让 Agent 根据审批意见重新生成。' : undefined}
        discussDisabled={reviewComments.pendingComments.length === 0}
        onClose={() => setSubmitDialogOpen(false)}
        onDiscuss={() => void handleDiscussComments()}
        onRegenerate={() => void handleRegenerateFromComments()}
      />
    </div>
  );
}

function EvidencePanel({ isDark, activeRun }: { isDark: boolean; activeRun: AgentRun | null }) {
  const evidenceEvents = activeRun?.events.filter((event) => event.toolName === 'rag.ask' || event.toolName === 'search.query') ?? [];
  return (
    <div className="space-y-2">
      {evidenceEvents.length === 0 && (
        <div className={clsx('rounded-lg border p-3 text-sm leading-6', isDark ? 'border-white/10 bg-black/20 text-neutral-400' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-muted)]')}>
          暂无检索证据。执行计划调用 RAG 或搜索后，会在这里列出来源摘要。
        </div>
      )}
      {evidenceEvents.map((event) => (
        <div key={event.eventId} className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
          <div className="text-xs font-mono">{event.toolName}</div>
          <div className={clsx('mt-2 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{eventSummary(event)}</div>
        </div>
      ))}
    </div>
  );
}
