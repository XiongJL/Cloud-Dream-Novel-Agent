from __future__ import annotations

from ..intent.operations import INTENT_OPERATION_REGISTRY
from ..roles import ALLOWED_ROLES
from .errors import AgentSkillError
from .registry import AgentSkillRegistry
from .schemas import (
    AgentSkillRef,
    AgentSkillResolveRequest,
    AgentSkillSelection,
    AgentSkillSelectionSource,
    ResolvedSkillSet,
)


class AgentSkillResolver:
    def __init__(self, registry: AgentSkillRegistry) -> None:
        self.registry = registry

    def resolve(self, request: AgentSkillResolveRequest) -> ResolvedSkillSet:
        if request.disabledForTurn:
            return ResolvedSkillSet(reasonCodes=["disabled_for_turn"])
        if request.roleId not in ALLOWED_ROLES:
            raise AgentSkillError("AGENT_SKILL_ROLE_NOT_ALLOWED", f"Unknown Agent role: {request.roleId}")
        if not INTENT_OPERATION_REGISTRY.has(request.operationId):
            raise AgentSkillError(
                "AGENT_SKILL_OPERATION_UNSUPPORTED",
                f"Unknown Intent Operation: {request.operationId}",
            )

        candidates: list[tuple[AgentSkillSelection, AgentSkillSelectionSource, bool]] = []
        candidates.extend((item, item.selectionSource, True) for item in request.explicitSkills)
        candidates.extend(
            (AgentSkillSelection(skillId=skill_id), "builtin", False)
            for skill_id in request.operationDefaultSkillIds
        )
        candidates.extend(
            (AgentSkillSelection(skillId=skill_id), "role", False)
            for skill_id in request.defaultSkillIds
        )

        refs: list[AgentSkillRef] = []
        warnings: list[str] = []
        seen: set[str] = set()
        for selection, source, required in candidates:
            registration = self.registry.get(selection.skillId)
            if not registration:
                if required:
                    raise AgentSkillError("AGENT_SKILL_NOT_FOUND", f"Agent Skill not found: {selection.skillId}")
                warnings.append(f"default_skill_not_found:{selection.skillId}")
                continue
            definition = registration.definition
            if definition.id in seen:
                continue
            if not definition.enabled:
                if required:
                    raise AgentSkillError("AGENT_SKILL_DISABLED", f"Agent Skill is disabled: {definition.stableId}")
                warnings.append(f"default_skill_disabled:{definition.stableId}")
                continue
            if definition.scope == "novel" and definition.ownerNovelId != request.novelId:
                if required:
                    raise AgentSkillError("AGENT_SKILL_SCOPE_MISMATCH", "Agent Skill is not visible in this novel")
                warnings.append(f"default_skill_scope_mismatch:{definition.stableId}")
                continue
            if request.operationId not in definition.supportedOperations:
                if required:
                    raise AgentSkillError(
                        "AGENT_SKILL_OPERATION_UNSUPPORTED",
                        f"{definition.stableId} does not support {request.operationId}",
                    )
                warnings.append(f"default_skill_operation_unsupported:{definition.stableId}")
                continue
            if definition.allowedRoles and request.roleId not in definition.allowedRoles:
                if required:
                    raise AgentSkillError(
                        "AGENT_SKILL_ROLE_NOT_ALLOWED",
                        f"Role {request.roleId} cannot use {definition.stableId}",
                    )
                warnings.append(f"default_skill_role_not_allowed:{definition.stableId}")
                continue
            revision = self.registry.revision(definition.id, selection.requestedRevisionId)
            seen.add(definition.id)
            refs.append(
                AgentSkillRef(
                    skillId=definition.id,
                    stableId=definition.stableId,
                    revisionId=revision.revisionId,
                    version=revision.version,
                    contentHash=revision.contentHash,
                    scope=definition.scope,
                    selectionSource=source,
                    position="primary" if not refs else "auxiliary",
                )
            )
            if len(refs) == 2:
                break

        reason_codes: list[str] = []
        if refs:
            reason_codes.append({
                "builtin": "operation_default_selected",
                "role": "role_default_selected",
                "preset": "pack_binding_selected",
            }.get(refs[0].selectionSource, "explicit_skill_selected"))
        else:
            reason_codes.append("no_compatible_skill")
        return ResolvedSkillSet(
            primary=refs[0] if refs else None,
            auxiliary=refs[1] if len(refs) > 1 else None,
            reasonCodes=reason_codes,
            warnings=warnings,
        )
