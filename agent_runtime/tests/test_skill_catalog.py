from __future__ import annotations

import asyncio
import copy

from novel_agent_runtime.agent_skills.registry import build_revision
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.intent.schemas import IntentRequest, SemanticProposal
from novel_agent_runtime.intent.service import IntentService
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore


class CatalogAutomation:
    def __init__(self):
        revision = build_revision(skill_id='method-a', revision_id='revision-a', version='1.0.0',
            instructions='完整方法正文，不属于菜单索引。', manifest={
                'supportedOperations': ['chapter.continuation'], 'allowedRoles': ['writer'],
                'category': 'style', 'guidanceMode': 'adaptive',
            }).model_dump()
        revision['id'] = revision.pop('revisionId')
        self.full = {'id': 'method-a', 'stableId': 'method-a', 'title': '方法 A',
            'description': '场景续写方法', 'scope': 'novel', 'ownerNovelId': 'a',
            'enabled': True, 'revision': revision}
        self.calls = []
        self.removed = False

    async def invoke(self, method, params, *_, **__):
        if method == 'agent_skill.pack.default.get':
            return {'packId': None, 'version': 0}
        self.calls.append(method)
        if method == 'agent_skill.list':
            if self.removed or (self.full['scope'] == 'novel' and params.get('novelId') != self.full['ownerNovelId']):
                return []
            return [{**{k: v for k, v in self.full.items() if k != 'revision'},
                **{k: self.full['revision'][k] for k in ('version', 'manifest', 'contentHash')},
                'revisionId': self.full['revision']['id']}]
        if method == 'agent_skill.get':
            return copy.deepcopy(self.full)
        if method == 'agent_skill.binding.list':
            return []
        raise AssertionError(f'Unexpected method/model call: {method}')


def make_runtime(tmp_path):
    store = AgentStateStore(tmp_path)
    automation = CatalogAutomation()
    return NovelAgentRuntime(store, automation, AgentEventBus(store)), automation


def test_menu_reads_only_metadata_and_does_not_mutate_execution_registry(tmp_path):
    async def scenario():
        runtime, automation = make_runtime(tmp_path)
        entries = await runtime.skills({'novelId': 'a'}, {})
        own = next(e for e in entries if e['id'] == 'method-a')
        assert own['revisionId'] == 'revision-a' and own['scope'] == 'novel'
        assert not {'instructions', 'examples', 'constraints', 'manifest'} & own.keys()
        assert automation.calls == ['agent_skill.list']
        assert runtime.agent_skill_service.registry.get('method-a') is None
        await runtime._refresh_persisted_skills('a')
        registry = runtime.agent_skill_service
        automation.calls.clear()
        assert not any(e['id'] == 'method-a' for e in await runtime.skills({'novelId': 'b'}, {}))
        assert runtime.agent_skill_service is registry
        assert automation.calls == ['agent_skill.list']
    asyncio.run(scenario())


def test_preview_loads_full_body_and_reuses_unchanged_revisions(tmp_path):
    async def scenario():
        runtime, automation = make_runtime(tmp_path)
        params = {'novelId': 'a', 'operationId': 'chapter.continuation', 'roleId': 'writer',
            'explicitSkills': [{'skillId': 'method-a'}]}
        preview = await runtime.preview_skill(params)
        assert '完整方法正文' in preview['compiled']['prompt']
        assert automation.calls.count('agent_skill.get') == 1
        automation.calls.clear()
        assert await runtime.preview_skill(params) == preview
        assert automation.calls == ['agent_skill.list', 'agent_skill.binding.list']
        # Live metadata changes still invalidate body registrations.
        automation.full['title'] = '方法已更名'
        await runtime.preview_skill(params)
        assert automation.calls.count('agent_skill.get') == 1
        assert runtime.agent_skill_service.registry.require('method-a').definition.title == '方法已更名'
        automation.removed = True
        await runtime._refresh_persisted_skills('a')
        assert runtime.agent_skill_service.registry.get('method-a') is None
    asyncio.run(scenario())


def test_new_revision_is_loaded_and_menu_validates_capabilities(tmp_path):
    async def scenario():
        runtime, automation = make_runtime(tmp_path)
        await runtime._refresh_persisted_skills('a')
        newer = build_revision(skill_id='method-a', revision_id='revision-b', version='1.1.0',
            instructions='更新后的完整方法。', manifest=automation.full['revision']['manifest']).model_dump()
        newer['id'] = newer.pop('revisionId')
        automation.full['revision'] = newer
        await runtime._refresh_persisted_skills('a')
        assert automation.calls.count('agent_skill.get') == 2
        assert runtime.agent_skill_service.registry.revision('method-a').revisionId == 'revision-b'
        automation.full['revision']['manifest']['supportedOperations'] = ['does.not.exist']
        assert not any(e['id'] == 'method-a' for e in await runtime.skills({'novelId': 'a'}, {}))
    asyncio.run(scenario())


def test_planning_selected_skill_works_without_opening_menu(tmp_path):
    async def scenario():
        runtime, automation = make_runtime(tmp_path)
        service = IntentService()
        request = IntentRequest(message='续写当前章节', conversationId='c', role='writer',
            entryHint={'actionId': 'skill.use', 'kind': 'skill.use', 'skillId': 'method-a'},
            currentSelection={'novelId': 'a', 'chapterId': 'ch', 'chapterTitle': '当前章',
                'chapterWordCount': 100, 'chapterHasContent': True})
        decision = service.finalize(request, service.preflight(request), SemanticProposal(
            responseContent='续写', shouldPlan=True, requestedOperations=['chapter.continuation'], confidence=.95))
        plan = await runtime.plan({'goal': '续写当前章节', 'role': 'writer', 'novelId': 'a',
            'chapterId': 'ch', 'intentDecision': decision.model_dump()}, {})
        ref = plan.steps[0].skills[0]
        assert ref.skillId == 'method-a' and ref.revisionId == 'revision-a'
        assert '完整方法正文' in runtime._compile_step_skills(plan.steps[0])['prompt']
        assert automation.calls == ['agent_skill.list', 'agent_skill.get', 'agent_skill.binding.list']
    asyncio.run(scenario())
