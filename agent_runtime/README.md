# CloudDream Novel Agent Runtime

Python runtime for the built-in CloudDream Novel Agent product.

Current scope:

- FastAPI control API.
- Template-based Supervisor planning.
- FastMCP Agent tool adapter with Automation HTTP upstream and HTTP fallback.
- SQLite-first local agent state.
- Draft-first execution through existing `AutomationService`.
- Independent FastMCP stdio gateway; shared external/internal tool contracts.

MCP gateway (from `agent_runtime`, after syncing the project environment):

```powershell
.\.venv\Scripts\python -m novel_mcp
.\.venv\Scripts\python -m novel_mcp --smoke --list-only
```

Streamable HTTP is the default external entry. The desktop manages a loopback-only
FastMCP process at `http://127.0.0.1:18765/mcp` (configurable port) and persists the
enable switch, port and local Bearer token in `userData/mcp/settings.json`.
Use Settings → AI → MCP CLI to enable/disable access and copy the connection instruction.
Disabling closes HTTP and blocks external stdio calls; the internal Agent remains available.

The packaged executable supports `--mode mcp-http` and `--mode mcp-stdio`. Both dispatch before the
Agent startup imports, prints no startup progress on stdout, and does not create
another Agent runtime. Ordinary tool calls use the running Electron app's
`/mcp/invoke` route. The gateway discovers `runtime.json` on each new call and
pins cancellation to the same desktop instance.

`contracts/tools/catalog.json` is shared by the external gateway (31 tools),
the internal Agent manifest (36 tools), and Electron validation. Existing external
and internal schema differences are explicit profile overrides. FastMCP 3.4.3 /
MCP SDK 1.28.1 are retained; the verified negotiated revision is 2025-11-25.
Support for revision 2026-07-28 is a subsequent compatibility task, not implied.

Run in development:

```powershell
cd agent_runtime
python -m venv .venv
.\.venv\Scripts\pip install -e .[dev]
.\.venv\Scripts\python -m novel_agent_runtime --automation-runtime "C:\path\to\runtime.json" --state-dir "C:\path\to\agent"
```

## Novel document export

`document_exporter` is an independent, offline Python worker for TXT and DOCX generation. Electron saves editor changes, reads a consistent database snapshot, and uses the shared Lexical converter before invoking the worker. The worker receives book metadata and paragraphs, never the business database or the final user-selected path.

Development uses this directory's `.venv` by default; `NOVEL_DOCUMENT_EXPORTER_PYTHON` can select another Python executable with the project dependencies installed. Packaged apps use `agent-runtime/document-exporter/document-exporter[.exe]` and do not need a system Python installation. The existing runtime build script builds and smoke-tests this worker alongside the Agent runtime and document extractor.

Run exporter tests with `.venv/Scripts/python.exe -m pytest tests/test_document_exporter.py -q` on Windows (use `.venv/bin/python` on macOS). Set `NOVEL_EXPORTER_BINARY` to the packaged executable to include its isolated-environment smoke test. Desktop integration tests: `pnpm --filter novel-editor-desktop run test:novel-export`.
