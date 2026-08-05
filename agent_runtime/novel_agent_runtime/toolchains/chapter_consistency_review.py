from __future__ import annotations

from typing import Any

from .schemas import ContextBundle, ReviewArtifact, ReviewIssue


def review_request(
    goal: str,
    locale: str,
    context: ContextBundle,
    dimensions: list[str],
    agent_skill: dict[str, Any] | None = None,
) -> dict[str, Any]:
    request = {
        "goal": goal,
        "locale": locale,
        "dimensions": dimensions,
        "contextBundle": context.model_dump(),
    }
    if agent_skill:
        request["agentSkill"] = agent_skill
    return request


def normalize_review(value: Any, context: ContextBundle) -> ReviewArtifact:
    review = ReviewArtifact.model_validate(value)
    unique: dict[tuple[str, str, str], ReviewIssue] = {}
    for issue in review.issues:
        key = (
            issue.type.strip().lower(),
            issue.title.strip().lower(),
            issue.location.strip().lower(),
        )
        existing = unique.get(key)
        if existing is None or _severity_rank(issue.severity) > _severity_rank(existing.severity):
            unique[key] = issue
    return review.model_copy(
        update={
            "issues": list(unique.values()),
            "warnings": list(dict.fromkeys([*context.warnings, *review.warnings])),
            "contextStats": {
                "toolCallCount": context.toolCallCount,
                "estimatedTokens": context.estimatedTokens,
                "evidenceCount": len(context.evidence),
                "omitted": [item.model_dump() for item in context.omitted],
            },
        }
    )


def review_markdown(review: ReviewArtifact) -> str:
    score = "无法评分" if review.overallScore is None else f"{review.overallScore}/100"
    lines = [f"# 章节一致性审核", "", f"**总分：{score}**", "", review.summary.strip()]
    if review.dimensions:
        lines.extend(["", "## 维度评分", ""])
        for dimension in review.dimensions:
            value = "不可检查" if not dimension.checkable or dimension.score is None else f"{dimension.score}/100"
            suffix = f"：{dimension.reason}" if dimension.reason else ""
            lines.append(f"- **{dimension.label}** {value}{suffix}")
    if review.issues:
        lines.extend(["", "## 问题清单", ""])
        for index, issue in enumerate(review.issues, start=1):
            lines.append(f"### {index}. [{issue.severity.upper()}] {issue.title}")
            if issue.location:
                lines.append(f"- 位置：{issue.location}")
            if issue.excerpt:
                lines.append(f"- 章节引用：{issue.excerpt}")
            if issue.evidence:
                evidence = "；".join(item.title or item.excerpt for item in issue.evidence[:3] if item.title or item.excerpt)
                if evidence:
                    lines.append(f"- 项目证据：{evidence}")
            if issue.recommendation:
                lines.append(f"- 修改建议：{issue.recommendation}")
            if issue.uncertainty:
                lines.append(f"- 不确定性：{issue.uncertainty}")
            lines.append("")
    if review.uncheckableDimensions:
        lines.extend(["## 无法检查", ""])
        for item in review.uncheckableDimensions:
            lines.append(f"- {item.get('dimension', '未命名维度')}：{item.get('reason', '资料不足')}")
    if review.warnings:
        lines.extend(["", "## 资料警告", "", *[f"- {warning}" for warning in review.warnings]])
    return "\n".join(lines).strip()


def _severity_rank(value: str) -> int:
    return {"critical": 5, "high": 4, "medium": 3, "low": 2, "info": 1}.get(value, 0)
