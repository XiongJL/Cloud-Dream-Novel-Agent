"""Ordinal destinations are not batch sizes or existing write targets."""
import asyncio

import pytest
from pydantic import ValidationError

from novel_agent_runtime.intent.rules import requested_created_chapter_count
from novel_agent_runtime.intent.schemas import IntentRequest, IntentSelectionContext, SemanticProposal
from novel_agent_runtime.intent.service import IntentService
from novel_agent_runtime.intent.targets import resolve_intent_chapter_target
from novel_agent_runtime.planner import build_plan_from_intent
from novel_agent_runtime.toolchains.schemas import ChapterSequenceContinuationInput
from test_runtime import create_runtime


def catalog(count=500):
    return [{'chapterId': f'chapter-{n}', 'title': f'第{n}章 顿悟' if n == 500 else f'第{n}章',
             'chapterOrder': n, 'volumeId': 'volume-1', 'volumeOrder': 1} for n in range(1, count + 1)]


def decide(message, target, operation='chapter.continuation'):
    request = IntentRequest(message=message, conversationId='test', role='writer', locale='zh-CN',
        currentSelection=IntentSelectionContext(novelId='novel-1', chapterId='unrelated-open-chapter'),
        requestedTarget=target)
    service = IntentService()
    return service.finalize(request, service.preflight(request), SemanticProposal(responseContent='准备写作',
        shouldPlan=True, requestedOperations=[operation]))


@pytest.mark.parametrize('message', ['开始写第第501章 对峙', '开始写第501章《对峙》', '新建501章，', '新建第501章', '新建第五百零一章'])
def test_next_ordinal_creates_one_after_authorized_tail(message):
    target = resolve_intent_chapter_target(message, catalog(), editor_chapter_id='chapter-12')
    assert target.selector == 'new_chapter_ordinal' and target.chapterId == 'chapter-500'
    assert '新建第501章' in target.label and '续写锚点' in target.label
    decision = decide(message, target)
    assert decision.route == 'plan' and [op.type for op in decision.operations] == ['chapter.create']
    plan = build_plan_from_intent(message, decision, preferred_role='writer', has_chapter=True)
    assert len(plan.steps) == 1
    invocation = plan.steps[0].toolchain
    assert invocation.id == 'chapter.sequence_continuation' and invocation.input['chapterCount'] == 1
    ChapterSequenceContinuationInput(novelId='novel-1', volumeId=target.volumeId, chapterId=target.chapterId,
                                    goal=message, **invocation.input)


@pytest.mark.parametrize('message,count', [('新建2章', 2), ('新建10章', 10), ('连续新写10章', 10), ('连续新建501章', 501), ('新建501个章节', 501)])
def test_explicit_counts_are_not_reduced_to_one(message, count):
    assert requested_created_chapter_count(message) == count
    target = resolve_intent_chapter_target(message, catalog(), editor_chapter_id='chapter-500')
    assert target.selector != 'new_chapter_ordinal'
    plan = build_plan_from_intent(message, decide(message, target, 'chapter.create'), preferred_role='writer', has_chapter=True)
    assert plan.steps[0].toolchain.input['chapterCount'] == count
    if count > 10:
        with pytest.raises(ValidationError):
            ChapterSequenceContinuationInput(novelId='n', volumeId='v', chapterId='c', goal=message, chapterCount=count)


@pytest.mark.parametrize('message', ['新建第500章', '开始写第700章'])
def test_existing_or_gap_creation_never_uses_open_chapter(message):
    target = resolve_intent_chapter_target(message, catalog(), editor_chapter_id='chapter-12')
    assert target.chapterId is None and target.selector == 'new_chapter_ordinal_conflict'
    decision = decide(message, target)
    assert decision.route == 'respond' and decision.operations[0].target.id is None
    assert 'PROJECT_CATALOG_UNAVAILABLE' not in decision.reasonCodes
    assert '已存在' in decision.responseContent or '不能直接跳到' in decision.responseContent


def test_missing_existing_target_is_not_catalog_failure_and_unavailable_still_blocks():
    target = resolve_intent_chapter_target('检查第501章', catalog(), editor_chapter_id='chapter-500')
    decision = decide('检查第501章', target, 'chapter.consistency_review')
    assert decision.route == 'respond' and '共有500章' in decision.responseContent
    assert 'PROJECT_CATALOG_UNAVAILABLE' not in decision.reasonCodes
    unavailable = resolve_intent_chapter_target('新建第501章', [], editor_chapter_id='chapter-500')
    decision = decide('新建第501章', unavailable)
    assert decision.route == 'respond' and decision.operations[0].target.id is None
    assert 'PROJECT_CATALOG_UNAVAILABLE' in decision.reasonCodes


def test_creation_conflict_blocks_even_when_model_omits_operations():
    target = resolve_intent_chapter_target('新建第500章', catalog())
    request = IntentRequest(message='新建第500章', conversationId='test', requestedTarget=target,
        currentSelection=IntentSelectionContext(novelId='novel-1', chapterId='chapter-12'))
    service = IntentService()
    decision = service.finalize(request, service.preflight(request), SemanticProposal(responseContent='准备写', shouldPlan=True))
    assert decision.route == 'respond' and '已存在' in decision.responseContent


def test_negation_and_history_do_not_authorize_a_new_chapter():
    target = resolve_intent_chapter_target('不要开始写第501章，先检查第500章', catalog(), editor_chapter_id='chapter-12')
    assert target.selector != 'new_chapter_ordinal'
    target = resolve_intent_chapter_target('检查当前章\n\n会话背景（仅用于理解当前任务）：\n用户：新建第501章',
        catalog(), editor_chapter_id='chapter-12')
    assert target.chapterId == 'chapter-12' and target.selector != 'new_chapter_ordinal'


