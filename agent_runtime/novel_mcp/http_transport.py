"""Loopback Streamable HTTP transport; the desktop owns this process."""
from __future__ import annotations

import os
import secrets
import threading

from starlette.middleware import Middleware
from starlette.responses import JSONResponse


class BearerAuth:
    def __init__(self, app, token: str):
        self.app = app
        self.expected = f"Bearer {token}".encode("utf-8")

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            authorization = dict(scope.get("headers", [])).get(b"authorization", b"")
            if not secrets.compare_digest(authorization, self.expected):
                response = JSONResponse({"error": "Unauthorized"}, status_code=401,
                                        headers={"WWW-Authenticate": "Bearer"})
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def run_http(server, port: int, *, parent_stdio: bool = False):
    token = os.environ.get("NOVEL_MCP_HTTP_TOKEN", "")
    if len(token) < 32:
        raise ValueError("NOVEL_MCP_HTTP_TOKEN must contain at least 32 characters")
    instance = os.environ.get("NOVEL_MCP_INSTANCE", "")

    @server.custom_route("/health", methods=["GET"])
    async def health(request):
        return JSONResponse({"service": "novel-editor-mcp", "instance": instance})

    if parent_stdio:
        # Electron's pipe closes even after a crash or forced exit. Do not leave
        # a writing endpoint running after its owning desktop has disappeared.
        def watch_parent():
            import sys
            while sys.stdin.buffer.read(1):
                pass
            os._exit(0)
        threading.Thread(target=watch_parent, daemon=True).start()

    server.run(
        transport="http", host="127.0.0.1", port=port, path="/mcp",
        show_banner=False, log_level="WARNING", json_response=True,
        host_origin_protection=True,
        allowed_hosts=[f"127.0.0.1:{port}", f"localhost:{port}"],
        allowed_origins=[f"http://127.0.0.1:{port}", f"http://localhost:{port}"],
        middleware=[Middleware(BearerAuth, token=token)],
        uvicorn_config={"access_log": False},
    )
