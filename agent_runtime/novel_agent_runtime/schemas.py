from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

from .intent.schemas import IntentDecision, IntentEffect
from .toolchains.schemas import (
    AgentChapterScope,
    AgentChapterSnapshot,
    ChapterScopeCoverage,
    ContextEvidence,
    ToolchainInvocation,
)


AgentName = Literal["supervisor", "writer", "editor", "reader", "worldbuilding", "research_rag"]
AgentRoleId = Literal["team", "writer", "editor", "reader", "worldbuilding", "research_rag"]
StepStatus = Literal["pending", "running", "completed", "failed", "skipped"]
RunStatus = Literal["idle", "waiting_approval", "running", "completed", "failed", "cancelled", "cancelling"]
AgentArtifactType = Literal[
    "report",
    "context_bundle",
    "chapter_scope_context",
    "consistency_review",
    "plotline_analysis",
    "chapter_draft",
    "chapter_draft_batch",
    "creative_assets_draft",
    "writer_revision_plan",
    "chapter_range_review",
    "reader_journey",
    "worldbuilding_consistency",
    "research_fact_check",
    "scope_audit",
]
AgentArtifactStatus = Literal["ready", "committed", "discarded", "failed"]
AgentArtifactReviewStatus = Literal["unreviewed", "in_review", "reviewed", "stale"]
ExpertReportArtifactType = Literal[
    "writer_revision_plan",
    "chapter_range_review",
    "reader_journey",
    "worldbuilding_consistency",
    "research_fact_check",
    "scope_audit",
]
ExpertFindingSeverity = Literal["critical", "high", "medium", "low", "info"]
FindingDecisionStatus = Literal["accepted", "rejected", "deferred"]
AgentRevisionTaskStatus = Literal["open", "planned", "deferred", "resolved", "closed", "stale"]
AgentRunEventType = Literal[
    "run_started",
    "plan_pending",
    "plan_approved",
    "plan_rejected",
    "message",
    "step_started",
    "step_completed",
    "step_failed",
    "tool_call",
    "tool_result",
    "toolchain_started",
    "toolchain_node_started",
    "toolchain_node_completed",
    "toolchain_completed",
    "toolchain_failed",
    "draft_created",
    "artifact_created",
    "approval_required",
    "error",
    "run_completed",
    "run_failed",
    "run_cancelled",
    "request_retry_scheduled",
    "request_retry_started",
    "request_retry_succeeded",
    "request_retry_exhausted",
    "run_retry_started",
]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:16]}"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentContext(BaseModel):
    novelId: str | None = None
    volumeId: str | None = None
    chapterId: str | None = None
    locale: str = "zh-CN"
    origin: str = "desktop-ui"


class AgentEnvelope(BaseModel):
    requestId: str | None = None
    method: str
    params: dict[str, Any] = Field(default_factory=dict)
    context: AgentContext = Field(default_factory=AgentContext)


class AgentPresetTask(BaseModel):
    id: str
    label: str
    description: str = ""
    goal: str
    deliverable: Literal["report", "expert_report", "chapter_draft", "chapter_draft_batch", "creative_assets_draft"] = "report"


class AgentRoleDefinition(BaseModel):
    id: AgentRoleId
    agent: AgentName
    label: str
    description: str
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    presets: list[AgentPresetTask] = Field(default_factory=list)


class AgentPlanStep(BaseModel):
    stepId: str
    agent: AgentName
    title: str
    tools: list[str] = Field(default_factory=list)
    toolchain: ToolchainInvocation | None = None
    status: StepStatus = "pending"


class AgentPlan(BaseModel):
    planId: str
    threadId: str
    title: str
    goal: str
    requiresApproval: bool = True
    steps: list[AgentPlanStep]
    preferredRole: str = "team"
    deliverable: Literal["report", "expert_report", "chapter_draft", "chapter_draft_batch", "creative_assets_draft"] = "report"
    requestedEffect: IntentEffect = "unknown"


class AgentMessage(BaseModel):
    messageId: str = Field(default_factory=lambda: new_id("message"))
    role: Literal["user", "assistant"]
    content: str
    createdAt: str = Field(default_factory=utc_now)


class AgentChatResponse(BaseModel):
    conversationId: str
    assistantMessage: AgentMessage
    suggestedActions: list[dict[str, str]] = Field(default_factory=list)
    awaitingUserInput: bool = False
    contextReads: list[dict[str, Any]] = Field(default_factory=list)
    contextDiagnostics: dict[str, Any] | None = None
    contextCompression: dict[str, Any] | None = None
    conversationSummary: dict[str, Any] | None = None
    intentDecision: IntentDecision | None = None


