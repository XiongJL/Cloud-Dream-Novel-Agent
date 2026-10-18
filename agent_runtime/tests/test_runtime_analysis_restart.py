from __future__ import annotations

import asyncio
from collections import Counter
import sqlite3

import pytest

from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.execution_graph import PlanExecutionGraph
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentPlan, AgentPlanStep, AgentRun, AgentRunEvent, AgentRecoveryDescriptor
from novel_agent_runtime.skill_analysis_graph import SkillAnalysisGraph, SkillWorkUnitStore
from novel_agent_runtime.skill_execution import STYLE_EXECUTION_HINTS
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.schemas import ToolchainError, ToolchainInvocation
from test_runtime import FakeAutomationClient
from test_skill_analysis_graph import POLICY, analysis, chapters


def checkpoint(run, operation="agent_skill.style_extract", stage="analyze"):
    return {
        "run_id": run.runId, "approved_step_ids": [run.currentStepId], "approval_mode": "standard",
        "novel_id": "novel-1", "volume_id": None, "chapter_id": "chapter-0", "current_content": "",
        "locale": "zh-CN", "step_index": 0, "tool_index": 0, "phase": "toolchain", "action": "continue",
        "checkpoint": None, "resume_response": None, "latest_analysis_summary": "", "report_findings": [],
        "creative_direction_checked": True, "pending_operation": None,
        "toolchain_state": {"toolchainId": operation, "stage": stage, "source": {"kind": "novel"}},
    }


def prepare(tmp_path, monkeypatch, *, status="running", stage="analyze"):
    store = AgentStateStore(tmp_path)
    run = AgentRun(runId="original-run", planId="original-plan", threadId="original-thread",
                   currentStepId="original-step", status=status)
    plan = AgentPlan(planId=run.planId, threadId=run.threadId, title="Analyze", goal="Analyze",
        steps=[AgentPlanStep(stepId=run.currentStepId, agent="writer", title="Analyze", status="running",
                            toolchain=ToolchainInvocation(id="agent_skill.style_extract", version="1.0.0", input={}))])
    state = store.load()
    state.runs[run.runId] = run
    state.plans[plan.planId] = plan
    store.save(state)
    cp = checkpoint(run, stage=stage)
    monkeypatch.setattr(PlanExecutionGraph, "load_checkpoint_state", lambda *_: cp)
    return store, run, cp


def test_restart_records_actionable_failure_and_does_not_resume_automatically(tmp_path, monkeypatch):
    store, original, _ = prepare(tmp_path, monkeypatch)
    runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    run = runtime.state.runs[original.runId]
    assert run.status == "failed"
    assert run.failureRevision == 1
    assert run.failure["retryable"] is True
    assert run.recovery.canRecover is True
    assert run.recovery.actionLabel == "从检查点继续"
    assert runtime.state.plans[run.planId].steps[0].status == "failed"
    assert runtime._run_tasks == {}
    assert runtime._retryable_failed_run_ref(run.runId) is not None
    assert store.load().runs[run.runId].failure == run.failure
    assert store.list_events(run.runId)[-1].payload["recovery"]["canRecover"] is True


def test_legacy_event_only_interruption_gains_recovery_once(tmp_path, monkeypatch):
    store, run, _ = prepare(tmp_path, monkeypatch, status="failed")
    event = store.append_event(AgentRunEvent(eventId="old-terminal", runId=run.runId, planId=run.planId,
        threadId=run.threadId, type="run_failed", status="failed", payload={"code": "RUNTIME_INTERRUPTED"}))
    state = store.load()
    state.runs[run.runId].events.append(event)
    store.save(state)
    first = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    assert first.state.runs[run.runId].recovery.canRecover is True
    assert first.state.runs[run.runId].failureRevision == 1
    second = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    assert second.state.runs[run.runId].failureRevision == 1
    assert len(store.list_events(run.runId)) == 2


