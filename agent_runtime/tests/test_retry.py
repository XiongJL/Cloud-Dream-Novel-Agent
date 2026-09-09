from __future__ import annotations

import httpx

from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.retry import MAX_ATTEMPTS, is_retryable_agent_error, normalize_agent_error
from novel_agent_runtime.toolchains.schemas import ToolchainError


def test_retry_classification_allows_only_recoverable_failures() -> None:
    assert is_retryable_agent_error(AutomationInvokeError("NETWORK_ERROR", "connection reset"))
    assert is_retryable_agent_error(AutomationInvokeError("PROVIDER_TIMEOUT", "timeout"))
    assert is_retryable_agent_error(AutomationInvokeError("PROVIDER_RATE_LIMITED", "busy"))
    assert is_retryable_agent_error(AutomationInvokeError("PROVIDER_UNAVAILABLE", "gateway"))
    assert is_retryable_agent_error(httpx.ConnectError("connection failed"))

    assert not is_retryable_agent_error(AutomationInvokeError("INVALID_INPUT", "invalid", status_code=500))
    assert not is_retryable_agent_error(AutomationInvokeError("PROVIDER_AUTH", "forbidden"))
    assert not is_retryable_agent_error(AutomationInvokeError(
        "MODEL_OUTPUT_TRUNCATED",
        "limit",
        {"safeToRetryBeforePublish": True},
        status_code=500,
    ))
    assert not is_retryable_agent_error(ToolchainError("SIDE_EFFECT_UNKNOWN", "unknown", retryable=True))
    assert not is_retryable_agent_error(ValueError("schema mismatch"))


def test_exhausted_provider_budget_prevents_outer_transport_retry() -> None:
    for code in ("PROVIDER_TIMEOUT", "NETWORK_ERROR", "PROVIDER_UNAVAILABLE"):
        error = AutomationInvokeError(code, "budget exhausted", {"retryable": False, "attempts": 2}, 503)
        assert not is_retryable_agent_error(error)
        failure = normalize_agent_error(error)
        assert failure.retryable is False
        assert failure.payload()["attempts"] == 2


def test_normalized_failure_is_sanitized_and_keeps_diagnostics() -> None:
    raw = "HTTP 504: <html>secret gateway body api_key=unsafe</html>"
    error = AutomationInvokeError(
        "PROVIDER_UNAVAILABLE",
        raw,
        {"httpStatus": 504, "retryable": True},
        500,
    )

    failure = normalize_agent_error(error, attempts=MAX_ATTEMPTS)

    assert failure.code == "PROVIDER_UNAVAILABLE"
    assert failure.retryable is True
    assert failure.attempts == 4
    assert failure.http_status == 504
    assert failure.user_message == "模型服务暂时不可用，已重试 3 次。"
    assert raw not in str(failure.payload())
    assert failure.diagnostic_ref.startswith("agenterr_")
