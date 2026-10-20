from __future__ import annotations

import asyncio
import copy
import pytest
from fastapi.testclient import TestClient
from novel_agent_runtime.main import build_app
from novel_agent_runtime.toolchains.schemas import StyleSkillExtractionInput, ToolchainInvocation
from novel_agent_runtime.intent.schemas import IntentRequest, SemanticProposal
from novel_agent_runtime.intent.service import IntentService
from novel_agent_runtime.schemas import AgentPlan, AgentPlanStep
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.agent_skills.errors import AgentSkillError
from test_skill_model_consumption import setup_runtime


def test_publication_scope_is_distinct_from_source_and_preserves_legacy_serialization():
    base={'sourceMode':'named_work_model_prior','sourceWorkTitle':'样本作品','novelId':'a','goal':'提炼方法'}
    legacy=StyleSkillExtractionInput.model_validate(base).model_dump()
    assert 'publicationScope' not in legacy
    for scope in ('user','novel'):
        explicit=StyleSkillExtractionInput.model_validate({**base,'publicationScope':scope}).model_dump()
        assert explicit.pop('publicationScope')==scope and explicit==legacy
    with pytest.raises(ValueError):StyleSkillExtractionInput.model_validate({**base,'novelId':None,'publicationScope':'novel'})


def test_structured_scope_survives_intent_and_plan_without_model_guessing():
    req=IntentRequest(message='提炼文风',conversationId='c',entryHint={'actionId':'style','kind':'operation','operationIds':['agent_skill.style_extract'],'publicationScope':'user'},currentSelection={'novelId':'a'})
    service=IntentService();decision=service.finalize(req,service.preflight(req),SemanticProposal(responseContent='提炼',shouldPlan=True,requestedOperations=['agent_skill.style_extract'],confidence=.95))
    assert decision.publicationScope=='user'
    p=AgentPlan(planId='p',threadId='t',title='style',goal='style',steps=[AgentPlanStep(stepId='s',agent='writer',title='style',toolchain=ToolchainInvocation(id='agent_skill.style_extract',version='1.0.0',input={'goal':'style'}))])
    original=copy.deepcopy(p)
    result=NovelAgentRuntime._apply_publication_scope(p,'user','a')
    assert result.steps[0].toolchain.input['novelId']=='a'
    assert result.steps[0].toolchain.input['publicationScope']=='user' and p==original
    assert NovelAgentRuntime._apply_publication_scope(p,None)==p


@pytest.mark.parametrize('allowed',[True,False,'incomplete'])
def test_execute_rechecks_visibility_before_start_and_freezes_authorization(tmp_path,allowed):
    async def scenario():
        runtime,automation,old_run,step=setup_runtime(tmp_path)
        plan=runtime.state.plans[old_run.planId]
        step.tools=['chapter.get'];plan.requestedEffect='read_only'
        snapshot=[{**ref.model_dump(),'novelId':'a','ownerNovelId':None,'visibilityVersion':2} for ref in step.skills]
        calls=[]
        async def invoke(method,params,*_,**__):
            calls.append(method)
            assert method=='agent_skill.visibility.check'
            if allowed is False:raise ValueError('Skill 可见范围已变化，请重新选择。')
            return snapshot if allowed is True else []
        automation.invoke=invoke
        async def worker(run_id,**_):runtime.state.runs[run_id].status='completed'
        runtime._run_graph_guarded=worker
        request={'planId':plan.planId,'novelId':'a','skillVisibilityEnabled':False,
                 'approval':{'approved':True,'approvedStepIds':['step']}}
        before=set(runtime.state.runs)
        if allowed is False:
            with pytest.raises(ValueError,match='可见范围'):await runtime.execute_plan(request,{})
            assert set(runtime.state.runs)==before
        elif allowed=='incomplete':
            with pytest.raises(AgentSkillError,match='范围校验'):await runtime.execute_plan(request,{})
            assert set(runtime.state.runs)==before
        else:
            started=await runtime.execute_plan(request,{})
            assert started.skillAccessSnapshot==snapshot
            await asyncio.gather(*runtime._run_tasks.values())
            loaded=type(started).model_validate(started.model_dump())
            assert loaded.skillAccessSnapshot==snapshot
            # A started run uses its immutable revisions after a scope change.
            calls.clear()
            loaded.currentStepId='step'
            params=await runtime._step_skill_params(loaded,'chapter.generate_draft',{})
            assert 'END_OF_METHOD_primary' in params['agentSkill']['prompt'] and not calls
        assert calls in (['agent_skill.visibility.check'],[])
    asyncio.run(scenario())


def test_visibility_http_mutation_clears_current_registry_without_model_calls(tmp_path):
    runtime,automation,_,_=setup_runtime(tmp_path);calls=[]
    async def invoke(method,params,*_,**__):
        calls.append(method)
        return {'title':'方法','scope':'user','visibilityVersion':2}
    automation.invoke=invoke
    with TestClient(build_app(runtime,None)) as client:
        assert 'agent.skill.visibility' in client.get('/health').json()['data']['capabilities']
        response=client.post('/invoke',json={'method':'agent.skill.visibility.set','params':{'targetType':'skill','targetId':'skill-primary','scope':'user'}}).json()
        assert response['ok'],response
        assert runtime.agent_skill_service.registry.require('builtin.style-skill-extractor')
        with pytest.raises(AgentSkillError):runtime.agent_skill_service.registry.require('skill-primary')
    assert calls==['agent_skill.visibility.set']
