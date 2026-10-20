from __future__ import annotations
import asyncio
import copy
import pytest
from pydantic import ValidationError
from novel_agent_runtime.agent_skills.packs import SkillPackRequest, resolve_pack
from novel_agent_runtime.agent_skills.pack_routing import normalize_style_routing, writing_combinations
from novel_agent_runtime.agent_skills.errors import AgentSkillError
from novel_agent_runtime.agent_skills.registry import build_revision
from novel_agent_runtime.intent.schemas import IntentEntryHint, IntentDecision, IntentRequest, SemanticProposal
from novel_agent_runtime.intent.service import IntentService
from novel_agent_runtime.schemas import AgentPlan, AgentPlanStep
from novel_agent_runtime.toolchains.schemas import ToolchainInvocation, StyleSkillPackAuthoringPlan
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.events import AgentEventBus
from test_style_quality import plan_binding


def packet(identity='A'):
    members=[];full={}
    for key,slot in [('language','core'),('suspense','auxiliary'),('ensemble','auxiliary')]:
        skill=identity+'-'+key
        manifest={'category':'style','guidanceMode':'guided','semanticSelection':'suggest','origin':'authored',
            'triggerHints':['写作'],'antiTriggerHints':['检索'],'supportedOperations':['chapter.continuation'],'allowedRoles':['writer'],'outputType':'none'}
        r=build_revision(skill_id=skill,revision_id=skill+'-v1',version='1.0.0',instructions='完整规则：'+key,manifest=manifest)
        members.append(dict(memberKey=key,skillId=skill,stableId=skill.lower(),revisionId=r.revisionId,contentHash=r.contentHash,version=r.version,
            title=key,slot=slot,enabled=True,supportedOperations=['chapter.continuation'],allowedRoles=['writer']))
        full[skill]={'id':skill,'stableId':skill.lower(),'title':key,'description':key,'scope':'user','enabled':True,
            'revision':{'id':r.revisionId,'version':r.version,'contentHash':r.contentHash,'createdAt':r.createdAt,'instructions':r.instructions,'manifest':manifest}}
    return dict(id=identity,title=identity,scope='user',enabled=True,available=True,version='1.0.0',revisionId=identity+'-rev',contentHash='a'*64,
        members=members,bindings=[{'operationId':'chapter.continuation','roleId':'writer','primary':members[0],'auxiliary':members[1],
            'allowedAuxiliaryMemberKeys':['suspense','ensemble']}]),full


@pytest.mark.parametrize('mode,key,expected',[('default',None,['language','suspense']),('none',None,['language']),('member','ensemble',['language','ensemble'])])
def test_pack_selection_is_atomic_and_exact_revision(mode,key,expected):
    p,_=packet();old=copy.deepcopy(p)
    refs,s=resolve_pack(p,SkillPackRequest(packId='A',requestedPackRevisionId='A-rev',auxiliaryMode=mode,auxiliaryMemberKey=key),'chapter.continuation','writer','book')
    assert [r.skillId for r in refs]==['A-'+x for x in expected]
    assert all(r.revisionId.endswith('-v1') for r in refs) and s['applicable']
    assert p==old


@pytest.mark.parametrize('change,code',[
    ({'available':False},'AGENT_SKILL_PACK_UNAVAILABLE'),
    ({'scope':'novel','ownerNovelId':'different'},'AGENT_SKILL_PACK_SCOPE_MISMATCH'),
    ({'revisionId':'other'},'AGENT_SKILL_PACK_VERSION_UNAVAILABLE'),
])
def test_unavailable_pack_never_falls_back(change,code):
    p,_=packet();p.update(change)
    with pytest.raises(AgentSkillError) as e:
        resolve_pack(p,SkillPackRequest(packId='A',requestedPackRevisionId='A-rev'),'chapter.continuation','writer','book')
    assert e.value.code==code


def test_override_validation_and_nonapplicable_steps():
    p,_=packet()
    with pytest.raises(AgentSkillError):
        resolve_pack(p,SkillPackRequest(packId='A',auxiliaryMode='member',auxiliaryMemberKey='foreign'),'chapter.continuation','writer','book')
    refs,selection=resolve_pack(p,SkillPackRequest(packId='A'),'worldbuilding.analysis','worldbuilder','book')
    assert refs==[] and not selection['applicable']
    with pytest.raises(ValidationError):IntentEntryHint(actionId='x',kind='skill.pack.use',packId='A',skillId='single')


def test_structured_pack_identity_survives_intent_without_model_expansion():
    service=IntentService();req=IntentRequest(message='继续写',conversationId='c',entryHint={'actionId':'skill.pack.use','kind':'skill.pack.use','packId':'A','requestedPackRevisionId':'A-rev'},currentSelection={'novelId':'book','chapterId':'ch'})
    decision=service.finalize(req,service.preflight(req),SemanticProposal(shouldPlan=True,requestedOperations=['chapter.continuation'],confidence=.95,responseContent='续写'))
    assert decision.requestedSkillPack['packId']=='A' and not decision.requestedSkills


