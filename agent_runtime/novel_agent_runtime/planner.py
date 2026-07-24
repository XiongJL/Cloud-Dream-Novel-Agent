from __future__ import annotations

import re
from typing import Any

from .roles import ALLOWED_AGENTS, ALLOWED_ROLES
from .intent.operations import INTENT_OPERATION_REGISTRY
from .intent.rules import detect_explicit_operations
from .intent.schemas import IntentDecision, IntentEffect
from .schemas import AgentPlan, AgentPlanStep, new_id
from .tool_manifest import AGENT_TOOL_BY_NAME, AVAILABLE_AGENT_TOOLS, DRAFT_TOOLS
from .toolchains.registry import TOOLCHAIN_REGISTRY
from .toolchains.schemas import ToolchainInvocation


_EFFECT_RANK: dict[IntentEffect, int] = {
    "unknown": 0,
    "none": 1,
    "read_only": 2,
    "draft_write": 3,
    "data_write": 4,
    "external": 5,
}
_DELIVERABLE_EFFECT: dict[str, IntentEffect] = {
    "report": "read_only",
    "expert_report": "read_only",
    "chapter_draft": "draft_write",
    "chapter_draft_batch": "draft_write",
    "creative_assets_draft": "draft_write",
}
_DATA_WRITE_TOOLS = {"draft.batch.commit_prefix"}
_DELIVERABLE_RANK = {
    "none": 0,
    "report": 1,
    "expert_report": 1,
    "creative_assets_draft": 2,
    "chapter_draft": 3,
    "chapter_draft_batch": 4,
}


def infer_deliverable_effect(deliverable: str) -> IntentEffect:
    return _DELIVERABLE_EFFECT.get(deliverable, "unknown")


def plan_step_effect(step: AgentPlanStep) -> IntentEffect:
    effects: list[IntentEffect] = []
    if step.toolchain:
        definition = TOOLCHAIN_REGISTRY.resolve(step.toolchain.id, step.toolchain.version)
        effects.append(definition.sideEffect)
    for tool_name in step.tools:
        definition = AGENT_TOOL_BY_NAME.get(tool_name)
        if definition is None:
            continue
        if definition.read_only:
            effects.append("read_only")
        elif tool_name in _DATA_WRITE_TOOLS:
            effects.append("data_write")
        else:
            effects.append("draft_write")
    return max(effects, key=lambda item: _EFFECT_RANK[item], default="none")


def validate_plan_effect(plan: AgentPlan) -> None:
    ceiling = plan.requestedEffect
    if ceiling == "unknown":
        ceiling = infer_deliverable_effect(plan.deliverable)
    deliverable_effect = infer_deliverable_effect(plan.deliverable)
    if _EFFECT_RANK[deliverable_effect] > _EFFECT_RANK[ceiling]:
        raise ValueError(
            f"Plan deliverable exceeds requested effect: {plan.deliverable} requires {deliverable_effect}, ceiling is {ceiling}"
        )
    for step in plan.steps:
        effect = plan_step_effect(step)
        if _EFFECT_RANK[effect] > _EFFECT_RANK[ceiling]:
            raise ValueError(
                f"Plan step exceeds requested effect: {step.title} requires {effect}, ceiling is {ceiling}"
            )


def _resolve_deliverable(goal: str, result: Any, existing: str | None = None) -> str:
    explicit = str(result.get("deliverable") or "").strip() if isinstance(result, dict) else ""
    if explicit in {"report", "expert_report", *DRAFT_TOOLS}:
        return explicit
    if existing:
        return existing
    raw_steps = result.get("steps") if isinstance(result, dict) else []
    tools = {
        str(tool).strip()
        for step in raw_steps if isinstance(step, dict)
        for tool in (step.get("tools") or []) if isinstance(tool, str)
    }
    if "chapter.generate_draft" in tools:
        return "chapter_draft"
    if "creative_assets.generate_draft" in tools:
        return "creative_assets_draft"
    operation_deliverables = [
        definition.defaultDeliverable
        for operation_id in detect_explicit_operations(goal)
        if (definition := INTENT_OPERATION_REGISTRY.get(operation_id)) is not None
    ]
    if operation_deliverables:
        return max(operation_deliverables, key=lambda item: _DELIVERABLE_RANK[item])
    return "report"


