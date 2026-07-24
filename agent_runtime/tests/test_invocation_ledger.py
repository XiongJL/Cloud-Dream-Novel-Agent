from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.invocations import SideEffectResultUnknown, ToolInvocationRecord, build_invocation_key
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentRun, new_id
from novel_agent_runtime.store import AgentStateStore


class RecordingAutomation:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []

    async def invoke(
        self,
        method: str,
        params: dict[str, Any],
        origin: str,
        request_id: str | None = None,
    ) -> Any:
        self.calls.append((method, params, request_id))
        if self.fail:
            raise TimeoutError("automation response timed out")
        return {
            "draftSessionId": "draft_ledger_1",
            "type": "chapter-draft",
            "previewSummary": "ledger draft",
        }

    async def cancel(self, request_id: str) -> bool:
        return True


def test_batch_side_effect_snapshot_preserves_recovery_contract() -> None:
    batch = {
        "draftBatchId": "batch-1",
        "status": "generating",
        "outline": {"revision": 1, "beats": [{"title": "第三章"}]},
        "children": [{"childIndex": 0, "status": "draft", "draftSessionId": "draft-1"}],
        "stateLedger": {"timeline": [{"childIndex": 0}]},
    }
    child = {
        "draftSessionId": "draft-1",
        "draftBatchId": "batch-1",
        "childIndex": 0,
        "generationRevision": 1,
        "type": "chapter-draft",
        "status": "draft",
        "version": 1,
        "payload": {"chapterId": "temporary", "generatedText": "正文", "content": "正文", "baseContent": "ignored"},
    }

    batch_snapshot = NovelAgentRuntime._side_effect_result_snapshot(batch)  # noqa: SLF001
    child_snapshot = NovelAgentRuntime._side_effect_result_snapshot(child)  # noqa: SLF001

    assert batch_snapshot == batch
    assert child_snapshot["draftBatchId"] == "batch-1"
    assert child_snapshot["payload"] == {"chapterId": "temporary", "generatedText": "正文", "content": "正文"}


