from __future__ import annotations

import json
from typing import Any

from .schemas import (
    ContextEvidence,
    PlotlineAnalysisArtifact,
    PlotlineAnalysisContext,
    PlotlineAnalysisInput,
    PlotlineAnalysisIssue,
    PlotlineAnalysisScope,
    PlotlineThreadAssessment,
    ToolchainError,
    estimate_tokens,
)


PLOTLINE_SCOPE_OPTIONS = {
    "plot_current_chapter": "chapter",
    "plot_current_volume": "volume",
    "plot_whole_novel": "novel",
}

_CHAPTER_SCOPE_MARKERS = ("当前章", "本章", "当前章节", "这一章", "current chapter")
_VOLUME_SCOPE_MARKERS = ("当前卷", "本卷", "整卷", "全卷", "current volume")
_NOVEL_SCOPE_MARKERS = ("整本", "全书", "整个小说", "全局情节", "所有章节", "whole novel", "entire novel")


def infer_plotline_scope(goal: str) -> PlotlineAnalysisScope | None:
    normalized = goal.strip().lower()
    if any(marker in normalized for marker in _NOVEL_SCOPE_MARKERS):
        return "novel"
    if any(marker in normalized for marker in _VOLUME_SCOPE_MARKERS):
        return "volume"
    if any(marker in normalized for marker in _CHAPTER_SCOPE_MARKERS):
        return "chapter"
    return None


def initial_plotline_analysis_state(input_data: PlotlineAnalysisInput) -> dict[str, Any]:
    return {
        "input": input_data.model_dump(),
        # Toolchain input is planner/model output, not proof that the user approved a scope.
        "scope": None,
        "scopeChecked": False,
        "plotlines": None,
        "volumes": None,
        "batches": [],
        "batchesPlanned": False,
        "batchIndex": 0,
        "chapters": [],
        "ragResult": None,
        "ragCompleted": False,
        "warnings": [],
        "sourceStatus": {},
        "toolCallCount": 0,
        "modelCallCount": 0,
        "estimatedTokens": 0,
        "coverage": {},
        "analysis": None,
        "artifactId": None,
    }


def resolve_plotline_scope(state: dict[str, Any], scope: PlotlineAnalysisScope) -> dict[str, Any]:
    input_data = PlotlineAnalysisInput.model_validate(state["input"])
    if scope == "chapter" and not input_data.chapterId:
        raise ToolchainError(
            "CONTEXT_INSUFFICIENT",
            "按章节分析需要当前 chapterId。",
            node_id="scope.resolve",
        )
    if scope == "volume" and not input_data.volumeId:
        raise ToolchainError(
            "CONTEXT_INSUFFICIENT",
            "按卷分析需要当前 volumeId。",
            node_id="scope.resolve",
        )
    return {**state, "scope": scope, "scopeChecked": True}


def compact_plotlines(value: Any) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    for item in _as_items(value)[:120]:
        points = []
        for point in _as_items(item.get("points"))[:80]:
            anchors = []
            for anchor in _as_items(point.get("anchors"))[:24]:
                anchors.append(
                    _pick(
                        anchor,
                        "id",
                        "chapterId",
                        "volumeId",
                        "title",
                        "label",
                        "description",
                        "order",
                    )
                )
            normalized_point = _pick(
                point,
                "id",
                "name",
                "title",
                "description",
                "summary",
                "status",
                "type",
                "order",
                "chapterId",
                "volumeId",
            )
            if anchors:
                normalized_point["anchors"] = anchors
            points.append(normalized_point)
        normalized = _pick(
            item,
            "id",
            "name",
            "title",
            "description",
            "summary",
            "status",
            "type",
            "role",
            "isMain",
            "sortOrder",
        )
        if points:
            normalized["points"] = points
        compact.append(normalized)
    return compact


def apply_plotline_result(state: dict[str, Any], value: Any) -> dict[str, Any]:
    plotlines = compact_plotlines(value)
    tokens = estimate_tokens(plotlines)
    return {
        **state,
        "plotlines": plotlines,
        "sourceStatus": {**(state.get("sourceStatus") or {}), "plotline.read": "completed"},
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
        "estimatedTokens": int(state.get("estimatedTokens") or 0) + tokens,
    }


