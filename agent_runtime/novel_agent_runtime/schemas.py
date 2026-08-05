from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator

from .agent_skills.schemas import AgentSkillRef
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
RunStatus = Literal["idle", "waiting_approval", "waiting_user_input", "running", "completed", "failed", "cancelled", "cancelling"]
RunCompletionKind = Literal["complete", "partial"]
RecoveryFailureKind = Literal[
    "transport",
    "model_output_invalid",
    "local_transform_failed",
    "artifact_publish_failed",
    "persistence_failed",
    "side_effect_unknown",
]
RecoveryStrategy = Literal[
    "retry_request",
    "repair_model_output",
    "reprocess_saved_result",
    "resume_publish",
    "reconcile_side_effect",
    "none",
]
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
    "novel_bootstrap_draft",
    "agent_skill_pack_draft",
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
    "draft_operation_started",
    "draft_operation_progress",
    "artifact_created",
    "approval_required",
    "user_input_required",
    "user_input_resolved",
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
    defaultSkillIds: list[str] = Field(default_factory=list)
    presets: list[AgentPresetTask] = Field(default_factory=list)


class AgentPlanStep(BaseModel):
    stepId: str
    agent: AgentName
    title: str
    tools: list[str] = Field(default_factory=list)
    toolchain: ToolchainInvocation | None = None
    skills: list[AgentSkillRef] = Field(default_factory=list, max_length=2)
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
    userDecisions: dict[str, Any] | None = None


class AgentMessage(BaseModel):
    messageId: str = Field(default_factory=lambda: new_id("message"))
    role: Literal["user", "assistant"]
    content: str
    createdAt: str = Field(default_factory=utc_now)


class AgentUserInputEvidence(BaseModel):
    evidenceId: str
    sourceKind: Literal["editor_snapshot", "chapter", "attachment", "rag", "search", "creative_setting"]
    sourceId: str
    title: str
    version: str | None = None
    contentHash: str | None = None
    coverage: str | None = None


class AgentUserInputOption(BaseModel):
    optionId: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=500)
    evidenceIds: list[str] = Field(default_factory=list)


class AgentUserInputQuestion(BaseModel):
    questionId: str = Field(min_length=1, max_length=80)
    header: str = Field(min_length=1, max_length=24)
    prompt: str = Field(min_length=1, max_length=500)
    options: list[AgentUserInputOption] = Field(min_length=2, max_length=3)
    recommendedOptionId: str = Field(min_length=1, max_length=80)
    recommendationReason: str = Field(min_length=1, max_length=500)
    evidenceIds: list[str] = Field(default_factory=list)
    allowCustom: Literal[True] = True

    @model_validator(mode="after")
    def validate_question(self) -> "AgentUserInputQuestion":
        option_ids = [option.optionId for option in self.options]
        if len(option_ids) != len(set(option_ids)):
            raise ValueError("Question option IDs must be unique")
        if self.recommendedOptionId != option_ids[0]:
            raise ValueError("The first option must be the recommended option")
        return self


class AgentUserInputRequest(BaseModel):
    schemaVersion: Literal["agent-user-input-v1"] = "agent-user-input-v1"
    requestId: str
    inputSessionId: str = ""
    conversationId: str
    sourceMessageId: str | None = None
    phase: Literal["pre_plan", "execution"]
    round: Literal[1, 2, 3] = 1
    maxRounds: Literal[1, 2, 3] = 1
    previousRequestId: str | None = None
    title: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=1000)
    questions: list[AgentUserInputQuestion] = Field(min_length=1, max_length=3)
    evidence: list[AgentUserInputEvidence] = Field(default_factory=list)
    runId: str | None = None
    stepId: str | None = None
    createdAt: str = Field(default_factory=utc_now)

    @model_validator(mode="after")
    def validate_request(self) -> "AgentUserInputRequest":
        if not self.inputSessionId:
            # Stable compatibility for old single-round records.
            self.inputSessionId = self.requestId
        question_ids = [question.questionId for question in self.questions]
        if len(question_ids) != len(set(question_ids)):
            raise ValueError("Question IDs must be unique")
        evidence_ids = {item.evidenceId for item in self.evidence}
        for question in self.questions:
            referenced = [*question.evidenceIds, *(item for option in question.options for item in option.evidenceIds)]
            if set(referenced) - evidence_ids:
                raise ValueError("Question references unknown evidence")
        if self.phase == "execution" and (not self.runId or not self.stepId):
            raise ValueError("Execution user input requires runId and stepId")
        if self.round > self.maxRounds:
            raise ValueError("User input round cannot exceed maxRounds")
        if self.round > 1 and not self.previousRequestId:
            raise ValueError("Follow-up user input requires previousRequestId")
        return self


