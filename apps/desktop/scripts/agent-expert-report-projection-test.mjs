import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const expertReportSource = await readFile(new URL('../shared/expertReport.ts', import.meta.url), 'utf8');
const expertReportOutput = ts.transpileModule(expertReportSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const expertReportModule = await import(`data:text/javascript;base64,${Buffer.from(expertReportOutput).toString('base64')}`);
globalThis.__normalizeExpertReportFindingIds = expertReportModule.normalizeExpertReportFindingIds;

const source = await readFile(new URL('../shared/agentExpertReportProjection.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(
    /import \{ normalizeExpertReportFindingIds \} from ['"]\.\/expertReport['"];/,
    'const normalizeExpertReportFindingIds = globalThis.__normalizeExpertReportFindingIds;',
);
const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const report = {
    artifactId: 'artifact-1',
    novelId: 'novel-1',
    runId: 'run-1',
    planId: 'plan-1',
    type: 'chapter_range_review',
    title: '编辑范围审核',
    expert: 'editor',
    scope: {
        scopeId: 'scope-1', novelId: 'novel-1', kind: 'selected_chapters',
        chapterIds: ['chapter-1', 'chapter-2'], processingMode: 'detailed', snapshot: [],
    },
    findings: [
        { findingId: 'finding-1', title: '动机断裂', summary: '摘要', category: 'motivation', severity: 'high', chapterIds: ['chapter-1'], expert: 'editor', evidenceRefs: [] },
        { findingId: 'finding-2', title: '节奏偏慢', summary: '摘要', category: 'pace', severity: 'medium', chapterIds: ['chapter-1', 'chapter-2'], expert: 'reader', evidenceRefs: [] },
    ],
    sourceSnapshot: [],
    generatedAt: '2026-07-18T00:00:00.000Z',
};
const artifact = { artifactId: 'artifact-1', type: report.type, title: report.title, metadata: { expertReport: report } };

assert.equal(module.getExpertReport(artifact)?.artifactId, 'artifact-1');
assert.equal(module.expertRoleLabel('worldbuilding'), '世界观');
assert.equal(module.expertReportTypeLabel('scope_audit'), '团队综合审计');
assert.deepEqual(module.severityCounts(report.findings), { critical: 0, high: 1, medium: 1, low: 0, info: 0 });

const matrix = module.projectChapterFindings(report);
assert.equal(matrix.length, 2);
assert.equal(matrix[0].findingCount, 2);
assert.equal(matrix[0].highestSeverity, 'high');
assert.deepEqual(matrix[0].experts, ['editor', 'reader']);
assert.equal(matrix[1].findingCount, 1);

const scopeReport = {
    ...report,
    artifactId: 'artifact-scope',
    type: 'scope_audit',
    findings: [
        { findingId: 'finding-low', title: '措辞重复', summary: '摘要', category: 'prose', severity: 'low', chapterIds: ['chapter-2'], expert: 'supervisor', evidenceRefs: [] },
        { findingId: 'finding-critical', title: '核心动机缺失', summary: '摘要', category: 'motivation', severity: 'critical', chapterIds: ['chapter-1'], expert: 'supervisor', evidenceRefs: [] },
        { findingId: 'finding-high', title: '高潮落点偏早', summary: '摘要', category: 'pace', severity: 'high', chapterIds: ['chapter-2'], expert: 'supervisor', evidenceRefs: [] },
        { findingId: 'finding-duplicate', title: '核心动机缺失', summary: '重复摘要', category: 'motivation', severity: 'high', chapterIds: ['chapter-1'], expert: 'supervisor', evidenceRefs: [] },
        { findingId: 'finding-medium', title: '线索回收不足', summary: '摘要', category: 'continuity', severity: 'medium', chapterIds: ['chapter-2'], expert: 'supervisor', evidenceRefs: [] },
        { findingId: 'finding-info', title: '可补充环境感官', summary: '摘要', category: 'prose', severity: 'info', chapterIds: ['chapter-1'], expert: 'supervisor', evidenceRefs: [] },
    ],
};
const scopeArtifact = {
    artifactId: 'artifact-scope',
    type: 'scope_audit',
    title: '综合审计',
    createdAt: '2026-07-19T00:00:00.000Z',
    metadata: {
        expertReport: scopeReport,
        scopeAudit: {
            findings: [{ findingId: 'finding-critical', sourceExperts: ['editor', 'reader', 'editor'] }],
        },
    },
};

assert.equal(module.selectConsolidatedReportArtifact([artifact, scopeArtifact])?.artifactId, 'artifact-scope');
assert.deepEqual(
    module.projectConsolidatedFindings(scopeReport).map((finding) => finding.findingId),
    ['finding-critical', 'finding-high', 'finding-medium', 'finding-low'],
);
assert.deepEqual(module.getFindingSourceExperts(scopeArtifact, scopeReport.findings[1]), ['editor', 'reader']);
assert.deepEqual(module.getFindingSourceExperts(artifact, report.findings[0]), ['editor']);

const duplicateIdArtifact = {
    ...artifact,
    artifactId: 'artifact-duplicate-ids',
    metadata: {
        expertReport: {
            ...report,
            artifactId: 'artifact-duplicate-ids',
            findings: [
                report.findings[0],
                { ...report.findings[1], findingId: 'finding-1' },
                { ...report.findings[1], findingId: '' },
            ],
        },
    },
};
assert.deepEqual(
    module.getExpertReport(duplicateIdArtifact).findings.map((finding) => finding.findingId),
    ['finding-1', 'finding-1__2', 'finding-auto-3'],
);

console.log('Agent expert report projection tests passed.');
