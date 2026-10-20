"""Validated method hints and product-owned execution bindings; no model calls."""
from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict


class SkillExecutionHints(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    decomposition: Literal["unknown", "none", "independent_units", "ordered_units", "multiple_perspectives"] = "unknown"
    preferredUnit: Literal["chapter", "scene", "entity", "document", "none"] = "none"
    contextRequirement: Literal["verbatim_samples", "summaries_allowed", "continuous_full_text"] = "verbatim_samples"
    crossUnitDependency: Literal["none", "adjacent", "ordered_state", "global"] = "global"
    resultComposition: Literal["evidence_findings", "ordered_parts", "synthesis"] = "evidence_findings"
    coverageRequirement: Literal["all_units", "representative_sample"] = "all_units"

    @property
    def supports_chapter_analysis(self) -> bool:
        return (self.preferredUnit == "chapter"
                and self.decomposition in {"independent_units", "ordered_units"}
                and self.contextRequirement != "continuous_full_text"
                and self.crossUnitDependency in {"none", "adjacent", "ordered_state"}
                and self.resultComposition == "evidence_findings"
                and self.coverageRequirement == "all_units")

    @property
    def parallel(self) -> bool:
        return self.decomposition == "independent_units" and self.crossUnitDependency == "none"


STYLE_EXECUTION_HINTS = SkillExecutionHints(
    decomposition="independent_units", preferredUnit="chapter", crossUnitDependency="none",
)


def builtin_executor_profile(operation_id: str, refs: list) -> str | None:
    if operation_id != "agent_skill.style_extract":
        return None
    return next(("style_extraction_v1" for ref in refs
                 if ref.scope == "builtin" and ref.skillId == "builtin.style-skill-extractor"
                 and getattr(ref, "position", None) == "primary"
                 and ref.revisionId in {"builtin.style-skill-extractor@1.0.0", "builtin.style-skill-extractor@1.1.0", "builtin.style-skill-extractor@1.2.0", "builtin.style-skill-extractor@1.3.0", "builtin.style-skill-extractor@1.4.0"}), None)
