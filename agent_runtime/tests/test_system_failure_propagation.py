from __future__ import annotations

import asyncio
import errno
import sqlite3
from pathlib import Path

import pytest

from novel_agent_runtime.schemas import AgentRun, AgentRunEvent
from novel_agent_runtime.system_errors import storage_failure
from novel_agent_runtime.retry import is_retryable_agent_error, normalize_agent_error
from novel_agent_runtime.automation import AutomationInvokeError
from test_runtime import create_runtime


def full_disk(*_args, **_kwargs):
    raise sqlite3.OperationalError("database or disk is full")


def live_run(runtime, run_id="run_system"):
    run = AgentRun(runId=run_id, threadId="thread_system", planId="plan_system", status="running")
    runtime.state.runs[run_id] = run
    return run


@pytest.mark.parametrize("error,code", [
    (sqlite3.OperationalError("database or disk is full"), "STORAGE_DISK_FULL"),
    (OSError(errno.ENOSPC, "full"), "STORAGE_DISK_FULL"),
    (PermissionError(errno.EACCES, "permission denied"), "STORAGE_PERMISSION_DENIED"),
    (sqlite3.OperationalError("database is locked"), "STORAGE_BUSY"),
])
def test_storage_errors_are_actionable(error, code):
    failure = storage_failure(error)
    assert failure["code"] == code
    assert failure["message"] and failure["retryable"] is False
    assert not is_retryable_agent_error(error)
    assert normalize_agent_error(error).code == code


def test_network_and_application_errors_are_not_storage_errors():
    assert storage_failure(ConnectionResetError(errno.ECONNRESET, "reset")) is None
    assert storage_failure(ValueError("bad input")) is None


def test_reconnect_replays_corrected_terminal_recovery_instead_of_old_failure(tmp_path):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        old = runtime.store.append_event(AgentRunEvent(eventId="old-busy", runId=run.runId,
            planId=run.planId, threadId=run.threadId, type="run_failed", status="failed", payload={"code": "P2010"}))
        corrected = runtime.store.append_event(AgentRunEvent(eventId="corrected-busy", runId=run.runId,
            planId=run.planId, threadId=run.threadId, type="run_failed", status="failed",
            payload={"code": "STORAGE_BUSY", "recovery": {"canRecover": True}, "failureRevision": 2}))
        for after_sequence in (0, old.sequence):
            replay = [event async for event in runtime.event_bus.subscribe(run.runId, after_sequence)]
            assert [event.eventId for event in replay] == [corrected.eventId]
            assert replay[0].payload["recovery"]["canRecover"] is True
    asyncio.run(scenario())


def test_terminal_reaches_subscriber_and_reconnect_when_all_storage_fails(tmp_path: Path, monkeypatch):
    async def scenario():
        runtime, automation = create_runtime(tmp_path)
        run = live_run(runtime)
        initial = await runtime._emit(run, "run_started")
        stream = runtime.event_stream(run.runId, initial.sequence)
        pending = asyncio.create_task(anext(stream))
        await asyncio.sleep(0.03)
        monkeypatch.setattr(runtime.store, "_write_state", full_disk)
        monkeypatch.setattr(runtime.store, "_insert_event", full_disk)
        await runtime._finish_run(run, "failed", "run_failed", {"message": "original failure"})
        terminal = await asyncio.wait_for(pending, 1)
        assert terminal.type == "run_failed"
        assert terminal.sequence > initial.sequence
        assert terminal.payload["code"] == "STORAGE_DISK_FULL"
        monkeypatch.setattr(runtime.store, "get_last_event", full_disk)
        status = runtime.run_status({"runId": run.runId})
        assert status.status == "failed" and status.failure["code"] == "STORAGE_DISK_FULL"
        monkeypatch.setattr(runtime.store, "list_events", full_disk)
        replay = [event async for event in runtime.event_stream(run.runId, initial.sequence)]
        assert len(replay) == 1 and replay[0].eventId == terminal.eventId
        await stream.aclose()
        assert automation.calls == []
    asyncio.run(scenario())


@pytest.mark.parametrize("failed_write", ["_write_state", "_insert_event"])
def test_completion_storage_failure_never_advertises_success(tmp_path: Path, monkeypatch, failed_write):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        monkeypatch.setattr(runtime.store, failed_write, full_disk)
        await runtime._finish_run(run, "completed", "run_completed", {})
        assert run.status == "failed" and run.failureRevision == 1
        assert runtime.store.list_events(run.runId) == []  # Final transaction rolled back.
        replay = [event async for event in runtime.event_stream(run.runId)]
        assert [event.type for event in replay] == ["run_failed"]
        if failed_write == "_insert_event":
            assert runtime.store.load().runs[run.runId].status == "failed"
    asyncio.run(scenario())


