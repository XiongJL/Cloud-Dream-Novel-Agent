from __future__ import annotations

from typing import Any

from .schemas import (
    ChapterScopeBundle,
    ContextEvidence,
    ScopeAuditArtifact,
    ScopeAuditConflict,
    ScopeAuditExpertRef,
    ScopeAuditFinding,
)


def scope_audit_request(
    goal: str,
    locale: str,
    child_reports: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "goal": goal,
        "locale": locale,
        "childReports": child_reports,
    }


def normalize_scope_audit(
    value: Any,
    bundle: ChapterScopeBundle,
    child_reports: list[dict[str, Any]],
    expert_refs: list[ScopeAuditExpertRef],
) -> ScopeAuditArtifact:
    audit = ScopeAuditArtifact.model_validate(value)
    target_chapter_ids = set(bundle.scope.chapterIds)
    executed_experts = {item.expert for item in expert_refs}
    source_findings: dict[str, tuple[str, dict[str, Any]]] = {}
    allowed_source_ids: set[str] = set()
    for report in child_reports:
        expert = str(report.get("expert") or "")
        if expert not in executed_experts:
            continue
        for finding in report.get("findings") or []:
            if not isinstance(finding, dict):
                continue
            finding_id = str(finding.get("findingId") or "")
            if finding_id:
                source_findings[finding_id] = (expert, finding)
            allowed_source_ids.update(str(item) for item in (finding.get("evidenceRefs") or []) if item)
            for evidence in finding.get("evidence") or []:
                if isinstance(evidence, dict) and evidence.get("sourceId"):
                    allowed_source_ids.add(str(evidence["sourceId"]))

    dropped_findings = 0
    dropped_sources = 0
    unique: dict[tuple[str, str, tuple[str, ...]], ScopeAuditFinding] = {}
    for finding in audit.findings:
        source_ids = list(dict.fromkeys(
            source_id for source_id in finding.sourceFindingIds if source_id in source_findings
        ))
        dropped_sources += len(finding.sourceFindingIds) - len(source_ids)
        if not source_ids:
            dropped_findings += 1
            continue
        source_experts = list(dict.fromkeys(source_findings[source_id][0] for source_id in source_ids))
        chapter_ids = list(dict.fromkeys(
            chapter_id for chapter_id in finding.chapterIds if chapter_id in target_chapter_ids
        ))
        evidence = _valid_evidence(finding.evidence, allowed_source_ids)
        evidence_refs = list(dict.fromkeys(
            source_id for source_id in finding.evidenceRefs if source_id in allowed_source_ids
        ))
        dropped_sources += len(finding.evidence) - len(evidence)
        dropped_sources += len(finding.evidenceRefs) - len(evidence_refs)
        for item in evidence:
            if item.sourceId and item.sourceId not in evidence_refs:
                evidence_refs.append(item.sourceId)
        relationship = "single" if len(source_experts) == 1 else finding.relationship
        normalized = finding.model_copy(update={
            "sourceFindingIds": source_ids,
            "sourceExperts": source_experts,
            "chapterIds": chapter_ids,
            "relationship": relationship,
            "evidence": evidence,
            "evidenceRefs": evidence_refs,
        })
        key = (
            normalized.category.strip().lower(),
            normalized.title.strip().lower(),
            tuple(normalized.chapterIds),
        )
        existing = unique.get(key)
        if existing is None or _severity_rank(normalized.severity) > _severity_rank(existing.severity):
            unique[key] = normalized

    conflicts: list[ScopeAuditConflict] = []
    for conflict in audit.conflicts:
        source_ids = list(dict.fromkeys(
            source_id for source_id in conflict.sourceFindingIds if source_id in source_findings
        ))
        dropped_sources += len(conflict.sourceFindingIds) - len(source_ids)
        experts = list(dict.fromkeys(source_findings[source_id][0] for source_id in source_ids))
        if len(experts) < 2:
            continue
        conflicts.append(conflict.model_copy(update={"sourceFindingIds": source_ids, "experts": experts}))

    warnings = list(dict.fromkeys([*bundle.warnings, *audit.warnings]))
    requested_experts = set(audit_item for item in audit.findings for audit_item in item.sourceExperts)
    unexecuted = requested_experts - executed_experts
    if unexecuted:
        warnings.append(f"已移除未执行专家引用：{'、'.join(sorted(unexecuted))}。")
    if dropped_findings:
        warnings.append(f"已移除 {dropped_findings} 条没有真实子报告来源的综合结论。")
    if dropped_sources:
        warnings.append(f"已移除 {dropped_sources} 个无法关联到真实子报告的 finding 或证据引用。")
    return audit.model_copy(update={
        "experts": expert_refs,
        "findings": list(unique.values()),
        "conflicts": conflicts,
        "warnings": warnings,
        "coverage": bundle.coverage,
    })


def scope_audit_markdown(audit: ScopeAuditArtifact) -> str:
    lines = ["# 团队多章节综合审计", "", audit.summary.strip()]
    if audit.experts:
        lines.extend(["", "## 已执行专家", ""])
        for item in audit.experts:
            lines.append(f"- **{item.expert}**：{item.findingCount} 条 finding，Artifact `{item.artifactId}`")
    if audit.findings:
        lines.extend(["", "## 综合结论", ""])
        for index, finding in enumerate(audit.findings, start=1):
            lines.append(f"### {index}. [{finding.severity.upper()}] {finding.title}")
            lines.append(f"- 专家：{'、'.join(finding.sourceExperts)}")
            lines.append(f"- 关系：{finding.relationship}")
            if finding.chapterIds:
                lines.append(f"- 章节：{'、'.join(finding.chapterIds)}")
            lines.append(f"- 判断：{finding.summary}")
            if finding.recommendation:
                lines.append(f"- 建议：{finding.recommendation}")
            lines.append("")
    if audit.conflicts:
        lines.extend(["## 专家分歧", ""])
        for item in audit.conflicts:
            lines.append(f"- **{item.topic}**（{'、'.join(item.experts)}）：{item.summary} {item.resolution}".strip())
    if audit.recommendations:
        lines.extend(["", "## 优先建议", "", *[f"- {item}" for item in audit.recommendations]])
    if audit.warnings:
        lines.extend(["", "## 覆盖与来源警告", "", *[f"- {item}" for item in audit.warnings]])
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
