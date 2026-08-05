from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.chapter_batch_rewrite import rewrite_scope_context_params
from novel_agent_runtime.toolchains.schemas import ChapterBatchRewriteInput, ChapterScopeBundle
from novel_agent_runtime.toolchains.writer_range_revision_plan import normalize_writer_range_revision_plan

from test_runtime import FakeAutomationClient, install_durable_draft_protocol


def test_batch_rewrite_omits_empty_optional_scope_context_params() -> None:
    input_data = ChapterBatchRewriteInput(
        novelId="novel_1",
        volumeId="volume_1",
        chapterId="chapter_1",
        chapterIds=["chapter_1", "chapter_2"],
        goal="改写两章",
    )

    params = rewrite_scope_context_params(input_data)

    assert "scopeId" not in params
    assert params["chapterIds"] == ["chapter_1", "chapter_2"]
    assert params["anchorChapterId"] == "chapter_1"


def test_batch_rewrite_accepts_batched_scope_but_requests_detailed_context() -> None:
    input_data = ChapterBatchRewriteInput(
        novelId="novel_1",
        volumeId="volume_1",
        chapterId="chapter_1",
        chapterIds=["chapter_1", "chapter_2"],
        processingMode="batched",
        goal="改写两章",
    )

    params = rewrite_scope_context_params(input_data)

    assert input_data.processingMode == "batched"
    assert params["processingMode"] == "detailed"


def _scope_bundle() -> dict[str, Any]:
    snapshots = [
        {
            "chapterId": f"chapter_{index}",
            "version": index,
            "contentHash": f"hash_{index}",
            "updatedAt": f"2026-07-{index:02d}T00:00:00Z",
            "source": "database",
        }
        for index in range(1, 3)
    ]
    return {
        "scope": {
            "scopeId": "scope_writer_1",
            "novelId": "novel_1",
            "kind": "selected_chapters",
            "volumeId": "volume_1",
            "chapterIds": ["chapter_1", "chapter_2"],
            "anchorChapterId": "chapter_1",
            "processingMode": "detailed",
            "snapshot": snapshots,
        },
        "chapters": [
            {
                "chapterId": f"chapter_{index}",
                "volumeId": "volume_1",
                "title": f"第{index}章",
                "order": index,
                "volumeOrder": 1,
                "version": index,
                "updatedAt": f"2026-07-{index:02d}T00:00:00Z",
                "contentHash": f"hash_{index}",
                "contentMode": "full",
                "content": f"第{index}章原文。顾野走进旧站。",
                "summaryFresh": True,
                "target": True,
            }
            for index in range(1, 3)
        ],
        "narrativeSummaries": [],
        "entityContext": {
            "characters": [{"id": "character_1", "name": "顾野"}],
            "items": [],
            "worldSettings": [],
            "maps": [],
        },
        "plotContext": {"plotLines": [{"id": "plotline_1", "name": "旧站主线"}]},
        "evidence": [],
        "stateLedger": {},
        "coverage": {
            "totalChapterCount": 2,
            "contextChapterCount": 2,
            "readonlyChapterCount": 0,
            "detailedChapterCount": 2,
            "summarizedChapterCount": 0,
            "excerptChapterCount": 0,
            "omittedChapterCount": 0,
            "batchSize": 2,
            "batchCount": 1,
            "batches": [{"index": 0, "chapterIds": ["chapter_1", "chapter_2"]}],
        },
        "sourceSnapshot": snapshots,
        "warnings": [],
        "estimatedTokens": 2800,
    }


def _revision_plan() -> dict[str, Any]:
    return {
        "overallScore": 68,
        "summary": "第一章场景有效，第二章需要优先重建冲突。",
        "dimensions": [{
            "id": "scene_strength",
            "label": "场景强度",
            "score": 65,
            "reason": "第二章冲突启动较晚。",
            "checkable": True,
        }],
        "findings": [{
            "findingId": "writer_finding_1",
            "title": "第二章冲突启动过晚",
            "summary": "进入旧站后的目标不够明确。",
            "category": "scene_strength",
            "severity": "high",
            "chapterIds": ["chapter_2", "chapter_future"],
            "evidenceRefs": ["chapter_2", "fabricated"],
            "evidence": [
                {"sourceType": "chapter", "sourceId": "chapter_2", "title": "第二章", "excerpt": "顾野走进旧站。"},
                {"sourceType": "chapter", "sourceId": "chapter_future", "title": "未来章", "excerpt": "不存在。"},
            ],
            "recommendation": "前移威胁信号并明确本章目标。",
            "recommendedRole": "writer",
            "uncertainty": "",
        }],
        "rewriteOrder": ["chapter_2", "chapter_future", "chapter_1"],
        "continuationReadiness": "先完成第二章冲突修订，再继续写后续章节。",
        "recommendations": ["先改第二章，再微调第一章结尾。"],
        "warnings": [],
    }


