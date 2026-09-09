from __future__ import annotations

import asyncio
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from novel_agent_runtime.agent_skills.compiler import AgentSkillCompiler
from novel_agent_runtime.agent_skills.errors import AgentSkillError
from novel_agent_runtime.agent_skills.registry import BUILTIN_AGENT_SKILL_REGISTRY
from novel_agent_runtime.agent_skills.resolver import AgentSkillResolver
from novel_agent_runtime.agent_skills.schemas import AgentSkillDefinition, AgentSkillResolveRequest
from novel_agent_runtime.agent_skills.service import AGENT_SKILL_SERVICE
from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.roles import list_agent_roles
from novel_agent_runtime.main import build_app
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.intent.schemas import (
    IntentEntryHint,
    IntentRequest,
    SemanticProposal,
    SemanticUserInputOption,
    SemanticUserInputQuestion,
    SemanticUserInputRequest,
)
from novel_agent_runtime.intent.service import IntentService
from novel_agent_runtime.intent.targets import extract_style_work_title
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import (
    AgentPlan,
    AgentPlanStep,
    AgentUserInputAnswer,
    AgentUserInputEffectiveAnswer,
    AgentUserInputRequest,
)
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.tool_adapter import FastMcpAgentToolAdapter
from novel_agent_runtime.toolchains.schemas import StyleSkillExtractionInput, ToolchainInvocation
from test_runtime import FakeAutomationClient
from test_chapter_scope_context import _scope_bundle


_UNHANDLED = object()


def _style_authoring_plan(legacy: dict[str, object]) -> dict[str, object]:
    skills = []
    for raw in legacy["skills"]:  # type: ignore[index]
        item = dict(raw)  # type: ignore[arg-type]
        item.pop("instructions", None)
        item["methodDimensions"] = {
            "language_style": ["句长节奏", "叙述距离", "对白与段落"],
            "suspense_release": ["问题建立", "线索与误导", "揭示节拍与章末钩子"],
            "ensemble_progression": ["视角轮换", "人物目标", "交汇节点"],
        }[str(item["draftKey"])]
        skills.append(item)
    return {**legacy, "skills": skills}


class FakeStyleAuthoringWorkspace:
    def __init__(self, plan: dict[str, object], draft_id: str, *, fail_once_path: str | None = None) -> None:
        self.plan = plan
        self.draft_id = draft_id
        self.version = 0
        self.documents: dict[str, str] = {}
        self.pack: dict[str, object] = {}
        self.calls: list[str] = []
        self.generated_keys: list[str] = []
        self.fail_once_path = fail_once_path
        self.failed_validation_once = False

    def _summary(self, *, status: str = "editing", phase: str = "authoring", report: dict[str, object] | None = None) -> dict[str, object]:
        return {
            "draftId": self.draft_id,
            "version": self.version,
            "status": status,
            "action": "pack",
            "phase": phase,
            "documents": [
                {"logicalPath": path, "deleted": False, "byteLength": len(content.encode("utf-8"))}
                for path, content in self.documents.items()
            ],
            **({"validationReport": report} if report is not None else {}),
        }

    def _document(self, member: dict[str, object], scope: str) -> str:
        lines = [
            "---",
            "schemaVersion: novel-editor.agent-skill.v1",
            f"stableId: {member['stableIdCandidate']}",
            "version: 1.0.0",
            f"name: {member['title']}",
            f"description: {member['description']}",
            f"scope: {scope}",
            "skillType: prompt_method",
            f"category: {'style' if member['draftKey'] == 'language_style' else 'narrative_method'}",
            f"guidanceMode: {member['guidanceMode']}",
            "semanticSelection: suggest",
            "triggerHints:",
            *[f"  - {item}" for item in member["triggerHints"]],  # type: ignore[index]
            "antiTriggerHints:",
            *[f"  - {item}" for item in member["antiTriggerHints"]],  # type: ignore[index]
            "supportedOperations:",
            *[f"  - {item}" for item in member["supportedOperations"]],  # type: ignore[index]
            "allowedRoles:",
            "  - writer",
            "  - editor",
            "outputType: none",
            "constraints:",
            *[f"  - {item}" for item in member["constraints"]],  # type: ignore[index]
            "---",
            "",
            "按规划维度执行，并在证据不足时降低结论强度。",
        ]
        return "\n".join(lines)

    async def handle(self, method: str, params: dict[str, object]) -> object:
        self.calls.append(method)
        if method == "agent.plan_style_skill_pack":
            return self.plan
        if method == "agent_skill.workspace.create":
            self.version = 1
            self.documents[str(params["logicalPath"])] = ""
            return self._summary()
        if method == "agent_skill.workspace.list":
            return self._summary()
        if method == "agent_skill.workspace.read":
            path = str(params["logicalPath"])
            return {**self._summary(), "logicalPath": path, "contentText": self.documents[path]}
        if method == "agent.generate_skill_document":
            source = params["source"]
            assert isinstance(source, dict)
            member = source["memberPlan"]
            assert isinstance(member, dict)
            assert params["creatorProfile"] == "builtin.style-skill-extractor.member"
            self.generated_keys.append(str(member["draftKey"]))
            return {"contentText": self._document(member, str(params["scope"]))}
        if method == "agent_skill.workspace.write":
            assert params["expectedVersion"] == self.version
            self.documents[str(params["logicalPath"])] = str(params["contentText"])
            self.version += 1
            return self._summary()
        if method == "agent_skill.workspace.set_pack":
            assert params["expectedVersion"] == self.version
            self.pack = dict(params["pack"])  # type: ignore[arg-type]
            self.version += 1
            return self._summary()
        if method == "agent_skill.workspace.validate":
            assert params["expectedVersion"] == self.version
            self.version += 1
            if self.fail_once_path and not self.failed_validation_once:
                self.failed_validation_once = True
                return self._summary(
                    phase="revising",
                    report={
                        "ok": False,
                        "diagnostics": [{
                            "code": "SKILL_INSTRUCTIONS_INVALID",
                            "path": self.fail_once_path,
                            "severity": "error",
                            "message": "正文需要补充可执行步骤。",
                        }],
                    },
                )
            return self._summary(phase="validating", report={"ok": True, "diagnostics": []})
        if method == "agent_skill.workspace.compile":
            assert params["expectedVersion"] == self.version
            self.version += 1
            return self._summary(status="ready_for_review", phase="compiled", report={"ok": True, "diagnostics": []})
        if method == "agent_skill.draft.get":
            skills = []
            for member in self.plan["skills"]:  # type: ignore[index]
                assert isinstance(member, dict)
                key = str(member["draftKey"]).replace("_", "-")
                skills.append({
                    "draftKey": key,
                    "definition": {
                        "stableId": member["stableIdCandidate"],
                        "title": member["title"],
                        "description": member["description"],
                    },
                    "revision": {
                        "version": "1.0.0",
                        "instructions": "按规划维度执行，并在证据不足时降低结论强度。",
                        "constraints": member["constraints"],
                        "manifest": {},
                    },
                })
            return {
                "id": self.draft_id,
                "version": self.version,
                "status": "ready_for_review",
                "action": "pack",
                "draft": {"skills": skills, "pack": self.pack},
            }
        return _UNHANDLED


