from __future__ import annotations

import asyncio
import pytest
from pydantic import ValidationError

from novel_agent_runtime.agent_skills.compiler import AgentSkillCompiler
from novel_agent_runtime.agent_skills.errors import AgentSkillError
from novel_agent_runtime.agent_skills.registry import AgentSkillRegistration, AgentSkillRegistry, build_revision
from novel_agent_runtime.agent_skills.schemas import AgentSkillDefinition, AgentSkillResolveRequest
from novel_agent_runtime.agent_skills.service import AgentSkillService
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.intent.schemas import IntentEntryHint, IntentRequest, SemanticProposal
from novel_agent_runtime.intent.service import IntentService
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentPlan, AgentPlanStep, AgentRun
from novel_agent_runtime.store import AgentStateStore


def registrations(count=4):
    values = []
    for index in range(count):
        definition = AgentSkillDefinition(
            id=f'method-{index}', stableId=f'user.method-{index}', title=f'Method {index}',
            description=f'Purpose {index}', scope='user', origin='authored', category='style', guidanceMode='adaptive',
            allowedRoles=('writer',), supportedOperations=('chapter.continuation',),
        )
        manifest = {'origin': 'authored', 'category': 'style', 'allowedRoles': ['writer'],
                    'supportedOperations': ['chapter.continuation'], 'guidanceMode': 'adaptive'}
        old = build_revision(skill_id=definition.id, revision_id=f'locked-{index}', version='1.0.0',
                             instructions=f'FULL_METHOD_{index}\nEND_{index}', constraints=(f'CONSTRAINT_{index}',), manifest=manifest)
        new = build_revision(skill_id=definition.id, revision_id=f'latest-{index}', version='2.0.0',
                             instructions=f'NEW_RULES_{index}', manifest=manifest)
        values.append(AgentSkillRegistration(definition, (old, new), {}, {}))
    return values


def selections(count=4):
    return [{'skillId': f'method-{index}', 'requestedRevisionId': f'locked-{index}'} for index in range(count)]


class Native:
    def __init__(self, values):
        self.values = values
        self.calls = []

    async def invoke(self, method, params, *_args, **_kwargs):
        if method == 'agent_skill.pack.default.get':
            return {'packId': None, 'version': 0}
        self.calls.append((method, params))
        if method == 'agent_skill.get':
            registration = next(item for item in self.values if item.definition.id == params['skillId'])
            revision = next(item for item in registration.revisions if item.revisionId == params['revisionId'])
            return {**registration.definition.model_dump(), 'revision': {
                'id': revision.revisionId, 'version': revision.version, 'instructions': revision.instructions,
                'constraints': list(revision.constraints), 'examples': [], 'manifest': revision.manifest,
                'contentHash': revision.contentHash, 'createdAt': revision.createdAt}}
        if method == 'agent.generate_chapter_beats':
            return {'beats': []}
        raise AssertionError('Unexpected model or data call: ' + method)


def test_entry_hint_preserves_many_locked_selections_and_legacy_single():
    hint = IntentEntryHint(actionId='skill.use', kind='skill.use', skills=selections())
    request = IntentRequest(message='续写下一章', conversationId='c', entryHint=hint)
    service = IntentService()
    decision = service.finalize(request, service.preflight(request), SemanticProposal(
        responseContent='生成章节', shouldPlan=True, requestedOperations=['chapter.continuation'], confidence=.95))
    assert [item.model_dump(exclude={'selectionSource'}) for item in decision.requestedSkills] == selections()
    assert IntentEntryHint(actionId='skill.use', kind='skill.use', skillId='one', requestedRevisionId='v1').selected_skills()[0].skillId == 'one'
    with pytest.raises(ValidationError):
        IntentEntryHint(actionId='skill.use', kind='skill.use', skills=[*selections(), selections()[0]])
    with pytest.raises(ValidationError):
        IntentEntryHint(actionId='skill.pack.use', kind='skill.pack.use', packId='pack', skills=selections())


