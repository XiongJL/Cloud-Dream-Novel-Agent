from __future__ import annotations

import pytest

from novel_agent_runtime.intent.capabilities import match_operation_capability
from novel_agent_runtime.intent.operations import INTENT_OPERATION_REGISTRY
from novel_agent_runtime.intent.rules import detect_explicit_operations
from novel_agent_runtime.toolchains.registry import (
    TOOLCHAIN_REGISTRY,
    ToolchainDefinition,
    ToolchainRegistry,
)
from novel_agent_runtime.toolchains.schemas import ChapterContextInput, ContextBundle, ToolchainBudget, ToolchainError
from novel_agent_runtime.intent.schemas import IntentDecision, IntentOperation, IntentTargetRef
from novel_agent_runtime.planner import build_plan_from_model, route_plan_from_intent, validate_plan_effect


def _definition(**updates: object) -> ToolchainDefinition:
    values = {
        "id": "test.context",
        "version": "1.0.0",
        "title": "Test",
        "description": "Test chain",
        "inputModel": ChapterContextInput,
        "outputModel": ContextBundle,
        "allowedRoles": ("editor",),
        "requiredTools": ("chapter.get",),
        "sideEffect": "read_only",
        "supportedOperations": ("chapter.context",),
        "budget": ToolchainBudget(maxToolCalls=2, maxEstimatedTokens=2000, timeoutSeconds=30),
    }
    values.update(updates)
    return ToolchainDefinition.model_validate(values)


def test_default_toolchain_registry_exposes_stable_contracts() -> None:
    contracts = {item["id"]: item for item in TOOLCHAIN_REGISTRY.list_public()}

    assert set(contracts) == {
        "chapter.context",
        "chapter.scope_context",
        "chapter.consistency_review",
        "writer.range_revision_plan",
        "editor.range_review",
        "reader.journey_review",
        "worldbuilding.range_consistency",
        "research.range_fact_check",
        "novel.scope_audit",
        "chapter.continuation",
        "chapter.sequence_continuation",
        "chapter.batch_rewrite",
        "creative_asset.draft",
        "plotline.analysis",
    }
    assert contracts["chapter.context"]["version"] == "1.0.0"
    assert contracts["chapter.context"]["sideEffect"] == "read_only"
    assert contracts["chapter.scope_context"]["version"] == "1.0.0"
    assert contracts["chapter.scope_context"]["requiredTools"] == ["chapter.scope_context.build", "rag.ask"]
    assert contracts["chapter.consistency_review"]["outputSchema"]["title"] == "ReviewArtifact"
    assert contracts["editor.range_review"]["outputSchema"]["title"] == "EditorRangeReviewArtifact"
    assert contracts["editor.range_review"]["requiredTools"] == ["chapter.scope_context.build", "rag.ask"]
    assert contracts["writer.range_revision_plan"]["outputSchema"]["title"] == "WriterRangeRevisionPlanArtifact"
    assert contracts["writer.range_revision_plan"]["requiredTools"] == ["chapter.scope_context.build", "rag.ask"]
    assert contracts["reader.journey_review"]["outputSchema"]["title"] == "ReaderJourneyArtifact"
    assert contracts["reader.journey_review"]["requiredTools"] == ["chapter.scope_context.build"]
    assert contracts["reader.journey_review"]["budget"]["maxModelCalls"] == 20
    assert contracts["worldbuilding.range_consistency"]["outputSchema"]["title"] == "WorldbuildingConsistencyArtifact"
    assert contracts["worldbuilding.range_consistency"]["requiredTools"] == ["chapter.scope_context.build", "rag.ask"]
    assert contracts["research.range_fact_check"]["outputSchema"]["title"] == "ResearchFactCheckArtifact"
    assert contracts["research.range_fact_check"]["requiredTools"] == ["chapter.scope_context.build", "rag.ask", "search.query"]
    assert contracts["research.range_fact_check"]["budget"]["maxModelCalls"] == 2
    assert contracts["novel.scope_audit"]["outputSchema"]["title"] == "ScopeAuditArtifact"
    assert contracts["novel.scope_audit"]["requiredTools"] == [
        "chapter.scope_context.build",
        "rag.ask",
        "search.query",
    ]
    assert contracts["novel.scope_audit"]["budget"]["maxModelCalls"] == 25
    assert contracts["chapter.continuation"]["sideEffect"] == "draft_write"
    assert "chapter.generate_draft" in contracts["chapter.continuation"]["requiredTools"]
    assert contracts["chapter.sequence_continuation"]["outputSchema"]["title"] == "ChapterDraftBatchResult"
    assert "draft.batch.create" in contracts["chapter.sequence_continuation"]["requiredTools"]
    assert contracts["chapter.sequence_continuation"]["budget"]["maxToolCalls"] == 12
    assert contracts["chapter.batch_rewrite"]["outputSchema"]["title"] == "ChapterDraftBatchResult"
    assert "chapter.scope_context.build" in contracts["chapter.batch_rewrite"]["requiredTools"]
    assert "draft.batch.create" in contracts["chapter.batch_rewrite"]["requiredTools"]
    assert contracts["creative_asset.draft"]["outputSchema"]["title"] == "DraftToolchainResult"
    assert "creative_assets.validate_draft" in contracts["creative_asset.draft"]["requiredTools"]
    assert contracts["plotline.analysis"]["sideEffect"] == "read_only"
    assert contracts["plotline.analysis"]["outputSchema"]["title"] == "PlotlineAnalysisArtifact"
    assert contracts["plotline.analysis"]["budget"]["maxToolCalls"] == 24
    assert {"scope", "batchSize", "maxChapters", "maxEstimatedTokens"}.issubset(
        contracts["plotline.analysis"]["inputSchema"]["properties"]
    )
    assert "chapter.list" in contracts["plotline.analysis"]["requiredTools"]