def test_builtin_registry_exposes_only_level_one_metadata() -> None:
    entries = BUILTIN_AGENT_SKILL_REGISTRY.list_index(locale="zh-CN")

    assert len(entries) == 3
    entry = next(item for item in entries if item.stableId == "builtin.continuity-review")
    assert entry.stableId == "builtin.continuity-review"
    assert entry.title == "连续性审查"
    assert entry.version == "1.0.0"
    assert entry.supportedOperations == ["chapter.consistency_review"]
    assert "instructions" not in entry.model_dump()
    assert "constraints" not in entry.model_dump()


def test_builtin_registry_localizes_public_metadata() -> None:
    entry = BUILTIN_AGENT_SKILL_REGISTRY.list_index(locale="en-US")[0]

    assert entry.title == "Continuity Review"
    assert "continuity" in entry.description.lower()


def test_editor_role_uses_stable_default_skill_id() -> None:
    editor = next(role for role in list_agent_roles() if role.id == "editor")

    assert editor.defaultSkillIds == ["builtin.continuity-review"]


def test_resolver_locks_role_default_revision() -> None:
    resolver = AgentSkillResolver(BUILTIN_AGENT_SKILL_REGISTRY)

    resolved = resolver.resolve(
        AgentSkillResolveRequest(
            operationId="chapter.consistency_review",
            roleId="editor",
            defaultSkillIds=["builtin.continuity-review"],
        )
    )

    assert resolved.primary is not None
    assert resolved.primary.revisionId == "builtin.continuity-review@1.0.0"
    assert resolved.primary.selectionSource == "role"
    assert len(resolved.primary.contentHash) == 64
    assert resolved.reasonCodes == ["role_default_selected"]


def test_explicit_selection_has_priority_and_incompatible_selection_fails() -> None:
    resolver = AgentSkillResolver(BUILTIN_AGENT_SKILL_REGISTRY)
    resolved = resolver.resolve(
        AgentSkillResolveRequest.model_validate(
            {
                "operationId": "chapter.consistency_review",
                "roleId": "editor",
                "explicitSkills": [{"skillId": "builtin.continuity-review"}],
                "defaultSkillIds": ["builtin.continuity-review"],
            }
        )
    )
    assert resolved.primary is not None
    assert resolved.primary.selectionSource == "explicit"

    with pytest.raises(AgentSkillError) as error:
        resolver.resolve(
            AgentSkillResolveRequest.model_validate(
                {
                    "operationId": "chapter.continuation",
                    "roleId": "writer",
                    "explicitSkills": [{"skillId": "builtin.continuity-review"}],
                }
            )
        )
    assert error.value.code == "AGENT_SKILL_OPERATION_UNSUPPORTED"


def test_resolver_can_disable_skills_for_one_turn() -> None:
    resolver = AgentSkillResolver(BUILTIN_AGENT_SKILL_REGISTRY)
    resolved = resolver.resolve(
        AgentSkillResolveRequest(
            operationId="chapter.consistency_review",
            roleId="editor",
            defaultSkillIds=["builtin.continuity-review"],
            disabledForTurn=True,
        )
    )

    assert resolved.primary is None
    assert resolved.reasonCodes == ["disabled_for_turn"]


def test_compiler_loads_locked_revision_and_enforces_budget() -> None:
    resolved = AgentSkillResolver(BUILTIN_AGENT_SKILL_REGISTRY).resolve(
        AgentSkillResolveRequest(
            operationId="chapter.consistency_review",
            roleId="editor",
            defaultSkillIds=["builtin.continuity-review"],
        )
    )
    compiled = AgentSkillCompiler(BUILTIN_AGENT_SKILL_REGISTRY).compile(resolved)

    assert compiled.estimatedTokens > 0
    assert 'id="builtin.continuity-review"' in compiled.prompt
    assert "[Method]" in compiled.prompt
    assert "资料不足时标记无法检查" in compiled.prompt

    with pytest.raises(AgentSkillError) as error:
        AgentSkillCompiler(BUILTIN_AGENT_SKILL_REGISTRY, max_estimated_tokens=1).compile(resolved)
    assert error.value.code == "AGENT_SKILL_BUDGET_EXCEEDED"


def test_auto_semantic_selection_requires_positive_and_negative_boundaries() -> None:
    with pytest.raises(ValidationError):
        AgentSkillDefinition(
            id="user.test-skill",
            stableId="user.test-skill",
            title="测试技能",
            description="在需要测试时执行固定检查。",
            scope="user",
            origin="authored",
            semanticSelection="auto",
            triggerHints=("请执行测试",),
            supportedOperations=("chapter.consistency_review",),
        )


def test_service_preview_keeps_index_and_body_loading_separate() -> None:
    index = AGENT_SKILL_SERVICE.list_public({"locale": "zh-CN"}, {})
    preview = AGENT_SKILL_SERVICE.preview(
        {
            "operationId": "chapter.consistency_review",
            "roleId": "editor",
            "defaultSkillIds": ["builtin.continuity-review"],
        }
    )

    assert "instructions" not in index[0]
    assert preview["resolved"]["primary"]["revisionId"] == "builtin.continuity-review@1.0.0"
    assert "[Constraints]" in preview["compiled"]["prompt"]


class _SkillRuntimeStub:
    tool_transport = "test"

    async def resume_interrupted_runs(self) -> None:
        return None

    async def skills(self, params: dict[str, object], context: dict[str, object]) -> list[dict[str, object]]:
        return AGENT_SKILL_SERVICE.list_public(params, context)

    async def resolve_skill(self, params: dict[str, object]) -> dict[str, object]:
        return AGENT_SKILL_SERVICE.resolve(params)

    async def preview_skill(self, params: dict[str, object]) -> dict[str, object]:
        return AGENT_SKILL_SERVICE.preview(params)


def test_runtime_exposes_skill_list_resolve_preview_and_structured_errors() -> None:
    with TestClient(build_app(_SkillRuntimeStub(), None)) as client:  # type: ignore[arg-type]
        health = client.get("/health").json()
        listed = client.post(
            "/invoke",
            json={"method": "agent.skills", "params": {"locale": "zh-CN"}, "context": {}},
        ).json()
        resolved = client.post(
            "/invoke",
            json={
                "method": "agent.skill.resolve",
                "params": {
                    "operationId": "chapter.consistency_review",
                    "roleId": "editor",
                    "defaultSkillIds": ["builtin.continuity-review"],
                },
                "context": {},
            },
        ).json()
        failed = client.post(
            "/invoke",
            json={
                "method": "agent.skill.preview",
                "params": {
                    "operationId": "chapter.continuation",
                    "roleId": "writer",
                    "explicitSkills": [{"skillId": "builtin.continuity-review"}],
                },
                "context": {},
            },
        ).json()

    assert "agent.skills" in health["data"]["capabilities"]
    assert any(item["stableId"] == "builtin.continuity-review" for item in listed["data"])
    assert resolved["data"]["primary"]["version"] == "1.0.0"
    assert failed["ok"] is False
    assert failed["code"] == "AGENT_SKILL_OPERATION_UNSUPPORTED"


def test_skill_entry_hint_survives_intent_decision() -> None:
    intent_request = IntentRequest(
        message="检查当前章节的一致性",
        conversationId="conv-skill",
        source="shortcut",
        entryHint=IntentEntryHint(
            actionId="skill.use",
            kind="skill.use",
            skillId="builtin.continuity-review",
            requestedRevisionId="builtin.continuity-review@1.0.0",
        ),
    )
    service = IntentService()
    decision = service.finalize(
        intent_request,
        service.preflight(intent_request),
        SemanticProposal(
            responseContent="我会先生成一致性审核计划。",
            shouldPlan=True,
            requestedOperations=["chapter.consistency_review"],
            confidence=0.9,
        ),
    )

    assert decision.requestedSkills[0].skillId == "builtin.continuity-review"
    assert decision.requestedSkills[0].selectionSource == "shortcut"
    assert "EXPLICIT_SKILL_SELECTED" in decision.reasonCodes