def apply_volume_result(state: dict[str, Any], value: Any) -> dict[str, Any]:
    volumes = []
    for volume in _as_items(value):
        chapters = [
            _pick(chapter, "id", "chapterId", "volumeId", "title", "order", "wordCount", "updatedAt")
            for chapter in _as_items(volume.get("chapters"))
        ]
        normalized = _pick(volume, "id", "volumeId", "novelId", "title", "order")
        normalized["chapters"] = chapters
        volumes.append(normalized)
    metadata_tokens = estimate_tokens(volumes)
    return {
        **state,
        "volumes": volumes,
        "sourceStatus": {**(state.get("sourceStatus") or {}), "volume.read": "completed"},
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
        "estimatedTokens": int(state.get("estimatedTokens") or 0) + metadata_tokens,
    }


def build_plotline_batches(state: dict[str, Any]) -> dict[str, Any]:
    input_data = PlotlineAnalysisInput.model_validate(state["input"])
    scope = _scope(state)
    if scope == "chapter":
        coverage = {
            "scope": scope,
            "availableChapterCount": 1,
            "selectedChapterCount": 1,
            "analyzedChapterCount": 0,
            "omittedChapterCount": 0,
            "volumeIds": [input_data.volumeId] if input_data.volumeId else [],
            "chapterIds": [],
            "batchCount": 1,
        }
        return {
            **state,
            "batches": [{"kind": "chapter", "chapterId": input_data.chapterId}],
            "batchesPlanned": True,
            "coverage": coverage,
        }

    volumes = list(state.get("volumes") or [])
    if scope == "volume":
        volumes = [
            volume
            for volume in volumes
            if str(volume.get("id") or volume.get("volumeId") or "") == str(input_data.volumeId)
        ]
        if not volumes:
            raise ToolchainError(
                "CONTEXT_INSUFFICIENT",
                "当前 volumeId 不在项目卷列表中。",
                node_id="batch.plan",
            )
    if not volumes:
        raise ToolchainError(
            "CONTEXT_INSUFFICIENT",
            "没有可用于情节线分析的卷或章节。",
            node_id="batch.plan",
        )

    available_count = sum(len(volume.get("chapters") or []) for volume in volumes)
    remaining = min(input_data.maxChapters, available_count)
    batches: list[dict[str, Any]] = []
    selected_ids: list[str] = []
    for volume in volumes:
        if remaining <= 0:
            break
        volume_id = str(volume.get("id") or volume.get("volumeId") or "")
        chapter_meta = list(volume.get("chapters") or [])
        selected = chapter_meta[:remaining]
        for offset in range(0, len(selected), input_data.batchSize):
            chunk = selected[offset:offset + input_data.batchSize]
            batches.append(
                {
                    "kind": "volume_batch",
                    "volumeId": volume_id,
                    "offset": offset,
                    "limit": len(chunk),
                    "expectedChapterIds": [
                        str(item.get("id") or item.get("chapterId") or "") for item in chunk
                    ],
                }
            )
            selected_ids.extend(
                str(item.get("id") or item.get("chapterId") or "") for item in chunk
            )
        remaining -= len(selected)

    selected_ids = [item for item in selected_ids if item]
    omitted_count = max(0, available_count - len(selected_ids))
    warnings = list(state.get("warnings") or [])
    if omitted_count:
        warnings.append(
            f"分析范围共有 {available_count} 章；受 maxChapters={input_data.maxChapters} 限制，"
            f"本次选择 {len(selected_ids)} 章，省略 {omitted_count} 章。"
        )
    coverage = {
        "scope": scope,
        "availableChapterCount": available_count,
        "selectedChapterCount": len(selected_ids),
        "analyzedChapterCount": 0,
        "omittedChapterCount": omitted_count,
        "volumeIds": [str(volume.get("id") or volume.get("volumeId") or "") for volume in volumes],
        "chapterIds": [],
        "plannedChapterIds": selected_ids,
        "batchCount": len(batches),
    }
    return {
        **state,
        "batches": batches,
        "batchesPlanned": True,
        "warnings": _dedupe(warnings),
        "coverage": coverage,
    }


