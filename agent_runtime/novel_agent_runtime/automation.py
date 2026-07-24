from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from .tool_manifest import AGENT_TOOL_BY_NAME


AUTOMATION_METHOD_TIMEOUT_SECONDS: dict[str, float] = {
    "agent.generate_chat": 180,
    "agent.generate_plan": 180,
    "agent.revise_plan": 180,
    "agent.generate_report": 240,
    "agent.generate_consistency_review": 270,
    "agent.generate_editor_range_review": 270,
    "agent.generate_writer_range_revision_plan": 270,
    "agent.generate_reader_chapter_evaluation": 270,
    "agent.generate_worldbuilding_range_consistency": 270,
    "agent.extract_research_claims": 270,
    "agent.generate_research_fact_check": 270,
    "agent.generate_scope_audit": 270,
    "agent.generate_plotline_analysis": 270,
    "agent.detect_creative_direction": 180,
}


def resolve_automation_timeout(method: str, default_timeout_seconds: float) -> float:
    definition = AGENT_TOOL_BY_NAME.get(method)
    if definition:
        return definition.timeout_seconds
    return AUTOMATION_METHOD_TIMEOUT_SECONDS.get(method, default_timeout_seconds)


class AutomationInvokeError(RuntimeError):
    def __init__(self, code: str, message: str, details: Any | None = None, status_code: int | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details
        self.status_code = status_code


class AutomationClient:
    def __init__(self, runtime_path: Path, timeout_seconds: float = 90) -> None:
        self.runtime_path = runtime_path
        self.timeout_seconds = timeout_seconds

    def _read_runtime(self) -> dict[str, Any]:
        return json.loads(self.runtime_path.read_text(encoding="utf-8"))

    async def invoke(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        origin: str = "desktop-ui",
        request_id: str | None = None,
    ) -> Any:
        runtime = self._read_runtime()
        url = f"http://127.0.0.1:{runtime['port']}/invoke"
        payload = {
            "requestId": request_id or uuid4().hex,
            "method": method,
            "params": params or {},
            "origin": origin,
        }
        request_timeout = resolve_automation_timeout(method, self.timeout_seconds)
        try:
            async with httpx.AsyncClient(timeout=request_timeout) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={"Authorization": f"Bearer {runtime['token']}"},
                )
        except httpx.TimeoutException as error:
            raise AutomationInvokeError(
                "UPSTREAM_TIMEOUT",
                "Automation service timed out",
                {"method": method},
            ) from error
        except httpx.TransportError as error:
            raise AutomationInvokeError(
                "NETWORK_ERROR",
                "Automation service connection failed",
                {"method": method},
            ) from error

        try:
            body = response.json()
        except ValueError:
            body = {
                "ok": False,
                "code": "AUTOMATION_HTTP_ERROR",
                "message": response.text or f"HTTP {response.status_code}",
            }
        if response.status_code >= 400:
            raise AutomationInvokeError(
                str(body.get("code") or "AUTOMATION_HTTP_ERROR"),
                str(body.get("message") or f"HTTP {response.status_code}"),
                body.get("data"),
                response.status_code,
            )
        if not body.get("ok"):
            raise AutomationInvokeError(
                str(body.get("code") or "AUTOMATION_ERROR"),
                str(body.get("message") or "Automation failed"),
                body.get("data"),
            )
        return body.get("data")

    async def cancel(self, request_id: str) -> bool:
        runtime = self._read_runtime()
        url = f"http://127.0.0.1:{runtime['port']}/cancel"
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                url,
                json={"requestId": request_id},
                headers={"Authorization": f"Bearer {runtime['token']}"},
            )
            response.raise_for_status()
            body = response.json()
        return bool((body.get("data") or {}).get("cancelled"))
