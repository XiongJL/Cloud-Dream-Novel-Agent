from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.execution_graph import PlanExecutionGraph
from novel_agent_runtime.invocations import (
    AgentControlFlowSignal,
    DraftOperationPending,
    SideEffectResultUnknown,
    ToolInvocationRecord,
    build_durable_operation_key,
    build_invocation_key,
)
from novel_agent_runtime.request_graph import RetryableRequestGraph
from novel_agent_runtime.retry import agent_retry_policy
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
        if method == "chapter.draft.start":
            return {
                "operationId": "draft_operation_1",
                "operationKey": params["operationKey"],
                "status": "queued",
                "phase": "accepted",
                "version": 1,
                "attempt": 0,
                "maxAttempts": 4,
                "pollAfterMs": 1,
            }
        if method == "chapter.draft.get_status":
            return {
                "operationId": params["operationId"],
                "status": "succeeded",
                "phase": "terminal",
                "version": 4,
                "attempt": 1,
                "maxAttempts": 4,
                "result": {"draftSessionId": "draft_ledger_1", "generationRevision": 1},
            }
        return {
            "draftSessionId": "draft_ledger_1",
            "type": "chapter-draft",
            "previewSummary": "ledger draft",
        }

    async def cancel(self, request_id: str) -> bool:
        return True


class PendingThenSuccessAutomation(RecordingAutomation):
    def __init__(self, pending_observations: int = 1) -> None:
        super().__init__()
        self.pending_observations = pending_observations
        self.status_observations = 0

    async def invoke(
        self,
        method: str,
        params: dict[str, Any],
        origin: str,
        request_id: str | None = None,
    ) -> Any:
        if method != "chapter.draft.get_status":
            return await super().invoke(method, params, origin, request_id)
        self.calls.append((method, params, request_id))
        self.status_observations += 1
        if self.status_observations <= self.pending_observations:
            return {
                "operationId": params["operationId"],
                "status": "running_generation",
                "phase": "generation",
                "version": 2,
                "attempt": 1,
                "maxAttempts": 4,
                "pollAfterMs": 1,
            }
        return {
            "operationId": params["operationId"],
            "status": "succeeded",
            "phase": "terminal",
            "version": 3,
            "attempt": 1,
            "maxAttempts": 4,
            "result": {"draftSessionId": "draft_ledger_1", "generationRevision": 1},
        }


def test_draft_operation_pending_is_a_control_flow_signal_not_a_business_exception() -> None:
    pending = DraftOperationPending(
        "draft_operation_1",
        "draftop_key",
        "queued",
        1,
    )

    assert isinstance(pending, AgentControlFlowSignal)
    assert not isinstance(pending, Exception)


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
        assert [method for method, _, _ in automation.calls] == [
            "chapter.draft.start",
            "chapter.draft.get_status",
            "draft.get",
        ]
        records = store.list_invocations(run.runId)
        assert len(records) == 1
        assert records[0].status == "succeeded"
        assert records[0].invocationKey.startswith("draftop_")

    asyncio.run(scenario())


