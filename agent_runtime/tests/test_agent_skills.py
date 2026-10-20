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
from novel_agent_runtime.automation import AutomationClient, AutomationInvokeError
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
    def __init__(self, plan: dict[str, object], draft_id: str, *, fail_once_path: str | None = None,
                 reject_document_once: bool = False, reject_trials: bool = False) -> None:
        self.plan = plan
        self.draft_id = draft_id
        self.version = 0
        self.documents: dict[str, str] = {}
        self.pack: dict[str, object] = {}
        self.calls: list[str] = []
        self.generated_keys: list[str] = []
        self.fail_once_path = fail_once_path
        self.failed_validation_once = False
        self.reject_document_once = reject_document_once
        self.reject_trials = reject_trials

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
        if method == "agent.style_quality":
            from novel_agent_runtime.style_quality import CRITERIA, TRIAL_CRITERIA, FIDELITY_TRIAL_CRITERIA
            phase = params["phase"]
            if phase == "evidence":
                return {"phase": phase, "decisions": [{"findingRef": candidate["findingRef"], "feature": "short_actions",
                    "disposition": "supported", "reason": "局部短证据支持该观察"} for candidate in params["source"]["candidates"]]}
            if phase == "generate_trial":
                docs = params["source"]["documents"]
                prefix = "值班员完成交接登记。" if not docs else "钟走了一格。" if len(docs) == 1 and docs[0]["draftKey"] == "language_style" else "封条完好，时间却对不上。" if len(docs) == 1 else "凭证放在桌上，重量栏仍是空白。"
                return {"phase": phase, "text": prefix + "值班员看了一眼墙钟，又核对登记时间。取件人把凭证放在桌上，手却没有离开纸面。保管盒的封条完好，重量栏仍是空白。值班员没有交付，先请对方说明物品。" * 4}
            checks = {key: "pass" for key in (CRITERIA if phase == "document" else FIDELITY_TRIAL_CRITERIA if params['source'].get('fidelityMode') == 2 else TRIAL_CRITERIA)}
            if phase == "document" and getattr(self, "advisory_docs", False):
                return {"phase": phase, "summary": "核心检查通过，可润色", "checks": checks,
                    "issues": [{"severity": "advisory", "message": "可选：增加一个应用例子"}]}
            if phase == "document" and self.reject_document_once and params["source"]["document"]["draftKey"] == "suspense_release":
                self.reject_document_once = False
                checks["rule_calibration"] = "fail"
                return {"phase": phase, "summary": "低置信却强制短句", "checks": checks, "issues": [{"message": "撤销固定章末句数并保留可调建议"}]}
            if phase == "trial" and self.reject_trials:
                checks["style_application"] = "unverified"
                return {"phase": phase, "summary": "未验证文风应用", "checks": checks, "issues": [{"message": "不得声明试写达标"}]}
            return {"phase": phase, "summary": "已检查应用与证据边界", "checks": checks, "issues": []}
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
            content = self._document(member, str(params["scope"]))
            if getattr(self, "broken_member_headers", False):
                assert params["contentOnly"] is True
                content = "---\nschemaVersion: novel-editor.agent-skill.v1\nstableId: model.changed-id\nsemanticSelection: true\n## 应用方法\n按规划与已核验的边界条件输出原创正文，不使用无证据的硬阈值。"
            if any(d.get("code") == "STYLE_CONTENT_REVIEW" for d in params.get("validationDiagnostics", [])):
                content += "\n应用模式输出原创正文；章末节奏是可调建议，不规定固定句数。"
            return {"contentText": content}
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

    assert len(entries) == 4
    entry = next(item for item in entries if item.stableId == "builtin.continuity-review")
    assert entry.stableId == "builtin.continuity-review"
    assert entry.title == "连续性审查"
    assert entry.version == "1.0.0"
    assert entry.supportedOperations == ["chapter.consistency_review"]
    assert "instructions" not in entry.model_dump()
    assert "constraints" not in entry.model_dump()


