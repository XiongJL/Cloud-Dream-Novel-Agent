from __future__ import annotations

from statistics import mean
from typing import Any

from .schemas import (
    ChapterScopeBundle,
    ChapterScopeContextItem,
    ReaderChapterEvaluation,
    ReaderJourneyArtifact,
)


def reader_chapter_request(
    locale: str,
    chapter: ChapterScopeContextItem,
    prior_reader_state: str,
    chapter_index: int,
    chapter_count: int,
) -> dict[str, Any]:
    return {
        "locale": locale,
        "chapter": {
            "chapterId": chapter.chapterId,
            "title": chapter.title,
            "contentMode": chapter.contentMode,
            "content": chapter.content,
        },
        "priorReaderState": prior_reader_state[:2000],
        "position": {"index": chapter_index + 1, "count": chapter_count},
    }


def normalize_reader_chapter_evaluation(
    value: Any,
    chapter: ChapterScopeContextItem,
) -> ReaderChapterEvaluation:
    evaluation = ReaderChapterEvaluation.model_validate(value)
    dropped_refs = 0
    normalized_findings = []
    for finding_index, finding in enumerate(evaluation.findings, start=1):
        chapter_ids = [chapter.chapterId] if chapter.chapterId in finding.chapterIds else []
        dropped_refs += len(finding.chapterIds) - len(chapter_ids)
        evidence = [
            item for item in finding.evidence
            if item.sourceType == "chapter" and item.sourceId == chapter.chapterId
        ]
        evidence_refs = [chapter.chapterId] if chapter.chapterId in finding.evidenceRefs else []
        dropped_refs += len(finding.evidence) - len(evidence)
        dropped_refs += len(finding.evidenceRefs) - len(evidence_refs)
        normalized_findings.append(finding.model_copy(update={
            "findingId": f"reader:{chapter.chapterId}:{finding_index}:{finding.findingId.strip()}",
            "chapterIds": chapter_ids,
            "evidence": evidence,
            "evidenceRefs": evidence_refs,
            "uncertainty": finding.uncertainty or (
                "逐章盲读请求中没有可核验的当前章证据，需人工确认。"
                if not evidence and not evidence_refs
                else ""
            ),
        }))
    warnings = list(evaluation.warnings)
    if dropped_refs:
        warnings.append(f"已移除 {dropped_refs} 个非当前章引用。")
    return evaluation.model_copy(update={
        "chapterId": chapter.chapterId,
        "chapterTitle": chapter.title,
        "readerStateSummary": evaluation.readerStateSummary.strip(),
        "findings": normalized_findings,
        "warnings": warnings,
    })


def build_reader_journey_artifact(
    evaluations: list[ReaderChapterEvaluation],
    bundle: ChapterScopeBundle,
) -> ReaderJourneyArtifact:
    retention_scores = [item.retentionScore for item in evaluations]
    overall = round(mean(retention_scores)) if retention_scores else None
    high_risk = [item for item in evaluations if item.dropRisk == "high"]
    findings = [finding for item in evaluations for finding in item.findings]
    trends: list[str] = []
    if len(evaluations) >= 2:
        delta = evaluations[-1].retentionScore - evaluations[0].retentionScore
        if delta > 5:
            trends.append(f"追更动力较首章提升 {delta} 分。")
        elif delta < -5:
            trends.append(f"追更动力较首章下降 {abs(delta)} 分。")
        else:
            trends.append("追更动力整体平稳。")
    if high_risk:
        trends.append(f"{len(high_risk)} 章出现高弃读风险。")
    if evaluations:
        strongest = max(evaluations, key=lambda item: item.retentionScore)
        weakest = min(evaluations, key=lambda item: item.retentionScore)
        trends.append(f"追更动力最高为《{strongest.chapterTitle}》，最低为《{weakest.chapterTitle}》。")
    warnings = [*bundle.warnings, *(warning for item in evaluations for warning in item.warnings)]
    summarized = [
        item.title for item in bundle.chapters
        if item.target and item.contentMode in {"summary", "excerpt"}
    ]
    if summarized:
        warnings.append(f"{len(summarized)} 章仅以摘要或摘录评估，读者体验结论可信度受限。")
    summary = (
        f"已按严格顺序盲读 {len(evaluations)} 章，平均追更动力 {overall}/100；"
        f"高弃读风险章节 {len(high_risk)} 个。"
        if evaluations and overall is not None
        else "当前范围没有可供逐章盲读的目标章节。"
    )
    return ReaderJourneyArtifact(
        overallRetentionScore=overall,
        summary=summary,
        chapters=evaluations,
        findings=findings,
        trends=trends,
        warnings=list(dict.fromkeys(warnings)),
        coverage=bundle.coverage,
    )


def reader_journey_markdown(journey: ReaderJourneyArtifact) -> str:
    score = "无法评分" if journey.overallRetentionScore is None else f"{journey.overallRetentionScore}/100"
    lines = ["# 读者多章节旅程报告", "", f"**整体追更动力：{score}**", "", journey.summary]
    if journey.trends:
        lines.extend(["", "## 总体趋势", "", *[f"- {item}" for item in journey.trends]])
    for index, chapter in enumerate(journey.chapters, start=1):
        lines.extend([
            "",
            f"## {index}. {chapter.chapterTitle}",
            "",
            f"- 理解清晰度：{chapter.clarityScore}/100",
            f"- 情绪强度：{chapter.emotionalIntensity}/100",
            f"- 悬念强度：{chapter.suspenseScore}/100",
            f"- 追更动力：{chapter.retentionScore}/100",
            f"- 弃读风险：{chapter.dropRisk}",
            f"- 主导情绪：{chapter.dominantEmotion or '未识别'}",
            f"- 阅读反馈：{chapter.summary}",
        ])
        if chapter.confusionPoints:
            lines.append(f"- 困惑点：{'；'.join(chapter.confusionPoints)}")
        if chapter.effectiveHooks:
            lines.append(f"- 有效钩子：{'；'.join(chapter.effectiveHooks)}")
        if chapter.immersionBreaks:
            lines.append(f"- 出戏点：{'；'.join(chapter.immersionBreaks)}")
        if chapter.expectations:
            lines.append(f"- 后续期待：{'；'.join(chapter.expectations)}")
    if journey.findings:
        lines.extend(["", "## 可审批问题", ""])
        for finding in journey.findings:
            lines.append(f"- **[{finding.severity.upper()}] {finding.title}**：{finding.summary}")
    if journey.warnings:
        lines.extend(["", "## 覆盖警告", "", *[f"- {item}" for item in journey.warnings]])
    return "\n".join(lines).strip()
