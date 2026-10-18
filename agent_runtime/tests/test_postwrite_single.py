import asyncio
import copy
import json

import pytest

from novel_agent_runtime.postwrite_audit import DraftSource, apply_patches, literal_caption_count_proof, run_postwrite_loop, validate_audit
from novel_agent_runtime.postwrite_wire import ResponseBinding, build_request, consume_response, digest_request, response_schema, token_breakdown, validate_wire


def fixture():
    text = '他关好门。' * 45 + '\n\n信封没有封口。正面写了五个字，用的是钢笔，笔画很稳：\n\n下一个守塔人。\n\n他把信收好。'
    source = DraftSource(text, 'skill-1', 'original-1', 'experiment')
    finding = {'classification': 'conflict', 'evidence': [{'quote': '正面写了五个字，用的是钢笔，笔画很稳：'}],
               'basisEvidence': [{'quote': '下一个守塔人。'}], 'statementKind': 'narrator_assertion', 'basisStatementKind': 'quoted_record',
               'reason': '题字实际六字，叙述计数五字', 'impact': '字面计数不一致', 'minimalRepair': '只将五改六',
               'alternativeExplanation': 'ruled_out_with_evidence', 'alternativeReason': '核对明确题字整行汉字数'}
    return source, finding


def normalized(source, finding):
    return {'source': source.binding(), 'findings': [{**finding, 'id': 'F1', 'basisSource': source.binding()}]}


def test_literal_proof_is_narrow_and_opt_in_not_document_truth():
    s, f = fixture()
    raw = normalized(s, f)
    assert not validate_audit(s, raw)['findings'][0]['eligibleForPatch'], 'Old full profile unchanged'
    checked = validate_audit(s, raw, allow_literal_count=True)
    assert checked['findings'][0]['eligibleForPatch']
    assert checked['findings'][0]['literalCountProof']['actual'] == 6
    text, _ = apply_patches(s, checked, {'source': s.binding(), 'patches': [{'findingId': 'F1', 'old': '正面写了五个字', 'new': '正面写了六个字'}]})
    assert text == s.text.replace('正面写了五个字', '正面写了六个字')
    with pytest.raises(ValueError, match='proven_count'):
        apply_patches(s, checked, {'source': s.binding(), 'patches': [{'findingId': 'F1', 'old': '正面写了五个字，用的是钢笔', 'new': '正面写了六个字，用的是铅笔'}]})


@pytest.mark.parametrize('change', ['substring', 'character_claim', 'unbound_layout'])
def test_no_arbitrary_count_or_character_misstatement_authorizes_patch(change):
    s, f = fixture()
    if change == 'substring': f['basisEvidence'] = [{'quote': '守塔人'}]
    if change == 'character_claim': f['statementKind'] = 'character_claim'
    if change == 'unbound_layout': s = DraftSource(s.text.replace('正面写了', '他声称写了'), s.draft_id, s.version, s.branch)
    assert literal_caption_count_proof(s, f) is None


def test_compact_request_has_one_draft_no_hash_echo_or_repeated_instruction():
    s, _ = fixture()
    p = {'source': s.binding(), 'draft': s.text, 'instruction': '只审计内部矛盾', 'contextBundle': {'chapter': {'content': s.text}}, 'stateCandidates': ['irrelevant']}
    body = build_request(s, p, 'audit', 'deepseek-flash', 4096)
    assert json.loads(body['input']) == {'draft': s.text}
    assert s.binding()['sha256'] not in json.dumps(body)
    assert body['reasoning'] == {'effort': 'none'}
    assert body['text']['format']['type'] == 'json_schema'
    assert not {'thinking', 'reasoning_effort', 'response_format', 'temperature'} & set(body)


def test_binding_rejects_old_phase_version_branch_and_response_even_same_text():
    s, f = fixture()
    body = build_request(s, {'source': s.binding(), 'draft': s.text, 'instruction': '审核'}, 'audit', 'model', 4096)
    binding = ResponseBinding('trial-audit', 'audit', s, digest_request(body))
    submitted = {'recordKey': binding.record_key, 'phase': 'audit', 'source': s.binding(), 'requestSha256': binding.request_sha256}
    record = {'key': binding.record_key, 'status': 'completed', 'responseId': 'response-1', 'text': json.dumps({'findings': [f]}, ensure_ascii=False)}
    consume = lambda **kw: consume_response(kw.get('binding', binding), kw.get('request', body), kw.get('record', record), 'response-1', kw.get('last', 'response-1'), submitted_binding=submitted)
    assert consume()['source'] == s.binding()
    for altered in [DraftSource(s.text, s.draft_id, 'v2', s.branch), DraftSource(s.text, s.draft_id, s.version, 'other')]:
        with pytest.raises(ValueError, match='submission'):
            consume(binding=ResponseBinding('trial-audit', 'audit', altered, binding.request_sha256))
    with pytest.raises(ValueError): consume(last='different-response')
    with pytest.raises(ValueError): consume(record={**record, 'status': 'incomplete'})
    changed = copy.deepcopy(body); changed['instructions'] = 'different'
    with pytest.raises(ValueError): consume(request=changed)


def test_empty_findings_legal_but_extra_state_and_excess_issues_fail():
    schema = response_schema('audit')
    validate_wire({'findings': []}, schema)
    with pytest.raises(ValueError): validate_wire({'findings': [], 'stateCandidates': []}, schema)
    s, f = fixture()
    with pytest.raises(ValueError): validate_wire({'findings': [f, f, f]}, schema)


def test_real_minimal_entry_finishes_three_stages_without_relaxing_patch_gate():
    s, f = fixture()
    calls, journal = [], {}
    async def model(op, payload):
        calls.append((op, payload))
        if len(calls) == 1: return normalized(s, f)
        if len(calls) == 2:
            return {'source': s.binding(), 'patches': [{'findingId': 'F1', 'old': '正面写了五个字', 'new': '正面写了六个字'}]}
        assert payload['contextBundle']['chapter']['content'] == payload['draft']
        assert '正面写了六个字' in payload['draft']
        return {'source': payload['source'], 'findings': []}
    result = asyncio.run(run_postwrite_loop(s, {'chapter': {'content': s.text}}, model, journal.__setitem__, profile='internal_two'))
    assert len(calls) == 3 and len(result['patches']) == 1 and result['recheck']['findings'] == []
    assert not result['adopted']


def test_no_legal_candidate_does_not_manufacture_revision_or_recheck():
    s, calls = fixture()[0], []
    async def model(op, payload):
        calls.append(op)
        return {'source': s.binding(), 'findings': []}
    result = asyncio.run(run_postwrite_loop(s, {'chapter': {}}, model, lambda *a: None, profile='internal_two'))
    assert len(calls) == 1 and result['status'] == 'revision_not_validated' and result['recheck'] is None


def test_token_breakdown_does_not_call_reasoning_final_text():
    assert token_breakdown({'input_tokens': 10, 'output_tokens': 9000, 'output_tokens_details': {'reasoning_tokens': 8247}, 'total_tokens': 9010})['nonReasoningOutputTokens'] == 753
    with pytest.raises(ValueError): token_breakdown({'output_tokens': 5})