def test_registry_rejects_duplicates_unknown_permissions_and_writable_tools() -> None:
    definition = _definition()
    with pytest.raises(ValueError, match="Duplicate Toolchain"):
        ToolchainRegistry([definition, definition])
    with pytest.raises(ValueError, match="Unknown Toolchain roles"):
        ToolchainRegistry([_definition(allowedRoles=("unknown",))])
    with pytest.raises(ValueError, match="Unknown Toolchain tools"):
        ToolchainRegistry([_definition(requiredTools=("missing.tool",))])
    with pytest.raises(ValueError, match="Unknown Toolchain operations"):
        ToolchainRegistry([_definition(supportedOperations=("missing.operation",))])
    with pytest.raises(ValueError, match="Read-only Toolchain contains writable tools"):
        ToolchainRegistry([_definition(requiredTools=("chapter.generate_draft",))])


def test_registry_resolve_returns_stable_errors() -> None:
    with pytest.raises(ToolchainError) as missing:
        TOOLCHAIN_REGISTRY.resolve("missing.chain", "1.0.0", "editor")
    assert missing.value.code == "TOOLCHAIN_NOT_FOUND"

    with pytest.raises(ToolchainError) as version:
        TOOLCHAIN_REGISTRY.resolve("chapter.context", "2.0.0", "editor")
    assert version.value.code == "VERSION_UNAVAILABLE"

    with pytest.raises(ToolchainError) as role:
        TOOLCHAIN_REGISTRY.resolve("chapter.consistency_review", "1.0.0", "writer")
    assert role.value.code == "ROLE_NOT_ALLOWED"


def test_disabled_toolchain_is_hidden_and_capability_matcher_degrades() -> None:
    registry = ToolchainRegistry([_definition(enabled=False)])
    assert registry.list_public() == []
    with pytest.raises(ToolchainError) as disabled:
        registry.resolve("test.context", "1.0.0", "editor")
    assert disabled.value.code == "TOOLCHAIN_DISABLED"

    match = match_operation_capability(
        INTENT_OPERATION_REGISTRY.require("chapter.context"),
        "editor",
        registry,
    )
    assert match.toolchainId is None
    assert "TOOLCHAIN_DISABLED" in match.reasonCodes
    assert "PLANNER_FALLBACK" in match.reasonCodes