def test_builtin_registry_localizes_public_metadata() -> None:
    entry = next(item for item in BUILTIN_AGENT_SKILL_REGISTRY.list_index(locale="en-US")
                 if item.stableId == "builtin.continuity-review")

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

        async def invoke(method: str, params: dict[str, object], origin: str, request_id: str | None = None, **_request_context) -> object:
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

    assert revision.revisionId == "builtin.style-skill-extractor@1.4.0"
    assert BUILTIN_AGENT_SKILL_REGISTRY.revision(registration.definition.id, "builtin.style-skill-extractor@1.2.0").version == "1.2.0"
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

        async def invoke(method: str, params: dict[str, object], origin: str, request_id: str | None = None, **_request_context) -> object:
            if method == 'agent_skill.pack.default.get':
                return {'packId': None, 'version': 0}
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

        async def invoke(method: str, params: dict[str, object], origin: str, request_id: str | None = None, **_request_context) -> object:
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
        report_params = next(params for method, params, _ in automation.calls if method == "agent.generate_report")
        blueprint_finding = next(item["data"] for item in report_params["findings"] if item["toolName"].startswith("toolchain:novel.bootstrap"))
        assert blueprint_finding["artifactId"] == artifact.artifactId
        assert blueprint_finding["status"] == "ready"
        assert blueprint_finding["summary"] == artifact.metadata["draft"]["corePremise"]
        assert len(blueprint_finding["chapterPlan"]) == 3

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

        async def invoke(method: str, params: dict[str, object], origin: str, request_id: str | None = None, **_request_context) -> object:
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
            SemanticProposal(
                responseContent="生成初始化草稿。", shouldPlan=True, confidence=0.95,
                requestedOperations=["novel.project_initialize", "creative_asset.draft"],
            ),
        )
        plan = await runtime.plan({
            "goal": "根据已确认蓝图初始化当前小说项目",
            "role": "worldbuilding",
            "intentDecision": decision.model_dump(),
            "bootstrapArtifactId": "artifact_blueprint_1",
            "bootstrapDraft": bootstrap_draft,
        }, {"novelId": "novel_1", "locale": "zh-CN"})

        assert plan.requiresApproval is True
        assert len(plan.steps) == 1, "Initialization already owns the creative-assets draft"
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
        await asyncio.wait_for(asyncio.gather(*tuple(runtime._run_tasks.values())), timeout=60)
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed"
        assert {name for name, _ in calls}.issuperset({"creative_assets.generate_draft", "creative_assets.validate_draft"})
        assert sum(name == "creative_assets.generate_draft" for name, _ in calls) == 1
        artifact = next(item for item in completed.artifacts if item.type == "creative_assets_draft")
        assert artifact.metadata["bootstrapArtifactId"] == "artifact_blueprint_1"
        assert artifact.reference["draftSessionId"] == "creative_init_1"

    asyncio.run(scenario())


