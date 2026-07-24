from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.tool_adapter import FastMcpAgentToolAdapter

from test_runtime import FakeAutomationClient


def _read_result(method: str, params: dict[str, Any]) -> Any:
    if method == "chapter.continuation_context.build":
        return {
            "currentContentSource": "顾野带伤抵达旧站，广播里传来陌生人的警告。",
            "hardContext": {
                "plotLines": [{"id": "plot_1", "name": "旧站真相", "status": "active"}],
                "characters": [{"id": "character_1", "name": "顾野", "description": "左腿受伤"}],
                "worldSettings": [{"id": "world_1", "name": "广播禁令"}],
                "items": [{"id": "item_1", "name": "旧站钥匙"}],
                "maps": [],
            },
            "dynamicContext": {
                "recentChapters": [{
                    "chapterId": "chapter_1",
                    "title": "第一章",
                    "excerpt": "顾野左腿受伤。",
                    "contentMode": "full",
                }],
                "currentChapterBeforeCursor": "顾野带伤抵达旧站，广播里传来陌生人的警告。",
                "selectedIdeas": [],
                "selectedIdeaEntities": [],
                "narrativeSummaries": [],
            },
            "params": {"mode": "continue_chapter", "contextChapterCount": 8},
            "policy": {
                "version": "continuation-context-v1",
                "summaryChapterCount": 8,
                "fullTextChapterCount": 2,
                "maxFullTextChars": 12000,
                "maxSummaryChars": 2400,
                "maxCurrentContentChars": 12000,
            },
            "snapshot": {
                "scopeId": "scope_continuation_1",
                "novelId": "novel_1",
                "anchorChapterId": "chapter_2",
                "chapterSources": [{
                    "chapterId": "chapter_2",
                    "volumeId": "volume_1",
                    "title": "第二章",
                    "order": 2,
                    "volumeOrder": 1,
                    "version": 1,
                    "contentHash": "hash_2",
                    "updatedAt": "2026-07-17T00:00:00Z",
                    "source": "database",
                    "contentMode": "full",
                    "summaryFresh": False,
                }],
                "narrativeSummaryIds": [],
                "estimatedTokens": 3200,
                "createdAt": "2026-07-17T00:00:00Z",
            },
            "usedContext": ["continuation-context-v1"],
            "warnings": [],
        }
    if method == "chapter.get":
        return {
            "id": params["chapterId"],
            "volumeId": "volume_1",
            "title": "第二章",
            "content": "顾野带伤抵达旧站，广播里传来陌生人的警告。",
        }
    if method == "volume.list":
        return [{"id": "volume_1", "title": "第一卷"}]
    if method == "chapter.list":
        return [
            {"id": "chapter_1", "order": 1, "title": "第一章", "summary": "顾野受伤。"},
            {"id": "chapter_2", "order": 2, "title": "第二章", "summary": "顾野抵达旧站。"},
        ]
    if method == "plotline.list":
        return [{"id": "plot_1", "name": "旧站真相", "status": "active"}]
    if method == "character.list":
        return [{"id": "character_1", "name": "顾野", "description": "左腿受伤，正在追查广播来源"}]
    if method == "worldsetting.list":
        return [{"id": "world_1", "name": "广播禁令", "rules": "午夜后不得回应公共广播"}]
    if method == "item.list":
        return [{"id": "item_1", "name": "旧站钥匙", "description": "只能打开地下检修层"}]
    if method == "map.list":
        return [{"id": "map_1", "name": "旧站", "description": "废弃地铁换乘站"}]
    if method == "rag.ask":
        return {
            "answer": "第一章确认顾野左腿受伤，旧站钥匙来自失踪的调查员。",
            "confidence": "high",
            "evidence": [
                {
                    "sourceType": "chapter",
                    "sourceId": "chapter_1",
                    "title": "第一章",
                    "excerpt": "左腿无法着力",
                    "confidence": 0.95,
                }
            ],
        }
    return {"ok": True}


