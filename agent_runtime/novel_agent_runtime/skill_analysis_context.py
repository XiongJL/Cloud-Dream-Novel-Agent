"""Evidence-preserving projections for the original business expert nodes."""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from .skill_analysis_graph import canonical, fingerprint
from .toolchains.schemas import AgentChapterSnapshot, ChapterScopeBundle, ContextEvidence, ToolchainError


def attach_analysis(bundle: ChapterScopeBundle, analyzed: dict[str, Any]) -> ChapterScopeBundle:
    result = bundle.model_copy(deep=True)
    snapshots = analyzed["sourceSnapshot"]
    result.sourceSnapshot = [AgentChapterSnapshot.model_validate(item) for item in snapshots]
    result.scope.snapshot = result.sourceSnapshot
    by_id = {item["chapterId"]: item for item in snapshots}
    if analyzed["coverage"].get("mode") == "user_completed_results":
        # Subsequent RAG and expert nodes must stay within the adjusted scope.
        result.chapters = [chapter for chapter in result.chapters if chapter.chapterId in by_id]
        result.scope.kind = "selected_chapters"
        result.scope.chapterIds = [chapter.chapterId for chapter in result.chapters]
        result.scope.anchorChapterId = result.scope.chapterIds[0] if result.scope.chapterIds else None
        result.coverage.contextChapterCount = len(result.chapters)
        result.coverage.readonlyChapterCount = 0
        result.coverage.omittedChapterCount = analyzed["coverage"]["omittedChapterCount"]
        result.coverage.batches = []
        result.coverage.batchCount = 0
        result.narrativeSummaries = [item for item in result.narrativeSummaries if item.get("chapterId") in by_id]
        result.evidence = [item for item in result.evidence if item.sourceType != "chapter" or item.sourceId in by_id]
    for chapter in result.chapters:
        if chapter.chapterId in by_id:
            chapter.content = ""
            chapter.contentMode = "catalog"
            chapter.contentHash = by_id[chapter.chapterId]["contentHash"]
    result.coverage.detailedChapterCount = 0
    result.coverage.excerptChapterCount = 0
    result.coverage.summarizedChapterCount = 0
    result.coverage.analyzedChapterCount = analyzed["coverage"]["analyzedChapterCount"]
    result.coverage.expertReviewedChapterCount = 0
    result.coverage.expertReviewMode = "analysis_evidence"
    result.skillAnalysis = {"version": 2, "analysisRef": analyzed["analysisRef"],
        "summary": analyzed["analysis"]["summary"], "unitRefs": analyzed["unitRefs"], "candidates": [],
        "executionPolicy": analyzed["executionPolicy"],
        "coverage": analyzed["coverage"],
        "pageIndex": 0, "pageCount": 0}
    result.warnings = list(dict.fromkeys([*result.warnings, *analyzed.get("warnings", []),
        "专家依据已分析材料和核验短证据审核；未在该阶段复读全部原文，跨章推断仍需相应证据。"] ))
    return result


def expert_pages(bundle: ChapterScopeBundle, units: list[tuple[str, dict[str, Any]]], maximum_bytes: int) -> list[ChapterScopeBundle]:
    """Pack every leaf candidate, never replacing the ledger with eight root findings."""
    candidates = []
    for ref, result in units:
        for index, finding in enumerate(result.get("findings", [])):
            candidates.append({"findingRef": f"{ref}:{index}", "chapterIds": result.get("chapterIds", []), **finding})
        if not result.get("findings"):
            candidates.append({"findingRef": f"{ref}:summary", "dimension": "method", "observation": result["summary"],
                "confidence": "low", "evidence": [], "chapterIds": result.get("chapterIds", [])})

    def make(items: list[dict[str, Any]]) -> ChapterScopeBundle:
        page = bundle.model_copy(deep=True)
        ids = {item["sourceId"] for finding in items for item in finding.get("evidence", [])}
        ids.update(chapter for finding in items for chapter in finding.get("chapterIds", []))
        if not ids:
            # Units without findings still have an explicit chapter coverage entry.
            ids = set(bundle.scope.chapterIds)
        page.chapters = [item for item in page.chapters if item.chapterId in ids]
        page.sourceSnapshot = [item for item in page.sourceSnapshot if item.chapterId in ids]
        page.scope.snapshot = page.sourceSnapshot
        page.scope.chapterIds = [item for item in bundle.scope.chapterIds if item in ids]
        page.scope.anchorChapterId = page.scope.chapterIds[0] if page.scope.chapterIds else None
        page.coverage.batches = []
        page.coverage.contextChapterCount = len(page.chapters)
        page.skillAnalysis = {**(page.skillAnalysis or {}), "unitRefs": [], "candidates": items,
            "summary": (page.skillAnalysis or {}).get("summary", "")[:300]}
        seen = {(item.sourceId, item.excerpt) for item in page.evidence}
        for finding in items:
            for item in finding.get("evidence", []):
                if (item["sourceId"], item["excerpt"]) not in seen:
                    page.evidence.append(ContextEvidence(sourceType="chapter", sourceId=item["sourceId"], excerpt=item["excerpt"],
                        metadata={key: value for key, value in item.items() if key not in {"sourceId", "excerpt"}}))
                    seen.add((item["sourceId"], item["excerpt"]))
        page.estimatedTokens = 0
        return page

    pages, pending = [], []
    for finding in candidates:
        proposed = make([*pending, finding])
        if len(pending) >= 16 or len(canonical(proposed.model_dump(exclude_none=True)).encode("utf-8")) + 128 > maximum_bytes:
            if not pending:
                raise ToolchainError("BUDGET_EXCEEDED", "专家窗口无法容纳一个完整发现及必需项目资料，已保存分析结果。")
            pages.append(make(pending))
            pending = [finding]
            if len(canonical(make(pending).model_dump(exclude_none=True)).encode("utf-8")) > maximum_bytes:
                raise ToolchainError("BUDGET_EXCEEDED", "专家窗口无法容纳一个完整发现及必需项目资料，已保存分析结果。")
        else:
            pending.append(finding)
    if pending:
        pages.append(make(pending))
    if not pages:
        pages.append(make([]))
    for index, page in enumerate(pages):
        page.skillAnalysis.update(pageIndex=index, pageCount=len(pages))
        page.coverage.expertReviewedChapterCount = len(page.scope.chapterIds)
        if len(canonical(page.model_dump(exclude_none=True)).encode("utf-8")) > maximum_bytes:
            raise ToolchainError("BUDGET_EXCEEDED", "专家页的最终序列化结果超过窗口。")
    return pages


