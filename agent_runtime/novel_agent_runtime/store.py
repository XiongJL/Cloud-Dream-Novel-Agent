from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from .invocations import ToolInvocationRecord
from .schemas import AgentRunEvent, AgentState


class AgentStateStore:
    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir
        self.db_path = state_dir / "agent_state.db"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=5000;")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_state (
                    id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS run_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    event_id TEXT NOT NULL UNIQUE,
                    event_type TEXT NOT NULL,
                    event_payload TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence
                ON run_events(run_id, sequence)
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tool_invocations (
                    invocation_key TEXT PRIMARY KEY,
                    request_id TEXT NOT NULL UNIQUE,
                    run_id TEXT NOT NULL,
                    step_id TEXT,
                    method TEXT NOT NULL,
                    params_hash TEXT NOT NULL,
                    side_effect INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    result_json TEXT,
                    error_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_tool_invocations_run_status
                ON tool_invocations(run_id, status)
                """
            )

    def load(self) -> AgentState:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM agent_state WHERE id = 'default'").fetchone()
        if not row:
            return AgentState()
        return AgentState.model_validate(json.loads(row[0]))

    def save(self, state: AgentState) -> None:
        payload = state.model_dump_json()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO agent_state (id, payload, updated_at)
                VALUES ('default', ?, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
                """,
                (payload,),
            )

    def append_event(self, event: AgentRunEvent) -> AgentRunEvent:
        payload = event.model_dump_json()
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO run_events (run_id, event_id, event_type, event_payload)
                VALUES (?, ?, ?, ?)
                """,
                (event.runId, event.eventId, event.type, payload),
            )
            sequence = int(cursor.lastrowid)
        return event.model_copy(update={"sequence": sequence})

    def list_events(self, run_id: str, after_sequence: int = 0) -> list[AgentRunEvent]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT event_payload, sequence
                FROM run_events
                WHERE run_id = ? AND sequence > ?
                ORDER BY sequence ASC
                """,
                (run_id, after_sequence),
            ).fetchall()
        events: list[AgentRunEvent] = []
        for payload, sequence in rows:
            event = AgentRunEvent.model_validate(json.loads(payload))
            events.append(event.model_copy(update={"sequence": int(sequence)}))
        return events

    def get_last_event(self, run_id: str) -> AgentRunEvent | None:
        events = self.list_events(run_id, 0)
        return events[-1] if events else None

    def prepare_invocation(self, record: ToolInvocationRecord) -> ToolInvocationRecord:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT * FROM tool_invocations WHERE invocation_key = ?",
                (record.invocationKey,),
            ).fetchone()
            if existing:
                return self._invocation_from_row(existing)
            conn.execute(
                """
                INSERT INTO tool_invocations (
                    invocation_key, request_id, run_id, step_id, method, params_hash,
                    side_effect, status, result_json, error_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.invocationKey,
                    record.requestId,
                    record.runId,
                    record.stepId,
                    record.method,
                    record.paramsHash,
                    int(record.sideEffect),
                    record.status,
                    None,
                    None,
                    record.createdAt,
                    record.updatedAt,
                ),
            )
        return record

    def mark_invocation_in_flight(self, invocation_key: str) -> ToolInvocationRecord:
        return self._transition_invocation(invocation_key, "in_flight", expected={"prepared"})

    def mark_invocation_operation_pending(
        self,
        invocation_key: str,
        operation: Any,
    ) -> ToolInvocationRecord:
        return self._transition_invocation(
            invocation_key,
            "operation_pending",
            expected={"prepared"},
            result=operation,
        )

    def mark_invocation_succeeded(self, invocation_key: str, result: Any) -> ToolInvocationRecord:
        return self._transition_invocation(
            invocation_key,
            "succeeded",
            expected={"in_flight", "operation_pending"},
            result=result,
        )

    def mark_invocation_failed(self, invocation_key: str, error: dict[str, Any]) -> ToolInvocationRecord:
        return self._transition_invocation(
            invocation_key,
            "failed",
            expected={"prepared", "in_flight", "operation_pending"},
            error=error,
        )

    def mark_invocation_unknown(self, invocation_key: str, error: dict[str, Any]) -> ToolInvocationRecord:
        return self._transition_invocation(
            invocation_key,
            "unknown",
            expected={"in_flight", "operation_pending"},
            error=error,
        )

    def reconcile_invocation(
        self,
        invocation_key: str,
        resolution: str,
        *,
        result: Any = None,
        note: str | None = None,
    ) -> ToolInvocationRecord:
        if resolution not in {"reconciled_succeeded", "reconciled_absent"}:
            raise ValueError(f"Unsupported invocation reconciliation: {resolution}")
        return self._transition_invocation(
            invocation_key,
            resolution,
            expected={"unknown"},
            result=result,
            error={
                "code": resolution.upper(),
                "message": note or (
                    "A matching persisted result was accepted by the user."
                    if resolution == "reconciled_succeeded"
                    else "The user confirmed that no usable result was created."
                ),
            },
        )

    def recover_in_flight_invocations(self) -> list[ToolInvocationRecord]:
        recovered_keys: list[str] = []
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM tool_invocations WHERE status = 'in_flight'"
            ).fetchall()
            for row in rows:
                record = self._invocation_from_row(row)
                recovered_keys.append(record.invocationKey)
                error = {
                    "code": "RUNTIME_INTERRUPTED",
                    "message": "Runtime stopped while the side-effect request was in flight.",
                }
                conn.execute(
                    """
                    UPDATE tool_invocations
                    SET status = 'unknown', error_json = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE invocation_key = ? AND status = 'in_flight'
                    """,
                    (json.dumps(error, ensure_ascii=False), record.invocationKey),
                )
        if not recovered_keys:
            return []
        recovered = set(recovered_keys)
        return [item for item in self.list_invocations(statuses={"unknown"}) if item.invocationKey in recovered]

    def list_invocations(
        self,
        run_id: str | None = None,
        *,
        statuses: Iterable[str] | None = None,
    ) -> list[ToolInvocationRecord]:
        clauses: list[str] = []
        values: list[Any] = []
        if run_id:
            clauses.append("run_id = ?")
            values.append(run_id)
        normalized_statuses = sorted(set(statuses or []))
        if normalized_statuses:
            placeholders = ",".join("?" for _ in normalized_statuses)
            clauses.append(f"status IN ({placeholders})")
            values.extend(normalized_statuses)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM tool_invocations{where} ORDER BY created_at ASC",
                values,
            ).fetchall()
        return [self._invocation_from_row(row) for row in rows]

    def get_invocation(self, invocation_key: str) -> ToolInvocationRecord | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM tool_invocations WHERE invocation_key = ?",
                (invocation_key,),
            ).fetchone()
        return self._invocation_from_row(row) if row else None

    def _transition_invocation(
        self,
        invocation_key: str,
        status: str,
        *,
        expected: set[str],
        result: Any = None,
        error: dict[str, Any] | None = None,
    ) -> ToolInvocationRecord:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM tool_invocations WHERE invocation_key = ?",
                (invocation_key,),
            ).fetchone()
            if not row:
                raise ValueError(f"Invocation not found: {invocation_key}")
            current = self._invocation_from_row(row)
            if current.status not in expected:
                if current.status == status:
                    return current
                raise ValueError(
                    f"Invalid invocation transition for {invocation_key}: {current.status} -> {status}"
                )
            conn.execute(
                """
                UPDATE tool_invocations
                SET status = ?, result_json = ?, error_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE invocation_key = ?
                """,
                (
                    status,
                    json.dumps(result, ensure_ascii=False, default=str) if result is not None else None,
                    json.dumps(error, ensure_ascii=False, default=str) if error is not None else None,
                    invocation_key,
                ),
            )
            updated = conn.execute(
                "SELECT * FROM tool_invocations WHERE invocation_key = ?",
                (invocation_key,),
            ).fetchone()
        return self._invocation_from_row(updated)

    @staticmethod
    def _invocation_from_row(row: tuple[Any, ...]) -> ToolInvocationRecord:
        return ToolInvocationRecord(
            invocationKey=str(row[0]),
            requestId=str(row[1]),
            runId=str(row[2]),
            stepId=str(row[3]) if row[3] is not None else None,
            method=str(row[4]),
            paramsHash=str(row[5]),
            sideEffect=bool(row[6]),
            status=str(row[7]),
            result=json.loads(row[8]) if row[8] else None,
            error=json.loads(row[9]) if row[9] else None,
            createdAt=str(row[10]),
            updatedAt=str(row[11]),
        )