def test_runtime_plan_replaces_competing_flat_bindings_and_compiles_only_selected_pack(tmp_path):
    async def scenario():
        p,full=packet();calls=[]
        class Native:
            async def invoke(self,method,params,origin,**_):
                calls.append((method,params))
                if method=='agent_skill.pack.get':return p
                if method=='agent_skill.get':return full[params['skillId']]
                raise AssertionError('No model or other pack allowed: '+method)
        store=AgentStateStore(tmp_path);runtime=NovelAgentRuntime(store,Native(),AgentEventBus(store))
        step=AgentPlanStep(stepId='s',agent='writer',title='Write',toolchain=ToolchainInvocation(id='chapter.continuation',version='1.0.0',input={}))
        plan=AgentPlan(planId='p',threadId='t',title='Write',goal='Write',steps=[step])
        decision=IntentDecision(interaction='task',route='plan',responseContent='',requestedSkillPack={'packId':'A','requestedPackRevisionId':'A-rev'})
        result=await runtime._apply_pack_to_plan(plan,decision,'book')
        assert [r.skillId for r in result.steps[0].skills]==['A-language','A-suspense']
        assert result.steps[0].skillPackSelection['revisionId']=='A-rev'
        # A later membership/current-revision change cannot mutate this plan.
        p['revisionId']='A-new'
        assert result.steps[0].skillPackSelection['revisionId']=='A-rev'
        for ref in result.steps[0].skills:assert runtime.agent_skill_service.registry.revision(ref.skillId,ref.revisionId).instructions.startswith('完整规则')
        assert not any('generate' in m for m,_ in calls)
        calls.clear()
        await runtime._apply_pack_to_plan(plan,IntentDecision(interaction='task',route='plan',responseContent='',disabledSkillsForTurn=True),'book')
        assert calls==[]
    asyncio.run(scenario())


def test_new_style_routes_preserve_language_core_without_modifying_legacy_plan():
    p=StyleSkillPackAuthoringPlan.model_validate(plan_binding())
    p.pack.bindings[0].primaryDraftKey='suspense_release';p.pack.bindings[0].auxiliaryDraftKey='language_style'
    old=copy.deepcopy(p)
    routing=normalize_style_routing(p)
    assert p.pack.bindings[0].primaryDraftKey=='language_style' and old.pack.bindings[0].primaryDraftKey=='suspense_release'
    assert list(writing_combinations(p,routing))==[('language_style','suspense_release')]


def test_http_pack_catalog_preview_and_default_without_client_opt_in(tmp_path):
    from fastapi.testclient import TestClient
    from novel_agent_runtime.main import build_app
    from test_runtime import FakeAutomationClient
    p,full=packet();calls=[]
    class Native(FakeAutomationClient):
        async def invoke(self,method,params,origin,**kwargs):
            calls.append(method)
            if method=='agent_skill.pack.list':return [p]
            if method=='agent_skill.pack.get':return p
            if method=='agent_skill.pack.default.get':return {'novelId':'book','packId':'A','packRevisionId':'A-rev','version':1,'enabled':True,'operationPairs':[{'operationId':'chapter.continuation','roleId':'writer'}]}
            if method=='agent_skill.get':return full[params['skillId']]
            return await super().invoke(method,params,origin,**kwargs)
    store=AgentStateStore(tmp_path);runtime=NovelAgentRuntime(store,Native(),AgentEventBus(store))
    step=AgentPlanStep(stepId='s',agent='writer',title='Write',toolchain=ToolchainInvocation(id='chapter.continuation',version='1.0.0',input={}))
    plan=AgentPlan(planId='p',threadId='t',title='Write',goal='Write',steps=[step])
    initial=asyncio.run(runtime._apply_pack_to_plan(plan,None,'book'))
    assert initial.steps[0].skillPackSelection['source']=='novel_default'
    assert calls[0]=='agent_skill.pack.default.get', 'default selection must not depend on a previous UI catalog request'
    with TestClient(build_app(runtime,None)) as client:
        assert 'agent.skill.packs' in client.get('/health').json()['data']['capabilities']
        listed=client.post('/invoke',json={'method':'agent.skill.packs','params':{'novelId':'book'}}).json()
        assert listed['ok'] and listed['data'][0]['id']=='A'
        preview=client.post('/invoke',json={'method':'agent.skill.pack.preview','params':{'packId':'A','requestedPackRevisionId':'A-rev','novelId':'book','operationId':'chapter.continuation','roleId':'writer','auxiliaryMode':'member','auxiliaryMemberKey':'ensemble'}}).json()
        assert preview['ok'],preview
        assert [r['skillId'] for r in preview['data']['skills']]==['A-language','A-ensemble']
        default=client.post('/invoke',json={'method':'agent.skill.pack.default.get','params':{'novelId':'book'}}).json()
        assert default['ok'] and default['data']['packId']=='A'
    selected=asyncio.run(runtime._apply_pack_to_plan(plan,None,'book'))
    assert selected.steps[0].skillPackSelection['source']=='novel_default'
    assert selected.steps[0].skills[0].revisionId=='A-language-v1'
    assert not any('generate' in name for name in calls)


@pytest.mark.parametrize('code', ['METHOD_NOT_FOUND', 'UNKNOWN_METHOD', 'NOT_IMPLEMENTED'])
def test_missing_default_service_is_not_silently_ignored(tmp_path, code):
    from novel_agent_runtime.automation import AutomationInvokeError

    async def scenario():
        class Native:
            async def invoke(self, method, params, origin, **_):
                assert method == 'agent_skill.pack.default.get'
                raise AutomationInvokeError(code, 'default service unavailable')
        store = AgentStateStore(tmp_path)
        runtime = NovelAgentRuntime(store, Native(), AgentEventBus(store))
        plan = AgentPlan(planId='p', threadId='t', title='write', goal='write', steps=[
            AgentPlanStep(stepId='s', agent='writer', title='write', tools=['chapter.get'])])
        with pytest.raises(AutomationInvokeError) as failure:
            await runtime._apply_pack_to_plan(plan, None, 'book')
        assert failure.value.code == code
        assert runtime.state.runs == {}

    asyncio.run(scenario())
