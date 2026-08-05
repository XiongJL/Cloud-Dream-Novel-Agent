import type {
    ExpertAgentRole,
    ExpertFinding,
    ExpertFindingSeverity,
    ExpertReportPayload,
} from './expertReport';
import { normalizeExpertReportFindingIds } from './expertReport';

export const EXPERT_REPORT_TYPES = new Set([
    'writer_revision_plan',
    'chapter_range_review',
    'reader_journey',
    'worldbuilding_consistency',
    'research_fact_check',
    'scope_audit',
]);

export type ExpertArtifactLike = {
    artifactId: string;
    type: string;
    title: string;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    reviewStatus?: string;
    reviewRevision?: number;
    reviewDecisions?: Array<{ findingId: string; status: 'accepted' | 'rejected' | 'deferred'; note?: string }>;
    reviewStaleChapterIds?: string[];
    createdAt?: string;
};

export type ChapterFindingProjection = {
    chapterId: string;
    findingCount: number;
    highestSeverity: ExpertFindingSeverity | null;
    experts: ExpertAgentRole[];
};

const SEVERITY_RANK: Record<ExpertFindingSeverity, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
};

export const CONSOLIDATED_REPORT_FINDING_LIMIT = 4;

export function getExpertReport(artifact: ExpertArtifactLike | null | undefined): ExpertReportPayload | null {
    if (!artifact || !EXPERT_REPORT_TYPES.has(artifact.type)) return null;
    const report = artifact.metadata?.expertReport;
    if (!report || typeof report !== 'object') return null;
    const candidate = report as Partial<ExpertReportPayload>;
    if (!Array.isArray(candidate.findings) || !candidate.scope || !Array.isArray(candidate.scope.chapterIds)) return null;
    return normalizeExpertReportFindingIds(candidate as ExpertReportPayload);
}

export function selectConsolidatedReportArtifact<T extends ExpertArtifactLike>(artifacts: T[]): T | null {
    const reports = artifacts.filter((artifact) => getExpertReport(artifact));
    if (!reports.length) return null;
    return [...reports].sort((left, right) => {
        const typeDifference = Number(right.type === 'scope_audit') - Number(left.type === 'scope_audit');
        if (typeDifference !== 0) return typeDifference;
        const findingDifference = (getExpertReport(right)?.findings.length ?? 0)
            - (getExpertReport(left)?.findings.length ?? 0);
        if (findingDifference !== 0) return findingDifference;
        return Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? '');
    })[0] ?? null;
}

export function projectConsolidatedFindings(
    report: ExpertReportPayload,
    limit = CONSOLIDATED_REPORT_FINDING_LIMIT,
): ExpertFinding[] {
    if (limit <= 0) return [];
    const seen = new Set<string>();
    return report.findings
        .map((finding, index) => ({ finding, index }))
        .sort((left, right) => (
            SEVERITY_RANK[right.finding.severity] - SEVERITY_RANK[left.finding.severity]
            || left.index - right.index
        ))
        .filter(({ finding }) => {
            const key = [
                finding.title.trim().toLocaleLowerCase(),
                finding.category.trim().toLocaleLowerCase(),
                [...finding.chapterIds].sort().join(','),
            ].join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, limit)
        .map(({ finding }) => finding);
}

export function getFindingSourceExperts(
    artifact: ExpertArtifactLike,
    finding: ExpertFinding,
): ExpertAgentRole[] {
    const scopeAudit = artifact.metadata?.scopeAudit;
    if (scopeAudit && typeof scopeAudit === 'object') {
        const findings = (scopeAudit as { findings?: unknown }).findings;
        if (Array.isArray(findings)) {
            const match = findings.find((candidate) => (
                candidate && typeof candidate === 'object'
                && (candidate as { findingId?: unknown }).findingId === finding.findingId
            ));
            const sourceExperts = match && typeof match === 'object'
                ? (match as { sourceExperts?: unknown }).sourceExperts
                : null;
            if (Array.isArray(sourceExperts)) {
                return [...new Set(sourceExperts.filter((role): role is ExpertAgentRole => (
                    typeof role === 'string'
                    && ['supervisor', 'writer', 'editor', 'reader', 'worldbuilding', 'research_rag'].includes(role)
                )))];
            }
        }
    }
    return [finding.expert];
}

export function expertRoleLabel(role: ExpertAgentRole): string {
    return ({
        supervisor: '综合',
        writer: '作者',
        editor: '编辑',
        reader: '读者',
        worldbuilding: '世界观',
        research_rag: '考据',
    } as Record<ExpertAgentRole, string>)[role] || role;
}

export function expertReportTypeLabel(type: string): string {
    return ({
        writer_revision_plan: '作者修订计划',
        chapter_range_review: '编辑范围审核',
        reader_journey: '读者旅程',
        worldbuilding_consistency: '世界观一致性',
        research_fact_check: '事实核查',
        scope_audit: '团队综合审计',
    } as Record<string, string>)[type] || '专家报告';
}

export function severityCounts(findings: ExpertFinding[]): Record<ExpertFindingSeverity, number> {
    const counts: Record<ExpertFindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of findings) counts[finding.severity] += 1;
    return counts;
}

export function projectChapterFindings(report: ExpertReportPayload): ChapterFindingProjection[] {
    const ids = [...new Set([
        ...report.scope.chapterIds,
        ...report.findings.flatMap((finding) => finding.chapterIds),
    ])];
    return ids.map((chapterId) => {
        const findings = report.findings.filter((finding) => finding.chapterIds.includes(chapterId));
        const highestSeverity = findings.reduce<ExpertFindingSeverity | null>((highest, finding) => (
            !highest || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highest] ? finding.severity : highest
        ), null);
        return {
            chapterId,
            findingCount: findings.length,
            highestSeverity,
            experts: [...new Set(findings.map((finding) => finding.expert))],
        };
    });
}