def test_durable_draft_yields_after_one_nonterminal_observation(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = PendingThenSuccessAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        run = AgentRun(
            runId="run_durable_pending",
            threadId="thread_1",
            planId="plan_pending",
            status="running",
            currentStepId="step_draft",
        )
        runtime.state.runs[run.runId] = run
        params = {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"}

        with pytest.raises(DraftOperationPending) as pending:
            await runtime._tool_invoke(run, "chapter.generate_draft", params)  # noqa: SLF001

        assert pending.value.operation_id == "draft_operation_1"
        assert pending.value.status == "running_generation"
        assert automation.status_observations == 1
        assert store.list_invocations(run.runId)[0].status == "operation_pending"

        result = await runtime._tool_invoke(run, "chapter.generate_draft", params)  # noqa: SLF001

        assert result["draftSessionId"] == "draft_ledger_1"
        assert [method for method, _, _ in automation.calls].count("chapter.draft.start") == 1
        assert sum(
            event.type == "draft_operation_started"
            for event in store.list_events(run.runId)
        ) == 1

    asyncio.run(scenario())


def test_execution_graph_interrupts_and_resumes_durable_operation(tmp_path: Path) -> None:
    async def scenario() -> None:
        graph = PlanExecutionGraph(tmp_path / "agent_graph.db")
        advance_count = 0

        async def advance(state):
            nonlocal advance_count
            advance_count += 1
            if advance_count == 1:
                return {
                    "action": "waiting_operation",
                    "pending_operation": {
                        "operationId": "draft_operation_1",
                        "operationKey": "draftop_key",
                        "operationStatus": "running_generation",
                        "operationVersion": 2,
                        "pollAfterSeconds": 0.25,
                    },
                }
            return {"action": "terminal", "pending_operation": None}

        initial_state = {
            "run_id": "run_graph_operation",
            "approved_step_ids": ["step_draft"],
            "novel_id": "novel_1",
            "volume_id": None,
            "chapter_id": "chapter_1",
            "current_content": "",
            "locale": "zh-CN",
            "step_index": 0,
            "tool_index": 0,
            "phase": "before_tool",
            "action": "continue",
            "checkpoint": None,
            "resume_response": None,
            "latest_analysis_summary": "",
            "report_findings": [],
            "creative_direction_checked": True,
            "toolchain_state": None,
            "pending_operation": None,
        }
        interrupted = await graph.run(
            "run:run_graph_operation",
            advance,
            initial_state=initial_state,
        )

        assert interrupted["action"] == "waiting_operation"
        assert interrupted["pending_operation"]["operationId"] == "draft_operation_1"
        checkpoint = graph.load_checkpoint_state("run:run_graph_operation")
        assert checkpoint is not None
        assert checkpoint["action"] == "waiting_operation"

        resumed = await graph.run(
            "run:run_graph_operation",
            advance,
            resume={
                "operationId": "draft_operation_1",
                "operationStatus": "succeeded",
                "operationVersion": 3,
            },
        )

        assert resumed["action"] == "terminal"
        assert resumed["pending_operation"] is None
        assert advance_count == 2

    asyncio.run(scenario())


def test_completion_outbox_notification_wakes_operation_watcher(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = PendingThenSuccessAutomation(pending_observations=2)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        run = AgentRun(
            runId="run_outbox_wakeup",
            threadId="thread_1",
            planId="plan_outbox_wakeup",
            status="running",
            currentStepId="step_draft",
        )
        runtime.state.runs[run.runId] = run
        params = {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"}
        with pytest.raises(DraftOperationPending) as pending_error:
            await runtime._tool_invoke(run, "chapter.generate_draft", params)  # noqa: SLF001

        resumed: list[dict[str, Any]] = []

        async def fake_guarded(run_id: str, *, initial_state=None, resume=None) -> None:
            del initial_state
            assert run_id == run.runId
            resumed.append(resume)

        monkeypatch.setattr(runtime, "_run_graph_guarded", fake_guarded)
        pending = pending_error.value
        runtime._schedule_draft_operation_watcher(  # noqa: SLF001
            run.runId,
            {
                "operationId": pending.operation_id,
                "operationKey": pending.operation_key,
                "operationStatus": pending.status,
                "operationVersion": pending.version,
                "pollAfterSeconds": 5,
            },
        )
        watcher = runtime._operation_watch_tasks[run.runId]  # noqa: SLF001
        for _ in range(100):
            if automation.status_observations >= 2:
                break
            await asyncio.sleep(0.01)
        assert automation.status_observations == 2
        await watcher
        assert run.runId in runtime._operation_watch_timers  # noqa: SLF001

        notification = await runtime.operation_completed({
            "operationId": pending.operation_id,
            "status": "succeeded",
            "version": 3,
        })
        resumed_watcher = runtime._operation_watch_tasks[run.runId]  # noqa: SLF001
        await asyncio.wait_for(resumed_watcher, timeout=1)

        assert notification["awakenedRunIds"] == [run.runId]
        assert automation.status_observations == 3
        assert resumed[0]["operationId"] == pending.operation_id
        assert resumed[0]["operationStatus"] == "succeeded"

    asyncio.run(scenario())


def test_durable_draft_operation_key_survives_run_retry(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = RecordingAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        params = {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"}
        original = AgentRun(
            runId="run_original",
            threadId="thread_1",
            planId="plan_stable",
            status="running",
            currentStepId="step_draft",
        )
        retried = original.model_copy(update={"runId": "run_retry", "retryOfRunId": original.runId})

        first = await runtime._tool_invoke(original, "chapter.generate_draft", params)  # noqa: SLF001
        call_count = len(automation.calls)
        second = await runtime._tool_invoke(retried, "chapter.generate_draft", params)  # noqa: SLF001

        assert first == second
        assert len(automation.calls) == call_count
        assert len(store.list_invocations()) == 1
        assert store.list_invocations()[0].invocationKey.startswith("draftop_")

    asyncio.run(scenario())


def test_lost_start_receipt_replays_idempotent_start_instead_of_becoming_unknown(tmp_path: Path) -> None:
    class LostReceiptAutomation(RecordingAutomation):
        async def invoke(
            self,
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "chapter.draft.start" and not any(call[0] == method for call in self.calls):
                self.calls.append((method, params, request_id))
                raise AutomationInvokeError(
                    "NETWORK_ERROR",
                    "start response was lost",
                    {"retryable": True},
                )
            return await super().invoke(method, params, origin, request_id)

    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = LostReceiptAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        runtime.request_graph = RetryableRequestGraph(agent_retry_policy(
            initial_interval=0.001,
            backoff_factor=1,
            max_interval=0.001,
            jitter=False,
        ))
        run = AgentRun(
            runId="run_lost_receipt",
            threadId="thread_1",
            planId="plan_lost_receipt",
            status="running",
            currentStepId="step_draft",
        )
        result = await runtime._tool_invoke(  # noqa: SLF001
            run,
            "chapter.generate_draft",
            {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"},
        )

        starts = [params for method, params, _ in automation.calls if method == "chapter.draft.start"]
        assert len(starts) == 2
        assert starts[0]["operationKey"] == starts[1]["operationKey"]
        assert result["draftSessionId"] == "draft_ledger_1"
        assert store.list_invocations()[0].status == "succeeded"
        assert not any(item.status == "unknown" for item in store.list_invocations())

    asyncio.run(scenario())


def test_runtime_restart_resumes_run_bound_to_durable_operation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = AgentStateStore(tmp_path)
    params = {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"}
    operation_key, params_hash = build_durable_operation_key(
        "plan_restart",
        "step_draft",
        "chapter.generate_draft",
        params,
    )
    run = AgentRun(
        runId="run_durable_restart",
        threadId="thread_1",
        planId="plan_restart",
        status="running",
        currentStepId="step_draft",
        draftOperationId="draft_operation_restart",
        draftOperationKey=operation_key,
        draftOperationStatus="running_generation",
        draftOperationVersion=2,
    )
    state = store.load()
    state.runs[run.runId] = run
    store.save(state)
    store.prepare_invocation(ToolInvocationRecord(
        invocationKey=operation_key,
        requestId=new_id("automation"),
        runId=run.runId,
        stepId=run.currentStepId,
        method="chapter.generate_draft",
        paramsHash=params_hash,
        sideEffect=True,
        status="prepared",
    ))
    store.mark_invocation_operation_pending(operation_key, {
        "operationId": run.draftOperationId,
        "operationKey": operation_key,
        "status": "running_generation",
        "version": 2,
    })
    monkeypatch.setattr(PlanExecutionGraph, "has_checkpoint", lambda self, thread_id: True)

    restarted = NovelAgentRuntime(store, RecordingAutomation(), AgentEventBus(store))
    assert restarted.state.runs[run.runId].status == "running"

    resumed: list[tuple[str, dict[str, Any] | None]] = []
    checkpoint = {
        "run_id": run.runId,
        "approved_step_ids": ["step_draft"],
        "novel_id": "novel_1",
        "volume_id": None,
        "chapter_id": "chapter_1",
        "current_content": "",
        "locale": "zh-CN",
        "step_index": 0,
        "tool_index": 0,
        "phase": "before_tool",
        "action": "continue",
        "checkpoint": None,
        "resume_response": None,
        "latest_analysis_summary": "",
        "report_findings": [],
        "creative_direction_checked": True,
        "toolchain_state": None,
        "pending_operation": None,
    }
    monkeypatch.setattr(restarted.execution_graph, "load_checkpoint_state", lambda thread_id: checkpoint)

    async def fake_guarded(run_id: str, *, initial_state=None, resume=None) -> None:
        del resume
        resumed.append((run_id, initial_state))

    monkeypatch.setattr(restarted, "_run_graph_guarded", fake_guarded)

    async def scenario() -> None:
        await restarted.resume_interrupted_runs()
        await asyncio.gather(*restarted._run_tasks.values())  # noqa: SLF001

    asyncio.run(scenario())
    assert resumed == [(run.runId, checkpoint)]


def test_runtime_restart_reattaches_waiting_operation_watcher(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = AgentStateStore(tmp_path)
    params = {"novelId": "novel_1", "chapterId": "chapter_1", "userIntent": "续写"}
    operation_key, params_hash = build_durable_operation_key(
        "plan_restart_waiting",
        "step_draft",
        "chapter.generate_draft",
        params,
    )
    run = AgentRun(
        runId="run_durable_waiting_restart",
        threadId="thread_1",
        planId="plan_restart_waiting",
        status="running",
        currentStepId="step_draft",
        draftOperationId="draft_operation_waiting_restart",
        draftOperationKey=operation_key,
        draftOperationStatus="running_generation",
        draftOperationVersion=2,
    )
    state = store.load()
    state.runs[run.runId] = run
    store.save(state)
    store.prepare_invocation(ToolInvocationRecord(
        invocationKey=operation_key,
        requestId=new_id("automation"),
        runId=run.runId,
        stepId=run.currentStepId,
        method="chapter.generate_draft",
        paramsHash=params_hash,
        sideEffect=True,
        status="prepared",
    ))
    store.mark_invocation_operation_pending(operation_key, {
        "operationId": run.draftOperationId,
        "operationKey": operation_key,
        "status": "running_generation",
        "version": 2,
    })
    monkeypatch.setattr(PlanExecutionGraph, "has_checkpoint", lambda self, thread_id: True)
    restarted = NovelAgentRuntime(store, RecordingAutomation(), AgentEventBus(store))
    pending_operation = {
        "operationId": run.draftOperationId,
        "operationKey": operation_key,
        "operationStatus": "running_generation",
        "operationVersion": 2,
        "pollAfterSeconds": 1,
    }
    checkpoint = {
        "run_id": run.runId,
        "approved_step_ids": ["step_draft"],
        "novel_id": "novel_1",
        "volume_id": None,
        "chapter_id": "chapter_1",
        "current_content": "",
        "locale": "zh-CN",
        "step_index": 0,
        "tool_index": 0,
        "phase": "before_tool",
        "action": "waiting_operation",
        "checkpoint": None,
        "resume_response": None,
        "latest_analysis_summary": "",
        "report_findings": [],
        "creative_direction_checked": True,
        "toolchain_state": None,
        "pending_operation": pending_operation,
    }
    monkeypatch.setattr(restarted.execution_graph, "load_checkpoint_state", lambda thread_id: checkpoint)
    scheduled: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        restarted,
        "_schedule_draft_operation_watcher",
        lambda run_id, pending: scheduled.append((run_id, pending)),
    )

    asyncio.run(restarted.resume_interrupted_runs())

    assert scheduled == [(run.runId, pending_operation)]
    assert restarted._run_tasks == {}  # noqa: SLF001


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
            await runtime._tool_invoke(run, "creative_assets.generate_draft", params)  # noqa: SLF001
        with pytest.raises(SideEffectResultUnknown):
            await runtime._tool_invoke(run, "creative_assets.generate_draft", params)  # noqa: SLF001

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
    invocation_key, params_hash = build_invocation_key(run.runId, run.currentStepId, "creative_assets.generate_draft", params)
    store.prepare_invocation(
        ToolInvocationRecord(
            invocationKey=invocation_key,
            requestId=new_id("automation"),
            runId=run.runId,
            stepId=run.currentStepId,
            method="creative_assets.generate_draft",
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
            "creative_assets.generate_draft",
            params,
        )
        store.prepare_invocation(ToolInvocationRecord(
            invocationKey=invocation_key,
            requestId=new_id("automation"),
            runId=run.runId,
            stepId=run.currentStepId,
            method="creative_assets.generate_draft",
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

        result = await runtime._tool_invoke(run, "creative_assets.generate_draft", params)  # noqa: SLF001

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
