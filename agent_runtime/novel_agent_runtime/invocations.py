from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, Field

from .schemas import utc_now


InvocationStatus = Literal[
    "prepared",
    "operation_pending",
    "in_flight",
    "succeeded",
    "failed",
    "unknown",
    "reconciled_succeeded",
    "reconciled_absent",
]


class ToolInvocationRecord(BaseModel):
    invocationKey: str
    requestId: str
    runId: str
    stepId: str | None = None
    method: str
    paramsHash: str
    sideEffect: bool
    status: InvocationStatus
    result: Any = None
    error: dict[str, Any] | None = None
    createdAt: str = Field(default_factory=utc_now)
    updatedAt: str = Field(default_factory=utc_now)


class SideEffectResultUnknown(RuntimeError):
    code = "SIDE_EFFECT_UNKNOWN"

    def __init__(self, method: str, invocation_key: str, message: str | None = None) -> None:
        self.method = method
        self.invocation_key = invocation_key
        super().__init__(
            message
            or f"The result of side-effect tool {method} is unknown. The call will not be replayed automatically."
        )


class DraftOperationFailed(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        operation_id: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.operation_id = operation_id
        self.details = details or {}
        super().__init__(message)


class AgentControlFlowSignal(BaseException):
    """Internal scheduler signal that must bypass business error handlers."""


class DraftOperationPending(AgentControlFlowSignal):
    def __init__(
        self,
        operation_id: str,
        operation_key: str,
        status: str,
        version: int,
        poll_after_seconds: float = 1.0,
    ) -> None:
        self.operation_id = operation_id
        self.operation_key = operation_key
        self.status = status
        self.version = version
        self.poll_after_seconds = poll_after_seconds
        super().__init__(f"Draft operation {operation_id} is still {status}")


def invocation_params_hash(params: dict[str, Any]) -> str:
    encoded = json.dumps(params, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def build_invocation_key(
    run_id: str,
    step_id: str | None,
    method: str,
    params: dict[str, Any],
) -> tuple[str, str]:
    params_hash = invocation_params_hash(params)
    return f"{run_id}:{step_id or 'none'}:{method}:{params_hash[:24]}", params_hash


def build_durable_operation_key(
    plan_id: str,
    step_id: str | None,
    method: str,
    params: dict[str, Any],
) -> tuple[str, str]:
    """Build an idempotency key that survives Agent run retries and restarts."""
    params_hash = invocation_params_hash(params)
    encoded = f"{plan_id}:{step_id or 'none'}:{method}:{params_hash}"
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return f"draftop_{digest}", params_hash
