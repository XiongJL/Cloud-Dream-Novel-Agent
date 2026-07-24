from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Literal, NotRequired, TypedDict

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import RetryPolicy

from .retry import AgentRequestError, MAX_ATTEMPTS, RETRY_LIMIT, agent_retry_policy, normalize_agent_error, is_retryable_agent_error


class ExplorationState(TypedDict):
    message: str
    role: str
    approval_mode: str
    locale: str
    history: list[dict[str, Any]]
    context: dict[str, Any]
    observations: list[dict[str, Any]]
    tool_trace: list[dict[str, Any]]
    pending_tool_calls: list[dict[str, Any]]
    decision: dict[str, Any]
    iterations: int
    audit_observations: NotRequired[list[dict[str, Any]]]
    exploration_notes: NotRequired[list[str]]
    force_finalization: NotRequired[bool]
    extended: NotRequired[bool]
    needs_finalization: NotRequired[bool]


ModelCall = Callable[[ExplorationState], Awaitable[dict[str, Any]]]
ToolCall = Callable[[str, dict[str, Any]], Awaitable[Any]]
RetryStarted = Callable[[str, int, int], Awaitable[None]]
ProgressUpdated = Callable[[str, dict[str, Any]], Awaitable[None]]


def _estimated_tokens(value: str) -> int:
    ascii_chars = sum(1 for character in value if ord(character) < 128)
    return (ascii_chars + 3) // 4 + (len(value) - ascii_chars)


def _trim_to_token_budget(value: str, max_tokens: int) -> str:
    if _estimated_tokens(value) <= max_tokens:
        return value
    consumed = 0.0
    result: list[str] = []
    for character in value:
        consumed += 0.25 if ord(character) < 128 else 1
        if consumed > max_tokens:
            break
        result.append(character)
    return "".join(result).rstrip()