class _NoopAutomation:
    async def invoke(self, *_args: object, **_kwargs: object) -> dict[str, object]:
        return {}


def test_plan_step_locks_skill_and_compiler_uses_same_snapshot(tmp_path) -> None:
    store = AgentStateStore(tmp_path)
    runtime = NovelAgentRuntime(store, _NoopAutomation(), AgentEventBus(store))  # type: ignore[arg-type]
    intent_request = IntentRequest(
        message="检查当前章节的一致性",
        conversationId="conv-skill-plan",
        source="shortcut",
        entryHint=IntentEntryHint(
            actionId="skill.use",
            kind="skill.use",
            skillId="builtin.continuity-review",
        ),
    )
    service = IntentService()
    decision = service.finalize(
        intent_request,
        service.preflight(intent_request),
        SemanticProposal(
            responseContent="我会先生成一致性审核计划。",
            shouldPlan=True,
            requestedOperations=["chapter.consistency_review"],
            confidence=0.9,
        ),
    )
    plan = AgentPlan(
        planId="plan-skill",
        threadId="thread-skill",
        title="章节一致性审核",
        goal="检查当前章节的一致性",
        steps=[AgentPlanStep(
            stepId="step-skill",
            agent="editor",
            title="章节一致性审核",
            toolchain=ToolchainInvocation(id="chapter.consistency_review", version="1.0.0", input={}),
        )],
    )

    resolved_plan = runtime._apply_agent_skills_to_plan(
        plan,
        decision,
        locale="zh-CN",
        novel_id="novel-1",
    )
    skill = resolved_plan.steps[0].skills[0]
    compiled = runtime._compile_step_skills(resolved_plan.steps[0])

    assert skill.selectionSource == "shortcut"
    assert skill.revisionId == "builtin.continuity-review@1.0.0"
    assert compiled is not None
    assert compiled["sections"][0]["skill"]["contentHash"] == skill.contentHash
    assert "资料不足时标记无法检查" in compiled["prompt"]


def test_novel_bootstrap_uses_builtin_recommended_question_contract() -> None:
    request = IntentRequest(
        message="帮我新建一本小说",
        conversationId="conv-new-novel",
        source="shortcut",
        entryHint=IntentEntryHint(
            actionId="novel.bootstrap",
            kind="novel.bootstrap",
            operationIds=["novel.bootstrap"],
        ),
    )
    service = IntentService()
    semantic = service.enrich_semantic(
        request,
        SemanticProposal(responseContent="开始创建。", shouldPlan=True),
    )

    assert semantic.inputRequest is not None
    assert len(semantic.inputRequest.questions) == 3
    assert all(question.recommendedOptionId == question.options[0].optionId for question in semantic.inputRequest.questions)
    decision = service.finalize(request, service.preflight(request), semantic)
    assert decision.route == "clarify"
    assert decision.operations[0].type == "novel.bootstrap"
    assert decision.operations[0].suggestedToolchainId == "novel.bootstrap"


def test_novel_bootstrap_replaces_model_single_question_with_product_flow() -> None:
    request = IntentRequest(message="新建小说", conversationId="conv-new-novel")
    model_question = SemanticUserInputQuestion(
        questionId="model_shortcut",
        header="模型问题",
        prompt="只问这一题。",
        options=[
            SemanticUserInputOption(optionId="recommended", label="推荐", description="推荐方向。"),
            SemanticUserInputOption(optionId="alternative", label="备选", description="备选方向。"),
        ],
        recommendedOptionId="recommended",
        recommendationReason="模型给出的推荐。",
    )
    service = IntentService()
    semantic = service.enrich_semantic(request, SemanticProposal(
        responseContent="只问一题。",
        requestedOperations=["novel.bootstrap"],
        inputRequest=SemanticUserInputRequest(title="模型单题", reason="不完整", questions=[model_question]),
    ))

    assert semantic.inputRequest is not None
    assert semantic.inputRequest.title == "新小说方向确认"
    assert [question.questionId for question in semantic.inputRequest.questions] == [
        "genre_concept", "protagonist_setup", "core_conflict",
    ]


def test_novel_bootstrap_deep_customization_uses_model_question_and_history(tmp_path) -> None:
    store = AgentStateStore(tmp_path)
    runtime = NovelAgentRuntime(store, FakeAutomationClient(), AgentEventBus(store))
    previous = AgentUserInputRequest.model_validate({
        "requestId": "input-first",
        "inputSessionId": "session-bootstrap",
        "conversationId": "conv-bootstrap",
        "phase": "pre_plan",
        "round": 1,
        "maxRounds": 3,
        "title": "新小说方向确认",
        "reason": "核心选择",
        "questions": [{
            "questionId": "genre_concept",
            "header": "题材与创意",
            "prompt": "测试问题",
            "options": [
                {"optionId": "recommended", "label": "推荐", "description": "推荐方向。"},
                {"optionId": "alternative", "label": "备选", "description": "备选方向。"},
            ],
            "recommendedOptionId": "recommended",
            "recommendationReason": "测试推荐。",
        }],
    })

    follow_up = runtime._build_follow_up_user_input_request({
        "needsFollowUp": True,
        "inputRequest": {
            "title": "新小说深度定制",
            "reason": "奇幻世界仍需明确力量代价。",
            "questions": [{
                "questionId": "power_cost",
                "header": "力量代价",
                "prompt": "主角每次使用力量应当付出什么不可逆的代价？",
                "options": [
                    {"optionId": "memory", "label": "遗忘记忆", "description": "力量越强，越接近失去最初的自我。"},
                    {"optionId": "debt", "label": "背负契约债务", "description": "每次胜利都会把主角推向更危险的势力。"},
                ],
                "recommendationReason": "这会直接决定成长线和关键关系的冲突来源。",
            }],
        },
    }, previous, [{
        "requestId": previous.requestId,
        "questions": [question.model_dump() for question in previous.questions],
        "answers": [{"questionId": "genre_concept", "answerKind": "option", "selectedOptionId": "fantasy"}],
    }])

    assert follow_up is not None
    assert follow_up.round == 2
    assert follow_up.maxRounds == 3
    assert follow_up.previousRequestId == previous.requestId
    assert [question.questionId for question in follow_up.questions] == ["power_cost"]
    assert follow_up.questions[0].prompt == "主角每次使用力量应当付出什么不可逆的代价？"

    with pytest.raises(ValueError, match="repeats"):
        runtime._build_follow_up_user_input_request({
            "needsFollowUp": True,
            "inputRequest": {
                "questions": [{
                    "questionId": "genre_concept",
                    "prompt": "测试问题",
                    "options": [
                        {"label": "推荐", "description": "推荐方向。"},
                        {"label": "备选", "description": "备选方向。"},
                    ],
                }],
            },
        }, previous, [{"questions": [question.model_dump() for question in previous.questions]}])


