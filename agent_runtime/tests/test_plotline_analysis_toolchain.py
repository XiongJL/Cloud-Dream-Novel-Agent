from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.tool_adapter import FastMcpAgentToolAdapter
from novel_agent_runtime.toolchains.plotline_analysis import apply_chapter_batch_result

from test_runtime import FakeAutomationClient


def _volumes() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for volume_index in range(1, 3):
        volume_id = f"volume_{volume_index}"
        result.append(
            {
                "id": volume_id,
                "title": f"第{volume_index}卷",
                "order": volume_index,
                "chapters": [
                    {
                        "id": f"chapter_{volume_index}_{chapter_index}",
                        "volumeId": volume_id,
                        "title": f"第{chapter_index}章",
                        "order": chapter_index,
                        "wordCount": 1200,
                    }
                    for chapter_index in range(1, 7)
                ],
            }
        )
    return result


def _chapter(volume_id: str, chapter_index: int, *, long_content: bool = False) -> dict[str, Any]:
    chapter_id = f"chapter_{volume_id.split('_')[-1]}_{chapter_index}"
    paragraph = f"林澈在第{chapter_index}章继续追查旧站广播，白鹿信号再次出现。"
    if long_content:
        paragraph *= 900
    lexical = json.dumps(
        {
            "root": {
                "children": [
                    {
                        "type": "paragraph",
                        "children": [{"type": "text", "text": paragraph}],
                    }
                ]
            }
        },
        ensure_ascii=False,
    )
    return {
        "id": chapter_id,
        "volumeId": volume_id,
        "title": f"第{chapter_index}章",
        "order": chapter_index,
        "wordCount": len(paragraph),
        "content": lexical,
    }


def _analysis(params: dict[str, Any]) -> dict[str, Any]:
    context = params["context"]
    chapter_ids = [item["id"] for item in context["chapters"]]
    return {
        "overallScore": 68,
        "summary": "主线持续推进，但白鹿信号伏笔在覆盖范围内停滞。",
        "threads": [
            {
                "plotlineId": "plot_main",
                "name": "旧站真相",
                "role": "main",
                "status": "推进中",
                "progressionScore": 74,
                "lastProgressLocation": chapter_ids[-1],
                "coveredChapterIds": chapter_ids,
                "findings": ["调查目标明确，连续章节都有新信息。"],
                "evidence": [
                    {
                        "sourceType": "plotline",
                        "sourceId": "plot_main",
                        "title": "旧站真相",
                        "excerpt": "主线登记为进行中",
                    },
                    {
                        "sourceType": "chapter",
                        "sourceId": "fabricated_chapter",
                        "title": "不存在章节",
                        "excerpt": "模型伪造证据",
                    },
                ],
                "recommendations": ["下一批章节揭示广播来源的可验证线索。"],
            }
        ],
        "issues": [
            {
                "issueId": "issue-1",
                "type": "unresolved_foreshadowing",
                "severity": "high",
                "title": "白鹿信号缺少阶段性回收",
                "plotlineIds": ["plot_signal"],
                "chapterIds": chapter_ids[-2:],
                "evidence": [],
                "recommendation": "在下一结构节点确认信号来源或代价。",
                "uncertainty": "未覆盖后续章节，不能判断是否已在更后处回收。",
            },
            {
                "issueId": "issue-duplicate",
                "type": "unresolved_foreshadowing",
                "severity": "medium",
                "title": "白鹿信号缺少阶段性回收",
                "recommendation": "重复项应被去除。",
            },
        ],
        "recommendations": ["先处理高风险未回收伏笔，再扩展新支线。"],
        "warnings": [],
        "coverage": {"analyzedChapterCount": 999},
    }


