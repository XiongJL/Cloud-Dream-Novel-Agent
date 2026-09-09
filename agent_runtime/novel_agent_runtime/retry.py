from __future__ import annotations

from dataclasses import dataclass, field
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
    "CONTEXT_BUDGET_UNSATISFIABLE",
    "CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH",
    "CONTEXT_INPUT_TOO_LARGE",
    "CONTEXT_INSUFFICIENT",
    "CONTEXT_PROTECTED_INPUT_TOO_LARGE",
    "CONTEXT_TOKEN_COUNTER_UNAVAILABLE",
    "INPUT_INVALID",
    "INVALID_INPUT",
    "INVALID_STATE",
    "MODEL_OUTPUT_INVALID",
    "MODEL_OUTPUT_TRUNCATED",
    "MODEL_RESULT_TOO_LARGE",
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
    details: dict[str, Any] = field(default_factory=dict)

    def payload(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "retryable": self.retryable,
            "attempts": self.attempts,
            "userMessage": self.user_message,
            "diagnosticRef": self.diagnostic_ref,
            **({"httpStatus": self.http_status} if self.http_status is not None else {}),
            **self.details,
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

    details = _error_details(error)
    # The provider layer may already have spent its bounded recovery budget.
    # A familiar transport code must not start another nested retry loop.
    if details.get("retryable") is False:
        return False
    code = _error_code(error)
    if code in _NON_RETRYABLE_CODES:
        return False
    if code in _RETRYABLE_CODES:
        return True

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
    source_details = _error_details(error)
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
    elif code == "CONTEXT_INPUT_TOO_LARGE":
        user_message = "当前消息超过模型可用上下文，请缩小范围或分批发送。"
    elif code == "CONTEXT_PROTECTED_INPUT_TOO_LARGE":
        user_message = "当前任务的必要状态超过模型可用上下文，请缩小章节范围或减少活动任务。"
    elif code == "CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH":
        user_message = "当前消息与已保存会话不一致，请刷新会话后重试。"
    elif code == "CONTEXT_TOKEN_COUNTER_UNAVAILABLE":
        user_message = "当前模型缺少可靠的上下文计数能力，请检查模型配置。"
    elif code == "CONTEXT_BUDGET_UNSATISFIABLE":
        user_message = "当前窗口无法同时容纳必要能力描述、任务上下文和回复空间，请减少能力范围或改用更大窗口。"
    elif code == "MODEL_OUTPUT_INVALID":
        user_message = "模型返回的结构不符合要求，已保存结果并可尝试修复。"
    elif code == "MODEL_OUTPUT_TRUNCATED":
        user_message = "生成达到本次输出额度，尚未形成完整草稿。"
    elif code == "MODEL_REPAIR_IN_PROGRESS":
        user_message = "JSON 修复仍在处理中，请稍后再次点击恢复按钮。"
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
        details={
            key: source_details[key]
            for key in (
                "modelResultRef",
                "modelResultRevision",
                "contractId",
                "contractVersion",
                "validationIssues",
                "resultHash",
                "terminationReason",
                "responseId",
                "model",
                "usage",
                "requestedMaxTokens",
                "attemptCount",
                "attempts",
                "safeToRetryBeforePublish",
            )
            if key in source_details
        },
    )