def test_graph_failure_survives_failure_of_diagnostic_events(tmp_path: Path, monkeypatch):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        async def broken_graph(*_args, **_kwargs):
            raise ValueError("processor crashed")
        monkeypatch.setattr(runtime.execution_graph, "run", broken_graph)
        monkeypatch.setattr(runtime.store, "_insert_event", full_disk)
        await runtime._run_graph_guarded(run.runId)
        assert run.status == "failed" and run.failureRevision == 1
        assert run.failure["code"] == "STORAGE_DISK_FULL"
    asyncio.run(scenario())


def test_escaped_worker_exception_is_observed_and_finishes_run(tmp_path: Path):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        async def escaped():
            raise RuntimeError("escaped worker failure")
        task = asyncio.create_task(escaped())
        runtime._track_run_task(run.runId, task)
        await asyncio.sleep(0.1)
        assert run.status == "failed" and run.failure["code"] == "EXECUTION_TASK_LOST"
        assert any(event.type == "run_failed" for event in run.events)
    asyncio.run(scenario())


def test_save_failure_stops_other_workers_and_preserves_waiting_run(tmp_path: Path, monkeypatch):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        active = live_run(runtime)
        waiting = live_run(runtime, "run_waiting")
        waiting.status = "waiting_approval"
        worker = asyncio.create_task(asyncio.sleep(60))
        runtime._track_run_task(active.runId, worker)
        runtime._active_request_ids[active.runId] = {"upstream-in-flight"}
        monkeypatch.setattr(runtime.store, "_write_state", full_disk)
        with pytest.raises(sqlite3.Error):
            runtime._save()
        await asyncio.sleep(0.1)
        assert worker.cancelled()
        assert active.status == waiting.status == "failed"
        assert active.failureRevision == waiting.failureRevision == 1
        assert "upstream-in-flight" in runtime.automation.cancelled_request_ids
    asyncio.run(scenario())


def test_wrapped_storage_error_cannot_trigger_provider_retries():
    error = AutomationInvokeError("AUTOMATION_ERROR", "database or disk is full", status_code=500)
    assert not is_retryable_agent_error(error)
    assert normalize_agent_error(error).code == "STORAGE_DISK_FULL"


def test_renderer_storage_failure_stops_runtime_and_publishes_failed_state(tmp_path: Path):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        worker = asyncio.create_task(asyncio.sleep(60))
        runtime._track_run_task(run.runId, worker)
        result = await runtime.report_system_failure({"message": "Invalid Prisma invocation: database or disk is full"})
        await asyncio.sleep(0)
        assert result["affectedRunIds"] == [run.runId]
        assert worker.cancelled()
        assert runtime.run_status({"runId": run.runId}).status == "failed"
        assert run.events[-1].type == "run_failed" and run.failure["code"] == "STORAGE_DISK_FULL"
        with pytest.raises(ValueError):
            await runtime.report_system_failure({"message": "ordinary user validation error"})
    asyncio.run(scenario())


def test_terminal_snapshot_and_event_survive_restart_together(tmp_path: Path):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        first = live_run(runtime)
        second = live_run(runtime, "run_other")
        await asyncio.gather(runtime._finish_run(first, "completed", "run_completed", {}),
            runtime._finish_run(second, "failed", "run_failed", {"message": "processor failed"}))
        restored, _ = create_runtime(tmp_path)
        for run in [first, second]:
            persisted = restored.state.runs[run.runId]
            assert persisted.status == run.status
            assert persisted.events[-1].type == runtime.store.get_last_event(run.runId).type
    asyncio.run(scenario())


def test_initial_event_failure_does_not_leave_unstarted_run_running(tmp_path: Path, monkeypatch):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        monkeypatch.setattr(runtime.store, "_insert_event", full_disk)
        with pytest.raises(sqlite3.Error):
            await runtime._emit(run, "run_started")
        assert run.status == "failed"
    asyncio.run(scenario())


def test_cancellation_still_stops_worker_when_save_fails(tmp_path: Path, monkeypatch):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        worker = asyncio.create_task(asyncio.sleep(60))
        runtime._track_run_task(run.runId, worker)
        monkeypatch.setattr(runtime.store, "_write_state", full_disk)
        await runtime.cancel({"runId": run.runId})
        await asyncio.sleep(0.1)
        assert worker.cancelled() and run.status == "failed"
    asyncio.run(scenario())


def test_lack_of_progress_does_not_fail_active_worker(tmp_path: Path):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        worker = asyncio.create_task(asyncio.sleep(60))
        runtime._track_run_task(run.runId, worker)
        assert runtime.run_status({"runId": run.runId}).status == "running"
        run.status = "cancelled"
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
    asyncio.run(scenario())


def test_cancellation_before_worker_startup_finishes_as_cancelled(tmp_path: Path):
    async def scenario():
        runtime, _ = create_runtime(tmp_path)
        run = live_run(runtime)
        worker = asyncio.create_task(asyncio.sleep(60))
        runtime._track_run_task(run.runId, worker)
        await runtime.cancel({"runId": run.runId})
        await asyncio.sleep(0.1)
        assert run.status == "cancelled"
        assert run.events[-1].type == "run_cancelled"
    asyncio.run(scenario())
