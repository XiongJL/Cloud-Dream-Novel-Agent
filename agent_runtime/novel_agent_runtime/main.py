from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse

from .automation import AutomationClient
from .events import AgentEventBus, serialize_sse_event
from .retry import AgentRequestError
from .runtime import NovelAgentRuntime
from .schemas import AgentEnvelope
from .store import AgentStateStore
from .tool_adapter import FastMcpAgentToolAdapter, HttpAgentToolAdapter


def report_progress(phase: str) -> None:
    print(
        "@@NOVEL_AGENT_PROGRESS@@" + json.dumps({"phase": phase}, ensure_ascii=False),
        flush=True,
    )


def build_app(runtime: NovelAgentRuntime, token: str | None) -> FastAPI:
    app = FastAPI(title="CloudDream Novel Agent Runtime", version="0.1.0")

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
                "capabilities": ["agent.roles", "agent.chat", "agent.plan", "agent.register_plan", "agent.revise_plan", "agent.execute_plan", "agent.retry_run", "agent.revise_draft", "agent.regenerate_batch", "agent.inspect_side_effect", "agent.reconcile_side_effect", "agent.run_status", "agent.cancel", "agent.submit_approval", "agent.events"],
                "toolTransport": runtime.tool_transport,
            },
        }

    @app.post("/invoke")
    async def invoke(envelope: AgentEnvelope, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        check_auth(authorization)
        try:
            method = envelope.method
            params = envelope.params
            context = envelope.context.model_dump()
            if method == "agent.roles":
                data = runtime.roles(params, context)
            elif method == "agent.chat":
                data = await runtime.chat(params, context)
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
            else:
                return {"ok": False, "code": "UNKNOWN_METHOD", "message": f"Unknown method: {method}"}
            return {"ok": True, "code": "OK", "message": "ok", "data": data.model_dump() if hasattr(data, "model_dump") else data}
        except AgentRequestError as error:
            return {
                "ok": False,
                "code": error.failure.code,
                "message": error.failure.user_message,
                "data": error.failure.payload(),
            }
        except Exception as error:
            return {"ok": False, "code": "AGENT_RUNTIME_ERROR", "message": str(error)}

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
