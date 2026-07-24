from __future__ import annotations

import re

from pydantic import BaseModel, Field

from .schemas import IntentConversationState, IntentDeliverable


class ResolvedIntentReference(BaseModel):
    matched: bool = False
    operationIds: list[str] = Field(default_factory=list)
    deliverable: IntentDeliverable | None = None
    suggestedRole: str | None = None
    reasonCodes: list[str] = Field(default_factory=list)


_REFERENCE_MARKERS = (
    "按刚才", "按上面", "照刚才", "照上面", "继续刚才", "接着刚才",
    "刚才那个", "上面的方案", "前面的方案", "继续这个", "接着这个",
    "that plan", "previous plan", "continue with that", "continue the previous",
)


def resolve_conversation_reference(message: str, state: IntentConversationState) -> ResolvedIntentReference:
    previous = state.previousIntent
    if not previous or not previous.operationIds:
        return ResolvedIntentReference()
    normalized = message.strip().lower()
    compact = re.sub(r"[\s,.!?，。！？]+", "", normalized)
    referenced = any(marker in normalized for marker in _REFERENCE_MARKERS) or compact in {
        "继续", "继续吧", "接着来", "就按这个", "按这个来", "continue",
    }
    if not referenced:
        return ResolvedIntentReference()
    return ResolvedIntentReference(
        matched=True,
        operationIds=list(previous.operationIds),
        deliverable=previous.deliverable,
        suggestedRole=previous.suggestedRole,
        reasonCodes=["CONVERSATION_REFERENCE", "PREVIOUS_INTENT_INHERITED"],
    )
