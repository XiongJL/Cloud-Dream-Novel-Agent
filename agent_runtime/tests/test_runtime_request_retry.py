from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.invocations import DraftOperationFailed
from novel_agent_runtime.request_graph import RetryableRequestGraph
from novel_agent_runtime.retry import AgentRequestError, agent_retry_policy, normalize_agent_error
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentPlan, AgentPlanStep, AgentRecoveryDescriptor, AgentRun
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.schemas import ToolchainInvocation


class FlakyInvoker:
    transport_name = "test"

    def __init__(self) -> None:
        self.calls: dict[str, int] = {}

    async def invoke(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        origin: str = "desktop-ui",
        request_id: str | None = None,
        parent_request_id: str | None = None,
        deadline_at: str | None = None,
    ) -> Any:
        del origin, request_id, parent_request_id, deadline_at
        count = self.calls.get(method, 0) + 1
        self.calls[method] = count
        if method == "agent.generate_plan":
            if count < 4:
                raise AutomationInvokeError("PROVIDER_UNAVAILABLE", "gateway")
            return {"title": "检查计划", "steps": [{"agent": "editor", "title": "检查", "tools": ["chapter.get"]}]}
        if method == "agent.generate_chat":
            return {"content": "继续处理。", "shouldPlan": True, "needsClarification": False}
        if method in {"agent.generate_report", "chapter.get"} and count < 4:
            raise AutomationInvokeError("NETWORK_ERROR", "connection reset")
        if method == "agent.generate_report":
            return {"content": "报告完成", "conversationSummary": "报告完成"}
        if method == "chapter.get":
            return {"id": (params or {}).get("chapterId"), "title": "第一章"}
        if method == "chapter.draft.start":
            return {
                "operationId": "operation-definitive-failure",
                "operationKey": (params or {})["operationKey"],
                "status": "queued",
                "phase": "accepted",
                "version": 1,
                "attempt": 0,
                "maxAttempts": 4,
                "pollAfterMs": 1,
            }
        if method == "chapter.draft.get_status":
            return {
                "operationId": (params or {})["operationId"],
                "status": "definitive_failed",
                "phase": "terminal",
                "version": 2,
                "attempt": 1,
                "maxAttempts": 4,
                "error": {"code": "NETWORK_ERROR", "userMessage": "provider failed definitively"},
            }
        return {"ok": True}

    async def cancel(self, _request_id: str) -> bool:
        return True

    async def list_tools(self) -> list[str]:
        return ["chapter.get", "chapter.generate_draft"]


def create_runtime(tmp_path: Path) -> tuple[NovelAgentRuntime, FlakyInvoker]:
    store = AgentStateStore(tmp_path)
    invoker = FlakyInvoker()
    runtime = NovelAgentRuntime(store, invoker, AgentEventBus(store), tool_adapter=invoker)
    runtime.request_graph = RetryableRequestGraph(agent_retry_policy(
        initial_interval=0.001,
        backoff_factor=1,
        max_interval=0.001,
        jitter=False,
    ))
    return runtime, invoker