def test_side_effect_invocation_reuses_success_without_replaying(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = RecordingAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        run = AgentRun(
            runId="run_ledger_success",
            threadId="thread_1",
            planId="plan_1",
            status="running",
            currentStepId="step_draft",
        )
        params = {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"}

        first = await runtime._tool_invoke(run, "chapter.generate_draft", params)  # noqa: SLF001
        second = await runtime._tool_invoke(run, "chapter.generate_draft", params)  # noqa: SLF001

        assert first["draftSessionId"] == "draft_ledger_1"
        assert second["draftSessionId"] == "draft_ledger_1"
        assert len(automation.calls) == 1
        records = store.list_invocations(run.runId)
        assert len(records) == 1
        assert records[0].status == "succeeded"
        assert records[0].requestId == automation.calls[0][2]

    asyncio.run(scenario())


def test_side_effect_error_becomes_unknown_and_is_never_replayed(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = RecordingAutomation(fail=True)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        run = AgentRun(
            runId="run_ledger_unknown",
            threadId="thread_1",
            planId="plan_1",
            status="running",
            currentStepId="step_draft",
        )
        params = {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"}

        with pytest.raises(SideEffectResultUnknown):
            await runtime._tool_invoke(run, "chapter.generate_draft", params)  # noqa: SLF001
        with pytest.raises(SideEffectResultUnknown):
            await runtime._tool_invoke(run, "chapter.generate_draft", params)  # noqa: SLF001

        assert len(automation.calls) == 1
        records = store.list_invocations(run.runId)
        assert len(records) == 1
        assert records[0].status == "unknown"
        assert records[0].error and records[0].error["code"] == "INVOCATION_ERROR"

    asyncio.run(scenario())


def test_runtime_restart_fails_run_with_in_flight_side_effect(tmp_path: Path) -> None:
    store = AgentStateStore(tmp_path)
    run = AgentRun(
        runId="run_ledger_restart",
        threadId="thread_1",
        planId="plan_1",
        status="running",
        currentStepId="step_draft",
    )
    state = store.load()
    state.runs[run.runId] = run
    store.save(state)
    params = {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"}
    invocation_key, params_hash = build_invocation_key(run.runId, run.currentStepId, "chapter.generate_draft", params)
    store.prepare_invocation(
        ToolInvocationRecord(
            invocationKey=invocation_key,
            requestId=new_id("automation"),
            runId=run.runId,
            stepId=run.currentStepId,
            method="chapter.generate_draft",
            paramsHash=params_hash,
            sideEffect=True,
            status="prepared",
        )
    )
    store.mark_invocation_in_flight(invocation_key)

    restarted = NovelAgentRuntime(store, RecordingAutomation(), AgentEventBus(store))

    failed = restarted.state.runs[run.runId]
    assert failed.status == "failed"
    assert failed.events[-1].type == "run_failed"
    assert failed.events[-1].payload["code"] == "SIDE_EFFECT_UNKNOWN"
    assert failed.events[-1].payload["unknownInvocations"][0]["invocationKey"] == invocation_key
    assert store.list_invocations(run.runId)[0].status == "unknown"


def test_reconciled_success_is_reused_without_replaying(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = RecordingAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        run = AgentRun(
            runId="run_reconciled_success",
            threadId="thread_1",
            planId="plan_1",
            status="running",
            currentStepId="step_draft",
        )
        params = {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"}
        invocation_key, params_hash = build_invocation_key(
            run.runId,
            run.currentStepId,
            "chapter.generate_draft",
            params,
        )
        store.prepare_invocation(ToolInvocationRecord(
            invocationKey=invocation_key,
            requestId=new_id("automation"),
            runId=run.runId,
            stepId=run.currentStepId,
            method="chapter.generate_draft",
            paramsHash=params_hash,
            sideEffect=True,
            status="prepared",
        ))
        store.mark_invocation_in_flight(invocation_key)
        store.mark_invocation_unknown(invocation_key, {"code": "TIMEOUT", "message": "unknown"})
        store.reconcile_invocation(
            invocation_key,
            "reconciled_succeeded",
            result={"draftSessionId": "accepted-draft"},
        )

        result = await runtime._tool_invoke(run, "chapter.generate_draft", params)  # noqa: SLF001

        assert result == {"draftSessionId": "accepted-draft"}
        assert automation.calls == []

    asyncio.run(scenario())


class ReconciliationAutomation:
    def __init__(self, batch: dict[str, Any], candidate: dict[str, Any] | None = None) -> None:
        self.batch = batch
        self.candidate = candidate
        self.calls: list[str] = []

    async def invoke(
        self,
        method: str,
        params: dict[str, Any],
        origin: str,
        request_id: str | None = None,
    ) -> Any:
        self.calls.append(method)
        child = self.batch["children"][params.get("childIndex", 0)]
        if method == "draft.batch.inspect_reconciliation":
            return {
                "batch": self.batch,
                "child": child,
                "candidates": [self.candidate] if self.candidate else [],
            }
        if method == "draft.batch.reconcile_unknown":
            child["error"] = {"code": "RECONCILED_ABSENT", "message": "confirmed absent"}
            child["reconciliation"] = {
                "resolution": params["resolution"],
                "invocationKey": params["invocationKey"],
                "method": "chapter.generate_draft",
            }
            self.batch["version"] += 1
            return self.batch
        if method == "draft.get" and self.candidate:
            return self.candidate
        raise AssertionError(f"Unexpected automation method: {method}")

    async def cancel(self, request_id: str) -> bool:
        return True


def test_runtime_reconciles_absent_batch_child_and_ledger(tmp_path: Path) -> None:
    async def scenario() -> None:
        invocation_key = "run_reconcile:step_draft:chapter.generate_draft:abc"
        batch = {
            "draftBatchId": "batch-reconcile",
            "version": 3,
            "runId": "run_reconcile",
            "linkedRunIds": [],
            "children": [{
                "childIndex": 0,
                "generationRevision": 1,
                "status": "failed",
                "error": {
                    "code": "SIDE_EFFECT_UNKNOWN",
                    "message": "timed out",
                    "sideEffectUnknown": True,
                    "invocationKey": invocation_key,
                    "method": "chapter.generate_draft",
                },
                "reconciliation": {
                    "resolution": "pending",
                    "invocationKey": invocation_key,
                    "method": "chapter.generate_draft",
                },
            }],
        }
        store = AgentStateStore(tmp_path)
        store.prepare_invocation(ToolInvocationRecord(
            invocationKey=invocation_key,
            requestId="request-reconcile",
            runId="run_reconcile",
            stepId="step_draft",
            method="chapter.generate_draft",
            paramsHash="abc",
            sideEffect=True,
            status="prepared",
        ))
        store.mark_invocation_in_flight(invocation_key)
        store.mark_invocation_unknown(invocation_key, {"code": "TIMEOUT", "message": "unknown"})
        automation = ReconciliationAutomation(batch)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))

        inspection = await runtime.inspect_side_effect({
            "draftBatchId": "batch-reconcile",
            "childIndex": 0,
            "generationRevision": 1,
        }, {})
        assert inspection["invocation"]["status"] == "unknown"
        assert inspection["canConfirmAbsent"] is True

        result = await runtime.reconcile_side_effect({
            "draftBatchId": "batch-reconcile",
            "version": 3,
            "childIndex": 0,
            "generationRevision": 1,
            "invocationKey": invocation_key,
            "resolution": "reconciled_absent",
            "confirmation": True,
        }, {})

        assert result["batch"]["version"] == 4
        assert result["invocation"]["status"] == "reconciled_absent"
        assert store.get_invocation(invocation_key).status == "reconciled_absent"
        assert automation.calls == [
            "draft.batch.inspect_reconciliation",
            "draft.batch.inspect_reconciliation",
            "draft.batch.reconcile_unknown",
        ]

    asyncio.run(scenario())


def test_runtime_finishes_ledger_after_batch_reconciliation_response_was_lost(tmp_path: Path) -> None:
    async def scenario() -> None:
        invocation_key = "run_partial:step_draft:chapter.generate_draft:abc"
        batch = {
            "draftBatchId": "batch-partial",
            "version": 4,
            "runId": "run_partial",
            "linkedRunIds": [],
            "children": [{
                "childIndex": 0,
                "generationRevision": 1,
                "status": "failed",
                "error": {"code": "RECONCILED_ABSENT", "message": "confirmed absent"},
                "reconciliation": {
                    "resolution": "reconciled_absent",
                    "invocationKey": invocation_key,
                    "method": "chapter.generate_draft",
                },
            }],
        }
        store = AgentStateStore(tmp_path)
        store.prepare_invocation(ToolInvocationRecord(
            invocationKey=invocation_key,
            requestId="request-partial",
            runId="run_partial",
            stepId="step_draft",
            method="chapter.generate_draft",
            paramsHash="abc",
            sideEffect=True,
            status="prepared",
        ))
        store.mark_invocation_in_flight(invocation_key)
        store.mark_invocation_unknown(invocation_key, {"code": "TIMEOUT", "message": "unknown"})
        automation = ReconciliationAutomation(batch)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))

        result = await runtime.reconcile_side_effect({
            "draftBatchId": "batch-partial",
            "version": 3,
            "childIndex": 0,
            "generationRevision": 1,
            "invocationKey": invocation_key,
            "resolution": "reconciled_absent",
            "confirmation": True,
        }, {})

        assert result["batch"]["version"] == 4
        assert result["invocation"]["status"] == "reconciled_absent"
        assert automation.calls == ["draft.batch.inspect_reconciliation"]

    asyncio.run(scenario())