def verify_expert_evidence(value: Any, bundle: ChapterScopeBundle) -> Any:
    """Keep the existing business normalizers, adding quote verification only for adaptive inputs."""
    if not bundle.skillAnalysis or not isinstance(value, dict):
        return value
    result = deepcopy(value)
    expected = {item["findingRef"] for item in bundle.skillAnalysis.get("candidates", [])}
    decisions = result.get("candidateDecisions", [])
    reviewed = {item.get("findingRef") for item in decisions if isinstance(item, dict)
                and item.get("status") in {"confirmed", "dismissed", "unresolved"} and str(item.get("reason", "")).strip()}
    if expected - reviewed:
        raise ToolchainError("MODEL_OUTPUT_INVALID", "专家未逐项审核本页发现，不能声明审核完成。", retryable=True)
    result["candidateDecisions"] = [item for item in decisions if item.get("findingRef") in expected]
    known = {(item.sourceId, item.excerpt): item for item in bundle.evidence}
    dropped = 0
    for finding in [*result.get("findings", []), *result.get("entityAssessments", [])]:
        finding["chapterIds"] = [chapter for chapter in finding.get("chapterIds", []) if chapter in bundle.scope.chapterIds]
        valid = []
        unverified_quote = False
        for evidence in finding.get("evidence", []):
            source_id, quote = evidence.get("sourceId"), str(evidence.get("excerpt") or "")
            matches = [item for (source, excerpt), item in known.items() if source == source_id and quote and quote in excerpt]
            if matches:
                matched = matches[0]
                metadata = {**evidence.get("metadata", {}), **matched.metadata}
                if isinstance(metadata.get("startOffset"), int):
                    metadata["startOffset"] += matched.excerpt.find(quote)
                    metadata["endOffset"] = metadata["startOffset"] + len(quote)
                valid.append({**evidence, "metadata": metadata})
            else:
                dropped += 1
                unverified_quote = True
        finding["evidence"] = valid
        # IDs alone cannot vouch for a fabricated quote.
        allowed_refs = {item.sourceId for item in bundle.evidence}
        finding["evidenceRefs"] = [ref for ref in finding.get("evidenceRefs", []) if ref in allowed_refs]
        if not valid and (unverified_quote or not finding.get("evidenceRefs")):
            finding["uncertainty"] = finding.get("uncertainty") or "当前专家输入未提供可核验短证据。"
    if dropped:
        result["warnings"] = [*result.get("warnings", []), f"已移除 {dropped} 条未匹配获准证据的专家引文。"]
    return result


def combine_expert_pages(reviews: list[dict[str, Any]]) -> dict[str, Any]:
    combined = deepcopy(reviews[0])
    for key in ("findings", "entityAssessments", "recommendations", "warnings", "rewriteOrder", "candidateDecisions"):
        if any(key in item for item in reviews):
            values, seen = [], {}
            for review in reviews:
                for item in review.get(key, []):
                    identity = fingerprint([item.get("category"), item.get("title"), sorted(item.get("chapterIds", []))]) if key == "findings" else fingerprint(item)
                    if identity not in seen:
                        seen[identity] = len(values)
                        if key == "findings":
                            item = {**item, "findingId": "finding_" + identity[:24]}
                        values.append(item)
                    elif key == "findings":
                        previous = values[seen[identity]]
                        rank = {"critical": 5, "high": 4, "medium": 3, "low": 2, "info": 1}
                        selected = item if rank.get(item.get("severity"), 0) > rank.get(previous.get("severity"), 0) else previous
                        merged = {**selected, "findingId": previous["findingId"]}
                        merged["evidenceRefs"] = list(dict.fromkeys([*previous.get("evidenceRefs", []), *item.get("evidenceRefs", [])]))
                        evidence = {fingerprint(value): value for value in [*previous.get("evidence", []), *item.get("evidence", [])]}
                        merged["evidence"] = list(evidence.values())
                        values[seen[identity]] = merged
            combined[key] = values
    if len(reviews) > 1:
        # Do not pretend a page score is a validated global score.
        for key in ("overallScore", "consistencyScore"):
            if key in combined:
                combined[key] = None
        combined["summary"] = f"专家已完成 {len(reviews)} 页材料审核。" + combined["summary"]
        combined["warnings"] = [*combined.get("warnings", []), "分页结论已保留；局部分数不合成为全书整体评分。"]
        combined["dimensions"] = [{**item, "score": None, "checkable": False,
            "reason": "已按页审核；跨页维度未获得独立全局评分。"} for item in combined.get("dimensions", [])]
    return combined
