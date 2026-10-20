from __future__ import annotations

import asyncio
from collections import Counter
import sqlite3
from types import SimpleNamespace

import pytest

from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.skill_analysis_graph import SkillAnalysisGraph, SkillWorkUnitStore
from novel_agent_runtime.skill_analysis_graph import fingerprint
from novel_agent_runtime.style_quality import review_evidence_page, quality_key
from novel_agent_runtime.skill_execution import STYLE_EXECUTION_HINTS
from novel_agent_runtime.toolchains.schemas import ToolchainError
from novel_agent_runtime.intent.schemas import FailedRunRef, IntentConversationState, IntentRequest, SemanticProposal
from novel_agent_runtime.intent.service import IntentService
from test_runtime import FakeAutomationClient
from test_runtime_analysis_restart import prepare
from test_skill_analysis_graph import POLICY, analysis, chapters


def test_unknown_result_does_not_turn_continue_into_a_new_request_or_plan():
    request = IntentRequest(message="继续", conversationId="original", conversationState=IntentConversationState(
        latestFailedRun=FailedRunRef(runId="failed", failureRevision=1, requiresUnconfirmedRetry=True)))
    service = IntentService()
    result = service.finalize(request, service.preflight(request), SemanticProposal(responseContent="", shouldPlan=True))
    assert result.route == "respond"
    assert result.recovery is None and result.operations == []
    assert "UNCONFIRMED_REQUEST_REQUIRES_EXPLICIT_RETRY" in result.reasonCodes
    assert "可能重复计费" in result.responseContent