def _sequence_beats(count: int = 3) -> list[dict[str, Any]]:
    return [
        {
            "title": f"第 {index + 3} 章",
            "chapterGoal": f"推进第 {index + 1} 个调查节点",
            "coreConflict": f"顾野必须解决冲突 {index + 1}",
            "keyEvents": [f"发现线索 {index + 1}"],
            "reveals": [f"揭示信息 {index + 1}"],
            "endingHook": f"钩子 {index + 1}",
            "targetWordCount": 1800 + index * 100,
        }
        for index in range(count)
    ]


def _sequence_batch(params: dict[str, Any], beats: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "draftBatchId": "batch_sequence_1",
        "novelId": params["novelId"],
        "volumeId": params["volumeId"],
        "anchorChapterId": params["anchorChapterId"],
        "mode": "sequence_continuation",
        "insertionMode": params.get("insertionMode", "after_anchor"),
        "status": "outline_draft",
        "outline": {
            "revision": 1,
            "status": "draft",
            "beats": [
                {**beat, "beatId": f"beat_{index}", "childIndex": index}
                for index, beat in enumerate(beats)
            ],
        },
        "children": [
            {
                "childIndex": index,
                "title": beat["title"],
                "status": "pending",
                "generationRevision": 1,
                **({"dependsOnChildIndex": index - 1} if index else {}),
            }
            for index, beat in enumerate(beats)
        ],
        "stateLedger": {
            "characterLocations": {},
            "relationshipChanges": [],
            "knowledgeState": {},
            "foreshadowing": [],
            "timeline": [],
            "itemStates": {},
            "unresolvedConflicts": [],
        },
        "sourceSnapshot": params.get("sourceSnapshot", []),
        "runId": params.get("runId"),
        "linkedRunIds": [params["runId"]] if params.get("runId") else [],
        "version": 1,
        "createdAt": "2026-07-17T00:00:00Z",
        "updatedAt": "2026-07-17T00:00:00Z",
    }


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(3000):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Draft Toolchain run did not reach a terminal state")


async def _wait_approval(runtime: NovelAgentRuntime, run_id: str, checkpoint_type: str) -> dict[str, Any]:
    for _ in range(1200):
        pending = runtime.state.runs[run_id].pendingApproval
        task = runtime._run_tasks.get(run_id)  # noqa: SLF001
        if pending and pending.get("checkpointType") == checkpoint_type and (task is None or task.done()):
            return pending
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            last_event = runtime.state.runs[run_id].events[-1] if runtime.state.runs[run_id].events else None
            raise AssertionError(f"Draft Toolchain ended before {checkpoint_type} approval: {last_event}")
        await asyncio.sleep(0.01)
    raise AssertionError(f"Draft Toolchain did not reach {checkpoint_type} approval")


