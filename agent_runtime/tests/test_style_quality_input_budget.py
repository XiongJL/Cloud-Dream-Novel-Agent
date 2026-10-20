from __future__ import annotations

import asyncio
import copy

import pytest

from novel_agent_runtime.skill_analysis_graph import canonical, fingerprint
from novel_agent_runtime.style_quality import (CRITERIA, document_quality_input, document_review_source,
    quality_key, quality_request)
from novel_agent_runtime.toolchains.schemas import ToolchainError
from test_style_quality import quality_fixture
from test_runtime_analysis_restart import prepare
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.schemas import AgentRunEvent
from test_runtime import FakeAutomationClient


def source_material():
    features = []
    for key in ('ensemble', 'dialogue', 'clues', 'character_voice', 'other'):
        f = {'feature': key, 'label': key}
        for stance in ('supported', 'counterexample', 'unresolved'):
            f[stance + 'ChapterCount'] = 4
            f[stance + 'FindingCount'] = 5
            f[stance + 'Examples'] = [{'findingRef': key + ':' + stance,
                'observation': '核验观察' * 100, 'reason': '证据边界' * 100,
                'evidence': [{'sourceId': 'chapter', 'excerpt': key + '逐字例证' * 50}]}]
        features.append(f)
    dossier = {'features': features, 'coverage': {'analyzedChapterCount': 10},
        'reviewedCandidateCount': 80, 'limitations': ['缺席不等于反例']}
    # Cross-dimension explicit finding reference must keep its full examples.
    document = {'draftKey': 'ensemble_progression', 'contentText': '## 方法\ncharacter_voice:supported\n' + '完整方法' * 250,
        'contentHash': 'hash', 'logicalPath': 'ensemble-progression/SKILL.md'}
    return document_quality_input(document, {'draftKey': 'ensemble_progression'}, dossier, {'bindings': []})


def passed():
    return {'phase': 'document', 'checks': dict.fromkeys(CRITERIA, 'pass'), 'issues': [], 'summary': '完整审核'}


def test_projection_preserves_document_all_statistics_and_referenced_counterexamples():
    source = source_material()
    before = copy.deepcopy(source)
    projected = document_review_source(source)
    assert source == before and projected['document'] == source['document']
    assert projected['memberPlan'] == source['memberPlan'] and projected['bindings'] == source['bindings']
    old = source['reviewedEvidence']; new = projected['reviewedEvidence']
    assert new['projection']['dossierRef'] == fingerprint(old)
    assert new['reviewedCandidateCount'] == 80 and new['coverage'] == old['coverage']
    assert new['limitations'] == old['limitations']
    for a, b in zip(old['features'], new['features']):
        assert {k:v for k,v in a.items() if not k.endswith('Examples')} == {k:v for k,v in b.items() if not k.endswith('Examples')}
        if a['feature'] in {'ensemble', 'character_voice', 'other'}:
            assert a == b
        else:
            assert not any(k.endswith('Examples') for k in b)
    assert set(new['projection']['omittedExampleFeatures']) == {'dialogue', 'clues'}


def test_oversized_document_reuses_projection_and_preserves_budget_reservations(tmp_path):
    async def scenario():
        runtime, run, policy, _, store, _ = quality_fixture(tmp_path, None)
        source = source_material(); sent = []
        projected = document_review_source(source)
        policy['stages']['expert']['maxInputBytes'] = len(canonical(projected).encode()) + 1024
        assert len(canonical(source).encode()) + 1024 > policy['stages']['expert']['maxInputBytes']
        async def invoke(_, method, params, request, key):
            if method == 'agent_skill.pack.default.get':
                return {'packId': None, 'version': 0}
            assert method == 'agent.style_quality'
            sent.append(params['source']); return passed()
        runtime._invoke_skill_model = invoke
        result = await quality_request(runtime, run, 'document', source, policy)
        assert result['accepted'] and sent == [projected]
        assert store.record(quality_key(run, 'document', source)) is None
        assert store.record(quality_key(run, 'document', projected))['status'] == 'completed'
        assert await quality_request(runtime, run, 'document', source, policy) == result
        assert len(sent) == 1
    asyncio.run(scenario())


def test_cached_original_and_saved_return_ignore_new_input_limit_without_new_request(tmp_path):
    async def scenario():
        runtime, run, policy, _, store, calls = quality_fixture(tmp_path, None)
        source = source_material(); key = quality_key(run, 'document', source)
        store.begin('run:step', key, fingerprint(source), 100, policy)
        store.save_raw(key, passed())
        policy['stages']['expert']['maxInputBytes'] = 1
        assert (await quality_request(runtime, run, 'document', source, policy))['accepted']
        assert (await quality_request(runtime, run, 'document', source, policy))['accepted']
        assert calls == [] and store.record(key)['status'] == 'completed'
    asyncio.run(scenario())