def _beats() -> list[dict[str, Any]]:
    return [
        {
            "title": f"第{index}章改写",
            "chapterGoal": f"强化第{index}章场景目标",
            "coreConflict": f"第{index}章核心冲突",
            "keyEvents": [f"事件{index}"],
            "reveals": [f"揭示{index}"],
            "endingHook": f"钩子{index}",
            "targetWordCount": 1800,
        }
        for index in range(1, 3)
    ]


def _rewrite_batch(params: dict[str, Any], beats: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "draftBatchId": "batch_rewrite_1",
        "novelId": params["novelId"],
        "volumeId": params["volumeId"],
        "anchorChapterId": params["anchorChapterId"],
        "mode": "batch_rewrite",
        "status": "outline_draft",
        "outline": {
            "revision": 1,
            "status": "draft",
            "beats": [
                {**beat, "beatId": f"rewrite_beat_{index}", "childIndex": index}
                for index, beat in enumerate(beats)
            ],
        },
        "children": [
            {
                "childIndex": index,
                "title": beat["title"],
                "status": "pending",
                "generationRevision": 1,
                "targetChapterId": params["targetChapterIds"][index],
                **({"dependsOnChildIndex": index - 1} if index else {}),
            }
            for index, beat in enumerate(beats)
        ],
        "stateLedger": {},
        "sourceSnapshot": params["sourceSnapshot"],
        "runId": params["runId"],
        "linkedRunIds": [params["runId"]],
        "version": 1,
        "createdAt": "2026-07-18T00:00:00Z",
        "updatedAt": "2026-07-18T00:00:00Z",
    }


async def _wait_terminal(runtime: NovelAgentRuntime, run_id: str) -> None:
    for _ in range(1200):
        if runtime.state.runs[run_id].status in {"completed", "failed", "cancelled"}:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Writer Toolchain did not reach a terminal state")


async def _wait_approval(runtime: NovelAgentRuntime, run_id: str) -> dict[str, Any]:
    for _ in range(1200):
        pending = runtime.state.runs[run_id].pendingApproval
        task = runtime._run_tasks.get(run_id)  # noqa: SLF001
        if pending and pending.get("checkpointType") == "chapter_beats" and (task is None or task.done()):
            return pending
        await asyncio.sleep(0.01)
    raise AssertionError("Rewrite Toolchain did not reach beat approval")


def test_writer_revision_plan_filters_scope_and_evidence() -> None:
    plan = normalize_writer_range_revision_plan(
        _revision_plan(),
        ChapterScopeBundle.model_validate(_scope_bundle()),
    )
    assert plan.findings[0].chapterIds == ["chapter_2"]
    assert plan.findings[0].evidenceRefs == ["chapter_2"]
    assert plan.rewriteOrder == ["chapter_2", "chapter_1"]
    assert any("不属于批准目标范围" in warning for warning in plan.warnings)
    assert any("无法在范围上下文" in warning for warning in plan.warnings)


def test_writer_revision_plan_publishes_expert_report(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "作者多章节修订计划",
                    "deliverable": "expert_report",
                    "steps": [{
                        "agent": "writer",
                        "title": "规划修订顺序",
                        "tools": [],
                        "toolchain": {
                            "id": "writer.range_revision_plan",
                            "version": "1.0.0",
                            "input": {"kind": "selected_chapters", "chapterIds": ["chapter_1", "chapter_2"]},
                        },
                    }],
                }
            if method == "chapter.scope_context.build":
                automation.calls.append((method, params, origin))
                return _scope_bundle()
            if method == "rag.ask":
                automation.calls.append((method, params, origin))
                return {"evidence": []}
            if method == "agent.generate_writer_range_revision_plan":
                return _revision_plan()
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = invoke  # type: ignore[method-assign]
        install_durable_draft_protocol(automation)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({"goal": "给这两章做作者多章节修订计划", "role": "writer"}, {})
        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "chapterId": "chapter_1",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed", [(event.type, event.payload) for event in completed.events[-8:]]
        artifact = next(item for item in completed.artifacts if item.type == "writer_revision_plan")
        assert artifact.metadata["expertReport"]["expert"] == "writer"
        assert artifact.metadata["writerRevisionPlan"]["rewriteOrder"] == ["chapter_2", "chapter_1"]
        assert artifact.reviewStatus == "unreviewed"
        assert not any(method.startswith("draft.") for method, _, _ in automation.calls)

    asyncio.run(scenario())