def test_plan_generation_uses_request_graph_without_creating_duplicate_plan(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        plan = await runtime.plan({"goal": "检查第一章", "novelId": "novel-1", "chapterId": "chapter-1"}, {})

        assert invoker.calls["agent.generate_plan"] == 4
        assert len(runtime.state.plans) == 1
        assert runtime.state.plans[plan.planId].title == "检查计划"

    asyncio.run(scenario())


def test_run_model_and_read_only_tool_emit_retry_events(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        run = AgentRun(runId="run-1", threadId="thread-1", planId="plan-1", status="running", currentStepId="step-1")
        runtime.state.runs[run.runId] = run

        report = await runtime._automation_invoke(run, "agent.generate_report", {"goal": "检查"})
        chapter = await runtime._tool_invoke(run, "chapter.get", {"chapterId": "chapter-1"})

        assert report["content"] == "报告完成"
        assert chapter["id"] == "chapter-1"
        assert invoker.calls["agent.generate_report"] == 4
        assert invoker.calls["chapter.get"] == 4
        event_types = [event.type for event in run.events]
        assert event_types.count("request_retry_scheduled") == 6
        assert event_types.count("request_retry_started") == 6
        assert event_types.count("request_retry_succeeded") == 2
        assert all(event.payload.get("retryLimit") == 3 for event in run.events)

    asyncio.run(scenario())


def test_run_deadline_guard_finishes_a_stalled_toolchain_with_terminal_events(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _invoker = create_runtime(tmp_path)
        step = AgentPlanStep(
            stepId="step-stalled",
            agent="writer",
            title="Stalled style extraction",
            tools=[],
            status="running",
            toolchain=ToolchainInvocation(
                id="agent_skill.style_extract",
                version="1.0.0",
                input={},
            ),
        )
        plan = AgentPlan(
            planId="plan-stalled",
            threadId="thread-stalled",
            title="Stalled plan",
            goal="Extract style",
            requiresApproval=True,
            steps=[step],
            preferredRole="writer",
            deliverable="report",
        )
        run = AgentRun(
            runId="run-stalled",
            threadId=plan.threadId,
            planId=plan.planId,
            status="running",
            currentStepId=step.stepId,
            deadlineAt=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),
        )
        runtime.state.plans[plan.planId] = plan
        runtime.state.runs[run.runId] = run

        class StalledExecutionGraph:
            async def run(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
                await runtime._emit(
                    run,
                    "tool_call",
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name="chapter.scope_context.build",
                    status="running",
                    payload={
                        "toolchainId": step.toolchain.id,
                        "nodeId": "style_source.read",
                    },
                )
                await asyncio.Event().wait()
                return {"action": "terminal"}

        runtime.execution_graph = StalledExecutionGraph()  # type: ignore[assignment]
        await runtime._run_graph_guarded(run.runId, initial_state={})  # type: ignore[arg-type]

        assert run.status == "failed"
        event_types = [event.type for event in runtime.store.list_events(run.runId)]
        expected = ["tool_call", "tool_result", "toolchain_failed", "step_failed", "run_failed"]
        positions = [event_types.index(event_type) for event_type in expected]
        assert positions == sorted(positions)
        assert next(event for event in run.events if event.type == "tool_result").status == "failed"
        assert next(event for event in run.events if event.type == "run_failed").payload["code"] == "UPSTREAM_TIMEOUT"

    asyncio.run(scenario())


def test_semantic_draft_tool_uses_durable_operation_without_sync_fallback(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        run = AgentRun(runId="run-write", threadId="thread-1", planId="plan-1", status="running", currentStepId="step-write")
        runtime.state.runs[run.runId] = run

        with pytest.raises(DraftOperationFailed):
            await runtime._tool_invoke(run, "chapter.generate_draft", {"chapterId": "chapter-1"})

        assert invoker.calls["chapter.draft.start"] == 1
        assert invoker.calls["chapter.draft.get_status"] == 1
        assert "chapter.generate_draft" not in invoker.calls
        assert not any(event.type.startswith("request_retry") for event in run.events)

    asyncio.run(scenario())


def test_typed_retry_uses_retryable_failed_run_from_prior_runs(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        failed = AgentRun(
            runId="run-prior-failed",
            threadId="thread-1",
            planId="plan-1",
            status="failed",
            failureRevision=1,
        )
        runtime.state.runs[failed.runId] = failed
        await runtime._emit(
            failed,
            "request_retry_exhausted",
            status="failed",
            payload={"code": "PROVIDER_UNAVAILABLE", "retryable": True},
        )
        await runtime._emit(
            failed,
            "run_failed",
            status="failed",
            payload={"code": "PROVIDER_UNAVAILABLE", "failureRevision": 1},
        )

        recovery_intent = await runtime.chat(
            {
                "message": "重试",
                "conversationId": "conversation-retry",
                "conversationContext": {
                    "activeRun": None,
                    "priorRuns": [{"runId": failed.runId, "status": "failed"}],
                },
            },
            {},
        )

        assert recovery_intent.intentDecision is not None
        assert recovery_intent.intentDecision.route == "retry_failed_run"
        assert recovery_intent.intentDecision.recovery is not None
        assert recovery_intent.intentDecision.recovery.failedRunId == failed.runId
        assert recovery_intent.suggestedActions == [{"label": "重试失败步骤", "method": "agent.retry_run"}]
        assert invoker.calls.get("agent.generate_chat", 0) == 0

    asyncio.run(scenario())


def test_exhausted_final_report_fails_once_without_artifact_or_raw_error(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        original_invoke = invoker.invoke

        async def always_fail_report(
            method: str,
            params: dict[str, Any] | None = None,
            origin: str = "desktop-ui",
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_report":
                invoker.calls[method] = invoker.calls.get(method, 0) + 1
                raise AutomationInvokeError(
                    "PROVIDER_UNAVAILABLE",
                    "HTTP 504 <html>private gateway page</html>",
                    {"httpStatus": 504, "retryable": True},
                )
            return await original_invoke(method, params, origin, request_id)

        invoker.invoke = always_fail_report  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "检查第一章", "novelId": "novel-1", "chapterId": "chapter-1"}, {})
        plan.deliverable = "report"
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {},
        )
        for _ in range(2000):
            if runtime.state.runs[run.runId].status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)

        failed = runtime.state.runs[run.runId]
        assert failed.status == "failed"
        assert invoker.calls["agent.generate_report"] == 4
        assert failed.artifacts == []
        assert sum(event.type == "request_retry_exhausted" for event in failed.events) == 1
        assert sum(event.type == "run_failed" for event in failed.events) == 1
        terminal = next(event for event in failed.events if event.type == "run_failed")
        assert terminal.payload["attempts"] == 4
        assert terminal.payload["httpStatus"] == 504
        assert terminal.payload["failureRevision"] == 1
        assert "<html>" not in str(failed.events)

        original_event_count = len(failed.events)
        recovery_intent = await runtime.chat(
            {
                "message": "继续",
                "conversationId": "conversation-retry",
                "conversationContext": {"activeRun": {"runId": failed.runId, "status": "failed"}},
            },
            {},
        )
        assert recovery_intent.intentDecision is not None
        assert recovery_intent.intentDecision.route == "retry_failed_run"
        assert recovery_intent.intentDecision.recovery is not None
        assert recovery_intent.intentDecision.recovery.failedRunId == failed.runId
        assert recovery_intent.suggestedActions == [{"label": "重试失败步骤", "method": "agent.retry_run"}]
        assert invoker.calls.get("agent.generate_chat", 0) == 0

        with pytest.raises(ValueError, match="revision conflict"):
            await runtime.retry_run(
                {"failedRunId": failed.runId, "expectedFailureRevision": 2, "mode": "failed_node"},
                {},
            )

        invoker.invoke = original_invoke  # type: ignore[method-assign]
        resumed = await runtime.retry_run(
            {"failedRunId": failed.runId, "expectedFailureRevision": 1, "mode": "failed_node"},
            {},
        )
        for _ in range(2000):
            if runtime.state.runs[resumed.runId].status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)

        completed = runtime.state.runs[resumed.runId]
        assert completed.status == "completed"
        assert completed.retryOfRunId == failed.runId
        assert completed.retryRootRunId == failed.runId
        assert completed.retryAttempt == 1
        assert completed.approvalResponses == failed.approvalResponses
        assert completed.resumedFrom and completed.resumedFrom["phase"] == "final_report"
        assert invoker.calls["agent.generate_report"] == 5
        assert invoker.calls["chapter.get"] == 4
        assert len(completed.artifacts) == 1
        assert completed.artifacts[0].type == "report"
        assert sum(event.type == "run_retry_started" for event in completed.events) == 1
        assert failed.status == "failed"
        assert failed.failureRevision == 1
        assert len(failed.events) == original_event_count

        with pytest.raises(ValueError, match="already has a linked retry"):
            await runtime.retry_run(
                {"failedRunId": failed.runId, "expectedFailureRevision": 1, "mode": "failed_node"},
                {},
            )

    asyncio.run(scenario())


def test_retry_run_rejects_side_effect_unknown_before_loading_checkpoint(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        failed = AgentRun(
            runId="run-side-effect",
            threadId="thread-1",
            planId="plan-1",
            status="failed",
            failureRevision=1,
        )
        runtime.state.runs[failed.runId] = failed
        await runtime._emit(
            failed,
            "run_failed",
            status="failed",
            payload={"code": "SIDE_EFFECT_UNKNOWN", "failureRevision": 1},
        )

        with pytest.raises(ValueError, match="reconciled"):
            await runtime.retry_run(
                {"failedRunId": failed.runId, "expectedFailureRevision": 1, "mode": "failed_node"},
                {},
            )

    asyncio.run(scenario())


def test_retryable_toolchain_failure_without_request_exhaustion_resumes_failed_node(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        plan = AgentPlan(
            planId="plan-research-retry",
            threadId="thread-research-retry",
            title="只读考据",
            goal="核对证据",
            steps=[AgentPlanStep(stepId="step-research", agent="research_rag", title="综合证据")],
        )
        failed = AgentRun(
            runId="run-research-retry",
            threadId=plan.threadId,
            planId=plan.planId,
            status="failed",
            currentStepId=plan.steps[0].stepId,
            failureRevision=1,
        )
        runtime.state.plans[plan.planId] = plan
        runtime.state.runs[failed.runId] = failed
        await runtime._emit(failed, "run_failed", payload={
            "code": "NODE_FAILED", "nodeId": "research.synthesize", "retryable": True,
        })
        assert not any(event.type == "request_retry_exhausted" for event in failed.events)
        assert runtime._retryable_failed_run_ref(failed.runId) is not None
        intent = await runtime.chat({
            "message": "重试失败步骤",
            "conversationId": "conversation-research-retry",
            "conversationContext": {"priorRuns": [{"runId": failed.runId, "status": "failed"}]},
        }, {})
        assert intent.intentDecision and intent.intentDecision.route == "retry_failed_run"
        assert intent.intentDecision.recovery and intent.intentDecision.recovery.failedRunId == failed.runId
        runtime.execution_graph.load_checkpoint_state = lambda _thread_id: {  # type: ignore[method-assign]
            "run_id": failed.runId,
            "approved_step_ids": [plan.steps[0].stepId],
            "novel_id": "novel-1",
            "volume_id": None,
            "chapter_id": "chapter-1",
            "current_content": "",
            "locale": "zh-CN",
            "step_index": 0,
            "tool_index": 0,
            "phase": "toolchain",
            "action": "continue",
            "checkpoint": None,
            "resume_response": None,
            "latest_analysis_summary": "",
            "report_findings": [],
            "creative_direction_checked": False,
            "toolchain_state": {"claimsExtracted": True, "researchSearchIndex": 1, "researchSearchQueue": ["claim-1"]},
            "pending_operation": None,
        }

        resumed_states: list[Any] = []

        async def no_op_guarded(*_args: Any, **kwargs: Any) -> None:
            resumed_states.append(kwargs.get("initial_state"))
            return None

        runtime._run_graph_guarded = no_op_guarded  # type: ignore[method-assign]
        linked = await runtime.retry_run({
            "failedRunId": failed.runId,
            "expectedFailureRevision": 1,
            "mode": "failed_node",
        }, {})
        assert linked.retryOfRunId == failed.runId
        assert linked.resumedFrom and linked.resumedFrom["phase"] == "toolchain"
        await asyncio.sleep(0)
        assert resumed_states and resumed_states[0]["toolchain_state"]["researchSearchIndex"] == 1

    asyncio.run(scenario())


def test_context_budget_error_keeps_actionable_message_without_retry() -> None:
    failure = normalize_agent_error(AutomationInvokeError(
        "CONTEXT_BUDGET_UNSATISFIABLE",
        "Required context cannot fit within the model input budget.",
        {"contextWindowTokens": 8192},
    ))

    assert failure.code == "CONTEXT_BUDGET_UNSATISFIABLE"
    assert failure.retryable is False
    assert "当前窗口无法同时容纳" in failure.user_message


def test_invalid_model_output_uses_one_saved_result_repair_without_repeating_original_request(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)
        original_invoke = invoker.invoke

        async def invoke(method: str, params: dict[str, Any] | None = None, origin: str = "desktop-ui", request_id: str | None = None) -> Any:
            if method == "agent.generate_scope_audit":
                invoker.calls[method] = invoker.calls.get(method, 0) + 1
                raise AutomationInvokeError("MODEL_OUTPUT_INVALID", "bad shape", {
                    "modelResultRef": "model-result-1",
                    "contractId": "agent.scope_audit.response",
                    "contractVersion": "1.0.0",
                    "validationIssues": [{"path": "$.experts[0]", "message": "Expected object"}],
                })
            if method == "agent.repair_structured_output":
                invoker.calls[method] = invoker.calls.get(method, 0) + 1
                assert params and params["repairAttempt"] == 1
                assert params["modelResultRef"] == "model-result-1"
                return {"repairedPayload": {"summary": "已修复", "experts": [], "findings": [], "conflicts": []}}
            return await original_invoke(method, params, origin, request_id)

        invoker.invoke = invoke  # type: ignore[method-assign]
        run = AgentRun(runId="run-model-repair", threadId="thread-1", planId="plan-1", status="running")
        runtime.state.runs[run.runId] = run

        result = await runtime._automation_invoke(
            run,
            "agent.generate_scope_audit",
            {"reports": []},
            node_id="audit.synthesize",
        )

        assert result["summary"] == "已修复"
        assert invoker.calls["agent.generate_scope_audit"] == 1
        assert invoker.calls["agent.repair_structured_output"] == 1
        assert run.recovery is None

    asyncio.run(scenario())


def test_failed_auto_repair_exposes_manual_button_then_allows_fresh_request_without_retry_event(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)

        async def invoke(method: str, params: dict[str, Any] | None = None, origin: str = "desktop-ui", request_id: str | None = None) -> Any:
            del origin, request_id
            invoker.calls[method] = invoker.calls.get(method, 0) + 1
            if method == "agent.repair_structured_output":
                raise AutomationInvokeError("MODEL_OUTPUT_INVALID", "repair is still invalid", {
                    "modelResultRef": (params or {}).get("modelResultRef"),
                })
            return {"ok": True}

        invoker.invoke = invoke  # type: ignore[method-assign]
        plan = AgentPlan(
            planId="plan-model-repair",
            threadId="thread-model-repair",
            title="结构化审核",
            goal="审核章节",
            steps=[AgentPlanStep(stepId="step-model-repair", agent="supervisor", title="综合审核")],
        )
        failed = AgentRun(
            runId="run-model-repair-failed",
            threadId=plan.threadId,
            planId=plan.planId,
            status="failed",
            currentStepId=plan.steps[0].stepId,
            failureRevision=1,
            recovery=AgentRecoveryDescriptor(
                failureKind="model_output_invalid",
                failedAtPhase="normalizing",
                retryStrategy="repair_model_output",
                canRecover=True,
                recoveryRevision=1,
                actionLabel="修复结果并继续",
                diagnosticRef="diagnostic-model-repair",
            ),
        )
        runtime.state.plans[plan.planId] = plan
        runtime.state.runs[failed.runId] = failed
        runtime.state.recoveryRecords[failed.runId] = {
            "nodeId": "audit.synthesize",
            "sourceMethod": "agent.generate_scope_audit",
            "modelResultRef": "model-result-2",
            "contractId": "agent.scope_audit.response",
            "contractVersion": "1.0.0",
            "validationIssues": [],
        }
        runtime.execution_graph.load_checkpoint_state = lambda _thread_id: {  # type: ignore[method-assign]
            "run_id": failed.runId,
            "approved_step_ids": [plan.steps[0].stepId],
            "novel_id": "novel-1",
            "volume_id": None,
            "chapter_id": "chapter-1",
            "current_content": "",
            "locale": "zh-CN",
            "step_index": 0,
            "tool_index": 0,
            "phase": "toolchain",
            "action": "continue",
            "checkpoint": None,
            "resume_response": None,
            "latest_analysis_summary": "",
            "report_findings": [],
            "creative_direction_checked": False,
            "toolchain_state": None,
            "pending_operation": None,
        }

        with pytest.raises(AgentRequestError):
            await runtime.retry_run({
                "failedRunId": failed.runId,
                "expectedFailureRevision": 1,
                "mode": "failed_node",
                "strategy": "repair_model_output",
            }, {})

        assert failed.failureRevision == 2
        assert failed.recovery and failed.recovery.retryStrategy == "retry_request"
        assert failed.recovery.actionLabel == "重新请求模型"
        assert failed.recovery.blockedReason == "repair_exhausted"

        async def no_op_guarded(*_args: Any, **_kwargs: Any) -> None:
            return None

        runtime._run_graph_guarded = no_op_guarded  # type: ignore[method-assign]
        linked = await runtime.retry_run({
            "failedRunId": failed.runId,
            "expectedFailureRevision": 2,
            "mode": "failed_node",
            "strategy": "retry_request",
        }, {})
        assert linked.retryOfRunId == failed.runId
        assert linked.resumedFrom and linked.resumedFrom["strategy"] == "retry_request"
        await asyncio.sleep(0)

    asyncio.run(scenario())


def test_programming_error_after_saved_model_result_is_not_blindly_retried(tmp_path: Path) -> None:
    runtime, _ = create_runtime(tmp_path)
    run = AgentRun(runId="run-local-error", threadId="thread-1", planId="plan-1", status="running")
    runtime.state.runs[run.runId] = run
    runtime._model_result_refs[(run.runId, "audit.synthesize")] = {
        "modelResultRef": "model-result-local-error",
        "sourceMethod": "agent.generate_scope_audit",
    }

    runtime._classify_local_transform_failure(run, AttributeError("missing chapterTitle"))

    assert run.recovery is not None
    assert run.recovery.failureKind == "local_transform_failed"
    assert run.recovery.retryStrategy == "none"
    assert run.recovery.canRecover is False
    assert run.recovery.blockedReason == "processor_update_required"
    assert "chapterTitle" not in runtime._public_failure_message(run, AttributeError("missing chapterTitle"))

    runtime._STRUCTURED_OUTPUT_PROCESSOR_VERSION = "agent-runtime-structured-output-v2"
    status = runtime.run_status({"runId": run.runId})
    assert status.recovery is not None
    assert status.recovery.retryStrategy == "reprocess_saved_result"
    assert status.recovery.canRecover is True
    assert status.recovery.actionLabel == "继续处理已保存结果"


def test_processor_upgrade_creates_linked_run_from_saved_result_without_model_call(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, invoker = create_runtime(tmp_path)

        async def invoke(method: str, params: dict[str, Any] | None = None, origin: str = "desktop-ui", request_id: str | None = None) -> Any:
            del origin, request_id
            invoker.calls[method] = invoker.calls.get(method, 0) + 1
            if method == "agent.reprocess_saved_structured_output":
                assert params and params["modelResultRef"] == "model-result-upgrade"
                return {
                    "payload": {"content": "已保存的最终报告", "conversationSummary": "已保存的最终报告"},
                    "revision": 1,
                }
            if method == "agent.generate_report":
                raise AssertionError("local reprocessing must not call the original model method")
            return {"ok": True}

        invoker.invoke = invoke  # type: ignore[method-assign]
        plan = AgentPlan(
            planId="plan-local-upgrade",
            threadId="thread-local-upgrade",
            title="最终报告",
            goal="生成最终报告",
            steps=[AgentPlanStep(stepId="step-local-upgrade", agent="supervisor", title="整理报告")],
        )
        failed = AgentRun(
            runId="run-local-upgrade",
            threadId=plan.threadId,
            planId=plan.planId,
            status="failed",
            currentStepId=plan.steps[0].stepId,
            failureRevision=1,
            recovery=AgentRecoveryDescriptor(
                failureKind="local_transform_failed",
                failedAtPhase="normalizing",
                retryStrategy="none",
                canRecover=False,
                recoveryRevision=1,
                blockedReason="processor_update_required",
                diagnosticRef="diagnostic-local-upgrade",
            ),
        )
        runtime.state.plans[plan.planId] = plan
        runtime.state.runs[failed.runId] = failed
        runtime.state.recoveryRecords[failed.runId] = {
            "nodeId": "final_report",
            "sourceMethod": "agent.generate_report",
            "modelResultRef": "model-result-upgrade",
            "processorVersion": "agent-runtime-structured-output-v1",
            "automaticRepairAttempts": 0,
        }
        runtime._STRUCTURED_OUTPUT_PROCESSOR_VERSION = "agent-runtime-structured-output-v2"
        runtime.execution_graph.load_checkpoint_state = lambda _thread_id: {  # type: ignore[method-assign]
            "run_id": failed.runId,
            "approved_step_ids": [plan.steps[0].stepId],
            "novel_id": "novel-1",
            "volume_id": None,
            "chapter_id": "chapter-1",
            "current_content": "",
            "locale": "zh-CN",
            "step_index": 0,
            "tool_index": 0,
            "phase": "final_report",
            "action": "continue",
            "checkpoint": None,
            "resume_response": None,
            "latest_analysis_summary": "",
            "report_findings": [],
            "creative_direction_checked": False,
            "toolchain_state": None,
            "pending_operation": None,
        }

        async def no_op_guarded(*_args: Any, **_kwargs: Any) -> None:
            return None

        runtime._run_graph_guarded = no_op_guarded  # type: ignore[method-assign]
        status = runtime.run_status({"runId": failed.runId})
        linked = await runtime.retry_run({
            "failedRunId": failed.runId,
            "expectedFailureRevision": status.failureRevision,
            "mode": "failed_node",
            "strategy": "reprocess_saved_result",
        }, {})

        assert linked.retryOfRunId == failed.runId
        assert invoker.calls["agent.reprocess_saved_structured_output"] == 1
        assert invoker.calls.get("agent.generate_report", 0) == 0
        pending = runtime.state.pendingModelResults[f"{linked.runId}:final_report"]
        assert pending["payload"]["content"] == "已保存的最终报告"
        await asyncio.sleep(0)

    asyncio.run(scenario())
