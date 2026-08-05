from __future__ import annotations

from typing import Any

from .compiler import AgentSkillCompiler
from .registry import BUILTIN_AGENT_SKILL_REGISTRY, AgentSkillRegistry
from .resolver import AgentSkillResolver
from .schemas import AgentSkillResolveRequest


class AgentSkillService:
    def __init__(self, registry: AgentSkillRegistry = BUILTIN_AGENT_SKILL_REGISTRY) -> None:
        self.registry = registry
        self.resolver = AgentSkillResolver(registry)
        self.compiler = AgentSkillCompiler(registry)

    def list_public(self, params: dict[str, Any], context: dict[str, Any]) -> list[dict[str, Any]]:
        locale = str(params.get("locale") or context.get("locale") or "zh-CN")
        novel_id = str(params.get("novelId") or context.get("novelId") or "").strip() or None
        return [item.model_dump() for item in self.registry.list_index(locale=locale, novel_id=novel_id)]

    def resolve(self, params: dict[str, Any]) -> dict[str, Any]:
        request = AgentSkillResolveRequest.model_validate(params)
        return self.resolver.resolve(request).model_dump()

    def preview(self, params: dict[str, Any]) -> dict[str, Any]:
        request = AgentSkillResolveRequest.model_validate(params)
        resolved = self.resolver.resolve(request)
        return {
            "resolved": resolved.model_dump(),
            "compiled": self.compiler.compile(resolved).model_dump(),
        }


AGENT_SKILL_SERVICE = AgentSkillService()