class AgentUserInputAnswer(BaseModel):
    questionId: str
    answerKind: Literal["option", "custom", "skipped"]
    selectedOptionId: str | None = None
    customText: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def validate_answer(self) -> "AgentUserInputAnswer":
        if self.answerKind == "option":
            if not self.selectedOptionId or self.customText:
                raise ValueError("Option answer requires only selectedOptionId")
        elif self.answerKind == "custom" and (not (self.customText or "").strip() or self.selectedOptionId):
            raise ValueError("Custom answer requires only non-empty customText")
        elif self.answerKind == "skipped" and (self.selectedOptionId or self.customText):
            raise ValueError("Skipped answer cannot include a value")
        if self.customText is not None:
            self.customText = self.customText.strip()
        return self


class AgentUserInputEffectiveAnswer(BaseModel):
    questionId: str
    answerKind: Literal["option", "custom"]
    selectedOptionId: str | None = None
    customText: str | None = None
    source: Literal["user", "recommended_fallback"] = "user"

    @model_validator(mode="after")
    def validate_effective_answer(self) -> "AgentUserInputEffectiveAnswer":
        if self.answerKind == "option":
            if not self.selectedOptionId or self.customText:
                raise ValueError("Effective option answer requires only selectedOptionId")
        elif not (self.customText or "").strip() or self.selectedOptionId:
            raise ValueError("Effective custom answer requires only non-empty customText")
        if self.source == "recommended_fallback" and self.answerKind != "option":
            raise ValueError("Recommended fallback must resolve to an option")
        if self.customText is not None:
            self.customText = self.customText.strip()
        return self


class AgentUserInputResolution(BaseModel):
    requestId: str
    inputSessionId: str | None = None
    round: Literal[1, 2, 3] = 1
    phase: Literal["pre_plan", "execution"]
    status: Literal["resolved", "dismissed"] = "resolved"
    answers: list[AgentUserInputAnswer] = Field(default_factory=list)
    effectiveAnswers: list[AgentUserInputEffectiveAnswer] = Field(default_factory=list)
    understandingSummary: str
    resolvedAt: str = Field(default_factory=utc_now)
    nextAction: Literal["follow_up_required", "plan_created", "run_resumed", "returned_to_chat", "run_cancelled"]
    request: AgentUserInputRequest | None = None
    pendingUserInput: AgentUserInputRequest | None = None
    plan: AgentPlan | None = None
    run: dict[str, Any] | None = None


class AgentChatResponse(BaseModel):
    conversationId: str
    assistantMessage: AgentMessage
    suggestedActions: list[dict[str, str]] = Field(default_factory=list)
    awaitingUserInput: bool = False
    contextReads: list[dict[str, Any]] = Field(default_factory=list)
    contextDiagnostics: dict[str, Any] | None = None
    contextCompression: dict[str, Any] | None = None
    intentDecision: IntentDecision | None = None
    pendingUserInput: AgentUserInputRequest | None = None
    status: Literal["completed", "failed", "cancelled"] = "completed"
    activities: list[dict[str, Any]] = Field(default_factory=list)
    failure: dict[str, Any] | None = None
    evidenceSnapshotId: str | None = None