@pytest.mark.parametrize("transport", ["http", "fastmcp"])
@pytest.mark.parametrize("plan_goal", [
    "根据当前样本提炼文风 Skill Pack",
    "重新执行\n\n会话背景（仅用于理解当前任务）：\n用户：根据当前选择的小说样本，提炼文风 Skill Pack\nAgent：本次范围为《样本作品》整本。",
    "根据当前选择的《样本作品》小说正文，提炼文风 Skill Pack",
    "根据当前样本提炼文风 Skill Pack，记录证据缺口",
    "根据当前样本提炼文风 Skill Pack，收尾验收",
    "根据当前样本提炼文风 Skill Pack，内容审核验收",
    "根据当前样本提炼文风 Skill Pack，试写失败保留",
    "根据当前样本提炼文风 Skill Pack，证据截断验收",
    "根据当前样本提炼文风 Skill Pack broken_header_check",
    "根据当前样本提炼文风 Skill Pack advisory_check",
    "根据当前样本提炼文风 Skill Pack ensemble_check",
])
def test_style_extraction_publishes_separate_skills_and_pack_binding(tmp_path, transport: str, plan_goal: str) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        original_invoke = automation.invoke
        scope_calls: list[dict[str, object]] = []
        call_deadlines: dict[str, str | None] = {}
        report_payloads: list[dict[str, object]] = []
        style_workspace: FakeStyleAuthoringWorkspace | None = None
        analysis_calls: list[str] = []
        evidence_call_sizes: list[int] = []
        closing = "收尾验收" in plan_goal

        async def invoke(
            method: str,
            params: dict[str, object],
            origin: str,
            request_id: str | None = None,
            **kwargs: object,
        ) -> object:
            nonlocal style_workspace
            call_deadlines[method] = str(kwargs.get("deadline_at") or "") or None
            if method == "agent.generate_report":
                report_payloads.append(params)
            if method == "chapter.scope_context.build":
                scope_calls.append(params)
                bundle = _scope_bundle()
                if closing and params.get("representation") == "catalog" and params.get("chapterIds") == ["chapter_1", "chapter_2"]:
                    bundle["chapters"] = bundle["chapters"][:2]
                    bundle["sourceSnapshot"] = bundle["sourceSnapshot"][:2]
                    bundle["scope"]["snapshot"] = bundle["sourceSnapshot"]
                    bundle["scope"]["chapterIds"] = ["chapter_1", "chapter_2"]
                    bundle["scope"]["anchorChapterId"] = "chapter_1"
                return bundle
            if method == "agent.get_skill_execution_policy":
                return {"maxInputBytes": 48000, "outputReserveTokens": 32768,
                        "maxConcurrency": 3, "maxModelCalls": 2048, "maxTotalTokens": 64000000}
            if method == "agent.plan_skill_execution":
                return {"executionMode": "delegated", "dependency": "none", "reason": "Independent observations"}
            if method in {"agent.analyze_skill_work_unit", "agent.merge_skill_analysis"}:
                assert "builtin.style-skill-extractor" in str(params["agentSkill"])
                if closing:
                    if method == "agent.merge_skill_analysis":
                        return params["source"]["results"][0]
                    sample = params["source"]["samples"][0]
                    analysis_calls.append(sample["sourceId"])
                    if sample["sourceId"] == "chapter_3":
                        raise AutomationInvokeError("MODEL_OUTPUT_INVALID", "Failed last chapter")
                    return {"summary": "Verified chapter", "findings": [{"dimension": "language_style",
                        "observation": "Short actions", "confidence": "medium",
                        "evidence": [{"sourceId": sample["sourceId"], "excerpt": "正文"}]}], "warnings": []}
                if "记录证据缺口" in plan_goal:
                    if method == "agent.merge_skill_analysis":
                        return params["source"]["results"][0]  # type: ignore[index]
                    sample = params["source"]["samples"][0]  # type: ignore[index]
                    return {"summary": "Features with a quote gap", "findings": [{
                        "dimension": "language_style", "observation": "Short actions", "confidence": "high",
                        "evidence": [{"sourceId": sample["sourceId"], "excerpt": "正文"},
                                     {"sourceId": sample["sourceId"], "excerpt": "并不存在的引文"}],
                    }], "warnings": []}
                if "证据截断验收" in plan_goal:
                    if method == "agent.merge_skill_analysis":
                        return params["source"]["results"][0]
                    sample = params["source"]["samples"][0]
                    analysis_calls.append(sample["sourceId"])
                    return {"summary": "Local observations", "findings": [{"dimension": "language_style",
                        "observation": f"局部动作观察{i}", "confidence": "medium",
                        "evidence": [{"sourceId": sample["sourceId"], "excerpt": "正文"}]} for i in range(8)], "warnings": []}
                return {"summary": "Bounded verified features", "findings": [], "warnings": []}
            if method == "agent.style_quality" and params["phase"] == "evidence" and "证据截断验收" in plan_goal:
                size = len(params["source"]["candidates"])
                evidence_call_sizes.append(size)
                if size > 4:
                    raise AutomationInvokeError("MODEL_OUTPUT_TRUNCATED", "confirmed output limit")
            if method == "agent.style_quality" and style_workspace is None:
                if "ensemble_check" in plan_goal:
                    return {"phase": "evidence", "decisions": [{"findingRef": c["findingRef"], "feature": "ensemble",
                        "disposition": "unresolved", "reason": "仅局部候选"} for c in params["source"]["candidates"]]}
                return await FakeStyleAuthoringWorkspace({}, "pending").handle(method, params)
            if method == "agent.style_quality" and params["phase"] == "generate_trial" and "ensemble_check" in plan_goal:
                assert "五人" in params["source"]["scene"] or "过渡场景" in params["source"]["scene"]
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
                if "ensemble_check" in plan_goal:
                    member = {**legacy["skills"][0], "draftKey": "ensemble_progression", "stableIdCandidate": "local-ensemble-method",
                        "title": "局部群像方法", "confidence": "low"}
                    legacy["skills"].append(member)
                    legacy["omittedDimensions"] = []
                style_workspace = FakeStyleAuthoringWorkspace(
                    _style_authoring_plan(legacy),
                    "skill_draft_style",
                    fail_once_path="suspense-release/SKILL.md",
                    reject_document_once="内容审核验收" in plan_goal,
                    reject_trials="试写失败保留" in plan_goal,
                )
                style_workspace.broken_member_headers = "broken_header_check" in plan_goal
                style_workspace.advisory_docs = "advisory_check" in plan_goal
                style_workspace.plan["summary"] = "规划只承载维度清单，尚未编写 SKILL.md 正文。"
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
            message=plan_goal.split("\n\n会话背景（仅用于理解当前任务）：\n", 1)[0],
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
            "goal": plan_goal,
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
        await asyncio.wait_for(asyncio.gather(*tuple(runtime._run_tasks.values())), timeout=60)
        completed = runtime.state.runs[run.runId]
        if closing:
            assert completed.status == "failed"
            assert completed.recovery.canFinalizeCompleted is True
            chat = await runtime.chat({"message": "就以当前结果提炼，后续章节可以不用管了", "conversationId": "conv-style",
                "novelId": "novel_1", "chapterId": "chapter_2",
                "conversationContext": {"priorRuns": [{"runId": run.runId, "status": "failed"}]}}, {"locale": "zh-CN"})
            assert chat.intentDecision.route == "retry_failed_run"
            assert chat.intentDecision.recovery.mode == "use_completed_results"
            assert len(runtime.state.plans) == 1
            resumed = await runtime.retry_run(chat.intentDecision.recovery.model_dump(), {})
            await asyncio.wait_for(asyncio.gather(*tuple(runtime._run_tasks.values())), timeout=60)
            completed = runtime.state.runs[resumed.runId]
            assert completed.retryRootRunId == run.runId
            assert completed.completionKind == "partial"
            assert analysis_calls == ["chapter_1", "chapter_2", "chapter_3"]
        if "试写失败保留" in plan_goal:
            assert completed.status == "failed"
            assert completed.failure["code"] == "STYLE_SKILL_WORKSPACE_NEEDS_ATTENTION"
            assert style_workspace is not None and style_workspace.documents
            assert "agent_skill.workspace.compile" not in style_workspace.calls
            assert not any(a.type == "agent_skill_pack_draft" for a in completed.artifacts)
            assert len(scope_calls) == 6
            return
        assert completed.status == "completed", (
            completed.failure,
            list(call_deadlines),
            style_workspace.calls if style_workspace else [],
        )
        assert completed.deadlineAt is not None
        if "证据截断验收" in plan_goal:
            assert analysis_calls == ["chapter_1", "chapter_2", "chapter_3"]
            assert max(evidence_call_sizes) == 8 and evidence_call_sizes.count(4) == 6
        assert len(scope_calls) == (8 if closing else 7)  # catalog-only version checks before review and publication
        assert scope_calls[0]["representation"] == "catalog"
        assert all(call["representation"] == "verbatim" for call in scope_calls[2:5])
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
            *(["ensemble_progression"] if "ensemble_check" in plan_goal else []),
            "suspense_release",
        ] + (["suspense_release"] if "内容审核验收" in plan_goal else [])
        artifact = next(item for item in completed.artifacts if item.type == "agent_skill_pack_draft")
        quality = artifact.metadata["qualityReview"]
        if "broken_header_check" in plan_goal:
            assert all("model.changed-id" not in text and "semanticSelection: suggest" in text
                for text in style_workspace.documents.values())
        if "advisory_check" in plan_goal:
            assert all(r["accepted"] and r["issues"][0]["severity"] == "advisory" for r in quality["documentReviews"])
        if "证据截断验收" in plan_goal:
            assert quality["evidenceAudit"]["candidateCount"] == 24
        assert quality["status"] == "passed"
        member_count = 3 if "ensemble_check" in plan_goal else 2
        trial_count = member_count + 2 + (1 if member_count == 3 else 0)
        if quality['version'] == 2:
            trial_count *= 2
        assert len(quality["trials"]) == trial_count
        assert {p['primaryDraftKey'] for p in quality['verifiedCombinations']} == {'language_style'}
        if member_count == 3:
            assert any(p['auxiliaryDraftKey'] == 'ensemble_progression' for p in quality['verifiedCombinations'])
        assert quality["trials"]["baseline"] != quality["trials"]["pack"]
        assert all(text in artifact.content for text in quality["trials"].values())
        assert [item["draftKey"] for item in artifact.metadata["draft"]["skills"]] == ["language_style", "suspense_release",
            *(["ensemble_progression"] if "ensemble_check" in plan_goal else [])]
        assert artifact.metadata["draft"]["pack"]["bindings"][0]["auxiliaryDraftKey"] == "suspense_release"
        assert artifact.reference["skillDraftId"] == "skill_draft_style"
        assert artifact.metadata["draft"]["sourceCoverage"]["chapterCount"] == (2 if closing else 3)
        assert artifact.metadata["draft"]["sourceCoverage"]["analysisCoverage"]["analyzedChapterCount"] == (2 if closing else 3)
        assert artifact.metadata["skillDraft"]["status"] == "ready_for_review"
        assert f"已生成 {member_count} 个独立文风 Skill 成员" in artifact.summary
        assert ("实际覆盖 2/3 章" if closing else "已分析 3 章正文") in artifact.summary
        assert "尚未编写" not in artifact.summary
        assert artifact.metadata["authoringPlanSummary"] == "规划只承载维度清单，尚未编写 SKILL.md 正文。"
        assert len(report_payloads) == 1
        delivery = report_payloads[0]["artifacts"][0]  # type: ignore[index]
        assert delivery["reference"]["skillDraftId"] == "skill_draft_style"
        expected_delivery = {"memberCount": member_count, "authoredMemberCount": member_count,
            "sourceType": "analyzed_chapter_scope", "chaptersRead": 3, "draftStatus": "ready_for_review"}
        expected_delivery.update({"contentReviewPassed": True, "applicationTrialsCompleted": trial_count, "qualityLimitation": quality["limitation"]})
        if closing:
            expected_delivery.update({"chaptersRead": 2, "completionMode": "use_completed_results", "totalChapterCount": 3, "omittedChapterCount": 1})
            assert artifact.metadata["source"]["coverage"]["omittedChapterIds"] == ["chapter_3"]
            assert "第3章" in artifact.content
            assert any("仅覆盖 2/3" in item for item in artifact.metadata["draft"]["sourceCoverage"]["gaps"])
        if "记录证据缺口" in plan_goal:
            expected_delivery["evidenceGapChapterCount"] = 3
            assert "3 章存在引用核验缺口" in artifact.summary
            assert any("剔除 3 条" in item for item in artifact.metadata["draft"]["warnings"])
        assert delivery["skillDelivery"] == expected_delivery
        assert report_payloads[0]["draftSessionId"] is None
        if "ensemble_check" not in plan_goal:
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
            if method == 'agent_skill.pack.default.get':
                return {'packId': None, 'version': 0}
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
            if method == 'agent_skill.pack.default.get':
                return {'packId': None, 'version': 0}
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


