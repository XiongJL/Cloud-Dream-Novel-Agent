from __future__ import annotations

import asyncio
import pytest

from novel_agent_runtime.agent_skills.errors import AgentSkillError
from novel_agent_runtime.agent_skills.registry import AgentSkillRegistration, AgentSkillRegistry, build_revision
from novel_agent_runtime.agent_skills.schemas import AgentSkillDefinition, AgentSkillRef
from novel_agent_runtime.agent_skills.service import AgentSkillService
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentPlan, AgentPlanStep, AgentRun
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.tool_adapter import FastMcpAgentToolAdapter
from test_runtime import FakeAutomationClient


def setup_runtime(tmp_path):
    store = AgentStateStore(tmp_path)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
    registrations, refs = [], []
    for position in ("primary", "auxiliary"):
        definition = AgentSkillDefinition(
            id=f"skill-{position}", stableId=f"user.method.{position}", title=position,
            description=f"Purpose {position}", scope="user", category="style", origin="authored",
            allowedRoles=("writer",), supportedOperations=("chapter.rewrite",),
        )
        locked = build_revision(
            skill_id=definition.id, revision_id=f"locked-{position}", version="1.0.0",
            instructions=f"Complete method {position}\nEND_OF_METHOD_{position}",
            constraints=(f"CONSTRAINT_{position}",),
            examples=({"input": f"INPUT_{position}", "output": f"OUTPUT_{position}"},),
        )
        newest = build_revision(
            skill_id=definition.id, revision_id=f"newest-{position}", version="2.0.0",
            instructions="NEW_RULES_MUST_NOT_REPLACE_LOCKED_RULES",
        )
        registrations.append(AgentSkillRegistration(definition, (locked, newest), {}, {}))
        refs.append(AgentSkillRef(
            skillId=definition.id, stableId=definition.stableId, revisionId=locked.revisionId,
            version=locked.version, contentHash=locked.contentHash, scope="user",
            selectionSource="shortcut", position=position,
        ))
    runtime.agent_skill_service = AgentSkillService(AgentSkillRegistry(registrations))
    step = AgentPlanStep(stepId="step", agent="writer", title="Rewrite", skills=refs)
    plan = AgentPlan(planId="plan", threadId="thread", title="Rewrite", goal="Rewrite", steps=[step])
    run = AgentRun(runId="run", threadId=plan.threadId, planId=plan.planId, currentStepId=step.stepId, status="running")
    runtime.state.plans[plan.planId] = plan
    runtime.state.runs[run.runId] = run
    return runtime, automation, run, step


@pytest.mark.parametrize("method", sorted(NovelAgentRuntime._SKILL_MODEL_METHODS))
def test_task_model_nodes_receive_complete_locked_primary_and_auxiliary_rules(tmp_path, method):
    runtime, _automation, run, _step = setup_runtime(tmp_path)
    params = asyncio.run(runtime._step_skill_params(run, method, {"goal": "Rewrite"}))
    compiled = params["agentSkill"]
    assert [item["skill"]["revisionId"] for item in compiled["sections"]] == ["locked-primary", "locked-auxiliary"]
    for position in ("primary", "auxiliary"):
        for marker in (f"END_OF_METHOD_{position}", f"CONSTRAINT_{position}", f"INPUT_{position}", f"OUTPUT_{position}"):
            assert marker in compiled["prompt"]
    assert "NEW_RULES_MUST_NOT_REPLACE" not in compiled["prompt"]


def test_real_model_dispatch_and_durable_dispatch_include_the_rules(tmp_path):
    async def scenario():
        runtime, automation, run, _step = setup_runtime(tmp_path)
        await runtime._automation_invoke(run, "agent.generate_chapter_beats", {"goal": "Rewrite"})
        assert "END_OF_METHOD_auxiliary" in automation.calls[-1][1]["agentSkill"]["prompt"]
        received = []

        async def durable(_run, params):
            received.append(params)
            return {"draftSessionId": "draft"}

        runtime._durable_chapter_draft_invoke = durable
        await runtime._tool_invoke(run, "chapter.generate_draft", {"novelId": "novel", "chapterId": "chapter"})
        assert "END_OF_METHOD_primary" in received[0]["agentSkill"]["prompt"]
        runtime.tool_adapter = FastMcpAgentToolAdapter(automation)
        await runtime._tool_invoke(run, "creative_assets.generate_draft", {"novelId": "novel", "brief": "Create"})
        call = next(call for call in reversed(automation.calls) if call[0] == "creative_assets.generate_draft")
        assert "END_OF_METHOD_primary" in call[1]["agentSkill"]["prompt"]

    asyncio.run(scenario())


def test_disabled_steps_and_non_task_nodes_do_not_inherit_rules(tmp_path):
    runtime, _automation, run, step = setup_runtime(tmp_path)
    for method in ("agent.generate_chat", "agent.generate_plan", "agent.generate_report", "agent.generate_skill_document", "chapter.get"):
        assert "agentSkill" not in asyncio.run(runtime._step_skill_params(run, method, {}))
    step.skills = []
    assert "agentSkill" not in asyncio.run(runtime._step_skill_params(run, "chapter.generate_draft", {"agentSkill": {"prompt": "stale"}}))


def test_hash_mismatch_stops_dispatch_before_model_call(tmp_path):
    runtime, automation, run, step = setup_runtime(tmp_path)
    step.skills[0].contentHash = "0" * 64
    with pytest.raises(AgentSkillError, match="hash mismatch"):
        asyncio.run(runtime._automation_invoke(run, "agent.generate_chapter_beats", {}))
    assert automation.calls == []


def test_restarted_runtime_reads_the_exact_old_revision_instead_of_latest(tmp_path):
    async def scenario():
        runtime, automation, run, _step = setup_runtime(tmp_path)
        registrations = list(runtime.agent_skill_service.registry.registrations())
        original = registrations[0]
        locked = original.revisions[0]
        registrations[0] = AgentSkillRegistration(original.definition, (original.revisions[1],), {}, {})
        runtime.agent_skill_service = AgentSkillService(AgentSkillRegistry(registrations))
        calls = []

        async def invoke(method, params, *_args, **_kwargs):
            if method == 'agent_skill.pack.default.get':
                return {'packId': None, 'version': 0}
            calls.append((method, params))
            assert method == "agent_skill.get"
            assert params == {"skillId": original.definition.id, "revisionId": locked.revisionId}
            return {
                **original.definition.model_dump(), "enabled": True,
                "revision": {
                    **locked.model_dump(), "id": locked.revisionId,
                    "manifest": original.definition.model_dump(),
                },
            }

        automation.invoke = invoke
        params = await runtime._step_skill_params(run, "chapter.generate_draft", {})
        assert "END_OF_METHOD_primary" in params["agentSkill"]["prompt"]
        assert "NEW_RULES_MUST_NOT_REPLACE" not in params["agentSkill"]["prompt"]
        assert len(calls) == 1

    asyncio.run(scenario())