@pytest.mark.parametrize('already_projected', [False, True])
def test_unknown_request_is_reconciled_before_projection_or_new_charge(tmp_path, already_projected):
    async def scenario():
        runtime, run, policy, _, store, calls = quality_fixture(tmp_path, None)
        source = source_material(); stored = document_review_source(source) if already_projected else source
        key = quality_key(run, 'document', stored)
        store.begin('run:step', key, fingerprint(stored), 100, policy)
        policy['stages']['expert']['maxInputBytes'] = 1
        with pytest.raises(ToolchainError) as e:
            await quality_request(runtime, run, 'document', source, policy)
        assert e.value.code == 'SIDE_EFFECT_UNKNOWN' and calls == []
        if not already_projected:
            assert store.record(quality_key(run, 'document', document_review_source(source))) is None
    asyncio.run(scenario())


@pytest.mark.parametrize('phase', ['document', 'generate_trial'])
def test_unsatisfiable_packet_reports_stage_limit_before_charging_and_never_truncates(tmp_path, phase):
    async def scenario():
        runtime, run, policy, _, store, calls = quality_fixture(tmp_path, None)
        source = source_material() if phase == 'document' else {'documents': [{'contentText': '完整正文' * 500}]}
        old = copy.deepcopy(source)
        policy['stages']['expert']['maxInputBytes'] = 1024
        with pytest.raises(ToolchainError) as e:
            await quality_request(runtime, run, phase, source, policy)
        assert e.value.code == 'STYLE_QUALITY_INPUT_LIMIT'
        assert e.value.details['requiredInputBytes'] > e.value.details['maxInputBytes'] == 1024
        assert '模型窗口' not in str(e.value) and source == old and calls == []
        assert store.record(quality_key(run, phase, source)) is None
    asyncio.run(scenario())


@pytest.mark.parametrize('cancelled,stage,message,complete,expected', [
    (False, 'quality_review', '文风验收输入超过模型窗口，已保存结果保留；没有截断待审核内容。', True, True),
    (True, 'quality_review', '文风验收输入超过模型窗口，已保存结果保留；没有截断待审核内容。', True, False),
    (False, 'trial', '文风验收输入超过模型窗口，已保存结果保留；没有截断待审核内容。', True, False),
    (False, 'quality_review', '总模型费用预算已耗尽', True, False),
    (False, 'quality_review', '文风验收输入超过模型窗口，已保存结果保留；没有截断待审核内容。', False, False),
])
def test_legacy_local_input_failure_migrates_once_only_with_complete_safe_checkpoint(tmp_path, monkeypatch, cancelled, stage, message, complete, expected):
    store, original, cp = prepare(tmp_path, monkeypatch, status='failed', stage=stage)
    cp['toolchain_state'].update(skillWorkspace={'draftId':'draft'}, stylePlan={},
        styleAnalysisResult={'unitRefs':['unit']}, source={'reviewedEvidence':{'features':[]}}, styleEvidenceAudit={'dossierRef':'ref'})
    if not complete:
        cp['toolchain_state'].pop('styleEvidenceAudit')
    payload = {'code': 'BUDGET_EXCEEDED', 'message': message, 'retryable': False, 'failureRevision': 1}
    state = store.load(); run = state.runs[original.runId]
    run.failure=payload; run.failureRevision=1; run.cancelRequested=cancelled; store.save(state)
    store.append_event(AgentRunEvent(eventId='terminal', runId=run.runId, planId=run.planId, threadId=run.threadId,
        type='run_failed', status='failed', payload=payload))
    runtime=NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store)); run=runtime.state.runs[run.runId]
    if expected:
        assert run.recovery.canRecover and run.recovery.actionLabel == '继续剩余文风审核'
        assert runtime._retryable_failed_run_ref(run.runId).retryable
        assert run.failureRevision == 2
        assert runtime._refresh_readonly_analysis_recovery(run) is False
        assert run.failureRevision == 2 and runtime._run_tasks == {}
        captured = []
        async def resume(run_id, initial_state):
            captured.append(initial_state['toolchain_state'])
        monkeypatch.setattr(runtime, '_run_graph_guarded', resume)
        async def retry():
            resumed = await runtime.retry_run({'failedRunId':run.runId,'expectedFailureRevision':2}, {})
            assert resumed.retryRootRunId == run.runId
            await asyncio.gather(*tuple(runtime._run_tasks.values()))
        asyncio.run(retry())
        assert captured[0] == cp['toolchain_state']
        assert captured[0]['stage'] == 'quality_review' and captured[0]['styleAnalysisResult']['unitRefs'] == ['unit']
    else:
        assert not run.recovery or not run.recovery.canRecover
        assert runtime._retryable_failed_run_ref(run.runId) is None
