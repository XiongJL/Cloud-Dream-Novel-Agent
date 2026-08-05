from __future__ import annotations

from collections.abc import Awaitable, Callable
import sqlite3
from pathlib import Path
from typing import Any, Literal, TypedDict

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt


class ExecutionState(TypedDict):
    run_id: str
    approved_step_ids: list[str]
    approval_mode: str
    novel_id: str
    volume_id: str | None
    chapter_id: str | None
    current_content: str
    locale: str
    step_index: int
    tool_index: int
    phase: str
    action: str
    checkpoint: dict[str, Any] | None
    resume_response: dict[str, Any] | None
    latest_analysis_summary: str
    report_findings: list[dict[str, Any]]
    creative_direction_checked: bool
    toolchain_state: dict[str, Any] | None
    pending_operation: dict[str, Any] | None


AdvanceExecution = Callable[[ExecutionState], Awaitable[dict[str, Any]]]


class PlanExecutionGraph:
    def __init__(self, checkpoint_path: Path) -> None:
        self.checkpoint_path = checkpoint_path

    def has_checkpoint(self, thread_id: str) -> bool:
        if not self.checkpoint_path.exists():
            return False
        try:
            with sqlite3.connect(self.checkpoint_path) as connection:
                saver = SqliteSaver(connection)
                return saver.get_tuple({"configurable": {"thread_id": thread_id}}) is not None
        except (sqlite3.Error, KeyError, ValueError):
            return False

    def load_checkpoint_state(self, thread_id: str) -> ExecutionState | None:
        if not self.checkpoint_path.exists():
            return None
        try:
            with sqlite3.connect(self.checkpoint_path) as connection:
                saver = SqliteSaver(connection)
                checkpoint_tuple = saver.get_tuple({"configurable": {"thread_id": thread_id}})
                if checkpoint_tuple is None:
                    return None
                values = checkpoint_tuple.checkpoint.get("channel_values")
                if not isinstance(values, dict):
                    return None
                return ExecutionState(**{
                    key: value for key, value in values.items()
                    if key in ExecutionState.__annotations__
                })
        except (sqlite3.Error, KeyError, TypeError, ValueError):
            return None

    async def run(
        self,
        thread_id: str,
        advance: AdvanceExecution,
        *,
        initial_state: ExecutionState | None = None,
        resume: dict[str, Any] | None = None,
    ) -> ExecutionState:
        if (initial_state is None) == (resume is None):
            raise ValueError("Provide exactly one of initial_state or resume")

        async def advance_node(state: ExecutionState) -> dict[str, Any]:
            return await advance(state)

        def approval_node(state: ExecutionState) -> dict[str, Any]:
            checkpoint = state.get("checkpoint")
            if not checkpoint:
                raise ValueError("Execution graph reached approval without a checkpoint")
            response = interrupt(checkpoint)
            if not isinstance(response, dict):
                raise ValueError("Approval resume payload must be an object")
            return {
                "action": "continue",
                "checkpoint": None,
                "resume_response": response,
            }

        def operation_node(state: ExecutionState) -> dict[str, Any]:
            pending_operation = state.get("pending_operation")
            if not pending_operation:
                raise ValueError("Execution graph reached operation wait without an operation")
            response = interrupt({
                "checkpointType": "draft_operation",
                **pending_operation,
            })
            if not isinstance(response, dict):
                raise ValueError("Draft operation resume payload must be an object")
            if response.get("operationId") != pending_operation.get("operationId"):
                raise ValueError("Draft operation resume payload does not match the checkpoint")
            return {
                "action": "continue",
                "pending_operation": None,
                # Operation completion is a machine signal, not an approval
                # response. Keeping it out of resume_response prevents an
                # unrelated approval node from consuming it later.
                "resume_response": None,
            }

        def route(state: ExecutionState) -> Literal["advance", "approval", "operation", "__end__"]:
            action = state.get("action")
            if action == "waiting_approval":
                return "approval"
            if action == "waiting_operation":
                return "operation"
            if action == "terminal":
                return END
            return "advance"

        builder = StateGraph(ExecutionState)
        builder.add_node("advance", advance_node)
        builder.add_node("approval", approval_node)
        builder.add_node("operation", operation_node)
        builder.add_edge(START, "advance")
        builder.add_conditional_edges("advance", route, ["advance", "approval", "operation", END])
        builder.add_edge("approval", "advance")
        builder.add_edge("operation", "advance")

        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 200}
        async with AsyncSqliteSaver.from_conn_string(str(self.checkpoint_path)) as checkpointer:
            await checkpointer.setup()
            graph = builder.compile(checkpointer=checkpointer, name="novel-agent-plan-executor")
            graph_input: ExecutionState | Command
            graph_input = initial_state if initial_state is not None else Command(resume=resume)
            result = await graph.ainvoke(graph_input, config=config)
        return ExecutionState(**{key: value for key, value in result.items() if key != "__interrupt__"})