def test_validated_consistency_operation_routes_to_stable_toolchain_only_with_chapter_context() -> None:
    model_result = {
        "title": "模型原始计划",
        "deliverable": "report",
        "steps": [{"agent": "editor", "title": "散装读取", "tools": ["chapter.get", "character.list"]}],
    }
    plan = build_plan_from_model("检查当前章节的前后矛盾与一致性", model_result, "editor")

    decision = IntentDecision(
        interaction="task",
        route="plan",
        operations=[IntentOperation(
            type="chapter.consistency_review",
            target=IntentTargetRef(kind="chapter", source="conversation_reference"),
            suggestedToolchainId="chapter.consistency_review",
            suggestedToolchainVersion="1.0.0",
            requestedEffect="read_only",
            confidence=0.95,
        )],
        deliverable="report",
        requestedEffect="read_only",
        confidence=0.95,
        reasonCodes=["MATCHED_TOOLCHAIN"],
        responseContent="开始审核",
    )
    without_chapter = route_plan_from_intent(plan, decision, has_chapter=False)
    routed = route_plan_from_intent(plan, decision, has_chapter=True)

    assert without_chapter.steps[0].toolchain is None
    assert routed.steps[0].tools == []
    assert routed.steps[0].toolchain is not None
    assert routed.steps[0].toolchain.id == "chapter.consistency_review"
    contracts = {item["id"]: item for item in TOOLCHAIN_REGISTRY.list_public()}
    assert "chapter.consistency_review" in contracts["chapter.consistency_review"]["supportedOperations"]
    assert routed.steps[0].toolchain.version == "1.0.0"


def test_multi_chapter_intent_routes_requested_count_to_sequence_toolchain() -> None:
    plan = build_plan_from_model(
        "从当前章后续写三章",
        {
            "title": "连续续写",
            "deliverable": "chapter_draft_batch",
            "steps": [{"agent": "writer", "title": "生成草稿", "tools": ["chapter.generate_draft"]}],
        },
        "writer",
    )
    decision = IntentDecision(
        interaction="task",
        route="plan",
        operations=[IntentOperation(
            type="chapter.sequence_continuation",
            target=IntentTargetRef(kind="chapter", source="current_selection", id="chapter-2"),
            suggestedToolchainId="chapter.sequence_continuation",
            suggestedToolchainVersion="1.0.0",
            requestedEffect="draft_write",
            confidence=0.98,
        )],
        deliverable="chapter_draft_batch",
        requestedEffect="draft_write",
        confidence=0.98,
        reasonCodes=["MATCHED_TOOLCHAIN"],
        responseContent="将生成三章连续草稿。",
    )

    routed = route_plan_from_intent(plan, decision, has_chapter=True)

    assert detect_explicit_operations("从这里继续写三章") == ["chapter.sequence_continuation"]
    assert len(routed.steps) == 1
    assert routed.steps[0].toolchain is not None
    assert routed.steps[0].toolchain.id == "chapter.sequence_continuation"
    assert routed.steps[0].toolchain.input["chapterCount"] == 3


