from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


ToolchainErrorCode = Literal[
    "TOOLCHAIN_NOT_FOUND",
    "VERSION_UNAVAILABLE",
    "TOOLCHAIN_DISABLED",
    "INPUT_INVALID",
    "ROLE_NOT_ALLOWED",
    "TOOL_NOT_ALLOWED",
    "BUDGET_EXCEEDED",
    "CONTEXT_INSUFFICIENT",
    "NODE_FAILED",
    "MODEL_OUTPUT_INVALID",
    "SIDE_EFFECT_UNKNOWN",
    "CANCELLED",
]


class ToolchainError(RuntimeError):
    def __init__(
        self,
        code: ToolchainErrorCode,
        message: str,
        *,
        node_id: str | None = None,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.node_id = node_id
        self.retryable = retryable
        self.details = details or {}

    def payload(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": str(self),
            "nodeId": self.node_id,
            "retryable": self.retryable,
            "details": self.details,
        }


class ToolchainBudget(BaseModel):
    maxToolCalls: int = Field(default=10, ge=1, le=100)
    maxModelCalls: int = Field(default=2, ge=0, le=32)
    maxEstimatedTokens: int = Field(default=24000, ge=1000, le=200000)
    timeoutSeconds: int = Field(default=180, ge=5, le=1800)


class ToolchainInvocation(BaseModel):
    id: str
    version: str
    input: dict[str, Any] = Field(default_factory=dict)


class ChapterContextInput(BaseModel):
    novelId: str = Field(min_length=1)
    chapterId: str = Field(min_length=1)
    volumeId: str | None = None
    goal: str = Field(min_length=1)
    locale: str = "zh-CN"
    includeAdjacent: int = Field(default=1, ge=0, le=3)
    maxEstimatedTokens: int | None = Field(default=None, ge=1000, le=200000)


class ChapterConsistencyReviewInput(ChapterContextInput):
    dimensions: list[str] = Field(
        default_factory=lambda: ["character", "plot_timeline", "world", "location_item_skill"]
    )


class ChapterContinuationInput(ChapterContextInput):
    currentContent: str = ""
    contextChapterCount: int = Field(default=8, ge=1, le=20)
    recentRawChapterCount: int = Field(default=2, ge=1, le=3)
    targetLength: int | None = Field(default=None, ge=100, le=50000)
    style: str = ""
    tone: str = ""
    pace: str = ""


ChapterScopeKind = Literal[
    "current_chapter",
    "selected_chapters",
    "chapter_range",
    "current_volume",
    "novel",
]


class ChapterScopeContextInput(BaseModel):
    scopeId: str | None = None
    novelId: str = Field(min_length=1)
    kind: ChapterScopeKind = "current_chapter"
    volumeId: str | None = None
    chapterId: str | None = None
    chapterIds: list[str] = Field(default_factory=list)
    anchorChapterId: str | None = None
    processingMode: Literal["detailed", "batched"] = "detailed"
    currentContent: str = ""
    goal: str = Field(min_length=1)
    locale: str = "zh-CN"
    batchSize: int = Field(default=4, ge=1, le=10)
    maxDetailedChapters: int = Field(default=20, ge=1, le=20)
    maxEstimatedTokens: int | None = Field(default=None, ge=4000, le=200000)

    @model_validator(mode="after")
    def normalize_scope_targets(self) -> "ChapterScopeContextInput":
        ordered_ids = list(dict.fromkeys(item.strip() for item in self.chapterIds if item.strip()))
        if (
            self.kind == "current_chapter"
            and self.chapterId
            and self.chapterId.strip()
            and self.chapterId.strip() not in ordered_ids
        ):
            ordered_ids.append(self.chapterId.strip())
        self.chapterIds = ordered_ids
        if not self.anchorChapterId:
            if self.kind == "current_chapter" and self.chapterId:
                self.anchorChapterId = self.chapterId
            elif self.chapterIds:
                self.anchorChapterId = self.chapterIds[-1]
        if self.kind == "current_chapter" and not self.anchorChapterId:
            raise ValueError("anchorChapterId or chapterId is required for current_chapter")
        if self.kind == "selected_chapters" and not self.chapterIds:
            raise ValueError("chapterIds is required for selected_chapters")
        if self.kind == "chapter_range" and len(self.chapterIds) < 2:
            raise ValueError("chapter_range requires at least two chapterIds")
        if self.kind == "current_volume" and not self.volumeId:
            raise ValueError("volumeId is required for current_volume")
        return self


class StyleSkillExtractionInput(BaseModel):
    """Input for the style extractor from either project samples or a named work."""
    sourceMode: Literal["project_chapter_scope", "named_work_model_prior"] = "project_chapter_scope"
    sourceWorkTitle: str | None = Field(default=None, max_length=300)
    scopeId: str | None = None
    novelId: str | None = None
    kind: ChapterScopeKind = "current_chapter"
    volumeId: str | None = None
    chapterId: str | None = None
    chapterIds: list[str] = Field(default_factory=list)
    anchorChapterId: str | None = None
    processingMode: Literal["detailed", "batched"] = "detailed"
    currentContent: str = ""
    goal: str = Field(min_length=1)
    locale: str = "zh-CN"
    batchSize: int = Field(default=4, ge=1, le=10)
    maxDetailedChapters: int = Field(default=20, ge=1, le=20)
    maxEstimatedTokens: int | None = Field(default=None, ge=4000, le=200000)

    @model_validator(mode="after")
    def validate_source(self) -> "StyleSkillExtractionInput":
        if self.sourceMode == "named_work_model_prior":
            if not (self.sourceWorkTitle or "").strip():
                raise ValueError("sourceWorkTitle is required for named_work_model_prior")
            self.novelId = self.novelId.strip() if isinstance(self.novelId, str) and self.novelId.strip() else None
            return self
        scope = ChapterScopeContextInput.model_validate({
            "scopeId": self.scopeId,
            "novelId": self.novelId,
            "kind": self.kind,
            "volumeId": self.volumeId,
            "chapterId": self.chapterId,
            "chapterIds": self.chapterIds,
            "anchorChapterId": self.anchorChapterId,
            "processingMode": self.processingMode,
            "currentContent": self.currentContent,
            "goal": self.goal,
            "locale": self.locale,
            "batchSize": self.batchSize,
            "maxDetailedChapters": self.maxDetailedChapters,
            "maxEstimatedTokens": self.maxEstimatedTokens,
        })
        for field_name, value in scope.model_dump().items():
            setattr(self, field_name, value)
        return self


class CreativeAssetDraftInput(BaseModel):
    novelId: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    brief: str = ""
    locale: str = "zh-CN"
    targetSections: list[str] = Field(default_factory=list)
    includeExistingEntities: bool = True
    filterCompletedPlotLines: bool = True
    maxEstimatedTokens: int | None = Field(default=None, ge=1000, le=200000)


class NovelBootstrapInput(BaseModel):
    goal: str = Field(min_length=1)
    locale: str = "zh-CN"
    userDecisions: dict[str, Any] = Field(default_factory=dict)
    maxEstimatedTokens: int | None = Field(default=None, ge=1000, le=200000)


class NovelBootstrapCharacter(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    role: str = Field(min_length=1, max_length=200)
    desire: str = Field(min_length=1, max_length=500)
    cost: str = Field(min_length=1, max_length=500)
    change: str = Field(min_length=1, max_length=500)


class NovelBootstrapVolumePlan(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    dramaticQuestion: str = Field(min_length=1, max_length=500)
    turningPoint: str = Field(min_length=1, max_length=500)
    chapterRange: str = Field(min_length=1, max_length=80)


class NovelBootstrapChapterPlan(BaseModel):
    chapterNumber: int = Field(ge=1, le=999)
    title: str = Field(min_length=1, max_length=160)
    sceneGoal: str = Field(min_length=1, max_length=500)
    conflict: str = Field(min_length=1, max_length=500)
    hook: str = Field(min_length=1, max_length=500)


class NovelBootstrapDraft(BaseModel):
    titleCandidates: list[str] = Field(min_length=1, max_length=5)
    genrePromise: str = Field(min_length=1, max_length=1000)
    readerPromise: str = Field(min_length=1, max_length=1000)
    corePremise: str = Field(min_length=1, max_length=2000)
    centralQuestion: str = Field(min_length=1, max_length=1000)
    narrativeShape: str = Field(min_length=1, max_length=1000)
    characters: list[NovelBootstrapCharacter] = Field(min_length=1, max_length=12)
    worldRules: list[str] = Field(default_factory=list, max_length=20)
    conflictEscalation: list[str] = Field(min_length=3, max_length=12)
    suspenseStrategy: list[str] = Field(min_length=1, max_length=12)
    openingBeats: list[str] = Field(min_length=3, max_length=12)
    volumePlan: list[NovelBootstrapVolumePlan] = Field(min_length=1, max_length=6)
    chapterPlan: list[NovelBootstrapChapterPlan] = Field(min_length=3, max_length=24)
    writingModeRecommendation: str = Field(min_length=1, max_length=500)
    targetChapterCount: int = Field(ge=3, le=999)
    targetWordsPerChapter: int = Field(ge=500, le=20000)
    validationChecklist: list[str] = Field(min_length=3, max_length=12)
    userDecisionSummary: str = Field(min_length=1, max_length=2000)
    assumptions: list[str] = Field(default_factory=list, max_length=20)
    warnings: list[str] = Field(default_factory=list, max_length=20)


class NovelProjectInitializeInput(BaseModel):
    """Initialize the active novel from an explicitly approved bootstrap draft."""

    novelId: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    locale: str = "zh-CN"
    bootstrapArtifactId: str = Field(min_length=1)
    bootstrapDraft: NovelBootstrapDraft
    targetSections: list[str] = Field(
        default_factory=lambda: [
            "plotLines",
            "plotPoints",
            "characters",
            "items",
            "skills",
            "worldSettings",
            "maps",
        ]
    )
    maxEstimatedTokens: int | None = Field(default=None, ge=1000, le=200000)


class StyleSkillDraftPreview(BaseModel):
    draftKey: Literal["language_style", "suspense_release", "ensemble_progression"]
    stableIdCandidate: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1000)
    guidanceMode: Literal["adaptive", "guided", "strict"] = "guided"
    confidence: Literal["low", "medium", "high"]
    triggerHints: list[str] = Field(min_length=1, max_length=8)
    antiTriggerHints: list[str] = Field(min_length=1, max_length=8)
    supportedOperations: list[str] = Field(min_length=1, max_length=8)
    instructions: str = Field(min_length=1, max_length=12000)
    constraints: list[str] = Field(min_length=1, max_length=20)
    evidenceNotes: list[str] = Field(default_factory=list, max_length=20)
    contaminationWarnings: list[str] = Field(default_factory=list, max_length=20)
    evaluationPrompt: str = Field(min_length=1, max_length=2000)


class StyleSkillPackBindingPreview(BaseModel):
    operationId: str = Field(min_length=1, max_length=120)
    roleId: str = Field(min_length=1, max_length=80)
    primaryDraftKey: str = Field(min_length=1, max_length=80)
    auxiliaryDraftKey: str | None = Field(default=None, max_length=80)


class StyleSkillPackPreview(BaseModel):
    stableIdCandidate: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1000)
    bindings: list[StyleSkillPackBindingPreview] = Field(min_length=1, max_length=20)


class StyleSkillPackDraftArtifact(BaseModel):
    summary: str = Field(min_length=1, max_length=2000)
    sourceCoverage: dict[str, Any] = Field(default_factory=dict)
    skills: list[StyleSkillDraftPreview] = Field(min_length=2, max_length=3)
    pack: StyleSkillPackPreview
    omittedDimensions: list[str] = Field(default_factory=list, max_length=10)
    warnings: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_dimensions_and_bindings(self) -> "StyleSkillPackDraftArtifact":
        keys = [item.draftKey for item in self.skills]
        if len(keys) != len(set(keys)):
            raise ValueError("Style Skill draft keys must be unique")
        if "language_style" not in keys or "suspense_release" not in keys:
            raise ValueError("Style extraction requires language_style and suspense_release drafts")
        known = set(keys)
        for binding in self.pack.bindings:
            if binding.primaryDraftKey not in known or (
                binding.auxiliaryDraftKey and binding.auxiliaryDraftKey not in known
            ):
                raise ValueError("Skill Pack binding references an unknown draft key")
        return self


class ContextEvidence(BaseModel):
    sourceType: str
    sourceId: str | None = None
    title: str = ""
    excerpt: str = ""
    confidence: float | None = Field(default=None, ge=0, le=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ContextOmission(BaseModel):
    sourceType: str
    reason: str


class ContextBundle(BaseModel):
    chapter: dict[str, Any]
    adjacentChapters: list[dict[str, Any]] = Field(default_factory=list)
    plotlines: list[dict[str, Any]] = Field(default_factory=list)
    characters: list[dict[str, Any]] = Field(default_factory=list)
    worldSettings: list[dict[str, Any]] = Field(default_factory=list)
    items: list[dict[str, Any]] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    omitted: list[ContextOmission] = Field(default_factory=list)
    toolCallCount: int = 0
    estimatedTokens: int = 0
    sourceStatus: dict[str, str] = Field(default_factory=dict)


class AgentChapterSnapshot(BaseModel):
    chapterId: str
    version: int = 1
    contentHash: str
    updatedAt: str
    source: Literal["database", "editor_buffer"] = "database"


class AgentChapterScope(BaseModel):
    scopeId: str
    novelId: str
    kind: ChapterScopeKind
    volumeId: str | None = None
    chapterIds: list[str] = Field(default_factory=list)
    anchorChapterId: str | None = None
    processingMode: Literal["detailed", "batched"]
    snapshot: list[AgentChapterSnapshot] = Field(default_factory=list)


class ChapterScopeContextItem(BaseModel):
    chapterId: str
    volumeId: str
    title: str = ""
    order: int = 0
    volumeOrder: int = 0
    version: int = 1
    updatedAt: str
    contentHash: str
    contentMode: Literal["full", "truncated", "summary", "excerpt"]
    content: str = ""
    summaryId: str | None = None
    summaryFresh: bool = False
    target: bool = True


class ChapterScopeCoverage(BaseModel):
    totalChapterCount: int = 0
    contextChapterCount: int = 0
    readonlyChapterCount: int = 0
    detailedChapterCount: int = 0
    summarizedChapterCount: int = 0
    excerptChapterCount: int = 0
    omittedChapterCount: int = 0
    batchSize: int = 4
    batchCount: int = 0
    batches: list[dict[str, Any]] = Field(default_factory=list)


class NarrativeStateLedger(BaseModel):
    entities: dict[str, Any] = Field(default_factory=dict)
    timelineHints: list[Any] = Field(default_factory=list)
    openQuestions: list[Any] = Field(default_factory=list)
    unresolvedThreads: list[Any] = Field(default_factory=list)


class ChapterBeatInput(BaseModel):
    title: str = Field(min_length=1)
    chapterGoal: str = Field(min_length=1)
    coreConflict: str = Field(min_length=1)
    keyEvents: list[str] = Field(default_factory=list)
    reveals: list[str] = Field(default_factory=list)
    endingHook: str = Field(min_length=1)
    targetWordCount: int = Field(ge=100, le=50000)


class ChapterBeat(ChapterBeatInput):
    beatId: str = Field(min_length=1)
    childIndex: int = Field(ge=0, le=4)


class DraftBatchOutline(BaseModel):
    revision: int = Field(ge=1)
    status: Literal["draft", "approved"] = "draft"
    beats: list[ChapterBeat] = Field(min_length=1, max_length=5)
    approvedAt: str | None = None
    approvedBy: str | None = None


class DraftBatchSourceSnapshot(BaseModel):
    chapterId: str = Field(min_length=1)
    version: int = Field(ge=1)
    contentHash: str = Field(min_length=1)


class DraftBatchChildRecord(BaseModel):
    childIndex: int = Field(ge=0, le=4)
    title: str = Field(min_length=1)
    status: Literal[
        "pending",
        "generating",
        "draft",
        "stale",
        "failed",
        "committed",
        "discarded",
    ] = "pending"
    generationRevision: int = Field(default=1, ge=1)
    draftSessionId: str | None = None
    targetChapterId: str | None = None
    dependsOnChildIndex: int | None = Field(default=None, ge=0, le=4)
    sourceSnapshot: DraftBatchSourceSnapshot | None = None
    error: dict[str, Any] | None = None


class NarrativeCharacterLocationDelta(BaseModel):
    characterKey: str = Field(min_length=1, max_length=160)
    location: str = Field(min_length=1, max_length=300)
    evidenceExcerpt: str = Field(min_length=1, max_length=500)


class NarrativeRelationshipDelta(BaseModel):
    sourceCharacterKey: str = Field(min_length=1, max_length=160)
    targetCharacterKey: str = Field(min_length=1, max_length=160)
    change: str = Field(min_length=1, max_length=500)
    evidenceExcerpt: str = Field(min_length=1, max_length=500)


class NarrativeKnowledgeDelta(BaseModel):
    characterKey: str = Field(min_length=1, max_length=160)
    learned: list[str] = Field(default_factory=list, max_length=20)
    forgotten: list[str] = Field(default_factory=list, max_length=20)
    evidenceExcerpt: str = Field(min_length=1, max_length=500)


class NarrativeItemStateDelta(BaseModel):
    itemKey: str = Field(min_length=1, max_length=160)
    state: str = Field(min_length=1, max_length=500)
    holderKey: str | None = Field(default=None, max_length=160)
    location: str | None = Field(default=None, max_length=300)
    evidenceExcerpt: str = Field(min_length=1, max_length=500)


class NarrativeConflictDelta(BaseModel):
    conflict: str = Field(min_length=1, max_length=500)
    evidenceExcerpt: str = Field(min_length=1, max_length=500)


class NarrativeStateDelta(BaseModel):
    characterLocations: list[NarrativeCharacterLocationDelta] = Field(default_factory=list, max_length=30)
    relationshipChanges: list[NarrativeRelationshipDelta] = Field(default_factory=list, max_length=30)
    knowledgeChanges: list[NarrativeKnowledgeDelta] = Field(default_factory=list, max_length=30)
    itemStates: list[NarrativeItemStateDelta] = Field(default_factory=list, max_length=30)
    resolvedConflicts: list[NarrativeConflictDelta] = Field(default_factory=list, max_length=20)
    openedConflicts: list[NarrativeConflictDelta] = Field(default_factory=list, max_length=20)
    warnings: list[str] = Field(default_factory=list, max_length=20)


class NarrativeStateDeltaRecord(NarrativeStateDelta):
    childIndex: int = Field(ge=0, le=4)
    generationRevision: int = Field(ge=1)
    draftSessionId: str = Field(min_length=1)


class DraftBatchNarrativeStateLedger(BaseModel):
    characterLocations: dict[str, str] = Field(default_factory=dict)
    relationshipChanges: list[dict[str, Any]] = Field(default_factory=list)
    knowledgeState: dict[str, list[str]] = Field(default_factory=dict)
    foreshadowing: list[dict[str, Any]] = Field(default_factory=list)
    timeline: list[dict[str, Any]] = Field(default_factory=list)
    itemStates: dict[str, str] = Field(default_factory=dict)
    unresolvedConflicts: list[str] = Field(default_factory=list)
    stateDeltas: list[NarrativeStateDeltaRecord] = Field(default_factory=list)


class DraftBatchRecord(BaseModel):
    draftBatchId: str = Field(min_length=1)
    novelId: str = Field(min_length=1)
    volumeId: str = Field(min_length=1)
    anchorChapterId: str = Field(min_length=1)
    mode: Literal["sequence_continuation", "batch_rewrite"]
    insertionMode: Literal["after_anchor", "volume_end"] | None = None
    status: Literal[
        "outline_draft",
        "ready_to_generate",
        "generating",
        "ready_for_review",
        "partially_failed",
        "stale",
        "committed",
        "discarded",
        "failed",
    ]
    outline: DraftBatchOutline
    children: list[DraftBatchChildRecord] = Field(min_length=1, max_length=5)
    stateLedger: DraftBatchNarrativeStateLedger = Field(default_factory=DraftBatchNarrativeStateLedger)
    sourceSnapshot: list[DraftBatchSourceSnapshot] = Field(default_factory=list)
    runId: str | None = None
    linkedRunIds: list[str] = Field(default_factory=list)
    version: int = Field(ge=1)
    createdAt: str
    updatedAt: str

    @model_validator(mode="after")
    def validate_batch_alignment(self) -> "DraftBatchRecord":
        expected = list(range(len(self.outline.beats)))
        beat_indices = [beat.childIndex for beat in self.outline.beats]
        child_indices = [child.childIndex for child in self.children]
        if beat_indices != expected or child_indices != expected:
            raise ValueError("Draft batch beats and children must use ordered zero-based indices")
        if len(self.outline.beats) != len(self.children):
            raise ValueError("Draft batch beats and children must have the same length")
        return self


class ChapterSequenceContinuationInput(BaseModel):
    novelId: str = Field(min_length=1)
    volumeId: str = Field(min_length=1)
    chapterId: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    currentContent: str = ""
    locale: str = "zh-CN"
    chapterCount: int = Field(default=2, ge=1, le=5)
    beats: list[ChapterBeatInput] = Field(default_factory=list, max_length=5)
    insertionMode: Literal["after_anchor", "volume_end"] = "after_anchor"
    contextChapterCount: int = Field(default=8, ge=1, le=20)
    recentRawChapterCount: int = Field(default=2, ge=1, le=3)
    style: str = ""
    tone: str = ""
    pace: str = ""
    resumeBatchId: str | None = None
    resumeBatchVersion: int | None = Field(default=None, ge=1)
    startChildIndex: int | None = Field(default=None, ge=0, le=4)

    @model_validator(mode="after")
    def validate_optional_beats(self) -> "ChapterSequenceContinuationInput":
        if self.beats and len(self.beats) != self.chapterCount:
            raise ValueError("beats must match chapterCount when supplied")
        if self.resumeBatchId and not self.beats:
            raise ValueError("resumeBatchId requires the approved batch beats")
        if self.resumeBatchId and self.resumeBatchVersion is None:
            raise ValueError("resumeBatchId requires resumeBatchVersion")
        if self.resumeBatchVersion is not None and not self.resumeBatchId:
            raise ValueError("resumeBatchVersion requires resumeBatchId")
        if self.startChildIndex is not None and not self.resumeBatchId:
            raise ValueError("startChildIndex requires resumeBatchId")
        return self


class ChapterBatchRewriteInput(ChapterSequenceContinuationInput):
    kind: Literal["current_chapter", "selected_chapters", "chapter_range"] = "selected_chapters"
    chapterIds: list[str] = Field(min_length=1, max_length=5)
    scopeId: str | None = None
    processingMode: Literal["detailed", "batched"] = "detailed"

    @model_validator(mode="after")
    def validate_rewrite_targets(self) -> "ChapterBatchRewriteInput":
        chapter_ids = list(dict.fromkeys(item.strip() for item in self.chapterIds if item.strip()))
        if not chapter_ids:
            raise ValueError("chapterIds is required for batch rewrite")
        if len(chapter_ids) > 5:
            raise ValueError("batch rewrite supports at most five chapters")
        self.chapterIds = chapter_ids
        self.chapterCount = len(chapter_ids)
        if not self.chapterId:
            self.chapterId = chapter_ids[0]
        if self.chapterId not in chapter_ids:
            self.chapterId = chapter_ids[0]
        if self.beats and len(self.beats) != len(chapter_ids):
            raise ValueError("beats must match chapterIds for batch rewrite")
        return self


class ChapterDraftBatchResult(BaseModel):
    draftBatchId: str = Field(min_length=1)
    status: str
    outlineRevision: int = Field(ge=1)
    draftSessionIds: list[str] = Field(default_factory=list, max_length=5)
    generatedCount: int = Field(ge=0, le=5)
    totalCount: int = Field(ge=1, le=5)
    artifactId: str = Field(min_length=1)
    warnings: list[str] = Field(default_factory=list)


class ChapterScopeBundle(BaseModel):
    scope: AgentChapterScope
    chapters: list[ChapterScopeContextItem] = Field(default_factory=list)
    narrativeSummaries: list[dict[str, Any]] = Field(default_factory=list)
    entityContext: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    plotContext: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    stateLedger: NarrativeStateLedger = Field(default_factory=NarrativeStateLedger)
    coverage: ChapterScopeCoverage
    sourceSnapshot: list[AgentChapterSnapshot] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    estimatedTokens: int = 0


class EditorRangeReviewInput(ChapterScopeContextInput):
    dimensions: list[str] = Field(
        default_factory=lambda: ["structure", "pacing", "motivation", "prose", "continuity"],
        max_length=12,
    )


class EditorRangeDimensionScore(BaseModel):
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    score: int | None = Field(default=None, ge=0, le=100)
    reason: str = ""
    checkable: bool = True


class EditorRangeFinding(BaseModel):
    findingId: str = Field(min_length=1)
    title: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    category: str = Field(min_length=1)
    severity: Literal["critical", "high", "medium", "low", "info"]
    chapterIds: list[str] = Field(default_factory=list)
    evidenceRefs: list[str] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    recommendation: str = ""
    recommendedRole: Literal["writer", "editor", "worldbuilding", "research_rag"] = "writer"
    uncertainty: str = ""

    @model_validator(mode="after")
    def require_uncertainty_without_evidence(self) -> "EditorRangeFinding":
        if not self.evidence and not self.evidenceRefs and not self.uncertainty.strip():
            self.uncertainty = "当前范围内缺少直接证据，需人工确认。"
        return self


class EditorRangeReviewArtifact(BaseModel):
    overallScore: int | None = Field(default=None, ge=0, le=100)
    summary: str = Field(min_length=1)
    dimensions: list[EditorRangeDimensionScore] = Field(default_factory=list)
    findings: list[EditorRangeFinding] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    coverage: ChapterScopeCoverage | None = None


class WriterRangeRevisionPlanInput(ChapterScopeContextInput):
    dimensions: list[str] = Field(
        default_factory=lambda: ["style_drift", "scene_strength", "rewrite_priority", "continuation_readiness"],
        max_length=12,
    )


class WriterRangeRevisionPlanArtifact(BaseModel):
    overallScore: int | None = Field(default=None, ge=0, le=100)
    summary: str = Field(min_length=1)
    dimensions: list[EditorRangeDimensionScore] = Field(default_factory=list)
    findings: list[EditorRangeFinding] = Field(default_factory=list)
    rewriteOrder: list[str] = Field(default_factory=list)
    continuationReadiness: str = ""
    recommendations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    coverage: ChapterScopeCoverage | None = None


class ReaderJourneyReviewInput(ChapterScopeContextInput):
    pass


class ReaderJourneyFinding(BaseModel):
    findingId: str = Field(min_length=1)
    title: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    category: Literal["confusion", "emotion", "suspense", "immersion", "drop_risk", "retention", "other"]
    severity: Literal["critical", "high", "medium", "low", "info"]
    chapterIds: list[str] = Field(default_factory=list)
    evidenceRefs: list[str] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    recommendation: str = ""
    recommendedRole: Literal["writer", "editor"] = "writer"
    uncertainty: str = ""


class ReaderChapterEvaluation(BaseModel):
    chapterId: str = Field(min_length=1)
    chapterTitle: str = ""
    scoreScale: Literal[100]
    clarityScore: int = Field(ge=0, le=100)
    emotionalIntensity: int = Field(ge=0, le=100)
    suspenseScore: int = Field(ge=0, le=100)
    retentionScore: int = Field(ge=0, le=100)
    dominantEmotion: str = ""
    confusionPoints: list[str] = Field(default_factory=list, max_length=12)
    immersionBreaks: list[str] = Field(default_factory=list, max_length=12)
    effectiveHooks: list[str] = Field(default_factory=list, max_length=12)
    expectations: list[str] = Field(default_factory=list, max_length=12)
    dropRisk: Literal["low", "medium", "high"] = "low"
    summary: str = Field(min_length=1)
    readerStateSummary: str = Field(min_length=1, max_length=2000)
    findings: list[ReaderJourneyFinding] = Field(default_factory=list, max_length=4)
    warnings: list[str] = Field(default_factory=list)


class ReaderJourneyArtifact(BaseModel):
    overallRetentionScore: int | None = Field(default=None, ge=0, le=100)
    summary: str = Field(min_length=1)
    chapters: list[ReaderChapterEvaluation] = Field(default_factory=list)
    findings: list[ReaderJourneyFinding] = Field(default_factory=list)
    trends: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    coverage: ChapterScopeCoverage | None = None


class WorldbuildingRangeConsistencyInput(ChapterScopeContextInput):
    dimensions: list[str] = Field(default_factory=lambda: [
        "rules",
        "terminology",
        "abilities",
        "locations",
        "items",
        "state_drift",
    ], max_length=12)


class WorldbuildingConsistencyFinding(BaseModel):
    findingId: str = Field(min_length=1)
    title: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    category: Literal[
        "rule_conflict",
        "terminology",
        "ability",
        "location",
        "item",
        "state_drift",
        "chronology",
        "other",
    ]
    severity: Literal["critical", "high", "medium", "low", "info"]
    chapterIds: list[str] = Field(default_factory=list)
    subjectIds: list[str] = Field(default_factory=list)
    evidenceRefs: list[str] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    recommendation: str = ""
    recommendedRole: Literal["writer", "editor", "worldbuilding"] = "worldbuilding"
    uncertainty: str = ""


class WorldbuildingEntityAssessment(BaseModel):
    entityType: Literal["worldsetting", "character", "item", "map", "term", "other"]
    entityId: str | None = None
    name: str = Field(min_length=1)
    status: Literal["consistent", "conflict", "insufficient"] = "insufficient"
    chapterIds: list[str] = Field(default_factory=list)
    summary: str = ""
    evidence: list[ContextEvidence] = Field(default_factory=list)
    uncertainty: str = ""


class WorldbuildingConsistencyArtifact(BaseModel):
    consistencyScore: int | None = Field(default=None, ge=0, le=100)
    summary: str = Field(min_length=1)
    dimensions: list[EditorRangeDimensionScore] = Field(default_factory=list)
    findings: list[WorldbuildingConsistencyFinding] = Field(default_factory=list)
    entityAssessments: list[WorldbuildingEntityAssessment] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    coverage: ChapterScopeCoverage | None = None


ResearchClaimCategory = Literal[
    "historical",
    "scientific",
    "medical",
    "legal",
    "technical",
    "geographic",
    "cultural",
    "economic",
    "other",
]


class ResearchRangeFactCheckInput(ChapterScopeContextInput):
    maxClaims: int = Field(default=8, ge=1, le=12)
    maxProjectSearches: int = Field(default=5, ge=0, le=8)


class ResearchExtractedClaim(BaseModel):
    claimId: str = Field(min_length=1)
    statement: str = Field(min_length=1, max_length=1000)
    chapterId: str = Field(min_length=1)
    excerpt: str = Field(default="", max_length=2000)
    category: ResearchClaimCategory = "other"
    importance: Literal["high", "medium", "low"] = "medium"
    searchKeyword: str = Field(default="", max_length=200)
    needsProjectSearch: bool = True
    requiresExternalEvidence: bool = False


class ResearchClaimExtraction(BaseModel):
    claims: list[ResearchExtractedClaim] = Field(default_factory=list, max_length=12)
    warnings: list[str] = Field(default_factory=list)


class ResearchFactCheckFinding(BaseModel):
    findingId: str = Field(min_length=1)
    claimId: str = Field(min_length=1)
    statement: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    verdict: Literal["supported", "contradicted", "mixed", "unverified", "not_applicable"]
    confidence: float = Field(default=0, ge=0, le=1)
    category: ResearchClaimCategory = "other"
    severity: Literal["critical", "high", "medium", "low", "info"]
    chapterIds: list[str] = Field(default_factory=list)
    evidenceRefs: list[str] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    recommendation: str = ""
    recommendedRole: Literal["writer", "editor", "research_rag"] = "research_rag"
    uncertainty: str = ""


class ResearchFactCheckArtifact(BaseModel):
    overallReliabilityScore: int | None = Field(default=None, ge=0, le=100)
    summary: str = Field(min_length=1)
    claims: list[ResearchExtractedClaim] = Field(default_factory=list)
    findings: list[ResearchFactCheckFinding] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    coverage: ChapterScopeCoverage | None = None
    searchStats: dict[str, int] = Field(default_factory=dict)


ScopeAuditExpertId = Literal["editor", "reader", "worldbuilding", "research_rag"]


class ScopeAuditInput(ChapterScopeContextInput):
    experts: list[ScopeAuditExpertId] = Field(
        default_factory=lambda: ["editor", "reader", "worldbuilding"],
        min_length=1,
        max_length=4,
    )
    maxConcurrency: int = Field(default=2, ge=1, le=2)
    researchMaxClaims: int = Field(default=8, ge=1, le=12)
    researchMaxProjectSearches: int = Field(default=5, ge=0, le=8)

    @model_validator(mode="after")
    def normalize_experts(self) -> "ScopeAuditInput":
        self.experts = list(dict.fromkeys(self.experts))
        return self


class ScopeAuditExpertRef(BaseModel):
    expert: ScopeAuditExpertId
    artifactId: str = Field(min_length=1)
    artifactType: Literal[
        "chapter_range_review",
        "reader_journey",
        "worldbuilding_consistency",
        "research_fact_check",
    ]
    summary: str = ""
    findingCount: int = Field(default=0, ge=0)


class ScopeAuditFinding(BaseModel):
    findingId: str = Field(min_length=1)
    title: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    category: str = Field(min_length=1)
    severity: Literal["critical", "high", "medium", "low", "info"]
    chapterIds: list[str] = Field(default_factory=list)
    sourceFindingIds: list[str] = Field(default_factory=list)
    sourceExperts: list[ScopeAuditExpertId] = Field(default_factory=list)
    relationship: Literal["consensus", "single", "conflict"] = "single"
    evidenceRefs: list[str] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    recommendation: str = ""
    recommendedRole: Literal["writer", "editor", "worldbuilding", "research_rag"] = "editor"
    uncertainty: str = ""


class ScopeAuditConflict(BaseModel):
    conflictId: str = Field(min_length=1)
    topic: str = Field(min_length=1)
    sourceFindingIds: list[str] = Field(default_factory=list)
    experts: list[ScopeAuditExpertId] = Field(default_factory=list)
    summary: str = Field(min_length=1)
    resolution: str = ""


class ScopeAuditArtifact(BaseModel):
    summary: str = Field(min_length=1)
    experts: list[ScopeAuditExpertRef] = Field(default_factory=list)
    findings: list[ScopeAuditFinding] = Field(default_factory=list)
    conflicts: list[ScopeAuditConflict] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    coverage: ChapterScopeCoverage | None = None


class CreativeAssetConflict(BaseModel):
    kind: str
    name: str
    sources: list[str] = Field(default_factory=list)
    severity: Literal["warning", "error"] = "warning"
    message: str


class CreativeAssetContext(BaseModel):
    plotlines: list[dict[str, Any]] = Field(default_factory=list)
    characters: list[dict[str, Any]] = Field(default_factory=list)
    worldSettings: list[dict[str, Any]] = Field(default_factory=list)
    items: list[dict[str, Any]] = Field(default_factory=list)
    maps: list[dict[str, Any]] = Field(default_factory=list)
    conflicts: list[CreativeAssetConflict] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    toolCallCount: int = 0
    estimatedTokens: int = 0
    sourceStatus: dict[str, str] = Field(default_factory=dict)


class DraftSessionRef(BaseModel):
    draftSessionId: str = Field(min_length=1)
    draftBatchId: str | None = None
    childIndex: int | None = Field(default=None, ge=0, le=4)
    generationRevision: int | None = Field(default=None, ge=1)
    type: str = ""
    status: str = "draft"
    version: int | None = None
    previewSummary: str = ""


class DraftToolchainResult(BaseModel):
    draftSessionId: str = Field(min_length=1)
    draftType: str
    status: str = "draft"
    version: int | None = None
    previewSummary: str = ""
    artifactId: str
    validation: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)
    contextStats: dict[str, Any] = Field(default_factory=dict)


ReviewSeverity = Literal["critical", "high", "medium", "low", "info"]


PlotlineAnalysisScope = Literal["chapter", "volume", "novel"]


class PlotlineAnalysisInput(BaseModel):
    novelId: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    locale: str = "zh-CN"
    scope: PlotlineAnalysisScope | None = None
    volumeId: str | None = None
    chapterId: str | None = None
    batchSize: int = Field(default=4, ge=1, le=10)
    maxChapters: int = Field(default=80, ge=1, le=300)
    maxEstimatedTokens: int | None = Field(default=None, ge=4000, le=200000)


class PlotlineAnalysisContext(BaseModel):
    scope: PlotlineAnalysisScope
    plotlines: list[dict[str, Any]] = Field(default_factory=list)
    chapters: list[dict[str, Any]] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    coverage: dict[str, Any] = Field(default_factory=dict)
    toolCallCount: int = 0
    estimatedTokens: int = 0


class PlotlineThreadAssessment(BaseModel):
    plotlineId: str | None = None
    name: str
    role: Literal["main", "subplot", "unknown"] = "unknown"
    status: str = ""
    progressionScore: int | None = Field(default=None, ge=0, le=100)
    lastProgressLocation: str = ""
    coveredChapterIds: list[str] = Field(default_factory=list)
    findings: list[str] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    uncertainty: str = ""


class PlotlineAnalysisIssue(BaseModel):
    issueId: str
    type: Literal["stalled", "unresolved_foreshadowing", "pacing", "continuity", "coverage", "other"]
    severity: ReviewSeverity
    title: str
    plotlineIds: list[str] = Field(default_factory=list)
    chapterIds: list[str] = Field(default_factory=list)
    evidence: list[ContextEvidence] = Field(default_factory=list)
    recommendation: str = ""
    uncertainty: str = ""

    @model_validator(mode="after")
    def require_issue_uncertainty_without_evidence(self) -> "PlotlineAnalysisIssue":
        if not self.evidence and not self.uncertainty.strip():
            self.uncertainty = "当前覆盖资料不足，需人工确认。"
        return self


class PlotlineAnalysisArtifact(BaseModel):
    scope: PlotlineAnalysisScope
    overallScore: int | None = Field(default=None, ge=0, le=100)
    summary: str
    threads: list[PlotlineThreadAssessment] = Field(default_factory=list)
    issues: list[PlotlineAnalysisIssue] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    coverage: dict[str, Any] = Field(default_factory=dict)


class ReviewDimensionScore(BaseModel):
    id: str
    label: str
    score: int | None = Field(default=None, ge=0, le=100)
    reason: str = ""
    checkable: bool = True


class ReviewIssue(BaseModel):
    issueId: str
    type: str
    severity: ReviewSeverity
    title: str
    location: str = ""
    excerpt: str = ""
    evidence: list[ContextEvidence] = Field(default_factory=list)
    recommendation: str = ""
    uncertainty: str = ""

    @model_validator(mode="after")
    def require_uncertainty_without_evidence(self) -> "ReviewIssue":
        if not self.evidence and not self.uncertainty.strip():
            self.uncertainty = "当前资料不足，需人工确认。"
        return self


class ReviewArtifact(BaseModel):
    overallScore: int | None = Field(default=None, ge=0, le=100)
    summary: str
    dimensions: list[ReviewDimensionScore] = Field(default_factory=list)
    issues: list[ReviewIssue] = Field(default_factory=list)
    uncheckableDimensions: list[dict[str, str]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    contextStats: dict[str, Any] = Field(default_factory=dict)


def estimate_tokens(value: Any) -> int:
    """Cheap, deterministic estimate used only for enforcing the shared chain budget."""
    import json

    serialized = json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
    ascii_count = sum(1 for char in serialized if ord(char) < 128)
    non_ascii_count = len(serialized) - ascii_count
    return max(1, (ascii_count + 3) // 4 + non_ascii_count)
