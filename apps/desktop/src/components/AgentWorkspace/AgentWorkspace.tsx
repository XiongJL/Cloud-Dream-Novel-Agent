import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  Bot,
  ChevronDown,
  CheckCircle2,
  ClipboardList,
  FileDiff,
  FileText,
  ListChecks,
  Loader2,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
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
} from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import type { Chapter, Novel, Volume } from '../../types';
import { shouldApplyRunSequence, shouldResubscribeRun } from '../../../shared/agentSseProtocol';
import {
  applyAgentRunEvent,
  getActiveRunApproval,
  getRunRecoverySnapshot,
} from '../../../shared/agentRunProjection';
import {
  buildAgentConversationTimeline,
  mergeAgentRunHistory,
} from '../../../shared/agentConversationTimeline';
import { buildAgentPlanGoal } from '../../../shared/agentPlanGoal';
import {
  projectAgentActivity,
  type ActivityDetail,
} from '../../../shared/agentActivityProjection';
import { appendPlainTextToLexical, extractReadableText } from '../../../shared/lexicalDocument';
import {
  chapterScopePayload,
  createDefaultChapterScope,
  isChapterScopeSelectionValid,
  normalizeChapterScopeSelection,
  type AgentChapterScopeSelection,
} from '../../../shared/agentChapterScopeSelection';
import { ChapterScopeSelector } from './ChapterScopeSelector';
import { ConsolidatedReportCard } from './ConsolidatedReportCard';
import { DraftBatchReviewPanel } from './DraftBatchReviewPanel';
import { DraftDiffView } from './DraftDiffView';
import { DraftMoreMenu } from './DraftMoreMenu';
import { ReviewableParagraphs, useReviewComments } from './DraftReviewComments';
import { ReviewSubmitDialog } from './ReviewSubmitDialog';
import { CreativeAssetsReviewPanel } from './CreativeAssetsReviewPanel';
import { ExpertReportPanel } from './ExpertReportPanel';
import { RevisionTaskWorkspace } from './RevisionTaskWorkspace';
import type {
  AgentRevisionTask,
  ArtifactReviewSubmitResult,
  RevisionTaskSyncRunInput,
} from '../../../shared/expertReport';
import { getExpertReport } from '../../../shared/agentExpertReportProjection';
import type { DraftBatchRecord } from '../../../shared/draftBatch';
import type { ReviewCommentRecord } from '../../../shared/reviewComments';
import { formatReviewCommentsForConversation } from '../../../shared/reviewComments';
import {
  pendingAgentStatusLabel,
  type AgentPendingPhase,
  type AgentPendingStatus,
} from '../../../shared/agentPendingStatus';

type Props = {
  novel: Novel | null;
  novelId: string;
  currentChapter: Chapter | null;
  currentContent: string;
  locale: string;
  theme: 'dark' | 'light';
  initialGoal?: string;
  onInitialGoalConsumed: () => void;
};

type AgentRoleMode = 'team' | 'writer' | 'editor' | 'reader' | 'worldbuilding' | 'research_rag';
type InspectorTab = 'context' | 'artifacts' | 'review' | 'evidence' | 'roles';
type ApprovalMode = 'review_required' | 'chat_only' | 'full_control';
type WorkspaceView = 'conversation' | 'revision_tasks';
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
  contextReads?: Array<{ toolName: string; status: 'completed' | 'failed'; message?: string }>;
  contextDiagnostics?: AgentContextDiagnostics;
};

const CONTEXT_COMPRESSION_MESSAGE_KIND = 'agent_context_compression_v1';

function inspectorVisibilityStorageKey(novelId: string): string {
  return `novel_editor_agent_inspector_open:${novelId}`;
}

function readInspectorVisibility(novelId: string): boolean {
  try {
    return localStorage.getItem(inspectorVisibilityStorageKey(novelId)) === 'true';
  } catch {
    return false;
  }
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
  if (diagnostics.contextVersion !== 'agent-context-v1'
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
  messages: ConversationMessage[];
  suggestedGoal: string | null;
  plan: AgentPlan | null;
  run: AgentRun | null;
  runs?: AgentRun[];
  contextSummary?: AgentConversationSummary | null;
  error: string;
};

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
  { id: 'review_required', label: '需要用户审核', desc: '可自动读取项目上下文；生成草稿或写回前需要人工确认计划。' },
  { id: 'chat_only', label: '只讨论不执行', desc: '保留交流和建议，不生成计划或调用工具。' },
  { id: 'full_control', label: '完全控制', desc: '预留模式，当前阶段不开放。', disabled: true },
];

function createSeedConversations(novelId: string, currentChapter?: Chapter | null): AgentConversation[] {
  const chapterTitle = currentChapter?.title || '当前章';
  const seedId = (kind: 'conv' | 'msg', name: string) => `${novelId}:${kind}:${name}`;
  return [
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
          content: '你可以直接讨论创作问题。当前工作模式为“需要用户审核”：我可以先读取项目上下文；生成草稿或写回前会提供可修改计划供你确认。',
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
        content: '读者模式适合模拟普通读者的理解成本、情绪反馈和追读动力。',
        createdAt: new Date().toISOString(),
      },
    ],
  },
  ];
}

function toErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  const timeout = message.match(/HTTP request timeout after (\d+)ms/i);
  if (timeout) {
    return `模型响应超时（${Math.round(Number(timeout[1]) / 1000)} 秒）。本次消息未生成回复，请重试。`;
  }
  return message;
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

