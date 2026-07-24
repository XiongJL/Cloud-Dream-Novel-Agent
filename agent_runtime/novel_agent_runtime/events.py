from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from collections.abc import AsyncGenerator

from .schemas import AgentRunEvent
from .store import AgentStateStore


class AgentEventBus:
    def __init__(self, store: AgentStateStore) -> None:
        self.store = store
        self._subscriptions: dict[str, list[asyncio.Queue[AgentRunEvent]]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def append(self, event: AgentRunEvent) -> AgentRunEvent:
        persisted = await asyncio.to_thread(self.store.append_event, event)
        async with self._lock:
            queues = list(self._subscriptions.get(event.runId, []))
        for queue in queues:
            await queue.put(persisted)
        return persisted

    async def subscribe(self, run_id: str, after_sequence: int = 0) -> AsyncGenerator[AgentRunEvent | None, None]:
        queue: asyncio.Queue[AgentRunEvent] = asyncio.Queue()
        async with self._lock:
            self._subscriptions[run_id].append(queue)
        try:
            history = await asyncio.to_thread(self.store.list_events, run_id, after_sequence)
            for event in history:
                yield event
                if event.type in {"run_completed", "run_failed", "run_cancelled"}:
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
