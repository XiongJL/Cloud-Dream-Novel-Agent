from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from .tool_manifest import AGENT_TOOL_BY_NAME


AUTOMATION_METHOD_TIMEOUT_SECONDS: dict[str, float] = {
    # Normal generation plus one bounded structured-output repair share the chat deadline.
    "agent.generate_chat": 300,
    "agent.generate_plan": 180,
    "agent.revise_plan": 180,
    "agent.generate_report": 240,
    "agent.generate_consistency_review": 360,
    "agent.generate_skill_document": 270,
    "agent.generate_novel_bootstrap": 270,
    "agent.plan_style_skill_pack": 270,
    "agent.generate_editor_range_review": 270,
    "agent.generate_writer_range_revision_plan": 270,
    "agent.generate_reader_chapter_evaluation": 270,
    "agent.generate_worldbuilding_range_consistency": 270,
    "agent.extract_research_claims": 270,
    "agent.generate_research_fact_check": 270,
    "agent.generate_scope_audit": 270,
    "agent.generate_plotline_analysis": 270,
    "agent.detect_creative_direction": 180,
    "agent.repair_structured_output": 180,
    "agent.reprocess_saved_structured_output": 30,
    "agent_skill.list": 30,
    "agent_skill.get": 30,
    "agent_skill.binding.list": 30,
    "agent_skill.draft.list": 30,
    "agent_skill.draft.get": 30,
    "agent_skill.draft.upsert": 45,
    "agent_skill.draft.commit": 60,
    "agent_skill.draft.discard": 30,
    "agent_skill.workspace.create": 45,
    "agent_skill.workspace.list": 30,
    "agent_skill.workspace.read": 30,
    "agent_skill.workspace.write": 45,
    "agent_skill.workspace.patch": 45,
    "agent_skill.workspace.remove": 45,
    "agent_skill.workspace.set_pack": 45,
    "agent_skill.workspace.validate": 45,
    "agent_skill.workspace.compile": 45,
    "agent_skill.workspace.diff": 30,
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
        parent_request_id: str | None = None,
        deadline_at: str | None = None,
    ) -> Any:
        runtime = self._read_runtime()
        url = f"http://127.0.0.1:{runtime['port']}/invoke"
        payload = {
            "requestId": request_id or uuid4().hex,
            "method": method,
            "params": params or {},
            "origin": origin,
            "parentRequestId": parent_request_id,
            "deadlineAt": deadline_at,
        }
        request_timeout = resolve_automation_timeout(method, self.timeout_seconds)
        if deadline_at:
            try:
                parsed_deadline = datetime.fromisoformat(deadline_at.replace("Z", "+00:00"))
                remaining = (parsed_deadline - datetime.now(timezone.utc)).total_seconds()
                request_timeout = max(0.1, min(request_timeout, remaining))
            except ValueError:
                pass
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