def test_explicit_retry_recovers_saved_results_and_resends_only_unconfirmed_units(tmp_path, monkeypatch):
    async def scenario():
        store, original, _ = prepare(tmp_path, monkeypatch)
        units = SkillWorkUnitStore(tmp_path / "agent_skill_units.db")
        graph = SkillAnalysisGraph(tmp_path / "agent_skill_graph.db", units)
        owner = f"{original.runId}:{original.currentStepId}"
        refs, saved, initial_calls, new_calls = {}, {}, Counter(), Counter()
        initial_request_ids = {}

        async def read(chapter):
            return {**chapter, "contentMode": "full", "content": "原文"}

        async def progress(_):
            pass

        async def interrupted_model(kind, payload, key):
            if kind == "merge":
                return payload["source"]["results"][0]
            cid = payload["source"]["samples"][0]["sourceId"]
            initial_calls[cid] += 1
            if cid in {"chapter-1", "chapter-2"}:
                request_id = payload["requestId"]
                refs[request_id] = {"runId": original.runId, "stepId": original.currentStepId,
                    "owner": owner, "unitKey": key, "status": "prepared", "sourceMethod": "agent.analyze_skill_work_unit"}
                initial_request_ids[cid] = request_id
                if cid == "chapter-2":
                    saved[request_id] = analysis(cid)
                raise ToolchainError("PROVIDER_TIMEOUT", "process interrupted before result consumption")
            return analysis(cid)

        kwargs = dict(owner=owner, chapters=chapters(6), goal="Analyze", skill_hash="locked",
            hints=STYLE_EXECUTION_HINTS, policy=POLICY, read=read, progress=progress, check_cancelled=lambda: None)
        with pytest.raises(ToolchainError):
            await graph.run(**kwargs, model=interrupted_model)
        # Reservation left by the pre-dispatch parent guard, as in the real incident.
        units.begin(owner, "orphan", "input", 1, POLICY)
        units.begin("other-task", "unrelated", "input", 1, POLICY)
        state = store.load()
        state.skillRequestRefs.update(refs)
        state.runs[original.runId].status = "failed"
        state.runs[original.runId].failureRevision = 1
        state.runs[original.runId].failure = {"code": "SIDE_EFFECT_UNKNOWN", "message": "工作单元请求结果尚未核对，不能自动重复收费请求。"}
        store.save(state)

        class RecoverAutomation(FakeAutomationClient):
            async def invoke(self, method, params, origin, **kwargs):
                if method == 'agent_skill.pack.default.get':
                    return {'packId': None, 'version': 0}
                self.calls.append((method, params, origin))
                if method == "agent.reprocess_saved_structured_output":
                    if params["modelResultRef"] not in saved:
                        raise AutomationInvokeError("MODEL_RESULT_NOT_FOUND", "no checkpoint")
                    return {"payload": saved[params["modelResultRef"]]}
                assert method == "agent.analyze_skill_work_unit"
                cid = params["source"]["samples"][0]["sourceId"]
                new_calls[cid] += 1
                assert kwargs["request_id"] != initial_request_ids.get(cid)
                return analysis(cid)

        automation = RecoverAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        failed = runtime.state.runs[original.runId]
        refreshed = runtime.run_status({"runId": failed.runId})
        assert refreshed.recovery.blockedReason == "unconfirmed_model_request"
        assert refreshed.recovery.actionLabel == "重新请求未确认分片"
        assert runtime._retryable_failed_run_ref(failed.runId).retryable is False
        chat = await runtime.chat({"message": "继续", "conversationId": "same-thread",
            "conversationContext": {"activeRun": {"runId": failed.runId, "status": "failed"}}}, {})
        assert chat.intentDecision.route == "respond"
        assert chat.intentDecision.recovery is None
        assert "UNCONFIRMED_REQUEST_REQUIRES_EXPLICIT_RETRY" in chat.intentDecision.reasonCodes
        assert automation.calls == [], "unconfirmed continuation is handled locally without a provider call"
        before_runs = len(runtime.state.runs)
        with pytest.raises(ValueError, match="无法直接从检查点继续"):
            await runtime.retry_run({"failedRunId": failed.runId, "expectedFailureRevision": 1}, {})
        assert len(runtime.state.runs) == before_runs and automation.calls == []

        async def execute(run_id, initial_state):
            run = runtime.state.runs[run_id]
            await runtime._reconcile_unconfirmed_analysis_requests(run)
            async def recovered_model(kind, payload, key):
                if kind == "merge":
                    return payload["source"]["results"][0]
                if kind == "recover":
                    return await runtime._recover_skill_model("agent.analyze_skill_work_unit", payload["requestId"])
                return await runtime._invoke_skill_model(run, "agent.analyze_skill_work_unit", payload, payload["requestId"], key)
            result = await graph.run(**kwargs, model=recovered_model)
            assert result["chapterCount"] == 6
            await runtime._finish_run(run, "completed", "run_completed", {})

        monkeypatch.setattr(runtime, "_run_graph_guarded", execute)
        retry = await runtime.retry_run({"failedRunId": failed.runId, "expectedFailureRevision": 1,
            "mode": "retry_unconfirmed_units"}, {})
        await asyncio.gather(*runtime._run_tasks.values())
        assert retry.status == "completed" and retry.planId == failed.planId
        assert initial_calls == Counter({"chapter-0": 1, "chapter-1": 1, "chapter-2": 1})
        assert new_calls == Counter({"chapter-1": 1, "chapter-3": 1, "chapter-4": 1, "chapter-5": 1})
        assert runtime.state.skillRequestRefs[initial_request_ids["chapter-1"]]["status"] == "abandoned"
        assert runtime.state.skillRequestRefs[initial_request_ids["chapter-2"]]["status"] == "completed"
        assert units.record("orphan")["status"] == "failed"
        assert units.record("unrelated")["status"] == "running"
        with sqlite3.connect(units.path) as db:
            attempt = db.execute("SELECT attempts FROM skill_work_units WHERE unit_key=?", (refs[initial_request_ids["chapter-1"]]["unitKey"],)).fetchone()[0]
            assert attempt == 2, "uncertain attempt and its reservations are retained"

    asyncio.run(scenario())


