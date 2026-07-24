from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from typing import Any

import httpx
from langgraph.types import RetryPolicy

from .toolchains.schemas import ToolchainError


MAX_ATTEMPTS = 4
RETRY_LIMIT = MAX_ATTEMPTS - 1

_NON_RETRYABLE_CODES = frozenset({
    "CANCELLED",
    "CONFLICT",
    "CONTEXT_INSUFFICIENT",
    "INPUT_INVALID",
    "INVALID_INPUT",
    "INVALID_STATE",
    "NOT_FOUND",
    "PERSISTENCE_ERROR",
    "PROVIDER_AUTH",
    "PROVIDER_FILTERED",
    "ROLE_NOT_ALLOWED",
    "SIDE_EFFECT_UNKNOWN",
    "TOOLCHAIN_DISABLED",
    "TOOLCHAIN_NOT_FOUND",
    "TOOL_NOT_ALLOWED",
    "UNAUTHORIZED",
    "VERSION_CONFLICT",
    "VERSION_UNAVAILABLE",
})

_RETRYABLE_CODES = frozenset({
    "NETWORK_ERROR",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "UPSTREAM_TIMEOUT",
})


def agent_retry_policy(
    *,
    initial_interval: float = 1.0,
    backoff_factor: float = 2.0,
    max_interval: float = 30.0,
    jitter: bool = True,
) -> RetryPolicy:
    return RetryPolicy(
        max_attempts=MAX_ATTEMPTS,
        initial_interval=initial_interval,
        backoff_factor=backoff_factor,
        max_interval=max_interval,
        jitter=jitter,
        retry_on=is_retryable_agent_error,
    )


@dataclass(frozen=True)
class AgentRequestFailure:
    code: str
    retryable: bool
    attempts: int
    user_message: str
    diagnostic_ref: str
    http_status: int | None = None

    def payload(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "retryable": self.retryable,
            "attempts": self.attempts,
            "userMessage": self.user_message,
            "diagnosticRef": self.diagnostic_ref,
            **({"httpStatus": self.http_status} if self.http_status is not None else {}),
        }


class AgentRequestError(RuntimeError):
    def __init__(self, failure: AgentRequestFailure) -> None:
        super().__init__(failure.user_message)
        self.failure = failure
        self.code = failure.code
        self.details = failure.payload()


def _error_code(error: BaseException) -> str:
    raw_code = getattr(error, "code", None)
    code = str(raw_code or error.__class__.__name__ or "UNKNOWN").strip().upper()
    if code == "UPSTREAM_TIMEOUT":
        return "PROVIDER_TIMEOUT"
    return code


def _error_details(error: BaseException) -> dict[str, Any]:
    details = getattr(error, "details", None)
    return details if isinstance(details, dict) else {}


def _http_status(error: BaseException) -> int | None:
    details = _error_details(error)
    detail_status = details.get("httpStatus")
    if isinstance(detail_status, int):
        return detail_status
    status = getattr(error, "status_code", None)
    if isinstance(status, int) and _error_code(error) == "AUTOMATION_HTTP_ERROR":
        return status
    return None


def is_retryable_agent_error(error: BaseException) -> bool:
    if isinstance(error, AgentRequestError):
        return error.failure.retryable
    if isinstance(error, ToolchainError):
        return error.code != "SIDE_EFFECT_UNKNOWN" and error.retryable
    if isinstance(error, (httpx.TimeoutException, httpx.TransportError)):
        return True

    code = _error_code(error)
    if code in _NON_RETRYABLE_CODES:
        return False
    if code in _RETRYABLE_CODES:
        return True

    details = _error_details(error)
    if details.get("retryable") is True:
        return True
    status = _http_status(error)
    return status in {408, 425, 429} or (status is not None and 500 <= status <= 599)


def normalize_agent_error(error: BaseException, *, attempts: int = 1) -> AgentRequestFailure:
    if isinstance(error, AgentRequestError):
        if error.failure.attempts == attempts:
            return error.failure
        error = error.__cause__ if isinstance(error.__cause__, BaseException) else error

    code = _error_code(error)
    http_status = _http_status(error)
    retryable = is_retryable_agent_error(error)
    if isinstance(error, (httpx.TimeoutException, httpx.TransportError)):
        code = "PROVIDER_TIMEOUT" if isinstance(error, httpx.TimeoutException) else "NETWORK_ERROR"
    if retryable and attempts >= MAX_ATTEMPTS:
        user_message = "模型服务暂时不可用，已重试 3 次。"
    elif code == "PROVIDER_AUTH":
        user_message = "模型鉴权失败，请检查 API Key 或权限。"
    elif code == "CANCELLED":
        user_message = "请求已取消。"
    elif retryable:
        user_message = "模型服务暂时不可用，请稍后重试。"
    else:
        user_message = "请求未能完成，请检查输入或任务状态。"

    raw = f"{code}|{http_status or ''}|{type(error).__name__}|{error}"
    diagnostic_ref = f"agenterr_{sha256(raw.encode('utf-8', errors='replace')).hexdigest()[:12]}"
    return AgentRequestFailure(
        code=code,
        retryable=retryable,
        attempts=max(1, attempts),
        user_message=user_message,
        diagnostic_ref=diagnostic_ref,
        http_status=http_status,
    )
