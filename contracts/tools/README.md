# Shared tool catalog

`catalog.json` is the source for the Python external gateway, internal Agent manifest,
and Electron external-call validation. It is copied into `novel_mcp/catalog.json`
only when building the frozen executable; no generated runtime copy is committed.

Each tool has common fields and explicit `profiles` overrides. Profiles preserve
existing external and internal schemas and ordering where the two APIs differ;
adding a tool to one profile never exposes it to another automatically.

Current migration: 31 external tools, 36 internal tools, 50 unique names.
The external gateway uses `/mcp/invoke`, where Electron enforces this profile
independently of the submitted origin. Internal Agent policies remain in force.

Run `agent_runtime/.venv/Scripts/python.exe -m pytest agent_runtime/tests/test_mcp_stdio.py`
on Windows (or `.venv/bin/python` on POSIX) to validate schemas, profile isolation,
and real SDK stdio calls, cancellation and launchers.

The first migration preserves existing nested object schemas and result shapes.
Broad output schemas and legacy nested inputs should be refined per business tool;
this catalog does not claim that all UI capabilities have been exposed.