@pytest.mark.parametrize("code", ["NETWORK_ERROR", "MODEL_OUTPUT_INVALID", "STORAGE_BUSY", "MALFORMED_RESPONSE"])
def test_failed_reconciliation_does_not_authorize_repeating_requests(tmp_path, monkeypatch, code):
    async def scenario():
        store, original, _ = prepare(tmp_path, monkeypatch)
        units = SkillWorkUnitStore(tmp_path / "agent_skill_units.db")
        SkillAnalysisGraph(tmp_path / "agent_skill_graph.db", units)
        owner = f"{original.runId}:{original.currentStepId}"
        units.begin(owner, "unit", "input", 1, POLICY)
        request = units.record("unit")["requestId"]
        class FailedLookup(FakeAutomationClient):
            async def invoke(self, *_args, **_kwargs):
                if code == "MALFORMED_RESPONSE":
                    return {}
                raise AutomationInvokeError(code, "lookup failed")
        runtime = NovelAgentRuntime(store, FailedLookup(), AgentEventBus(store))
        runtime.state.skillRequestRefs[request] = {"owner": owner, "sourceMethod": "agent.analyze_skill_work_unit", "status": "prepared"}
        run = runtime.state.runs[original.runId]
        with pytest.raises((ToolchainError, AutomationInvokeError)):
            await runtime._reconcile_unconfirmed_analysis_requests(run)
        assert units.record("unit")["status"] == "running"
        assert runtime.state.skillRequestRefs[request]["status"] == "prepared"
    asyncio.run(scenario())


def test_missing_model_result_immediately_exposes_explicit_action(tmp_path, monkeypatch):
    async def scenario():
        store, original, _ = prepare(tmp_path, monkeypatch)
        class MissingLookup(FakeAutomationClient):
            async def invoke(self, *_args, **_kwargs):
                raise AutomationInvokeError("MODEL_RESULT_NOT_FOUND", "missing result")
        runtime = NovelAgentRuntime(store, MissingLookup(), AgentEventBus(store))
        run = runtime.state.runs[original.runId]
        run.status = "running"
        runtime.state.skillRequestRefs["pending"] = {"status": "prepared"}
        with pytest.raises(ToolchainError) as raised:
            await runtime._recover_skill_model("agent.analyze_skill_work_unit", "pending")
        assert raised.value.code == "MODEL_RESULT_UNAVAILABLE"
        await runtime._finish_run(run, "failed", "run_failed", {"code": raised.value.code, "message": str(raised.value)})
        assert run.recovery.blockedReason == "unconfirmed_model_request"
        assert run.recovery.actionLabel == "重新请求未确认分片"
        assert store.list_events(run.runId)[-1].payload["recovery"]["blockedReason"] == "unconfirmed_model_request"
        assert store.load().skillRequestRefs["pending"]["status"] == "result_unavailable"
    asyncio.run(scenario())


def test_explicit_unconfirmed_retry_cannot_replay_write_stage(tmp_path, monkeypatch):
    store, original, _ = prepare(tmp_path, monkeypatch, status="failed", stage="compile")
    runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    run = runtime.state.runs[original.runId]
    run.failureRevision = 1
    with pytest.raises(ValueError, match="Only an unresolved read-only analysis"):
        asyncio.run(runtime.retry_run({"failedRunId": run.runId, "expectedFailureRevision": 1, "mode": "retry_unconfirmed_units"}, {}))
    assert len(runtime.state.runs) == 1 and runtime._run_tasks == {}