class AgentExplorationGraph:
    def __init__(
        self,
        checkpoint_path: Path,
        read_only_tools: list[str],
        max_iterations: int = 8,
        max_tool_calls: int = 12,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        self.checkpoint_path = checkpoint_path
        self.read_only_tools = frozenset(read_only_tools)
        self.max_iterations = max_iterations
        self.max_tool_calls = max_tool_calls
        self.retry_policy = retry_policy or agent_retry_policy()

    async def run(
        self,
        thread_id: str,
        initial_state: ExplorationState,
        model_call: ModelCall,
        tool_call: ToolCall,
        on_retry_started: RetryStarted | None = None,
        on_progress: ProgressUpdated | None = None,
        soft_iterations: int = 4,
        soft_tool_calls: int = 8,
        total_budget_seconds: float = 165,
        finalization_reserve_seconds: float = 45,
    ) -> ExplorationState:
        attempt_counts: dict[str, int] = {}
        started_at = time.monotonic()
        exploration_deadline = started_at + max(1, total_budget_seconds - finalization_reserve_seconds)

        async def progress(phase: str, **details: Any) -> None:
            if on_progress:
                await on_progress(phase, details)

        async def notify_retry(node: str, runtime: Runtime[Any]) -> None:
            attempt = runtime.execution_info.node_attempt if runtime.execution_info else 1
            attempt_counts[node] = max(attempt_counts.get(node, 1), attempt)
            if attempt > 1 and on_retry_started:
                await on_retry_started(node, attempt - 1, RETRY_LIMIT)

        async def agent_node(state: ExplorationState, runtime: Runtime[Any]) -> dict[str, Any]:
            await notify_retry("model", runtime)
            force_finalization = bool(state.get("force_finalization")) or time.monotonic() >= exploration_deadline
            await progress("finalizing" if force_finalization else "thinking", iteration=state["iterations"] + 1)
            call_state = {**state, "force_finalization": force_finalization, "pending_tool_calls": []}
            timeout = finalization_reserve_seconds if force_finalization else max(1, exploration_deadline - time.monotonic())
            try:
                async with asyncio.timeout(timeout):
                    decision = await model_call(ExplorationState(**call_state))
            except asyncio.TimeoutError:
                if force_finalization:
                    decision = {
                        "content": "已达到本次读取的时间上限。以上结论仅覆盖已成功读取的范围，未读取部分可能仍有遗漏。",
                        "toolCalls": [],
                        "shouldPlan": False,
                        "needsClarification": False,
                    }
                else:
                    await progress("finalizing", reason="time_budget")
                    force_finalization = True
                    call_state = {**state, "force_finalization": True, "pending_tool_calls": []}
                    try:
                        async with asyncio.timeout(finalization_reserve_seconds):
                            decision = await model_call(ExplorationState(**call_state))
                    except asyncio.TimeoutError:
                        decision = {
                            "content": "已达到本次读取的时间上限。以上结论仅覆盖已成功读取的范围，未读取部分可能仍有遗漏。",
                            "toolCalls": [],
                            "shouldPlan": False,
                            "needsClarification": False,
                        }
            if not isinstance(decision, dict):
                raise ValueError("Agent exploration model returned an invalid decision")
            raw_calls = decision.get("toolCalls")
            normalized_calls: list[dict[str, Any]] = []
            if isinstance(raw_calls, list):
                remaining = max(0, self.max_tool_calls - len(state["tool_trace"]))
                for raw_call in raw_calls[:min(3, remaining)]:
                    if not isinstance(raw_call, dict):
                        continue
                    name = str(raw_call.get("name") or "").strip()
                    if name not in self.read_only_tools:
                        continue
                    args = raw_call.get("args")
                    normalized_calls.append({"name": name, "args": args if isinstance(args, dict) else {}})
            if force_finalization:
                normalized_calls = []
            observed_signatures = {
                json.dumps(
                    {"name": item.get("toolName"), "args": item.get("args") or {}},
                    ensure_ascii=False,
                    sort_keys=True,
                    default=str,
                )
                for item in (state.get("audit_observations") or state["observations"])
            }
            projected_tool_calls = len(state["tool_trace"]) + len(normalized_calls)
            crossing_soft_limit = state["iterations"] + 1 >= soft_iterations or projected_tool_calls > soft_tool_calls
            novel_calls = [
                call for call in normalized_calls
                if json.dumps({"name": call["name"], "args": call["args"]}, ensure_ascii=False, sort_keys=True, default=str)
                not in observed_signatures
            ]
            needs_finalization = bool(normalized_calls) and crossing_soft_limit and not novel_calls
            if needs_finalization:
                normalized_calls = []
            decision = {**decision, "toolCalls": normalized_calls}
            notes = list(state.get("exploration_notes") or [])
            content = str(decision.get("content") or "").strip()
            if normalized_calls and content:
                notes.append(_trim_to_token_budget(content, 800))
                while sum(_estimated_tokens(item) for item in notes) > 6000 and len(notes) > 1:
                    notes.pop(0)
            extending = bool(normalized_calls) and crossing_soft_limit and not state.get("extended")
            if extending:
                await progress(
                    "extending",
                    softIterations=soft_iterations,
                    hardIterations=self.max_iterations,
                    softToolCalls=soft_tool_calls,
                    hardToolCalls=self.max_tool_calls,
                )
            elif not normalized_calls:
                await progress("finalizing", reason="complete")
            return {
                "decision": decision,
                "pending_tool_calls": normalized_calls,
                "iterations": state["iterations"] + 1,
                "exploration_notes": notes,
                "force_finalization": force_finalization,
                "extended": bool(state.get("extended")) or extending,
                "needs_finalization": needs_finalization,
            }

        async def tool_node(state: ExplorationState, runtime: Runtime[Any]) -> dict[str, Any]:
            await notify_retry("read_only_tool", runtime)
            observations = list(state["observations"])
            audit_observations = list(state.get("audit_observations") or state["observations"])
            trace = list(state["tool_trace"])
            pending = list(state["pending_tool_calls"])
            if not pending:
                return {}
            requested = pending[0]
            name = requested["name"]
            args = requested.get("args") or {}
            await progress(
                "reading" if name.startswith("attachment.") else "thinking",
                toolName=name,
                attachmentId=str(args.get("attachmentId") or ""),
                selector=args.get("selector"),
            )
            try:
                async with asyncio.timeout(max(1, exploration_deadline - time.monotonic())):
                    result = await tool_call(name, args)
                observation = {"toolName": name, "args": args, "result": result, "ok": True}
                trace.append({"toolName": name, "status": "completed"})
            except asyncio.TimeoutError:
                observation = {
                    "toolName": name,
                    "args": args,
                    "error": "读取时间预算已用尽，转入结果汇总。",
                    "errorCode": "EXPLORATION_TIME_BUDGET_EXHAUSTED",
                    "ok": False,
                }
                trace.append({
                    "toolName": name,
                    "status": "failed",
                    "message": observation["error"],
                    "errorCode": observation["errorCode"],
                })
            except Exception as error:
                if is_retryable_agent_error(error):
                    raise
                failure = normalize_agent_error(error)
                observation = {
                    "toolName": name,
                    "args": args,
                    "error": failure.user_message,
                    "errorCode": failure.code,
                    "diagnosticRef": failure.diagnostic_ref,
                    "ok": False,
                }
                trace.append({
                    "toolName": name,
                    "status": "failed",
                    "message": failure.user_message,
                    "errorCode": failure.code,
                    "diagnosticRef": failure.diagnostic_ref,
                })
            audit_observations.append(observation)
            if name == "attachment.read" and observation.get("ok") is True:
                compacted: list[dict[str, Any]] = []
                for item in observations:
                    previous_name = str(item.get("toolName") or "")
                    if previous_name in {"attachment.list", "attachment.outline", "attachment.search"}:
                        continue
                    if previous_name == "attachment.read" and item.get("ok") is True:
                        previous_result = item.get("result") if isinstance(item.get("result"), dict) else {}
                        compacted.append({
                            **item,
                            "result": {
                                "attachmentId": previous_result.get("attachmentId"),
                                "status": previous_result.get("status"),
                                "actualRange": previous_result.get("actualRange"),
                                "truncated": previous_result.get("truncated"),
                                "superseded": True,
                            },
                        })
                    else:
                        compacted.append(item)
                observations = compacted
            observations.append(observation)
            return {
                "observations": observations,
                "audit_observations": audit_observations,
                "tool_trace": trace,
                "pending_tool_calls": pending[1:],
            }

        def route_after_agent(state: ExplorationState) -> Literal["tools", "finalize", "__end__"]:
            if state.get("force_finalization"):
                return END
            if state.get("needs_finalization"):
                return "finalize"
            calls = state["pending_tool_calls"]
            if calls and time.monotonic() >= exploration_deadline:
                return "finalize"
            if calls and len(state["tool_trace"]) < self.max_tool_calls:
                return "tools"
            if calls:
                return "finalize"
            return END

        def route_after_tool(state: ExplorationState) -> Literal["tools", "agent", "finalize"]:
            if time.monotonic() >= exploration_deadline:
                return "finalize"
            if state["pending_tool_calls"]:
                return "tools"
            if state["iterations"] >= self.max_iterations or len(state["tool_trace"]) >= self.max_tool_calls or time.monotonic() >= exploration_deadline:
                return "finalize"
            return "agent"

        async def finalize_node(state: ExplorationState, runtime: Runtime[Any]) -> dict[str, Any]:
            await progress("finalizing", reason="budget")
            final_state = ExplorationState(**{**state, "force_finalization": True, "pending_tool_calls": []})
            return await agent_node(final_state, runtime)

        builder = StateGraph(ExplorationState)
        builder.add_node("agent", agent_node, retry_policy=self.retry_policy)
        builder.add_node("tools", tool_node, retry_policy=self.retry_policy)
        builder.add_node("finalize", finalize_node, retry_policy=self.retry_policy)
        builder.add_edge(START, "agent")
        builder.add_conditional_edges("agent", route_after_agent, ["tools", "finalize", END])
        builder.add_conditional_edges("tools", route_after_tool, ["tools", "agent", "finalize"])
        builder.add_edge("finalize", END)

        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        async with AsyncSqliteSaver.from_conn_string(str(self.checkpoint_path)) as checkpointer:
            await checkpointer.setup()
            graph = builder.compile(checkpointer=checkpointer, name="novel-agent-exploration")
            try:
                result = await graph.ainvoke(
                    initial_state,
                    config={
                        "configurable": {"thread_id": thread_id},
                        "recursion_limit": self.max_iterations + self.max_tool_calls + 6,
                    },
                )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                attempts = max(attempt_counts.values(), default=1)
                raise AgentRequestError(normalize_agent_error(error, attempts=attempts)) from error
        return ExplorationState(**result)