@pytest.mark.parametrize('count', [3, 4, 8])
def test_all_explicit_methods_compile_without_count_truncation(count):
    registry = AgentSkillRegistry(registrations(count))
    service = AgentSkillService(registry)
    result = service.preview({'operationId': 'chapter.continuation', 'roleId': 'writer', 'explicitSkills': selections(count)})
    assert len(result['compiled']['sections']) == count
    for index in range(count):
        assert result['compiled']['prompt'].count(f'END_{index}') == 1
        assert f'CONSTRAINT_{index}' in result['compiled']['prompt']
    assert 'NEW_RULES' not in result['compiled']['prompt']
    resolved = service.resolver.resolve(AgentSkillResolveRequest(operationId='chapter.continuation', roleId='writer', explicitSkills=selections(count)))
    with pytest.raises(AgentSkillError) as failure:
        AgentSkillCompiler(registry, max_estimated_tokens=1).compile(resolved)
    assert failure.value.code == 'AGENT_SKILL_BUDGET_EXCEEDED'


def test_third_selection_is_validated_instead_of_ignored():
    values = registrations()
    values[2].definition.enabled = False
    with pytest.raises(AgentSkillError) as failure:
        AgentSkillService(AgentSkillRegistry(values)).preview({
            'operationId': 'chapter.continuation', 'roleId': 'writer', 'explicitSkills': selections()})
    assert failure.value.code == 'AGENT_SKILL_DISABLED'


def test_many_methods_survive_plan_provider_dispatch_and_cold_reload(tmp_path):
    async def scenario():
        values = registrations()
        native = Native(values)
        store = AgentStateStore(tmp_path)
        runtime = NovelAgentRuntime(store, native, AgentEventBus(store))
        runtime.agent_skill_service = AgentSkillService(AgentSkillRegistry(values))
        service = IntentService()
        request = IntentRequest(message='续写下一章', conversationId='c', entryHint={
            'actionId': 'skill.use', 'kind': 'skill.use', 'skills': selections()})
        decision = service.finalize(request, service.preflight(request), SemanticProposal(
            responseContent='生成章节', shouldPlan=True, requestedOperations=['chapter.continuation'], confidence=.95))
        plan = AgentPlan(planId='plan', threadId='thread', title='写作', goal='续写下一章', steps=[AgentPlanStep(
            stepId='writer', agent='writer', title='写作', toolchain={
                'id': 'chapter.continuation', 'version': '1.0.0', 'input': {'novelId': 'book', 'chapterId': 'chapter'}})])
        plan = runtime._apply_agent_skills_to_plan(plan, decision, locale='zh-CN', novel_id='book')
        assert len(plan.steps[0].skills) == 4
        assert len(runtime._compile_step_skills(plan.steps[0])['sections']) == 4
        run = AgentRun(runId='run', threadId='thread', planId='plan', currentStepId='writer', status='running')
        runtime.state.plans[plan.planId] = plan
        runtime.state.runs[run.runId] = run
        runtime._save()
        await runtime._automation_invoke(run, 'agent.generate_chapter_beats', {'goal': plan.goal})
        assert len(native.calls[-1][1]['agentSkill']['sections']) == 4
        assert 'END_3' in native.calls[-1][1]['agentSkill']['prompt']
        original_prompt = native.calls[-1][1]['agentSkill']['prompt']
        # No cached registration remains: loading a saved plan must fetch every frozen revision.
        cold_store = AgentStateStore(tmp_path)
        cold = NovelAgentRuntime(cold_store, native, AgentEventBus(cold_store))
        cached_run = cold.state.runs[run.runId]
        actual = await cold._step_skill_params(cached_run, 'chapter.generate_draft', {})
        assert [section['skill']['revisionId'] for section in actual['agentSkill']['sections']] == [f'locked-{index}' for index in range(4)]
        assert 'NEW_RULES' not in actual['agentSkill']['prompt']
        assert actual['agentSkill']['prompt'] == original_prompt
        fresh = await cold._chat_skill_selection_context(request.entryHint, 'book')
        assert fresh['mode'] == 'explicit_multiple' and fresh['validated']
        assert len(fresh['skills']) == 4
    asyncio.run(scenario())
