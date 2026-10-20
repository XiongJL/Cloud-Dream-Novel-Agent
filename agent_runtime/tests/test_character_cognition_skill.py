from __future__ import annotations

import asyncio

import pytest

from novel_agent_runtime.agent_skills.errors import AgentSkillError
from novel_agent_runtime.agent_skills.registry import BUILTIN_AGENT_SKILL_REGISTRY
from novel_agent_runtime.agent_skills.service import AGENT_SKILL_SERVICE
from novel_agent_runtime.agent_skills.schemas import AgentSkillRef
from test_skill_model_consumption import setup_runtime
from test_skill_catalog import make_runtime


SKILL = "builtin.character-cognition"


@pytest.mark.parametrize("operation,role", [
    ("chapter.create", "writer"),
    ("chapter.rewrite", "writer"),
    ("chapter.consistency_review", "editor"),
    ("reader.journey_review", "reader"),
    ("creative_asset.draft", "worldbuilding"),
])
@pytest.mark.parametrize("version", ["1.0.0", "1.1.0", "1.2.0"])
def test_builtin_can_be_resolved_and_compiled_for_writing_and_review(operation, role, version):
    preview = AGENT_SKILL_SERVICE.preview({
        "operationId": operation, "roleId": role,
        "explicitSkills": [{"skillId": SKILL, "requestedRevisionId": SKILL + "@" + version}],
    })
    ref = preview["resolved"]["primary"]
    revision = BUILTIN_AGENT_SKILL_REGISTRY.revision(SKILL, SKILL + "@" + version)
    assert ref["scope"] == "builtin" and ref["contentHash"] == revision.contentHash
    assert revision.instructions in preview["compiled"]["prompt"]
    assert all(rule in preview["compiled"]["prompt"] for rule in revision.constraints)


def test_runtime_catalog_and_mixed_persisted_style_keep_both_complete_methods(tmp_path):
    async def scenario():
        runtime, automation = make_runtime(tmp_path)
        catalog = await runtime.skills({"novelId": "a"}, {})
        item = next(row for row in catalog if row["id"] == SKILL)
        assert item["title"] == "人物认知与行为" and item["enabled"]
        assert item["version"] == "1.2.0"
        assert "instructions" not in item  # catalog must not preload the method body
        preview = await runtime.preview_skill({
            "novelId": "a", "operationId": "chapter.continuation", "roleId": "writer",
            "explicitSkills": [{"skillId": "method-a"}, {"skillId": SKILL}],
        })
        assert preview["resolved"]["primary"]["skillId"] == "method-a"
        assert preview["resolved"]["auxiliary"]["skillId"] == SKILL
        assert automation.full["revision"]["instructions"] in preview["compiled"]["prompt"]
        assert BUILTIN_AGENT_SKILL_REGISTRY.revision(SKILL).instructions in preview["compiled"]["prompt"]
    asyncio.run(scenario())


def test_scene_revision_is_default_and_keeps_frozen_previous_revisions():
    old = BUILTIN_AGENT_SKILL_REGISTRY.revision(SKILL, SKILL + "@1.0.0")
    assert old.contentHash == "5e877259ad2eba61030b7051683a0030d840607788a4696d5ac3252dd58f41e4"
    detail = BUILTIN_AGENT_SKILL_REGISTRY.revision(SKILL, SKILL + "@1.1.0")
    assert detail.contentHash == "a40c9f6bbafec2a8f4b34b3eadb7a29df5483336375070955bab75650cc118f7"
    latest = BUILTIN_AGENT_SKILL_REGISTRY.revision(SKILL)
    assert latest.version == "1.2.0" and latest.contentHash not in {old.contentHash, detail.contentHash}
    assert latest.instructions.count("### 按场景作用取舍细节") == 1
    assert latest.instructions.count("### 让交锋与反转有实际支撑") == 1
    assert latest.instructions.count("### 让比喻增加理解而非装饰") == 1
    preview = AGENT_SKILL_SERVICE.preview({"operationId": "chapter.rewrite", "roleId": "writer",
        "explicitSkills": [{"skillId": SKILL}]})
    assert preview["resolved"]["primary"]["revisionId"] == latest.revisionId
    assert latest.instructions in preview["compiled"]["prompt"]


def test_character_method_does_not_claim_style_extraction_or_unknown_revisions():
    with pytest.raises(AgentSkillError) as error:
        AGENT_SKILL_SERVICE.preview({"operationId": "agent_skill.style_extract", "roleId": "writer",
            "explicitSkills": [{"skillId": SKILL}]})
    assert error.value.code == "AGENT_SKILL_OPERATION_UNSUPPORTED"
    with pytest.raises(AgentSkillError) as error:
        AGENT_SKILL_SERVICE.preview({"operationId": "chapter.rewrite", "roleId": "writer",
            "explicitSkills": [{"skillId": SKILL, "requestedRevisionId": SKILL + "@9.0.0"}]})
    assert error.value.code == "AGENT_SKILL_VERSION_UNAVAILABLE"


@pytest.mark.parametrize("method", ["chapter.generate_draft", "agent.generate_consistency_review"])
def test_builtin_body_reaches_task_model_dispatch(tmp_path, method):
    runtime, _automation, run, step = setup_runtime(tmp_path)
    runtime.agent_skill_service = AGENT_SKILL_SERVICE
    preview = AGENT_SKILL_SERVICE.preview({"operationId": "chapter.rewrite", "roleId": "writer",
        "explicitSkills": [{"skillId": SKILL}]})
    step.skills = [AgentSkillRef.model_validate(preview["resolved"]["primary"])]
    params = asyncio.run(runtime._step_skill_params(run, method, {"chapterId": "chapter"}))
    revision = BUILTIN_AGENT_SKILL_REGISTRY.revision(SKILL)
    assert revision.instructions in params["agentSkill"]["prompt"]
    assert params["agentSkill"]["sections"][0]["skill"]["contentHash"] == revision.contentHash
