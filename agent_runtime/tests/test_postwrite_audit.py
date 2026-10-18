import asyncio
import copy

import pytest

from novel_agent_runtime.postwrite_audit import (
    DraftSource, apply_patches, candidate_current, explicit_elapsed_minutes,
    quote_errors, validate_audit, verify_explicit_fact, FileDraftAuditJournal,
)
from novel_agent_runtime.toolchains.chapter_consistency_review import run_postwrite_loop


def source(text=None):
    return DraftSource(text or ('正面字数是五。' + '普通的景色。' * 40 + '正面六个字。'), 'draft-1', 'v1', 'active')


def audit(s, classification='conflict', quote='正面六个字。'):
    return {'source': s.binding(), 'findings': [{'id': 'count', 'classification': classification,
        'evidence': [{'quote': quote}], 'reason': '引用与显式数量冲突', 'impact': '读者误解',
        'minimalRepair': '只改数量', 'alternativeExplanation': 'ruled_out_with_evidence', 'alternativeReason': '计数不一致',
        'basisSource': s.binding(), 'basisEvidence': [{'quote': '正面字数是五。'}],
        'statementKind': 'narrator_assertion', 'basisStatementKind': 'narrator_assertion'}]}


def test_quote_and_confidence_cannot_override_evidence():
    s = source()
    raw = audit(s, quote='正面六个字……')
    raw['findings'][0]['confidence'] = 1
    assert not validate_audit(s, raw)['findings'][0]['eligibleForPatch']
    assert quote_errors(s, [{'quote': '正面六个字。', 'start': 0}])
    assert quote_errors(source('重复重复'), [{'quote': '重复'}])


@pytest.mark.parametrize('kind', ['needs_setup', 'acceptable', 'uncertain'])
def test_nonconflicts_never_drive_patch(kind):
    s = source()
    checked = validate_audit(s, audit(s, classification=kind))
    assert not checked['findings'][0]['eligibleForPatch']
    with pytest.raises(ValueError, match='unapproved'):
        apply_patches(s, checked, {'source': s.binding(), 'patches': [{'findingId': 'count', 'old': '六个', 'new': '五个'}]})


def test_possible_misbelief_or_unshown_conversation_stays_manual():
    s = source()
    raw = audit(s)
    raw['findings'][0]['alternativeExplanation'] = 'possible'
    assert not validate_audit(s, raw)['findings'][0]['eligibleForPatch']


def test_stale_hash_version_and_branch_rejected():
    s = source()
    for changed in [DraftSource(s.text + '改', s.draft_id, s.version, s.branch), DraftSource(s.text, s.draft_id, 'v2', s.branch), DraftSource(s.text, s.draft_id, s.version, 'abandoned')]:
        with pytest.raises(ValueError, match='source_mismatch'):
            validate_audit(changed, audit(s))


def test_local_patch_and_remote_rewrite_rejected():
    s = source()
    checked = validate_audit(s, audit(s))
    request = {'source': s.binding(), 'patches': [{'findingId': 'count', 'old': '六个', 'new': '五个'}]}
    text, patches = apply_patches(s, checked, request)
    assert text == s.text.replace('六个', '五个')
    assert len(patches) == 1
    request['patches'][0]['old'] = '景色。普通的'
    with pytest.raises(ValueError):
        apply_patches(s, checked, request)


def test_overlap_full_rewrite_and_growth_rejected():
    s = source()
    checked = validate_audit(s, audit(s))
    for old, new in [(s.text, '全文'), ('六个', '长' * 100)]:
        with pytest.raises(ValueError):
            apply_patches(s, checked, {'source': s.binding(), 'patches': [{'findingId': 'count', 'old': old, 'new': new}]})


def test_explicit_time_math_does_not_infer_day_or_character_knowledge():
    assert explicit_elapsed_minutes('23:47', '00:52', 1) == 65
    with pytest.raises(ValueError):
        explicit_elapsed_minutes('23:47', '00:52', 0)
    with pytest.raises(ValueError):
        explicit_elapsed_minutes('23:47', '00:52', None)
    with pytest.raises(ValueError):
        explicit_elapsed_minutes('25:47', '00:52', 1)


def test_candidates_preserve_heard_false_claim_and_clocks_invalidated():
    s = source('“停灯不到一小时。”' + '场景。' * 100)
    raw = {'source': s.binding(), 'findings': [], 'stateCandidates': [{
        'character': '姐姐', 'content': '听弟弟说停灯不到一小时，未核实',
        'effectiveAfter': '弟弟通话说出之后', 'eventTime': '三年前', 'learnedTime': '本夜',
        'narrativePosition': '电话场景；倒叙不继承此时所知', 'epistemicStatus': 'heard_claim',
        'evidence': [{'quote': '“停灯不到一小时。”'}]}]}
    candidate = validate_audit(s, raw)['stateCandidates'][0]
    assert candidate_current(candidate, s)
    assert '65' not in candidate['content']
    assert not candidate_current(candidate, DraftSource(s.text, s.draft_id, 'v2', s.branch))
    assert not candidate_current(candidate, DraftSource(s.text, s.draft_id, s.version, 'other'))
    raw['stateCandidates'][0]['learnedTime'] = ''
    assert validate_audit(s, raw)['stateCandidates'][0]['status'] == 'rejected'