def test_editor_range_review_intent_routes_to_expert_report_toolchain() -> None:
    assert detect_explicit_operations("对当前卷做多章节编辑审核") == ["editor.range_review"]
    operation = INTENT_OPERATION_REGISTRY.require("editor.range_review")
    assert operation.defaultDeliverable == "expert_report"

    plan = build_plan_from_model(
        "审核第一章和第二章的结构、节奏与人物动机",
        {
            "title": "多章节编辑审核",
            "deliverable": "expert_report",
            "steps": [{"agent": "editor", "title": "审核章节", "tools": ["chapter.get"]}],
        },
        "editor",
    )
    decision = IntentDecision(
        interaction="task",
        route="plan",
        operations=[IntentOperation(
            type="editor.range_review",
            target=IntentTargetRef(kind="chapter_scope", source="current_selection", id="scope-1"),
            suggestedToolchainId="editor.range_review",
            suggestedToolchainVersion="1.0.0",
            requestedEffect="read_only",
            confidence=0.98,
        )],
        deliverable="expert_report",
        requestedEffect="read_only",
        confidence=0.98,
        reasonCodes=["MATCHED_TOOLCHAIN"],
        responseContent="开始编辑审核。",
    )

    without_anchor = route_plan_from_intent(plan, decision, has_chapter=False)
    routed = route_plan_from_intent(plan, decision, has_chapter=True)
    assert without_anchor.steps[0].toolchain is None
    assert routed.deliverable == "expert_report"
    assert len(routed.steps) == 1
    assert routed.steps[0].tools == []
    assert routed.steps[0].toolchain is not None
    assert routed.steps[0].toolchain.id == "editor.range_review"


def test_writer_revision_and_batch_rewrite_intents_route_to_author_toolchains() -> None:
    assert detect_explicit_operations("给当前卷做作者多章节修订计划和改写顺序") == [
        "writer.range_revision_plan"
    ]
    assert detect_explicit_operations("批量改写选中的三章") == ["chapter.batch_rewrite"]
    assert INTENT_OPERATION_REGISTRY.require("writer.range_revision_plan").defaultDeliverable == "expert_report"
    assert INTENT_OPERATION_REGISTRY.require("chapter.batch_rewrite").defaultDeliverable == "chapter_draft_batch"


def test_reader_journey_intent_routes_to_strict_sequential_toolchain() -> None:
    assert detect_explicit_operations("对当前卷做多章节读者盲测和读者反馈") == ["reader.journey_review"]
    operation = INTENT_OPERATION_REGISTRY.require("reader.journey_review")
    assert operation.defaultDeliverable == "expert_report"
    assert operation.contextNeeds == ("chapter_scope", "chapter_summaries")

    plan = build_plan_from_model(
        "顺序盲读选中的三个章节",
        {
            "title": "读者旅程",
            "deliverable": "expert_report",
            "steps": [{"agent": "reader", "title": "逐章盲读", "tools": ["chapter.get"]}],
        },
        "reader",
    )
    decision = IntentDecision(
        interaction="task",
        route="plan",
        operations=[IntentOperation(
            type="reader.journey_review",
            target=IntentTargetRef(kind="chapter_scope", source="current_selection", id="chapter_3"),
            suggestedToolchainId="reader.journey_review",
            suggestedToolchainVersion="1.0.0",
            requestedEffect="read_only",
            confidence=0.99,
        )],
        deliverable="expert_report",
        requestedEffect="read_only",
        confidence=0.99,
        reasonCodes=["MATCHED_TOOLCHAIN"],
        responseContent="开始顺序盲读。",
    )

    routed = route_plan_from_intent(plan, decision, has_chapter=True)
    assert routed.steps[0].toolchain is not None
    assert routed.steps[0].toolchain.id == "reader.journey_review"


def test_worldbuilding_range_intent_routes_to_expert_report_toolchain() -> None:
    assert detect_explicit_operations("对当前卷做世界观一致性检查") == ["worldbuilding.range_consistency"]
    operation = INTENT_OPERATION_REGISTRY.require("worldbuilding.range_consistency")
    assert operation.defaultDeliverable == "expert_report"
    assert operation.defaultRole == "worldbuilding"

    plan = build_plan_from_model(
        "检查选中章节的规则和物品状态漂移",
        {
            "title": "世界观一致性审核",
            "deliverable": "expert_report",
            "steps": [{"agent": "worldbuilding", "title": "核对设定", "tools": ["worldsetting.list"]}],
        },
        "worldbuilding",
    )
    decision = IntentDecision(
        interaction="task",
        route="plan",
        operations=[IntentOperation(
            type="worldbuilding.range_consistency",
            target=IntentTargetRef(kind="chapter_scope", source="current_selection", id="chapter_2"),
            suggestedToolchainId="worldbuilding.range_consistency",
            suggestedToolchainVersion="1.0.0",
            requestedEffect="read_only",
            confidence=0.99,
        )],
        deliverable="expert_report",
        requestedEffect="read_only",
        confidence=0.99,
        reasonCodes=["MATCHED_TOOLCHAIN"],
        responseContent="开始世界观一致性审核。",
    )

    routed = route_plan_from_intent(plan, decision, has_chapter=True)
    assert routed.steps[0].toolchain is not None
    assert routed.steps[0].toolchain.id == "worldbuilding.range_consistency"


