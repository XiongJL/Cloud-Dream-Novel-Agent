from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

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
