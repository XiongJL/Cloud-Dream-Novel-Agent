from __future__ import annotations

import argparse
import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse

from .automation import AutomationClient
from .agent_skills.errors import AgentSkillError
from .events import AgentEventBus, serialize_sse_event
from .retry import AgentRequestError
from .runtime import NovelAgentRuntime
from .schemas import AgentEnvelope, new_id, utc_now
from .store import AgentStateStore
from .tool_adapter import FastMcpAgentToolAdapter, HttpAgentToolAdapter


def report_progress(phase: str) -> None:
    print(
        "@@NOVEL_AGENT_PROGRESS@@" + json.dumps({"phase": phase}, ensure_ascii=False),
        flush=True,
    )


def build_app(runtime: NovelAgentRuntime, token: str | None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await runtime.resume_interrupted_runs()
        yield

    app = FastAPI(title="CloudDream Novel Agent Runtime", version="0.1.0", lifespan=lifespan)
    active_requests: dict[str, asyncio.Task[Any]] = {}
    progress_states: dict[str, dict[str, Any]] = {}

    def append_progress(request_id: str, phase: str, details: dict[str, Any] | None = None) -> None:
        previous = progress_states.get(request_id) or {"sequence": 0, "events": []}
        event = {
            "eventId": new_id("activity"),
            "sequence": int(previous.get("sequence") or 0) + 1,
            "requestId": request_id,
            "phase": phase,
            "createdAt": utc_now(),
            **(details or {}),
        }
        progress_states[request_id] = {
            "sequence": event["sequence"],
            "events": [*(previous.get("events") or []), event][-200:],
        }

    def check_auth(authorization: str | None) -> None:
        if not token:
            return
        if authorization != f"Bearer {token}":
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "code": "OK",
            "message": "healthy",
            "data": {
                "capabilities": ["agent.roles", "agent.skills", "agent.skill.resolve", "agent.skill.preview", "agent.skill.author", "agent.skill.drafts", "agent.skill.draft", "agent.skill.commit", "agent.skill.discard", "agent.chat", "agent.recover_chat", "agent.retry_chat_summary", "agent.delete_chat_context", "agent.plan", "agent.register_plan", "agent.revise_plan", "agent.execute_plan", "agent.retry_run", "agent.revise_draft", "agent.regenerate_batch", "agent.inspect_side_effect", "agent.reconcile_side_effect", "agent.run_status", "agent.cancel", "agent.submit_approval", "agent.submit_user_input", "agent.dismiss_user_input", "agent.operation_completed", "agent.events"],
                "toolTransport": runtime.tool_transport,
            },
        }

    @app.post("/invoke")
    async def invoke(envelope: AgentEnvelope, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        check_auth(authorization)
        request_id = str(envelope.requestId or "").strip()
        current_task = asyncio.current_task()
        if request_id and current_task:
            active_requests[request_id] = current_task
            if len(progress_states) >= 200:
                progress_states.pop(next(iter(progress_states)), None)
            append_progress(request_id, "thinking", {
                "type": "request_started",
                "stage": "scope_validation",
                "displayName": "正在校验章节范围",
                "status": "running",
            })

        async def report_chat_progress(phase: str, details: dict[str, Any]) -> None:
            if not request_id:
                return
            append_progress(request_id, phase, details)
        try:
            method = envelope.method
            params = envelope.params
            context = envelope.context.model_dump()
            if request_id:
                context["_requestId"] = request_id
            if method == "agent.roles":
                data = runtime.roles(params, context)
            elif method == "agent.skills":
                data = await runtime.skills(params, context)
            elif method == "agent.skill.resolve":
                data = await runtime.resolve_skill(params)
            elif method == "agent.skill.preview":
                data = await runtime.preview_skill(params)
            elif method == "agent.skill.author":
                data = await runtime.author_skill(params, context)
            elif method == "agent.skill.drafts":
                data = await runtime.list_skill_drafts(params, context)
            elif method == "agent.skill.draft":
                data = await runtime.get_skill_draft(params)
            elif method == "agent.skill.commit":
                data = await runtime.commit_skill_draft(params)
            elif method == "agent.skill.discard":
                data = await runtime.discard_skill_draft(params)
            elif method == "agent.chat":
                data = await runtime.chat(params, context, on_progress=report_chat_progress)
            elif method == "agent.recover_chat":
                data = await runtime.recover_chat(params, context, on_progress=report_chat_progress)
            elif method == "agent.retry_chat_summary":
                data = await runtime.retry_chat_summary(params, context, on_progress=report_chat_progress)
            elif method == "agent.delete_chat_context":
                data = runtime.delete_chat_context(params)
            elif method == "agent.plan":
                data = await runtime.plan(params, context)
            elif method == "agent.register_plan":
                data = runtime.register_plan(params, context)
            elif method == "agent.revise_plan":
                data = await runtime.revise_plan(params, context)
            elif method == "agent.execute_plan":
                data = await runtime.execute_plan(params, context)
            elif method == "agent.retry_run":
                data = await runtime.retry_run(params, context)
            elif method == "agent.revise_draft":
                data = await runtime.revise_draft(params, context)
            elif method == "agent.regenerate_batch":
                data = await runtime.regenerate_batch(params, context)
            elif method == "agent.inspect_side_effect":
                data = await runtime.inspect_side_effect(params, context)
            elif method == "agent.reconcile_side_effect":
                data = await runtime.reconcile_side_effect(params, context)
            elif method == "agent.run_status":
                data = runtime.run_status(params)
            elif method == "agent.cancel":
                data = await runtime.cancel(params)
            elif method == "agent.submit_approval":
                data = await runtime.submit_approval(params)
            elif method == "agent.submit_user_input":
                data = await runtime.submit_user_input(params, context)
            elif method == "agent.dismiss_user_input":
                data = await runtime.dismiss_user_input(params, context)
            elif method == "agent.operation_completed":
                data = await runtime.operation_completed(params)
            else:
                return {"ok": False, "code": "UNKNOWN_METHOD", "message": f"Unknown method: {method}"}
            if request_id and method in {"agent.chat", "agent.recover_chat", "agent.retry_chat_summary"}:
                response_failed = getattr(data, "status", None) == "failed"
                append_progress(request_id, "finalizing", {
                    "type": "request_failed" if response_failed else "request_completed",
                    "stage": "finalization",
                    "displayName": "请求处理失败" if response_failed else "请求处理完成",
                    "status": "failed" if response_failed else "completed",
                })
                activities = [
                    event for event in (progress_states.get(request_id) or {}).get("events", [])
                    if event.get("type")
                ]
                if hasattr(data, "activities"):
                    data.activities = activities
            return {"ok": True, "code": "OK", "message": "ok", "data": data.model_dump() if hasattr(data, "model_dump") else data}
        except asyncio.CancelledError:
            if request_id:
                append_progress(request_id, "cancelled", {
                    "type": "request_cancelled", "stage": "finalization",
                    "displayName": "请求已取消", "status": "cancelled",
                })
            return {"ok": False, "code": "CANCELLED", "message": "Agent chat was cancelled"}
        except AgentSkillError as error:
            return {"ok": False, "code": error.code, "message": error.message}
        except AgentRequestError as error:
            if request_id:
                append_progress(request_id, "finalizing", {
                    "type": "request_failed", "stage": "finalization",
                    "displayName": error.failure.user_message, "status": "failed",
                    "details": {"errorCode": error.failure.code},
                })
            return {
                "ok": False,
                "code": error.failure.code,
                "message": error.failure.user_message,
                "data": error.failure.payload(),
            }
        except Exception as error:
            if request_id:
                append_progress(request_id, "finalizing", {
                    "type": "request_failed", "stage": "finalization",
                    "displayName": str(error), "status": "failed",
                })
            return {"ok": False, "code": "AGENT_RUNTIME_ERROR", "message": str(error)}
        finally:
            if request_id and active_requests.get(request_id) is current_task:
                active_requests.pop(request_id, None)

    @app.get("/progress/{request_id}")
    async def progress(request_id: str, afterSequence: int = 0, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        check_auth(authorization)
        state = progress_states.get(request_id) or {"sequence": 0, "events": []}
        events = [event for event in state.get("events", []) if int(event.get("sequence") or 0) > afterSequence]
        return {"ok": True, "code": "OK", "message": "ok", "data": {"events": events}}

    @app.post("/cancel")
    async def cancel_request(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
        check_auth(authorization)
        request_id = str(payload.get("requestId") or "").strip()
        if not request_id:
            return {"ok": False, "code": "INVALID_INPUT", "message": "requestId is required"}
        try:
            await runtime.cancel_chat_request(request_id)
        finally:
            task = active_requests.get(request_id)
            if task:
                task.cancel()
        return {
            "ok": True,
            "code": "OK",
            "message": "cancelled" if task else "request not active",
            "data": {"requestId": request_id, "cancelled": bool(task)},
        }

    @app.get("/events/{run_id}")
    async def events(run_id: str, afterSequence: int = 0, authorization: str | None = Header(default=None)) -> StreamingResponse:
        check_auth(authorization)

        async def stream():
            async for event in runtime.event_stream(run_id, afterSequence):
                yield serialize_sse_event(event)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", default=os.environ.get("NOVEL_AGENT_TOKEN", ""))
    parser.add_argument("--automation-runtime", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument(
        "--tool-transport",
        choices=["fastmcp", "http"],
        default=os.environ.get("NOVEL_AGENT_TOOL_TRANSPORT", "fastmcp"),
    )
    return parser.parse_args()


def main() -> None:
    os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")
    args = parse_args()
    report_progress("initializing_state")
    store = AgentStateStore(Path(args.state_dir))
    event_bus = AgentEventBus(store)
    automation = AutomationClient(Path(args.automation_runtime))
    report_progress("loading_tools")
    tool_adapter = FastMcpAgentToolAdapter(automation) if args.tool_transport == "fastmcp" else HttpAgentToolAdapter(automation)
    report_progress("restoring_state")
    runtime = NovelAgentRuntime(store, automation, event_bus, tool_adapter=tool_adapter)
    report_progress("starting_server")
    app = build_app(runtime, args.token or None)

    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="info")
    server = uvicorn.Server(config)
    server.run()


if __name__ == "__main__":
    main()