def build_chapter_batch_call(state: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
    batches = list(state.get("batches") or [])
    index = int(state.get("batchIndex") or 0)
    if index >= len(batches):
        raise ToolchainError("NODE_FAILED", "No pending chapter batch", node_id="chapter.batch")
    batch = batches[index]
    node_id = f"chapter.batch.{index + 1}"
    if batch.get("kind") == "chapter":
        return "chapter.get", {"chapterId": batch.get("chapterId")}, node_id
    return (
        "chapter.list",
        {
            "volumeId": batch.get("volumeId"),
            "offset": int(batch.get("offset") or 0),
            "limit": int(batch.get("limit") or 1),
            "includeContent": True,
        },
        node_id,
    )


def apply_chapter_batch_result(
    state: dict[str, Any],
    value: Any,
    *,
    max_estimated_tokens: int,
) -> dict[str, Any]:
    batches = list(state.get("batches") or [])
    index = int(state.get("batchIndex") or 0)
    batch = batches[index]
    raw_items = [_as_record(value)] if batch.get("kind") == "chapter" else _as_items(value)
    raw_items = [item for item in raw_items if item]
    expected_ids = [
        str(item)
        for item in (
            [batch.get("chapterId")]
            if batch.get("kind") == "chapter"
            else batch.get("expectedChapterIds") or []
        )
        if item
    ]
    unexpected_count = 0
    if expected_ids:
        raw_by_id = {
            str(item.get("id") or item.get("chapterId") or ""): item
            for item in raw_items
            if item.get("id") or item.get("chapterId")
        }
        unexpected_count = sum(
            1
            for item in raw_items
            if str(item.get("id") or item.get("chapterId") or "") not in expected_ids
        )
        raw_items = [raw_by_id[item_id] for item_id in expected_ids if item_id in raw_by_id]
    remaining_tokens = max(400, max_estimated_tokens - int(state.get("estimatedTokens") or 0))
    char_limit = max(400, min(3600, remaining_tokens // max(1, len(raw_items))))
    compact = [compact_chapter(item, max_excerpt_chars=char_limit) for item in raw_items]
    compact = [item for item in compact if item.get("id")]
    batch_tokens = estimate_tokens(compact)
    if batch_tokens > remaining_tokens and compact:
        char_limit = max(240, char_limit * remaining_tokens // batch_tokens)
        compact = [compact_chapter(item, max_excerpt_chars=char_limit) for item in raw_items]
        compact = [item for item in compact if item.get("id")]
        batch_tokens = estimate_tokens(compact)

    chapters = [*(state.get("chapters") or []), *compact]
    chapter_ids = list(dict.fromkeys(str(item.get("id")) for item in chapters if item.get("id")))
    returned_ids = {str(item.get("id")) for item in compact if item.get("id")}
    missing_ids = [item_id for item_id in expected_ids if item_id not in returned_ids]
    coverage = {**(state.get("coverage") or {})}
    coverage["analyzedChapterCount"] = len(chapter_ids)
    coverage["omittedChapterCount"] = int(coverage.get("omittedChapterCount") or 0) + len(missing_ids)
    coverage["chapterIds"] = chapter_ids
    warnings = list(state.get("warnings") or [])
    if missing_ids:
        warnings.append(
            f"第 {index + 1} 批计划读取 {len(expected_ids)} 章，"
            f"仅收到 {len(returned_ids)} 个有效章节；缺失 {len(missing_ids)} 章已计入省略。"
        )
    if unexpected_count:
        warnings.append(f"第 {index + 1} 批丢弃 {unexpected_count} 条不在计划范围内的章节响应。")
    return {
        **state,
        "batchIndex": index + 1,
        "chapters": chapters,
        "coverage": coverage,
        "warnings": _dedupe(warnings),
        "sourceStatus": {
            **(state.get("sourceStatus") or {}),
            f"chapter.batch.{index + 1}": "partial" if missing_ids else "completed",
        },
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
        "estimatedTokens": int(state.get("estimatedTokens") or 0) + batch_tokens,
    }


def skip_remaining_batches(state: dict[str, Any], reason: str) -> dict[str, Any]:
    batches = list(state.get("batches") or [])
    index = int(state.get("batchIndex") or 0)
    omitted = sum(int(batch.get("limit") or 1) for batch in batches[index:])
    coverage = {**(state.get("coverage") or {})}
    coverage["omittedChapterCount"] = int(coverage.get("omittedChapterCount") or 0) + omitted
    coverage["selectedChapterCount"] = int(coverage.get("analyzedChapterCount") or 0)
    source_status = {**(state.get("sourceStatus") or {})}
    for position in range(index, len(batches)):
        source_status[f"chapter.batch.{position + 1}"] = "skipped"
    return {
        **state,
        "batchIndex": len(batches),
        "coverage": coverage,
        "warnings": _dedupe([*(state.get("warnings") or []), reason]),
        "sourceStatus": source_status,
    }


def apply_chapter_batch_failure(state: dict[str, Any], error: Exception) -> dict[str, Any]:
    index = int(state.get("batchIndex") or 0)
    batches = list(state.get("batches") or [])
    batch = batches[index]
    omitted = int(batch.get("limit") or 1)
    coverage = {**(state.get("coverage") or {})}
    coverage["omittedChapterCount"] = int(coverage.get("omittedChapterCount") or 0) + omitted
    return {
        **state,
        "batchIndex": index + 1,
        "coverage": coverage,
        "warnings": _dedupe([*(state.get("warnings") or []), f"第 {index + 1} 批章节读取失败：{error}"]),
        "sourceStatus": {**(state.get("sourceStatus") or {}), f"chapter.batch.{index + 1}": "failed"},
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
    }


def plotline_rag_params(input_data: PlotlineAnalysisInput, state: dict[str, Any]) -> dict[str, Any]:
    scope = _scope(state)
    rag_scope = {
        "chapter": "current_chapter",
        "volume": "volume_structure",
        "novel": "compare_two_paths",
    }[scope]
    coverage = state.get("coverage") or {}
    chapter_ids = coverage.get("chapterIds") or []
    question = (
        f"{input_data.goal}\n"
        f"本次按 {scope} 范围分析，已读取 {len(chapter_ids)} 章。"
        "请检索能证明主线、支线、伏笔推进或停滞的资料，只返回可标注来源的证据。"
    )
    params: dict[str, Any] = {
        "novelId": input_data.novelId,
        "question": question,
        "analysisScope": rag_scope,
        "locale": input_data.locale,
        "maxEvidenceItems": 16,
    }
    if input_data.chapterId:
        params["chapterId"] = input_data.chapterId
    return params


def apply_rag_result(state: dict[str, Any], value: Any) -> dict[str, Any]:
    bounded = _bounded(value, string_limit=3000)
    return {
        **state,
        "ragResult": bounded,
        "ragCompleted": True,
        "sourceStatus": {**(state.get("sourceStatus") or {}), "rag.retrieve": "completed"},
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
        "estimatedTokens": int(state.get("estimatedTokens") or 0) + estimate_tokens(bounded),
    }


def apply_rag_failure(state: dict[str, Any], error: Exception) -> dict[str, Any]:
    return {
        **state,
        "ragCompleted": True,
        "warnings": _dedupe([*(state.get("warnings") or []), f"RAG 检索失败：{error}"]),
        "sourceStatus": {**(state.get("sourceStatus") or {}), "rag.retrieve": "failed"},
        "toolCallCount": int(state.get("toolCallCount") or 0) + 1,
    }


def build_plotline_context(state: dict[str, Any]) -> PlotlineAnalysisContext:
    chapters = list(state.get("chapters") or [])
    if not chapters:
        raise ToolchainError(
            "CONTEXT_INSUFFICIENT",
            "未读取到可分析的章节正文。",
            node_id="analysis.synthesize",
        )
    evidence = _rag_evidence(state.get("ragResult"))
    warnings = list(state.get("warnings") or [])
    if not evidence:
        warnings.append("未检索到额外可引用证据；报告仅基于已读取章节和情节线资料。")
    coverage = {**(state.get("coverage") or {})}
    coverage["analyzedChapterCount"] = len(chapters)
    coverage["chapterIds"] = [str(item.get("id")) for item in chapters if item.get("id")]
    return PlotlineAnalysisContext(
        scope=_scope(state),
        plotlines=list(state.get("plotlines") or []),
        chapters=chapters,
        evidence=evidence,
        warnings=_dedupe(warnings),
        coverage=coverage,
        toolCallCount=int(state.get("toolCallCount") or 0),
        estimatedTokens=int(state.get("estimatedTokens") or 0),
    )


def plotline_analysis_request(
    input_data: PlotlineAnalysisInput,
    context: PlotlineAnalysisContext,
) -> dict[str, Any]:
    return {
        "novelId": input_data.novelId,
        "goal": input_data.goal,
        "locale": input_data.locale,
        "scope": context.scope,
        "context": context.model_dump(),
    }


def normalize_plotline_analysis(
    value: Any,
    context: PlotlineAnalysisContext,
) -> PlotlineAnalysisArtifact:
    raw = _as_record(value)
    for key in ("analysis", "report", "result"):
        if isinstance(raw.get(key), dict):
            raw = raw[key]
            break

    plotline_by_id = {
        str(item.get("id")): item for item in context.plotlines if item.get("id")
    }
    plotline_by_name = {
        str(item.get("name") or item.get("title") or "").strip().casefold(): str(item.get("id"))
        for item in context.plotlines
        if item.get("id") and str(item.get("name") or item.get("title") or "").strip()
    }
    chapter_ids = {str(item.get("id")) for item in context.chapters if item.get("id")}
    evidence_source_ids = {str(item.sourceId) for item in context.evidence if item.sourceId}
    valid_source_ids = {*plotline_by_id, *chapter_ids, *evidence_source_ids}

    threads: list[PlotlineThreadAssessment] = []
    seen_threads: set[str] = set()
    for index, item in enumerate(_as_items(raw.get("threads"))[:120]):
        name = str(item.get("name") or item.get("title") or f"情节线 {index + 1}").strip()
        plotline_id = str(item.get("plotlineId") or item.get("id") or "").strip() or None
        if plotline_id not in plotline_by_id:
            plotline_id = plotline_by_name.get(name.casefold())
        key = plotline_id or name.casefold()
        if key in seen_threads:
            continue
        seen_threads.add(key)
        evidence = _normalize_evidence(item.get("evidence"), valid_source_ids)
        uncertainty = str(item.get("uncertainty") or "").strip()
        if not evidence and not uncertainty:
            uncertainty = "当前覆盖资料不足，需人工确认。"
        threads.append(
            PlotlineThreadAssessment(
                plotlineId=plotline_id,
                name=name,
                role=_normalize_role(item.get("role") or item.get("type")),
                status=str(item.get("status") or "").strip(),
                progressionScore=_score(
                    item.get("progressionScore")
                    if item.get("progressionScore") is not None
                    else item.get("score")
                ),
                lastProgressLocation=str(item.get("lastProgressLocation") or item.get("location") or "").strip(),
                coveredChapterIds=_valid_ids(item.get("coveredChapterIds") or item.get("chapterIds"), chapter_ids),
                findings=_strings(item.get("findings") or item.get("observations"), limit=20),
                evidence=evidence,
                recommendations=_strings(item.get("recommendations") or item.get("suggestions"), limit=12),
                uncertainty=uncertainty,
            )
        )

    issues: list[PlotlineAnalysisIssue] = []
    seen_issues: set[tuple[str, str]] = set()
    allowed_types = {"stalled", "unresolved_foreshadowing", "pacing", "continuity", "coverage", "other"}
    for index, item in enumerate(_as_items(raw.get("issues"))[:120]):
        title = str(item.get("title") or item.get("name") or f"分析问题 {index + 1}").strip()
        issue_type = str(item.get("type") or "other").strip().lower()
        if issue_type not in allowed_types:
            issue_type = "other"
        dedupe_key = (issue_type, title.casefold())
        if dedupe_key in seen_issues:
            continue
        seen_issues.add(dedupe_key)
        evidence = _normalize_evidence(item.get("evidence"), valid_source_ids)
        issues.append(
            PlotlineAnalysisIssue(
                issueId=str(item.get("issueId") or item.get("id") or f"plot-issue-{index + 1}"),
                type=issue_type,
                severity=_severity(item.get("severity")),
                title=title,
                plotlineIds=_valid_ids(item.get("plotlineIds"), set(plotline_by_id)),
                chapterIds=_valid_ids(item.get("chapterIds"), chapter_ids),
                evidence=evidence,
                recommendation=str(item.get("recommendation") or item.get("suggestion") or "").strip(),
                uncertainty=str(item.get("uncertainty") or "").strip(),
            )
        )

    summary = str(raw.get("summary") or "").strip()
    if not summary:
        summary = f"已分析 {len(context.chapters)} 章、{len(context.plotlines)} 条已登记情节线。"
    warnings = _dedupe([*context.warnings, *_strings(raw.get("warnings"), limit=20)])
    return PlotlineAnalysisArtifact(
        scope=context.scope,
        overallScore=_score(raw.get("overallScore") if raw.get("overallScore") is not None else raw.get("score")),
        summary=summary,
        threads=threads,
        issues=issues,
        recommendations=_strings(raw.get("recommendations") or raw.get("suggestions"), limit=30),
        warnings=warnings,
        coverage=context.coverage,
    )


def plotline_analysis_markdown(analysis: PlotlineAnalysisArtifact) -> str:
    lines = ["# 情节线分析", "", analysis.summary]
    if analysis.overallScore is not None:
        lines.extend(["", f"综合评分：{analysis.overallScore}/100"])
    lines.extend(
        [
            "",
            "## 覆盖范围",
            "",
            f"- 范围：{analysis.scope}",
            f"- 已分析章节：{analysis.coverage.get('analyzedChapterCount', 0)}",
            f"- 省略章节：{analysis.coverage.get('omittedChapterCount', 0)}",
        ]
    )
    if analysis.threads:
        lines.extend(["", "## 主线与支线", ""])
        for thread in analysis.threads:
            score = f"，推进度 {thread.progressionScore}/100" if thread.progressionScore is not None else ""
            lines.append(f"### {thread.name}（{thread.role}{score}）")
            if thread.status:
                lines.append(f"状态：{thread.status}")
            lines.extend(f"- {finding}" for finding in thread.findings)
            lines.extend(f"- 建议：{item}" for item in thread.recommendations)
            if thread.uncertainty:
                lines.append(f"- 不确定性：{thread.uncertainty}")
            lines.append("")
    if analysis.issues:
        lines.extend(["## 风险与待回收项", ""])
        for issue in analysis.issues:
            lines.append(f"### [{issue.severity}] {issue.title}")
            if issue.recommendation:
                lines.append(f"建议：{issue.recommendation}")
            if issue.uncertainty:
                lines.append(f"不确定性：{issue.uncertainty}")
            lines.append("")
    if analysis.recommendations:
        lines.extend(["## 下一步建议", ""])
        lines.extend(f"- {item}" for item in analysis.recommendations)
    if analysis.warnings:
        lines.extend(["", "## 覆盖提示", ""])
        lines.extend(f"- {item}" for item in analysis.warnings)
    return "\n".join(lines).strip()


def compact_chapter(record: dict[str, Any], *, max_excerpt_chars: int = 3600) -> dict[str, Any]:
    chapter_id = str(record.get("id") or record.get("chapterId") or "")
    content = _document_text(record.get("content"))
    excerpt = _head_tail(content, max_excerpt_chars)
    return {
        "id": chapter_id,
        "volumeId": str(record.get("volumeId") or "") or None,
        "title": str(record.get("title") or ""),
        "order": record.get("order"),
        "wordCount": record.get("wordCount"),
        "excerpt": excerpt,
        "excerptTruncated": len(content) > len(excerpt),
    }


def _scope(state: dict[str, Any]) -> PlotlineAnalysisScope:
    scope = state.get("scope")
    if scope not in {"chapter", "volume", "novel"}:
        raise ToolchainError("INPUT_INVALID", "Plotline analysis scope is unresolved", node_id="scope.resolve")
    return scope


def _document_text(value: Any) -> str:
    if not isinstance(value, str):
        return str(value or "")
    stripped = value.strip()
    if not stripped.startswith(("{", "[")):
        return value
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return value
    parts: list[str] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            text = node.get("text")
            if isinstance(text, str) and text:
                parts.append(text)
            for key, child in node.items():
                if key != "text":
                    visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(parsed)
    return "\n".join(parts) if parts else value


def _head_tail(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    head = max(1, int(limit * 0.68))
    tail = max(1, limit - head - 12)
    return f"{text[:head]}\n...[省略]...\n{text[-tail:]}"


def _rag_evidence(value: Any) -> list[ContextEvidence]:
    record = _as_record(value)
    items = record.get("evidence") or record.get("sources") or record.get("citations") or []
    if not isinstance(items, list):
        items = []
    evidence = _normalize_evidence(items, None)
    answer = str(record.get("answer") or "").strip()
    if answer and not evidence:
        evidence.append(ContextEvidence(sourceType="rag", excerpt=answer[:3000]))
    return evidence


def _normalize_evidence(value: Any, valid_source_ids: set[str] | None) -> list[ContextEvidence]:
    if not isinstance(value, list):
        return []
    result: list[ContextEvidence] = []
    for item in value[:30]:
        if isinstance(item, str):
            result.append(ContextEvidence(sourceType="analysis", excerpt=item[:2000]))
            continue
        if not isinstance(item, dict):
            continue
        source_id = str(item.get("sourceId") or item.get("id") or "").strip() or None
        if valid_source_ids is not None and (not source_id or source_id not in valid_source_ids):
            continue
        result.append(
            ContextEvidence(
                sourceType=str(item.get("sourceType") or item.get("type") or "analysis"),
                sourceId=source_id,
                title=str(item.get("title") or item.get("name") or "")[:300],
                excerpt=str(item.get("excerpt") or item.get("snippet") or item.get("content") or "")[:2000],
                confidence=_confidence(item.get("confidence")),
                metadata={key: item[key] for key in ("chapterId", "volumeId", "score") if key in item},
            )
        )
    return result


def _as_record(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        for key in ("data", "chapter"):
            nested = value.get(key)
            if isinstance(nested, dict):
                return nested
        return value
    return {}


def _as_items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        for key in ("items", "data", "results", "volumes", "chapters", "points", "anchors"):
            nested = value.get(key)
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
    return []


def _pick(record: dict[str, Any], *keys: str) -> dict[str, Any]:
    picked: dict[str, Any] = {}
    for key in keys:
        value = record.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            picked[key] = value[:3000]
        else:
            picked[key] = value
    return picked


def _strings(value: Any, *, limit: int) -> list[str]:
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, list):
        values = [str(item) for item in value if isinstance(item, (str, int, float))]
    else:
        values = []
    return _dedupe(values)[:limit]


def _valid_ids(value: Any, allowed: set[str]) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(str(item) for item in value if str(item) in allowed))


def _normalize_role(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"main", "mainline", "主线", "主情节"}:
        return "main"
    if normalized in {"subplot", "sub", "支线", "副线"}:
        return "subplot"
    return "unknown"


def _severity(value: Any) -> str:
    normalized = str(value or "medium").strip().lower()
    return normalized if normalized in {"critical", "high", "medium", "low", "info"} else "medium"


def _score(value: Any) -> int | None:
    try:
        return max(0, min(100, int(float(value)))) if value is not None else None
    except (TypeError, ValueError):
        return None


def _confidence(value: Any) -> float | None:
    try:
        return max(0.0, min(1.0, float(value))) if value is not None else None
    except (TypeError, ValueError):
        return None


def _dedupe(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values if value and value.strip()))


def _bounded(value: Any, *, string_limit: int, depth: int = 0) -> Any:
    if depth >= 5:
        return str(value)[:string_limit]
    if isinstance(value, str):
        return value[:string_limit]
    if isinstance(value, list):
        return [_bounded(item, string_limit=string_limit, depth=depth + 1) for item in value[:80]]
    if isinstance(value, dict):
        return {
            str(key): _bounded(item, string_limit=string_limit, depth=depth + 1)
            for key, item in list(value.items())[:60]
        }
    return value
