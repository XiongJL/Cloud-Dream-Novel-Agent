# CloudDream Novel Agent MCP CLI Setup

This document describes the currently working local MCP setup for `Codex`, `Claude Code`, and compatible MCP clients.

The design is:

- The desktop app remains the only real data source
- External CLIs do not connect to SQLite directly
- A local stdio MCP bridge forwards tool calls to the running desktop app

## How It Works

After the desktop app starts, it writes a local runtime file under `userData`:

- Dev mode:
  `C:\Users\<you>\AppData\Roaming\@novel-editor\desktop-dev\automation\runtime.json`

That file contains:

- the local automation port
- a temporary bearer token
- the current desktop app process id

The MCP bridge reads that runtime file automatically, so you do not need to put the port or token into your CLI config.

## Start Order

1. Start the desktop app first:

```bash
pnpm dev
```

or desktop-only:

```bash
pnpm dev:desktop
```

2. Confirm the runtime file exists:

```powershell
Get-Content "$env:APPDATA\@novel-editor\desktop-dev\automation\runtime.json"
```

3. Then start your MCP client.

## Runtime Notes

- The runtime port and token change every time the desktop app starts.
- The MCP bridge reads the latest runtime automatically.
- If you restart the desktop app, restart the CLI client too.

## In-App Settings Behavior (MCP CLI Mode)

In `Settings -> AI -> MCP CLI`, current behavior is:

- Legacy manual fields are removed from UI:
  - CLI executable path
  - working directory
  - startup args template
  - environment JSON
- The panel now shows copy-ready snippets only:
  - Codex `config.toml`
  - Claude Code registration command
  - generic `mcpServers` JSON
- `Test MCP` now validates bridge readiness (launcher + runtime + automation invoke), not the old MCP CLI launch template.

In `HTTP API` mode:

- Preset buttons are only shown in HTTP mode
- "Advanced / Summary Strategy / Proxy" cards are collapsed by default
- `Test Connection / Test Proxy / Test Generate` are only shown in HTTP mode

## Codex

From repo root, generate ready-to-paste config first (no manual absolute path typing):

```bash
pnpm mcp:config
```

Recommended config for `~/.codex/config.toml`:

```toml
[mcp_servers.novel_editor]
command = "cmd"
args = ["/c", "D:\\aiproject\\novalEditor\\apps\\desktop\\scripts\\novel-editor-mcp.cmd"]
startup_timeout_sec = 60
```

Before launching `codex`, set the Node path in the same terminal:

```powershell
$env:NOVEL_EDITOR_NODE_EXE = "D:\all_install\node.js\node.exe"
codex
```

Why the wrapper is recommended:

- Windows MCP clients can be picky about `node + .mjs`
- the wrapper resolves `node.exe`
- the wrapper also enables bridge logging automatically

## Claude Code

Recommended setup on Windows:

```powershell
claude mcp remove novel-editor
claude mcp add novel-editor --scope local -- cmd /c D:\aiproject\novalEditor\apps\desktop\scripts\novel-editor-mcp.cmd
```

Or print the exact command dynamically:

```bash
pnpm mcp:config -- --format claude
```

You can verify it with:

```bash
claude mcp list
claude mcp get novel-editor
```

## Generic MCP JSON Config

For clients that support `mcpServers` JSON:

```json
{
  "mcpServers": {
    "novel-editor": {
      "command": "cmd",
      "args": [
        "/c",
        "D:\\aiproject\\novalEditor\\apps\\desktop\\scripts\\novel-editor-mcp.cmd"
      ],
      "env": {
        "NOVEL_EDITOR_NODE_EXE": "D:\\all_install\\node.js\\node.exe"
      }
    }
  }
}
```

You can also print the JSON snippet directly:

```bash
pnpm mcp:config -- --format json
```

## OpenClaw

If your OpenClaw build supports standard MCP client config, use the same `mcpServers` structure shown above.

If your OpenClaw build still expects its older local integration route, keep using that route for now. The MCP bridge does not replace any existing OpenClaw-specific path yet.

## What Works Right Now

The bridge currently exposes tools for:

- listing novels, volumes, chapters, plotlines, characters, items, world settings, maps
- reading chapter content
- creating and saving chapters
- creating/updating world settings (MCP delete is intentionally disabled)
- generating internal AI drafts
- reading, updating, committing, and discarding draft sessions
- writing externally generated outline/character/story patch data back into the app

Typical working flow:

1. Start the desktop app
2. Start Codex or Claude Code with the MCP config above
3. Ask the CLI to call `novel_list`
4. Ask it to call `draft_list`
5. Ask it to call `creative_assets_generate_draft`
6. Review the returned JSON in the terminal or in the app UI
7. Then call `draft_commit` or discard it

## Suggested First Manual Checks

After MCP is connected, try these in order:

1. `novel_list`
2. `draft_list`
3. `creative_assets_generate_draft`

Example natural-language prompts:

- "List all novels with `novel_list`."
- "Call `draft_list` for the current novel."
- "Call `creative_assets_generate_draft` for this novel, generate 3 characters and 1 plotline, but do not commit yet. Show me the JSON."

## Local Diagnostics

### 1. Desktop automation runtime

Check the runtime file:

```powershell
Get-Content "$env:APPDATA\@novel-editor\desktop-dev\automation\runtime.json"
```

### 2. MCP bridge smoke test

Run from the repo root:

```powershell
D:\all_install\node.js\node.exe apps\desktop\scripts\mcp-smoke.mjs --tool draft.list
```

If this succeeds, the desktop app and MCP bridge are both working locally.

### 3. MCP bridge log file

The wrapper writes logs to:

```powershell
$env:TEMP\novel-editor-mcp.log
```

View the latest lines:

```powershell
Get-Content "$env:TEMP\novel-editor-mcp.log" -Tail 200
```

This is useful if a client says MCP startup failed.

## Known Compatibility Notes

- Current `Codex` on Windows sends bare JSON / NDJSON during MCP startup instead of only `Content-Length` framed messages.
- The local bridge now supports both framed MCP messages and bare JSON startup messages.
- During startup, some clients probe `resources/list` and `resources/templates/list`. At the moment the bridge advertises tools only; resources are not used by the CloudDream Novel Agent flow.

## Troubleshooting

### `APP_NOT_RUNNING`

- Make sure the desktop app is still running
- make sure the runtime file exists
- restart the CLI after restarting the desktop app

### MCP starts but tools return no data

- first call `novel_list`
- confirm you are looking at the dev database under:
  `C:\Users\<you>\AppData\Roaming\@novel-editor\desktop-dev\novel_editor.db`

### Codex or Claude Code times out on startup

- use the `.cmd` wrapper, not direct `.mjs`
- set `NOVEL_EDITOR_NODE_EXE` before launching the client
- inspect `$env:TEMP\novel-editor-mcp.log`

### `fetch failed` in connection or generate tests

This usually means HTTP provider connection timeout (for example `UND_ERR_CONNECT_TIMEOUT`), commonly caused by:

- the configured `baseUrl` is not reachable from current network
- proxy mode/values are incorrect
- DNS resolves but port 443 is blocked/unreachable

Recommended checks:

1. verify `baseUrl` and `apiKey` in `HTTP API` mode
2. verify proxy mode (`system/off/custom`) matches your environment
3. test port reachability (for example `Test-NetConnection <host> -Port 443`)
4. run in-app `Test Connection` again and read the detailed error text

