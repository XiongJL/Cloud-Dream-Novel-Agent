from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


AgentSkillScope = Literal["builtin", "user", "novel"]
AgentSkillGuidanceMode = Literal["adaptive", "guided", "strict"]
AgentSkillSemanticSelection = Literal["off", "suggest", "auto"]
AgentSkillSelectionSource = Literal["explicit", "shortcut", "role", "preset", "semantic", "user", "novel", "builtin"]


class AgentSkillExample(BaseModel):
    input: str = Field(min_length=1, max_length=4_000)
    output: str = Field(min_length=1, max_length=8_000)
    note: str | None = Field(default=None, max_length=500)


class AgentSkillDefinition(BaseModel):
    id: str = Field(min_length=1)
    stableId: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1_000)
    scope: AgentSkillScope
    ownerNovelId: str | None = None
    skillType: Literal["prompt_method"] = "prompt_method"
    category: Literal[
        "style",
        "narrative_method",
        "generation",
        "review",
        "character_voice",
        "novel_rules",
        "other",
    ] = "other"
    origin: Literal["builtin", "authored", "derived", "imported"]
    guidanceMode: AgentSkillGuidanceMode = "guided"
    semanticSelection: AgentSkillSemanticSelection = "suggest"
    triggerHints: tuple[str, ...] = ()
    antiTriggerHints: tuple[str, ...] = ()
    allowedRoles: tuple[str, ...] = ()
    supportedOperations: tuple[str, ...] = Field(min_length=1)
    recommendedToolchains: tuple[str, ...] = ()
    requiredCapabilities: tuple[str, ...] = ()
    contextNeeds: tuple[str, ...] = ()
    outputType: Literal["none", "report", "chapter_draft", "creative_assets_draft"] = "none"
    enabled: bool = True

    @model_validator(mode="after")
    def validate_identity_and_selection(self) -> "AgentSkillDefinition":
        import re

        if not re.fullmatch(r"[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*", self.stableId):
            raise ValueError("stableId must use lowercase ASCII segments separated by dots or hyphens")
        if self.scope == "novel" and not self.ownerNovelId:
            raise ValueError("Novel-scoped skills require ownerNovelId")
        if self.scope != "novel" and self.ownerNovelId:
            raise ValueError("Only novel-scoped skills may set ownerNovelId")
        if self.semanticSelection == "auto" and (not self.triggerHints or not self.antiTriggerHints):
            raise ValueError("Auto semantic selection requires positive and negative trigger hints")
        return self


class AgentSkillRevision(BaseModel):
    skillId: str
    revisionId: str
    version: str
    instructions: str = Field(min_length=1, max_length=32_000)
    constraints: tuple[str, ...] = ()
    examples: tuple[AgentSkillExample, ...] = Field(default=(), max_length=10)
    manifest: dict[str, Any] = Field(default_factory=dict)
    contentHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    createdAt: str


class AgentSkillIndexEntry(BaseModel):
    id: str
    stableId: str
    title: str
    description: str
    scope: AgentSkillScope
    ownerNovelId: str | None = None
    category: str
    guidanceMode: AgentSkillGuidanceMode
    semanticSelection: AgentSkillSemanticSelection
    triggerHints: list[str] = Field(default_factory=list)
    antiTriggerHints: list[str] = Field(default_factory=list)
    allowedRoles: list[str] = Field(default_factory=list)
    supportedOperations: list[str] = Field(default_factory=list)
    version: str
    revisionId: str
    enabled: bool


class AgentSkillSelection(BaseModel):
    skillId: str
    requestedRevisionId: str | None = None
    selectionSource: Literal["explicit", "shortcut", "preset", "semantic"] = "explicit"


class AgentSkillResolveRequest(BaseModel):
    operationId: str
    roleId: str
    novelId: str | None = None
    explicitSkills: list[AgentSkillSelection] = Field(default_factory=list, max_length=2)
    operationDefaultSkillIds: list[str] = Field(default_factory=list)
    defaultSkillIds: list[str] = Field(default_factory=list)
    disabledForTurn: bool = False


class AgentSkillRef(BaseModel):
    skillId: str
    stableId: str
    revisionId: str
    version: str
    contentHash: str
    scope: AgentSkillScope
    selectionSource: AgentSkillSelectionSource
    position: Literal["primary", "auxiliary"]


class ResolvedSkillSet(BaseModel):
    primary: AgentSkillRef | None = None
    auxiliary: AgentSkillRef | None = None
    reasonCodes: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

    def refs(self) -> list[AgentSkillRef]:
        return [item for item in (self.primary, self.auxiliary) if item is not None]


class AgentSkillPromptSection(BaseModel):
    skill: AgentSkillRef
    prompt: str
    estimatedTokens: int = Field(ge=0)


class AgentSkillCompileResult(BaseModel):
    sections: list[AgentSkillPromptSection] = Field(default_factory=list)
    prompt: str = ""
    estimatedTokens: int = Field(default=0, ge=0)
    warnings: list[str] = Field(default_factory=list)
