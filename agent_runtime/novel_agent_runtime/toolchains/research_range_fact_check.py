from __future__ import annotations

from typing import Any

from .schemas import (
    ChapterScopeBundle,
    ContextEvidence,
    ResearchClaimExtraction,
    ResearchExtractedClaim,
    ResearchFactCheckArtifact,
    ResearchFactCheckFinding,
)


def research_claim_extraction_request(
    goal: str,
    locale: str,
    bundle: ChapterScopeBundle,
    max_claims: int,
) -> dict[str, Any]:
    return {
        "goal": goal,
        "locale": locale,
        "maxClaims": max_claims,
        "scopeBundle": bundle.model_dump(),
    }


def normalize_research_claims(
    value: Any,
    bundle: ChapterScopeBundle,
    max_claims: int,
) -> ResearchClaimExtraction:
    extraction = ResearchClaimExtraction.model_validate(value)
    target_ids = set(bundle.scope.chapterIds)
    known: set[tuple[str, str]] = set()
    claims: list[ResearchExtractedClaim] = []
    dropped = 0
    for claim in extraction.claims:
        if claim.chapterId not in target_ids:
            dropped += 1
            continue
        key = (claim.chapterId, claim.statement.strip().lower())
        if key in known:
            continue
        known.add(key)
        keyword = claim.searchKeyword.strip() or _fallback_keyword(claim.statement)
        claims.append(claim.model_copy(update={
            "statement": claim.statement.strip(),
            "excerpt": claim.excerpt.strip(),
            "searchKeyword": keyword,
        }))
        if len(claims) >= max_claims:
            break
    warnings = list(extraction.warnings)
    if dropped:
        warnings.append(f"已移除 {dropped} 条不属于批准目标范围的声明。")
    return extraction.model_copy(update={"claims": claims, "warnings": list(dict.fromkeys(warnings))})


def research_search_params(novel_id: str, claim: ResearchExtractedClaim) -> dict[str, Any]:
    return {
        "novelId": novel_id,
        "keyword": claim.searchKeyword,
        "limit": 12,
        "offset": 0,
    }


def research_search_evidence(
    claim: ResearchExtractedClaim,
    value: Any,
) -> list[ContextEvidence]:
    rows = value if isinstance(value, list) else (
        value.get("items") or value.get("results") or []
        if isinstance(value, dict)
        else []
    )
    evidence: list[ContextEvidence] = []
    for item in rows[:12] if isinstance(rows, list) else []:
        if not isinstance(item, dict):
            continue
        source_id = str(item.get("chapterId") or item.get("entityId") or item.get("id") or "").strip()
        if not source_id:
            continue
        excerpt = str(item.get("snippet") or item.get("preview") or item.get("excerpt") or "").strip()
        evidence.append(ContextEvidence(
            sourceType="project_search",
            sourceId=source_id,
            title=str(item.get("title") or claim.searchKeyword)[:300],
            excerpt=excerpt[:2000],
            confidence=None,
            metadata={
                "claimId": claim.claimId,
                "keyword": claim.searchKeyword,
                **({"volumeId": item.get("volumeId")} if item.get("volumeId") else {}),
                **({"matchType": item.get("matchType")} if item.get("matchType") else {}),
            },
        ))
    unique: dict[tuple[str, str], ContextEvidence] = {}
    for item in evidence:
        unique.setdefault((item.sourceId or "", item.excerpt), item)
    return list(unique.values())


def research_fact_check_request(
    goal: str,
    locale: str,
    bundle: ChapterScopeBundle,
    claims: list[ResearchExtractedClaim],
    search_evidence: dict[str, list[ContextEvidence]],
) -> dict[str, Any]:
    return {
        "goal": goal,
        "locale": locale,
        "scopeBundle": bundle.model_dump(),
        "claims": [item.model_dump() for item in claims],
        "projectSearchEvidence": {
            claim_id: [item.model_dump() for item in evidence]
            for claim_id, evidence in search_evidence.items()
        },
        "externalSearchAvailable": False,
    }