def test_chapter_batch_drops_unplanned_rows_and_records_missing_coverage() -> None:
    state = {
        "batches": [
            {
                "kind": "volume_batch",
                "volumeId": "volume_1",
                "offset": 0,
                "limit": 2,
                "expectedChapterIds": ["chapter_1_1", "chapter_1_2"],
            }
        ],
        "batchIndex": 0,
        "chapters": [],
        "coverage": {"analyzedChapterCount": 0, "omittedChapterCount": 0},
        "warnings": [],
        "sourceStatus": {},
        "toolCallCount": 0,
        "estimatedTokens": 0,
    }

    updated = apply_chapter_batch_result(
        state,
        [
            _chapter("volume_1", 1),
            {**_chapter("volume_1", 3), "id": "chapter_outside_scope"},
        ],
        max_estimated_tokens=10_000,
    )

    assert [item["id"] for item in updated["chapters"]] == ["chapter_1_1"]
    assert updated["coverage"]["analyzedChapterCount"] == 1
    assert updated["coverage"]["omittedChapterCount"] == 1
    assert updated["sourceStatus"]["chapter.batch.1"] == "partial"
    assert any("缺失 1 章" in warning for warning in updated["warnings"])
    assert any("丢弃 1 条" in warning for warning in updated["warnings"])


def _tool_result(method: str, params: dict[str, Any], *, long_content: bool = False) -> Any:
    if method == "plotline.list":
        return [
            {"id": "plot_main", "name": "旧站真相", "role": "main", "status": "active"},
            {"id": "plot_signal", "name": "白鹿信号", "role": "subplot", "status": "active"},
        ]
    if method == "volume.list":
        return _volumes()
    if method == "chapter.get":
        return _chapter("volume_1", 1, long_content=long_content)
    if method == "chapter.list":
        offset = int(params.get("offset") or 0)
        limit = int(params.get("limit") or 20)
        return [
            _chapter(params["volumeId"], index, long_content=long_content)
            for index in range(offset + 1, min(6, offset + limit) + 1)
        ]
    if method == "rag.ask":
        return {
            "answer": "白鹿信号在已覆盖章节中多次出现，但没有解释来源。",
            "evidence": [
                {
                    "sourceType": "chapter",
                    "sourceId": "chapter_1_2",
                    "title": "第二章",
                    "excerpt": "白鹿信号再次出现",
                    "confidence": 0.93,
                }
            ],
        }
    return {"ok": True}


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(1400):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Plotline analysis did not reach a terminal state")


async def _wait_approval(runtime: NovelAgentRuntime, run_id: str) -> dict[str, Any]:
    for _ in range(1000):
        run = runtime.state.runs[run_id]
        task = runtime._run_tasks.get(run_id)  # noqa: SLF001
        if run.pendingApproval and run.pendingApproval.get("checkpointType") == "analysis_scope" and (task is None or task.done()):
            return run.pendingApproval
        if run.status in {"completed", "failed", "cancelled"}:
            raise AssertionError("Run ended before analysis scope approval")
        await asyncio.sleep(0.01)
    raise AssertionError("Plotline analysis did not request scope approval")


def _configure_automation(
    automation: FakeAutomationClient,
    *,
    chain_input: dict[str, Any],
    long_content: bool = False,
) -> None:
    async def invoke(
        method: str,
        params: dict[str, Any],
        origin: str,
        request_id: str | None = None,
    ) -> Any:
        automation.calls.append((method, params, origin))
        if request_id:
            automation.request_ids.append(request_id)
        if method == "agent.generate_plan":
            return {
                "title": "情节线分析",
                "deliverable": "report",
                "steps": [
                    {
                        "agent": "editor",
                        "title": "分批分析主线、支线与伏笔",
                        "tools": [],
                        "toolchain": {
                            "id": "plotline.analysis",
                            "version": "1.0.0",
                            "input": chain_input,
                        },
                    }
                ],
            }
        if method == "agent.generate_plotline_analysis":
            return _analysis(params)
        if method == "agent.generate_report":
            return {"content": "## 情节线结论\n\n结构化分析已生成，请在 Inspector 查看。"}
        if method in {"agent.generate_chat", "agent.revise_plan", "agent.detect_creative_direction"}:
            return await FakeAutomationClient.invoke(automation, method, params, origin, request_id=request_id)
        return _tool_result(method, params, long_content=long_content)

    automation.invoke = invoke  # type: ignore[method-assign]