@pytest.mark.parametrize("lookup", ["saved", "missing", "network"])
def test_network_failed_evidence_manual_retry_reconciles_before_new_generation(tmp_path, monkeypatch, lookup):
    async def scenario():
        store, original, _ = prepare(tmp_path, monkeypatch, status="failed", stage="evidence_review")
        units = SkillWorkUnitStore(tmp_path / "agent_skill_units.db")
        def result(source):
            return {"phase": "evidence", "decisions": [{"findingRef": c["findingRef"], "feature": "short_actions",
                "disposition": "supported", "reason": "局部引文支持"} for c in source["candidates"]]}
        source = {"features": {}, "coverage": {}, "candidates": [{"findingRef": str(i), **analysis()["findings"][0]} for i in range(16)]}
        left = {**source, "candidates": source["candidates"][:8]}
        right = {**source, "candidates": source["candidates"][8:]}
        owner = f"{original.runId}:{original.currentStepId}"
        complete_key = quality_key(original, "evidence", left)
        pending_key = quality_key(original, "evidence", right)
        units.begin(owner, complete_key, fingerprint(left), 100, POLICY)
        units.finish(complete_key, result(left))
        units.begin(owner, pending_key, fingerprint(right), 100, POLICY)
        request = units.record(pending_key)["requestId"]
        state = store.load()
        state.runs[original.runId].failureRevision = 1
        state.runs[original.runId].failure = {"code": "NETWORK_ERROR", "message": "interrupted"}
        state.skillRequestRefs[request] = {"owner": owner, "unitKey": pending_key,
            "status": "unknown", "sourceMethod": "agent.style_quality"}
        store.save(state)
        calls = []
        class Recover(FakeAutomationClient):
            async def invoke(self, method, params, origin, **kwargs):
                if method == 'agent_skill.pack.default.get':
                    return {'packId': None, 'version': 0}
                calls.append(method)
                if method == "agent.reprocess_saved_structured_output":
                    assert params["modelResultRef"] == request
                    if lookup == "missing":
                        raise AutomationInvokeError("MODEL_RESULT_NOT_FOUND", "not saved")
                    if lookup == "network":
                        raise AutomationInvokeError("NETWORK_ERROR", "lookup interrupted")
                    return {"payload": result(right)}
                assert method == "agent.style_quality"
                assert lookup == "missing" and kwargs["request_id"] != request
                assert params["source"] == right
                return result(right)
        runtime = NovelAgentRuntime(store, Recover(), AgentEventBus(store))
        async def get_graph():
            return SimpleNamespace(store=units)
        runtime.skill_execution_engine = SimpleNamespace(get_graph=get_graph)
        run = runtime.state.runs[original.runId]
        assert run.recovery.canRecover and run.recovery.blockedReason == "unconfirmed_model_request"
        assert calls == []
        with pytest.raises(ValueError, match="无法直接从检查点继续"):
            await runtime.retry_run({"failedRunId": run.runId, "expectedFailureRevision": run.failureRevision}, {})
        assert len(runtime.state.runs) == 1 and calls == []
        async def execute(run_id, initial_state):
            retry = runtime.state.runs[run_id]
            try:
                reviewed = await review_evidence_page(runtime, retry, source, POLICY)
            except (AutomationInvokeError, ToolchainError) as error:
                await runtime._finish_run(retry, "failed", "run_failed", {"code": error.code, "message": str(error)})
            else:
                assert [c["findingRef"] for c in reviewed["decisions"]] == [str(i) for i in range(16)]
                await runtime._finish_run(retry, "completed", "run_completed", {})
        monkeypatch.setattr(runtime, "_run_graph_guarded", execute)
        retry = await runtime.retry_run({"failedRunId": run.runId, "expectedFailureRevision": run.failureRevision,
            "mode": "retry_unconfirmed_units"}, {})
        await asyncio.gather(*tuple(runtime._run_tasks.values()))
        assert calls == (["agent.reprocess_saved_structured_output", "agent.style_quality"] if lookup == "missing"
            else ["agent.reprocess_saved_structured_output"])
        assert units.record(complete_key)["status"] == "completed"
        if lookup == "network":
            assert units.record(pending_key)["status"] == "running"
            assert retry.status == "failed" and retry.recovery.canRecover
            assert retry.recovery.blockedReason == "unconfirmed_model_request"
        else:
            assert retry.status == "completed" and units.record(pending_key)["status"] == "completed"
            assert units.record(pending_key)["requestId"] != request if lookup == "missing" else units.record(pending_key)["requestId"] == request
    asyncio.run(scenario())
