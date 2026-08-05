from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from .errors import AgentSkillError
from .registry import AgentSkillRegistration
from .schemas import AgentSkillDefinition, AgentSkillRevision


class AgentSkillAuthorRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=12_000)
    scope: Literal["user", "novel"] = "user"
    novelId: str | None = None
    locale: str = "zh-CN"
    targetSkillId: str | None = None
    expectedCurrentRevisionId: str | None = None
    source: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_scope(self) -> "AgentSkillAuthorRequest":
        if self.scope == "novel" and not self.novelId:
            raise ValueError("novelId is required for novel-scoped skills")
        return self


class AgentSkillAuthorDefinitionDraft(BaseModel):
    stableId: str = Field(pattern=r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$", max_length=64)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1_000)
    category: Literal[
        "style", "narrative_method", "generation", "review",
        "character_voice", "novel_rules", "other",
    ] = "other"
    guidanceMode: Literal["adaptive", "guided", "strict"] = "guided"
    semanticSelection: Literal["off", "suggest", "auto"] = "suggest"
    triggerHints: list[str] = Field(min_length=1, max_length=8)
    antiTriggerHints: list[str] = Field(min_length=1, max_length=8)
    allowedRoles: list[str] = Field(default_factory=list, max_length=8)
    supportedOperations: list[str] = Field(min_length=1, max_length=12)
    recommendedToolchains: list[str] = Field(default_factory=list, max_length=8)
    contextNeeds: list[str] = Field(default_factory=list, max_length=12)
    outputType: Literal["none", "report", "chapter_draft", "creative_assets_draft"] = "none"


class AgentSkillAuthorRevisionDraft(BaseModel):
    version: str = Field(default="1.0.0", pattern=r"^\d+\.\d+\.\d+$")
    instructions: str = Field(min_length=1, max_length=32_000)
    constraints: list[str] = Field(min_length=1, max_length=24)
    examples: list[dict[str, Any]] = Field(default_factory=list, max_length=10)
    manifest: dict[str, Any] = Field(default_factory=dict)


class AgentSkillAuthorModelDraft(BaseModel):
    definition: AgentSkillAuthorDefinitionDraft
    revision: AgentSkillAuthorRevisionDraft
    rationale: list[str] = Field(default_factory=list, max_length=20)
    warnings: list[str] = Field(default_factory=list, max_length=20)

    def persistence_payload(self) -> dict[str, Any]:
        definition = self.definition.model_dump()
        revision = self.revision.model_dump()
        revision["manifest"] = {
            **revision.get("manifest", {}),
            **{key: definition[key] for key in (
                "category", "guidanceMode", "semanticSelection", "triggerHints",
                "antiTriggerHints", "allowedRoles", "supportedOperations",
                "recommendedToolchains", "contextNeeds", "outputType",
            )},
        }
        return {
            "definition": {
                "stableId": definition["stableId"],
                "title": definition["title"],
                "description": definition["description"],
            },
            "revision": revision,
            "rationale": self.rationale,
            "warnings": self.warnings,
        }


def normalize_authored_skill(value: Any) -> AgentSkillAuthorModelDraft:
    try:
        return AgentSkillAuthorModelDraft.model_validate(value)
    except Exception as error:
        raise AgentSkillError("AGENT_SKILL_AUTHOR_OUTPUT_INVALID", str(error)) from error


def style_pack_persistence_payload(value: Any) -> dict[str, Any]:
    """Convert an extracted style pack preview into the store's review draft shape."""
    from ..toolchains.schemas import StyleSkillPackDraftArtifact

    artifact = StyleSkillPackDraftArtifact.model_validate(value)
    skills = []
    for item in artifact.skills:
        skills.append({
            "draftKey": item.draftKey,
            "definition": {
                "stableId": item.stableIdCandidate,
                "title": item.title,
                "description": item.description,
            },
            "revision": {
                "version": "1.0.0",
                "manifest": {
                    "category": "style" if item.draftKey == "language_style" else "narrative_method",
                    "guidanceMode": item.guidanceMode,
                    "semanticSelection": "suggest",
                    "triggerHints": item.triggerHints,
                    "antiTriggerHints": item.antiTriggerHints,
                    "allowedRoles": ["team", "writer", "editor"],
                    "supportedOperations": item.supportedOperations,
                    "recommendedToolchains": [],
                    "contextNeeds": [],
                    "outputType": "none",
                    "confidence": item.confidence,
                    "evaluationPrompt": item.evaluationPrompt,
                },
                "instructions": item.instructions,
                "constraints": item.constraints,
                "examples": [],
            },
            "evidenceNotes": item.evidenceNotes,
            "contaminationWarnings": item.contaminationWarnings,
        })
    return {
        "kind": "skill_pack",
        "summary": artifact.summary,
        "skills": skills,
        "pack": {
            "definition": {
                "stableId": artifact.pack.stableIdCandidate,
                "title": artifact.pack.title,
                "description": artifact.pack.description,
            },
            "revision": {
                "version": "1.0.0",
                "bindings": [item.model_dump() for item in artifact.pack.bindings],
            },
        },
        "omittedDimensions": artifact.omittedDimensions,
        "warnings": artifact.warnings,
    }


def registration_from_persisted(value: Any) -> AgentSkillRegistration:
    row = value if isinstance(value, dict) else {}
    revision = row.get("revision") if isinstance(row.get("revision"), dict) else {}
    manifest = revision.get("manifest") if isinstance(revision.get("manifest"), dict) else {}
    definition = AgentSkillDefinition(
        id=str(row.get("id") or ""),
        stableId=str(row.get("stableId") or ""),
        title=str(row.get("title") or ""),
        description=str(row.get("description") or ""),
        scope=str(row.get("scope") or "user"),
        ownerNovelId=row.get("ownerNovelId"),
        category=manifest.get("category", "other"),
        origin=manifest.get("origin", "authored"),
        guidanceMode=manifest.get("guidanceMode", "guided"),
        semanticSelection=manifest.get("semanticSelection", "suggest"),
        triggerHints=tuple(manifest.get("triggerHints") or ()),
        antiTriggerHints=tuple(manifest.get("antiTriggerHints") or ()),
        allowedRoles=tuple(manifest.get("allowedRoles") or ()),
        supportedOperations=tuple(manifest.get("supportedOperations") or ()),
        recommendedToolchains=tuple(manifest.get("recommendedToolchains") or ()),
        requiredCapabilities=tuple(manifest.get("requiredCapabilities") or ()),
        contextNeeds=tuple(manifest.get("contextNeeds") or ()),
        outputType=manifest.get("outputType", "none"),
        enabled=bool(row.get("enabled", True)),
    )
    persisted_revision = AgentSkillRevision(
        skillId=definition.id,
        revisionId=str(revision.get("id") or ""),
        version=str(revision.get("version") or ""),
        instructions=str(revision.get("instructions") or ""),
        constraints=tuple(revision.get("constraints") or ()),
        examples=tuple(revision.get("examples") or ()),
        manifest=manifest,
        contentHash=str(revision.get("contentHash") or ""),
        createdAt=str(revision.get("createdAt") or ""),
    )
    return AgentSkillRegistration(
        definition=definition,
        revisions=(persisted_revision,),
        localized_titles={"zh": definition.title, "en": definition.title},
        localized_descriptions={"zh": definition.description, "en": definition.description},
    )