def test_research_range_intent_routes_to_expert_report_toolchain() -> None:
    assert detect_explicit_operations("对当前卷考据并核查事实") == ["research.range_fact_check"]
    operation = INTENT_OPERATION_REGISTRY.require("research.range_fact_check")
    assert operation.defaultDeliverable == "expert_report"
    assert operation.defaultRole == "research_rag"

    plan = build_plan_from_model(
        "核查选中章节中的历史和技术事实",
        {
            "title": "多章节事实核查",
            "deliverable": "expert_report",
            "steps": [{"agent": "research_rag", "title": "核查事实", "tools": ["rag.ask"]}],
        },
        "research_rag",
    )
    decision = IntentDecision(
        interaction="task",
        route="plan",
        operations=[IntentOperation(
            type="research.range_fact_check",
            target=IntentTargetRef(kind="chapter_scope", source="current_selection", id="chapter_2"),
            suggestedToolchainId="research.range_fact_check",
            suggestedToolchainVersion="1.0.0",
            requestedEffect="read_only",
            confidence=0.99,
        )],
        deliverable="expert_report",
        requestedEffect="read_only",
        confidence=0.99,
        reasonCodes=["MATCHED_TOOLCHAIN"],
        responseContent="开始多章节事实核查。",
    )

    routed = route_plan_from_intent(plan, decision, has_chapter=True)
    assert routed.steps[0].toolchain is not None
    assert routed.steps[0].toolchain.id == "research.range_fact_check"


def test_scope_audit_intent_routes_to_team_supervisor_toolchain() -> None:
    assert detect_explicit_operations("对当前卷做团队综合审计") == ["novel.scope_audit"]
    operation = INTENT_OPERATION_REGISTRY.require("novel.scope_audit")
    assert operation.defaultDeliverable == "expert_report"
    assert operation.defaultRole == "team"

    plan = build_plan_from_model(
        "让编辑、读者和世界观专家综合审计当前卷",
        {
            "title": "团队综合审计",
            "deliverable": "expert_report",
            "steps": [{"agent": "supervisor", "title": "汇总专家结论", "tools": ["chapter.get"]}],
        },
        "team",
    )
    decision = IntentDecision(
        interaction="task",
        route="plan",
        operations=[IntentOperation(
            type="novel.scope_audit",
            target=IntentTargetRef(kind="chapter_scope", source="current_selection", id="scope_1"),
            suggestedToolchainId="novel.scope_audit",
            suggestedToolchainVersion="1.0.0",
            requestedEffect="read_only",
            confidence=0.99,
        )],
        deliverable="expert_report",
        requestedEffect="read_only",
        confidence=0.99,
        reasonCodes=["MATCHED_TOOLCHAIN"],
        responseContent="开始团队综合审计。",
    )

    routed = route_plan_from_intent(plan, decision, has_chapter=True)
    assert len(routed.steps) == 1
    assert routed.steps[0].agent == "supervisor"
    assert routed.steps[0].toolchain is not None
    assert routed.steps[0].toolchain.id == "novel.scope_audit"


