"""Bounded, checkpointed LangGraph workers for reusable read-only Skill analysis.

Graph checkpoints contain job/result references, never the novel's full text.
The unit journal commits each model result before the next request is issued.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from contextlib import contextmanager, closing
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any, TypedDict

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from .skill_execution import SkillExecutionHints
from .system_errors import storage_failure
from .toolchains.schemas import ToolchainError


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


class SkillWorkUnitStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS skill_work_units (
                unit_key TEXT PRIMARY KEY, owner TEXT NOT NULL, input_hash TEXT NOT NULL,
                status TEXT NOT NULL, reserved_tokens INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 1,
                result_json TEXT, error_json TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )""")
            if "attempts" not in {row[1] for row in db.execute("PRAGMA table_info(skill_work_units)")}:
                db.execute("ALTER TABLE skill_work_units ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1")
            columns = {row[1] for row in db.execute("PRAGMA table_info(skill_work_units)")}
            for column in ("metadata_json", "request_id", "raw_result_json"):
                if column not in columns:
                    db.execute(f"ALTER TABLE skill_work_units ADD COLUMN {column} TEXT")
            if "reserved_calls" not in columns:
                db.execute("ALTER TABLE skill_work_units ADD COLUMN reserved_calls INTEGER NOT NULL DEFAULT 1")
            for column in ("current_reserve_tokens", "current_reserve_calls"):
                if column not in columns:
                    db.execute(f"ALTER TABLE skill_work_units ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")

    @contextmanager
    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=1)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            with db:
                yield db
        finally:
            db.close()

    def result(self, key: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT result_json FROM skill_work_units WHERE unit_key=? AND status='completed'", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def begin(self, owner: str, key: str, input_hash: str, reserve: int, policy: dict[str, Any], calls: int = 1) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status,input_hash FROM skill_work_units WHERE unit_key=?", (key,)).fetchone()
            if row and row[1] != input_hash:
                raise ToolchainError("INPUT_INVALID", "工作单元输入指纹不一致。")
            if row and row[0] == "running":
                raise ToolchainError("SIDE_EFFECT_UNKNOWN", "工作单元的模型请求尚未核对，不能自动重复请求。")
            used_calls, tokens, units = db.execute("SELECT COALESCE(SUM(reserved_calls),0),COALESCE(SUM(reserved_tokens),0),COALESCE(SUM(attempts),0) FROM skill_work_units WHERE owner=?", (owner,)).fetchone()
            if used_calls + calls > policy["maxModelCalls"] or tokens + reserve > policy["maxTotalTokens"] or units >= policy.get("maxWorkUnits", policy["maxModelCalls"]):
                raise ToolchainError("BUDGET_EXCEEDED", "分片分析已达到本次总调用或 Token 预算；已完成结果保留。")
            attempt = db.execute("SELECT attempts FROM skill_work_units WHERE unit_key=?", (key,)).fetchone()
            request_id = "skill_" + fingerprint([owner, key, (attempt[0] if attempt else 0) + 1])
            db.execute("""INSERT INTO skill_work_units(unit_key,owner,input_hash,status,reserved_tokens,request_id,reserved_calls,current_reserve_tokens,current_reserve_calls)
                VALUES(?,?,?,'running',?,?,?,?,?) ON CONFLICT(unit_key) DO UPDATE SET
                status='running', reserved_tokens=reserved_tokens+excluded.reserved_tokens,
                reserved_calls=reserved_calls+excluded.reserved_calls,
                current_reserve_tokens=excluded.current_reserve_tokens, current_reserve_calls=excluded.current_reserve_calls,
                attempts=attempts+1, request_id=excluded.request_id, raw_result_json=NULL,
                updated_at=CURRENT_TIMESTAMP""", (key, owner, input_hash, reserve, request_id, calls, reserve, calls))

    def record(self, key: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT status,input_hash,request_id,raw_result_json,metadata_json,error_json FROM skill_work_units WHERE unit_key=?", (key,)).fetchone()
        return {"status": row[0], "inputHash": row[1], "requestId": row[2],
                "rawResult": json.loads(row[3]) if row[3] else None,
                "metadata": json.loads(row[4]) if row[4] else {},
                "error": json.loads(row[5]) if row[5] else None} if row else None

    def save_raw(self, key: str, result: Any) -> None:
        with self.connect() as db:
            db.execute("UPDATE skill_work_units SET raw_result_json=? WHERE unit_key=?", (canonical(result), key))

    def finish(self, key: str, result: dict[str, Any], metadata: dict[str, Any] | None = None, *, expected_input_hash: str | None = None) -> None:
        with self.connect() as db:
            usage = (metadata or {}).get("executionUsage") or {}
            calls = usage.get("calls")
            totals = []
            for attempt in usage.get("attempts", []):
                metrics = attempt.get("usage") or {}
                total = metrics.get("total_tokens")
                if total is None:
                    input_tokens = metrics.get("input_tokens", metrics.get("prompt_tokens"))
                    output_tokens = metrics.get("output_tokens", metrics.get("completion_tokens"))
                    total = input_tokens + output_tokens if isinstance(input_tokens, int) and isinstance(output_tokens, int) else None
                totals.append(total if isinstance(total, int) and total >= 0 else None)
            total = sum(totals) if totals and len(totals) == calls and all(item is not None for item in totals) else None
            db.execute("""UPDATE skill_work_units SET status='completed',result_json=?,metadata_json=?,error_json=NULL,
                reserved_calls=reserved_calls-current_reserve_calls+COALESCE(?,current_reserve_calls),
                reserved_tokens=reserved_tokens-current_reserve_tokens+COALESCE(?,current_reserve_tokens),
                current_reserve_calls=0,current_reserve_tokens=0,updated_at=CURRENT_TIMESTAMP
                WHERE unit_key=? AND (status='running' OR
                    (status='failed' AND raw_result_json IS NOT NULL AND input_hash=?))""", (canonical(result), canonical(metadata or {}),
                    calls if isinstance(calls, int) and calls > 0 else None, total, key, expected_input_hash))

    @staticmethod
    def read_completed_analysis(path: Path, owner: str, graph_key: str | None = None) -> list[dict[str, Any]]:
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            rows = db.execute("SELECT unit_key,result_json,metadata_json FROM skill_work_units WHERE owner=? AND status='completed' ORDER BY rowid", (owner,)).fetchall()
        records = []
        for key, result, metadata in rows:
            detail = json.loads(metadata) if metadata else {}
            if (graph_key is None or detail.get("graphKey") == graph_key) and detail.get("kind") == "analyze":
                records.append({"ref": key, "analysis": json.loads(result), **detail})
        return sorted(records, key=lambda item: (item.get("chapterIndex", 0), item.get("offset", 0)))

    def completed_analysis(self, owner: str, graph_key: str | None) -> list[dict[str, Any]]:
        return self.read_completed_analysis(self.path, owner, graph_key)

    def pending_requests(self, owner: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT unit_key,request_id,raw_result_json FROM skill_work_units WHERE owner=? AND status='running'", (owner,)).fetchall()
        return [{"unitKey": key, "requestId": request, "hasRawResult": raw is not None} for key, request, raw in rows]

    def authorize_unconfirmed_retry(self, key: str, request_id: str) -> bool:
        # Explicit user choice only. Preserve the first attempt and its budget;
        # begin() creates a different request ID and charges a new reservation.
        with self.connect() as db:
            cursor = db.execute("""UPDATE skill_work_units SET status='failed',error_json=?,updated_at=CURRENT_TIMESTAMP
                WHERE unit_key=? AND request_id=? AND status='running' AND raw_result_json IS NULL""",
                (canonical({"code": "UNCONFIRMED_REQUEST_RETRY_AUTHORIZED", "message": "用户已选择重新请求未确认分片；原请求仍可能产生费用。"}), key, request_id))
            return cursor.rowcount == 1

    def fail(self, key: str, error: Exception) -> None:
        # A transport failure can mean a request was sent but its result is unknown.
        # Leave it running so resume does not duplicate a potentially billed call.
        code = getattr(error, "code", "NODE_FAILED")
        unknown = code in {"PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "NETWORK_ERROR", "UPSTREAM_TIMEOUT", "SIDE_EFFECT_UNKNOWN"}
        with self.connect() as db:
            db.execute("UPDATE skill_work_units SET status=?,error_json=?,updated_at=CURRENT_TIMESTAMP WHERE unit_key=?",
                       ("running" if unknown else "failed", canonical({"code": code, "message": str(error)[:1000]}), key))


def split_verbatim(text: str, maximum_bytes: int) -> list[tuple[int, str]]:
    """Split on paragraph boundaries where possible, covering every code point."""
    if not text:
        return [(0, "")]
    parts: list[tuple[int, str]] = []
    start = 0
    while start < len(text):
        end, size = start, 0
        while end < len(text) and size + len(text[end].encode("utf-8")) <= maximum_bytes:
            size += len(text[end].encode("utf-8"))
            end += 1
        if end == start:
            raise ToolchainError("BUDGET_EXCEEDED", "模型输入窗口不足以容纳工作单元。")
        if end < len(text):
            boundary = text.rfind("\n", start + (end - start) // 2, end)
            if boundary >= start:
                end = boundary + 1
        parts.append((start, text[start:end]))
        start = end
    return parts


def validate_analysis(raw: Any, sources: list[dict[str, Any]], *, merged: bool = False) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("summary"), str) or not isinstance(raw.get("findings"), list):
        raise ToolchainError("MODEL_OUTPUT_INVALID", "分析工作单元缺少 summary/findings。")
    by_id = {str(item["sourceId"]): item for item in sources} if not merged else {}
    known = {(item["sourceId"], item["excerpt"]): item for source in sources
             for finding in source.get("findings", []) for item in finding.get("evidence", [])} if merged else {}
    known_refs = {evidence_ref(item): item for source in sources
                  for finding in source.get("findings", []) for item in finding.get("evidence", [])} if merged else {}
    incomplete_refs = {evidence_ref(item) for source in sources for finding in source.get("findings", [])
                       if finding.get("evidenceIncomplete") for item in finding.get("evidence", [])} if merged else set()
    result = {"summary": raw["summary"][:600], "findings": [], "warnings": [str(item)[:200] for item in raw.get("warnings", [])[:8]]}
    rejected = []
    omitted = 0
    for finding_index, finding in enumerate(raw["findings"][:8]):
        if not isinstance(finding, dict) or not str(finding.get("observation") or "").strip():
            raise ToolchainError("MODEL_OUTPUT_INVALID", "分析结论格式无效。")
        evidence = []
        incomplete = False
        raw_evidence = finding.get("evidence", [])
        if not isinstance(raw_evidence, list):
            raise ToolchainError("MODEL_OUTPUT_INVALID", "分析证据格式无效。")
        for evidence_index, item in enumerate(raw_evidence[:2]):
            if not isinstance(item, dict):
                raise ToolchainError("MODEL_OUTPUT_INVALID", "分析证据格式无效。")
            if merged and item.get("evidenceRef"):
                matched = known_refs.get(item["evidenceRef"])
                if not matched:
                    raise ToolchainError("MODEL_OUTPUT_INVALID", "汇总引入了未验证的证据引用。")
                evidence.append(matched)
                incomplete |= evidence_ref(matched) in incomplete_refs
                continue
            source_id, quote = str(item.get("sourceId") or ""), str(item.get("excerpt") or "")
            if not quote:
                raise ToolchainError("MODEL_OUTPUT_INVALID", "分析证据必须包含原文短引文。")
            if merged:
                matched = known.get((source_id, quote))
                if not matched:
                    raise ToolchainError("MODEL_OUTPUT_INVALID", "汇总引入了未验证的来源证据。")
                evidence.append(matched)
                incomplete |= evidence_ref(matched) in incomplete_refs
            else:
                source = by_id.get(source_id)
                if source is None:
                    raise ToolchainError("MODEL_OUTPUT_INVALID", "分析引用的来源不在获准的工作单元原文中。")
                at = source["content"].find(quote)
                if at < 0:
                    rejected.append({"findingIndex": finding_index, "evidenceIndex": evidence_index,
                                     "sourceId": source_id, "excerpt": quote[:120], "reason": "not_verbatim"})
                    incomplete = True
                    continue
                evidence.append({"sourceId": source_id, "excerpt": quote,
                                 "startOffset": int(source.get("offset") or 0) + at,
                                 "endOffset": int(source.get("offset") or 0) + at + len(quote),
                                 "offsetUnit": "unicode_codepoints", "contentHash": source.get("contentHash"),
                                 "chapterVersion": source.get("version"), "sourceUpdatedAt": source.get("updatedAt")})
        if incomplete and not evidence:
            # The original response remains in the journal; unsupported
            # observations never enter the verified candidate index.
            omitted += 1
            continue
        result["findings"].append({"dimension": str(finding.get("dimension") or "method")[:80],
                                  "observation": str(finding["observation"])[:400],
                                  "confidence": finding.get("confidence") if evidence and not incomplete and finding.get("confidence") in {"low", "medium", "high"} else "low",
                                  "evidence": evidence, **({"evidenceIncomplete": True} if incomplete else {})})
    if rejected:
        if not any(finding["evidence"] for finding in result["findings"]):
            raise ToolchainError("MODEL_OUTPUT_INVALID", "该工作单元没有通过原文核验的分析引文；结果已保存，请仅重试失败分片。",
                                 details={"rejectedEvidence": rejected, "omittedFindingCount": omitted})
        result["rejectedEvidence"] = rejected
        result["evidenceQuality"] = {"rejectedQuoteCount": len(rejected), "omittedFindingCount": omitted}
        result["warnings"].append(f"已剔除 {len(rejected)} 条非逐字引文，省略 {omitted} 项无有效证据的结论；受影响的保留结论为低置信度，需专家复核，不能声称证据完整。")
    if len(raw.get("findings", [])) > 8:
        result["warnings"].append("单元发现超过容量；多余发现未完成处理，需补充分析。")
    if len(canonical(result).encode("utf-8")) > 32_000:
        raise ToolchainError("MODEL_OUTPUT_INVALID", "分析结果超过工作单元容量上限；原始响应已保存。")
    return result


def evidence_ref(item: dict[str, Any]) -> str:
    return fingerprint(item)


def analysis_projection(result: dict[str, Any], maximum_bytes: int, ref: str = "") -> dict[str, Any]:
    """Bound the model view; keep every finding/evidence address in durable storage."""
    for length in (400, 180, 80, 32, 0):
        view = {"analysisRef": ref, "summary": result.get("summary", "")[:max(32, length)] if length else "", "findings": [],
                "warnings": ["此为有界投影，完整结论与证据保存在引用中。"]}
        if result.get("evidenceQuality"):
            view["evidenceQuality"] = result["evidenceQuality"]
            view["warnings"].append("原分析有引用核验缺口；低置信度结论不可升级为已验证特征，详情见分析引用。")
        elif any(finding.get("evidenceIncomplete") for finding in result.get("findings", [])):
            view["warnings"].append("部分结论继承了引用核验缺口，不可升级为已验证特征。")
        for index, finding in enumerate(result.get("findings", [])):
            view["findings"].append({"findingRef": str(index),
                "dimension": str(finding.get("dimension", "method"))[:max(12, length)] if length else "method",
                "observation": str(finding.get("observation", ""))[:length] or "见引用",
                "observationTruncated": len(str(finding.get("observation", ""))) > length,
                "confidence": finding.get("confidence", "low"),
                **({"evidenceIncomplete": True} if finding.get("evidenceIncomplete") else {}),
                "evidence": [{"evidenceRef": evidence_ref(item)} for item in finding.get("evidence", [])]})
        if len(canonical(view).encode("utf-8")) <= maximum_bytes:
            return view
    raise ToolchainError("BUDGET_EXCEEDED", "汇总窗口无法容纳最小发现与证据索引；尚未丢弃完整结果。")


def preflight_analysis(policy: dict[str, Any], chapter_count: int, *, include_expert: bool = False, include_route: bool = False) -> int:
    maximum = int(policy["maxInputBytes"])
    projection_bytes = min(14_000, (maximum - 512) // 2)
    placeholder = {"summary": "字" * 600, "findings": [{"dimension": "字" * 80, "observation": "字" * 400, "confidence": "medium", "evidence":
        [{"sourceId": "c", "excerpt": str(i)}, {"sourceId": "c", "excerpt": str(i) + "b"}]} for i in range(8)]}
    analysis_projection(placeholder, projection_bytes, "x" * 64)
    stages = policy.get("stages", {})
    minimum_calls = chapter_count * stages.get("analyze", {}).get("maxProviderCalls", 1) + max(0, chapter_count - 1) * stages.get("merge", {}).get("maxProviderCalls", 1)
    # Every chapter contributes at least a summary candidate; expert pages are
    # capped at 16. Long chapters and larger findings can require more work,
    # checked atomically as they become known.
    expert_pages_minimum = max(1, (chapter_count + 15) // 16) if include_expert else 0
    minimum_calls += expert_pages_minimum * stages.get("expert", {}).get("maxProviderCalls", 1)
    minimum_calls += stages.get("route", {}).get("maxProviderCalls", 1) if include_route else 0
    minimum_units = 2 * chapter_count - 1 + expert_pages_minimum + int(include_route)
    if minimum_calls > policy["maxModelCalls"] or minimum_units > policy.get("maxWorkUnits", policy["maxModelCalls"]):
        raise ToolchainError("BUDGET_EXCEEDED", "总调用预算不足以覆盖全部章节与最小汇总，尚未开始收费分析。")
    return projection_bytes


def union_refs(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    return {**left, **right}


class AnalysisState(TypedDict):
    jobs: list[dict[str, Any]]
    completed: Annotated[dict[str, str], union_refs]
    failures: Annotated[dict[str, dict[str, Any] | None], union_refs]
    level: int
    final_ref: str


ReadChapter = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
ModelCall = Callable[[str, dict[str, Any], str], Awaitable[Any]]
Progress = Callable[[dict[str, Any]], Awaitable[None]]


class SkillAnalysisGraph:
    def __init__(self, checkpoint_path: Path, store: SkillWorkUnitStore) -> None:
        self.checkpoint_path, self.store = checkpoint_path, store

    @staticmethod
    def freeze_completed(unit_path: Path, checkpoint_path: Path, *, owner: str, chapters: list[dict[str, Any]], active_unit_id: str | None = None) -> dict[str, Any]:
        """Freeze only complete chapter jobs, including all their verified leaves."""
        records = SkillWorkUnitStore.read_completed_analysis(unit_path, owner)
        expected = {chapter["chapterId"]: chapter for chapter in chapters}
        groups = {}
        for record in records:
            graph_key = record.get("graphKey")
            snapshot = record.get("snapshot") or {}
            chapter = expected.get(snapshot.get("chapterId"))
            # Catalog hashes describe stored editor documents; verbatim hashes
            # describe extracted prose (or the approved editor buffer). They
            # are different representations, so compare source versions here.
            # The graph checkpoint proves the chapter job completed, while the
            # manifest separately pins each verified result's exact hash.
            if (not graph_key or not chapter or snapshot.get("version") != chapter.get("version")
                    or snapshot.get("updatedAt") != chapter.get("updatedAt")):
                continue
            groups.setdefault(graph_key, []).append(record)
        available = []
        active_graphs = set()
        with closing(sqlite3.connect(checkpoint_path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            saver = SqliteSaver(db)
            for graph_key, items in groups.items():
                checkpoint = saver.get_tuple({"configurable": {"thread_id": f"skill-analysis:{graph_key}"}})
                values = checkpoint.checkpoint.get("channel_values", {}) if checkpoint else {}
                completed = values.get("completed", {})
                if active_unit_id and (active_unit_id in completed or active_unit_id in values.get("failures", {})
                    or any(job.get("id") == active_unit_id for job in values.get("jobs", []))):
                    active_graphs.add(graph_key)
                selected = [item for item in items if fingerprint([graph_key, item["snapshot"]["chapterId"]]) in completed]
                if selected:
                    available.append((graph_key, selected))
        if active_graphs:
            available = [item for item in available if item[0] in active_graphs]
        if not available:
            raise ToolchainError("CONTEXT_INSUFFICIENT", "没有已完成且来源匹配的章节分析，无法仅用当前结果收尾。")
        if len(available) != 1:
            raise ToolchainError("CONTEXT_INSUFFICIENT", "已保存分析包含多个来源或方法版本，不能混合收尾，请先核对原任务。")
        graph_key, selected = available[0]
        ids = {item["snapshot"]["chapterId"] for item in selected}
        manifest = {"version": 1, "owner": owner, "sourceGraphKey": graph_key,
                    "chapters": [chapter for chapter in chapters if chapter["chapterId"] in ids],
                    "omittedChapters": [chapter for chapter in chapters if chapter["chapterId"] not in ids],
                    "units": [{"ref": item["ref"], "resultHash": fingerprint(item["analysis"])} for item in selected]}
        return {**manifest, "manifestHash": fingerprint(manifest)}

    async def run(self, *, owner: str, chapters: list[dict[str, Any]], goal: str,
                  skill_hash: str, hints: SkillExecutionHints, policy: dict[str, Any],
                  read: ReadChapter, model: ModelCall, progress: Progress,
                  check_cancelled: Callable[[], None], completed_scope: dict[str, Any] | None = None) -> dict[str, Any]:
        if not chapters:
            raise ToolchainError("CONTEXT_INSUFFICIENT", "获准范围没有可分析的章节。")
        maximum = int(policy["maxInputBytes"])
        projection_bytes = preflight_analysis(policy, 1 if completed_scope else len(chapters))
        graph_key = fingerprint({"executorVersion": "chapter-analysis-v2", "owner": owner, "sources": chapters, "goal": goal, "skill": skill_hash,
                                 "hints": hints.model_dump(), "policy": policy})
        concurrency = min(3, policy["maxConcurrency"]) if (
            hints.parallel and len(chapters) >= policy.get("delegationMinChapters", 4)
            and policy.get("executionMode", "delegated") == "delegated"
        ) else 1
        jobs = [{"id": fingerprint([graph_key, chapter["chapterId"]]), "kind": "chapter", "chapter": chapter,
                 "index": index + 1, "total": len(chapters)} for index, chapter in enumerate(chapters)]
        frozen_records = None
        if completed_scope:
            check_cancelled()
            manifest = {key: value for key, value in completed_scope.items() if key != "manifestHash"}
            if completed_scope.get("owner") != owner or fingerprint(manifest) != completed_scope.get("manifestHash"):
                raise ToolchainError("INPUT_INVALID", "已完成结果的冻结记录不一致，不能继续。")
            existing = {item["ref"]: item for item in await asyncio.to_thread(
                self.store.completed_analysis, owner, completed_scope["sourceGraphKey"])}
            frozen_records = []
            for entry in completed_scope["units"]:
                record = existing.get(entry["ref"])
                if not record or fingerprint(record["analysis"]) != entry["resultHash"]:
                    raise ToolchainError("CONTEXT_INSUFFICIENT", "冻结的分析结果缺失或已改变，请检查原任务。")
                frozen_records.append(record)
            if not frozen_records or completed_scope["chapters"] != chapters:
                raise ToolchainError("INPUT_INVALID", "冻结的章节范围不一致，不能继续。")
            graph_key = fingerprint({"executorVersion": "completed-results-v1", "manifest": completed_scope["manifestHash"],
                                     "goal": goal, "skill": skill_hash, "policy": policy})
            refs = [item["ref"] for item in frozen_records]
            jobs = [{"id": fingerprint([graph_key, 0, refs[i:i + 2]]), "kind": "merge", "refs": refs[i:i + 2]}
                    for i in range(0, len(refs), 2)]

        async def request(kind: str, payload: dict[str, Any], source_items: list[dict[str, Any]], key: str,
                          metadata: dict[str, Any] | None = None) -> str:
            check_cancelled()
            if await asyncio.to_thread(self.store.result, key) is not None:
                return key
            size = len(canonical(payload).encode("utf-8"))
            if size > policy["maxInputBytes"]:
                raise ToolchainError("BUDGET_EXCEEDED", "工作单元输入超过当前模型预算。")
            record = await asyncio.to_thread(self.store.record, key)
            metadata_value = {"kind": kind, "graphKey": graph_key, **(metadata or {})}
            if record and record["status"] == "failed" and record.get("rawResult") is not None:
                if record["inputHash"] != fingerprint(payload):
                    raise ToolchainError("INPUT_INVALID", "已保存分析结果的来源输入不一致，不能复用。")
                try:
                    checked = validate_analysis(record["rawResult"], source_items, merged=kind == "merge")
                except ToolchainError:
                    # Still-invalid saved results may be regenerated only by
                    # the caller's explicit retry, within the existing budget.
                    pass
                else:
                    await asyncio.to_thread(self.store.finish, key, checked,
                        {**metadata_value, "executionUsage": record["rawResult"].get("_executionUsage"), "revalidatedSavedResult": True},
                        expected_input_hash=record["inputHash"])
                    return key
            raw = record.get("rawResult") if record and record["status"] == "running" else None
            if raw is None and record and record["status"] == "running":
                # The callback may reconcile an existing Automation checkpoint;
                # it must never send a second unknown provider request.
                raw = await model("recover", {"requestId": record["requestId"], "sourceKind": kind}, key)
            if raw is None:
                stage = policy.get("stages", {}).get(kind, {})
                calls = stage.get("maxProviderCalls", 1)
                reserve = stage.get("inputReserveTokens", size) + stage.get("outputReserveTokens", policy["outputReserveTokens"])
                await asyncio.to_thread(self.store.begin, owner, key, fingerprint(payload), reserve, policy, calls)
                record = await asyncio.to_thread(self.store.record, key)
            try:
                if raw is None:
                    raw = await model(kind, {"goal": goal, "source": payload, "requestId": record["requestId"],
                        "executionBudget": policy.get("stages", {}).get(kind),
                        "locale": policy.get("locale", "zh-CN")}, key)
                    await asyncio.to_thread(self.store.save_raw, key, raw)
                checked = validate_analysis(raw, source_items, merged=kind == "merge")
                await asyncio.to_thread(self.store.finish, key, checked, {**metadata_value, "executionUsage": raw.get("_executionUsage")})
            except Exception as error:
                if not isinstance(error, (sqlite3.Error, OSError)):
                    await asyncio.to_thread(self.store.fail, key, error)
                raise
            return key

        async def merge_refs(refs: list[str], key: str) -> str:
            if len(refs) == 1:
                return refs[0]
            results = await asyncio.gather(*(asyncio.to_thread(self.store.result, ref) for ref in refs))
            if any(result is None for result in results):
                raise ToolchainError("CONTEXT_INSUFFICIENT", "汇总工作单元缺少已完成结果。")
            projections = [analysis_projection(result, projection_bytes, ref) for result, ref in zip(results, refs)]
            return await request("merge", {"results": projections}, results, key)

        async def process_unit(state: dict[str, Any]) -> dict[str, Any]:
            job = state["job"]
            check_cancelled()
            detail = {"chapterId": job["chapter"]["chapterId"], "chapterTitle": job["chapter"]["title"],
                      "unitIndex": job["index"], "totalUnits": job["total"]} if job["kind"] == "chapter" else {}
            await progress({"unitId": job["id"], "stage": job["kind"], "status": "running", **detail})
            if job["kind"] == "merge":
                result_ref = await merge_refs(job["refs"], job["id"])
            else:
                chapter = await read(job["chapter"])
                expected = job["chapter"]
                if (chapter.get("chapterId") != expected["chapterId"] or chapter.get("contentMode") != "full"
                        or chapter.get("version") != expected["version"] or chapter.get("updatedAt") != expected["updatedAt"]):
                    raise ToolchainError("CONTEXT_INSUFFICIENT", "章节已改变或原文读取不完整，请重新建立来源快照。")
                preceding = state.get("previous")
                prior_view = None
                if preceding and not hints.parallel:
                    prior_view = analysis_projection(await asyncio.to_thread(self.store.result, preceding), projection_bytes, preceding)
                fixed = len(canonical({"samples": [{"sourceId": chapter["chapterId"], "content": "", "offset": 0,
                    "contentHash": chapter["contentHash"], "title": chapter.get("title", ""),
                    "version": chapter["version"], "updatedAt": chapter["updatedAt"]}], "previous": prior_view,
                    "partCount": 100000, "partialChapter": True}).encode("utf-8")) + 256
                # JSON escaping can double byte size, even when raw prose fits.
                parts = split_verbatim(str(chapter.get("content") or ""), min(24_000, (maximum - max(fixed, projection_bytes + 1024)) // 2))
                refs = []
                for offset, text in parts:
                    source = {"sourceId": chapter["chapterId"], "content": text, "offset": offset,
                              "contentHash": chapter["contentHash"], "title": chapter.get("title", ""),
                              "version": chapter["version"], "updatedAt": chapter["updatedAt"]}
                    key = fingerprint([graph_key, source])
                    payload = {"samples": [source], "partCount": len(parts), "partialChapter": len(parts) > 1}
                    preceding = refs[-1] if refs else state.get("previous")
                    if preceding and not hints.parallel:
                        payload["previous"] = analysis_projection(await asyncio.to_thread(self.store.result, preceding), projection_bytes, preceding)
                    snapshot = {"chapterId": chapter["chapterId"], "version": chapter["version"],
                        "contentHash": chapter["contentHash"], "updatedAt": chapter["updatedAt"], "source": chapter.get("source", "database")}
                    refs.append(await request("analyze", payload, [source], key, {"snapshot": snapshot,
                        "chapterIndex": job["index"], "offset": offset, "endOffset": offset + len(text)}))
                level = 0
                while len(refs) > 1:
                    refs = [await merge_refs(refs[i:i + 2], fingerprint([graph_key, job["id"], level, refs[i:i + 2]]))
                            for i in range(0, len(refs), 2)]
                    level += 1
                result_ref = refs[0]
            await progress({"unitId": job["id"], "stage": job["kind"], "status": "completed", **detail})
            return {"completed": {job["id"]: result_ref}, "failures": {job["id"]: None}}

        async def worker(state: dict[str, Any]) -> dict[str, Any]:
            # Commit all siblings in a dispatched wave before surfacing a unit
            # failure. Throwing inside a worker would cancel valid in-flight
            # requests and turn their recoverable results into unknown calls.
            try:
                return await process_unit(state)
            except Exception as error:
                job = state["job"]
                failure = {"code": str(getattr(error, "code", "NODE_FAILED")), "message": str(error)[:1000],
                           **(storage_failure(error) or {})}
                detail = {"chapterTitle": job["chapter"]["title"], "unitIndex": job["index"], "totalUnits": job["total"]} if job["kind"] == "chapter" else {}
                await progress({"unitId": job["id"], "stage": job["kind"], "status": "failed", **failure, **detail})
                return {"failures": {job["id"]: failure}}

        def route(state: AnalysisState) -> list[Send] | str:
            pending = [job for job in state["jobs"] if job["id"] not in state["completed"]]
            if not pending:
                return "dispatch"
            previous = None
            if not hints.parallel:
                index = state["jobs"].index(pending[0])
                if index:
                    previous = state["completed"].get(state["jobs"][index - 1]["id"])
            return [Send("worker", {"job": job, "previous": previous}) for job in pending[:concurrency]]

        async def dispatch(state: AnalysisState) -> dict[str, Any]:
            check_cancelled()
            for job in state["jobs"]:
                failure = state.get("failures", {}).get(job["id"])
                if failure:
                    raise ToolchainError(failure["code"], failure["message"], node_id=job["id"],
                        retryable=failure["code"] in {"MODEL_OUTPUT_INVALID", "PROVIDER_RATE_LIMITED"},
                        details={key: value for key, value in failure.items() if key not in {"code", "message"}})
            done = all(job["id"] in state["completed"] for job in state["jobs"])
            if not done:
                return {}
            refs = [state["completed"][job["id"]] for job in state["jobs"]]
            if len(refs) == 1:
                return {"final_ref": refs[0]}
            level = state["level"] + 1
            next_jobs = [{"id": fingerprint([graph_key, level, refs[i:i + 2]]), "kind": "merge", "refs": refs[i:i + 2]}
                         for i in range(0, len(refs), 2)]
            return {"jobs": next_jobs, "level": level}

        def after_dispatch(state: AnalysisState) -> list[Send] | str:
            return END if state.get("final_ref") else route(state)

        builder = StateGraph(AnalysisState)
        builder.add_node("dispatch", dispatch)
        builder.add_node("worker", worker)
        builder.add_edge(START, "dispatch")
        builder.add_conditional_edges("dispatch", after_dispatch)
        builder.add_edge("worker", "dispatch")
        config = {"configurable": {"thread_id": f"skill-analysis:{graph_key}"},
                  "recursion_limit": max(200, len(chapters) * 4 + 100)}
        async with AsyncSqliteSaver.from_conn_string(str(self.checkpoint_path)) as saver:
            await saver.setup()
            graph = builder.compile(checkpointer=saver, name="skill-adaptive-analysis")
            previous = await graph.aget_state(config)
            if previous.values and previous.values.get("final_ref"):
                result = previous.values
            else:
                if previous.values and any(previous.values.get("failures", {}).values()):
                    # Explicit resume retries pending units while retaining the
                    # completed sibling references in the checkpoint.
                    await graph.aupdate_state(config, {"failures": {
                        key: None for key in previous.values["failures"]}}, as_node="dispatch")
                result = await graph.ainvoke(None if previous.values else
                                             {"jobs": jobs, "completed": {}, "failures": {}, "level": 0, "final_ref": ""}, config)
        final = await asyncio.to_thread(self.store.result, result["final_ref"])
        if final is None:
            raise ToolchainError("CONTEXT_INSUFFICIENT", "分析结果引用不可用。")
        records = frozen_records if frozen_records is not None else await asyncio.to_thread(self.store.completed_analysis, owner, graph_key)
        snapshots = {item["snapshot"]["chapterId"]: item["snapshot"] for item in records}
        warnings = list(final.get("warnings", []))
        unit_warnings = [warning for item in records for warning in item["analysis"].get("warnings", [])]
        rejected_quotes = sum(item["analysis"].get("evidenceQuality", {}).get("rejectedQuoteCount", 0) for item in records)
        omitted_findings = sum(item["analysis"].get("evidenceQuality", {}).get("omittedFindingCount", 0) for item in records)
        evidence_gap_chapters = len({item["snapshot"]["chapterId"] for item in records if item["analysis"].get("evidenceQuality")})
        if rejected_quotes:
            warnings.append(f"{evidence_gap_chapters} 章存在引用核验缺口：剔除 {rejected_quotes} 条非逐字引文，省略 {omitted_findings} 项无有效证据的结论；受影响结论仅可作为低置信度候选。")
        if unit_warnings:
            warnings.append("工作单元包含分析限制或未解决项；完整说明保存在单元引用中，根摘要不能代替逐项核验。")
        if any("单元发现超过容量" in warning for warning in unit_warnings):
            warnings.append("至少一个单元的发现超过容量，多余发现未完成处理，需要补充分析；当前不能声明穷尽全部问题。")
        omitted = completed_scope["omittedChapters"] if completed_scope else []
        if completed_scope:
            warnings.append(f"用户选择仅用已完成结果收尾：实际覆盖 {len(chapters)}/{len(chapters) + len(omitted)} 章，跳过 {len(omitted)} 章；不得声称全书覆盖或推断未分析章节。")
        return {"version": 2, "sourceType": "analyzed_chapter_scope", "chapterCount": len(chapters),
                "confidence": "medium", "analysis": final, "analysisRef": result["final_ref"],
                "unitRefs": [item["ref"] for item in records], "sourceSnapshot": list(snapshots.values()),
                "executionPolicy": policy,
                "coverage": {"totalChapterCount": len(chapters) + len(omitted), "analyzedChapterCount": len(chapters),
                             **({"evidenceGapChapterCount": evidence_gap_chapters} if evidence_gap_chapters else {}),
                             "mode": "user_completed_results" if completed_scope else "all_units",
                             **({"omittedChapterCount": len(omitted), "omittedChapterIds": [item["chapterId"] for item in omitted],
                                 "closureRef": completed_scope["manifestHash"]} if completed_scope else {}),
                             "executionMode": "delegated" if concurrency > 1 else ("single" if len(chapters) <= 3 else "partitioned"),
                             "maxConcurrency": concurrency},
                "warnings": list(dict.fromkeys(warnings))}
