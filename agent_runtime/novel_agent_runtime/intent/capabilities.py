from __future__ import annotations

from pydantic import BaseModel, Field

from ..roles import ALLOWED_ROLES
from ..tool_manifest import AGENT_TOOL_BY_NAME
from ..toolchains.registry import TOOLCHAIN_REGISTRY, ToolchainRegistry
from .operations import IntentOperationDefinition


class CapabilityMatch(BaseModel):
    operationId: str
    toolchainId: str | None = None
    toolchainVersion: str | None = None
    fallbackTools: list[str] = Field(default_factory=list)
    suggestedRole: str | None = None
    allowedRoles: list[str] = Field(default_factory=list)
    reasonCodes: list[str] = Field(default_factory=list)


def match_operation_capability(
    definition: IntentOperationDefinition,
    requested_role: str,
    registry: ToolchainRegistry = TOOLCHAIN_REGISTRY,
) -> CapabilityMatch:
    role = requested_role if requested_role in ALLOWED_ROLES else "team"
    all_candidates = registry.find_for_operation(definition.id, include_disabled=True)
    candidates = [candidate for candidate in all_candidates if candidate.enabled]
    if candidates:
        direct = next((candidate for candidate in candidates if role in candidate.allowedRoles), None)
        selected = direct or candidates[0]
        suggested_role = role if direct else definition.defaultRole
        if suggested_role not in selected.allowedRoles:
            suggested_role = selected.allowedRoles[0]
        reasons = ["MATCHED_TOOLCHAIN"]
        if not direct:
            reasons.append("ROLE_FALLBACK")
        return CapabilityMatch(
            operationId=definition.id,
            toolchainId=selected.id,
            toolchainVersion=selected.version,
            suggestedRole=suggested_role,
            allowedRoles=list(selected.allowedRoles),
            reasonCodes=reasons,
        )
    fallback = [name for name in definition.fallbackTools if name in AGENT_TOOL_BY_NAME]
    reasons = ["MATCHED_ATOMIC_TOOLS"] if fallback else ["PLANNER_FALLBACK"]
    if all_candidates and not candidates:
        reasons.insert(0, "TOOLCHAIN_DISABLED")
    return CapabilityMatch(
        operationId=definition.id,
        fallbackTools=fallback,
        suggestedRole=definition.defaultRole or role,
        reasonCodes=reasons,
    )
