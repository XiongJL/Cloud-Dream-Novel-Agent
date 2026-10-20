"""Optional Skill infrastructure, initialized away from the Runtime startup path."""
from __future__ import annotations

import asyncio
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from .skill_analysis_graph import SkillAnalysisGraph, SkillWorkUnitStore
from .toolchains.schemas import ToolchainError


class SkillExecutionEngine:
    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir
        self.graph: SkillAnalysisGraph | None = None
        self.status = "uninitialized"
        self._lock = asyncio.Lock()

    def _open(self) -> SkillAnalysisGraph:
        units = SkillWorkUnitStore(self.state_dir / "agent_skill_units.db")
        checkpoint = self.state_dir / "agent_skill_graph.db"
        try:
            with closing(sqlite3.connect(checkpoint)) as db:
                db.execute("SELECT name FROM sqlite_master LIMIT 1").fetchall()
        except sqlite3.DatabaseError as error:
            if getattr(error, "sqlite_errorcode", None) not in {sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB}:
                raise
            # Only checkpoints are rebuildable. Never reset the request journal.
            recovery = self.state_dir / ("skill-checkpoint-recovery-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f"))
            recovery.mkdir()
            for suffix in ("", "-wal", "-shm"):
                candidate = Path(str(checkpoint) + suffix)
                if candidate.exists():
                    if candidate.resolve().parent != self.state_dir.resolve():
                        raise ValueError("Checkpoint recovery escaped the runtime directory")
                    candidate.rename(recovery / candidate.name)
        return SkillAnalysisGraph(checkpoint, units)

    async def get_graph(self) -> SkillAnalysisGraph:
        async with self._lock:
            if self.graph is not None:
                return self.graph
            try:
                self.graph = await asyncio.to_thread(self._open)
            except (sqlite3.Error, OSError) as error:
                self.status = "recovery_required" if getattr(error, "sqlite_errorcode", None) in {
                    sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB} else "unavailable"
                raise ToolchainError("SKILL_STORAGE_UNAVAILABLE",
                    "分片执行存储不可用；当前任务已停止，其他功能可继续使用。请求账本未被清空。",
                    details={"availability": self.status, "reason": str(error), "stateDir": str(self.state_dir)}) from error
            self.status = "ready"
            return self.graph
