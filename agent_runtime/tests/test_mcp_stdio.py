from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import threading

from jsonschema import Draft202012Validator
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.shared.exceptions import McpError
from mcp.types import ClientNotification, CancelledNotification, CancelledNotificationParams
import pytest

from novel_mcp.contracts import load_tool_contracts
from novel_mcp.connection import DesktopConnection, resolve_runtime_path

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def desktop(tmp_path):
    calls = []
    started = threading.Event()
    cancelled = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, body, self.headers.get("Authorization")))
            if self.path == "/cancel":
                cancelled.set()
                response = {"ok": True, "data": {"cancelled": True}}
            elif body.get("params", {}).get("chapterId") == "slow":
                started.set()
                cancelled.wait(8)
                response = {"ok": True, "data": {"finished": True}}
            elif body.get("params", {}).get("chapterId") == "error":
                response = {"ok": False, "code": "VERSION_CONFLICT", "message": "版本已变化", "data": {"version": 2}}
            else:
                response = {"ok": True, "data": [{"id": "novel", "title": "中文小说"}]}
            encoded = json.dumps(response, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    runtime = tmp_path / "runtime.json"
    runtime.write_text(json.dumps({"port": server.server_port, "token": "isolated-test"}), encoding="utf-8")
    yield runtime, calls, started, cancelled
    cancelled.set()
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)


@asynccontextmanager
async def session_for(runtime, command=None, args=None):
    env = dict(os.environ, NOVEL_EDITOR_RUNTIME_FILE=str(runtime), PYTHONUTF8="1")
    params = StdioServerParameters(
        command=command or sys.executable,
        args=args or [str(ROOT / "runtime_entry.py"), "--mode", "mcp-stdio"],
        cwd=str(ROOT), env=env,
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=15)) as session:
            await session.initialize()
            yield session


def test_contract_profiles_and_schemas():
    external = load_tool_contracts("external_mcp")
    internal = load_tool_contracts("internal_agent")
    assert len(external) == 31
    assert len(internal) == 36
    assert "draft.commit" in {tool["name"] for tool in external}
    assert "draft.commit" not in {tool["name"] for tool in internal}
    for profile in (external, internal):
        assert len({tool["name"] for tool in profile}) == len(profile)
        assert len({tool["order"] for tool in profile}) == len(profile)
        for tool in profile:
            Draft202012Validator.check_schema(tool["inputSchema"])
            assert tool["timeoutSeconds"] > 0
    with pytest.raises(ValueError):
        load_tool_contracts("all")


def test_bootstrap_help_does_not_import_agent_or_print_progress():
    code = """
import runpy, sys
sys.argv = ['runtime_entry.py', '--mode', 'mcp-stdio', '--help']
try:
    runpy.run_path('runtime_entry.py', run_name='__main__')
except SystemExit as e:
    assert e.code == 0
assert 'novel_agent_runtime.__main__' not in sys.modules
from novel_mcp.server import build_mcp_server
build_mcp_server()
assert 'novel_agent_runtime.runtime' not in sys.modules
assert not any(name.startswith('langgraph') for name in sys.modules)
"""
    result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, timeout=15, check=True)
    assert b"@@NOVEL_AGENT_PROGRESS@@" not in result.stdout
    assert b"FastMCP stdio gateway" in result.stdout


def test_bad_frame_recovers_and_unknown_version_is_not_echoed():
    async def scenario():
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(ROOT / "runtime_entry.py"), "--mode", "mcp-stdio",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2099-01-01", "capabilities": {},
                "clientInfo": {"name": "中文客户端", "version": "test"},
            }}
            # Malformed line followed by a valid request, split across writes.
            encoded = (json.dumps(initialize, ensure_ascii=False) + "\n").encode("utf-8")
            process.stdin.write(b"{malformed}\n" + encoded[:40])
            await process.stdin.drain()
            process.stdin.write(encoded[40:])
            await process.stdin.drain()
            while True:
                line = await asyncio.wait_for(process.stdout.readline(), 15)
                assert line, "gateway exited instead of recovering from a bad frame"
                reply = json.loads(line)
                if reply.get("id") == 1:
                    break
            assert reply["result"]["protocolVersion"] != "2099-01-01"
            process.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
            await process.stdin.drain()
            assert json.loads(await asyncio.wait_for(process.stdout.readline(), 5))["id"] == 2
            process.stdin.close()
            assert await asyncio.wait_for(process.wait(), 5) == 0
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    asyncio.run(scenario())


