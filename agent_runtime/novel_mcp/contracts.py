"""Shared, versioned tool catalog consumed by external and internal adapters."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_tool_contracts(profile: str) -> list[dict[str, Any]]:
    if profile not in {"external_mcp", "internal_agent"}:
        raise ValueError(f"Unknown MCP tool profile: {profile}")
    packaged = Path(__file__).with_name("catalog.json")
    source = Path(__file__).resolve().parents[2] / "contracts" / "tools" / "catalog.json"
    catalog = json.loads((packaged if packaged.is_file() else source).read_text(encoding="utf-8"))
    if catalog.get("schemaVersion") != 1:
        raise ValueError("Unsupported tool catalog version")
    tools = []
    seen = set()
    for entry in catalog["tools"]:
        name = entry["name"]
        if name in seen:
            raise ValueError(f"Duplicate tool: {name}")
        seen.add(name)
        if profile in entry["profiles"]:
            tool = {key: value for key, value in entry.items() if key != "profiles"}
            tool.update(entry["profiles"][profile])
            tools.append(tool)
    return sorted(tools, key=lambda tool: tool["order"])
