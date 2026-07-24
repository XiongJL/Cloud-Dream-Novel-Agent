from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Literal, TypedDict

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


ModelCall = Callable[[ExplorationState], Awaitable[dict[str, Any]]]
ToolCall = Callable[[str, dict[str, Any]], Awaitable[Any]]
RetryStarted = Callable[[str, int, int], Awaitable[None]]


class AgentExplorationGraph:
    def __init__(
        self,
        checkpoint_path: Path,
        read_only_tools: list[str],
        max_iterations: int = 4,
        max_tool_calls: int = 8,
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
    ) -> ExplorationState:
        attempt_counts: dict[str, int] = {}

        async def notify_retry(node: str, runtime: Runtime[Any]) -> None:
            attempt = runtime.execution_info.node_attempt if runtime.execution_info else 1
            attempt_counts[node] = max(attempt_counts.get(node, 1), attempt)
            if attempt > 1 and on_retry_started:
                await on_retry_started(node, attempt - 1, RETRY_LIMIT)

        async def agent_node(state: ExplorationState, runtime: Runtime[Any]) -> dict[str, Any]:
            await notify_retry("model", runtime)
            decision = await model_call(state)
            if not isinstance(decision, dict):
                raise ValueError("Agent exploration model returned an invalid decision")
            raw_calls = decision.get("toolCalls")
            normalized_calls: list[dict[str, Any]] = []
            if isinstance(raw_calls, list):
                remaining = max(0, self.max_tool_calls - len(state["tool_trace"]))
                for raw_call in raw_calls[:remaining]:
                    if not isinstance(raw_call, dict):
                        continue
                    name = str(raw_call.get("name") or "").strip()
                    if name not in self.read_only_tools:
                        continue
                    args = raw_call.get("args")
                    normalized_calls.append({"name": name, "args": args if isinstance(args, dict) else {}})
            decision = {**decision, "toolCalls": normalized_calls}
            return {
                "decision": decision,
                "pending_tool_calls": normalized_calls,
                "iterations": state["iterations"] + 1,
            }

        async def tool_node(state: ExplorationState, runtime: Runtime[Any]) -> dict[str, Any]:
            await notify_retry("read_only_tool", runtime)
            observations = list(state["observations"])
            trace = list(state["tool_trace"])
            pending = list(state["pending_tool_calls"])
            if not pending:
                return {}
            requested = pending[0]
            name = requested["name"]
            args = requested.get("args") or {}
            try:
                result = await tool_call(name, args)
                observation = {"toolName": name, "args": args, "result": result, "ok": True}
                trace.append({"toolName": name, "status": "completed"})
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
            observations.append(observation)
            return {
                "observations": observations,
                "tool_trace": trace,
                "pending_tool_calls": pending[1:],
            }

        def route_after_agent(state: ExplorationState) -> Literal["tools", "__end__"]:
            calls = state["pending_tool_calls"]
            if calls and state["iterations"] < self.max_iterations and len(state["tool_trace"]) < self.max_tool_calls:
                return "tools"
            return END

        def route_after_tool(state: ExplorationState) -> Literal["tools", "agent"]:
            return "tools" if state["pending_tool_calls"] else "agent"

        builder = StateGraph(ExplorationState)
        builder.add_node("agent", agent_node, retry_policy=self.retry_policy)
        builder.add_node("tools", tool_node, retry_policy=self.retry_policy)
        builder.add_edge(START, "agent")
        builder.add_conditional_edges("agent", route_after_agent, ["tools", END])
        builder.add_conditional_edges("tools", route_after_tool, ["tools", "agent"])

        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        async with AsyncSqliteSaver.from_conn_string(str(self.checkpoint_path)) as checkpointer:
            await checkpointer.setup()
            graph = builder.compile(checkpointer=checkpointer, name="novel-agent-exploration")
            try:
                result = await graph.ainvoke(
                    initial_state,
                    config={
                        "configurable": {"thread_id": thread_id},
                        "recursion_limit": self.max_iterations + self.max_tool_calls + 2,
                    },
                )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                attempts = max(attempt_counts.values(), default=1)
                raise AgentRequestError(normalize_agent_error(error, attempts=attempts)) from error
        return ExplorationState(**result)