@pytest.mark.parametrize("transport", ["http", "fastmcp"])
def test_chapter_continuation_routes_to_one_chain_and_waits_for_direction_approval(
    tmp_path: Path,
    transport: str,
) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path / transport)
        automation = FakeAutomationClient()

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
                    "title": "模型返回的散装续写计划",
                    "deliverable": "chapter_draft",
                    "steps": [
                        {"agent": "writer", "title": "读取章节", "tools": ["chapter.get"]},
                        {"agent": "writer", "title": "生成草稿", "tools": ["chapter.generate_draft"]},
                    ],
                }
            if method == "agent.detect_creative_direction":
                return {
                    "requiresDecision": True,
                    "title": "转折方向",
                    "question": "广播来自谁？",
                    "options": [
                        {"label": "失踪调查员", "description": "承接钥匙伏笔"},
                        {"label": "伪装的系统", "description": "强化异常规则"},
                    ],
                }
            if method == "chapter.generate_draft":
                return {
                    "draftSessionId": "draft_chapter_chain_1",
                    "type": "chapter-draft",
                    "status": "draft",
                    "version": 1,
                    "previewSummary": "章节草稿 1200 字符",
                }
            if method in {"agent.generate_report", "agent.generate_chat", "agent.revise_plan"}:
                return await FakeAutomationClient.invoke(automation, method, params, origin, request_id=request_id)
            return _read_result(method, params)

        automation.invoke = invoke  # type: ignore[method-assign]
        adapter = FastMcpAgentToolAdapter(automation) if transport == "fastmcp" else None
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store), tool_adapter=adapter)
        plan = await runtime.plan(
            {
                "goal": "接着写当前章节，推进旧站真相",
                "role": "writer",
                "chapterId": "chapter_2",
                "intentDecision": {
                    "interaction": "task",
                    "route": "plan",
                    "operations": [{
                        "type": "chapter.continuation",
                        "target": {"kind": "chapter", "source": "current_selection", "id": "chapter_2"},
                        "suggestedToolchainId": "chapter.continuation",
                        "suggestedToolchainVersion": "1.0.0",
                        "requestedEffect": "draft_write",
                        "confidence": 0.96,
                    }],
                    "deliverable": "chapter_draft",
                    "suggestedRole": "writer",
                    "requestedEffect": "draft_write",
                    "confidence": 0.96,
                    "reasonCodes": ["MATCHED_TOOLCHAIN"],
                    "responseContent": "将生成可审核的章节续写计划。",
                },
            },
            {"chapterId": "chapter_2"},
        )

        assert len(plan.steps) == 1
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "chapter.continuation"
        assert plan.steps[0].tools == []

        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_2",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        pending = await _wait_approval(runtime, run.runId, "creative_direction")
        assert not any(method == "chapter.generate_draft" for method, _, _ in automation.calls)

        resumed_adapter = FastMcpAgentToolAdapter(automation) if transport == "fastmcp" else None
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store), tool_adapter=resumed_adapter)
        assert runtime.state.runs[run.runId].status == "waiting_approval"
        assert runtime.state.runs[run.runId].pendingApproval is not None

        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": pending["checkpointId"],
                "selectedOptionIds": ["direction_1"],
            }
        )
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed"
        assert [method for method, _, _ in automation.calls].count("chapter.generate_draft") == 1
        draft_params = next(params for method, params, _ in automation.calls if method == "chapter.generate_draft")
        assert draft_params["currentContent"].startswith("顾野带伤")
        assert draft_params["contextChapterCount"] == 8
        assert draft_params["recentRawChapterCount"] == 2
        assert draft_params["preparedContext"]["policy"]["version"] == "continuation-context-v1"
        assert "用户确认的创作方向" in draft_params["userIntent"]
        assert "失踪调查员" in draft_params["userIntent"]
        artifact = next(item for item in completed.artifacts if item.type == "chapter_draft")
        assert artifact.reference["draftSessionId"] == "draft_chapter_chain_1"
        assert store.list_invocations(run.runId)[0].status == "succeeded"
        events = store.list_events(run.runId)
        assert any(event.type == "toolchain_completed" for event in events)

    asyncio.run(scenario())


def test_creative_asset_chain_reads_validates_and_publishes_same_draft_session(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()

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
                    "title": "新增旧站角色",
                    "deliverable": "creative_assets_draft",
                    "steps": [{
                        "agent": "worldbuilding",
                        "title": "执行创作素材链",
                        "tools": [],
                        "toolchain": {"id": "creative_asset.draft", "version": "1.0.0", "input": {}},
                    }],
                }
            if method == "agent.detect_creative_direction":
                return {"requiresDecision": False}
            if method == "creative_assets.generate_draft":
                return {
                    "draftSessionId": "draft_assets_chain_1",
                    "type": "creative-assets",
                    "status": "draft",
                    "version": 1,
                    "previewSummary": "角色 1，世界设定 1",
                }
            if method == "creative_assets.validate_draft":
                assert params == {"draftSessionId": "draft_assets_chain_1", "version": 1}
                return {
                    "session": {
                        "draftSessionId": "draft_assets_chain_1",
                        "type": "creative-assets",
                        "status": "draft",
                        "version": 2,
                        "previewSummary": "角色 1，世界设定 1",
                    },
                    "validation": {
                        "ok": False,
                        "errors": [{"scope": "characters", "name": "旧站", "code": "CONFLICT", "detail": "名称与地图重复"}],
                        "warnings": ["建议修改角色代号"],
                        "normalizedDraft": {"characters": []},
                    },
                }
            if method in {"agent.generate_report", "agent.generate_chat", "agent.revise_plan"}:
                return await FakeAutomationClient.invoke(automation, method, params, origin, request_id=request_id)
            return _read_result(method, params)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(
            store,
            automation,
            AgentEventBus(store),
            tool_adapter=FastMcpAgentToolAdapter(automation),
        )
        plan = await runtime.plan({"goal": "新增一个与旧站主线有关的角色", "role": "worldbuilding"}, {})

        assert len(plan.steps) == 1
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "creative_asset.draft"
        assert plan.steps[0].tools == []

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

        assert completed.status == "completed"
        assert [method for method, _, _ in automation.calls].count("creative_assets.generate_draft") == 1
        assert [method for method, _, _ in automation.calls].count("creative_assets.validate_draft") == 1
        assert not any(method == "draft.commit" for method, _, _ in automation.calls)
        artifact = next(item for item in completed.artifacts if item.type == "creative_assets_draft")
        assert artifact.reference["draftSessionId"] == "draft_assets_chain_1"
        assert artifact.metadata["validation"]["ok"] is False
        assert artifact.metadata["draftSession"]["version"] == 2
        records = store.list_invocations(run.runId)
        assert [record.method for record in records] == [
            "creative_assets.generate_draft",
            "creative_assets.validate_draft",
        ]
        assert all(record.status == "succeeded" for record in records)

    asyncio.run(scenario())


