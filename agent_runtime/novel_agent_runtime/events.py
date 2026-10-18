from __future__ import annotations

import asyncio
import json
import sqlite3
from collections import defaultdict, OrderedDict
from collections.abc import AsyncGenerator

from .schemas import AgentRunEvent
from .store import AgentStateStore


class AgentEventBus:
    def __init__(self, store: AgentStateStore) -> None:
        self.store = store
        self._subscriptions: dict[str, list[asyncio.Queue[AgentRunEvent]]] = defaultdict(list)
        self._lock = asyncio.Lock()
        self._transient_terminals: OrderedDict[str, AgentRunEvent] = OrderedDict()

    async def append(self, event: AgentRunEvent) -> AgentRunEvent:
        persisted = await asyncio.to_thread(self.store.append_event, event)
        await self.publish(persisted)
        return persisted

    async def publish(self, event: AgentRunEvent) -> None:
        async with self._lock:
            queues = list(self._subscriptions.get(event.runId, []))
        for queue in queues:
            queue.put_nowait(event)

    async def publish_terminal(self, event: AgentRunEvent, sequence_hint: int = 0) -> AgentRunEvent:
        """A terminal notification must work even when its journal cannot write."""
        async with self._lock:
            existing = self._transient_terminals.get(event.runId)
            if existing:
                return existing
            event = event.model_copy(update={"sequence": sequence_hint + 1,
                "payload": {**event.payload, "transient": True, "persistenceFailed": True}})
            self._transient_terminals[event.runId] = event
            while len(self._transient_terminals) > 100:
                self._transient_terminals.popitem(last=False)
            for queue in self._subscriptions.get(event.runId, []):
                queue.put_nowait(event)
        return event

    async def subscribe(self, run_id: str, after_sequence: int = 0) -> AsyncGenerator[AgentRunEvent | None, None]:
        queue: asyncio.Queue[AgentRunEvent] = asyncio.Queue()
        async with self._lock:
            self._subscriptions[run_id].append(queue)
        try:
            try:
                history = await asyncio.to_thread(self.store.list_events, run_id, after_sequence)
            except (OSError, sqlite3.Error):
                if run_id not in self._transient_terminals:
                    raise
                history = []
            terminal = self._transient_terminals.get(run_id)
            latest_durable_terminal = next((event for event in reversed(history)
                if event.type in {"run_completed", "run_failed", "run_cancelled"}), None)
            for event in history:
                if terminal and event.type in {"run_completed", "run_failed", "run_cancelled"}:
                    continue
                if (latest_durable_terminal and event.type in {"run_completed", "run_failed", "run_cancelled"}
                        and event.eventId != latest_durable_terminal.eventId):
                    # Recovery metadata upgrades append a corrected terminal;
                    # reconnect must not stop at the superseded failure.
                    continue
                yield event
                if event.type in {"run_completed", "run_failed", "run_cancelled"}:
                    return

            terminal = self._transient_terminals.get(run_id)
            if terminal:
                if terminal.sequence > after_sequence:
                    yield terminal
                return

            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield event
                    if event.type in {"run_completed", "run_failed", "run_cancelled"}:
                        break
                except asyncio.TimeoutError:
                    yield None
        finally:
            async with self._lock:
                queues = self._subscriptions.get(run_id, [])
                if queue in queues:
                    queues.remove(queue)
                if not queues and run_id in self._subscriptions:
                    del self._subscriptions[run_id]


def serialize_sse_event(event: AgentRunEvent | None) -> str:
    if event is None:
        return ": keepalive\n\n"
    payload = json.dumps(event.model_dump(), ensure_ascii=False, separators=(",", ":"))
    return f"event: agent_run_event\ndata: {payload}\n\n"