export default function AgentWorkspace({
  novel,
  novelId,
  currentChapter,
  currentContent,
  locale,
  theme,
  initialGoal,
  onInitialGoalConsumed,
}: Props) {
  const isDark = theme === 'dark';
  const initialConversations = useMemo(
    () => createSeedConversations(novelId, currentChapter),
    [currentChapter, novelId],
  );
  const [input, setInput] = useState('');
  const [conversationSearch, setConversationSearch] = useState('');
  const [selectedRole, setSelectedRole] = useState<AgentRoleMode>('team');
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>(ROLE_OPTIONS);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('review_required');
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
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('conversation');
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(() => readInspectorVisibility(novelId));
  const [inspectorOpen, setInspectorOpen] = useState(() => readInspectorVisibility(novelId));
  const [activeConversationId, setActiveConversationId] = useState(initialConversations[0]?.id ?? 'conv-current-chapter-review');
  const [conversations, setConversations] = useState<AgentConversation[]>(initialConversations);
  const [isConversationsLoading, setIsConversationsLoading] = useState(true);
  const [health, setHealth] = useState<AgentHealthResult | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [isRuntimeRecoveryPending, setIsRuntimeRecoveryPending] = useState(false);
  const [pendingRevisionBatch, setPendingRevisionBatch] = useState<{ conversationId: string; plan: RevisionBatchPlan } | null>(null);
  const [revisionTaskCount, setRevisionTaskCount] = useState(0);
  const [revisionTaskRefreshKey, setRevisionTaskRefreshKey] = useState(0);
  const [pendingAgentStatus, setPendingAgentStatus] = useState<AgentPendingStatus | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const runtimeRecoveryRequestRef = useRef<Promise<AgentHealthResult> | null>(null);
  const sendInFlightRef = useRef(false);
  const subscribedRunIdRef = useRef<string | null>(null);
  const lastSequenceRef = useRef(0);
  const consumedInitialGoalRef = useRef<string | null>(null);
  const conversationsLoadedRef = useRef(false);
  const loadedConversationNovelIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<AgentConversation[]>(initialConversations);
  const revisionSyncInFlightRef = useRef(new Set<string>());
  const revisionSyncCompletedRef = useRef(new Set<string>());
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const followsLatestRef = useRef(true);
  const [followsLatest, setFollowsLatest] = useState(true);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    const open = readInspectorVisibility(novelId);
    setInspectorOpen(open);
    setInspectorDrawerOpen(open);
  }, [novelId]);

  const setInspectorVisibility = useCallback((open: boolean) => {
    setInspectorOpen(open);
    setInspectorDrawerOpen(open);
    try {
      localStorage.setItem(inspectorVisibilityStorageKey(novelId), String(open));
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }, [novelId]);

  const openInspector = useCallback((tab: InspectorTab, target?: 'draft' | 'report', runId?: string) => {
    if (target) setReviewTarget(target);
    if (tab === 'review' || tab === 'artifacts') setSelectedReviewRunId(runId ?? null);
    setInspectorTab(tab);
    setConversationDrawerOpen(false);
    setInspectorVisibility(true);
  }, [setInspectorVisibility]);

  useEffect(() => {
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
    setChapterScope((current) => ({
      ...current,
      volumeId: currentChapter?.volumeId,
      chapterIds: currentChapter?.id ? [currentChapter.id] : [],
      anchorChapterId: currentChapter?.id,
    }));
  }, [chapterScope.kind, currentChapter?.id, currentChapter?.volumeId]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0],
    [activeConversationId, conversations],
  );

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
  const conversationRuns = useMemo(() => (
    activeRun
      ? mergeAgentRunHistory(activeConversation?.runs, activeRun)
      : activeConversation?.runs ?? []
  ), [activeConversation?.runs, activeRun]);
  const selectedReviewRun = selectedReviewRunId
    ? conversationRuns.find((run) => run.runId === selectedReviewRunId) ?? activeRun
    : activeRun;
  const activeApproval = getActiveApproval(activeRun);
  const activeError = activeConversation?.error ?? '';
  const isAwaitingChatResponse = pendingAgentStatus?.conversationId === activeConversation?.id;
  const pendingStatusLabel = pendingAgentStatus ? pendingAgentStatusLabel(pendingAgentStatus) : '';
  const chapterScopeReady = isChapterScopeSelectionValid(chapterScope);
  const activeTimeline = useMemo(() => buildAgentConversationTimeline({
    messages: activeConversation?.messages ?? [],
    runs: activeConversation?.runs,
    currentRun: activeRun,
    currentPlan: activePlan,
    updatedAt: activeConversation?.updatedAt ?? new Date().toISOString(),
  }), [activeConversation?.messages, activeConversation?.runs, activeConversation?.updatedAt, activePlan, activeRun]);
  const timelineActivityKey = useMemo(() => [
    activeConversation?.id ?? '',
    activeTimeline[activeTimeline.length - 1]?.key ?? '',
    activeConversation?.messages.length ?? 0,
    activeRun?.events.length ?? 0,
    activeRun?.status ?? '',
    activeRun?.pendingApproval?.checkpointId ?? '',
    activePlan?.steps.map((step) => `${step.stepId}:${step.status}`).join('|') ?? '',
    isAwaitingChatResponse ? `awaiting-chat-response:${pendingAgentStatus?.phase}` : '',
    activeError,
  ].join(':'), [activeConversation?.id, activeConversation?.messages.length, activeError, activePlan?.steps, activeRun?.events.length, activeRun?.pendingApproval?.checkpointId, activeRun?.status, activeTimeline, isAwaitingChatResponse, pendingAgentStatus?.phase]);

  const setPendingPhase = useCallback((conversationId: string, phase: AgentPendingPhase) => {
    setPendingAgentStatus({ conversationId, phase });
  }, []);

  const clearPendingStatus = useCallback((conversationId: string) => {
    setPendingAgentStatus((current) => current?.conversationId === conversationId ? null : current);
  }, []);

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
      if (container) container.scrollTop = container.scrollHeight;
    });
  }, []);

  const handleConversationScroll = useCallback(() => {
    const container = conversationScrollRef.current;
    if (!container) return;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 96;
    followsLatestRef.current = isNearBottom;
    setFollowsLatest(isNearBottom);
  }, []);

  useLayoutEffect(() => {
    if (!followsLatestRef.current) return;
    const container = conversationScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [timelineActivityKey]);

  useLayoutEffect(() => {
    scrollToLatest();
  }, [activeConversation?.id, scrollToLatest]);

  const explicitChapterScope = useMemo(() => chapterScopePayload(chapterScope), [chapterScope]);

  const contextPayload = useMemo(() => ({
    novelId,
    novelTitle: novel?.title,
    volumeId: currentChapter?.volumeId,
    chapterId: currentChapter?.id,
    chapterTitle: currentChapter?.title,
    locale,
    origin: 'desktop-ui',
    chapterScope: explicitChapterScope,
  }), [currentChapter?.id, currentChapter?.title, currentChapter?.volumeId, explicitChapterScope, locale, novel?.title, novelId]);

  const currentContentText = useMemo(
    () => extractReadableText(currentContent),
    [currentContent],
  );

  useEffect(() => {
    let cancelled = false;
    const shouldShowLoader = loadedConversationNovelIdRef.current !== novelId;
    conversationsLoadedRef.current = false;
    if (shouldShowLoader) setIsConversationsLoading(true);
    setConversationSearch('');
    activeRunIdRef.current = null;
    subscribedRunIdRef.current = null;
    lastSequenceRef.current = 0;

    void (async () => {
      try {
        const stored = await window.db.getAgentConversations(novelId);
        const nextConversations = stored.length > 0
          ? stored.map((conversation) => ({ ...conversation, novelId }))
          : createSeedConversations(novelId, currentChapter);
        if (cancelled) return;
        setConversations(nextConversations);
        setActiveConversationId(nextConversations[0]?.id ?? 'conv-current-chapter-review');
      } catch (err) {
        console.warn('[AgentWorkspace] Failed to load agent conversations:', err);
        const fallback = createSeedConversations(novelId, currentChapter);
        if (cancelled) return;
        setConversations(fallback);
        setActiveConversationId(fallback[0]?.id ?? 'conv-current-chapter-review');
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
          window.db.upsertAgentConversation({ ...conversation, novelId: conversation.novelId || novelId })
        )));
      } catch (err) {
        console.warn('[AgentWorkspace] Failed to save agent conversations:', err);
      }
    })();
  }, [conversations, novelId]);

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
      if (!conversation.run) return conversation;
      const run: AgentRun = {
        ...conversation.run,
        artifacts: (conversation.run.artifacts ?? []).map((artifact) => (
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
      return { ...withCurrentRun(conversation, run), updatedAt: new Date().toISOString() };
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
    updateActiveConversation((conversation) => ({
      ...conversation,
      role,
      updatedAt: new Date().toISOString(),
    }));
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
      return;
    }
    toast.error(result.message || 'Runtime 恢复失败');
  }, [ensureRuntimeReady, isRuntimeRecoveryPending, refreshRoles]);

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
  }, [refreshHealth]);

  useEffect(() => {
    void refreshRoles();
    void refreshAiSettings();
  }, [refreshAiSettings, refreshRoles]);

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
        http: { ...aiSettings.http, model },
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

  const applyRunEvent = useCallback((event: AgentRunEvent) => {
    if (activeRunIdRef.current && event.runId !== activeRunIdRef.current) return;
    if (!shouldApplyRunSequence(event.sequence, lastSequenceRef.current)) return;
    lastSequenceRef.current = event.sequence;
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

    if (event.type === 'draft_created') {
      setReviewTarget('draft');
      setInspectorTab('review');
    }

    if (event.type === 'approval_required') {
      setIsWorking(false);
    }

    if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') {
      setIsWorking(false);
      if (subscribedRunIdRef.current === event.runId) {
        subscribedRunIdRef.current = null;
      }
      void window.agent.unsubscribeRun(event.runId);
    }
  }, []);

  useEffect(() => {
    const unsubscribeEvent = window.agent.onRunEvent(applyRunEvent);
    const unsubscribeDisconnected = window.agent.onRunDisconnected((payload) => {
      if (payload.runId !== activeRunIdRef.current) return;
      updateConversation(activeConversationId, (conversation) => ({
        ...conversation,
        error: `事件流已断开：${payload.message}`,
      }));
      void (async () => {
        try {
          const afterSequence = lastSequenceRef.current;
          const status = await window.agent.runStatus({ runId: payload.runId });
          setConversations((current) => current.map((conversation) => (
            conversation.run?.runId === payload.runId
              ? withCurrentRun(conversation, {
                  ...conversation.run,
                  status: status.status,
                  currentStepId: status.currentStepId,
                  draftSessionId: status.draftSessionId,
                  draftBatchId: status.draftBatchId,
                  artifacts: status.artifacts,
                })
              : conversation
          )));
          if (shouldResubscribeRun(status.status, afterSequence, status.lastSequence)) {
            await window.agent.subscribeRun(payload.runId, { afterSequence });
            subscribedRunIdRef.current = payload.runId;
          } else {
            if (subscribedRunIdRef.current === payload.runId) {
              subscribedRunIdRef.current = null;
            }
            setIsWorking(false);
          }
        } catch (err) {
          setIsWorking(false);
          const interruptedConversation = conversationsRef.current.find((conversation) => conversation.run?.runId === payload.runId);
          const interruptedPlan = interruptedConversation?.run?.planSnapshot ?? interruptedConversation?.plan;
          if (interruptedConversation && interruptedPlan && isRevisionBatchPlan(interruptedPlan) && hasRevisionBatchSource(interruptedPlan)) {
            void syncRevisionPlanOutcome(interruptedConversation.id, interruptedPlan, 'interrupted', payload.runId)
              .catch((syncError) => console.warn('[AgentWorkspace] Failed to recover interrupted revision tasks:', syncError));
          }
          updateConversation(activeConversationId, (conversation) => ({
            ...conversation,
            error: toErrorMessage(err),
          }));
        }
      })();
    });
    return () => {
      unsubscribeEvent();
      unsubscribeDisconnected();
      const runId = activeRunIdRef.current;
      if (runId) void window.agent.unsubscribeRun(runId);
      subscribedRunIdRef.current = null;
    };
  }, [activeConversationId, applyRunEvent, syncRevisionPlanOutcome, updateConversation]);

  useEffect(() => {
    const run = activeConversation?.run;
    const runId = run?.runId ?? null;
    if (!run || !runId) {
      const previous = subscribedRunIdRef.current;
      if (previous) void window.agent.unsubscribeRun(previous);
      activeRunIdRef.current = null;
      subscribedRunIdRef.current = null;
      lastSequenceRef.current = 0;
      setIsWorking(false);
      return;
    }

    activeRunIdRef.current = runId;
    const recovery = getRunRecoverySnapshot(run);
    lastSequenceRef.current = recovery.lastSequence;
    if (!recovery.isLive) {
      if (subscribedRunIdRef.current === runId) {
        void window.agent.unsubscribeRun(runId);
        subscribedRunIdRef.current = null;
      }
      setIsWorking(false);
      return;
    }

    setIsWorking(run.status === 'running' || run.status === 'cancelling');
    if (subscribedRunIdRef.current === runId) return;
    const previous = subscribedRunIdRef.current;
    if (previous) void window.agent.unsubscribeRun(previous);
    subscribedRunIdRef.current = runId;
    const afterSequence = lastSequenceRef.current;
    void window.agent.subscribeRun(runId, { afterSequence }).catch((err) => {
      if (subscribedRunIdRef.current === runId) {
        subscribedRunIdRef.current = null;
      }
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        error: `恢复事件流失败：${toErrorMessage(err)}`,
      }));
    });
  }, [activeConversation?.id, activeConversation?.run?.runId, activeConversation?.run?.status, updateConversation]);

  const createConversation = () => {
    const conversation: AgentConversation = {
      id: nowId('conv'),
      novelId,
      title: `${roleLabel(selectedRole)}新会话`,
      description: '新的小说创作讨论',
      role: selectedRole,
      runtimeConversationId: null,
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: nowId('msg'),
          role: 'assistant',
          content: `已切换到${roleLabel(selectedRole)}模式。当前工作模式决定是否形成计划草稿和调用工具。`,
          createdAt: new Date().toISOString(),
        },
      ],
      suggestedGoal: null,
      plan: null,
      run: null,
      error: '',
    };
    setConversations((current) => [conversation, ...current]);
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
      setChapterScope({
        kind: targetIds.length === 1 ? 'current_chapter' : 'selected_chapters',
        ...(targetVolume ? { volumeId: targetVolume.id } : {}),
        chapterIds: targetIds,
        anchorChapterId,
        processingMode: 'detailed',
        experts: ['editor'],
      });
    }
    setSelectedRole(conversation.role);
    setActiveConversationId(conversation.id);
    setWorkspaceView('conversation');
    setConversationDrawerOpen(false);
    requestAnimationFrame(scrollToLatest);
  }, [conversations, scrollToLatest, volumes]);

  const deleteConversation = async (conversationId: string) => {
    if (conversations.length <= 1) return;
    const nextConversations = conversations.filter((conversation) => conversation.id !== conversationId);
    setConversations(nextConversations);
    if (activeConversationId === conversationId) {
      setActiveConversationId(nextConversations[0]?.id ?? '');
      setInspectorTab(nextConversations[0]?.run?.draftSessionId || nextConversations[0]?.run?.draftBatchId ? 'review' : 'context');
    }
    try {
      await window.db.deleteAgentConversation(conversationId);
    } catch (err) {
      console.warn('[AgentWorkspace] Failed to delete agent conversation:', err);
    }
  };

  const createPlan = useCallback(async (goal: string, intentDecision?: AgentIntentDecision) => {
    if (!goal.trim() || !activeConversation) return;
    const conversationId = activeConversation.id;
    if (!chapterScopeReady) {
      clearPendingStatus(conversationId);
      updateConversation(conversationId, (conversation) => ({ ...conversation, error: '请先完成章节范围选择。' }));
      return;
    }
    if (approvalMode === 'chat_only') {
      clearPendingStatus(conversationId);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: '当前权限为“只讨论不执行”。请切换为“需要用户审核”后再生成计划。',
      }));
      return;
    }
    setPendingPhase(conversationId, 'planning');
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '', suggestedGoal: null }));
    try {
      const nextPlan = await window.agent.plan({
        novelId,
        chapterId: currentChapter?.id,
        goal,
        currentContent,
        locale,
        role: activeConversation.role,
        approvalMode,
        chapterScope: explicitChapterScope,
        context: contextPayload,
        intentDecision,
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
            content: `已生成计划草稿：${nextPlan.title}。你可以忽略、提交修改意见，或选择“实施此计划”。`,
            createdAt: new Date().toISOString(),
          },
        ],
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
  }, [activeConversation, approvalMode, chapterScopeReady, clearPendingStatus, contextPayload, currentChapter?.id, currentContent, explicitChapterScope, locale, novelId, setPendingPhase, updateConversation]);

  const beginRetryRun = useCallback(async (
    conversationId: string,
    failedRun: AgentRun,
    recovery?: AgentIntentDecision['recovery'],
  ) => {
    const nextRun = await window.agent.retryRun({
      failedRunId: recovery?.failedRunId ?? failedRun.runId,
      expectedFailureRevision: recovery?.expectedFailureRevision ?? failedRun.failureRevision,
      mode: recovery?.mode ?? 'failed_node',
      context: contextPayload,
    });
    activeRunIdRef.current = nextRun.runId;
    lastSequenceRef.current = 0;
    updateConversation(conversationId, (conversation) => {
      const planSnapshot = failedRun.planSnapshot ?? conversation.plan ?? undefined;
      const updated = withCurrentRun(conversation, {
        ...nextRun,
        events: [],
        ...(planSnapshot ? { planSnapshot } : {}),
      });
      return { ...updated, updatedAt: new Date().toISOString(), error: '' };
    });
    await window.agent.subscribeRun(nextRun.runId);
    subscribedRunIdRef.current = nextRun.runId;
    scrollToLatest();
  }, [contextPayload, scrollToLatest, updateConversation]);

  const retryFailedRun = useCallback(async (failedRun: AgentRun) => {
    if (!activeConversation || isWorking || failedRun.status !== 'failed' || !failedRun.failureRevision) return;
    const conversationId = activeConversation.id;
    setIsWorking(true);
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    try {
      await beginRetryRun(conversationId, failedRun);
    } catch (error) {
      subscribedRunIdRef.current = null;
      setIsWorking(false);
      updateConversation(conversationId, (conversation) => ({ ...conversation, error: toErrorMessage(error) }));
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
        chapterScope: explicitChapterScope,
        context: contextPayload,
      });
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: new Date().toISOString(),
        plan: revisedPlan,
        messages: [
          ...conversation.messages,
          {
            id: nowId('msg'),
            role: 'assistant',
            content: `计划已按意见修订：${trimmed}`,
            createdAt: new Date().toISOString(),
          },
        ],
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
  }, [activeConversation, activePlan, activeRun, clearPendingStatus, contextPayload, explicitChapterScope, isWorking, locale, setPendingPhase, updateConversation]);

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
      appendMessage(conversationId, { role: 'user', content: initialGoal });
      setPendingPhase(conversationId, 'thinking');
      void createPlan(initialGoal);
      onInitialGoalConsumed();
    })();
  }, [activeConversationId, appendMessage, createPlan, ensureRuntimeReady, initialGoal, onInitialGoalConsumed, setPendingPhase, updateConversation]);

  const sendChat = async (messageOverride?: string) => {
    if (!activeConversation) return;
    const message = (messageOverride ?? input).trim();
    if (!message || isWorking || isRuntimeRecoveryPending || sendInFlightRef.current) return;
    const conversationId = activeConversation.id;
    if (!chapterScopeReady) {
      updateConversation(conversationId, (conversation) => ({ ...conversation, error: '请先完成章节范围选择。' }));
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
    const userMessageId = nowId('msg');
    const userCreatedAt = new Date().toISOString();
    if (messageOverride === undefined) setInput('');
    scrollToLatest();
    appendMessage(conversationId, { role: 'user', content: message }, {
      startNewTurnAfterTerminal: true,
      messageId: userMessageId,
      createdAt: userCreatedAt,
    });
    setIsWorking(true);
    setPendingPhase(conversationId, 'thinking');
    updateConversation(conversationId, (conversation) => ({ ...conversation, error: '' }));
    let startedRetryRun = false;
    try {
      const response = await window.agent.chat({
        novelId,
        novelTitle: novel?.title,
        volumeId: currentChapter?.volumeId,
        chapterId: currentChapter?.id,
        chapterTitle: currentChapter?.title,
        message,
        conversationId: runtimeConversationId,
        currentContent,
        currentContentText,
        locale,
        role: activeConversation.role,
        approvalMode,
        chapterScope: explicitChapterScope,
        messageId: userMessageId,
        history: activeConversation.messages.flatMap(({ id, role, content, createdAt }) => (
          role === 'system' ? [] : [{ role, content, createdAt, messageId: id }]
        )),
        persistentSummary: activeConversation.contextSummary,
        conversationContext: {
          currentPlan: activeConversation.plan,
          activeRun: activeConversation.run ? {
            runId: activeConversation.run.runId,
            status: activeConversation.run.status,
            progress: activeConversation.run.progress,
            currentStepId: activeConversation.run.currentStepId,
            pendingApproval: activeConversation.run.pendingApproval,
            approvalResponses: activeConversation.run.approvalResponses,
            draftSessionId: activeConversation.run.draftSessionId,
            draftBatchId: activeConversation.run.draftBatchId,
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
      });
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
        content: serializeContextCompression(response.contextCompression),
        createdAt: compressionCreatedAt,
      } : null;
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        runtimeConversationId: response.conversationId,
        contextSummary: response.conversationSummary ?? conversation.contextSummary,
        suggestedGoal: null,
        messages: [
          ...conversation.messages,
          ...(compressionMessage ? [compressionMessage] : []),
          ...(!recovery ? [{
            id: response.assistantMessage.messageId || nowId('msg'),
            role: 'assistant' as const,
            content: response.assistantMessage.content,
            createdAt: response.assistantMessage.createdAt,
            contextReads: response.contextReads,
            contextDiagnostics: response.contextDiagnostics,
          }] : []),
        ],
      }));
      if (recovery && activeConversation.run) {
        await beginRetryRun(conversationId, activeConversation.run, recovery);
        startedRetryRun = true;
        clearPendingStatus(conversationId);
      } else if (shouldDraftPlan) {
        const conversationHistory = activeConversation.messages.flatMap(({ role, content }) => (
          role === 'system' ? [] : [{ role, content }]
        ));
        const planGoal = activeConversation.plan && !activeConversation.run
          ? `${activeConversation.plan.goal}\n\n用户修改意见：${message}`
          : buildAgentPlanGoal(message, conversationHistory);
        await createPlan(planGoal, response.intentDecision);
      } else {
        clearPendingStatus(conversationId);
      }
    } catch (err) {
      clearPendingStatus(conversationId);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(err),
      }));
    } finally {
      clearPendingStatus(conversationId);
      if (!startedRetryRun) setIsWorking(false);
      sendInFlightRef.current = false;
    }
  };

  const submitApproval = async (approval: AgentApprovalRequest, selectedOptionIds: string[], freeText: string) => {
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
    } catch (err) {
      setIsWorking(false);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(err),
      }));
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
      updateConversation(conversationId, (conversation) => withCurrentRun(conversation, {
        ...nextRun,
        events: [],
        planSnapshot: revisionPlan,
      }));
      await window.agent.subscribeRun(nextRun.runId);
      subscribedRunIdRef.current = nextRun.runId;
      scrollToLatest();
    } catch (error) {
      subscribedRunIdRef.current = null;
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
      updateConversation(conversationId, (conversation) => withCurrentRun(conversation, {
        ...nextRun,
        events: [],
        planSnapshot: activePlan,
      }));
      await window.agent.subscribeRun(nextRun.runId);
      subscribedRunIdRef.current = nextRun.runId;
    } catch (err) {
      subscribedRunIdRef.current = null;
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
            `从第 ${fromChildIndex + 1} 章开始重新生成，并保留此前已审核草稿。`,
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
        title: `重新生成${regenerationLabel}（从第 ${fromChildIndex + 1} 章）`,
        goal: reviewComments.length
          ? `根据 ${reviewComments.length} 条审批意见，从第 ${fromChildIndex + 1} 章开始重新生成。`
          : `从第 ${fromChildIndex + 1} 章开始重新生成，并保留此前已审核草稿。`,
        requiresApproval: true,
        preferredRole: 'writer',
        deliverable: 'chapter_draft_batch',
        steps: [{
          stepId,
          agent: 'writer',
          title: `从第 ${fromChildIndex + 1} 章重新生成${isRewriteBatch ? '改写' : '批次'}草稿`,
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
      await window.agent.subscribeRun(nextRun.runId);
      subscribedRunIdRef.current = nextRun.runId;
    } catch (err) {
      subscribedRunIdRef.current = null;
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
      await window.agent.subscribeRun(nextRun.runId);
      subscribedRunIdRef.current = nextRun.runId;
    } catch (error) {
      subscribedRunIdRef.current = null;
      setIsWorking(false);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        error: toErrorMessage(error),
      }));
      throw error;
    }
  };

  const cancelRun = async () => {
    const runId = activeRunIdRef.current;
    if (!runId || !activeConversation || !activeRun || activeRun.status !== 'running') return;
    const conversationId = activeConversation.id;
    updateConversation(conversationId, (conversation) => (
      conversation.run?.runId === runId
        ? withCurrentRun(conversation, { ...conversation.run, status: 'cancelling', cancelRequested: true })
        : conversation
    ));
    try {
      const nextRun = await window.agent.cancel({ runId });
      updateConversation(conversationId, (conversation) => (
        conversation.run?.runId === runId
          ? withCurrentRun(conversation, { ...conversation.run, status: nextRun.status, cancelRequested: true })
          : conversation
      ));
    } catch (err) {
      updateConversation(conversationId, (conversation) => {
        const restored = conversation.run?.runId === runId
          ? withCurrentRun(conversation, { ...conversation.run, status: 'running', cancelRequested: false })
          : conversation;
        return { ...restored, error: `无法取消，请稍后重试：${toErrorMessage(err)}` };
      });
    }
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
  const inspectorVisible = inspectorOpen && workspaceView === 'conversation';

  return (
    <div className={clsx(
      'relative h-full min-h-0 grid overflow-hidden max-[1040px]:grid-cols-1',
      inspectorVisible
        ? 'grid-cols-[300px_minmax(0,1fr)_360px] max-[1180px]:grid-cols-[minmax(0,1fr)_360px]'
        : 'grid-cols-[300px_minmax(0,1fr)] max-[1180px]:grid-cols-1',
      isDark ? 'bg-[#0a0a0f] text-neutral-100' : 'bg-[var(--ui-canvas)] text-[var(--ui-text-primary)]',
    )}>
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
            <button
              type="button"
              onClick={() => {
                setInspectorVisibility(!inspectorOpen);
              }}
              className={clsx('grid h-8 w-8 place-items-center rounded-md', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white')}
              title={inspectorOpen ? '收起 Inspector' : '打开 Inspector'}
              aria-label={inspectorOpen ? '收起 Inspector' : '打开 Inspector'}
              aria-pressed={inspectorOpen}
            >
              {inspectorOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </button>
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
              if (entry.kind === 'message') {
                return <MessageBubble key={entry.key} message={entry.message} isDark={isDark} />;
              }
              const timelineRun = entry.run as AgentRun | null;
              const timelinePlan = entry.plan as AgentPlan;
              const supportingArtifacts = (timelineRun?.artifacts ?? []).filter((artifact) => !getExpertReport(artifact));
              const isRevisionBatch = isRevisionBatchPlan(timelinePlan);
              const isActiveTask = timelineRun
                ? activeRun?.runId === timelineRun.runId
                : activePlan?.planId === timelinePlan.planId && !activeRun;
              return (
                <Fragment key={entry.key}>
                  {isRevisionBatch ? (
                    <RevisionProgressCard
                      plan={timelinePlan}
                      run={timelineRun}
                      isDark={isDark}
                      interactive={isActiveTask}
                      onCancel={() => void cancelRun()}
                    />
                  ) : (
                    <PlanCard
                      plan={timelinePlan}
                      run={timelineRun}
                      interactive={isActiveTask}
                      isDark={isDark}
                      isWorking={isWorking}
                      renderStepStatus={renderStepStatus}
                      onExecute={() => void executePlan()}
                      onCancel={() => void cancelRun()}
                      onIgnore={ignorePlan}
                      onSubmitRevision={(revision) => void submitPlanRevision(revision)}
                    />
                  )}
                  {timelineRun && !isRevisionBatch && (
                    <AgentActivityStream
                      run={timelineRun}
                      plan={timelinePlan}
                      isDark={isDark}
                      interactive={isActiveTask}
                      isWorking={isWorking}
                      onRetry={() => void retryFailedRun(timelineRun)}
                      onReplan={() => prepareFailedRunReplan(timelinePlan)}
                    />
                  )}
                  {timelineRun?.artifacts && timelineRun.artifacts.some((artifact) => getExpertReport(artifact)) && (
                    <ConsolidatedReportCard
                      artifacts={timelineRun.artifacts}
                      isDark={isDark}
                      interactive={isActiveTask && !isWorking}
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
                  {isActiveTask && activeApproval && (
                    <ApprovalRequiredCard
                      approval={activeApproval}
                      isDark={isDark}
                      isWorking={isWorking}
                      onSubmit={(selectedOptionIds, freeText) => void submitApproval(activeApproval, selectedOptionIds, freeText)}
                    />
                  )}
                  {timelineRun?.draftBatchId && (
                    <DraftBatchCard
                      draftBatchId={timelineRun.draftBatchId}
                      isDark={isDark}
                      onOpenReview={() => openInspector('review', 'draft', timelineRun.runId)}
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

            {pendingRevisionBatch?.conversationId === activeConversation?.id && (
              <RevisionProgressCard
                plan={pendingRevisionBatch.plan}
                run={null}
                isDark={isDark}
                interactive={false}
                onCancel={() => undefined}
              />
            )}

            {isAwaitingChatResponse && <ThinkingIndicator isDark={isDark} label={pendingStatusLabel} />}

            {activeConversation?.suggestedGoal && !activePlan && (
              <ActionCard
                isDark={isDark}
                title="需要形成计划草稿吗？"
                description="当前回复可以使用只读项目上下文。形成计划草稿后可继续修改；确认后才会生成草稿或执行写回。"
                actionLabel="生成计划草稿"
                onAction={() => void createPlan(activeConversation.suggestedGoal ?? '')}
                disabled={isWorking}
              />
            )}

              {activeError && !(activeRun?.status === 'failed' && activeRun.events.some((event) => event.type === 'run_failed')) && (
                <div className={clsx('rounded-lg border px-3 py-2 text-sm flex gap-2', isDark ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700')}>
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{activeError}</span>
                </div>
              )}
            </div>
          </div>
          {!followsLatest && (
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
          <div className={clsx('mx-auto max-w-[880px] rounded-lg border p-2', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
            <textarea
              ref={chatInputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendChat();
                }
              }}
              rows={3}
              disabled={isWorking || isRuntimeRecoveryPending}
              placeholder={approvalMode === 'chat_only' ? '只讨论不执行：保留交流和建议，不读取项目或生成计划。' : '直接描述创作任务；我会先读取所需上下文，草稿与写回仍需你确认。'}
              className={clsx('block w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none', isDark ? 'placeholder:text-neutral-600' : 'placeholder:text-[var(--ui-text-disabled)]')}
            />
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
              <div className="min-w-0 flex flex-wrap items-center gap-1.5">
                <ChapterScopeSelector
                  isDark={isDark}
                  value={chapterScope}
                  volumes={volumes}
                  currentChapterId={currentChapter?.id}
                  currentVolumeId={currentChapter?.volumeId}
                  teamMode={(activeConversation?.role ?? selectedRole) === 'team'}
                  open={scopeMenuOpen}
                  disabled={isWorking || isRuntimeRecoveryPending}
                  onChange={setChapterScope}
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
                onClick={() => void sendChat()}
                disabled={isWorking || isRuntimeRecoveryPending || !input.trim() || !chapterScopeReady}
                title={!chapterScopeReady ? '请先完成章节范围选择' : '发送'}
                className={clsx(
                  'h-8 min-w-[64px] shrink-0 whitespace-nowrap rounded-md px-2.5 inline-flex items-center justify-center gap-1.5 text-xs text-white disabled:opacity-40',
                  'max-[640px]:w-8 max-[640px]:min-w-8 max-[640px]:px-0',
                  isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600',
                )}
              >
                <Send className="h-4 w-4" />
                <span className="max-[640px]:sr-only">发送</span>
              </button>
            </div>
          </div>
        </div>
      </main>

      {inspectorVisible && inspectorDrawerOpen && (
        <button
          type="button"
          className="absolute inset-0 z-30 bg-black/20 min-[1041px]:hidden"
          onClick={() => setInspectorVisibility(false)}
          aria-label="关闭 Inspector"
        />
      )}
      {inspectorVisible && <InspectorPanel
        isDark={isDark}
        narrowOpen={inspectorDrawerOpen}
        onClose={() => setInspectorVisibility(false)}
        activeTab={inspectorTab}
        onTabChange={setInspectorTab}
        novel={novel}
        currentChapter={currentChapter}
        novelId={novelId}
        sourceConversationId={activeConversation?.id ?? ''}
        messages={activeConversation?.messages ?? []}
        contextSummary={activeConversation?.contextSummary ?? null}
        activeRun={selectedReviewRun}
        conversationRuns={conversationRuns}
        activeRole={activeConversation?.role ?? selectedRole}
        roleOptions={roleOptions}
        volumes={volumes}
        reviewTarget={reviewTarget}
        onReviewTargetChange={setReviewTarget}
        onUsePreset={usePresetTask}
        onArtifactStatusChange={updateArtifactStatus}
        onDraftBatchStatusChange={updateDraftBatchArtifactStatus}
        onArtifactReviewChange={updateArtifactReview}
        onRegenerateDraftBatch={regenerateDraftBatch}
        onDiscussReviewComments={discussReviewComments}
        onRegenerateDraft={regenerateDraftFromReview}
        onSelectReviewRun={setSelectedReviewRunId}
      />}
      </>
      )}
    </div>
  );
}

function MessageBubble({ message, isDark }: { message: ConversationMessage; isDark: boolean }) {
  if (message.role === 'system') {
    return <ContextCompressionNotice message={message} isDark={isDark} />;
  }
  const isUser = message.role === 'user';
  return (
    <div className={clsx('flex gap-3', isUser && 'justify-end')}>
      {!isUser && (
        <div className={clsx('mt-1 h-8 w-8 rounded-md grid place-items-center shrink-0', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')}>
          <Bot className="h-4 w-4" />
        </div>
      )}
      <div className={clsx('max-w-[78%] rounded-lg border px-4 py-3 text-sm leading-6 whitespace-pre-wrap', isUser
        ? (isDark ? 'border-white/10 bg-white/10' : 'border-[var(--ui-border)] bg-white')
        : (isDark ? 'border-white/10 bg-[#111827]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-muted)]'))}
      >
        {!isUser && message.contextReads && message.contextReads.length > 0 && (
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
        {message.content}
      </div>
      {isUser && (
        <div className={clsx('mt-1 h-8 w-8 rounded-md grid place-items-center shrink-0', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')}>
          <UserRound className="h-4 w-4" />
        </div>
      )}
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
  const title = compressedHistory > 0 ? '已压缩较早上下文' : '已压缩本次上下文';
  const summary = compression.historyMessagesSummarized > 0
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
            <span>持久摘要 v{compression.persistentSummaryRevision} · 覆盖 {compression.persistentSummaryMessageCount} 条</span>
          )}
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
  onCancel,
}: {
  plan: RevisionBatchPlan;
  run: AgentRun | null;
  isDark: boolean;
  interactive: boolean;
  onCancel: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const completedStepCount = plan.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
  const activeStepIndex = Math.max(0, plan.steps.findIndex((step) => step.stepId === run?.currentStepId));
  const progressRatio = run?.status === 'completed'
    ? 1
    : plan.steps.length > 0
      ? Math.max(completedStepCount, activeStepIndex) / plan.steps.length
      : 0;
  const itemIndex = Math.min(
    plan.revisionItems.length - 1,
    Math.max(0, Math.floor(progressRatio * plan.revisionItems.length)),
  );
  const currentItem = plan.revisionItems[itemIndex];
  const currentStep = plan.steps[activeStepIndex] ?? plan.steps[0];
  const isRunning = run?.status === 'running' || run?.status === 'cancelling';
  const statusLabel = !run
    ? '正在准备修订'
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
            : run.status === 'completed'
              ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              : <AlertCircle className="h-4 w-4 text-amber-600" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            第 {run?.status === 'completed' ? plan.revisionItems.length : itemIndex + 1} / {plan.revisionItems.length} 项修订
          </div>
          <p className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>
            {currentStep ? `第 ${activeStepIndex + 1} / ${plan.steps.length} 步 · ` : ''}{statusLabel}
          </p>
          {currentItem && run?.status !== 'completed' && (
            <p className={clsx('mt-1 truncate text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-disabled)]')}>{currentItem.title}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {interactive && run?.status === 'running' && (
            <button type="button" onClick={onCancel} className={clsx('grid h-8 w-8 place-items-center rounded-md', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')} title="停止修订" aria-label="停止修订">
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          )}
          <button type="button" onClick={() => setExpanded((value) => !value)} className={clsx('grid h-8 w-8 place-items-center rounded-md', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')} aria-expanded={expanded} title={expanded ? '收起步骤' : '展开步骤'} aria-label={expanded ? '收起修订步骤' : '展开修订步骤'}>
            <ChevronDown className={clsx('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className={clsx('border-t px-4 py-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
          <div className="space-y-2">
            {plan.revisionItems.map((item, index) => {
              const status = run?.status === 'completed' || index < itemIndex
                ? '已完成'
                : index === itemIndex && run?.status === 'failed'
                  ? '失败'
                  : index === itemIndex && isRunning
                    ? '处理中'
                    : index === itemIndex && !run
                      ? '准备中'
                      : '等待';
              return (
                <div key={item.findingId} className="flex items-start gap-2 text-xs leading-5">
                  <span className={clsx(
                    'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px]',
                    status === '已完成'
                      ? 'bg-emerald-100 text-emerald-700'
                      : status === '处理中' || status === '准备中'
                        ? 'bg-blue-100 text-blue-700'
                        : status === '失败'
                          ? 'bg-red-100 text-red-700'
                          : isDark ? 'bg-white/10 text-neutral-500' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-disabled)]',
                  )}>{status === '已完成' ? '✓' : index + 1}</span>
                  <span className="min-w-0 flex-1">{item.title}</span>
                  <span className={clsx('shrink-0', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-disabled)]')}>{status}</span>
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

function PlanCard({
  plan,
  run,
  interactive,
  isDark,
  isWorking,
  renderStepStatus,
  onExecute,
  onCancel,
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
  onCancel: () => void;
  onIgnore: () => void;
  onSubmitRevision: (revision: string) => void;
}) {
  const canCancel = interactive && run?.status === 'running';
  const canRetry = interactive && run?.status === 'cancelled';
  const hasStarted = Boolean(run);
  const [revision, setRevision] = useState('');
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
          <p className={clsx('mt-1 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{plan.goal}</p>
          {scopeLabel && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className={clsx('rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[#eef6ff] text-[#1f6fca]')}>{scopeLabel}</span>
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
        {plan.steps.map((step, index) => (
          <div key={step.stepId} className={clsx('rounded-md border p-3 flex gap-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
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
              </div>
            </div>
            {step.status === 'completed' && <CheckCircle2 className="h-4 w-4 text-[#2f80ed]" />}
          </div>
        ))}
      </div>
      {!hasStarted && interactive && (
        <div className={clsx('mt-4 rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
          <div className="text-sm font-semibold">实施此计划？</div>
          <div className="mt-3 grid gap-2 text-sm">
            <label className={clsx('flex items-center gap-2 rounded-md px-2 py-2', isDark ? 'bg-white/5' : 'bg-white border border-[var(--ui-border)]')}>
              <span className={clsx('grid h-6 w-6 place-items-center rounded-full text-xs font-semibold', isDark ? 'bg-white text-black' : 'bg-indigo-600 text-white')}>1</span>
              是，实施此计划
            </label>
            <label className={clsx('flex items-center gap-2 rounded-md px-2 py-2', isDark ? 'bg-white/5 text-neutral-300' : 'bg-white border border-[var(--ui-border)] text-[var(--ui-text-muted)]')}>
              <span className={clsx('grid h-6 w-6 place-items-center rounded-full border text-xs', isDark ? 'border-white/20' : 'border-[var(--ui-border-strong)]')}>2</span>
              否，请告知如何调整
            </label>
          </div>
          <textarea
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
            rows={2}
            placeholder="例如：不要生成改写稿，只输出问题清单"
            className={clsx('mt-3 block w-full resize-none rounded-md border px-3 py-2 text-sm leading-6 outline-none', isDark ? 'border-white/10 bg-black/20 placeholder:text-neutral-600' : 'border-[var(--ui-border)] bg-white placeholder:text-[var(--ui-text-disabled)]')}
          />
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onIgnore}
              disabled={isWorking}
              className={clsx('h-9 px-3 rounded-md text-sm border disabled:opacity-50', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-subtle)]')}
            >
              忽略
            </button>
            <button
              type="button"
              onClick={() => {
                onSubmitRevision(revision);
                setRevision('');
              }}
              disabled={isWorking || !revision.trim()}
              className={clsx('h-9 px-3 rounded-md text-sm border disabled:opacity-50', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}
            >
              提交
            </button>
            <button
              type="button"
              onClick={onExecute}
              disabled={isWorking}
              className={clsx('h-9 px-3 rounded-md inline-flex items-center gap-2 text-sm text-white disabled:opacity-50', isDark ? 'bg-[#2f80ed]' : 'bg-indigo-600')}
            >
              {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              实施此计划
            </button>
          </div>
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        {canCancel && (
          <button
            type="button"
            onClick={onCancel}
            className={clsx('h-9 px-3 rounded-md inline-flex items-center gap-2 text-sm border', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border)] text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-subtle)]')}
          >
            <Square className="h-4 w-4" />
            取消
          </button>
        )}
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

function AgentActivityStream({
  run,
  plan,
  isDark,
  interactive,
  isWorking,
  onRetry,
  onReplan,
}: {
  run: AgentRun;
  plan: AgentPlan;
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
  const detailPanelId = `agent-activity-${run.runId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

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

  const toneClass = projection.tone === 'failed'
    ? (isDark ? 'text-red-300' : 'text-red-700')
    : projection.tone === 'waiting'
      ? (isDark ? 'text-amber-300' : 'text-amber-700')
      : projection.tone === 'completed'
        ? (isDark ? 'text-emerald-300' : 'text-emerald-700')
        : (isDark ? 'text-neutral-300' : 'text-[var(--ui-text-muted)]');

  const statusIcon = projection.tone === 'running'
    ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
    : projection.tone === 'completed'
      ? <CheckCircle2 className="h-4 w-4" />
      : projection.tone === 'failed'
        ? <AlertCircle className="h-4 w-4" />
        : projection.tone === 'waiting'
          ? <MessageSquare className="h-4 w-4" />
          : <Square className="h-4 w-4" />;

  const retryableFailure = run.status === 'failed'
    && projection.retry?.phase === 'exhausted'
    && projection.retry.retryable
    && Boolean(run.failureRevision);
  const canRetry = retryableFailure && interactive;
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
    <div className={clsx(
      'overflow-hidden rounded-md border',
      retryableFailure
        ? isDark ? 'border-red-400/25 bg-red-500/[0.04]' : 'border-[#e9c8c4] bg-white'
        : isDark ? 'border-white/10 bg-black/15' : 'border-[var(--ui-border)] bg-white',
    )}>
      <div className="flex min-h-12 w-full items-center gap-3 px-3 py-2.5">
        <span className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-md', toneClass, isDark ? 'bg-white/5' : 'bg-[var(--ui-surface-muted)]')}>
          {statusIcon}
        </span>
        <span className="min-w-0 flex-1">
          <span aria-live="polite" className={clsx('block text-sm font-medium', toneClass)}>{activityTitle}</span>
          <span className={clsx('mt-0.5 block text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
            {activitySubline}
          </span>
        </span>
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          aria-controls={detailPanelId}
          className={clsx('inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-muted)]')}
        >
          <span className="max-[520px]:sr-only">{expanded ? '收起详情' : '查看详情'}</span>
          <ChevronDown className={clsx('h-4 w-4 transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
        </button>
      </div>

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
                重试失败步骤
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
        <div
          id={detailPanelId}
          ref={detailScrollRef}
          role="region"
          aria-label="Agent 操作明细"
          onScroll={handleDetailScroll}
          className={clsx('max-h-80 overflow-y-auto border-t px-3 py-2', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}
        >
          {projection.details.length > 0 ? (
            <div className="space-y-0">
              {projection.details.map((detail, index) => (
                <ActivityDetailRow key={detail.eventId} detail={detail} isDark={isDark} isLast={index === projection.details.length - 1} />
              ))}
            </div>
          ) : (
            <div className={clsx('px-1 py-3 text-sm', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>等待第一条执行事件。</div>
          )}
        </div>
      )}
    </div>
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

function ApprovalRequiredCard({
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

function DraftBatchCard({ draftBatchId, isDark, onOpenReview }: { draftBatchId: string; isDark: boolean; onOpenReview: () => void }) {
  return (
    <div className={clsx('rounded-lg border p-4', isDark ? 'border-white/10 bg-white/[0.03]' : 'border-[var(--ui-border)] bg-white')}>
      <div className="flex items-start gap-3">
        <div className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-md', isDark ? 'bg-white/10' : 'bg-[var(--ui-surface-muted)]')}>
          <ListChecks className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">已生成多章节草稿</div>
          <p className={clsx('mt-1 text-sm leading-6', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>
            可以逐章检查节拍和正文，只提交连续且未过期的章节前缀。
          </p>
          <div className={clsx('mt-2 rounded border px-2 py-1 text-xs font-mono', isDark ? 'border-white/10 bg-black/20 text-neutral-400' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-[var(--ui-text-muted)]')}>
            {draftBatchId}
          </div>
          <button type="button" onClick={onOpenReview} className={clsx('mt-3 h-9 rounded-md border px-3 text-sm', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}>
            打开批次审核
          </button>
        </div>
      </div>
    </div>
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
              ? '素材包已进入审核流程。可以在右侧 Inspector 逐条添加审批意见或整包入库。'
              : '草稿进入审核流程。可以在右侧 Inspector 查看差异、编辑反馈并确认写回。'}
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
            角色与 Skill 设置
            <div className={clsx('mt-0.5 text-xs leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>查看角色能力、工具权限和技能说明</div>
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
  novel,
  currentChapter,
  novelId,
  sourceConversationId,
  messages,
  contextSummary,
  activeRun,
  conversationRuns,
  activeRole,
  roleOptions,
  volumes,
  reviewTarget,
  onReviewTargetChange,
  onUsePreset,
  onArtifactStatusChange,
  onDraftBatchStatusChange,
  onArtifactReviewChange,
  onRegenerateDraftBatch,
  onDiscussReviewComments,
  onRegenerateDraft,
  onSelectReviewRun,
}: {
  isDark: boolean;
  narrowOpen: boolean;
  onClose: () => void;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  novel: Novel | null;
  currentChapter: Chapter | null;
  novelId: string;
  sourceConversationId: string;
  messages: ConversationMessage[];
  contextSummary: AgentConversationSummary | null;
  activeRun: AgentRun | null;
  conversationRuns: AgentRun[];
  activeRole: AgentRoleMode;
  roleOptions: RoleOption[];
  volumes: Volume[];
  reviewTarget: 'draft' | 'report';
  onReviewTargetChange: (target: 'draft' | 'report') => void;
  onUsePreset: (role: AgentRoleMode, preset: AgentPresetTask) => void;
  onArtifactStatusChange: (draftSessionId: string, status: AgentArtifact['status']) => void;
  onDraftBatchStatusChange: (draftBatchId: string, status: AgentArtifact['status']) => void;
  onArtifactReviewChange: (artifactId: string, result: ArtifactReviewSubmitResult) => void;
  onRegenerateDraftBatch: (batch: DraftBatchRecord, fromChildIndex: number, comments?: ReviewCommentRecord[]) => Promise<void>;
  onDiscussReviewComments: (comments: ReviewCommentRecord[]) => Promise<void>;
  onRegenerateDraft: (session: DraftSessionRecord, comments: ReviewCommentRecord[]) => Promise<void>;
  onSelectReviewRun: (runId: string | null) => void;
}) {
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
  const hasDraftReview = Boolean(activeRun?.draftSessionId || activeRun?.draftBatchId);
  const showsReportReview = reviewTarget === 'report' && hasExpertReport;
  const isDraftReview = isReview && !showsReportReview && hasDraftReview;
  const reviewTitle = isDraftReview
    ? (activeRun?.draftBatchId ? '多章草稿审核' : hasCreativeAssetsReview ? '创作素材审核' : '草稿审核中心')
    : '报告审核';
  const allArtifacts = conversationRuns.flatMap((run) => run.artifacts ?? []);

  return (
    <aside className={clsx(
      'border-l min-h-0 min-w-0 overflow-hidden flex flex-col max-[1040px]:absolute max-[1040px]:inset-y-0 max-[1040px]:right-0 max-[1040px]:z-40 max-[1040px]:w-[min(360px,calc(100vw-16px))] max-[1040px]:shadow-[-16px_0_40px_rgba(17,24,39,0.12)]',
      !narrowOpen && 'max-[1040px]:hidden',
      isDraftReview && 'absolute inset-y-0 right-0 z-30 w-[min(880px,calc(100vw-16px))] shadow-[-16px_0_40px_rgba(17,24,39,0.10)] max-[1040px]:z-40 max-[1040px]:w-[calc(100vw-16px)]',
      isDark ? 'border-white/10 bg-[#0f0f13]' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]',
    )}>
      <div className="p-4 border-b border-inherit">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {isReview ? <FileText className="h-4 w-4 text-[#2f80ed]" /> : <MessageSquare className="h-4 w-4" />}
            {isReview ? reviewTitle : 'Inspector'}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onClose}
              className={clsx('grid h-8 w-8 place-items-center rounded-md', isDark ? 'text-neutral-400 hover:bg-white/5' : 'text-[var(--ui-text-muted)] hover:bg-white')}
              title="收起 Inspector"
              aria-label="收起 Inspector"
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
      <div className={clsx('flex-1 min-h-0', isDraftReview ? 'overflow-hidden' : 'overflow-y-auto p-4')}>
        {activeTab === 'context' && (
          <div className="space-y-3">
            <InspectorItem label="当前小说" value={novel?.title || '未命名小说'} isDark={isDark} />
            <InspectorItem label="当前章" value={currentChapter?.title || '未选择'} isDark={isDark} />
            <InspectorItem label="章节字数" value={String(currentChapter?.wordCount ?? 0)} isDark={isDark} />
            <InspectorItem label="当前能力" value="RAG、搜索、章节草稿、创作素材草稿" isDark={isDark} />
            <PersistentContextSummaryCard isDark={isDark} summary={contextSummary} />
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
              onReviewSubmitted={onArtifactReviewChange}
            />
          ) : activeRun?.draftBatchId ? (
            <DraftBatchReviewPanel
              isDark={isDark}
              draftBatchId={activeRun.draftBatchId}
              reviewContext={{
                novelId,
                sourceConversationId,
                sourceRunId: activeRun.runId,
                sourceArtifactId: activeRun.artifacts?.find((artifact) => artifact.reference?.draftBatchId === activeRun.draftBatchId)?.artifactId,
              }}
              volumes={volumes}
              onBatchStatusChange={onDraftBatchStatusChange}
              onRegenerate={onRegenerateDraftBatch}
              onDiscuss={onDiscussReviewComments}
            />
          ) : (
            <ReviewPanel
              isDark={isDark}
              activeRun={activeRun}
              novelId={novelId}
              sourceConversationId={sourceConversationId}
              chapterTitle={currentChapter?.title || '当前章节'}
              onArtifactStatusChange={onArtifactStatusChange}
              onDiscuss={onDiscussReviewComments}
              onRegenerate={onRegenerateDraft}
            />
          )
        )}
        {activeTab === 'artifacts' && (
          <ArtifactPanel
            isDark={isDark}
            artifacts={allArtifacts}
            onOpenReview={(target, artifact) => {
              onSelectReviewRun(artifact.runId);
              onReviewTargetChange(target);
              onTabChange('review');
            }}
          />
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
}: {
  isDark: boolean;
  summary: AgentConversationSummary | null;
}) {
  if (!summary || summary.version !== 'agent-conversation-summary-v1') return null;
  const decisions = Array.isArray(summary.userDecisions) ? summary.userDecisions : [];
  const questions = Array.isArray(summary.unresolvedQuestions) ? summary.unresolvedQuestions : [];
  const artifactRefs = Array.isArray(summary.artifactRefs) ? summary.artifactRefs : [];
  const facts = Array.isArray(summary.facts) ? summary.facts : [];
  const summaryGroups: Array<[string, AgentConversationSummaryEntry[]]> = [
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
              覆盖 {summary.coverage?.messageCount ?? summary.coveredMessageIds.length} 条消息 · {artifactRefs.length} 个产物引用
            </div>
          </div>
          <span className={clsx('shrink-0 rounded px-2 py-1 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
            v{summary.revision}
          </span>
        </div>
      </summary>
      <div className={clsx('border-t px-3 py-3 space-y-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
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
                      {entry.sourceMessageIds.length} 个来源
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
          <span>{diagnostics.contextWindowSource === 'configured' ? '手动配置' : '模型档案'}</span>
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
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      title={onOpen ? '在 Inspector 中查看产物' : '历史任务产物'}
      className={clsx(
        'w-full rounded-lg border px-4 py-3 text-left flex items-center gap-3 disabled:cursor-default',
        isDark ? 'border-white/10 bg-black/20 enabled:hover:bg-white/5' : 'border-[var(--ui-border)] bg-white enabled:hover:bg-[var(--ui-surface-subtle)]',
      )}
    >
      <FileText className="h-4 w-4 shrink-0 text-[#2f80ed]" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">本次产物</div>
        <div className={clsx('mt-1 text-xs truncate', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
          {artifacts.map((artifact) => artifact.title).join(' · ')}
        </div>
      </div>
      <span className={clsx('shrink-0 rounded px-1.5 py-0.5 text-[11px]', isDark ? 'bg-white/10 text-neutral-300' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
        {artifacts.length}
      </span>
    </button>
  );
}

function ArtifactPanel({ isDark, artifacts, onOpenReview }: { isDark: boolean; artifacts: AgentArtifact[]; onOpenReview: (target: 'draft' | 'report', artifact: AgentArtifact) => void }) {
  if (artifacts.length === 0) {
    return (
      <div className={clsx('rounded-lg border p-3 text-sm leading-6', isDark ? 'border-white/10 bg-black/20 text-neutral-400' : 'border-[var(--ui-border)] bg-white text-[var(--ui-text-muted)]')}>
        当前任务还没有结构化产物。任务完成前至少会生成一份最终报告；生成型任务还必须包含对应草稿。
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {artifacts.map((artifact) => {
        const isDraftArtifact = artifact.type === 'chapter_draft' || artifact.type === 'chapter_draft_batch' || artifact.type === 'creative_assets_draft';
        const expertReport = getExpertReport(artifact);
        const review = artifact.type === 'consistency_review' && artifact.metadata?.review && typeof artifact.metadata.review === 'object'
          ? artifact.metadata.review as Record<string, unknown>
          : null;
        const dimensions = review && Array.isArray(review.dimensions) ? review.dimensions as Array<Record<string, unknown>> : [];
        const issues = review && Array.isArray(review.issues) ? review.issues as Array<Record<string, unknown>> : [];
        const plotlineAnalysis = artifact.type === 'plotline_analysis' && artifact.metadata?.analysis && typeof artifact.metadata.analysis === 'object'
          ? artifact.metadata.analysis as Record<string, unknown>
          : null;
        const plotlineThreads = plotlineAnalysis && Array.isArray(plotlineAnalysis.threads)
          ? plotlineAnalysis.threads as Array<Record<string, unknown>>
          : [];
        const plotlineIssues = plotlineAnalysis && Array.isArray(plotlineAnalysis.issues)
          ? plotlineAnalysis.issues as Array<Record<string, unknown>>
          : [];
        const plotlineCoverage = plotlineAnalysis?.coverage && typeof plotlineAnalysis.coverage === 'object'
          ? plotlineAnalysis.coverage as Record<string, unknown>
          : null;
        return (
          <div key={artifact.artifactId} className={clsx('rounded-lg border p-3', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
            <div className="flex items-start gap-2">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[#2f80ed]" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold break-words">{artifact.title}</div>
                <div className={clsx('mt-1 text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                  {artifactTypeLabel(artifact.type)} · {artifact.status}
                </div>
              </div>
            </div>
            {artifact.summary && (
              <p className={clsx('mt-3 text-sm leading-6 whitespace-pre-wrap break-words', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-secondary)]')}>
                {artifact.summary}
              </p>
            )}
            {expertReport && (
              <div className={clsx('mt-3 rounded-md border p-3', isDark ? 'border-white/10 bg-white/5' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span>{expertReport.findings.length} 个结构化问题</span>
                  <span className={clsx('rounded px-1.5 py-0.5 text-[10px]', artifact.reviewStatus === 'reviewed' ? 'bg-emerald-50 text-emerald-700' : artifact.reviewStatus === 'stale' ? 'bg-red-50 text-red-700' : isDark ? 'bg-white/10 text-neutral-400' : 'bg-white text-[var(--ui-text-muted)]')}>
                    {artifact.reviewStatus === 'reviewed' ? '已审核' : artifact.reviewStatus === 'stale' ? '已过期' : artifact.reviewStatus === 'in_review' ? '审核中' : '待审核'}
                  </span>
                </div>
                {expertReport.coverage && (
                  <div className={clsx('mt-2 text-[11px] leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                    覆盖 {expertReport.coverage.contextChapterCount}/{expertReport.coverage.totalChapterCount} 章
                    {expertReport.coverage.omittedChapterCount > 0 ? ` · 省略 ${expertReport.coverage.omittedChapterCount} 章` : ''}
                  </div>
                )}
                <button type="button" onClick={() => onOpenReview('report', artifact)} className={clsx('mt-3 h-8 w-full rounded-md border px-3 text-xs', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}>
                  审核报告
                </button>
              </div>
            )}
            {review && (
              <div className={clsx('mt-3 rounded-md border p-3', isDark ? 'border-white/10 bg-white/5' : 'border-[var(--ui-border)] bg-[var(--ui-surface-subtle)]')}>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <div className={clsx('text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>一致性总分</div>
                    <div className="mt-1 text-2xl font-semibold">{typeof review.overallScore === 'number' ? review.overallScore : '--'}<span className={clsx('ml-1 text-xs font-normal', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>/ 100</span></div>
                  </div>
                  <span className={clsx('text-xs', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{issues.length} 个问题</span>
                </div>
                {dimensions.length > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {dimensions.slice(0, 8).map((dimension, index) => (
                      <div key={`${String(dimension.id || 'dimension')}-${index}`} className={clsx('rounded border px-2 py-1.5', isDark ? 'border-white/10' : 'border-[var(--ui-border)] bg-white')}>
                        <div className="truncate text-[11px]">{String(dimension.label || dimension.id || '未命名维度')}</div>
                        <div className="mt-0.5 text-sm font-semibold">{typeof dimension.score === 'number' ? dimension.score : '不可检查'}</div>
                      </div>
                    ))}
                  </div>
                )}
                {issues.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {issues.slice(0, 20).map((issue, index) => (
                      <div key={`${String(issue.issueId || 'issue')}-${index}`} className={clsx('border-t pt-2', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                        <div className="flex items-start gap-2">
                          <span className={clsx('mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10px] uppercase', issue.severity === 'critical' || issue.severity === 'high' ? 'bg-red-500/10 text-red-600' : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>{String(issue.severity || 'info')}</span>
                          <div className="min-w-0 text-sm font-medium leading-5">{String(issue.title || '未命名问题')}</div>
                        </div>
                        {typeof issue.location === 'string' && issue.location && <div className={clsx('mt-1 text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>位置：{issue.location}</div>}
                        {typeof issue.recommendation === 'string' && issue.recommendation && <div className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{issue.recommendation}</div>}
                        {typeof issue.uncertainty === 'string' && issue.uncertainty && <div className={clsx('mt-1 text-[11px] leading-5', isDark ? 'text-amber-300/80' : 'text-amber-700')}>需确认：{issue.uncertainty}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {plotlineAnalysis && (
              <div className={clsx('mt-3 border-t pt-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <div className={clsx('text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>情节线健康度</div>
                    <div className="mt-1 text-2xl font-semibold">
                      {typeof plotlineAnalysis.overallScore === 'number' ? plotlineAnalysis.overallScore : '--'}
                      <span className={clsx('ml-1 text-xs font-normal', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>/ 100</span>
                    </div>
                  </div>
                  <div className={clsx('text-right text-[11px] leading-5', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
                    <div>{String(plotlineAnalysis.scope || '未标注范围')}</div>
                    <div>
                      已读 {typeof plotlineCoverage?.analyzedChapterCount === 'number' ? plotlineCoverage.analyzedChapterCount : 0} 章
                      {typeof plotlineCoverage?.omittedChapterCount === 'number' && plotlineCoverage.omittedChapterCount > 0
                        ? ` · 省略 ${plotlineCoverage.omittedChapterCount} 章`
                        : ''}
                    </div>
                  </div>
                </div>

                {plotlineThreads.length > 0 && (
                  <div className="mt-4">
                    <div className={clsx('text-xs font-semibold', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-primary)]')}>主线与支线</div>
                    <div className={clsx('mt-2 divide-y', isDark ? 'divide-white/10' : 'divide-[var(--ui-border)]')}>
                      {plotlineThreads.slice(0, 30).map((thread, index) => {
                        const findings = Array.isArray(thread.findings) ? thread.findings.map(String) : [];
                        const recommendations = Array.isArray(thread.recommendations) ? thread.recommendations.map(String) : [];
                        return (
                          <div key={`${String(thread.plotlineId || thread.name || 'thread')}-${index}`} className="py-2.5 first:pt-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={clsx('shrink-0 rounded px-1.5 py-0.5 text-[10px]', thread.role === 'main' ? 'bg-blue-500/10 text-blue-600' : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
                                {thread.role === 'main' ? '主线' : thread.role === 'subplot' ? '支线' : '未分类'}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">{String(thread.name || '未命名情节线')}</span>
                              {typeof thread.progressionScore === 'number' && (
                                <span className={clsx('shrink-0 text-xs tabular-nums', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{thread.progressionScore}/100</span>
                              )}
                            </div>
                            {typeof thread.status === 'string' && thread.status && (
                              <div className={clsx('mt-1 text-[11px]', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>{thread.status}</div>
                            )}
                            {findings[0] && <div className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-secondary)]')}>{findings[0]}</div>}
                            {recommendations[0] && <div className={clsx('mt-1 text-xs leading-5', isDark ? 'text-blue-300/80' : 'text-[#285b91]')}>建议：{recommendations[0]}</div>}
                            {typeof thread.uncertainty === 'string' && thread.uncertainty && (
                              <div className={clsx('mt-1 text-[11px] leading-5', isDark ? 'text-amber-300/80' : 'text-amber-700')}>需确认：{thread.uncertainty}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {plotlineIssues.length > 0 && (
                  <div className="mt-4">
                    <div className={clsx('text-xs font-semibold', isDark ? 'text-neutral-300' : 'text-[var(--ui-text-primary)]')}>风险与待回收项</div>
                    <div className={clsx('mt-2 divide-y', isDark ? 'divide-white/10' : 'divide-[var(--ui-border)]')}>
                      {plotlineIssues.slice(0, 30).map((issue, index) => (
                        <div key={`${String(issue.issueId || 'plotline-issue')}-${index}`} className="py-2.5 first:pt-0">
                          <div className="flex items-start gap-2">
                            <span className={clsx('mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10px] uppercase', issue.severity === 'critical' || issue.severity === 'high' ? 'bg-red-500/10 text-red-600' : issue.severity === 'medium' ? 'bg-amber-500/10 text-amber-700' : isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]')}>
                              {String(issue.severity || 'info')}
                            </span>
                            <div className="min-w-0 text-sm font-medium leading-5">{String(issue.title || '未命名问题')}</div>
                          </div>
                          {typeof issue.recommendation === 'string' && issue.recommendation && (
                            <div className={clsx('mt-1 text-xs leading-5', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>{issue.recommendation}</div>
                          )}
                          {typeof issue.uncertainty === 'string' && issue.uncertainty && (
                            <div className={clsx('mt-1 text-[11px] leading-5', isDark ? 'text-amber-300/80' : 'text-amber-700')}>需确认：{issue.uncertainty}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {artifact.content && artifact.content !== artifact.summary && (
              review || plotlineAnalysis || artifact.type === 'context_bundle' || artifact.type === 'chapter_scope_context' ? (
                <details className={clsx('mt-3 border-t pt-3', isDark ? 'border-white/10' : 'border-[var(--ui-border)]')}>
                  <summary className={clsx('cursor-pointer text-xs', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}>
                    {review ? '查看完整审核正文' : plotlineAnalysis ? '查看完整分析正文' : '查看结构化上下文'}
                  </summary>
                  <div className={clsx('mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md p-2 text-sm leading-6', isDark ? 'bg-white/5 text-neutral-300' : 'bg-[var(--ui-surface-subtle)] text-[var(--ui-text-secondary)]')}>
                    {artifact.content}
                  </div>
                </details>
              ) : (
                <div className={clsx('mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md p-2 text-sm leading-6', isDark ? 'bg-white/5 text-neutral-300' : 'bg-[var(--ui-surface-subtle)] text-[var(--ui-text-secondary)]')}>
                  {artifact.content}
                </div>
              )
            )}
            {isDraftArtifact && (typeof artifact.reference?.draftSessionId === 'string' || typeof artifact.reference?.draftBatchId === 'string') && (
              <button type="button" onClick={() => onOpenReview('draft', artifact)} className={clsx('mt-3 h-8 rounded-md border px-3 text-xs', isDark ? 'border-white/10 text-neutral-300 hover:bg-white/5' : 'border-[var(--ui-border-strong)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-subtle)]')}>
                {artifact.type === 'chapter_draft_batch' ? '打开批次审核' : artifact.type === 'creative_assets_draft' ? '打开素材审核' : '打开草稿审核'}
              </button>
            )}
          </div>
        );
      })}
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
        <div className="text-xs font-semibold">Skill</div>
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
  chapterTitle,
  onArtifactStatusChange,
  onDiscuss,
  onRegenerate,
}: {
  isDark: boolean;
  activeRun: AgentRun | null;
  novelId: string;
  sourceConversationId: string;
  chapterTitle: string;
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
  const [reviewMode, setReviewMode] = useState<'diff' | 'review' | 'original' | 'draft'>('diff');
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
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold">{chapterTitle}</h2>
              <span className={clsx('shrink-0 rounded px-2 py-0.5 text-[11px]', isDraft ? 'bg-[#e8f2ff] text-[#2f80ed]' : (isDark ? 'bg-white/10 text-neutral-400' : 'bg-[var(--ui-surface-muted)] text-[var(--ui-text-muted)]'))}>{statusLabel}</span>
            </div>
            <div className={clsx('mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs', isDark ? 'text-neutral-500' : 'text-[var(--ui-text-muted)]')}>
              <span>原文 {originalLength} 字</span>
              <span>草稿 {draftLength} 字</span>
              <span>新增 {Math.max(0, draftLength)} 字</span>
              {chapterPayload?.usedContext?.length ? <span>参考 {chapterPayload.usedContext.length} 项上下文</span> : null}
              {chapterPayload?.contextPolicy && (
                <button
                  type="button"
                  onClick={() => setShowContextDetails((value) => !value)}
                  className={clsx('inline-flex items-center gap-1 hover:underline', isDark ? 'text-neutral-400' : 'text-[var(--ui-text-muted)]')}
                >
                  前文 {previousContextSources.length} 章 · 正文 {fullContextCount} · 摘要 {summaryContextCount}
                  <ChevronDown className={clsx('h-3 w-3 transition-transform', showContextDetails && 'rotate-180')} />
                </button>
              )}
            </div>
          </div>
          <div className={clsx('flex shrink-0 rounded-md border p-1', isDark ? 'border-white/10 bg-black/20' : 'border-[var(--ui-border)] bg-white')}>
            {([
              { id: 'diff', label: '高亮差异', icon: FileDiff },
              { id: 'review', label: '逐段审核', icon: MessageSquare },
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
        {reviewMode === 'diff' && <DraftDiffView originalText={originalText} draftText={generatedText} isDark={isDark} />}
        {reviewMode === 'review' && session && (
          <ReviewableParagraphs
            text={generatedText}
            reviewVersionId={session.draftSessionId}
            comments={reviewComments.comments}
            isDark={isDark}
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
