from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


IntentSource = Literal["chat", "shortcut", "preset"]
IntentEffect = Literal["unknown", "none", "read_only", "draft_write", "data_write", "external"]
IntentDeliverable = Literal["none", "report", "expert_report", "chapter_draft", "chapter_draft_batch", "creative_assets_draft"]


class IntentSelectionContext(BaseModel):
    novelId: str | None = None
    volumeId: str | None = None
    chapterId: str | None = None
    selectedText: str | None = None


class PendingClarificationRef(BaseModel):
    questionId: str
    question: str
    originatingMessageId: str | None = None


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


class IntentEntryHint(BaseModel):
    actionId: str
    operationIds: list[str] = Field(default_factory=list)
    deliverable: IntentDeliverable | None = None
    suggestedToolchainId: str | None = None


class IntentRequest(BaseModel):
    message: str
    conversationId: str
    locale: str = "zh-CN"
    role: str = "team"
    approvalMode: str = "review_required"
    source: IntentSource = "chat"
    entryHint: IntentEntryHint | None = None
    currentSelection: IntentSelectionContext = Field(default_factory=IntentSelectionContext)
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