def test_chapter_continuation_unknown_write_result_fails_without_replay(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()

        async def invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_plan":
                return {
                    "title": "续写失败关闭",
                    "deliverable": "chapter_draft",
                    "steps": [{
                        "agent": "writer",
                        "title": "执行章节续写链",
                        "tools": [],
                        "toolchain": {"id": "chapter.continuation", "version": "1.0.0", "input": {}},
                    }],
                }
            if method == "agent.detect_creative_direction":
                return {"requiresDecision": False}
            if method == "chapter.generate_draft":
                raise TimeoutError("draft response timed out")
            if method in {"agent.generate_report", "agent.generate_chat", "agent.revise_plan"}:
                return await FakeAutomationClient.invoke(automation, method, params, origin, request_id=request_id)
            return _read_result(method, params)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan(
            {"goal": "续写当前章节", "role": "writer"},
            {"chapterId": "chapter_2"},
        )
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_2",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )
        await _wait_terminal(runtime, run.runId)
        failed = runtime.state.runs[run.runId]

        assert failed.status == "failed"
        assert [method for method, _, _ in automation.calls].count("chapter.generate_draft") == 1
        record = store.list_invocations(run.runId)[0]
        assert record.status == "unknown"
        assert store.list_events(run.runId)[-1].payload["code"] == "SIDE_EFFECT_UNKNOWN"

    asyncio.run(scenario())


def test_chapter_sequence_continuation_approves_beats_and_generates_children_in_order(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        beats = _sequence_beats()
        batch: dict[str, Any] | None = None

        async def invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            nonlocal batch
            automation.calls.append((method, params, origin))
            if method == "agent.generate_plan":
                return {
                    "title": "连续续写三章",
                    "deliverable": "chapter_draft_batch",
                    "steps": [{
                        "agent": "writer",
                        "title": "生成三章连续草稿",
                        "tools": [],
                        "toolchain": {
                            "id": "chapter.sequence_continuation",
                            "version": "1.0.0",
                            "input": {"chapterCount": 3},
                        },
                    }],
                }
            if method == "agent.generate_chapter_beats":
                assert params["chapterCount"] == 3
                return {"beats": beats}
            if method == "draft.batch.create":
                batch = _sequence_batch(params, beats)
                return batch
            if method == "draft.batch.approve_outline":
                assert batch is not None
                assert params["version"] == batch["version"]
                batch["outline"] = {**batch["outline"], "status": "approved", "approvedAt": "now", "approvedBy": "agent-user"}
                batch["status"] = "ready_to_generate"
                batch["version"] += 1
                return batch
            if method == "chapter.generate_draft":
                assert batch is not None
                index = params["childIndex"]
                assert index == sum(1 for child in batch["children"] if child["status"] == "draft")
                assert params["draftBatchId"] == batch["draftBatchId"]
                assert params["generationRevision"] == batch["children"][index]["generationRevision"]
                assert params["batchContext"]["currentBeat"]["childIndex"] == index
                assert len(params["batchContext"]["stateLedger"]["timeline"]) == index
                if index > 0:
                    assert params["batchContext"]["stateLedger"]["characterLocations"]["顾野"] == f"地点-{index - 1}"
                    assert params["batchContext"]["stateLedger"]["itemStates"]["铜钥匙"] == f"状态-{index - 1}"
                    assert len(params["batchContext"]["stateLedger"]["stateDeltas"]) == index
                if index == 2:
                    assert len(params["batchContext"]["recentFullDrafts"]) == 2
                session_id = f"draft_sequence_{index}"
                batch["children"][index] = {
                    **batch["children"][index],
                    "status": "draft",
                    "draftSessionId": session_id,
                }
                batch["status"] = "ready_for_review" if index == 2 else "generating"
                batch["version"] += 1
                return {
                    "draftSessionId": session_id,
                    "draftBatchId": batch["draftBatchId"],
                    "childIndex": index,
                    "generationRevision": 1,
                    "type": "chapter-draft",
                    "status": "draft",
                    "version": 1,
                    "previewSummary": f"第 {index + 1}/3 章草稿",
                    "payload": {
                        "chapterId": f"draft-batch:{batch['draftBatchId']}:{index}",
                        "generatedText": f"这是第 {index + 1} 章生成正文。" * 20,
                        "content": f"这是第 {index + 1} 章生成正文。" * 20,
                        "narrativeStateDelta": {
                            "characterLocations": [{
                                "characterKey": "顾野",
                                "location": f"地点-{index}",
                                "evidenceExcerpt": f"这是第 {index + 1} 章生成正文。",
                            }],
                            "relationshipChanges": [],
                            "knowledgeChanges": [{
                                "characterKey": "顾野",
                                "learned": [f"事实-{index}"],
                                "forgotten": [],
                                "evidenceExcerpt": f"这是第 {index + 1} 章生成正文。",
                            }],
                            "itemStates": [{
                                "itemKey": "铜钥匙",
                                "state": f"状态-{index}",
                                "holderKey": "顾野",
                                "evidenceExcerpt": f"这是第 {index + 1} 章生成正文。",
                            }],
                            "resolvedConflicts": [],
                            "openedConflicts": [],
                            "warnings": [],
                        },
                    },
                }
            if method == "draft.batch.get":
                return batch
            if method in {"agent.generate_report", "agent.generate_chat", "agent.revise_plan"}:
                return await FakeAutomationClient.invoke(automation, method, params, origin, request_id=request_id)
            return _read_result(method, params)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({"goal": "从当前章后连续续写三章", "role": "writer"}, {"chapterId": "chapter_2"})
        assert plan.deliverable == "chapter_draft_batch"
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "chapter.sequence_continuation"

        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_2",
                "currentContent": "顾野带伤抵达旧站。",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        pending = await _wait_approval(runtime, run.runId, "chapter_beats")
        assert not any(method == "chapter.generate_draft" for method, _, _ in automation.calls)
        assert pending["outlineRevision"] == 1

        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        assert runtime.state.runs[run.runId].status == "waiting_approval"
        assert runtime.state.runs[run.runId].draftBatchId == "batch_sequence_1"

        await runtime.submit_approval({
            "runId": run.runId,
            "checkpointId": pending["checkpointId"],
            "selectedOptionIds": ["approve_beats"],
        })
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed"
        assert completed.draftBatchId == "batch_sequence_1"
        generation_calls = [params for method, params, _ in automation.calls if method == "chapter.generate_draft"]
        assert [params["childIndex"] for params in generation_calls] == [0, 1, 2]
        assert generation_calls[-1]["batchContext"]["stateLedger"]["knowledgeState"]["顾野"] == ["事实-0", "事实-1"]
        artifact = next(item for item in completed.artifacts if item.type == "chapter_draft_batch")
        assert artifact.reference["draftBatchId"] == "batch_sequence_1"
        assert artifact.reference["draftSessionIds"] == ["draft_sequence_0", "draft_sequence_1", "draft_sequence_2"]
        assert [record.method for record in store.list_invocations(run.runId)] == [
            "draft.batch.create",
            "draft.batch.approve_outline",
            "chapter.generate_draft",
            "chapter.generate_draft",
            "chapter.generate_draft",
        ]

    asyncio.run(scenario())


def test_chapter_sequence_continuation_stops_after_first_failed_child(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        beats = _sequence_beats()
        batch: dict[str, Any] | None = None

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            nonlocal batch
            automation.calls.append((method, params, origin))
            if method == "agent.generate_plan":
                return {
                    "title": "连续续写失败测试",
                    "deliverable": "chapter_draft_batch",
                    "steps": [{
                        "agent": "writer",
                        "title": "连续续写",
                        "tools": [],
                        "toolchain": {"id": "chapter.sequence_continuation", "version": "1.0.0", "input": {"chapterCount": 3}},
                    }],
                }
            if method == "agent.generate_chapter_beats":
                return {"beats": beats}
            if method == "draft.batch.create":
                batch = _sequence_batch(params, beats)
                return batch
            if method == "draft.batch.approve_outline":
                assert batch is not None
                batch["outline"] = {**batch["outline"], "status": "approved"}
                batch["status"] = "ready_to_generate"
                batch["version"] += 1
                return batch
            if method == "chapter.generate_draft":
                assert batch is not None
                index = params["childIndex"]
                if index == 1:
                    raise TimeoutError("second child timed out")
                batch["children"][0] = {**batch["children"][0], "status": "draft", "draftSessionId": "draft_sequence_0"}
                batch["status"] = "generating"
                batch["version"] += 1
                return {
                    "draftSessionId": "draft_sequence_0",
                    "draftBatchId": batch["draftBatchId"],
                    "childIndex": 0,
                    "generationRevision": 1,
                    "type": "chapter-draft",
                    "status": "draft",
                    "version": 1,
                    "previewSummary": "第一章草稿",
                    "payload": {"chapterId": "temporary", "generatedText": "第一章正文", "content": "第一章正文"},
                }
            if method == "draft.batch.mark_failed":
                assert batch is not None
                index = params["childIndex"]
                assert params["version"] == batch["version"]
                assert params["generationRevision"] == batch["children"][index]["generationRevision"]
                batch["children"][index] = {
                    **batch["children"][index],
                    "status": "failed",
                    "error": params["error"],
                }
                batch["status"] = "partially_failed"
                batch["version"] += 1
                return batch
            if method in {"agent.generate_report", "agent.generate_chat", "agent.revise_plan"}:
                return await FakeAutomationClient.invoke(automation, method, params, origin, request_id=request_id)
            return _read_result(method, params)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({"goal": "连续续写三章", "role": "writer"}, {"chapterId": "chapter_2"})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_2",
                "currentContent": "当前正文",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        pending = await _wait_approval(runtime, run.runId, "chapter_beats")
        await runtime.submit_approval({
            "runId": run.runId,
            "checkpointId": pending["checkpointId"],
            "selectedOptionIds": ["approve_beats"],
        })
        await _wait_terminal(runtime, run.runId)
        failed = runtime.state.runs[run.runId]

        assert failed.status == "failed"
        generation_calls = [params for method, params, _ in automation.calls if method == "chapter.generate_draft"]
        assert [params["childIndex"] for params in generation_calls] == [0, 1]
        assert batch is not None
        assert [child["status"] for child in batch["children"]] == ["draft", "failed", "pending"]
        assert batch["children"][1]["error"]["sideEffectUnknown"] is True
        records = store.list_invocations(run.runId)
        assert records[-2].method == "chapter.generate_draft"
        assert records[-2].status == "unknown"
        assert records[-1].method == "draft.batch.mark_failed"
        assert records[-1].status == "succeeded"

    asyncio.run(scenario())


def test_regenerate_batch_resumes_from_first_failed_child(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        beats = _sequence_beats()
        batch = _sequence_batch({
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "anchorChapterId": "chapter_2",
            "runId": "run_original",
        }, beats)
        batch["outline"] = {**batch["outline"], "status": "approved", "approvedAt": "now"}
        batch["status"] = "partially_failed"
        batch["version"] = 5
        batch["children"][0] = {
            **batch["children"][0],
            "status": "draft",
            "draftSessionId": "draft_sequence_0",
        }
        batch["children"][1] = {
            **batch["children"][1],
            "status": "failed",
            "error": {"code": "GENERATION_FAILED", "message": "provider rejected request"},
        }
        batch["stateLedger"]["timeline"] = [{"childIndex": 0, "summary": "第一章草稿摘要"}]

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            automation.calls.append((method, params, origin))
            if method == "draft.batch.get":
                return batch
            if method == "draft.batch.prepare_regeneration":
                assert params["draftBatchId"] == batch["draftBatchId"]
                assert params["version"] == 5
                assert params["fromChildIndex"] == 1
                for index in (1, 2):
                    batch["children"][index] = {
                        **batch["children"][index],
                        "status": "pending",
                        "generationRevision": 2,
                    }
                    batch["children"][index].pop("error", None)
                    batch["children"][index].pop("draftSessionId", None)
                batch["status"] = "ready_to_generate"
                batch["version"] = 6
                batch["linkedRunIds"].append(params["runId"])
                return {
                    "batch": batch,
                    "fromChildIndex": 1,
                    "preservedDrafts": [{
                        "draftSessionId": "draft_sequence_0",
                        "draftBatchId": batch["draftBatchId"],
                        "childIndex": 0,
                        "generationRevision": 1,
                        "type": "chapter-draft",
                        "status": "draft",
                        "version": 1,
                        "previewSummary": "第一章草稿",
                        "payload": {
                            "chapterId": "temporary-0",
                            "generatedText": "第一章正文",
                            "content": "第一章正文",
                        },
                    }],
                }
            if method == "chapter.generate_draft":
                index = params["childIndex"]
                assert index in {1, 2}
                assert params["generationRevision"] == 2
                if index == 1:
                    assert params["batchContext"]["recentFullDrafts"][0]["childIndex"] == 0
                session_id = f"draft_regenerated_{index}"
                batch["children"][index] = {
                    **batch["children"][index],
                    "status": "draft",
                    "draftSessionId": session_id,
                }
                batch["status"] = "ready_for_review" if index == 2 else "generating"
                batch["version"] += 1
                return {
                    "draftSessionId": session_id,
                    "draftBatchId": batch["draftBatchId"],
                    "childIndex": index,
                    "generationRevision": 2,
                    "type": "chapter-draft",
                    "status": "draft",
                    "version": 1,
                    "previewSummary": f"重生成第 {index + 1} 章",
                    "payload": {
                        "chapterId": f"temporary-{index}",
                        "generatedText": f"重生成第 {index + 1} 章正文",
                        "content": f"重生成第 {index + 1} 章正文",
                    },
                }
            if method in {"agent.generate_report", "agent.generate_chat", "agent.revise_plan"}:
                return await FakeAutomationClient.invoke(automation, method, params, origin, request_id=request_id)
            return _read_result(method, params)

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        run = await runtime.regenerate_batch({
            "draftBatchId": batch["draftBatchId"],
            "version": batch["version"],
            "confirmed": True,
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]

        assert completed.status == "completed"
        assert completed.draftBatchId == batch["draftBatchId"]
        generation_calls = [params for method, params, _ in automation.calls if method == "chapter.generate_draft"]
        assert [params["childIndex"] for params in generation_calls] == [1, 2]
        assert all(params["generationRevision"] == 2 for params in generation_calls)
        assert not any(method == "draft.batch.approve_outline" for method, _, _ in automation.calls)
        assert batch["linkedRunIds"][-1] == run.runId
        artifact = next(item for item in completed.artifacts if item.type == "chapter_draft_batch")
        assert artifact.reference["draftSessionIds"] == [
            "draft_sequence_0",
            "draft_regenerated_1",
            "draft_regenerated_2",
        ]

    asyncio.run(scenario())