def test_novel_bootstrap_deep_customization_passes_every_round_to_model(tmp_path) -> None:
    async def scenario() -> None:
        automation = FakeAutomationClient()
        original_invoke = automation.invoke

        async def invoke(method: str, params: dict[str, object], origin: str, request_id: str | None = None) -> object:
            if method == "agent.generate_user_input_followup":
                assert params["workflow"] == "novel_bootstrap"
                history = params["decisionHistory"]
                assert isinstance(history, list)
                assert [entry["round"] for entry in history] == [1, 2]
                assert history[0]["questions"][0]["questionId"] == "genre_concept"
                assert history[1]["questions"][0]["questionId"] == "power_cost"
                assert history[1]["effectiveAnswers"][0]["selectedOptionId"] == "memory"
                return {
                    "needsFollowUp": True,
                    "inputRequest": {
                        "title": "新小说深度定制",
                        "reason": "还需要确定信息释放的边界。",
                        "questions": [{
                            "questionId": "reveal_pacing",
                            "header": "信息释放",
                            "prompt": "力量代价应在第几章首次明确揭示？",
                            "options": [
                                {"optionId": "early", "label": "前三章揭示", "description": "尽早建立规则与期待。"},
                                {"optionId": "late", "label": "中段反转揭示", "description": "先让读者体验力量，再翻转其代价。"},
                            ],
                            "recommendationReason": "这会决定首卷钩子和悬念节拍。",
                        }],
                    },
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = invoke  # type: ignore[method-assign]
        store = AgentStateStore(tmp_path)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        request = AgentUserInputRequest.model_validate({
            "requestId": "input-round-two",
            "inputSessionId": "session-bootstrap",
            "conversationId": "conv-bootstrap",
            "phase": "pre_plan",
            "round": 2,
            "maxRounds": 3,
            "previousRequestId": "input-round-one",
            "title": "新小说深度定制",
            "reason": "补齐力量规则。",
            "questions": [{
                "questionId": "power_cost",
                "header": "力量代价",
                "prompt": "主角每次使用力量应当付出什么不可逆的代价？",
                "options": [
                    {"optionId": "memory", "label": "遗忘记忆", "description": "力量越强，越接近失去最初的自我。"},
                    {"optionId": "debt", "label": "背负契约债务", "description": "每次胜利都会把主角推向更危险的势力。"},
                ],
                "recommendedOptionId": "memory",
                "recommendationReason": "这会直接决定成长线和关键关系的冲突来源。",
            }],
        })
        answers = [AgentUserInputAnswer(questionId="power_cost", answerKind="option", selectedOptionId="memory")]
        effective_answers = [AgentUserInputEffectiveAnswer(
            questionId="power_cost", answerKind="option", selectedOptionId="memory", source="user",
        )]
        follow_up = await runtime._request_user_input_follow_up(
            request,
            answers,
            effective_answers,
            "奇幻故事的力量会使主角遗忘最重要的记忆。",
            {
                "goal": "创建一部奇幻冒险小说",
                "role": "writer",
                "locale": "zh-CN",
                "intentDecision": {"operations": [{"type": "novel.bootstrap"}]},
                "decisionRounds": [{
                    "requestId": "input-round-one",
                    "round": 1,
                    "questions": [{"questionId": "genre_concept", "prompt": "你想写什么题材？"}],
                    "answers": [{"questionId": "genre_concept", "answerKind": "option", "selectedOptionId": "fantasy"}],
                    "effectiveAnswers": [{"questionId": "genre_concept", "answerKind": "option", "selectedOptionId": "fantasy", "source": "user"}],
                }],
            },
        )
        assert follow_up is not None
        assert follow_up.round == 3
        assert follow_up.questions[0].questionId == "reveal_pacing"

    asyncio.run(scenario())


def test_style_extractor_registry_has_required_multidimensional_contract() -> None:
    registration = BUILTIN_AGENT_SKILL_REGISTRY.require("builtin.style-skill-extractor")
    revision = BUILTIN_AGENT_SKILL_REGISTRY.revision(registration.definition.id)

    assert revision.revisionId == "builtin.style-skill-extractor@1.1.0"
    assert registration.definition.supportedOperations == ("agent_skill.style_extract",)
    assert "语言风格" in revision.instructions
    assert "悬念与信息释放" in revision.instructions
    assert "群像人物推进" in revision.instructions
    assert "Skill Pack" in revision.instructions
    assert "草稿工作区" in revision.instructions
    assert "不在规划协议中编写长篇 Skill 正文" in revision.instructions
    assert any("只修订诊断指向的成员文档" in item for item in revision.constraints)


def test_named_work_style_request_does_not_become_an_unresolved_chapter(tmp_path) -> None:
    request = IntentRequest(
        message="根据《十日终焉》，提炼文风 Skill Pack",
        conversationId="conv-named-work-style",
        currentSelection={"novelId": "novel_1", "chapterId": "chapter_2"},
    )
    service = IntentService()
    decision = service.finalize(
        request,
        service.preflight(request),
        SemanticProposal(
            responseContent="生成文风 Skill Pack 草稿。",
            shouldPlan=True,
            requestedOperations=["agent_skill.style_extract", "chapter.scope_context", "chapter.context"],
            confidence=0.95,
        ),
    )

    assert decision.route == "plan"
    assert "CHAPTER_TARGET_UNRESOLVED" not in decision.reasonCodes
    assert [operation.type for operation in decision.operations] == ["agent_skill.style_extract"]
    assert "STYLE_SOURCE_WORKFLOW_OWNS_CONTEXT" in decision.reasonCodes
    assert decision.operations[0].target.kind == "conversation"
    assert extract_style_work_title("提炼《十日终焉》的文风") == "十日终焉"

    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke
        calls: list[str] = []
        style_workspace: FakeStyleAuthoringWorkspace | None = None

        async def invoke(method: str, params: dict[str, object], origin: str, request_id: str | None = None) -> object:
            nonlocal style_workspace
            calls.append(method)
            if method == "chapter.scope_context.build":
                raise AssertionError("A named work must not read the open project chapter scope")
            if method == "agent.plan_style_skill_pack":
                source_payload = params["source"]
                assert isinstance(source_payload, dict)
                assert source_payload["sourceType"] == "model_prior"
                assert source_payload["workTitle"] == "十日终焉"
                legacy = {
                    "summary": "仅基于作品名称生成的低置信度创作方法候选。",
                    "sourceCoverage": {"chapterCount": 0, "confidence": "low", "gaps": ["未提供正文样本"]},
                    "skills": [
                        {
                            "draftKey": "language_style", "stableIdCandidate": "ten-day-prose-candidate",
                            "title": "高压短句候选", "description": "以短句和有限信息维持紧张感。",
                            "guidanceMode": "guided", "confidence": "low", "triggerHints": ["写高压场景"],
                            "antiTriggerHints": ["复制来源表达"], "supportedOperations": ["chapter.continuation"],
                            "instructions": "以角色可见信息组织短句动作，并保留节奏变化空间。",
                            "constraints": ["不得声称已读取原作正文"], "evidenceNotes": ["仅模型先验"],
                            "contaminationWarnings": ["未提供正文，结论需人工验证"],
                            "evaluationPrompt": "用中性密室场景验证节奏。",
                        },
                        {
                            "draftKey": "suspense_release", "stableIdCandidate": "ten-day-reveal-candidate",
                            "title": "分层信息释放候选", "description": "通过局部回应保留下一层疑问。",
                            "guidanceMode": "guided", "confidence": "low", "triggerHints": ["设计悬念推进"],
                            "antiTriggerHints": ["一次性揭示全部答案"], "supportedOperations": ["chapter.continuation"],
                            "instructions": "每次回应一个当前问题，同时留下可追踪的新问题。",
                            "constraints": ["不得复用作品人物、设定或情节"], "evidenceNotes": ["仅模型先验"],
                            "contaminationWarnings": ["未提供正文，结论需人工验证"],
                            "evaluationPrompt": "用中性调查场景验证线索回收。",
                        },
                    ],
                    "pack": {
                        "stableIdCandidate": "ten-day-style-candidate-pack", "title": "低置信度文风候选 Pack",
                        "description": "用于验证高压叙述与分层揭示方法。",
                        "bindings": [{
                            "operationId": "chapter.continuation", "roleId": "writer",
                            "primaryDraftKey": "language_style", "auxiliaryDraftKey": "suspense_release",
                        }],
                    },
                    "omittedDimensions": ["ensemble_progression：无正文样本"],
                    "warnings": ["仅基于作品名称和模型先验生成。"],
                }
                style_workspace = FakeStyleAuthoringWorkspace(
                    _style_authoring_plan(legacy), "named-work-style-draft"
                )
                return style_workspace.plan
            if style_workspace is not None:
                handled = await style_workspace.handle(method, params)
                if handled is not _UNHANDLED:
                    return handled
            return await original_invoke(method, params, origin, request_id=request_id)  # type: ignore[arg-type]

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        plan = await runtime.plan({
            "goal": request.message,
            "role": "writer",
            "intentDecision": decision.model_dump(),
        }, {"locale": "zh-CN"})
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.input == {
            "sourceMode": "named_work_model_prior",
            "sourceWorkTitle": "十日终焉",
        }
        run = await runtime.execute_plan({
            "planId": plan.planId,
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {"locale": "zh-CN"})
        for _ in range(1000):
            if runtime.state.runs[run.runId].status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)
        assert runtime.state.runs[run.runId].status == "completed", (
            "\n".join(calls),
            "\n".join(style_workspace.calls if style_workspace else []),
        )
        assert "chapter.scope_context.build" not in calls

    # The input accepts a named work without a project chapter or database ID.
    source = StyleSkillExtractionInput.model_validate({
        "sourceMode": "named_work_model_prior",
        "sourceWorkTitle": "十日终焉",
        "goal": request.message,
    })
    assert source.novelId is None
    assert source.sourceWorkTitle == "十日终焉"
    asyncio.run(scenario())


def test_novel_bootstrap_executes_with_locked_builtin_skill_and_publishes_draft(tmp_path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke

        async def invoke(method: str, params: dict[str, object], origin: str, request_id: str | None = None) -> object:
            if method == "agent.generate_novel_bootstrap":
                assert params["userDecisions"]
                assert "builtin.novel-bootstrap" in str(params["agentSkill"])
                return {
                    "titleCandidates": ["灰塔回声"],
                    "genrePromise": "封闭都市中的人物悬疑",
                    "readerPromise": "每个关系变化都会揭开一层真相",
                    "corePremise": "失忆调查员必须在城市重置前找出谁篡改了所有人的记忆。",
                    "centralQuestion": "真相是否值得以最重要的关系为代价？",
                    "narrativeShape": "聚焦主角，逐步扩展关键关系",
                    "characters": [{"name": "林昼", "role": "调查员", "desire": "找回记忆", "cost": "失去同伴信任", "change": "从控制走向承担"}],
                    "worldRules": ["城市每十天重置一次公共记录"],
                    "conflictEscalation": ["发现记录矛盾", "同伴成为嫌疑人", "必须选择保留谁的记忆"],
                    "suspenseStrategy": ["每章回答一个局部问题并扩大核心谜团"],
                    "openingBeats": ["重置后的异常", "第一次关系冲突", "发现不应存在的证据"],
                    "volumePlan": [{
                        "title": "第一卷：重置之城",
                        "dramaticQuestion": "林昼能否在下一次重置前找回记忆？",
                        "turningPoint": "同伴成为唯一可信的嫌疑人。",
                        "chapterRange": "第 1-12 章",
                    }],
                    "chapterPlan": [
                        {"chapterNumber": 1, "title": "错误的档案", "sceneGoal": "确认重置异常", "conflict": "档案与记忆冲突", "hook": "出现不应存在的照片"},
                        {"chapterNumber": 2, "title": "失踪的证人", "sceneGoal": "锁定证人去向", "conflict": "同伴阻止调查", "hook": "证人留下新的坐标"},
                        {"chapterNumber": 3, "title": "第十天", "sceneGoal": "进入重置前夜", "conflict": "必须在救人和取证间选择", "hook": "城市提前开始重置"},
                    ],
                    "writingModeRecommendation": "串行写作：先稳定人物弧与谜题回收，再按卷扩展。",
                    "targetChapterCount": 36,
                    "targetWordsPerChapter": 3000,
                    "validationChecklist": ["每章都有明确冲突", "章末保留可追踪钩子", "每三章回收一条已知线索"],
                    "userDecisionSummary": "人物驱动；聚焦人物；故事圣经加开篇节拍",
                    "assumptions": [],
                    "warnings": [],
                }
            return await original_invoke(method, params, origin, request_id=request_id)  # type: ignore[arg-type]

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        request = IntentRequest(message="新建小说", conversationId="conv-bootstrap")
        service = IntentService()
        semantic = SemanticProposal(
            responseContent="生成方案。",
            shouldPlan=True,
            requestedOperations=["novel.bootstrap"],
            confidence=0.95,
        )
        decision = service.finalize(request, service.preflight(request), semantic)
        plan = await runtime.plan({
            "goal": "新建小说",
            "role": "team",
            "intentDecision": decision.model_dump(),
            "userDecisions": {"understandingSummary": "人物驱动；聚焦人物；故事圣经加开篇节拍"},
        }, {"locale": "zh-CN"})

        assert plan.steps[0].skills[0].stableId == "builtin.novel-bootstrap"
        assert plan.steps[0].skills[0].selectionSource == "builtin"
        run = await runtime.execute_plan({
            "planId": plan.planId,
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {"locale": "zh-CN"})
        for _ in range(500):
            if runtime.state.runs[run.runId].status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed"
        artifact = next(item for item in completed.artifacts if item.type == "novel_bootstrap_draft")
        assert artifact.metadata["draft"]["titleCandidates"] == ["灰塔回声"]
        assert "开篇章节节拍" in str(artifact.content)
        assert "连载章节表" in str(artifact.content)
        assert plan.requiresApproval is True
        assert completed.skillSnapshot[0].revisionId == "builtin.novel-bootstrap@1.3.0"

    asyncio.run(scenario())


def test_approved_novel_blueprint_initializes_reviewable_project_assets(tmp_path) -> None:
    async def scenario() -> None:
        bootstrap_draft = {
            "titleCandidates": ["灰塔回声"],
            "genrePromise": "封闭都市悬疑",
            "readerPromise": "每次关系变化都会揭开真相",
            "corePremise": "失忆调查员必须在城市重置前找出记忆篡改者。",
            "centralQuestion": "真相是否值得以关系为代价？",
            "narrativeShape": "聚焦主角的悬疑成长线",
            "characters": [{"name": "林昼", "role": "调查员", "desire": "找回记忆", "cost": "失去信任", "change": "从控制走向承担"}],
            "worldRules": ["城市每十天重置公共记录"],
            "conflictEscalation": ["发现记录矛盾", "同伴成为嫌疑人", "重置提前发生"],
            "suspenseStrategy": ["每章回答局部问题并扩大谜团"],
            "openingBeats": ["重置后的异常", "第一次关系冲突", "出现错误档案"],
            "volumePlan": [{"title": "第一卷：重置之城", "dramaticQuestion": "能否找回记忆？", "turningPoint": "同伴成为嫌疑人", "chapterRange": "第 1-12 章"}],
            "chapterPlan": [
                {"chapterNumber": 1, "title": "错误档案", "sceneGoal": "确认异常", "conflict": "档案冲突", "hook": "出现照片"},
                {"chapterNumber": 2, "title": "失踪证人", "sceneGoal": "锁定去向", "conflict": "同伴阻止", "hook": "留下坐标"},
                {"chapterNumber": 3, "title": "第十天", "sceneGoal": "进入前夜", "conflict": "救人与取证", "hook": "重置提前"},
            ],
            "writingModeRecommendation": "串行写作",
            "targetChapterCount": 36,
            "targetWordsPerChapter": 3000,
            "validationChecklist": ["每章有冲突", "保留钩子", "回收线索"],
            "userDecisionSummary": "人物驱动；聚焦人物；故事圣经加开篇节拍",
            "assumptions": [],
            "warnings": [],
        }
        automation = FakeAutomationClient()
        original_invoke = automation.invoke
        calls: list[tuple[str, dict[str, object]]] = []

        async def invoke(method: str, params: dict[str, object], origin: str, request_id: str | None = None) -> object:
            calls.append((method, params))
            if method in {"plotline.list", "character.list", "worldsetting.list", "item.list", "map.list"}:
                return []
            if method == "creative_assets.generate_draft":
                assert "失忆调查员" in str(params["brief"])
                assert params["targetSections"] == ["plotLines", "plotPoints", "characters", "items", "skills", "worldSettings", "maps"]
                return {
                    "draftSessionId": "creative_init_1",
                    "type": "creative-assets",
                    "status": "draft",
                    "version": 1,
                    "previewSummary": "主线 1 / 角色 1",
                }
            if method == "creative_assets.validate_draft":
                return {
                    "session": {
                        "draftSessionId": "creative_init_1",
                        "type": "creative-assets",
                        "status": "draft",
                        "version": 1,
                        "previewSummary": "主线 1 / 角色 1",
                    },
                    "validation": {"ok": True, "errors": [], "warnings": []},
                }
            return await original_invoke(method, params, origin, request_id=request_id)  # type: ignore[arg-type]

        automation.invoke = invoke  # type: ignore[method-assign]
        store = AgentStateStore(tmp_path)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        request = IntentRequest(
            message="初始化小说项目",
            conversationId="conv-initialize",
            entryHint=IntentEntryHint(
                actionId="novel.project_initialize",
                operationIds=["novel.project_initialize"],
                deliverable="creative_assets_draft",
                suggestedToolchainId="novel.project_initialize",
            ),
        )
        decision = IntentService().finalize(
            request,
            IntentService().preflight(request),
            SemanticProposal(responseContent="生成初始化草稿。", shouldPlan=True, confidence=0.95),
        )
        plan = await runtime.plan({
            "goal": "根据已确认蓝图初始化当前小说项目",
            "role": "worldbuilding",
            "intentDecision": decision.model_dump(),
            "bootstrapArtifactId": "artifact_blueprint_1",
            "bootstrapDraft": bootstrap_draft,
        }, {"novelId": "novel_1", "locale": "zh-CN"})

        assert plan.requiresApproval is True
        assert plan.steps[0].toolchain and plan.steps[0].toolchain.id == "novel.project_initialize"
        assert plan.steps[0].skills[0].stableId == "builtin.novel-bootstrap"
        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "approvalMode": "full_control",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {"novelId": "novel_1", "locale": "zh-CN"})
        # Windows runners can take longer to flush the async LangGraph SQLite
        # checkpoint after the creative-assets draft has been validated.
        for _ in range(2000):
            if runtime.state.runs[run.runId].status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed"
        assert {name for name, _ in calls}.issuperset({"creative_assets.generate_draft", "creative_assets.validate_draft"})
        artifact = next(item for item in completed.artifacts if item.type == "creative_assets_draft")
        assert artifact.metadata["bootstrapArtifactId"] == "artifact_blueprint_1"
        assert artifact.reference["draftSessionId"] == "creative_init_1"

    asyncio.run(scenario())


@pytest.mark.parametrize("transport", ["http", "fastmcp"])
def test_style_extraction_publishes_separate_skills_and_pack_binding(tmp_path, transport: str) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke
        scope_calls: list[dict[str, object]] = []
        call_deadlines: dict[str, str | None] = {}
        style_workspace: FakeStyleAuthoringWorkspace | None = None

        async def invoke(
            method: str,
            params: dict[str, object],
            origin: str,
            request_id: str | None = None,
            **kwargs: object,
        ) -> object:
            nonlocal style_workspace
            call_deadlines[method] = str(kwargs.get("deadline_at") or "") or None
            if method == "chapter.scope_context.build":
                scope_calls.append(params)
                return _scope_bundle()
            if method == "agent.plan_style_skill_pack":
                assert "builtin.style-skill-extractor" in str(params["agentSkill"])
                legacy = {
                    "summary": "样本支持语言节奏和悬念释放提炼；群像证据不足。",
                    "sourceCoverage": {"chapterCount": 2, "confidence": "medium", "gaps": ["缺少多视角章节"]},
                    "skills": [
                        {
                            "draftKey": "language_style",
                            "stableIdCandidate": "measured-short-sentence-style",
                            "title": "克制短句叙事",
                            "description": "用短句和受限叙述距离维持紧张感。",
                            "guidanceMode": "guided",
                            "confidence": "medium",
                            "triggerHints": ["写紧张调查场景"],
                            "antiTriggerHints": ["写百科式设定说明"],
                            "supportedOperations": ["chapter.continuation", "chapter.rewrite"],
                            "instructions": "控制句长，关键动作独立成段；只描述视角人物可感知的信息。",
                            "constraints": ["不得复用样本专名"],
                            "evidenceNotes": ["动作段落以短句为主"],
                            "contaminationWarnings": ["已移除人物名和具体情节"],
                            "evaluationPrompt": "使用中性调查场景比较节奏与信息清晰度。",
                        },
                        {
                            "draftKey": "suspense_release",
                            "stableIdCandidate": "layered-reveal-method",
                            "title": "分层揭示",
                            "description": "每次揭示回答局部问题并扩大核心疑问。",
                            "guidanceMode": "strict",
                            "confidence": "medium",
                            "triggerHints": ["设计悬念章节"],
                            "antiTriggerHints": ["一次性说明全部背景"],
                            "supportedOperations": ["chapter.continuation", "chapter.create"],
                            "instructions": "先建立读者问题，再布置可回看线索，章末只揭示一层。",
                            "constraints": ["线索必须在揭示前出现"],
                            "evidenceNotes": ["样本的揭示均回应前置问题"],
                            "contaminationWarnings": [],
                            "evaluationPrompt": "使用不含原作元素的密室场景测试线索可回看性。",
                        },
                    ],
                    "pack": {
                        "stableIdCandidate": "measured-suspense-pack",
                        "title": "克制悬念 Skill Pack",
                        "description": "组合语言节奏与信息释放方法。",
                        "bindings": [{
                            "operationId": "chapter.continuation",
                            "roleId": "writer",
                            "primaryDraftKey": "language_style",
                            "auxiliaryDraftKey": "suspense_release",
                        }],
                    },
                    "omittedDimensions": ["ensemble_progression：缺少多人物并行样本"],
                    "warnings": [],
                }
                style_workspace = FakeStyleAuthoringWorkspace(
                    _style_authoring_plan(legacy),
                    "skill_draft_style",
                    fail_once_path="suspense-release/SKILL.md",
                )
                return style_workspace.plan
            if style_workspace is not None:
                handled = await style_workspace.handle(method, params)
                if handled is not _UNHANDLED:
                    return handled
            return await original_invoke(method, params, origin, request_id=request_id)  # type: ignore[arg-type]

        automation.invoke = invoke  # type: ignore[method-assign]
        runtime = NovelAgentRuntime(
            store,
            automation,
            AgentEventBus(store),
            tool_adapter=FastMcpAgentToolAdapter(automation) if transport == "fastmcp" else None,
        )
        request = IntentRequest(
            message="根据当前样本提炼文风 Skill Pack",
            conversationId="conv-style",
            currentSelection={"novelId": "novel_1", "chapterId": "chapter_2"},
        )
        service = IntentService()
        decision = service.finalize(
            request,
            service.preflight(request),
            SemanticProposal(
                responseContent="生成提炼计划。",
                shouldPlan=True,
                requestedOperations=["agent_skill.style_extract"],
                confidence=0.95,
            ),
        )
        plan = await runtime.plan({
            "goal": request.message,
            "role": "writer",
            "novelId": "novel_1",
            "chapterId": "chapter_2",
            "intentDecision": decision.model_dump(),
        }, {"locale": "zh-CN"})
        assert plan.steps[0].skills[0].stableId == "builtin.style-skill-extractor"
        run = await runtime.execute_plan({
            "planId": plan.planId,
            "novelId": "novel_1",
            "chapterId": "chapter_2",
            "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
        }, {"locale": "zh-CN"})
        for _ in range(2000):
            if runtime.state.runs[run.runId].status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed", (
            list(call_deadlines),
            style_workspace.calls if style_workspace else [],
        )
        assert completed.deadlineAt is not None
        assert len(scope_calls) == 1
        assert all(value is not None for value in scope_calls[0].values())
        assert "sourceMode" not in scope_calls[0]
        assert "sourceWorkTitle" not in scope_calls[0]
        assert call_deadlines["chapter.scope_context.build"] == completed.deadlineAt
        assert call_deadlines["agent.plan_style_skill_pack"] == completed.deadlineAt
        assert call_deadlines["agent.generate_skill_document"] == completed.deadlineAt
        assert "agent.generate_style_skill_pack" not in call_deadlines
        assert style_workspace is not None
        assert style_workspace.generated_keys == [
            "language_style",
            "suspense_release",
            "suspense_release",
        ]
        artifact = next(item for item in completed.artifacts if item.type == "agent_skill_pack_draft")
        assert [item["draftKey"] for item in artifact.metadata["draft"]["skills"]] == ["language_style", "suspense_release"]
        assert artifact.metadata["draft"]["pack"]["bindings"][0]["auxiliaryDraftKey"] == "suspense_release"
        assert artifact.reference["skillDraftId"] == "skill_draft_style"
        assert artifact.metadata["skillDraft"]["status"] == "ready_for_review"
        assert "未生成维度" in str(artifact.content)

    asyncio.run(scenario())


@pytest.mark.parametrize("transport", ["http", "fastmcp"])
def test_style_extraction_scope_failure_reaches_ordered_terminal_events(tmp_path, transport: str) -> None:
    class FailingScopeAutomation(FakeAutomationClient):
        async def invoke(
            self,
            method: str,
            params: dict[str, object],
            origin: str,
            request_id: str | None = None,
            **_kwargs: object,
        ) -> object:
            if method == "chapter.scope_context.build":
                raise AutomationInvokeError("INVALID_INPUT", "scope rejected")
            return await super().invoke(method, params, origin, request_id=request_id)  # type: ignore[arg-type]

    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FailingScopeAutomation()
        runtime = NovelAgentRuntime(
            store,
            automation,
            AgentEventBus(store),
            tool_adapter=FastMcpAgentToolAdapter(automation) if transport == "fastmcp" else None,
        )
        step = AgentPlanStep(
            stepId="step-style-failure",
            agent="writer",
            title="提炼文风 Skill Pack",
            tools=[],
            toolchain=ToolchainInvocation(
                id="agent_skill.style_extract",
                version="1.0.0",
                input=StyleSkillExtractionInput(
                    sourceMode="project_chapter_scope",
                    sourceWorkTitle=None,
                    scopeId=None,
                    novelId="novel_1",
                    kind="selected_chapters",
                    chapterId="chapter_2",
                    chapterIds=["chapter_1", "chapter_2"],
                    anchorChapterId="chapter_2",
                    goal="根据当前样本提炼文风 Skill Pack",
                    maxEstimatedTokens=None,
                ).model_dump(),
            ),
        )
        plan = AgentPlan(
            planId="plan-style-failure",
            threadId="thread-style-failure",
            title="文风 Skill 提炼",
            goal="根据当前样本提炼文风 Skill Pack",
            requiresApproval=True,
            steps=[step],
            preferredRole="writer",
            deliverable="report",
        )
        runtime.state.plans[plan.planId] = plan
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_2",
                "approval": {"approved": True, "approvedStepIds": [step.stepId]},
            },
            {"locale": "zh-CN"},
        )
        for _ in range(500):
            if runtime.state.runs[run.runId].status in {"completed", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.01)

        failed = runtime.state.runs[run.runId]
        assert failed.status == "failed"
        event_types = [event.type for event in store.list_events(run.runId)]
        expected = ["tool_call", "tool_result", "toolchain_failed", "step_failed", "run_failed"]
        positions = [event_types.index(event_type) for event_type in expected]
        assert positions == sorted(positions)
        failed_tool = next(event for event in failed.events if event.type == "tool_result")
        assert failed_tool.status == "failed"
        assert failed_tool.payload["code"] == "INVALID_INPUT"
        terminal = next(event for event in failed.events if event.type == "run_failed")
        assert terminal.payload["code"] == "INVALID_INPUT"

    asyncio.run(scenario())