def test_batch_rewrite_uses_explicit_targets_and_original_content(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke
        beats = _beats()
        batch: dict[str, Any] | None = None

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            nonlocal batch
            automation.calls.append((method, params, origin))
            if method == "agent.generate_plan":
                return {
                    "title": "批量改写两章",
                    "deliverable": "chapter_draft_batch",
                    "steps": [{
                        "agent": "writer",
                        "title": "改写选中章节",
                        "tools": [],
                        "toolchain": {"id": "chapter.batch_rewrite", "version": "1.0.0", "input": {}},
                    }],
                }
            if method == "chapter.scope_context.build":
                return _scope_bundle()
            if method == "agent.generate_chapter_beats":
                assert params["chapterCount"] == 2
                assert params["taskMode"] == "batch_rewrite"
                assert params["targetChapterIds"] == ["chapter_1", "chapter_2"]
                return {"beats": beats}
            if method == "draft.batch.create":
                assert params["mode"] == "batch_rewrite"
                assert params["targetChapterIds"] == ["chapter_1", "chapter_2"]
                assert [item["contentHash"] for item in params["sourceSnapshot"]] == ["hash_1", "hash_2"]
                batch = _rewrite_batch(params, beats)
                return batch
            if method == "draft.batch.approve_outline":
                assert batch is not None
                batch["outline"] = {**batch["outline"], "status": "approved", "approvedAt": "now", "approvedBy": "agent-user"}
                batch["status"] = "ready_to_generate"
                batch["version"] += 1
                return batch
            if method == "chapter.generate_draft":
                assert batch is not None
                index = params["childIndex"]
                chapter_id = f"chapter_{index + 1}"
                assert params["mode"] == "rewrite_chapter"
                assert params["batchMode"] == "batch_rewrite"
                assert params["chapterId"] == chapter_id
                assert params["targetChapterId"] == chapter_id
                assert params["currentContent"].startswith(f"第{index + 1}章原文")
                assert params["preparedContext"]["snapshot"]["anchorChapterId"] == chapter_id
                session_id = f"draft_rewrite_{index}"
                batch["children"][index] = {
                    **batch["children"][index],
                    "status": "draft",
                    "draftSessionId": session_id,
                }
                batch["status"] = "ready_for_review" if index == 1 else "generating"
                batch["version"] += 1
                return {
                    "draftSessionId": session_id,
                    "draftBatchId": batch["draftBatchId"],
                    "childIndex": index,
                    "generationRevision": 1,
                    "type": "chapter-draft",
                    "status": "draft",
                    "version": 1,
                    "previewSummary": f"第{index + 1}章改写草稿",
                    "payload": {
                        "chapterId": chapter_id,
                        "baseContent": params["currentContent"],
                        "generatedText": f"第{index + 1}章完整改写正文。" * 20,
                        "content": f"第{index + 1}章完整改写正文。" * 20,
                    },
                }
            if method == "draft.batch.get":
                return batch
            if method in {"agent.generate_report", "agent.generate_chat", "agent.revise_plan"}:
                return await original_invoke(method, params, origin, request_id=request_id)
            return {"ok": True}

        automation.invoke = invoke  # type: ignore[method-assign]
        install_durable_draft_protocol(automation)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({
            "goal": "批量改写选中的两章",
            "role": "writer",
            "chapterScope": {
                "kind": "selected_chapters",
                "volumeId": "volume_1",
                "chapterIds": ["chapter_1", "chapter_2"],
                "anchorChapterId": "chapter_1",
            },
            "novelId": "novel_1",
            "chapterId": "chapter_1",
        }, {})
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "chapter.batch_rewrite"
        assert plan.steps[0].toolchain.input["chapterIds"] == ["chapter_1", "chapter_2"]
        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "chapterId": "chapter_1",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {})
        pending = await _wait_approval(runtime, run.runId)
        assert not any(method == "chapter.generate_draft" for method, _, _ in automation.calls)
        await runtime.submit_approval({
            "runId": run.runId,
            "checkpointId": pending["checkpointId"],
            "selectedOptionIds": ["approve_beats"],
        })
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed", [(event.type, event.payload) for event in completed.events[-10:]]
        generation_calls = [params for method, params, _ in automation.calls if method == "chapter.generate_draft"]
        assert [params["targetChapterId"] for params in generation_calls] == ["chapter_1", "chapter_2"]
        artifact = next(item for item in completed.artifacts if item.type == "chapter_draft_batch")
        assert artifact.title == "多章节改写草稿"
        assert artifact.reference["draftSessionIds"] == ["draft_rewrite_0", "draft_rewrite_1"]

    asyncio.run(scenario())