@pytest.mark.parametrize("stage,cancelled,available", [("compile", False, True), ("analyze", True, True), ("analyze", False, False)])
def test_unsafe_phase_cancellation_and_missing_checkpoint_are_not_replayable(tmp_path, monkeypatch, stage, cancelled, available):
    store, run, _ = prepare(tmp_path, monkeypatch, stage=stage)
    state = store.load()
    state.runs[run.runId].cancelRequested = cancelled
    store.save(state)
    if not available:
        monkeypatch.setattr(PlanExecutionGraph, "load_checkpoint_state", lambda *_: None)
    runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    failed = runtime.state.runs[run.runId]
    assert failed.failureRevision == 1
    assert failed.recovery.canRecover is False
    assert failed.failure["retryable"] is False


def test_explicit_retry_recovers_child_checkpoint_and_saved_pending_request(tmp_path, monkeypatch):
    async def scenario():
        store, original, _ = prepare(tmp_path, monkeypatch)
        units = SkillWorkUnitStore(tmp_path / "agent_skill_units.db")
        graph = SkillAnalysisGraph(tmp_path / "agent_skill_graph.db", units)
        calls = Counter()
        saved = {}

        async def read(chapter):
            return {**chapter, "contentMode": "full", "content": "原文"}

        async def first_model(kind, payload, key):
            if kind == "merge":
                return payload["source"]["results"][0]
            cid = payload["source"]["samples"][0]["sourceId"]
            calls[cid] += 1
            raw = analysis(cid)
            if cid == "chapter-3":
                saved[payload["requestId"]] = raw
                raise ToolchainError("PROVIDER_TIMEOUT", "Response arrived after the old process stopped")
            return raw

        async def progress(_):
            pass

        kwargs = dict(owner=f"{original.runId}:{original.currentStepId}", chapters=chapters(6), goal="Analyze",
            skill_hash="locked", hints=STYLE_EXECUTION_HINTS, policy=POLICY, read=read,
            progress=progress, check_cancelled=lambda: None)
        with pytest.raises(ToolchainError):
            await graph.run(**kwargs, model=first_model)
        state = store.load()
        for request_id in saved:
            state.skillRequestRefs[request_id] = {"runId": original.runId, "status": "prepared",
                "sourceMethod": "agent.analyze_skill_work_unit"}
        store.save(state)

        class RecoverAutomation(FakeAutomationClient):
            async def invoke(self, method, params, origin, **_):
                if method == 'agent_skill.pack.default.get':
                    return {'packId': None, 'version': 0}
                assert method == "agent.reprocess_saved_structured_output"
                return {"payload": saved[params["modelResultRef"]]}

        runtime = NovelAgentRuntime(store, RecoverAutomation(), AgentEventBus(store))

        async def recovered_model(kind, payload, key):
            if kind == "recover":
                return await runtime._recover_skill_model("agent.analyze_skill_work_unit", payload["requestId"])
            assert kind == "merge", "completed or pending chapter requests must not be sent again"
            return payload["source"]["results"][0]

        async def execute(run_id, initial_state):
            assert initial_state["toolchain_state"]["stage"] == "analyze"
            result = await graph.run(**kwargs, model=recovered_model)
            assert result["chapterCount"] == 6
            await runtime._finish_run(runtime.state.runs[run_id], "completed", "run_completed", {})

        monkeypatch.setattr(runtime, "_run_graph_guarded", execute)
        failed = runtime.state.runs[original.runId]
        retried = await runtime.retry_run({"failedRunId": failed.runId, "expectedFailureRevision": 1}, {})
        await asyncio.gather(*runtime._run_tasks.values())
        assert retried.status == "completed"
        assert retried.retryRootRunId == original.runId
        assert calls == Counter({f"chapter-{i}": 1 for i in range(6)})
        assert all(runtime.state.skillRequestRefs[key]["status"] == "completed" for key in saved)
        with sqlite3.connect(units.path) as db:
            assert db.execute("SELECT max(attempts) FROM skill_work_units").fetchone()[0] == 1

    asyncio.run(scenario())


