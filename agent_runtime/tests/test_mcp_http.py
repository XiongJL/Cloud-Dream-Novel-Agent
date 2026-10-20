from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import timedelta
import os
import socket
import subprocess
import sys
import time

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import ClientNotification, CancelledNotification, CancelledNotificationParams

from test_mcp_stdio import ROOT, desktop  # reuse the isolated Automation fixture

TOKEN = 'isolated-http-token-' + 'a' * 32


@contextmanager
def gateway(runtime, tmp_path):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    frozen = os.environ.get('NOVEL_MCP_PACKAGED_EXE')
    command = [frozen, '--mode', 'mcp-http'] if frozen else [sys.executable, str(ROOT / 'runtime_entry.py'), '--mode', 'mcp-http']
    log = (tmp_path / 'http.log').open('wb')
    child = subprocess.Popen([*command, '--port', str(port), '--runtime-file', str(runtime), '--parent-stdio'],
                             cwd=ROOT, stdin=subprocess.PIPE, stdout=log, stderr=log,
                             env=dict(os.environ, NOVEL_MCP_HTTP_TOKEN=TOKEN, NOVEL_MCP_INSTANCE='isolated-test'))
    url = f'http://127.0.0.1:{port}'
    try:
        with httpx.Client(headers={'Authorization': f'Bearer {TOKEN}'}, timeout=.5) as client:
            for _ in range(200):
                assert child.poll() is None, (tmp_path / 'http.log').read_text(encoding='utf-8', errors='replace')
                try:
                    if client.get(url + '/health').json().get('instance') == 'isolated-test':
                        break
                except (httpx.HTTPError, ValueError):
                    pass
                time.sleep(.1)
            else:
                raise AssertionError('MCP listener did not become ready')
        yield url, child
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
        log.close()


def test_http_auth_contract_and_parent_lifetime(desktop, tmp_path):
    runtime, calls, _, _ = desktop
    with gateway(runtime, tmp_path) as (url, child):
        assert httpx.get(url + '/health').status_code == 401
        assert httpx.post(url + '/mcp', headers={'Authorization': 'Bearer wrong'}).status_code == 401
        assert httpx.post(url + '/mcp', headers={
            'Authorization': f'Bearer {TOKEN}', 'Origin': 'https://untrusted.example',
        }).status_code == 403

        async def scenario():
            async with httpx.AsyncClient(headers={'Authorization': f'Bearer {TOKEN}'}) as client:
                async with streamable_http_client(url + '/mcp', http_client=client) as (read, write, session_id):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=10)) as session:
                        await session.initialize()
                        assert session_id()
                        tools = await session.list_tools()
                        assert len(tools.tools) == 31
                        result = await session.call_tool('novel.list', {})
                        assert result.structuredContent == {'items': [{'id': 'novel', 'title': '中文小说'}]}
                        assert calls[-1][0] == '/mcp/invoke'
                        before = len(calls)
                        assert (await session.call_tool('chapter.get', {'chapterId': 123})).isError
                        assert (await session.call_tool('agent.generate_chat', {})).isError
                        assert len(calls) == before
                        error = await session.call_tool('chapter.get', {'chapterId': 'error'})
                        assert error.isError and error.structuredContent['code'] == 'VERSION_CONFLICT'
        asyncio.run(scenario())
        child.stdin.close()
        assert child.wait(timeout=5) == 0


def test_http_cancellation_reaches_desktop(desktop, tmp_path):
    runtime, _, started, cancelled = desktop
    with gateway(runtime, tmp_path) as (url, _):
        async def scenario():
            async with httpx.AsyncClient(headers={'Authorization': f'Bearer {TOKEN}'}) as client:
                async with streamable_http_client(url + '/mcp', http_client=client) as (read, write, _):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=10)) as session:
                        await session.initialize()
                        request_id = session._request_id
                        task = asyncio.create_task(session.call_tool('chapter.get', {'chapterId': 'slow'}))
                        assert await asyncio.to_thread(started.wait, 5)
                        await session.send_notification(ClientNotification(CancelledNotification(
                            method='notifications/cancelled', params=CancelledNotificationParams(requestId=request_id))))
                        assert await asyncio.to_thread(cancelled.wait, 5)
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
        asyncio.run(scenario())