def test_agent_skill_revise_updates_same_draft_and_keeps_version_guard(tmp_path) -> None:
    class ReviseAutomation:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, object]]] = []
            self.version = 7
            self.fail_after_generation = False

        async def invoke(self, method: str, params: dict[str, object], *_args: object, **_kwargs: object) -> object:
            if method == 'agent_skill.pack.default.get':
                return {'packId': None, 'version': 0}
            self.calls.append((method, params))
            if method == "agent_skill.draft.get":
                return {
                    "id": "existing-style", "scope": "novel", "sourceNovelId": "novel-1",
                    "version": self.version, "status": "editing",
                    "draft": {"authoring": {"documents": [{
                        "logicalPath": "SKILL.md", "contentText": "---\nscope: novel\n---\n\n原有文风规则。",
                    }]}},
                }
            if method == "agent.generate_skill_document":
                assert params["contentOnly"] is True
                assert params["scope"] == "novel"
                assert params["goal"] == "减少环境描写"
                if self.fail_after_generation:
                    self.version += 1
                return {"contentText": "保留人物行动，减少重复环境描写。"}
            if method == "agent_skill.workspace.prepare":
                assert params["expectedVersion"] == 7
                assert params["draftId"] == "existing-style"
                assert params["rules"] == {"instructions": "保留人物行动，减少重复环境描写。"}
                if self.version != params["expectedVersion"]:
                    raise AutomationInvokeError("AGENT_SKILL_DRAFT_VERSION_CONFLICT", "changed")
                return {"draft": {"id": "existing-style", "version": 8, "status": "ready_for_review"}}
            raise AssertionError(f"unexpected mutation: {method}")

    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = ReviseAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))  # type: ignore[arg-type]
        params = {"draftId": "existing-style", "expectedVersion": 7, "goal": "减少环境描写", "novelId": "novel-1"}
        result = await runtime.revise_skill(params, {})
        assert result["draft"]["id"] == "existing-style"
        assert [method for method, _ in automation.calls] == [
            "agent_skill.draft.get", "agent.generate_skill_document", "agent_skill.workspace.prepare",
        ]
        for updates, code in [
            ({"expectedVersion": 6}, "AGENT_SKILL_DRAFT_VERSION_CONFLICT"),
            ({"novelId": "novel-2"}, "AGENT_SKILL_SCOPE_MISMATCH"),
            ({"logicalPath": "references/notes.md"}, "AGENT_SKILL_WORKSPACE_DOCUMENT_NOT_FOUND"),
        ]:
            automation.calls.clear()
            with pytest.raises(AgentSkillError) as error:
                await runtime.revise_skill({**params, **updates}, {})
            assert error.value.code == code
            assert len(automation.calls) == 1  # Reject before invoking a model or writing.
        automation.fail_after_generation = True
        with pytest.raises(AutomationInvokeError) as error:
            await runtime.revise_skill(params, {})
        assert error.value.code == "AGENT_SKILL_DRAFT_VERSION_CONFLICT"

    asyncio.run(scenario())