@pytest.mark.parametrize("transport", ["http", "fastmcp"])
def test_plotline_analysis_batches_volume_on_both_transports_and_publishes_structured_artifact(
    tmp_path: Path,
    transport: str,
) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path / transport)
        automation = FakeAutomationClient()
        _configure_automation(automation, chain_input={"batchSize": 2, "maxChapters": 20})
        adapter = FastMcpAgentToolAdapter(automation) if transport == "fastmcp" else None
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store), tool_adapter=adapter)
        plan = await runtime.plan(
            {"goal": "分析当前卷的主线支线与伏笔回收", "role": "editor"},
            {"volumeId": "volume_1"},
        )
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "plotline.analysis"

        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed"
        chapter_calls = [params for method, params, _ in automation.calls if method == "chapter.list"]
        rag_call = next(params for method, params, _ in automation.calls if method == "rag.ask")
        assert [(item["offset"], item["limit"]) for item in chapter_calls] == [(0, 2), (2, 2), (4, 2)]
        assert all(item["includeContent"] is True for item in chapter_calls)
        assert rag_call["analysisScope"] == "volume_structure"
        artifact = next(item for item in completed.artifacts if item.type == "plotline_analysis")
        analysis = artifact.metadata["analysis"]
        assert analysis["coverage"]["analyzedChapterCount"] == 6
        assert analysis["coverage"]["omittedChapterCount"] == 0
        assert len(analysis["issues"]) == 1
        assert [item["sourceId"] for item in analysis["threads"][0]["evidence"]] == ["plot_main"]
        assert not any(item.type in {"chapter_draft", "creative_assets_draft"} for item in completed.artifacts)
        assert [record.method for record in store.list_invocations(run.runId)] == []

    asyncio.run(scenario())


def test_ambiguous_scope_waits_before_tools_and_survives_runtime_restart(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        # A model-supplied whole-novel hint must not bypass explicit scope approval.
        _configure_automation(automation, chain_input={"batchSize": 3, "scope": "novel"})
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({"goal": "检查主线推进和伏笔", "role": "editor"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_1_3",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        pending = await _wait_approval(runtime, run.runId)
        assert {item["id"] for item in pending["options"]} == {
            "plot_current_chapter",
            "plot_current_volume",
            "plot_whole_novel",
        }
        assert not any(method == "plotline.list" for method, _, _ in automation.calls)

        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        assert runtime.state.runs[run.runId].status == "waiting_approval"
        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": pending["checkpointId"],
                "selectedOptionIds": ["plot_current_volume"],
            }
        )
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]
        artifact = next(item for item in completed.artifacts if item.type == "plotline_analysis")

        assert completed.status == "completed"
        assert artifact.metadata["analysis"]["scope"] == "volume"
        assert len([call for call in automation.calls if call[0] == "chapter.list"]) == 2

    asyncio.run(scenario())


def test_whole_novel_scope_honors_chapter_and_token_budgets(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        _configure_automation(
            automation,
            chain_input={
                "scope": "novel",
                "batchSize": 4,
                "maxChapters": 5,
                "maxEstimatedTokens": 4000,
            },
            long_content=True,
        )
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({"goal": "分析整本小说的长期停滞情节线", "role": "editor"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]
        artifact = next(item for item in completed.artifacts if item.type == "plotline_analysis")
        analysis = artifact.metadata["analysis"]
        chapter_calls = [params for method, params, _ in automation.calls if method == "chapter.list"]

        assert completed.status == "completed"
        assert 1 <= len(chapter_calls) <= 2
        assert analysis["coverage"]["availableChapterCount"] == 12
        assert analysis["coverage"]["omittedChapterCount"] >= 7
        assert analysis["coverage"]["analyzedChapterCount"] <= 5
        assert any("maxChapters=5" in warning or "预算" in warning for warning in analysis["warnings"])
        assert not any(method == "chapter.generate_draft" for method, _, _ in automation.calls)

    asyncio.run(scenario())