def test_read_only_diagnostic_does_not_escalate_to_creation():
    message = '分析开始写第501章为什么报错'
    target = resolve_intent_chapter_target(message, catalog(), editor_chapter_id='chapter-12')
    decision = decide(message, target, 'project.lookup')
    assert all(operation.type != 'chapter.create' for operation in decision.operations)


@pytest.mark.parametrize('message', ['之前回复“开始写第501章”是什么意思', '怎么新建第501章', '讨论新建第501章的方案'])
def test_quoted_or_discussed_creation_is_not_a_new_destination(message):
    target = resolve_intent_chapter_target(message, catalog(), editor_chapter_id='chapter-12')
    assert target.selector != 'new_chapter_ordinal'


def test_model_supplied_count_cannot_override_a_resolved_single_ordinal():
    from novel_agent_runtime.runtime import NovelAgentRuntime
    from novel_agent_runtime.schemas import AgentPlan, AgentPlanStep
    from novel_agent_runtime.toolchains.schemas import ToolchainInvocation
    target = resolve_intent_chapter_target('新建501章', catalog())
    plan = AgentPlan(planId='p', threadId='t', goal='新建501章', title='新章',
        steps=[AgentPlanStep(stepId='s', agent='writer', title='新章', tools=[],
            toolchain=ToolchainInvocation(id='chapter.sequence_continuation', version='1.0.0', input={'chapterCount': 501}))])
    fixed = NovelAgentRuntime._apply_fallback_resolved_target(plan, target)
    assert fixed.steps[0].toolchain.input['chapterCount'] == 1
    assert fixed.steps[0].toolchain.input['chapterId'] == 'chapter-500'


def test_authoritative_catalog_failure_never_executes_against_renderer_anchor(tmp_path):
    async def scenario():
        runtime, automation = create_runtime(tmp_path)
        original = automation.invoke
        async def invoke(method, params, origin, request_id=None, **kwargs):
            if method == 'volume.list':
                raise RuntimeError('catalog offline')
            return await original(method, params, origin, request_id=request_id, **kwargs)
        automation.invoke = invoke
        response = await runtime.chat({'message': '新建第501章', 'novelId': 'novel-1', 'conversationId': 'offline',
            'chapterId': 'chapter-12', 'role': 'writer', 'chapterCatalog': catalog()}, {})
        assert response.intentDecision.route == 'respond'
        assert response.intentDecision.operations[0].target.id is None
        assert 'PROJECT_CATALOG_UNAVAILABLE' in response.intentDecision.reasonCodes
        assert not any(method in {'chapter.generate_draft', 'chapter.save'} for method, _, _ in automation.calls)
    asyncio.run(scenario())


@pytest.mark.parametrize('message', ['开始写第第501章 对峙', '新建501章，'])
def test_chat_to_plan_reads_authoritative_catalog_and_creates_one_with_frozen_target(tmp_path, message):
    async def scenario():
        runtime, automation = create_runtime(tmp_path)
        original = automation.invoke
        async def invoke(method, params, origin, request_id=None, **kwargs):
            if method == 'volume.list':
                automation.calls.append((method, params, origin))
                return catalog()
            if method == 'agent.generate_chat':
                automation.calls.append((method, params, origin))
                assert params['selectionContext']['operationTarget']['chapterId'] == 'chapter-500'
                return {'content': '以500章为前文新建501章', 'shouldPlan': True, 'needsClarification': False,
                        'requestedOperations': ['chapter.continuation']}
            return await original(method, params, origin, request_id=request_id, **kwargs)
        automation.invoke = invoke
        # Renderer is incomplete and has a different chapter open.
        response = await runtime.chat({'message': message, 'novelId': 'novel-1', 'conversationId': 'conv-new-501',
            'chapterId': 'chapter-12', 'volumeId': 'volume-1', 'role': 'writer', 'chapterCatalog': catalog(12)}, {})
        assert response.intentDecision.route == 'plan'
        plan = await runtime.plan({'goal': message + '\n\n会话背景（仅用于理解当前任务）：\n用户：新建501章',
            'novelId': 'novel-1', 'conversationId': 'conv-new-501', 'chapterId': 'chapter-12', 'role': 'writer'}, {})
        chain = plan.steps[0].toolchain
        assert chain.id == 'chapter.sequence_continuation'
        assert chain.input['chapterCount'] == 1 and chain.input['chapterId'] == 'chapter-500'
        assert '新建第501章' in chain.input['_resolvedTarget']['label']
        assert any(method == 'volume.list' for method, _, _ in automation.calls)
        assert not any(method in {'agent.generate_plan', 'chapter.generate_draft', 'chapter.save'} for method, _, _ in automation.calls)
    asyncio.run(scenario())


def test_destination_added_after_chat_blocks_stale_creation_plan(tmp_path):
    from novel_agent_runtime.retry import AgentRequestError
    async def scenario():
        runtime, automation = create_runtime(tmp_path)
        original = automation.invoke
        count = 500
        async def invoke(method, params, origin, request_id=None, **kwargs):
            if method == 'volume.list':
                return catalog(count)
            return await original(method, params, origin, request_id=request_id, **kwargs)
        automation.invoke = invoke
        response = await runtime.chat({'message': '新建第501章', 'novelId': 'novel-1', 'conversationId': 'concurrent',
            'role': 'writer', 'chapterCatalog': catalog()}, {})
        assert response.intentDecision.route == 'plan'
        count = 501
        with pytest.raises(AgentRequestError, match='已存在'):
            await runtime.plan({'goal': '新建第501章', 'novelId': 'novel-1', 'conversationId': 'concurrent', 'role': 'writer'}, {})
    asyncio.run(scenario())