class AgentEvidenceSnapshot(BaseModel):
    evidenceSnapshotId: str = Field(default_factory=lambda: new_id("evidence_snapshot"))
    conversationId: str
    storageConversationId: str = ""
    requestId: str | None = None
    sourceMessageId: str | None = None
    message: str
    role: str
    locale: str
    chapterScope: dict[str, Any]
    chapters: list[dict[str, Any]] = Field(default_factory=list)
    contextReads: list[dict[str, Any]] = Field(default_factory=list)
    contextDiagnostics: dict[str, Any] | None = None
    createdAt: str = Field(default_factory=utc_now)


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


class AgentRecoveryDescriptor(BaseModel):
    failureKind: RecoveryFailureKind
    failedAtPhase: Literal["model_pending", "model_received", "normalizing", "publishing"]
    retryStrategy: RecoveryStrategy
    canRecover: bool
    recoveryRevision: int = Field(default=1, ge=1)
    actionLabel: str | None = None
    blockedReason: Literal[
        "processor_update_required",
        "stale_dependency",
        "unsafe_side_effect",
        "repair_exhausted",
    ] | None = None
    completedArtifactIds: list[str] = Field(default_factory=list)
    affectedArtifactIds: list[str] = Field(default_factory=list)
    diagnosticRef: str


class AgentRun(BaseModel):
    runId: str
    threadId: str
    planId: str
    status: RunStatus
    currentStepId: str | None = None
    progress: float = 0
    events: list[AgentRunEvent] = Field(default_factory=list)
    artifacts: list[AgentArtifact] = Field(default_factory=list)
    skillSnapshot: list[AgentSkillRef] = Field(default_factory=list)
    draftSessionId: str | None = None
    draftBatchId: str | None = None
    draftOperationId: str | None = None
    draftOperationKey: str | None = None
    draftOperationStatus: str | None = None
    draftOperationVersion: int | None = None
    cancelRequested: bool = False
    pendingApproval: dict[str, Any] | None = None
    approvalResponses: list[dict[str, Any]] = Field(default_factory=list)
    pendingUserInput: AgentUserInputRequest | None = None
    userInputResponses: list[dict[str, Any]] = Field(default_factory=list)
    retryOfRunId: str | None = None
    retryRootRunId: str | None = None
    retryAttempt: int = Field(default=0, ge=0)
    failureRevision: int = Field(default=0, ge=0)
    resumedFrom: dict[str, Any] | None = None
    completionKind: RunCompletionKind = "complete"
    recovery: AgentRecoveryDescriptor | None = None


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
    draftOperationId: str | None = None
    draftOperationKey: str | None = None
    draftOperationStatus: str | None = None
    draftOperationVersion: int | None = None
    artifacts: list[AgentArtifact] = Field(default_factory=list)
    pendingApproval: dict[str, Any] | None = None
    pendingUserInput: AgentUserInputRequest | None = None
    retryOfRunId: str | None = None
    retryRootRunId: str | None = None
    retryAttempt: int = 0
    failureRevision: int = 0
    completionKind: RunCompletionKind = "complete"
    recovery: AgentRecoveryDescriptor | None = None


class AgentState(BaseModel):
    plans: dict[str, AgentPlan] = Field(default_factory=dict)
    runs: dict[str, AgentRun] = Field(default_factory=dict)
    conversations: dict[str, list[AgentMessage]] = Field(default_factory=dict)
    pendingClarifications: dict[str, dict[str, Any]] = Field(default_factory=dict)
    pendingUserInputs: dict[str, dict[str, Any]] = Field(default_factory=dict)
    userInputResolutions: dict[str, dict[str, Any]] = Field(default_factory=dict)
    intentDecisions: dict[str, dict[str, Any]] = Field(default_factory=dict)
    evidenceSnapshots: dict[str, AgentEvidenceSnapshot] = Field(default_factory=dict)
    recoveryRecords: dict[str, dict[str, Any]] = Field(default_factory=dict)
    pendingModelResults: dict[str, dict[str, Any]] = Field(default_factory=dict)