def test_agent_skill_revise_model_failure_keeps_original_draft(tmp_path) -> None:
    class FailedAutomation:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def invoke(self, method: str, _params: dict[str, object], *_args: object, **_kwargs: object) -> object:
            self.calls.append(method)
            if method == "agent_skill.draft.get":
                return {"id": "draft-1", "version": 1, "status": "editing", "scope": "user",
                        "draft": {"authoring": {"documents": [{"logicalPath": "SKILL.md", "contentText": "原有要求"}]}}}
            raise AutomationInvokeError("PROVIDER_TIMEOUT", "timeout")

    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FailedAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))  # type: ignore[arg-type]
        with pytest.raises(AutomationInvokeError):
            await runtime.revise_skill({"draftId": "draft-1", "expectedVersion": 1, "goal": "缩短规则"}, {})
        assert automation.calls == ["agent_skill.draft.get", "agent.generate_skill_document"]

    asyncio.run(scenario())


def test_persisted_skill_is_listed_and_pack_binding_selects_locked_revision(tmp_path) -> None:
    class PersistedAutomation:
        async def invoke(self, method: str, _params: dict[str, object], *_args: object, **_kwargs: object) -> object:
            if method == "agent_skill.list":
                full = await self.invoke("agent_skill.get", _params)
                revision = full["revision"]
                return [{**{key: value for key, value in full.items() if key != "revision"},
                    **{key: revision[key] for key in ("version", "contentHash", "manifest")},
                    "revisionId": revision["id"]}]
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
        # Listing is metadata-only; planning owns loading the execution registry.
        await runtime._refresh_persisted_skills("novel_1")
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