def test_explicit_operation_detection_distinguishes_analysis_from_drafting() -> None:
    assert detect_explicit_operations(
        "读取当前章节及世界观资料，检查设定冲突和需要补充说明之处"
    ) == ["chapter.consistency_review"]
    assert detect_explicit_operations("评估当前卷的续写准备度") == ["writer.range_revision_plan"]
    assert detect_explicit_operations("给出润色建议，不要改写") == []
    assert detect_explicit_operations("先讨论怎么续写，不要生成正文") == []
    assert detect_explicit_operations("生成当前项目的角色列表") == ["project.lookup"]
    assert detect_explicit_operations("生成世界观一致性报告") == ["worldbuilding.range_consistency"]
    assert detect_explicit_operations("分析新增角色的必要性") == []
    assert detect_explicit_operations("我想知道这一章该怎么续写") == []
    assert detect_explicit_operations("续写会不会破坏这一章的节奏") == []
    assert detect_explicit_operations("改写和润色有什么区别") == []
    assert detect_explicit_operations("先检查现有角色，再新增一个角色") == ["creative_asset.draft"]
    assert detect_explicit_operations("先检查设定冲突，再根据结果起草补充设定") == [
        "chapter.consistency_review",
        "creative_asset.draft",
    ]


def test_read_only_intent_replaces_model_generated_draft_step() -> None:
    plan = build_plan_from_model(
        "检查当前章节设定冲突和需要补充说明之处",
        {
            "title": "错误扩展的计划",
            "deliverable": "creative_assets_draft",
            "steps": [{
                "agent": "worldbuilding",
                "title": "生成补充设定",
                "tools": ["creative_assets.generate_draft"],
            }],
        },
        "worldbuilding",
    )
    decision = IntentDecision(
        interaction="task",
        route="plan",
        operations=[IntentOperation(
            type="chapter.consistency_review",
            target=IntentTargetRef(kind="chapter", source="current_selection", id="chapter-1"),
            suggestedToolchainId="chapter.consistency_review",
            suggestedToolchainVersion="1.0.0",
            requestedEffect="read_only",
            confidence=0.99,
        )],
        deliverable="report",
        requestedEffect="read_only",
        confidence=0.99,
        responseContent="只执行一致性审核。",
    )

    routed = route_plan_from_intent(plan, decision, has_chapter=True)

    assert routed.deliverable == "report"
    assert routed.requestedEffect == "read_only"
    assert len(routed.steps) == 1
    assert routed.steps[0].toolchain is not None
    assert routed.steps[0].toolchain.id == "chapter.consistency_review"


def test_plan_effect_validator_rejects_draft_step_under_read_only_ceiling() -> None:
    plan = build_plan_from_model(
        "只做分析",
        {
            "title": "越权计划",
            "deliverable": "creative_assets_draft",
            "steps": [{
                "agent": "worldbuilding",
                "title": "生成设定",
                "tools": ["creative_assets.generate_draft"],
            }],
        },
        "worldbuilding",
    ).model_copy(update={"deliverable": "report", "requestedEffect": "read_only"})

    with pytest.raises(ValueError, match="Plan step exceeds requested effect"):
        validate_plan_effect(plan)


def test_unknown_intent_is_fail_closed_to_read_only_planning() -> None:
    report_plan = build_plan_from_model(
        "处理一下这个问题",
        {
            "title": "分析问题",
            "deliverable": "report",
            "steps": [{"agent": "editor", "title": "分析当前问题", "tools": ["chapter.get"]}],
        },
        "editor",
    )
    decision = IntentDecision(
        interaction="task",
        route="plan",
        deliverable="none",
        requestedEffect="unknown",
        confidence=0.5,
        responseContent="我会先分析问题。",
    )

    routed = route_plan_from_intent(report_plan, decision, has_chapter=True)
    assert routed.requestedEffect == "read_only"
    assert routed.deliverable == "report"

    draft_plan = build_plan_from_model(
        "处理一下这个问题",
        {
            "title": "生成草稿",
            "deliverable": "chapter_draft",
            "steps": [{"agent": "writer", "title": "生成正文", "tools": ["chapter.generate_draft"]}],
        },
        "writer",
    )
    with pytest.raises(ValueError, match="Intent deliverable exceeds requested effect"):
        route_plan_from_intent(draft_plan, decision, has_chapter=True)
