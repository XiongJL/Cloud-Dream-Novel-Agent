from __future__ import annotations

STYLE_SKILL_MEMBER_PATHS = {
    "language_style": "language-style/SKILL.md", "suspense_release": "suspense-release/SKILL.md",
    "ensemble_progression": "ensemble-progression/SKILL.md",
}

from typing import Any, Literal
import json
import re

from pydantic import BaseModel, Field, model_validator

from .registry import AgentSkillRegistration, AgentSkillRegistry
from .schemas import AgentSkillDefinition, AgentSkillIndexEntry, AgentSkillRevision


def style_skill_body(document: str) -> str:
    """Extract prose without trusting model-authored technical metadata."""
    text = document.strip().removeprefix("\ufeff").replace("\r\n", "\n")
    fenced = re.fullmatch(r"```(?:markdown|md)?\s*\n([\s\S]*?)\n```", text, re.I)
    if fenced:
        text = fenced[1].strip()
    if text.startswith("---\n") and re.search(r"(?m)^(schemaVersion|stableId|scope|skillType):", text):
        closed = re.match(r"^---\n[\s\S]*?\n---\s*\n", text)
        if closed:
            text = text[closed.end():].strip()
        else:
            heading = re.search(r"(?m)^#{1,6}\s+\S", text)
            if not heading:
                raise ValueError("Style Skill technical header is incomplete and no body can be recovered")
            text = text[heading.start():].strip()
    if not text or len(text) > 32000:
        raise ValueError("Style Skill body must contain 1 to 32000 characters")
    return text


def style_skill_member_document(member: Any, body: str, scope: str, novel_id: str | None = None) -> str:
    """The product owns identity, capabilities and file framing; the model owns prose."""
    if scope not in {"user", "novel"} or (scope == "novel" and not novel_id):
        raise ValueError("Invalid Style Skill scope")
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    description = f"用于{member.title}相关的写作、修订或诊断；按目标场景与用户约束应用正文中的条件化方法，证据强度及降级边界见正文。"
    lines = ["---", "schemaVersion: novel-editor.agent-skill.v1", f"stableId: {quote(member.stableIdCandidate)}",
        "version: 1.0.0", f"name: {quote(member.title)}", f"description: {quote(description)}", f"scope: {scope}"]
    if novel_id and scope == "novel":
        lines.append(f"ownerNovelId: {quote(novel_id)}")
    lines += ["skillType: prompt_method", f"category: {'style' if member.draftKey == 'language_style' else 'narrative_method'}",
        f"guidanceMode: {member.guidanceMode}", "semanticSelection: suggest"]
    for key in ("triggerHints", "antiTriggerHints", "supportedOperations", "allowedRoles"):
        lines += [f"{key}:"] + [f"  - {quote(value)}" for value in getattr(member, key)]
    lines += ["outputType: none", "constraints:",
        "  - " + quote("遵循目标场景与用户约束；写作模式输出原创正文，诊断模式输出问题与建议。"),
        "  - " + quote("不得复制来源作品的专名、长句、人物、设定或情节；未核验的方法不得伪称来源规律。"),
        "---", "", style_skill_body(body), ""]
    document = "\n".join(lines)
    if len(document.encode("utf-8")) > 32 * 1024:
        raise ValueError("Style Skill document exceeds the 32 KiB workspace limit")
    return document


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


class AgentSkillReviseRequest(BaseModel):
    draftId: str = Field(min_length=1, max_length=128)
    expectedVersion: int = Field(ge=1)
    goal: str = Field(min_length=1, max_length=12_000)
    logicalPath: str = Field(default="SKILL.md", min_length=1, max_length=256)
    novelId: str | None = None
    locale: str = "zh-CN"


def definition_from_persisted(row: dict[str, Any], manifest: dict[str, Any]) -> AgentSkillDefinition:
    return AgentSkillDefinition(
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


def index_from_persisted(row: dict[str, Any]) -> AgentSkillIndexEntry:
    manifest = row.get("manifest") if isinstance(row.get("manifest"), dict) else {}
    definition = definition_from_persisted(row, manifest)
    AgentSkillRegistry.validate_definition(definition)
    version = str(row.get("version") or "")
    revision_id = str(row.get("revisionId") or "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not revision_id:
        raise ValueError("Skill catalog revision is invalid")
    return AgentSkillIndexEntry(**{
        key: value for key, value in definition.model_dump().items()
        if key in AgentSkillIndexEntry.model_fields
    }, version=version, revisionId=revision_id)


def registration_from_persisted(value: Any) -> AgentSkillRegistration:
    row = value if isinstance(value, dict) else {}
    revision = row.get("revision") if isinstance(row.get("revision"), dict) else {}
    manifest = revision.get("manifest") if isinstance(revision.get("manifest"), dict) else {}
    definition = definition_from_persisted(row, manifest)
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