def test_chat_uses_fresh_published_skill_state_instead_of_old_draft_notice(tmp_path) -> None:
    published = {
        "id": "skill_saved", "stableId": "user.style.saved", "title": "文风1.0",
        "description": "减少解释并推动事件。", "scope": "user", "enabled": True,
        "revision": {
            "id": "revision_saved", "version": "1.0.0", "contentHash": "0" * 64,
            "createdAt": "2026-10-01T00:00:00Z", "instructions": "减少解释，每段推动事件。",
            "manifest": {"category": "style", "supportedOperations": ["chapter.rewrite"], "allowedRoles": ["writer"]},
        },
    }

    class PublishedAutomation(FakeAutomationClient):
        async def invoke(self, method, params, origin, **kwargs):
            if method == "agent_skill.get":
                assert params == {"skillId": "skill_saved", "revisionId": "revision_saved"}
                return published
            if method == "agent.generate_chat":
                self.calls.append((method, params, origin))
                assert params["skillSelectionContext"]["status"] == "published"
                assert params["skillSelectionContext"]["validated"] is True
                return {"content": "已选择保存的文风，准备重写。", "shouldPlan": True,
                        "requestedOperations": ["chapter.rewrite"], "deliverable": "chapter_draft",
                        "confidence": 0.99, "toolCalls": [], "inputRequest": None}
            return await super().invoke(method, params, origin, request_id=kwargs.get("request_id"))

    async def scenario():
        store = AgentStateStore(tmp_path)
        automation = PublishedAutomation()
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        response = await runtime.chat({
            "message": "重写本章", "novelId": "novel_1", "chapterId": "chapter_1",
            "conversationId": "conv_saved", "source": "shortcut",
            "history": [{"role": "assistant", "content": "文风1.0 未通过校验，不能参与任务。"}],
            "entryHint": {"actionId": "skill.use", "kind": "skill.use", "skillId": "skill_saved",
                          "requestedRevisionId": "revision_saved"},
        }, {})
        assert response.intentDecision.requestedSkills[0].requestedRevisionId == "revision_saved"
        payload = next(params for method, params, _ in automation.calls if method == "agent.generate_chat")
        assert payload["skillSelectionContext"]["title"] == "文风1.0"
        assert payload["skillSelectionContext"]["revisionId"] == "revision_saved"
        assert "instructions" not in payload["skillSelectionContext"], "Method body must not change chat voice"

        published["enabled"] = False
        selected = IntentEntryHint(actionId="skill.use", kind="skill.use", skillId="skill_saved",
                                   requestedRevisionId="revision_saved")
        disabled = await runtime._chat_skill_selection_context(selected, "novel_1")
        assert disabled["status"] == "published" and disabled["enabled"] is False
        published["scope"] = "novel"
        published["ownerNovelId"] = "other_novel"
        assert (await runtime._chat_skill_selection_context(selected, "novel_1"))["status"] == "scope_mismatch"
        published["scope"] = "user"
        published.pop("ownerNovelId")
        published["revision"]["id"] = "different_revision"
        unavailable = await runtime._chat_skill_selection_context(selected, "novel_1")
        assert unavailable["status"] == "unavailable"
        assert unavailable["code"] == "AGENT_SKILL_VERSION_UNAVAILABLE"
        assert (await runtime._chat_skill_selection_context(None, "novel_1"))["mode"] == "auto"
        assert (await runtime._chat_skill_selection_context(
            IntentEntryHint(actionId="skill.none", kind="skill.none"), "novel_1"))["mode"] == "disabled"

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