def test_real_entry_runs_once_checkpoints_and_rechecks_old_and_new():
    s = source()
    calls, records = [], {}
    async def model(operation, payload):
        calls.append((operation, payload))
        assert 'contextBundle' in payload
        if len(calls) == 1:
            return audit(s)
        if len(calls) == 2:
            return {'source': s.binding(), 'patches': [{'findingId': 'count', 'old': '六个', 'new': '五个'}]}
        assert payload['previousFindings'] and payload['appliedPatches']
        assert payload['contextBundle']['chapter']['content'] == payload['draft'] == s.text.replace('六个', '五个')
        assert payload['contextBundle']['chapter']['draftSource'] == payload['source']
        assert payload['contextBundle']['chapter']['version'] == payload['source']['version']
        assert payload['programChecks'] == []
        assert payload['historicalProgramChecks'][0]['source'] == s.binding()
        return {'source': payload['source'], 'findings': []}
    fact = {'source': s.binding(), 'kind': 'literal_hanzi_count', 'literal': '字数',
            'statementKind': 'narrator_assertion', 'evidence': [{'quote': '正面字数是五。'}]}
    result = asyncio.run(run_postwrite_loop(s, {'chapter': {'id': s.draft_id, 'content': s.text}}, model, records.__setitem__, explicit_facts=(fact,)))
    assert len(calls) == 3
    assert result['adopted'] is False
    assert result['invalidatedCandidateSources'] == [s.binding()]
    assert records['revision']['source']['sha256'] != s.binding()['sha256']
    assert set(records) == {'source', 'program-checks', 'audit-raw', 'audit', 'patch-proposal', 'revision', 'recheck-raw', 'recheck', 'result'}


def test_unknown_request_is_never_retried():
    calls, records = [], {}
    async def fail(*args):
        calls.append(args); raise TimeoutError('unknown_remote_state')
    with pytest.raises(TimeoutError):
        asyncio.run(run_postwrite_loop(source(), {'chapter': {}}, fail, records.__setitem__))
    assert len(calls) == 1 and set(records) == {'source', 'program-checks'}


@pytest.mark.parametrize('kind', ['character_claim', 'quoted_record', 'narrator_assertion'])
def test_correct_math_cannot_authorize_rewriting_a_claim(kind):
    s = source('日志写着23:47至次日00:52。姐姐听他说不到一小时。')
    fact = {'source': s.binding(), 'evidence': [{'quote': '日志写着23:47至次日00:52。'}],
            'kind': 'elapsed_minutes', 'start': '23:47', 'end': '00:52', 'endDayOffset': 1,
            'nextDayMarker': '次日', 'statementKind': kind}
    result = verify_explicit_fact(s, fact)
    assert result['computedValue'] == 65 and not result['authorizesPatch']
    assert not result['semanticErrorVerified']
    assert not result['extractionVerified'] and result['suppliedRoleAssignments']
    fact['end'] = '00:55'
    with pytest.raises(ValueError): verify_explicit_fact(s, fact)


def test_literal_quantity_and_ambiguous_midnight_extraction():
    s = source('正面写着下一个守塔人，日志23:47至00:52。')
    fact = {'source': s.binding(), 'evidence': [{'quote': '正面写着下一个守塔人，日志23:47至00:52。'}],
            'kind': 'literal_hanzi_count', 'literal': '下一个守塔人', 'statementKind': 'quoted_record'}
    assert verify_explicit_fact(s, fact)['computedValue'] == 6
    fact.update(kind='elapsed_minutes', start='23:47', end='00:52', endDayOffset=1, nextDayMarker='次日')
    with pytest.raises(ValueError, match='next_day'):
        verify_explicit_fact(s, fact)


def test_recheck_failure_leaves_revision_invalidation_checkpoint():
    s = source()
    calls, records = [], {}
    async def model(operation, payload):
        calls.append(operation)
        if len(calls) == 1: return audit(s)
        if len(calls) == 2:
            return {'source': s.binding(), 'patches': [{'findingId': 'count', 'old': '六个', 'new': '五个'}]}
        raise TimeoutError('unknown')
    with pytest.raises(TimeoutError):
        asyncio.run(run_postwrite_loop(s, {'chapter': {}}, model, records.__setitem__))
    assert records['revision']['invalidatedCandidateSources'] == [s.binding()]


@pytest.mark.parametrize('kind', ['character_claim', 'quoted_record', 'unknown'])
def test_quoted_or_unreliable_counterstatement_cannot_drive_patch(kind):
    s = source()
    raw = audit(s)
    raw['findings'][0]['basisStatementKind'] = kind
    assert not validate_audit(s, raw)['findings'][0]['eligibleForPatch']