def test_batch_rewrite_regeneration_preserves_prefix_and_snapshot(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        beats = _beats()
        batch = _rewrite_batch({
            "novelId": "novel_1",
            "volumeId": "volume_1",
            "anchorChapterId": "chapter_1",
            "targetChapterIds": ["chapter_1", "chapter_2"],
            "sourceSnapshot": _scope_bundle()["sourceSnapshot"],
            "runId": "run_original",
        }, beats)
        batch["outline"] = {**batch["outline"], "status": "approved", "approvedAt": "now"}
        batch["status"] = "partially_failed"
        batch["version"] = 5
        batch["children"][0] = {
            **batch["children"][0],
            "status": "draft",
            "draftSessionId": "draft_rewrite_0",
        }
        batch["children"][1] = {
            **batch["children"][1],
            "status": "failed",
            "error": {"code": "GENERATION_FAILED", "message": "provider rejected request"},
        }

        async def invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            automation.calls.append((method, params, origin))
            if method == "draft.batch.get":
                return batch
            if method == "chapter.scope_context.build":
                return _scope_bundle()
            if method == "draft.batch.prepare_regeneration":
                assert params["fromChildIndex"] == 1
                batch["children"][1] = {
                    **batch["children"][1],
                    "status": "pending",
                    "generationRevision": 2,
                }
                batch["children"][1].pop("error", None)
                batch["status"] = "ready_to_generate"
                batch["version"] = 6
                batch["linkedRunIds"].append(params["runId"])
                return {
                    "batch": batch,
                    "fromChildIndex": 1,
                    "preservedDrafts": [{
                        "draftSessionId": "draft_rewrite_0",
                        "draftBatchId": batch["draftBatchId"],
                        "childIndex": 0,
                        "generationRevision": 1,
                        "type": "chapter-draft",
                        "status": "draft",
                        "version": 1,
                        "previewSummary": "第一章改写草稿",
                        "payload": {
                            "chapterId": "chapter_1",
                            "baseContent": "第一章原文",
                            "generatedText": "第一章改写正文",
                            "content": "第一章改写正文",
                        },
                    }],
                }
            if method == "chapter.generate_draft":
                assert params["childIndex"] == 1
                assert params["generationRevision"] == 2
                assert params["targetChapterId"] == "chapter_2"
                assert params["batchContext"]["recentFullRewrites"][0]["childIndex"] == 0
                batch["children"][1] = {
                    **batch["children"][1],
                    "status": "draft",
                    "draftSessionId": "draft_rewrite_regenerated_1",
                }
                batch["status"] = "ready_for_review"
                batch["version"] += 1
                return {
                    "draftSessionId": "draft_rewrite_regenerated_1",
                    "draftBatchId": batch["draftBatchId"],
                    "childIndex": 1,
                    "generationRevision": 2,
                    "type": "chapter-draft",
                    "status": "draft",
                    "version": 1,
                    "previewSummary": "第二章重生成改写草稿",
                    "payload": {
                        "chapterId": "chapter_2",
                        "baseContent": "第二章原文",
                        "generatedText": "第二章重生成改写正文",
                        "content": "第二章重生成改写正文",
                    },
                }
            if method in {"agent.generate_report", "agent.generate_chat", "agent.revise_plan"}:
                return await FakeAutomationClient.invoke(
                    automation,
                    method,
                    params,
                    origin,
                    request_id=request_id,
                )
            return {"ok": True}

        automation.invoke = invoke  # type: ignore[method-assign]
        install_durable_draft_protocol(automation)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        run = await runtime.regenerate_batch({
            "draftBatchId": batch["draftBatchId"],
            "version": batch["version"],
            "confirmed": True,
        }, {})
        await _wait_terminal(runtime, run.runId)
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed", [(event.type, event.payload) for event in completed.events[-10:]]
        assert completed.draftBatchId == batch["draftBatchId"]
        generation_calls = [params for method, params, _ in automation.calls if method == "chapter.generate_draft"]
        assert [params["childIndex"] for params in generation_calls] == [1]
        artifact = next(item for item in completed.artifacts if item.type == "chapter_draft_batch")
        assert artifact.title == "多章节改写草稿"
        assert artifact.reference["draftSessionIds"] == [
            "draft_rewrite_0",
            "draft_rewrite_regenerated_1",
        ]

    asyncio.run(scenario())
