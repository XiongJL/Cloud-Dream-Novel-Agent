from __future__ import annotations

from typing import Any

from .schemas import (
    CreativeAssetConflict,
    CreativeAssetContext,
    CreativeAssetDraftInput,
    DraftSessionRef,
    ToolchainError,
    estimate_tokens,
)


CREATIVE_CONTEXT_NODES = (
    "plotline.read",
    "character.read",
    "world.read",
    "item.read",
    "map.read",
)

CREATIVE_NODE_TOOL = {
    "plotline.read": "plotline.list",
    "character.read": "character.list",
    "world.read": "worldsetting.list",
    "item.read": "item.list",
    "map.read": "map.list",
}


def initial_creative_asset_state(input_data: CreativeAssetDraftInput) -> dict[str, Any]:
    return {
        "input": input_data.model_dump(),
        "nodeIndex": 0,
        "results": {},
        "warnings": [],
        "sourceStatus": {},
        "toolCallCount": 0,
        "estimatedTokens": 0,
        "conflictChecked": False,
        "creativeDirectionChecked": False,
        "brief": "",
        "draftResult": None,
        "validation": None,
        "artifactId": None,
    }


def build_creative_tool_call(node_id: str, state: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    input_data = CreativeAssetDraftInput.model_validate(state["input"])
    try:
        return CREATIVE_NODE_TOOL[node_id], {"novelId": input_data.novelId}
    except KeyError as error:
        raise ToolchainError("NODE_FAILED", f"Unknown creative asset node: {node_id}", node_id=node_id) from error


def apply_creative_result(state: dict[str, Any], node_id: str, result: Any) -> dict[str, Any]:
    bounded = _bounded_value(result)
    return {
        **state,
        "nodeIndex": int(state.get("nodeIndex") or 0) + 1,
        "results": {**(state.get("results") or {}), node_id: bounded},
        "sourceStatus": {**(state.get("sourceStatus") or {}), node_id: "completed"},
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
        "estimatedTokens": int(state.get("estimatedTokens") or 0) + estimate_tokens(bounded),
    }


def apply_creative_failure(state: dict[str, Any], node_id: str, error: Exception) -> dict[str, Any]:
    return {
        **state,
        "nodeIndex": int(state.get("nodeIndex") or 0) + 1,
        "warnings": [*(state.get("warnings") or []), f"{CREATIVE_NODE_TOOL[node_id]} 读取失败：{error}"],
        "sourceStatus": {**(state.get("sourceStatus") or {}), node_id: "failed"},
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
    }


def exhaust_creative_budget(state: dict[str, Any], reason: str) -> dict[str, Any]:
    updated = {**state}
    for node_id in CREATIVE_CONTEXT_NODES[int(state.get("nodeIndex") or 0):]:
        updated = {
            **updated,
            "nodeIndex": int(updated.get("nodeIndex") or 0) + 1,
            "warnings": [*(updated.get("warnings") or []), reason],
            "sourceStatus": {**(updated.get("sourceStatus") or {}), node_id: "skipped"},
        }
    return updated


def build_creative_context(state: dict[str, Any]) -> CreativeAssetContext:
    results = state.get("results") or {}
    groups = {
        "plotline": _as_items(results.get("plotline.read")),
        "character": _as_items(results.get("character.read")),
        "world": _as_items(results.get("world.read")),
        "item": _as_items(results.get("item.read")),
        "map": _as_items(results.get("map.read")),
    }
    return CreativeAssetContext(
        plotlines=groups["plotline"],
        characters=groups["character"],
        worldSettings=groups["world"],
        items=groups["item"],
        maps=groups["map"],
        conflicts=_duplicate_name_conflicts(groups),
        warnings=list(dict.fromkeys(state.get("warnings") or [])),
        toolCallCount=int(state.get("toolCallCount") or 0),
        estimatedTokens=int(state.get("estimatedTokens") or 0),
        sourceStatus=dict(state.get("sourceStatus") or {}),
    )


def build_creative_brief(
    input_data: CreativeAssetDraftInput,
    context: CreativeAssetContext,
    direction_summary: str = "",
) -> str:
    parts = [(input_data.brief or input_data.goal).strip()]
    if direction_summary.strip():
        parts.append(f"用户确认的创作方向：{direction_summary.strip()}")
    if input_data.targetSections:
        parts.append(f"目标素材类型：{'、'.join(input_data.targetSections)}")
    existing = {
        "情节线": _names(context.plotlines),
        "角色": _names(context.characters),
        "世界设定": _names(context.worldSettings),
        "物品": _names(context.items),
        "地图": _names(context.maps),
    }
    summaries = [f"{label}：{value}" for label, value in existing.items() if value]
    if summaries:
        parts.append("现有资料：" + "；".join(summaries))
    if context.conflicts:
        parts.append("冲突提醒：" + "；".join(item.message for item in context.conflicts[:5]))
    if context.warnings:
        parts.append("资料提醒：" + "；".join(context.warnings[:3]))
    return "\n".join(part for part in parts if part)


def creative_generation_params(input_data: CreativeAssetDraftInput, brief: str) -> dict[str, Any]:
    params: dict[str, Any] = {
        "novelId": input_data.novelId,
        "brief": brief,
        "locale": input_data.locale,
        "includeExistingEntities": input_data.includeExistingEntities,
        "filterCompletedPlotLines": input_data.filterCompletedPlotLines,
    }
    if input_data.targetSections:
        params["targetSections"] = input_data.targetSections
    return params


def normalize_creative_draft(value: Any) -> DraftSessionRef:
    try:
        session = DraftSessionRef.model_validate(value)
    except Exception as error:
        raise ToolchainError(
            "NODE_FAILED",
            f"creative_assets.generate_draft returned an invalid DraftSession: {error}",
            node_id="draft.generate",
        ) from error
    if session.type and session.type not in {"creative-assets", "outline-draft"}:
        raise ToolchainError(
            "NODE_FAILED",
            f"creative_assets.generate_draft returned unexpected draft type: {session.type}",
            node_id="draft.generate",
        )
    return session.model_copy(update={"type": session.type or "creative-assets"})


def normalize_creative_validation(value: Any, expected_session_id: str) -> tuple[DraftSessionRef, dict[str, Any]]:
    if not isinstance(value, dict) or not isinstance(value.get("session"), dict) or not isinstance(value.get("validation"), dict):
        raise ToolchainError(
            "NODE_FAILED",
            "creative_assets.validate_draft returned an invalid validation response.",
            node_id="draft.validate",
        )
    session = normalize_creative_draft(value["session"])
    if session.draftSessionId != expected_session_id:
        raise ToolchainError(
            "NODE_FAILED",
            "creative_assets.validate_draft returned a different DraftSession.",
            node_id="draft.validate",
        )
    raw_validation = value["validation"]
    if not isinstance(raw_validation.get("ok"), bool):
        raise ToolchainError(
            "NODE_FAILED",
            "creative_assets.validate_draft did not return a boolean ok field.",
            node_id="draft.validate",
        )
    validation = {
        "ok": raw_validation["ok"],
        "errors": list(raw_validation.get("errors") or []),
        "warnings": [str(item) for item in (raw_validation.get("warnings") or [])],
    }
    return session, validation


def _duplicate_name_conflicts(groups: dict[str, list[dict[str, Any]]]) -> list[CreativeAssetConflict]:
    names: dict[str, list[str]] = {}
    display: dict[str, str] = {}
    for source, items in groups.items():
        for item in items:
            name = str(item.get("name") or item.get("title") or "").strip()
            key = name.casefold()
            if not key:
                continue
            display.setdefault(key, name)
            names.setdefault(key, []).append(source)
    conflicts: list[CreativeAssetConflict] = []
    for key, sources in names.items():
        if len(sources) < 2:
            continue
        unique_sources = list(dict.fromkeys(sources))
        conflicts.append(
            CreativeAssetConflict(
                kind="duplicate_name",
                name=display[key],
                sources=unique_sources,
                message=f"名称“{display[key]}”已在 {'、'.join(unique_sources)} 中出现，生成时需避免误覆盖。",
            )
        )
    return conflicts


def _as_items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        for key in ("items", "data", "results"):
            nested = value.get(key)
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
    return []


def _names(items: list[dict[str, Any]]) -> str:
    values = [str(item.get("name") or item.get("title") or "").strip() for item in items[:10]]
    return "、".join(value for value in values if value)


def _bounded_value(value: Any, depth: int = 0) -> Any:
    if depth >= 4:
        return str(value)[:3000]
    if isinstance(value, str):
        return value[:3000]
    if isinstance(value, list):
        return [_bounded_value(item, depth + 1) for item in value[:80]]
    if isinstance(value, dict):
        return {str(key): _bounded_value(item, depth + 1) for key, item in list(value.items())[:60]}
    return value
