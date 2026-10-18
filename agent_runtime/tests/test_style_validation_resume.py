from __future__ import annotations

import asyncio

from novel_agent_runtime.agent_skills.authoring import style_skill_body, style_skill_member_document, STYLE_SKILL_MEMBER_PATHS
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentPlan, AgentPlanStep, AgentRun
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.schemas import StyleSkillPackAuthoringPlan, ToolchainInvocation
from test_style_quality import plan_binding


def test_exhausted_legacy_validate_checkpoint_repairs_before_validation_without_model(tmp_path):
    async def scenario():
        style_plan = StyleSkillPackAuthoringPlan.model_validate(plan_binding())
        body = "## 应用方法\n依据目标场景生成原创正文，未核验的节奏只作为可调建议。"
        documents = {STYLE_SKILL_MEMBER_PATHS[m.draftKey]: style_skill_member_document(m, body, "novel", "novel-1")
            for m in style_plan.skills}
        # The exact class of the real failure: an otherwise populated header
        # has no ending delimiter, and normal validation retries are exhausted.
        documents['language-style/SKILL.md'] = "---\nschemaVersion: novel-editor.agent-skill.v1\nstableId: model.old-id\nsemanticSelection: true\n" + body
        calls = []
        version = 9
        def summary():
            return {"draftId": "saved-draft", "version": version, "status": "editing", "phase": "needs_attention"}
        class Workspace:
            async def invoke(self, method, params, origin, **kwargs):
                if method == 'agent_skill.pack.default.get':
                    return {'packId': None, 'version': 0}
                nonlocal version
                calls.append((method, params))
                if method == 'agent_skill.workspace.list':
                    return summary()
                if method == 'agent_skill.workspace.read':
                    return {**summary(), 'contentText': documents[params['logicalPath']]}
                if method == 'agent_skill.workspace.write':
                    assert params['expectedVersion'] == version
                    documents[params['logicalPath']] = params['contentText']
                    version += 1
                    return summary()
                if method == 'agent_skill.workspace.validate':
                    assert params['expectedVersion'] == version
                    assert params['finalAttempt'] is False, 'a migrated checkpoint must not reuse exhausted format attempts'
                    assert all('\n---\n' in text and 'semanticSelection: suggest' in text for text in documents.values()), 'repair must run before validation'
                    assert all(style_skill_body(text) == body for text in documents.values())
                    version += 1
                    return {**summary(), 'validationReport': {'ok': True, 'diagnostics': []}}
                raise AssertionError(f'Unexpected call (no model, source read or compile is needed): {method}')
        store = AgentStateStore(tmp_path)
        runtime = NovelAgentRuntime(store, Workspace(), AgentEventBus(store))
        step = AgentPlanStep(stepId='step', agent='writer', title='Style', toolchain=ToolchainInvocation(id='agent_skill.style_extract', version='1.0.0', input={}))
        plan = AgentPlan(planId='plan', threadId='thread', title='Style', goal='Style', steps=[step])
        run = AgentRun(runId='run', planId=plan.planId, threadId=plan.threadId, currentStepId=step.stepId, status='running')
        runtime.state.plans[plan.planId] = plan
        runtime.state.runs[run.runId] = run
        chain = {'stage': 'validate', 'stylePlan': style_plan.model_dump(), 'skillWorkspace': summary(),
            'styleValidationAttempt': 3, 'styleAnalysisResult': {'unitRefs': ['already-complete']}, 'styleQualityAttempt': 1}
        result = await runtime._advance_builtin_skill_workflow(run, plan, step, {'novel_id': 'novel-1'}, chain, None)
        resumed = result['toolchain_state']
        assert resumed['stage'] == 'quality_review'
        assert resumed['styleValidationAttempt'] == 1 and resumed['styleDocumentFormatVersion'] == 2
        assert resumed['styleQualityAttempt'] == 1
        assert resumed['styleAnalysisResult']['unitRefs'] == ['already-complete']
        methods = [method for method, _ in calls]
        assert methods.index('agent_skill.workspace.write') < methods.index('agent_skill.workspace.validate')
        assert methods.count('agent_skill.workspace.write') == 1
        # A subsequent validation is idempotent and advances, rather than resets,
        # the bounded format counter. It must not rewrite already managed files.
        calls.clear()
        resumed['stage'] = 'validate'
        again = await runtime._advance_builtin_skill_workflow(run, plan, step, {'novel_id': 'novel-1'}, resumed, None)
        assert again['toolchain_state']['styleValidationAttempt'] == 2
        assert not any(method == 'agent_skill.workspace.write' for method, _ in calls)
    asyncio.run(scenario())
