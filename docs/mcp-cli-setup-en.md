# MCP connection

Streamable HTTP is the primary transport. stdio remains a compatibility option. Both use the same Python FastMCP gateway, tool contracts and desktop business services.

## Connect

1. Open **Settings → AI → MCP CLI** in the desktop app.
2. Turn on **Enable MCP** and wait until Streamable HTTP is ready.
3. Copy the connection instruction to an Agent on this computer that supports Streamable HTTP. Alternatively copy the HTTP JSON and adapt it to the client's configuration format.
4. List the tools in the client. Currently 31 tools are exposed; broader writing and high-level Agent delegation remain separate delivery stages.

The default URL is `http://127.0.0.1:18765/mcp`. Use the actual URL shown in Settings. Each request needs `Authorization: Bearer <local token>`; the copied instruction includes it. For clients supporting this configuration shape:

```json
{
  "mcpServers": {
    "novel_editor": {
      "url": "http://127.0.0.1:18765/mcp",
      "headers": { "Authorization": "Bearer <local token>" }
    }
  }
}
```

Keep the desktop running. Loopback URLs work only on the same computer. A remote/cloud Agent cannot access this app using its own `127.0.0.1`. An occupied port is reported as an error; retry after releasing it or change the port in advanced settings and update the client URL.

## Enable switch

Changes take effect and save immediately. Disabling stops HTTP and makes existing stdio tool calls return `MCP_DISABLED`. Active external requests receive cancellation signals; already accepted persistent tasks and completed writes are not automatically undone. Internal Agent tools remain available. Switching the AI provider or leaving Settings does not change this switch.

The switch, port and random local token persist in `userData/mcp/settings.json`. The HTTP token is separate from the internal Automation token. Existing external access remains enabled by default; malformed configuration disables access until explicitly re-enabled.

**Test MCP** uses the official Python MCP SDK to initialize the HTTP session, list tools and perform the read-only `novel.list` call. It does not call a model or modify a novel.

## stdio compatibility

Expand **Port and stdio compatibility** and copy the fallback configuration. The app generates the actual installed launcher path. Windows uses `mcp/novel-editor-mcp.cmd`; macOS/Linux use `mcp/novel-editor-mcp.sh`. Packaged users do not need system Python or Node.

For development, run `uv sync --frozen --project agent_runtime --extra dev`. From the repository root:

```powershell
pnpm mcp:config
& .\apps\desktop\scripts\novel-editor-mcp.cmd --smoke --list-only
& .\apps\desktop\scripts\novel-editor-mcp.cmd --smoke --tool novel.list
```

The first command prints stdio fallback configurations. Tool discovery does not require a running desktop; actual calls require the app and enabled MCP. stdio discovers `automation/runtime.json` or accepts `NOVEL_EDITOR_RUNTIME_FILE` / `--runtime-file`. That descriptor contains the internal Automation connection, not the public MCP HTTP URL.

FastMCP 3.4.3 / mcp 1.28.1 have been verified with negotiated protocol 2025-11-25. The desktop remains the sole business data source. The gateway does not access the novel database or create a LangGraph runtime per client. See the [requirements](agent/mcp-application-capabilities-requirements.md) and [HTTP acceptance record](agent/acceptance-mcp-http-2026-10-19.md).
