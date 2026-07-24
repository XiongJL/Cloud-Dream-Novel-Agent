# CloudDream Novel Agent Runtime

Python runtime for the built-in CloudDream Novel Agent product.

Current scope:

- FastAPI control API.
- Template-based Supervisor planning.
- FastMCP Agent tool adapter with Automation HTTP upstream and HTTP fallback.
- SQLite-first local agent state.
- Draft-first execution through existing `AutomationService`.

Run in development:

```powershell
cd agent_runtime
python -m venv .venv
.\.venv\Scripts\pip install -e .[dev]
.\.venv\Scripts\python -m novel_agent_runtime --automation-runtime "C:\path\to\runtime.json" --state-dir "C:\path\to\agent"
```