@pytest.mark.parametrize("descriptor", [None, "{", '{"port": 12345}'])
def test_builtin_skills_survive_missing_or_invalid_desktop_descriptor(tmp_path, descriptor) -> None:
    runtime_path = tmp_path / "automation" / "runtime.json"
    if descriptor is not None:
        runtime_path.parent.mkdir()
        runtime_path.write_text(descriptor, encoding="utf-8")
    store = AgentStateStore(tmp_path / "agent")
    runtime = NovelAgentRuntime(store, AutomationClient(runtime_path), AgentEventBus(store))
    with TestClient(build_app(runtime, None)) as client:
        response = client.post("/invoke", json={"method": "agent.skills", "params": {"locale": "zh-CN"}})
        body = response.json()
        assert body["ok"] is True
        entries = {item["id"]: item for item in body["data"]}
        assert entries.keys() >= {"builtin.continuity-review", "builtin.novel-bootstrap", "builtin.style-skill-extractor"}
        assert all(item["enabled"] and item["revisionId"] for item in entries.values())
        assert runtime.agent_skill_service.preview({
            "novelId": "novel-1", "operationId": "novel.bootstrap", "roleId": "team",
            "explicitSkills": [{"skillId": "builtin.novel-bootstrap"}],
        })["compiled"]["sections"], "The fallback must return executable bundled revisions"