def test_exact_quote_and_self_reported_certainty_are_not_sufficient():
    s = source()
    raw = audit(s)
    raw['findings'][0].pop('basisEvidence')
    assert not validate_audit(s, raw)['findings'][0]['eligibleForPatch']
    raw['findings'][0]['id'] = []
    assert not validate_audit(s, raw)['findings'][0]['eligibleForPatch']


def test_large_anchor_cannot_modify_surrounding_prose():
    s = source()
    checked = validate_audit(s, audit(s))
    with pytest.raises(ValueError, match='outside_evidence'):
        apply_patches(s, checked, {'source': s.binding(), 'patches': [{'findingId': 'count', 'old': '景色。正面六个字。', 'new': '空气。正面五个字。'}]})


def test_no_eligible_issue_skips_revision_but_rechecks_identical_source():
    s, calls = source(), []
    async def model(operation, payload):
        calls.append(payload)
        assert payload['source'] == s.binding()
        return {'source': s.binding(), 'findings': []}
    result = asyncio.run(run_postwrite_loop(s, {'chapter': {}}, model, lambda *args: None))
    assert len(calls) == 2 and result['patches'] == [] and result['text'] == s.text
    assert calls[1]['previousFindings'] == []


def test_malformed_model_types_fail_closed():
    s = source()
    bad = audit(s)
    bad['stateCandidates'] = None
    with pytest.raises(ValueError, match='state_candidates'): validate_audit(s, bad)
    with pytest.raises(ValueError, match='unapproved'):
        apply_patches(s, validate_audit(s, audit(s)), {'source': s.binding(), 'patches': [{'findingId': [], 'old': '六个', 'new': '五个'}]})


def test_nested_quote_is_not_independent_counterstatement():
    s = source()
    raw = audit(s)
    raw['findings'][0]['basisEvidence'] = [{'quote': '六个字'}]
    checked = validate_audit(s, raw)['findings'][0]
    assert not checked['eligibleForPatch']
    assert not checked['patchGate']['distinctCounterstatement']


def test_context_text_mismatch_fails_before_model():
    async def fail(*args):
        pytest.fail('must not call model with conflicting current text')
    with pytest.raises(ValueError, match='context_draft_content_mismatch'):
        asyncio.run(run_postwrite_loop(source(), {'chapter': {'content': 'other version'}}, fail, lambda *args: None))


def test_disk_journal_persists_invalidation_before_unknown_recheck(tmp_path):
    import json
    s, calls = source(), []
    journal = FileDraftAuditJournal(tmp_path / 'draft-review')
    async def model(operation, payload):
        calls.append(operation)
        if len(calls) == 1: return audit(s)
        if len(calls) == 2:
            return {'source': s.binding(), 'patches': [{'findingId': 'count', 'old': '六个', 'new': '五个'}]}
        assert (journal.directory / 'revision.json').exists()
        raise TimeoutError('unknown_billed_request')
    with pytest.raises(TimeoutError):
        asyncio.run(run_postwrite_loop(s, {'chapter': {}}, model, journal))
    revision = json.loads((journal.directory / 'revision.json').read_text(encoding='utf-8'))
    candidate = {'source': s.binding(), 'status': 'candidate_only'}
    assert not candidate_current(candidate, s, tuple(revision['invalidatedCandidateSources']))
    with pytest.raises(FileExistsError): FileDraftAuditJournal(journal.directory)
    with pytest.raises(ValueError): journal('../escape', {})


def test_swapped_time_roles_remain_unverified_extraction():
    s = source('结束00:52，开始23:47，附注次日。')
    fact = {'source': s.binding(), 'evidence': [{'quote': s.text}], 'kind': 'elapsed_minutes',
            'start': '00:52', 'end': '23:47', 'endDayOffset': 1, 'nextDayMarker': '次日', 'statementKind': 'quoted_record'}
    result = validate_audit(s, {'source': s.binding(), 'findings': [], 'computations': [fact]})['computations'][0]
    assert result['calculationVerified'] and not result['extractionVerified']
    assert not result['authorizesPatch']


def test_entry_runs_explicit_program_layer_before_model_and_rejects_stale_fact():
    s, calls, records = source('日志23:47至次日00:52。'), [], {}
    fact = {'source': s.binding(), 'evidence': [{'quote': s.text}], 'kind': 'elapsed_minutes',
            'start': '23:47', 'end': '00:52', 'endDayOffset': 1, 'nextDayMarker': '次日', 'statementKind': 'quoted_record'}
    async def model(operation, payload):
        calls.append(operation)
        assert records['program-checks']['computations'][0]['computedValue'] == 65
        assert not payload['programChecks'][0]['authorizesPatch']
        return {'source': s.binding(), 'findings': []}
    result = asyncio.run(run_postwrite_loop(s, {'chapter': {}}, model, records.__setitem__, explicit_facts=(fact,)))
    assert len(calls) == 2 and result['programChecks'][0]['computedValue'] == 65
    fact['source'] = {**s.binding(), 'branch': 'abandoned'}
    calls.clear()
    with pytest.raises(ValueError, match='fact_source'):
        asyncio.run(run_postwrite_loop(s, {'chapter': {}}, model, records.__setitem__, explicit_facts=(fact,)))
    assert calls == []