def normalize_research_fact_check(
    value: Any,
    bundle: ChapterScopeBundle,
    claims: list[ResearchExtractedClaim],
    search_evidence: dict[str, list[ContextEvidence]],
    extraction_warnings: list[str],
) -> ResearchFactCheckArtifact:
    # Search statistics are derived below from the actual project-search
    # results. Ignore model-supplied values before validation: a model may
    # include lists or prose here even when its findings are otherwise valid.
    report_input = {**value, "searchStats": {}} if isinstance(value, dict) else value
    report = ResearchFactCheckArtifact.model_validate(report_input)
    claim_by_id = {claim.claimId: claim for claim in claims}
    bundle_source_ids = {
        *(chapter.chapterId for chapter in bundle.chapters),
        *(item.sourceId for item in bundle.evidence if item.sourceId),
        *(str(item.get("id")) for values in bundle.entityContext.values() for item in values if item.get("id")),
        *(str(item.get("id")) for values in bundle.plotContext.values() for item in values if item.get("id")),
        *(str(item.get("id")) for item in bundle.narrativeSummaries if item.get("id")),
    }
    search_source_ids = {
        item.sourceId
        for evidence in search_evidence.values()
        for item in evidence
        if item.sourceId
    }
    allowed_source_ids = {*bundle_source_ids, *search_source_ids}
    dropped_findings = 0
    dropped_evidence = 0
    normalized_findings: list[ResearchFactCheckFinding] = []
    seen_claims: set[str] = set()
    for finding in report.findings:
        claim = claim_by_id.get(finding.claimId)
        if claim is None or finding.claimId in seen_claims:
            dropped_findings += 1
            continue
        seen_claims.add(finding.claimId)
        evidence = _valid_evidence(finding.evidence, allowed_source_ids)
        evidence_refs = list(dict.fromkeys(
            source_id for source_id in finding.evidenceRefs if source_id in allowed_source_ids
        ))
        dropped_evidence += len(finding.evidence) - len(evidence)
        dropped_evidence += len(finding.evidenceRefs) - len(evidence_refs)
        for item in evidence:
            if item.sourceId and item.sourceId not in evidence_refs:
                evidence_refs.append(item.sourceId)
        verdict = finding.verdict
        confidence = finding.confidence
        uncertainty = finding.uncertainty.strip()
        if not evidence and not evidence_refs and verdict in {"supported", "contradicted", "mixed"}:
            verdict = "unverified"
            confidence = min(confidence, 0.3)
            uncertainty = uncertainty or "没有可追溯证据，结论已降级为未核验。"
        normalized_findings.append(finding.model_copy(update={
            "statement": claim.statement,
            "category": claim.category,
            "chapterIds": [claim.chapterId],
            "evidence": evidence,
            "evidenceRefs": evidence_refs,
            "verdict": verdict,
            "confidence": confidence,
            "uncertainty": uncertainty or (
                "现有项目资料不足，需补充可靠来源。" if verdict == "unverified" else ""
            ),
        }))

    warnings = list(dict.fromkeys([*bundle.warnings, *extraction_warnings, *report.warnings]))
    if any(claim.requiresExternalEvidence for claim in claims):
        warnings.append("当前 Runtime 未配置外部网络搜索；需要外部来源的声明只能依据已导入 RAG 资料判断，否则保持未核验。")
    if dropped_findings:
        warnings.append(f"已移除 {dropped_findings} 条无法关联到已提取声明的结论。")
    if dropped_evidence:
        warnings.append(f"已移除 {dropped_evidence} 个无法在范围、RAG 或项目全文检索中核验的证据引用。")
    searched_claims = sum(1 for evidence in search_evidence.values() if evidence)
    return report.model_copy(update={
        "claims": claims,
        "findings": normalized_findings,
        "warnings": list(dict.fromkeys(warnings)),
        "coverage": bundle.coverage,
        "searchStats": {
            "claimCount": len(claims),
            "searchedClaimCount": len(search_evidence),
            "matchedClaimCount": searched_claims,
            "projectEvidenceCount": sum(len(items) for items in search_evidence.values()),
        },
    })


def research_fact_check_markdown(report: ResearchFactCheckArtifact) -> str:
    score = "无法评分" if report.overallReliabilityScore is None else f"{report.overallReliabilityScore}/100"
    lines = ["# 多章节考据与事实核查", "", f"**可靠性评分：{score}**", "", report.summary.strip()]
    if report.findings:
        lines.extend(["", "## 核验结论", ""])
        for index, finding in enumerate(report.findings, start=1):
            lines.append(f"### {index}. [{finding.verdict}] {finding.statement}")
            lines.append(f"- 章节：{'、'.join(finding.chapterIds)}")
            lines.append(f"- 分类：{finding.category}")
            lines.append(f"- 可信度：{round(finding.confidence * 100)}%")
            lines.append(f"- 判断：{finding.summary}")
            if finding.evidence:
                sources = "；".join(item.title or item.excerpt for item in finding.evidence[:4])
                if sources:
                    lines.append(f"- 证据：{sources}")
            if finding.recommendation:
                lines.append(f"- 建议：{finding.recommendation}")
            if finding.uncertainty:
                lines.append(f"- 不确定性：{finding.uncertainty}")
            lines.append("")
    if report.recommendations:
        lines.extend(["## 总体建议", "", *[f"- {item}" for item in report.recommendations]])
    if report.warnings:
        lines.extend(["", "## 来源与覆盖警告", "", *[f"- {item}" for item in report.warnings]])
    return "\n".join(lines).strip()


def _fallback_keyword(statement: str) -> str:
    compact = " ".join(statement.strip().split())
    return compact[:80]


def _valid_evidence(
    evidence: list[ContextEvidence],
    allowed_source_ids: set[str],
) -> list[ContextEvidence]:
    unique: dict[tuple[str, str, str], ContextEvidence] = {}
    for item in evidence:
        if not item.sourceId or item.sourceId not in allowed_source_ids:
            continue
        key = (item.sourceType, item.sourceId, item.excerpt)
        unique.setdefault(key, item)
    return list(unique.values())
