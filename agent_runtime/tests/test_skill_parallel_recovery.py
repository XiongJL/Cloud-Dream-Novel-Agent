from __future__ import annotations

import asyncio
from collections import Counter

import pytest

from novel_agent_runtime.skill_analysis_graph import SkillAnalysisGraph, SkillWorkUnitStore
from novel_agent_runtime.skill_execution import STYLE_EXECUTION_HINTS
from novel_agent_runtime.toolchains.schemas import ToolchainError
from test_skill_analysis_graph import POLICY, analysis, chapters


def test_failed_parallel_unit_does_not_cancel_or_repeat_valid_siblings(tmp_path):
    async def scenario():
        graph = SkillAnalysisGraph(tmp_path / "graph.db", SkillWorkUnitStore(tmp_path / "units.db"))
        calls = Counter()
        fail = True

        async def read(chapter):
            return {**chapter, "contentMode": "full", "content": "原文"}

        async def model(kind, payload, _key):
            nonlocal fail
            if kind == "merge":
                return payload["source"]["results"][0]
            source_id = payload["source"]["samples"][0]["sourceId"]
            calls[source_id] += 1
            if source_id == "chapter-1" and fail:
                fail = False
                raise ToolchainError("MODEL_OUTPUT_INVALID", "one unit failed")
            await asyncio.sleep(0.01)  # These siblings must be allowed to commit.
            return analysis(source_id)

        async def progress(_payload):
            pass

        kwargs = dict(owner="run", chapters=chapters(6), goal="Analyze", skill_hash="locked",
            hints=STYLE_EXECUTION_HINTS, policy=POLICY, read=read, model=model,
            progress=progress, check_cancelled=lambda: None)
        with pytest.raises(ToolchainError, match="one unit failed"):
            await graph.run(**kwargs)
        assert calls == Counter({"chapter-0": 1, "chapter-1": 1, "chapter-2": 1})
        result = await graph.run(**kwargs)
        assert result["coverage"]["analyzedChapterCount"] == 6
        assert calls == Counter({f"chapter-{i}": 2 if i == 1 else 1 for i in range(6)})

    asyncio.run(scenario())
