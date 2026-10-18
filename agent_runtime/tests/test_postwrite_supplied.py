import asyncio
import copy

import pytest

from novel_agent_runtime.postwrite_audit import DraftSource, apply_patches, candidate_current, run_postwrite_loop, validate_audit
from novel_agent_runtime.postwrite_supplied import validate_supplied_count_candidates, verify_supplied_revision


def fixture():
    s = DraftSource('他关好门。' * 60 + '\n\n正面写了五个字，用的是钢笔，笔画很稳：\n\n下一个守塔人。\n\n他又看了一眼那五个字。\n他还要去值班。', 'draft', 'v1', 'trial')
    f = {'id': 'given-1', 'classification': 'conflict', 'evidence': [{'quote': '正面写了五个字，用的是钢笔，笔画很稳：'}],
         'basisEvidence': [{'quote': '下一个守塔人。'}], 'basisSource': s.binding(),
         'statementKind': 'narrator_assertion', 'basisStatementKind': 'quoted_record',
         'reason': '题字计数不符', 'impact': '回指计数不一致', 'minimalRepair': '只改计数数词',
         'alternativeExplanation': 'ruled_out_with_evidence', 'alternativeReason': '完整题字为六个汉字'}
    supplied = {'source': s.binding(), 'provenance': {'kind': 'user_supplied_verified_issue', 'request': '核实计数与回指', 'reviewer': 'operator'},
        'anchor': f, 'reviewedReferences': [{'id': 'given-2', 'evidence': [{'quote': '他又看了一眼那五个字。'}],
            'statementKind': 'narrator_assertion', 'relationReview': {'anchorId': 'given-1', 'decision': 'same_literal_confirmed', 'reviewer': 'operator'}}]}
    return s, supplied


def proposal(s):
    return {'source': s.binding(), 'patches': [
        {'findingId': 'given-1', 'old': '正面写了五个字', 'new': '正面写了六个字'},
        {'findingId': 'given-2', 'old': '他又看了一眼那五个字。', 'new': '他又看了一眼那六个字。'}]}


def test_supplied_two_locations_keep_original_autonomous_gate_and_provenance():
    s, given = fixture()
    assert not validate_audit(s, {'source': s.binding(), 'findings': [given['anchor']]})['findings'][0]['eligibleForPatch']
    audit = validate_supplied_count_candidates(s, given)
    assert len(audit['findings']) == 2 and not audit['autonomousDiscoveryTested']
    assert audit['computations'][0]['computedValue'] == 6
    text, _ = apply_patches(s, audit, proposal(s))
    b = DraftSource(text, s.draft_id, 'v2', s.branch)
    checks = verify_supplied_revision(s, b, audit)
    assert checks['allRelatedLocationsCorrected'] and checks['exactlyApprovedChangesOnly']
    assert text == s.text.replace('五个字', '六个字')


@pytest.mark.parametrize('alteration', ['source', 'quote', 'basis', 'provenance', 'relation', 'kind', 'duplicate'])
def test_external_candidate_never_bypasses_evidence_binding(alteration):
    s, given = fixture()
    if alteration == 'source': given['source']['version'] = 'stale'
    if alteration == 'quote': given['reviewedReferences'][0]['evidence'][0]['quote'] = '不存在的五个字'
    if alteration == 'basis': given['anchor']['basisEvidence'][0]['quote'] = '守塔人'
    if alteration == 'provenance': given['provenance']['kind'] = 'model_self_report'
    if alteration == 'relation': given['reviewedReferences'][0]['relationReview']['reviewer'] = 'model'
    if alteration == 'kind': given['reviewedReferences'][0]['statementKind'] = 'character_claim'
    if alteration == 'duplicate': given['reviewedReferences'][0]['evidence'] = copy.deepcopy(given['anchor']['evidence'])
    with pytest.raises(ValueError): validate_supplied_count_candidates(s, given)


def test_wrong_or_remote_edits_rejected_and_partial_revision_detected():
    s, given = fixture()
    audit = validate_supplied_count_candidates(s, given)
    p = proposal(s)
    p['patches'][1]['new'] += '他明白了一切。'
    with pytest.raises(ValueError): apply_patches(s, audit, p)
    p = proposal(s); p['patches'][1]['new'] = p['patches'][1]['new'].replace('六', '七')
    with pytest.raises(ValueError): apply_patches(s, audit, p)
    p = proposal(s); p['patches'].pop()
    text, _ = apply_patches(s, audit, p)
    checks = verify_supplied_revision(s, DraftSource(text, s.draft_id, 'v2', s.branch), audit)
    assert not checks['allRelatedLocationsCorrected'] and not checks['exactlyApprovedChangesOnly']


def test_supplied_entry_only_patch_then_recheck_binds_current_source_invalidates_old():
    s, given = fixture()
    calls, journal = [], {}
    async def model(op, payload):
        calls.append((op, payload))
        if len(calls) == 1: return proposal(s)
        assert payload['draft'] == s.text.replace('五个字', '六个字')
        assert payload['source']['version'] != s.version
        assert payload['contextBundle']['chapter']['draftSource'] == payload['source']
        assert not payload.get('programChecks')
        return {'source': payload['source'], 'findings': []}
    result = asyncio.run(run_postwrite_loop(s, {'chapter': {'content': s.text}}, model, journal.__setitem__,
        profile='internal_two', supplied_candidates=given))
    assert [op for op, _ in calls] == ['chapter.rewrite', 'chapter.consistency_review']
    assert 'audit-raw' not in journal and 'supplied-candidates' in journal
    assert result['autonomousDiscoveryTested'] is False and not result['adopted']
    assert result['suppliedRevisionChecks']['exactlyApprovedChangesOnly']
    old_candidate = {'status': 'candidate_only', 'source': s.binding()}
    invalid = tuple(result['invalidatedCandidateSources'])
    b = DraftSource(result['text'], s.draft_id, result['revisedSource']['version'], s.branch)
    assert not candidate_current(old_candidate, s, invalid) and not candidate_current(old_candidate, b)
    with pytest.raises(ValueError, match='source_mismatch'):
        validate_supplied_count_candidates(b, given)


def test_no_patch_no_recheck_and_no_retry_on_transport_failure():
    s, given = fixture()
    calls = []
    async def empty(op, payload):
        calls.append(op)
        return {'source': s.binding(), 'patches': []}
    result = asyncio.run(run_postwrite_loop(s, {'chapter': {}}, empty, lambda *args: None, profile='internal_two', supplied_candidates=given))
    assert len(calls) == 1 and result['status'] == 'revision_not_validated'
    assert result['recheck'] is None and not result['autonomousDiscoveryTested']
    calls.clear()
    async def broken(op, payload):
        calls.append(op)
        raise RuntimeError('truncated')
    with pytest.raises(RuntimeError, match='truncated'):
        asyncio.run(run_postwrite_loop(s, {'chapter': {}}, broken, lambda *args: None, profile='internal_two', supplied_candidates=given))
    assert len(calls) == 1