def _ensure_deliverable_tool(steps: list[AgentPlanStep], deliverable: str, preferred_role: str) -> None:
    required_tool = DRAFT_TOOLS.get(deliverable)
    if not required_tool or any(_step_provides_tool(step, required_tool) for step in steps):
        return
    preferred_agent = preferred_role if preferred_role in ALLOWED_AGENTS else ("writer" if deliverable == "chapter_draft" else "worldbuilding")
    target = next((step for step in reversed(steps) if step.agent == preferred_agent), None)
    if target:
        target.tools.append(required_tool)
        return
    if len(steps) < 8:
        title = "生成章节草稿并提交审核" if deliverable == "chapter_draft" else "生成创作素材草稿并提交审核"
        steps.append(AgentPlanStep(stepId=new_id("step"), agent=preferred_agent, title=title, tools=[required_tool]))
        return
    steps[-1].agent = preferred_agent
    steps[-1].tools.append(required_tool)


def _step_provides_tool(step: AgentPlanStep, tool_name: str) -> bool:
    if tool_name in step.tools:
        return True
    if not step.toolchain:
        return False
    definition = TOOLCHAIN_REGISTRY.resolve(step.toolchain.id, step.toolchain.version)
    return tool_name in definition.requiredTools


def _sequence_toolchain_input(goal: str) -> dict[str, Any]:
    match = re.search(
        r"(?:续写|继续写|接着写|连续写|往下写).{0,6}([1-5一二两三四五])章",
        goal.lower(),
    )
    if not match:
        return {"chapterCount": 2}
    token = match.group(1)
    chapter_count = {
        "一": 1,
        "二": 2,
        "两": 2,
        "三": 3,
        "四": 4,
        "五": 5,
    }.get(token, int(token) if token.isdigit() else 2)
    return {"chapterCount": chapter_count}


def _build_steps_from_model(result: Any, existing_step_ids: set[str] | None = None) -> tuple[str, list[AgentPlanStep]]:
    if not isinstance(result, dict):
        raise ValueError("Agent planner returned an invalid response")
    raw_steps = result.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ValueError("Agent planner returned no steps")

    steps: list[AgentPlanStep] = []
    used_step_ids: set[str] = set()
    allowed_tools = set(AVAILABLE_AGENT_TOOLS)
    for raw_step in raw_steps[:8]:
        if not isinstance(raw_step, dict):
            continue
        title = str(raw_step.get("title") or "").strip()[:200]
        agent = str(raw_step.get("agent") or "supervisor").strip()
        if not title or agent not in ALLOWED_AGENTS:
            continue
        raw_tools = raw_step.get("tools") or []
        if not isinstance(raw_tools, list):
            raise ValueError("Agent planner returned an invalid tools list")
        tools: list[str] = []
        for value in raw_tools:
            tool = str(value).strip()
            if tool and tool not in allowed_tools:
                raise ValueError(f"Agent planner requested an unavailable tool: {tool}")
            if tool and tool not in tools:
                tools.append(tool)
        raw_toolchain = raw_step.get("toolchain")
        toolchain: ToolchainInvocation | None = None
        if raw_toolchain is not None:
            if not isinstance(raw_toolchain, dict):
                raise ValueError("Agent planner returned an invalid toolchain invocation")
            toolchain = ToolchainInvocation.model_validate(raw_toolchain)
            TOOLCHAIN_REGISTRY.resolve(
                toolchain.id,
                toolchain.version,
                "team" if agent == "supervisor" else agent,
            )
            if tools:
                raise ValueError("A plan step cannot mix a Toolchain with atomic tools")
        requested_step_id = str(raw_step.get("stepId") or "").strip()
        if requested_step_id and (existing_step_ids is None or requested_step_id not in existing_step_ids):
            raise ValueError(f"Agent planner returned an unknown stepId: {requested_step_id}")
        if requested_step_id in used_step_ids:
            raise ValueError(f"Agent planner returned a duplicate stepId: {requested_step_id}")
        step_id = requested_step_id or new_id("step")
        used_step_ids.add(step_id)
        steps.append(AgentPlanStep(stepId=step_id, agent=agent, title=title, tools=tools, toolchain=toolchain))

    if not steps:
        raise ValueError("Agent planner returned no usable steps")
    title = str(result.get("title") or "创作任务计划").strip()[:120] or "创作任务计划"
    return title, steps