def test_checkpoint_reconciliation_does_not_hide_storage_failure(tmp_path):
    class DamagedStorage(FakeAutomationClient):
        async def invoke(self, *_args, **_kwargs):
            raise AutomationInvokeError("SQLITE_FULL", "database or disk is full")

    store = AgentStateStore(tmp_path)
    runtime = NovelAgentRuntime(store, DamagedStorage(), AgentEventBus(store))
    with pytest.raises(AutomationInvokeError, match="disk is full"):
        asyncio.run(runtime._recover_skill_model("agent.analyze_skill_work_unit", "saved"))


def test_legacy_busy_analysis_failure_gains_manual_recovery_without_replaying(tmp_path, monkeypatch):
    store, original, _ = prepare(tmp_path, monkeypatch, status="failed")
    state = store.load()
    state.runs[original.runId].failureRevision = 1
    state.runs[original.runId].failure = {"code": "P2010", "message": "Raw query failed. Code: `5`. Message: `database is locked`"}
    store.save(state)
    runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    run = runtime.state.runs[original.runId]
    assert run.failureRevision == 2
    assert run.failure["code"] == "STORAGE_BUSY"
    assert run.recovery.failureKind == "persistence_failed"
    assert run.recovery.canRecover is True
    assert runtime._retryable_failed_run_ref(run.runId) is not None
    assert runtime._run_tasks == {}
    again = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    assert again.state.runs[run.runId].failureRevision == 2


def test_busy_failure_is_actionable_after_graph_terminalization(tmp_path, monkeypatch):
    async def scenario():
        store, original, _ = prepare(tmp_path, monkeypatch)
        runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
        run = runtime.state.runs[original.runId]
        run.status = "running"
        run.recovery = None
        await runtime._finish_run(run, "failed", "run_failed", {"code": "STORAGE_BUSY", "retryable": False,
            "message": "checkpoint database is locked"})
        assert run.recovery.canRecover is True
        assert run.recovery.failureKind == "persistence_failed"
        assert runtime._retryable_failed_run_ref(run.runId) is not None
    asyncio.run(scenario())


@pytest.mark.parametrize("stage", ["analyze", "evidence_review", "quality_review", "trial"])
def test_legacy_readonly_truncation_gains_manual_recovery_without_replaying(tmp_path, monkeypatch, stage):
    store, original, _ = prepare(tmp_path, monkeypatch, status="failed", stage=stage)
    state = store.load()
    run = state.runs[original.runId]
    run.failureRevision = 1
    run.failure = {"code": "MODEL_OUTPUT_TRUNCATED", "message": "output limit"}
    # Older failure has a completed-only closure action, but no resume action.
    run.recovery = AgentRecoveryDescriptor(failureKind="execution_incomplete", failedAtPhase="model_received",
        retryStrategy="none", canRecover=False, canFinalizeCompleted=True, recoveryRevision=1, diagnosticRef="old")
    store.save(state)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
    run = runtime.state.runs[original.runId]
    assert run.failureRevision == 2
    assert run.recovery.failureKind == "model_output_truncated"
    assert run.recovery.canRecover and run.recovery.canFinalizeCompleted
    assert run.recovery.retryStrategy == "retry_request"
    assert runtime._retryable_failed_run_ref(run.runId).retryable
    assert runtime._run_tasks == {} and automation.calls == []
    again = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    assert again.state.runs[run.runId].failureRevision == 2


def test_truncation_resume_is_not_enabled_for_authoring_or_cancelled_run(tmp_path, monkeypatch):
    store, original, cp = prepare(tmp_path, monkeypatch, status="failed", stage="author")
    state = store.load()
    state.runs[original.runId].failure = {"code": "MODEL_OUTPUT_TRUNCATED", "message": "output limit"}
    store.save(state)
    runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    run = runtime.state.runs[original.runId]
    assert run.recovery is None
    cp["toolchain_state"]["stage"] = "evidence_review"
    run.cancelRequested = True
    assert runtime._refresh_readonly_analysis_recovery(run) is False
    assert run.recovery is None


