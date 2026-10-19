from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from novel_mcp.contracts import load_tool_contracts


@dataclass(frozen=True)
class AgentToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    read_only: bool
    timeout_seconds: float = 90
    idempotent: bool = False


AGENT_TOOL_MANIFEST = tuple(
    AgentToolDefinition(
        name=tool["name"], description=tool["description"],
        input_schema=tool["inputSchema"], read_only=tool["readOnly"],
        timeout_seconds=tool["timeoutSeconds"], idempotent=tool["idempotent"],
    )
    for tool in load_tool_contracts("internal_agent")
)
AGENT_TOOL_BY_NAME = {definition.name: definition for definition in AGENT_TOOL_MANIFEST}
AVAILABLE_AGENT_TOOLS = [definition.name for definition in AGENT_TOOL_MANIFEST]
READ_ONLY_AGENT_TOOLS = [definition.name for definition in AGENT_TOOL_MANIFEST if definition.read_only]
DRAFT_TOOLS = {
    "chapter_draft": "chapter.generate_draft",
    "chapter_draft_batch": "chapter.generate_draft",
    "creative_assets_draft": "creative_assets.generate_draft",
}
