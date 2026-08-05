from __future__ import annotations

import math

from .errors import AgentSkillError
from .registry import AgentSkillRegistry
from .schemas import AgentSkillCompileResult, AgentSkillPromptSection, ResolvedSkillSet


class AgentSkillCompiler:
    def __init__(self, registry: AgentSkillRegistry, *, max_estimated_tokens: int = 12_000) -> None:
        self.registry = registry
        self.max_estimated_tokens = max_estimated_tokens

    @staticmethod
    def estimate_tokens(value: str) -> int:
        return math.ceil(len(value) / 4)

    def compile(self, resolved: ResolvedSkillSet) -> AgentSkillCompileResult:
        sections: list[AgentSkillPromptSection] = []
        total = 0
        for ref in resolved.refs():
            registration = self.registry.require(ref.skillId)
            definition = registration.definition
            revision = self.registry.revision(ref.skillId, ref.revisionId)
            if revision.contentHash != ref.contentHash:
                raise AgentSkillError(
                    "AGENT_SKILL_CONTENT_HASH_MISMATCH",
                    f"Agent Skill content hash mismatch: {definition.stableId}@{revision.version}",
                )
            constraints = "\n".join(f"- {item}" for item in revision.constraints) or "- 无额外约束"
            examples = ""
            if revision.examples:
                rendered = [f"输入：{item.input}\n输出：{item.output}" for item in revision.examples]
                examples = "\n\n[Examples]\n" + "\n\n".join(rendered)
            prompt = (
                f'<agent_skill id="{definition.stableId}" revision="{revision.version}" '
                f'guidance="{definition.guidanceMode}" position="{ref.position}">\n'
                f"[Purpose]\n{definition.description}\n\n"
                f"[Method]\n{revision.instructions}\n\n"
                f"[Constraints]\n{constraints}"
                f"{examples}\n"
                "</agent_skill>"
            )
            estimate = self.estimate_tokens(prompt)
            total += estimate
            sections.append(AgentSkillPromptSection(skill=ref, prompt=prompt, estimatedTokens=estimate))
        if total > self.max_estimated_tokens:
            raise AgentSkillError(
                "AGENT_SKILL_BUDGET_EXCEEDED",
                f"Compiled Agent Skill context exceeds {self.max_estimated_tokens} estimated tokens",
            )
        return AgentSkillCompileResult(
            sections=sections,
            prompt="\n\n".join(item.prompt for item in sections),
            estimatedTokens=total,
            warnings=list(resolved.warnings),
        )