def build_plan_from_model(goal: str, result: Any, preferred_role: str = "team") -> AgentPlan:
    title, steps = _build_steps_from_model(result)
    normalized_goal = goal.strip() or "创作任务"
    normalized_role = preferred_role if preferred_role in ALLOWED_ROLES else "team"
    deliverable = _resolve_deliverable(normalized_goal, result)
    _ensure_deliverable_tool(steps, deliverable, normalized_role)
    return AgentPlan(
        planId=new_id("plan"),
        threadId=new_id("thread"),
        title=title,
        goal=normalized_goal,
        steps=steps,
        preferredRole=normalized_role,
        deliverable=deliverable,
        requestedEffect=infer_deliverable_effect(deliverable),
    )


def revise_plan_from_model(plan: AgentPlan, result: Any) -> AgentPlan:
    title, steps = _build_steps_from_model(result, {step.stepId for step in plan.steps})
    deliverable = _resolve_deliverable(plan.goal, result, plan.deliverable)
    _ensure_deliverable_tool(steps, deliverable, plan.preferredRole)
    revised = plan.model_copy(update={"title": title, "steps": steps, "deliverable": deliverable})
    validate_plan_effect(revised)
    return revised


def route_plan_from_intent(plan: AgentPlan, decision: IntentDecision | dict[str, Any] | None, *, has_chapter: bool) -> AgentPlan:
    if decision is None:
        return plan
    normalized = decision if isinstance(decision, IntentDecision) else IntentDecision.model_validate(decision)
    deliverable = normalized.deliverable if normalized.deliverable != "none" else plan.deliverable
    deliverable_effect = infer_deliverable_effect(deliverable)
    effect_ceiling: IntentEffect = "read_only" if normalized.requestedEffect == "unknown" else normalized.requestedEffect
    if _EFFECT_RANK[deliverable_effect] > _EFFECT_RANK[effect_ceiling]:
        raise ValueError(
            f"Intent deliverable exceeds requested effect: {deliverable} requires {deliverable_effect}, ceiling is {effect_ceiling}"
        )
    existing_chain_ids = {step.toolchain.id for step in plan.steps if step.toolchain}
    chain_steps: list[AgentPlanStep] = []
    chain_operation_count = 0
    routable_operation_count = 0
    for operation in normalized.operations:
        if operation.type == "project.lookup":
            continue
        routable_operation_count += 1
        chain_id = operation.suggestedToolchainId
        version = operation.suggestedToolchainVersion
        if not chain_id or not version or chain_id in existing_chain_ids:
            continue
        if operation.target.kind in {"chapter", "chapter_scope"} and not has_chapter:
            continue
        definition = TOOLCHAIN_REGISTRY.resolve(chain_id, version)
        chain_operation_count += 1
        role_candidates = [normalized.suggestedRole, plan.preferredRole]
        resolved_role = next((
            "team" if role == "supervisor" else role
            for role in role_candidates
            if role and ("team" if role == "supervisor" else role) in definition.allowedRoles
        ), definition.allowedRoles[0])
        agent = "supervisor" if resolved_role == "team" else resolved_role
        chain_steps.append(
            AgentPlanStep(
                stepId=new_id("step"),
                agent=agent,
                title=definition.title,
                tools=[],
                toolchain=ToolchainInvocation(
                    id=definition.id,
                    version=definition.version,
                    input=_sequence_toolchain_input(plan.goal)
                    if definition.id == "chapter.sequence_continuation"
                    else {},
                ),
            )
        )
        existing_chain_ids.add(chain_id)

    required_tool = DRAFT_TOOLS.get(deliverable)
    chain_covers_deliverable = bool(required_tool) and any(
        _step_provides_tool(step, required_tool) for step in chain_steps
    )
    if chain_steps and chain_operation_count == routable_operation_count and (
        deliverable in {"report", "expert_report"} or chain_covers_deliverable
    ):
        steps = chain_steps
    else:
        steps = [*chain_steps, *plan.steps]
    _ensure_deliverable_tool(steps, deliverable, normalized.suggestedRole or plan.preferredRole)
    routed = plan.model_copy(update={
        "steps": steps[:8],
        "deliverable": deliverable,
        "requestedEffect": effect_ceiling,
    })
    validate_plan_effect(routed)
    return routed


def route_plan_to_stable_toolchain(plan: AgentPlan, *, has_chapter: bool) -> AgentPlan:
    """Compatibility shim retained while callers migrate to route_plan_from_intent."""
    return plan