class AgentRunEvent(BaseModel):
    eventId: str
    sequence: int = 0
    runId: str
    planId: str | None = None
    threadId: str | None = None
    stepId: str | None = None
    type: AgentRunEventType
    agent: AgentName | None = None
    toolName: str | None = None
    status: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    createdAt: str = Field(default_factory=utc_now)


class AgentArtifact(BaseModel):
    artifactId: str
    runId: str
    planId: str
    type: AgentArtifactType
    title: str
    status: AgentArtifactStatus = "ready"
    summary: str = ""
    content: str | None = None
    reference: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    reviewStatus: AgentArtifactReviewStatus = "unreviewed"
    reviewRevision: int = Field(default=0, ge=0)
    createdAt: str = Field(default_factory=utc_now)


class ExpertFinding(BaseModel):
    findingId: str = Field(min_length=1)
    title: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    category: str = Field(min_length=1)
    severity: ExpertFindingSeverity
    chapterIds: list[str] = Field(default_factory=list)
    expert: AgentName
    evidenceRefs: list[str] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    recommendation: str | None = None
    recommendedRole: AgentName | None = None
    uncertainty: str | None = None


class ExpertReportPayload(BaseModel):
    artifactId: str
    novelId: str
    runId: str
    planId: str
    type: ExpertReportArtifactType
    title: str
    expert: AgentName
    scope: AgentChapterScope
    findings: list[ExpertFinding] = Field(default_factory=list)
    sourceSnapshot: list[AgentChapterSnapshot] = Field(default_factory=list)
    coverage: ChapterScopeCoverage | None = None
    summary: str | None = None
    generatedAt: str = Field(default_factory=utc_now)


class FindingDecision(BaseModel):
    findingId: str
    status: FindingDecisionStatus
    note: str | None = None


class AgentRevisionTask(BaseModel):
    revisionTaskId: str
    novelId: str
    sourceArtifactId: str
    sourceFindingId: str
    title: str
    description: str
    targetChapterIds: list[str] = Field(default_factory=list)
    sourceExpert: AgentName
    severity: ExpertFindingSeverity
    recommendedRole: AgentName
    status: AgentRevisionTaskStatus = "open"
    sourceSnapshot: list[AgentChapterSnapshot] = Field(default_factory=list)
    note: str | None = None
    planId: str | None = None
    plan: dict[str, Any] | None = None
    createdAt: str = Field(default_factory=utc_now)
    updatedAt: str = Field(default_factory=utc_now)


class AgentRun(BaseModel):
    runId: str
    threadId: str
    planId: str
    status: RunStatus
    currentStepId: str | None = None
    progress: float = 0
    events: list[AgentRunEvent] = Field(default_factory=list)
    artifacts: list[AgentArtifact] = Field(default_factory=list)
    draftSessionId: str | None = None
    draftBatchId: str | None = None
    cancelRequested: bool = False
    pendingApproval: dict[str, Any] | None = None
    approvalResponses: list[dict[str, Any]] = Field(default_factory=list)
    retryOfRunId: str | None = None
    retryRootRunId: str | None = None
    retryAttempt: int = Field(default=0, ge=0)
    failureRevision: int = Field(default=0, ge=0)
    resumedFrom: dict[str, Any] | None = None


class AgentRunStatusResult(BaseModel):
    runId: str
    planId: str
    threadId: str
    status: RunStatus
    currentStepId: str | None = None
    currentStepTitle: str | None = None
    totalSteps: int = 0
    completedSteps: int = 0
    lastSequence: int = 0
    lastEventAt: str | None = None
    draftSessionId: str | None = None
    draftBatchId: str | None = None
    artifacts: list[AgentArtifact] = Field(default_factory=list)
    retryOfRunId: str | None = None
    retryRootRunId: str | None = None
    retryAttempt: int = 0
    failureRevision: int = 0


class AgentState(BaseModel):
    plans: dict[str, AgentPlan] = Field(default_factory=dict)
    runs: dict[str, AgentRun] = Field(default_factory=dict)
    conversations: dict[str, list[AgentMessage]] = Field(default_factory=dict)
    pendingClarifications: dict[str, dict[str, Any]] = Field(default_factory=dict)
    intentDecisions: dict[str, dict[str, Any]] = Field(default_factory=dict)