def test_sdk_stdio_discovery_results_validation_errors_and_concurrency(desktop):
    runtime, calls, _, _ = desktop

    async def scenario():
        async with session_for(runtime) as session:
            tools = (await session.list_tools()).tools
            assert len(tools) == 31
            assert next(tool for tool in tools if tool.name == "novel.list").annotations.readOnlyHint
            result = await session.call_tool("novel.list", {})
            assert not result.isError
            assert result.structuredContent == {"items": [{"id": "novel", "title": "中文小说"}]}
            assert json.loads(result.content[0].text) == result.structuredContent
            assert calls[-1][0] == "/mcp/invoke"
            assert calls[-1][2] == "Bearer isolated-test"
            assert calls[-1][1]["origin"] == "mcp-bridge"
            assert calls[-1][1]["deadlineAt"]
            count = len(calls)
            for name, arguments in (("chapter.get", {}), ("chapter.get", {"chapterId": 123}), ("agent.generate_chat", {})):
                try:
                    invalid = await session.call_tool(name, arguments)
                    assert invalid.isError
                except McpError:
                    pass
            assert len(calls) == count, "invalid calls must never reach Electron"
            error = await session.call_tool("chapter.get", {"chapterId": "error"})
            assert error.isError
            assert error.structuredContent["code"] == "VERSION_CONFLICT"
            assert error.structuredContent["details"] == {"version": 2}
            await asyncio.gather(*(session.call_tool("novel.list", {}) for _ in range(3)))
            ids = [body["requestId"] for path, body, _ in calls if path == "/mcp/invoke"]
            assert len(ids) == len(set(ids))

    asyncio.run(scenario())


def test_stdio_cancellation_reaches_pinned_http_request(desktop):
    runtime, calls, started, cancelled = desktop

    async def scenario():
        async with session_for(runtime) as session:
            mcp_request_id = session._request_id
            pending = asyncio.create_task(session.call_tool("chapter.get", {"chapterId": "slow"}))
            assert await asyncio.to_thread(started.wait, 8)
            # Cancelling a local asyncio task is not a wire cancellation in SDK 1.x.
            await session.send_notification(ClientNotification(CancelledNotification(
                params=CancelledNotificationParams(requestId=mcp_request_id, reason="test"),
            )))
            with pytest.raises(McpError):
                await pending
            assert await asyncio.to_thread(cancelled.wait, 6), "MCP cancellation did not reach /cancel"
            invoke = next(body for path, body, _ in calls if path == "/mcp/invoke")
            cancel = next(body for path, body, _ in calls if path == "/cancel")
            assert invoke["requestId"] == cancel["requestId"]
            assert not (await session.call_tool("novel.list", {})).isError

    asyncio.run(scenario())


def test_runtime_connection_pins_cancel_and_rediscovers_next_call(desktop, monkeypatch):
    runtime, _, _, _ = desktop
    monkeypatch.setenv("NOVEL_EDITOR_RUNTIME_FILE", str(runtime))
    first = DesktopConnection(resolve_runtime_path(), 1)
    runtime.write_text(json.dumps({"port": 12345, "token": "successor"}), encoding="utf-8")
    assert first._read_runtime()["token"] == "isolated-test"
    assert DesktopConnection(resolve_runtime_path(), 1)._read_runtime()["token"] == "successor"


@pytest.mark.parametrize("launcher", ["cmd", "node"] if os.name == "nt" else ["sh", "node"])
def test_real_launcher_with_sdk_client(desktop, launcher):
    if not shutil.which(launcher):
        pytest.skip(f"Optional launcher executable unavailable: {launcher}")
    runtime, _, _, _ = desktop
    scripts = ROOT.parent / "apps" / "desktop" / "scripts"
    args = ["/c", str(scripts / "novel-editor-mcp.cmd")] if launcher == "cmd" else [str(scripts / ("novel-editor-mcp.sh" if launcher == "sh" else "novel-editor-mcp.mjs"))]

    async def scenario():
        async with session_for(runtime, launcher, args) as session:
            assert not (await session.call_tool("novel.list", {})).isError

    asyncio.run(scenario())


@pytest.mark.skipif(not os.environ.get("NOVEL_MCP_PACKAGED_EXE"), reason="Set NOVEL_MCP_PACKAGED_EXE after building the frozen runtime")
def test_packaged_launcher_without_system_python_or_node(desktop, tmp_path):
    runtime, calls, _, _ = desktop
    binary = Path(os.environ["NOVEL_MCP_PACKAGED_EXE"]).resolve()
    resources = tmp_path / "中文 resources"
    bundled = resources / "agent-runtime"
    shutil.copytree(binary.parent, bundled)
    launchers = resources / "mcp"
    launchers.mkdir()
    suffix = ".cmd" if os.name == "nt" else ".sh"
    launcher = launchers / ("novel-editor-mcp" + suffix)
    shutil.copy2(ROOT.parent / "apps" / "desktop" / "scripts" / launcher.name, launcher)
    env = dict(os.environ, NOVEL_EDITOR_RUNTIME_FILE=str(runtime), PATH=os.environ.get("SystemRoot", "/usr") + ("\\System32" if os.name == "nt" else "/bin"))
    env.pop("NOVEL_EDITOR_PYTHON_EXE", None)
    command = [os.environ.get("COMSPEC", "cmd.exe"), "/c", str(launcher)] if os.name == "nt" else ["/bin/sh", str(launcher)]
    result = subprocess.run(command + ["--smoke"], env=env, cwd=tmp_path, capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    report = json.loads(result.stdout)
    assert report["toolCount"] == 31
    assert report["result"]["items"][0]["title"] == "中文小说"
    assert b"Traceback" not in result.stderr, result.stderr.decode("utf-8", errors="replace")
    assert calls[-1][0] == "/mcp/invoke"