def test_agent_skill_author_persists_review_draft_without_committing(tmp_path) -> None:
    class AuthorAutomation:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, object]]] = []

        async def invoke(self, method: str, params: dict[str, object], *_args: object, **_kwargs: object) -> object:
            self.calls.append((method, params))
            if method == "agent_skill.workspace.create":
                assert params["scope"] == "user"
                return {"draftId": "draft_author_1", "version": 1, "status": "editing", "phase": "authoring"}
            if method == "agent_skill.workspace.read":
                return {"draftId": "draft_author_1", "version": 1, "logicalPath": "SKILL.md", "contentText": ""}
            if method == "agent.generate_skill_document":
                assert params["attempt"] == 1
                assert params["creatorProfile"] == "builtin.skill-creator"
                return {"contentText": "---\nschemaVersion: novel-editor.agent-skill.v1\n---\n\n方法"}
            if method == "agent_skill.workspace.write":
                assert params["expectedVersion"] == 1
                return {"draftId": "draft_author_1", "version": 2, "status": "editing", "phase": "authoring"}
            if method == "agent_skill.workspace.validate":
                assert params["expectedVersion"] == 2
                return {
                    "draftId": "draft_author_1", "version": 3, "status": "editing", "phase": "validating",
                    "validationReport": {"ok": True, "diagnostics": []},
                }
            if method == "agent_skill.workspace.compile":
                assert params["expectedVersion"] == 3
                return {"draftId": "draft_author_1", "version": 4, "status": "ready_for_review", "phase": "compiled"}
            if method == "agent_skill.draft.get":
                return {
                    "id": "draft_author_1", "version": 4, "status": "ready_for_review",
                    "draft": {
                        "definition": {
                            "stableId": "scene-pressure-builder",
                            "title": "场景压力构建",
                            "description": "在规划或续写冲突场景时，逐层增加人物选择压力。",
                        },
                        "revision": {
                            "version": "1.0.0",
                            "instructions": "识别人物当前目标，再增加会迫使其付出代价的障碍。",
                            "constraints": ["压力升级必须来自既有目标或关系"],
                            "examples": [],
                            "manifest": {"supportedOperations": ["chapter.continuation", "chapter.rewrite"]},
                        },
                    },
                }
            raise AssertionError(f"unexpected method: {method}")

    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = AuthorAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))  # type: ignore[arg-type]
        result = await runtime.author_skill(
            {"goal": "创建一个逐层增强场景压力的 Skill", "scope": "user"},
            {"locale": "zh-CN", "_requestId": "request_author_1"},
        )
        assert result["requiresReview"] is True
        assert result["draft"]["id"] == "draft_author_1"
        assert [method for method, _params in automation.calls] == [
            "agent_skill.workspace.create",
            "agent_skill.workspace.read",
            "agent.generate_skill_document",
            "agent_skill.workspace.write",
            "agent_skill.workspace.validate",
            "agent_skill.workspace.compile",
            "agent_skill.draft.get",
        ]
        assert all(method != "agent_skill.draft.commit" for method, _params in automation.calls)

    asyncio.run(scenario())


