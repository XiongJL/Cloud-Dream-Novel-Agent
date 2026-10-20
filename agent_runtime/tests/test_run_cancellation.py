from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from test_system_failure_propagation import live_run
from test_runtime import create_runtime


@pytest.mark.parametrize("previous", ["running", "cancelling"])
def test_orphan_run_cancellation_finishes_without_worker_or_timer(tmp_path: Path, previous):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        run.status = previous
        result = await runtime.cancel({"runId": run.runId})
        assert result.status == "cancelled"
        assert result.events[-1].type == "run_cancelled"
        assert runtime.store.load().runs[run.runId].status == "cancelled"
        revision = len(result.events)
        assert (await runtime.cancel({"runId": run.runId})).status == "cancelled"
        assert len(result.events) == revision
    asyncio.run(scenario())


def test_slow_upstream_cancel_cannot_hold_local_orphan_run_forever(tmp_path: Path, monkeypatch):
    async def scenario():
        runtime, automation = create_runtime(tmp_path)
        runtime._CANCELLATION_GRACE_SECONDS = 0.03
        run = live_run(runtime)
        runtime._active_request_ids[run.runId] = {"request_slow"}
        async def blocked_cancel(_request_id):
            await asyncio.Event().wait()
        monkeypatch.setattr(automation, "cancel", blocked_cancel)
        result = await asyncio.wait_for(runtime.cancel({"runId": run.runId}), 0.3)
        assert result.status == "cancelled"
        assert result.events[-1].payload["upstreamCancellationConfirmed"] is False
        assert "上游停止状态未确认" in result.events[-1].payload["message"]
    asyncio.run(scenario())


@pytest.mark.parametrize("response", [None, "committing", "succeeded", "blocked"])
def test_durable_orphan_cannot_claim_cancellation_without_acknowledgement(tmp_path: Path, monkeypatch, response):
    async def scenario():
        runtime, automation = create_runtime(tmp_path)
        runtime._CANCELLATION_GRACE_SECONDS = 0.03
        run = live_run(runtime)
        run.draftOperationId = "operation_uncertain"
        async def invoke(*_args, **_kwargs):
            if response is None:
                await asyncio.Event().wait()
            return {"status": response}
        monkeypatch.setattr(automation, "invoke", invoke)
        result = await asyncio.wait_for(runtime.cancel({"runId": run.runId}), 0.3)
        assert result.status == "failed"
        assert result.failure["code"] == "SIDE_EFFECT_UNKNOWN"
        assert result.failure["cancellationUnconfirmed"] is True
        assert result.draftOperationId == "operation_uncertain"
        assert not any(event.type == "run_cancelled" for event in result.events)
    asyncio.run(scenario())


def test_durable_operation_without_timer_still_receives_cancel(tmp_path: Path, monkeypatch):
    async def scenario():
        runtime, automation = create_runtime(tmp_path)
        run = live_run(runtime)
        run.draftOperationId = "operation_known"
        calls = []
        async def invoke(method, *_args, **_kwargs):
            calls.append(method)
            return {"status": "cancel_requested"}
        monkeypatch.setattr(automation, "invoke", invoke)
        assert (await runtime.cancel({"runId": run.runId})).status == "cancelled"
        assert calls == ["chapter.draft.cancel"]
    asyncio.run(scenario())


@pytest.mark.parametrize("in_flight", [False, True])
def test_cancellation_resistant_worker_becomes_explicit_failure(tmp_path: Path, in_flight):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        runtime._CANCELLATION_GRACE_SECONDS = 0.03
        run = live_run(runtime)
        if in_flight:
            runtime._active_request_ids[run.runId] = {"request_in_flight"}
        release = asyncio.Event()
        started = asyncio.Event()
        async def stubborn():
            started.set()
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue
        worker = asyncio.create_task(stubborn())
        runtime._track_run_task(run.runId, worker)
        await started.wait()
        result = await asyncio.wait_for(runtime.cancel({"runId": run.runId}), 0.3)
        assert result.status == "failed" and result.failure["code"] == ("SIDE_EFFECT_UNKNOWN" if in_flight else "CANCELLATION_TIMEOUT")
        release.set()
        await worker
        assert run.status == "failed"
        graph = await runtime._advance_execution_inner({"run_id": run.runId})
        assert graph["action"] == "terminal"
    asyncio.run(scenario())
