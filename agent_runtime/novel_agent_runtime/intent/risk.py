from __future__ import annotations

from pydantic import BaseModel, Field

from .rules import marker_is_requested
from .schemas import IntentEffect


_EFFECT_RANK: dict[IntentEffect, int] = {
    "unknown": 0,
    "none": 1,
    "read_only": 2,
    "draft_write": 3,
    "data_write": 4,
    "external": 5,
}
_DATA_WRITE_MARKERS = (
    "直接写回", "写回正文", "覆盖正文", "直接保存", "保存到正文", "提交草稿",
    "正式写入", "修改数据库", "commit the draft", "write directly", "save directly",
)
_EXTERNAL_MARKERS = (
    "发布到", "同步到外部", "发送到外部", "上传到", "发到公众号", "发到网站",
    "publish to", "upload to", "send externally", "post to",
)


class IntentRiskAssessment(BaseModel):
    requestedEffect: IntentEffect
    routePolicy: str = "standard"
    reasonCodes: list[str] = Field(default_factory=list)


def assess_intent_risk(
    operation_effects: list[IntentEffect],
    message: str,
    *,
    semantic_should_plan: bool,
) -> IntentRiskAssessment:
    normalized = message.strip().lower()
    effects = list(operation_effects)
    reasons: list[str] = []
    if any(marker_is_requested(normalized, marker) for marker in _EXTERNAL_MARKERS):
        effects.append("external")
        reasons.append("EXTERNAL_EFFECT_REQUESTED")
    elif any(marker_is_requested(normalized, marker) for marker in _DATA_WRITE_MARKERS):
        effects.append("data_write")
        reasons.append("DATA_WRITE_REQUESTED")
    if not effects:
        effects.append("unknown" if semantic_should_plan else "none")
    requested_effect = max(effects, key=lambda item: _EFFECT_RANK[item])
    if requested_effect == "external":
        return IntentRiskAssessment(
            requestedEffect=requested_effect,
            routePolicy="unsupported_external",
            reasonCodes=[*reasons, "EXTERNAL_EFFECT_UNSUPPORTED"],
        )
    if requested_effect == "data_write":
        return IntentRiskAssessment(
            requestedEffect=requested_effect,
            routePolicy="structured_confirmation_required",
            reasonCodes=[*reasons, "DATA_WRITE_REQUIRES_STRUCTURED_CONFIRMATION"],
        )
    if requested_effect == "draft_write":
        reasons.append("DRAFT_REQUIRES_PLAN_APPROVAL")
    elif requested_effect == "unknown":
        reasons.append("EFFECT_UNKNOWN")
    return IntentRiskAssessment(requestedEffect=requested_effect, reasonCodes=reasons)