def test_agent_skill_author_keeps_needs_attention_workspace_after_four_invalid_rounds(tmp_path) -> None:
    class InvalidAuthorAutomation:
        def __init__(self) -> None:
            self.version = 1
            self.generate_count = 0

        async def invoke(self, method: str, params: dict[str, object], *_args: object, **_kwargs: object) -> object:
            if method == "agent_skill.workspace.create":
                return {"draftId": "draft_attention_1", "version": self.version, "phase": "authoring"}
            if method == "agent_skill.workspace.read":
                return {"draftId": "draft_attention_1", "version": self.version, "contentText": "invalid"}
            if method == "agent.generate_skill_document":
                self.generate_count += 1
                return {"contentText": "仍然缺少合法 Frontmatter"}
            if method == "agent_skill.workspace.write":
                assert params["expectedVersion"] == self.version
                self.version += 1
                return {"draftId": "draft_attention_1", "version": self.version, "phase": "authoring"}
            if method == "agent_skill.workspace.validate":
                assert params["expectedVersion"] == self.version
                self.version += 1
                return {
                    "draftId": "draft_attention_1",
                    "version": self.version,
                    "phase": "needs_attention" if params["finalAttempt"] else "revising",
                    "validationReport": {
                        "ok": False,
                        "errorCount": 1,
                        "diagnostics": [{"code": "SKILL_FRONTMATTER_MISSING", "path": "SKILL.md"}],
                    },
                }
            if method == "agent_skill.draft.get":
                return {"id": "draft_attention_1", "version": self.version, "status": "editing", "draft": {}}
            raise AssertionError(f"unexpected method: {method}")

    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = InvalidAuthorAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))  # type: ignore[arg-type]
        result = await runtime.author_skill(
            {"goal": "创建一个边界尚不完整的 Skill", "scope": "user"},
            {"locale": "zh-CN", "_requestId": "request_author_attention"},
        )
        assert result["requiresReview"] is False
        assert result["needsAttention"] is True
        assert result["workspace"]["phase"] == "needs_attention"
        assert result["draft"]["id"] == "draft_attention_1"
        assert automation.generate_count == 4

    asyncio.run(scenario())


