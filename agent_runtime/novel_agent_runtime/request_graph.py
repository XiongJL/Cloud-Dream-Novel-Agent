from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import RetryPolicy

from .retry import (
    AgentRequestError,
    MAX_ATTEMPTS,
    RETRY_LIMIT,
    agent_retry_policy,
    normalize_agent_error,
)


class RequestState(TypedDict):
    result: Any


RequestCall = Callable[[], Awaitable[Any]]
RequestEvent = Callable[[str, dict[str, Any]], Awaitable[None]]


@dataclass
class _RequestContext:
    request_call: RequestCall
    operation_id: str
    request_id: str
    node_id: str
    method: str
    on_event: RequestEvent | None
    attempts: int = 1


class RetryableRequestGraph:
    def __init__(self, retry_policy: RetryPolicy | None = None) -> None:
        self.retry_policy = retry_policy or agent_retry_policy()
        builder = StateGraph(RequestState, context_schema=_RequestContext)
        builder.add_node("request", self._request_node, retry_policy=self.retry_policy)
        builder.add_edge(START, "request")
        builder.add_edge("request", END)
        self.graph = builder.compile(name="novel-agent-retryable-request")

    async def _emit(
        self,
        context: _RequestContext,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        if context.on_event:
            await context.on_event(event_type, {
                "operationId": context.operation_id,
                "requestId": context.request_id,
                "nodeId": context.node_id,
                "method": context.method,
                "maxAttempts": MAX_ATTEMPTS,
                "retryLimit": RETRY_LIMIT,
                **payload,
            })

    async def _request_node(
        self,
        _state: RequestState,
        runtime: Runtime[_RequestContext],
    ) -> dict[str, Any]:
        context = runtime.context
        attempt = runtime.execution_info.node_attempt if runtime.execution_info else 1
        context.attempts = max(context.attempts, attempt)
        retry_attempt = max(0, attempt - 1)
        if attempt > 1:
            await self._emit(context, "request_retry_started", {
                "attempt": attempt,
                "retryAttempt": retry_attempt,
            })
        try:
            result = await context.request_call()
        except Exception as error:
            failure = normalize_agent_error(error, attempts=attempt)
            if failure.retryable:
                if attempt < MAX_ATTEMPTS:
                    base_delay = min(
                        self.retry_policy.max_interval,
                        self.retry_policy.initial_interval
                        * (self.retry_policy.backoff_factor ** (attempt - 1)),
                    )
                    await self._emit(context, "request_retry_scheduled", {
                        "attempt": attempt,
                        "retryAttempt": attempt,
                        "retryDelayMs": int(base_delay * 1000),
                        "jitter": self.retry_policy.jitter,
                        **failure.payload(),
                    })
                else:
                    await self._emit(context, "request_retry_exhausted", {
                        "attempt": attempt,
                        "retryAttempt": RETRY_LIMIT,
                        **failure.payload(),
                    })
            raise
        if attempt > 1:
            await self._emit(context, "request_retry_succeeded", {
                "attempt": attempt,
                "retryAttempt": retry_attempt,
            })
        return {"result": result}

    async def run(
        self,
        request_call: RequestCall,
        *,
        operation_id: str,
        request_id: str,
        node_id: str,
        method: str,
        on_event: RequestEvent | None = None,
    ) -> Any:
        context = _RequestContext(
            request_call=request_call,
            operation_id=operation_id,
            request_id=request_id,
            node_id=node_id,
            method=method,
            on_event=on_event,
        )
        try:
            result = await self.graph.ainvoke({"result": None}, context=context)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise AgentRequestError(normalize_agent_error(error, attempts=context.attempts)) from error
        return result["result"]