def test_truncated_evidence_failure_exposes_checkpoint_action_immediately(tmp_path, monkeypatch):
    async def scenario():
        store, original, _ = prepare(tmp_path, monkeypatch, stage="evidence_review")
        runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
        run = runtime.state.runs[original.runId]
        run.status = "running"
        run.recovery = None
        await runtime._finish_run(run, "failed", "run_failed", {"code": "MODEL_OUTPUT_TRUNCATED", "retryable": False,
            "message": "single candidate truncated"})
        assert run.recovery.canRecover and run.recovery.failureKind == "model_output_truncated"
        assert runtime._retryable_failed_run_ref(run.runId).retryable
    asyncio.run(scenario())


@pytest.mark.parametrize("code", ["NETWORK_ERROR", "UPSTREAM_TIMEOUT", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"])
@pytest.mark.parametrize("pending", [False, True])
def test_legacy_readonly_network_failure_has_manual_action_without_auto_requests(tmp_path, monkeypatch, code, pending):
    store, original, _ = prepare(tmp_path, monkeypatch, status="failed", stage="evidence_review")
    state = store.load()
    run = state.runs[original.runId]
    run.failureRevision = 1
    run.failure = {"code": code, "message": "connection interrupted"}
    if pending:
        state.skillRequestRefs["pending"] = {"owner": f"{run.runId}:{run.currentStepId}",
            "status": "unknown", "sourceMethod": "agent.style_quality"}
    store.save(state)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
    run = runtime.state.runs[original.runId]
    assert run.recovery.canRecover and run.recovery.failureKind == "transport"
    assert run.failureRevision == 2
    ref = runtime._retryable_failed_run_ref(run.runId)
    assert ref.requiresUnconfirmedRetry is pending
    assert ref.retryable is not pending
    assert run.recovery.blockedReason == ("unconfirmed_model_request" if pending else None)
    assert runtime._run_tasks == {} and automation.calls == []
    again = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    assert again.state.runs[run.runId].failureRevision == 2


@pytest.mark.parametrize("stage,cancelled", [("compile", False), ("evidence_review", True)])
def test_network_action_is_not_enabled_for_write_or_cancelled_checkpoint(tmp_path, monkeypatch, stage, cancelled):
    store, original, _ = prepare(tmp_path, monkeypatch, status="failed", stage=stage)
    state = store.load()
    run = state.runs[original.runId]
    run.failure = {"code": "NETWORK_ERROR", "message": "connection interrupted"}
    run.cancelRequested = cancelled
    state.skillRequestRefs["pending"] = {"owner": f"{run.runId}:{run.currentStepId}",
        "status": "unknown", "sourceMethod": "agent.style_quality"}
    store.save(state)
    runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    run = runtime.run_status({"runId": original.runId})
    assert run.recovery is None


def test_graph_network_failure_immediately_exposes_manual_action_and_transport_details(tmp_path, monkeypatch):
    async def scenario():
        store, original, _ = prepare(tmp_path, monkeypatch, status="failed", stage="evidence_review")
        runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
        run = runtime.state.runs[original.runId]
        run.status = "running"
        runtime.state.skillRequestRefs["pending"] = {"owner": f"{run.runId}:{run.currentStepId}",
            "status": "unknown", "sourceMethod": "agent.style_quality"}
        async def interrupted(*_, **__):
            raise AutomationInvokeError("NETWORK_ERROR", "应用执行服务连接中断。", {
                "method": "agent.style_quality", "transportLayer": "automation", "requestId": "pending",
                "transportErrorType": "RemoteProtocolError", "partialText": "not part of public diagnostics"})
        monkeypatch.setattr(runtime.execution_graph, "run", interrupted)
        await runtime._run_graph_guarded(run.runId)
        assert run.status == "failed" and run.recovery.canRecover
        assert run.recovery.blockedReason == "unconfirmed_model_request"
        assert run.failure["transportLayer"] == "automation"
        assert run.failure["transportErrorType"] == "RemoteProtocolError"
        assert run.failure["requestId"] == "pending"
        assert "partialText" not in run.failure
        assert store.list_events(run.runId)[-1].payload["recovery"]["canRecover"]
    asyncio.run(scenario())


def test_saved_style_validation_draft_gets_manual_resume_without_reanalysis(tmp_path, monkeypatch):
    store, original, cp = prepare(tmp_path, monkeypatch, status="failed", stage="validate")
    cp["toolchain_state"].update({"skillWorkspace": {"draftId": "saved-draft"}, "stylePlan": {"skills": []},
        "styleValidationAttempt": 3, "styleAnalysisResult": {"unitRefs": ["complete-analysis"]}})
    state = store.load()
    run = state.runs[original.runId]
    run.failureRevision = 1
    run.failure = {"code": "STYLE_SKILL_WORKSPACE_NEEDS_ATTENTION", "message": "format check failed"}
    store.save(state)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
    run = runtime.state.runs[original.runId]
    status = runtime.run_status({"runId": run.runId})
    assert status.recovery.canRecover and status.recovery.actionLabel == "修复草稿并继续"
    assert status.failureRevision == 2
    assert runtime._retryable_failed_run_ref(run.runId).retryable
    assert runtime._run_tasks == {} and automation.calls == []
    captured = []
    async def continue_saved(run_id, initial_state):
        captured.append(initial_state["toolchain_state"])
    monkeypatch.setattr(runtime, "_run_graph_guarded", continue_saved)
    async def scenario():
        await runtime.retry_run({"failedRunId": run.runId, "expectedFailureRevision": 2}, {})
        await asyncio.gather(*tuple(runtime._run_tasks.values()))
    asyncio.run(scenario())
    assert captured[0]["stage"] == "validate"
    assert captured[0]["skillWorkspace"]["draftId"] == "saved-draft"
    assert captured[0]["styleAnalysisResult"]["unitRefs"] == ["complete-analysis"]
    assert automation.calls == []


def test_graph_normalizes_prisma_busy_and_retries_only_failed_partition(tmp_path):
    async def scenario():
        units = SkillWorkUnitStore(tmp_path / "units.db")
        graph = SkillAnalysisGraph(tmp_path / "graph.db", units)
        calls = Counter()
        busy = True

        async def read(chapter):
            return {**chapter, "contentMode": "full", "content": "原文"}

        async def model(kind, payload, key):
            if kind == "merge":
                return payload["source"]["results"][0]
            cid = payload["source"]["samples"][0]["sourceId"]
            calls[cid] += 1
            if busy and cid == "chapter-1":
                raise AutomationInvokeError("P2010", "Raw query failed. Code: `5`. Message: `database is locked`")
            return analysis(cid)

        async def progress(_):
            pass

        kwargs = dict(owner="same-root", chapters=chapters(6), goal="Analyze", skill_hash="locked",
            hints=STYLE_EXECUTION_HINTS, policy=POLICY, read=read, model=model,
            progress=progress, check_cancelled=lambda: None)
        with pytest.raises(ToolchainError) as failure:
            await graph.run(**kwargs)
        assert failure.value.code == "STORAGE_BUSY"
        assert failure.value.details["persistenceFailed"] is True
        assert failure.value.retryable is False
        assert calls == Counter({"chapter-0": 1, "chapter-1": 1, "chapter-2": 1})
        busy = False
        result = await graph.run(**kwargs)
        assert result["chapterCount"] == 6
        assert calls == Counter({f"chapter-{i}": (2 if i == 1 else 1) for i in range(6)})
    asyncio.run(scenario())
