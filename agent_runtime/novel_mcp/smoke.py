"""Exercise the real gateway using the official MCP SDK client."""
from __future__ import annotations

import argparse
import asyncio
from datetime import timedelta
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def smoke(command, arguments, *, tool="novel.list", tool_args=None, list_only=False, runtime_file=None):
    env = dict(os.environ)
    if runtime_file:
        env["NOVEL_EDITOR_RUNTIME_FILE"] = runtime_file
    params = StdioServerParameters(
        command=command, args=arguments, env=env,
        cwd=str(Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1]),
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=300)) as session:
            initialized = await session.initialize()
            tools = await session.list_tools()
            report = {"protocolVersion": initialized.protocolVersion, "toolCount": len(tools.tools)}
            if not list_only:
                result = await session.call_tool(tool, tool_args or {})
                report.update({"tool": tool, "isError": result.isError, "result": result.structuredContent})
                if result.isError:
                    raise RuntimeError(json.dumps(report, ensure_ascii=False))
            return report


async def smoke_http(url, *, tool="novel.list", tool_args=None, list_only=False):
    import httpx
    from mcp.client.streamable_http import streamable_http_client
    token = os.environ["NOVEL_MCP_HTTP_TOKEN"]
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}, timeout=300) as client:
        async with streamable_http_client(url, http_client=client) as (read, write, _):
            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=300)) as session:
                initialized = await session.initialize()
                tools = await session.list_tools()
                report = {"protocolVersion": initialized.protocolVersion, "toolCount": len(tools.tools)}
                if not list_only:
                    result = await session.call_tool(tool, tool_args or {})
                    report.update({"tool": tool, "isError": result.isError, "result": result.structuredContent})
                    if result.isError:
                        raise RuntimeError(json.dumps(report, ensure_ascii=False))
                return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Test the Python MCP stdio gateway")
    parser.add_argument("--command", default=sys.executable)
    parser.add_argument("--url", help="Streamable HTTP URL; token comes from NOVEL_MCP_HTTP_TOKEN")
    parser.add_argument("--args", help="JSON command arguments")
    parser.add_argument("--tool", default="novel.list")
    parser.add_argument("--tool-args", default="{}")
    parser.add_argument("--runtime-file")
    parser.add_argument("--list-only", action="store_true")
    args = parser.parse_args(argv)
    command_args = json.loads(args.args) if args.args is not None else (
        ["--mode", "mcp-stdio"] if getattr(sys, "frozen", False) else ["-m", "novel_mcp"]
    )
    report = asyncio.run(smoke_http(
        args.url, tool=args.tool, tool_args=json.loads(args.tool_args), list_only=args.list_only,
    ) if args.url else smoke(
        args.command, command_args, tool=args.tool, tool_args=json.loads(args.tool_args),
        list_only=args.list_only, runtime_file=args.runtime_file,
    ))
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
