from __future__ import annotations

from typing import Any

from .schemas import (
    ChapterScopeBundle,
    ContextEvidence,
    EditorRangeFinding,
    WriterRangeRevisionPlanArtifact,
)


def writer_range_revision_plan_request(
    goal: str,
    locale: str,
    bundle: ChapterScopeBundle,
    dimensions: list[str],
) -> dict[str, Any]:
    return {
        "goal": goal,
        "locale": locale,
        "dimensions": dimensions,
        "scopeBundle": bundle.model_dump(),
    }


def normalize_writer_range_revision_plan(
    value: Any,
    bundle: ChapterScopeBundle,
) -> WriterRangeRevisionPlanArtifact:
    plan = WriterRangeRevisionPlanArtifact.model_validate(value)
    target_chapter_ids = set(bundle.scope.chapterIds)
    allowed_source_ids = {
        *(chapter.chapterId for chapter in bundle.chapters),
        *(item.sourceId for item in bundle.evidence if item.sourceId),
        *(item.get("id") for values in bundle.entityContext.values() for item in values if item.get("id")),
        *(item.get("id") for values in bundle.plotContext.values() for item in values if item.get("id")),
        *(item.get("id") for item in bundle.narrativeSummaries if item.get("id")),
    }
    dropped_chapter_refs = 0
    dropped_evidence_refs = 0
    unique: dict[tuple[str, str, tuple[str, ...]], EditorRangeFinding] = {}
    for finding in plan.findings:
        chapter_ids = list(dict.fromkeys(
            chapter_id for chapter_id in finding.chapterIds if chapter_id in target_chapter_ids
        ))
        dropped_chapter_refs += len(finding.chapterIds) - len(chapter_ids)
        evidence = _valid_evidence(finding.evidence, allowed_source_ids)
        evidence_refs = list(dict.fromkeys(
            source_id for source_id in finding.evidenceRefs if source_id in allowed_source_ids
        ))
        dropped_evidence_refs += len(finding.evidence) - len(evidence)
        dropped_evidence_refs += len(finding.evidenceRefs) - len(evidence_refs)
        for item in evidence:
            if item.sourceId and item.sourceId not in evidence_refs:
                evidence_refs.append(item.sourceId)
        normalized = finding.model_copy(update={
            "chapterIds": chapter_ids,
            "evidence": evidence,
            "evidenceRefs": evidence_refs,
            "uncertainty": finding.uncertainty or (
                "模型返回的证据不在批准范围或实际检索结果中，需人工确认。"
                if not evidence and not evidence_refs
                else ""
            ),
        })
        key = (
            normalized.category.strip().lower(),
            normalized.title.strip().lower(),
            tuple(normalized.chapterIds),
        )
        existing = unique.get(key)
        if existing is None or _severity_rank(normalized.severity) > _severity_rank(existing.severity):
            unique[key] = normalized

    rewrite_order = list(dict.fromkeys(
        chapter_id for chapter_id in plan.rewriteOrder if chapter_id in target_chapter_ids
    ))
    dropped_chapter_refs += len(plan.rewriteOrder) - len(rewrite_order)
    warnings = list(dict.fromkeys([*bundle.warnings, *plan.warnings]))
    if dropped_chapter_refs:
        warnings.append(f"已移除 {dropped_chapter_refs} 个不属于批准目标范围的章节引用。")
    if dropped_evidence_refs:
        warnings.append(f"已移除 {dropped_evidence_refs} 个无法在范围上下文或检索结果中核验的证据引用。")
    return plan.model_copy(update={
        "findings": list(unique.values()),
        "rewriteOrder": rewrite_order,
        "warnings": warnings,
        "coverage": bundle.coverage,
    })


def writer_range_revision_plan_markdown(plan: WriterRangeRevisionPlanArtifact) -> str:
    score = "无法评分" if plan.overallScore is None else f"{plan.overallScore}/100"
    lines = ["# 作者多章节修订计划", "", f"**修订准备度：{score}**", "", plan.summary.strip()]
    if plan.dimensions:
        lines.extend(["", "## 维度评估", ""])
        for dimension in plan.dimensions:
            value = "不可检查" if not dimension.checkable or dimension.score is None else f"{dimension.score}/100"
            suffix = f"：{dimension.reason}" if dimension.reason else ""
            lines.append(f"- **{dimension.label}** {value}{suffix}")
    if plan.rewriteOrder:
        lines.extend(["", "## 建议改写顺序", "", *[
            f"{index}. {chapter_id}" for index, chapter_id in enumerate(plan.rewriteOrder, start=1)
        ]])
    if plan.continuationReadiness:
        lines.extend(["", "## 续写准备", "", plan.continuationReadiness])
    if plan.findings:
        lines.extend(["", "## 修订项", ""])
        for index, finding in enumerate(plan.findings, start=1):
            lines.append(f"### {index}. [{finding.severity.upper()}] {finding.title}")
            lines.append(f"- 分类：{finding.category}")
            if finding.chapterIds:
                lines.append(f"- 章节：{'、'.join(finding.chapterIds)}")
            lines.append(f"- 判断：{finding.summary}")
            if finding.recommendation:
                lines.append(f"- 修订建议：{finding.recommendation}")
            if finding.uncertainty:
                lines.append(f"- 不确定性：{finding.uncertainty}")
            lines.append("")
    if plan.recommendations:
        lines.extend(["## 总体建议", "", *[f"- {item}" for item in plan.recommendations]])
    if plan.warnings:
        lines.extend(["", "## 资料与覆盖警告", "", *[f"- {item}" for item in plan.warnings]])
    return "\n".join(lines).strip()


def _valid_evidence(evidence: list[ContextEvidence], allowed_source_ids: set[str]) -> list[ContextEvidence]:
    unique: dict[tuple[str, str, str], ContextEvidence] = {}
    for item in evidence:
        if not item.sourceId or item.sourceId not in allowed_source_ids:
            continue
        unique.setdefault((item.sourceType, item.sourceId, item.excerpt), item)
    return list(unique.values())


def _severity_rank(value: str) -> int:
    return {"critical": 5, "high": 4, "medium": 3, "low": 2, "info": 1}.get(value, 0)