def test_persisted_skill_is_listed_and_pack_binding_selects_locked_revision(tmp_path) -> None:
    class PersistedAutomation:
        async def invoke(self, method: str, _params: dict[str, object], *_args: object, **_kwargs: object) -> object:
            if method == "agent_skill.list":
                return [{"id": "skill_user_1", "revisionId": "revision_user_1"}]
            if method == "agent_skill.get":
                return {
                    "id": "skill_user_1",
                    "stableId": "scene-pressure-builder",
                    "title": "场景压力构建",
                    "description": "在续写冲突场景时逐层增加选择压力。",
                    "scope": "user",
                    "ownerNovelId": None,
                    "enabled": True,
                    "revision": {
                        "id": "revision_user_1",
                        "version": "1.0.0",
                        "manifest": {
                            "category": "narrative_method",
                            "guidanceMode": "guided",
                            "semanticSelection": "suggest",
                            "triggerHints": ["增强场景冲突"],
                            "antiTriggerHints": ["只校对错别字"],
                            "allowedRoles": ["writer"],
                            "supportedOperations": ["chapter.continuation"],
                            "recommendedToolchains": [],
                            "contextNeeds": ["current_chapter"],
                            "outputType": "none",
                        },
                        "instructions": "识别人物目标，再增加迫使其付出代价的障碍。",
                        "constraints": ["压力必须来自既有目标"],
                        "examples": [],
                        "contentHash": "0" * 64,
                        "createdAt": "2026-08-04T00:00:00Z",
                    },
                }
            if method == "agent_skill.binding.list":
                return [{
                    "skillId": "skill_user_1", "novelId": None, "roleId": "writer",
                    "operationId": "chapter.continuation", "bindingType": "pack_primary", "priority": 100,
                }]
            return {}

    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        runtime = NovelAgentRuntime(store, PersistedAutomation(), AgentEventBus(store))  # type: ignore[arg-type]
        listed = await runtime.skills({"locale": "zh-CN"}, {})
        assert any(item["id"] == "skill_user_1" for item in listed)
        plan = AgentPlan(
            planId="plan-bound-skill",
            threadId="thread-bound-skill",
            title="续写",
            goal="续写当前章节",
            steps=[AgentPlanStep(
                stepId="step-bound-skill",
                agent="writer",
                title="续写",
                toolchain=ToolchainInvocation(id="chapter.continuation", version="1.0.0", input={}),
            )],
        )
        resolved = runtime._apply_agent_skills_to_plan(plan, None, locale="zh-CN", novel_id="novel_1")
        assert resolved.steps[0].skills[0].skillId == "skill_user_1"
        assert resolved.steps[0].skills[0].revisionId == "revision_user_1"
        assert resolved.steps[0].skills[0].selectionSource == "preset"

    asyncio.run(scenario())


def test_builtin_skills_remain_available_when_automation_bridge_is_unavailable(tmp_path) -> None:
    class UnavailableAutomation:
        async def invoke(self, method: str, *_args: object, **_kwargs: object) -> object:
            raise AutomationInvokeError("AUTOMATION_HTTP_ERROR", f"{method}: HTTP 503", status_code=503)

    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        runtime = NovelAgentRuntime(
            store,
            UnavailableAutomation(),
            AgentEventBus(store),
        )  # type: ignore[arg-type]
        listed = await runtime.skills({"locale": "zh-CN"}, {})
        assert {item["id"] for item in listed} >= {
            "builtin.continuity-review",
            "builtin.novel-bootstrap",
            "builtin.style-skill-extractor",
        }

    asyncio.run(scenario())
