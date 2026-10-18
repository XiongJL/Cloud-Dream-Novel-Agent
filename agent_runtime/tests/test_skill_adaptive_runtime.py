from __future__ import annotations

import asyncio
import sqlite3
from collections import Counter
from datetime import datetime, timezone

import pytest

from novel_agent_runtime.agent_skills.registry import AgentSkillRegistration, AgentSkillRegistry, build_revision
from novel_agent_runtime.agent_skills.schemas import AgentSkillDefinition, AgentSkillRef
from novel_agent_runtime.agent_skills.service import AgentSkillService
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentPlan, AgentPlanStep
from novel_agent_runtime.skill_execution import STYLE_EXECUTION_HINTS
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.toolchains.schemas import ToolchainInvocation
from test_chapter_scope_context import _scope_bundle
from test_editor_range_review import _model_review
from test_runtime import FakeAutomationClient


@pytest.mark.parametrize("routing", ["independent", "ordered", "global", "unmarked", "recover", "expert_retry", "publish_retry"])
@pytest.mark.parametrize("operation,role,artifact_type", [
    ("editor.range_review", "editor", "chapter_range_review"),
    ("writer.range_revision_plan", "writer", "writer_revision_plan"),
    ("worldbuilding.range_consistency", "worldbuilding", "worldbuilding_consistency"),
])
def test_user_skill_runtime_routing_preserves_methods_and_legacy_flow(tmp_path, routing, operation, role, artifact_type):
    async def scenario():
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        assert not (tmp_path / "agent_skill_units.db").exists(), "Optional Skill storage must be lazy"
        if routing == "unmarked":
            (tmp_path / "agent_skill_units.db").write_bytes(b"corrupted optional cache")
        definition = AgentSkillDefinition(id="user-analysis", stableId="user.analysis", title="Analysis",
            description="Read-only chapter analysis", scope="user", category="review", origin="authored",
            allowedRoles=(role,), supportedOperations=(operation,))
        revision = build_revision(skill_id=definition.id, revision_id="user-analysis@1", version="1.0.0",
            instructions="USER_METHOD_MUST_REACH_EVERY_WORKER", manifest={} if routing == "unmarked" else
            {"executionHints": STYLE_EXECUTION_HINTS.model_dump()})
        runtime.agent_skill_service = AgentSkillService(AgentSkillRegistry([
            AgentSkillRegistration(definition, (revision,), {}, {})]))
        ref = AgentSkillRef(skillId=definition.id, stableId=definition.stableId, revisionId=revision.revisionId,
            version=revision.version, contentHash=revision.contentHash, scope="user", position="primary", selectionSource="shortcut")
        step = AgentPlanStep(stepId="review", agent=role, title="Local method analysis", skills=[ref],
            toolchain=ToolchainInvocation(id=operation, version="1.0.0", input={
                "kind": "selected_chapters", "chapterIds": ["chapter_1", "chapter_2", "chapter_3"], "anchorChapterId": "chapter_2"}))
        plan = AgentPlan(planId="plan", threadId="thread", title="Method review", goal="Analyze local prose",
            steps=[step], deliverable="expert_report", requestedEffect="read_only")
        runtime.state.plans[plan.planId] = plan
        methods, previous_sources = [], []
        expert_method = {"editor": "agent.generate_editor_range_review", "writer": "agent.generate_writer_range_revision_plan",
            "worldbuilding": "agent.generate_worldbuilding_range_consistency"}[role]
        unit_calls = Counter()
        original = automation.invoke

        async def invoke(method, params, origin, request_id=None, **kwargs):
            methods.append(method)
            if method == "agent_skill.visibility.check":
                return [{**skill, "novelId": params["novelId"], "ownerNovelId": None,
                         "visibilityVersion": 1} for skill in params["skills"]]
            if method == "chapter.scope_context.build":
                bundle = _scope_bundle()
                if params.get("representation") == "catalog":
                    for item in bundle["chapters"]:
                        item.update(content="", contentMode="catalog")
                    bundle["narrativeSummaries"] = []
                    bundle["entityContext"] = {}
                    bundle["plotContext"] = {}
                elif params.get("representation") == "verbatim":
                    bundle["chapters"] = [item for item in bundle["chapters"] if item["chapterId"] == params["chapterId"]]
                return bundle
            if method == "agent.get_skill_execution_policy":
                return {"maxInputBytes": 48000, "outputReserveTokens": 32768, "maxConcurrency": 3,
                    "maxModelCalls": 2048, "maxTotalTokens": 64000000}
            if method == "agent.plan_skill_execution":
                assert "USER_METHOD_MUST_REACH_EVERY_WORKER" in params["agentSkill"]["prompt"]
                return {"executionMode": "delegated", "dependency": {"independent": "none", "ordered": "ordered", "global": "global", "recover": "none", "expert_retry": "none", "publish_retry": "none"}[routing],
                    "reason": "Task dependency assessment"}
            if method in {"agent.analyze_skill_work_unit", "agent.merge_skill_analysis"}:
                assert "USER_METHOD_MUST_REACH_EVERY_WORKER" in params["agentSkill"]["prompt"]
                if method == "agent.analyze_skill_work_unit":
                    previous_sources.append(params["source"].get("previous"))
                    sample = params["source"]["samples"][0]
                    unit_calls[sample["sourceId"]] += 1
                    return {"summary": "Verified local prose", "findings": [{"dimension": "method", "observation": "Exact source observation",
                        "confidence": "medium", "evidence": [{"sourceId": sample["sourceId"],
                            "excerpt": "伪造引文" if routing == "recover" and sample["sourceId"] == "chapter_2" and unit_calls["chapter_2"] == 1 else "正文"}]}], "warnings": []}
                return params["source"]["results"][0]
            if method == expert_method:
                assert "USER_METHOD_MUST_REACH_EVERY_WORKER" in params["agentSkill"]["prompt"]
                if routing == "expert_retry" and methods.count(method) == 1:
                    raise ValueError("expert phase failed before returning a result")
                review = _model_review()
                if role == "worldbuilding":
                    review.update(consistencyScore=74, entityAssessments=[])
                    review["findings"][0]["category"] = "other"
                if params["scopeBundle"].get("skillAnalysis"):
                    review["candidateDecisions"] = [{"findingRef": item["findingRef"], "status": "confirmed", "reason": "Checked source"}
                        for item in params["scopeBundle"]["skillAnalysis"]["candidates"]]
                    review["findings"][0]["evidence"][0]["excerpt"] = "正文"
                    assert params["scopeBundle"]["entityContext"]["characters"]
                return review
            return await original(method, params, origin, request_id=request_id)

        automation.invoke = invoke
        published_ids = []
        if routing == "publish_retry":
            original_publish = runtime._publish_artifact
            original_emit = runtime._emit
            async def emit(run, event_type, **kwargs):
                if event_type == "artifact_created" and kwargs.get("payload", {}).get("artifact", {}).get("metadata", {}).get("skillAnalysis"):
                    raise ValueError("failure after artifact creation before event persistence")
                return await original_emit(run, event_type, **kwargs)
            runtime._emit = emit
            async def publish(*args, **kwargs):
                try:
                    artifact = await original_publish(*args, **kwargs)
                except Exception:
                    published_ids.append(args[0].artifacts[-1].artifactId)
                    runtime._emit = original_emit
                    raise
                if kwargs.get("metadata", {}).get("skillAnalysis"):
                    published_ids.append(artifact.artifactId)
                return artifact
            runtime._publish_artifact = publish
        run = await runtime.execute_plan({"planId": plan.planId, "novelId": "novel_1", "chapterId": "chapter_2",
            "approval": {"approved": True, "approvedStepIds": [step.stepId]}}, {})
        for _ in range(1000):
            if run.status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)
        if routing in {"recover", "expert_retry", "publish_retry"}:
            assert run.status == "failed"
            terminal = next(item for item in reversed(run.events) if item.type == "run_failed")
            assert terminal.payload["retryable"] is True
            run = await runtime.retry_run({"failedRunId": run.runId, "expectedFailureRevision": run.failureRevision}, {})
            for _ in range(1000):
                if run.status in {"completed", "failed", "cancelled"}:
                    break
                await asyncio.sleep(0.01)
            assert methods.count("agent.plan_skill_execution") == 1
            assert unit_calls == Counter({"chapter_1": 1, "chapter_2": 2 if routing == "recover" else 1, "chapter_3": 1})
        assert run.status == "completed", [(item.type, item.payload) for item in run.events[-10:]]
        assert (datetime.fromisoformat(run.deadlineAt) - datetime.now(timezone.utc)).total_seconds() > (10000 if routing != "unmarked" else 200)
        if routing in {"global", "unmarked"}:
            assert expert_method in methods
            assert "agent.analyze_skill_work_unit" not in methods
            assert ("agent.plan_skill_execution" in methods) == (routing == "global")
        else:
            assert methods.count(expert_method) == (2 if routing == "expert_retry" else 1)
            artifact = next(item for item in run.artifacts if "skillAnalysis" in item.metadata)
            assert artifact.type == artifact_type
            assert artifact.metadata["expertReport"]["artifactId"] == artifact.artifactId
            if routing == "publish_retry":
                assert len(published_ids) == 2 and len(set(published_ids)) == 1
            assert artifact.metadata["expertReport"]["coverage"]["expertReviewedChapterCount"] == 3
            assert artifact.metadata["skillAnalysis"]["coverage"]["analyzedChapterCount"] == 3
            assert artifact.metadata["expertReport"]["findings"][0]["evidence"][0]["excerpt"] == "正文"
            assert len(previous_sources) == (4 if routing == "recover" else 3)
            assert previous_sources[0] is None
            assert all(item is not None for item in previous_sources[1:]) == (routing == "ordered")
        # Analysis caches must not add domains to the historical backup database.
        with sqlite3.connect(store.db_path) as db:
            assert not db.execute("SELECT name FROM sqlite_master WHERE name='skill_work_units'").fetchone()

    asyncio.run(scenario())
