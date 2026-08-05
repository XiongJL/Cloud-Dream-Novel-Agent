from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


IntentSource = Literal["chat", "shortcut", "preset"]
IntentEffect = Literal["unknown", "none", "read_only", "draft_write", "data_write", "external"]
IntentDeliverable = Literal["none", "report", "expert_report", "chapter_draft", "chapter_draft_batch", "creative_assets_draft"]


class IntentSelectionContext(BaseModel):
    novelId: str | None = None
    volumeId: str | None = None
    chapterId: str | None = None
    selectedText: str | None = None


class ResolvedChapterCandidate(BaseModel):
    role: Literal["structural_last", "last_written", "trailing_empty"]
    chapterId: str
    volumeId: str | None = None
    title: str | None = None
    label: str | None = None
    wordCount: int | None = Field(default=None, ge=0)
    hasContent: bool | None = None


class ResolvedIntentTarget(BaseModel):
    selector: str
    chapterId: str | None = None
    chapterIds: list[str] = Field(default_factory=list)
    volumeId: str | None = None
    title: str | None = None
    label: str | None = None
    wordCount: int | None = Field(default=None, ge=0)
    hasContent: bool | None = None
    structuralLast: ResolvedChapterCandidate | None = None
    lastWritten: ResolvedChapterCandidate | None = None
    trailingEmptyChapters: list[ResolvedChapterCandidate] = Field(default_factory=list)
    source: Literal["user_message", "structured_selection", "current_reference", "operation_default"]


class PendingClarificationRef(BaseModel):
    questionId: str
    question: str
    originatingMessageId: str | None = None


class SemanticUserInputOption(BaseModel):
    optionId: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=500)


class SemanticUserInputQuestion(BaseModel):
    questionId: str = Field(min_length=1, max_length=80)
    header: str = Field(min_length=1, max_length=24)
    prompt: str = Field(min_length=1, max_length=500)
    options: list[SemanticUserInputOption] = Field(min_length=2, max_length=3)
    recommendedOptionId: str = Field(min_length=1, max_length=80)
    recommendationReason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_recommendation(self) -> "SemanticUserInputQuestion":
        option_ids = [option.optionId for option in self.options]
        if len(option_ids) != len(set(option_ids)):
            raise ValueError("Question option IDs must be unique")
        if self.recommendedOptionId != option_ids[0]:
            raise ValueError("The first option must be the recommended option")
        return self


class SemanticUserInputRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=1000)
    questions: list[SemanticUserInputQuestion] = Field(min_length=1, max_length=3)


class PriorIntentRef(BaseModel):
    operationIds: list[str] = Field(default_factory=list)
    deliverable: IntentDeliverable = "none"
    suggestedRole: str | None = None


class FailedRunRef(BaseModel):
    runId: str
    failureRevision: int = Field(ge=1)
    retryable: bool = False
    code: str | None = None


class IntentConversationState(BaseModel):
    activePlanId: str | None = None
    activeRunId: str | None = None
    pendingClarification: PendingClarificationRef | None = None
    hasPendingApproval: bool = False
    previousIntent: PriorIntentRef | None = None
    latestFailedRun: FailedRunRef | None = None


class SemanticToolCall(BaseModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class SemanticProposal(BaseModel):
    responseContent: str
    shouldPlan: bool = False
    needsClarification: bool = False
    requestedOperations: list[str] = Field(default_factory=list)
    deliverable: IntentDeliverable | None = None
    suggestedRole: str | None = None
    confidence: float = Field(default=0.5, ge=0, le=1)
    toolCalls: list[SemanticToolCall] = Field(default_factory=list)
    inputRequest: SemanticUserInputRequest | None = None


class IntentEntryHint(BaseModel):
    actionId: str
    kind: Literal["operation", "skill.use", "skill.none", "skill.manager", "skill.author", "novel.bootstrap"] = "operation"
    operationIds: list[str] = Field(default_factory=list)
    deliverable: IntentDeliverable | None = None
    suggestedToolchainId: str | None = None
    skillId: str | None = None
    requestedRevisionId: str | None = None

    @model_validator(mode="after")
    def validate_skill_hint(self) -> "IntentEntryHint":
        if self.kind == "skill.use" and not self.skillId:
            raise ValueError("skill.use entry hints require skillId")
        return self


class IntentRequest(BaseModel):
    message: str
    conversationId: str
    locale: str = "zh-CN"
    role: str = "team"
    approvalMode: str = "review_required"
    source: IntentSource = "chat"
    entryHint: IntentEntryHint | None = None
    currentSelection: IntentSelectionContext = Field(default_factory=IntentSelectionContext)
    requestedTarget: ResolvedIntentTarget | None = None
    conversationState: IntentConversationState = Field(default_factory=IntentConversationState)


class IntentPreflight(BaseModel):
    source: IntentSource
    forceChatOnly: bool
    pendingClarification: PendingClarificationRef | None = None
    pendingApprovalNotice: bool = False
    reasonCodes: list[str] = Field(default_factory=list)


class IntentTargetRef(BaseModel):
    kind: Literal["novel", "volume", "chapter", "chapter_scope", "selection", "conversation"]
    source: Literal["explicit_id", "current_selection", "conversation_reference"]
    id: str | None = None
    ids: list[str] = Field(default_factory=list)
    selector: str | None = None
    volumeId: str | None = None
    title: str | None = None
    label: str | None = None
    wordCount: int | None = Field(default=None, ge=0)
    hasContent: bool | None = None


class IntentOperation(BaseModel):
    type: str
    target: IntentTargetRef
    suggestedToolchainId: str | None = None
    suggestedToolchainVersion: str | None = None
    requestedEffect: IntentEffect
    confidence: float = Field(ge=0, le=1)


class RetryFailedRunAction(BaseModel):
    failedRunId: str
    expectedFailureRevision: int = Field(ge=1)
    mode: Literal["failed_node"] = "failed_node"


class IntentSkillRequest(BaseModel):
    skillId: str
    requestedRevisionId: str | None = None
    selectionSource: Literal["explicit", "shortcut", "preset", "semantic"]


class IntentDecision(BaseModel):
    interaction: Literal["conversation", "task", "clarification_response"]
    route: Literal["respond", "clarify", "plan", "retry_failed_run"]
    operations: list[IntentOperation] = Field(default_factory=list)
    deliverable: IntentDeliverable = "none"
    contextNeeds: list[str] = Field(default_factory=list)
    missingUserDecisions: list[str] = Field(default_factory=list)
    suggestedRole: str | None = None
    requestedEffect: IntentEffect = "none"
    needsClarification: bool = False
    confidence: float = Field(default=0.5, ge=0, le=1)
    reasonCodes: list[str] = Field(default_factory=list)
    responseContent: str
    explorationPerformed: bool = False
    recovery: RetryFailedRunAction | None = None
    requestedSkills: list[IntentSkillRequest] = Field(default_factory=list, max_length=2)
    disabledSkillsForTurn: bool = False
