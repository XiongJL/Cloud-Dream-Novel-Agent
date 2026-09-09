from __future__ import annotations

import pytest

from novel_agent_runtime.intent.operations import INTENT_OPERATION_REGISTRY
from novel_agent_runtime.intent.rules import (
    detect_explicit_operations,
    requested_continuation_chapter_count,
    requested_created_chapter_count,
)
from novel_agent_runtime.intent.schemas import (
    FailedRunRef,
    IntentConversationState,
    IntentRequest,
    IntentSelectionContext,
    PendingClarificationRef,
    PriorIntentRef,
    SemanticProposal,
)
from novel_agent_runtime.intent.service import IntentService
from novel_agent_runtime.intent.targets import resolve_intent_chapter_target


def request(
    message: str,
    *,
    role: str = "team",
    approval_mode: str = "review_required",
    state: IntentConversationState | None = None,
) -> IntentRequest:
    return IntentRequest(
        message=message,
        conversationId="conv-1",
        locale="zh-CN",
        role=role,
        approvalMode=approval_mode,
        source="chat",
        currentSelection=IntentSelectionContext(novelId="novel-1", chapterId="chapter-1"),
        conversationState=state or IntentConversationState(),
    )


def decide(intent_request: IntentRequest, semantic: SemanticProposal):
    service = IntentService()
    preflight = service.preflight(intent_request)
    return service.finalize(intent_request, preflight, semantic)


def proposal(
    content: str = "可以。",
    *,
    should_plan: bool = False,
    clarify: bool = False,
    operations: list[str] | None = None,
    deliverable: str | None = None,
    suggested_role: str | None = None,
) -> SemanticProposal:
    return SemanticProposal(
        responseContent=content,
        shouldPlan=should_plan,
        needsClarification=clarify,
        requestedOperations=operations or [],
        deliverable=deliverable,
        suggestedRole=suggested_role,
        confidence=0.8,
    )


def test_greeting_stays_conversation_even_if_model_suggests_plan() -> None:
    decision = decide(request("你好"), proposal(should_plan=True))
    assert decision.route == "respond"
    assert decision.operations == []
    assert "LIGHT_CONVERSATION" in decision.reasonCodes


def test_project_fact_lookup_responds_after_read_only_exploration() -> None:
    intent_request = request("当前小说已有多少个章节？")
    service = IntentService()
    decision = service.finalize(
        intent_request,
        service.preflight(intent_request),
        proposal("目前有两个章节。", operations=["project.lookup"], clarify=True),
        exploration_performed=True,
    )
    assert decision.route == "respond"
    assert decision.requestedEffect == "read_only"
    assert decision.explorationPerformed is True
    assert decision.needsClarification is False


def test_compound_review_then_continuation_preserves_order_and_capabilities() -> None:
    decision = decide(
        request("先检查当前章节一致性，再根据结果续写"),
        proposal(should_plan=True, deliverable="chapter_draft"),
    )
    assert [item.type for item in decision.operations] == [
        "chapter.consistency_review",
        "chapter.continuation",
    ]
    assert decision.operations[0].suggestedToolchainId == "chapter.consistency_review"
    assert decision.operations[1].suggestedToolchainId == "chapter.continuation"
    assert decision.operations[1].suggestedToolchainVersion == "1.0.0"
    assert decision.deliverable == "chapter_draft"
    assert decision.requestedEffect == "draft_write"
    assert decision.route == "plan"


def test_complete_chapter_then_editor_review_drops_incidental_assets_and_owns_review() -> None:
    message = "续写当前章节，完成约 1800—2200 字正文；人物和世界规则保持一致，写完后由编辑审校逻辑、视角与结尾钩子。"
    decision = decide(
        request(message),
        proposal(
            should_plan=True,
            operations=["creative_asset.draft", "chapter.continuation", "chapter.consistency_review"],
            deliverable="chapter_draft",
        ),
    )
    assert [item.type for item in decision.operations] == ["chapter.continuation"]
    assert "INCIDENTAL_CREATIVE_ASSET_DROPPED" in decision.reasonCodes
    assert "DRAFT_EDITORIAL_REVIEW_OWNED_BY_CHAPTER_TOOLCHAIN" in decision.reasonCodes


def test_explicit_asset_creation_remains_separate_from_chapter_draft() -> None:
    message = "创建角色卡，然后续写当前章节。"
    decision = decide(
        request(message),
        proposal(
            should_plan=True,
            operations=["creative_asset.draft", "chapter.continuation"],
            deliverable="chapter_draft",
        ),
    )
    assert [item.type for item in decision.operations] == ["creative_asset.draft", "chapter.continuation"]


def test_ambiguous_creative_request_waits_for_user_answer() -> None:
    decision = decide(
        request("大纲新增一部分"),
        proposal("你想新增主线、角色支线还是世界观设定？", clarify=True),
    )
    assert decision.route == "clarify"
    assert decision.needsClarification is True
    assert decision.deliverable == "creative_assets_draft"


def test_current_chapter_review_does_not_repeat_target_clarification() -> None:
    decision = decide(
        request("帮我校验这篇文章"),
        proposal("你想校验哪一章？", clarify=True),
    )
    assert decision.route == "plan"
    assert decision.needsClarification is False
    assert [item.type for item in decision.operations] == ["chapter.consistency_review"]
    assert decision.operations[0].target.id == "chapter-1"
    assert "CURRENT_SELECTION_RESOLVED" in decision.reasonCodes
    assert "当前选中的章节" in decision.responseContent


def test_chat_only_preserves_requested_effect_but_blocks_plan() -> None:
    decision = decide(
        request("续写这一章", approval_mode="chat_only"),
        proposal("我可以先讨论续写方向。", should_plan=True),
    )
    assert decision.route == "respond"
    assert decision.requestedEffect == "draft_write"
    assert "PLAN_BLOCKED_BY_CHAT_ONLY" in decision.reasonCodes


def test_pending_approval_plain_chat_never_submits_approval() -> None:
    state = IntentConversationState(activeRunId="run-1", hasPendingApproval=True)
    decision = decide(request("选第二个", state=state), proposal("收到。"))
    assert decision.route == "respond"
    assert "审批卡" in decision.responseContent
    assert "APPROVAL_CARD_REQUIRED" in decision.reasonCodes


def test_pending_clarification_marks_response_interaction() -> None:
    state = IntentConversationState(
        pendingClarification=PendingClarificationRef(questionId="q-1", question="新增哪一部分？")
    )
    decision = decide(
        request("主线", state=state),
        proposal("我会补充主线。", should_plan=True, operations=["creative_asset.draft"]),
    )
    assert decision.interaction == "clarification_response"
    assert decision.route == "plan"


def test_unknown_model_operation_is_dropped_without_authority() -> None:
    decision = decide(
        request("帮我处理一下"),
        proposal(operations=["system.delete_all"], should_plan=False),
    )
    assert decision.operations == []
    assert decision.route == "respond"
    assert "UNKNOWN_OPERATION_DROPPED" in decision.reasonCodes


def test_role_mismatch_uses_registered_toolchain_role_fallback() -> None:
    decision = decide(
        request("检查当前章节一致性", role="writer"),
        proposal(should_plan=True, suggested_role="writer"),
    )
    assert decision.operations[0].suggestedToolchainId == "chapter.consistency_review"
    assert decision.suggestedRole == "editor"
    assert "ROLE_FALLBACK" in decision.reasonCodes
    assert "SUGGESTED_ROLE_REJECTED" in decision.reasonCodes


def test_operation_registry_contract_is_public_and_stable() -> None:
    public = {item["id"]: item for item in INTENT_OPERATION_REGISTRY.list_public()}
    assert public["chapter.continuation"]["requestedEffect"] == "draft_write"
    assert public["chapter.consistency_review"]["defaultDeliverable"] == "report"
    assert public["plotline.analysis"]["requestedEffect"] == "read_only"


def test_plotline_analysis_routes_to_stable_read_only_toolchain() -> None:
    decision = decide(
        request("分析主线支线和未回收伏笔", role="editor"),
        proposal("我会先确认范围再分批读取章节。", should_plan=True),
    )
    assert [item.type for item in decision.operations] == ["plotline.analysis"]
    assert decision.operations[0].suggestedToolchainId == "plotline.analysis"
    assert decision.operations[0].suggestedToolchainVersion == "1.0.0"
    assert decision.deliverable == "report"
    assert decision.requestedEffect == "read_only"
    assert decision.route == "plan"


def test_conversation_reference_inherits_previous_structured_intent() -> None:
    state = IntentConversationState(
        previousIntent=PriorIntentRef(
            operationIds=["creative_asset.draft"],
            deliverable="creative_assets_draft",
            suggestedRole="worldbuilding",
        )
    )
    decision = decide(
        request("按刚才那个方案继续", state=state),
        proposal(
            "我会沿用刚才的方案。",
            should_plan=True,
            operations=["chapter.continuation"],
            deliverable="chapter_draft",
            suggested_role="writer",
        ),
    )
    assert [item.type for item in decision.operations] == ["creative_asset.draft"]
    assert decision.deliverable == "creative_assets_draft"
    assert decision.suggestedRole == "worldbuilding"
    assert "PREVIOUS_INTENT_INHERITED" in decision.reasonCodes


def test_data_write_request_is_preserved_but_requires_structured_confirmation() -> None:
    decision = decide(
        request("改写这一段并直接写回正文"),
        proposal("我会直接写回。", should_plan=True),
    )
    assert decision.route == "respond"
    assert decision.requestedEffect == "data_write"
    assert decision.operations[0].type == "chapter.rewrite"
    assert "审核中心" in decision.responseContent
    assert "ROUTE_DOWNGRADED_BY_RISK" in decision.reasonCodes


def test_external_effect_is_not_routed_to_plan() -> None:
    decision = decide(
        request("把这一章发布到网站"),
        proposal("准备发布。", should_plan=True),
    )
    assert decision.route == "respond"
    assert decision.requestedEffect == "external"
    assert "EXTERNAL_EFFECT_UNSUPPORTED" in decision.reasonCodes


def test_unclassified_model_task_keeps_unknown_effect() -> None:
    decision = decide(request("处理一下这个问题"), proposal(should_plan=True))
    assert decision.route == "plan"
    assert decision.requestedEffect == "unknown"
    assert "EFFECT_UNKNOWN" in decision.reasonCodes


def test_fixed_inputs_produce_identical_decisions() -> None:
    intent_request = request("先检查一致性，再续写")
    semantic = proposal("准备生成计划。", should_plan=True)
    first = decide(intent_request, semantic)
    second = decide(intent_request, semantic)
    assert first.model_dump() == second.model_dump()


def test_short_continue_recovers_latest_retryable_failed_run() -> None:
    state = IntentConversationState(
        activeRunId="run-failed",
        latestFailedRun=FailedRunRef(
            runId="run-failed",
            failureRevision=2,
            retryable=True,
            code="PROVIDER_UNAVAILABLE",
        ),
    )
    decision = decide(
        request("继续。", state=state),
        proposal("我会创建一个新计划。", should_plan=True, operations=["chapter.continuation"]),
    )

    assert decision.route == "retry_failed_run"
    assert decision.operations == []
    assert decision.recovery is not None
    assert decision.recovery.failedRunId == "run-failed"
    assert decision.recovery.expectedFailureRevision == 2
    assert "RETRY_FAILED_RUN" in decision.reasonCodes


def test_continue_with_changed_scope_does_not_recover_failed_run() -> None:
    state = IntentConversationState(
        activeRunId="run-failed",
        latestFailedRun=FailedRunRef(
            runId="run-failed",
            failureRevision=1,
            retryable=True,
        ),
    )
    decision = decide(
        request("继续，但把范围改为全书", state=state),
        proposal("我会按新范围生成计划。", should_plan=True, operations=["plotline.analysis"]),
    )

    assert decision.route == "plan"
    assert decision.recovery is None


def test_non_retryable_failure_never_routes_to_recovery() -> None:
    state = IntentConversationState(
        activeRunId="run-failed",
        latestFailedRun=FailedRunRef(
            runId="run-failed",
            failureRevision=1,
            retryable=False,
            code="SIDE_EFFECT_UNKNOWN",
        ),
    )
    decision = decide(request("重试", state=state), proposal("请先检查执行结果。"))

    assert decision.route == "respond"
    assert decision.recovery is None


@pytest.mark.parametrize("role", ["team", "writer", "editor", "reader", "worldbuilding", "research_rag"])
def test_read_only_review_cannot_be_upgraded_by_role_or_semantic_hint(role: str) -> None:
    decision = decide(
        request(
            "读取当前章节及世界观、角色、物品和地图资料，检查设定冲突、遗漏规则和需要补充说明之处。",
            role=role,
        ),
        proposal(
            "我会检查设定并形成报告。",
            should_plan=True,
            operations=["chapter.consistency_review", "creative_asset.draft"],
            deliverable="creative_assets_draft",
            suggested_role="worldbuilding",
        ),
    )

    assert [item.type for item in decision.operations] == ["chapter.consistency_review"]
    assert decision.requestedEffect == "read_only"
    assert decision.deliverable == "report"
    assert "SEMANTIC_EFFECT_ESCALATION_DROPPED" in decision.reasonCodes


def test_continuation_readiness_is_a_report_not_a_continuation_draft() -> None:
    decision = decide(
        request("评估当前卷的续写准备度"),
        proposal(
            "我会评估当前卷。",
            should_plan=True,
            operations=["writer.range_revision_plan", "chapter.continuation"],
            deliverable="chapter_draft",
        ),
    )

    assert [item.type for item in decision.operations] == ["writer.range_revision_plan"]
    assert decision.requestedEffect == "read_only"
    assert decision.deliverable == "expert_report"


def test_advice_and_negation_do_not_authorize_rewrite() -> None:
    decision = decide(
        request("给出这一段的润色建议，不要改写"),
        proposal(
            "可以先讨论润色方向。",
            should_plan=True,
            operations=["chapter.rewrite"],
            deliverable="chapter_draft",
        ),
    )

    assert decision.operations == []
    assert decision.deliverable == "none"
    assert decision.route == "respond"
    assert "CONVERSATION_REQUESTED" in decision.reasonCodes
    assert "SEMANTIC_EFFECT_ESCALATION_DROPPED" in decision.reasonCodes


def test_discussion_first_does_not_authorize_continuation() -> None:
    decision = decide(
        request("先讨论怎么续写，不要生成正文"),
        proposal(
            "我们先讨论后续方向。",
            should_plan=True,
            operations=["chapter.continuation"],
            deliverable="chapter_draft",
        ),
    )

    assert decision.operations == []
    assert decision.route == "respond"
    assert decision.deliverable == "none"


def test_negated_data_write_marker_does_not_raise_requested_effect() -> None:
    decision = decide(
        request("不要写回正文，只列出修改建议"),
        proposal("下面只列出建议。"),
    )

    assert decision.requestedEffect == "none"
    assert "DATA_WRITE_REQUESTED" not in decision.reasonCodes


def test_explicit_review_then_draft_remains_a_compound_task() -> None:
    decision = decide(
        request("先检查设定冲突，再根据结果起草补充设定"),
        proposal("我会先审核，再起草设定。", should_plan=True),
    )

    assert [item.type for item in decision.operations] == [
        "chapter.consistency_review",
        "creative_asset.draft",
    ]
    assert decision.requestedEffect == "draft_write"
    assert decision.deliverable == "creative_assets_draft"


def test_last_chapter_is_a_target_not_a_sequence_count() -> None:
    assert requested_continuation_chapter_count("帮我续写最后一章。") is None
    assert detect_explicit_operations("帮我续写最后一章。") == ["chapter.continuation"]
    assert requested_continuation_chapter_count("帮我续写三章。") == 3
    assert detect_explicit_operations("帮我续写三章。") == ["chapter.sequence_continuation"]


def test_last_chapter_target_resolves_against_novel_order() -> None:
    target = resolve_intent_chapter_target(
        "帮我续写最后一章。",
        [
            {"chapterId": "chapter-2", "title": "白色房间", "chapterOrder": 2, "volumeId": "volume-1", "volumeTitle": "第一卷", "volumeOrder": 1},
            {"chapterId": "chapter-1", "title": "雨夜来电", "chapterOrder": 1, "volumeId": "volume-1", "volumeTitle": "第一卷", "volumeOrder": 1},
            {"chapterId": "chapter-9", "title": "终局", "chapterOrder": 3, "volumeId": "volume-3", "volumeTitle": "第三卷", "volumeOrder": 3},
        ],
        editor_chapter_id="chapter-2",
        editor_volume_id="volume-1",
    )

    assert target is not None
    assert target.selector == "last_in_novel"
    assert target.chapterId == "chapter-9"
    assert target.label == "第三卷 · 终局"


def test_semantic_single_continuation_wins_over_misclassified_sequence_candidate() -> None:
    target = resolve_intent_chapter_target(
        "帮我续写最后一章。",
        [
            {"chapterId": "chapter-2", "title": "白色房间", "chapterOrder": 2, "volumeOrder": 1},
            {"chapterId": "chapter-9", "title": "终局", "chapterOrder": 1, "volumeOrder": 3},
        ],
        editor_chapter_id="chapter-2",
    )
    intent_request = request("帮我续写最后一章。")
    intent_request = intent_request.model_copy(update={"requestedTarget": target})
    decision = decide(
        intent_request,
        proposal(
            "准备续写全书最后一章。",
            should_plan=True,
            operations=["chapter.sequence_continuation", "chapter.continuation"],
            deliverable="chapter_draft",
        ),
    )

    assert [item.type for item in decision.operations] == ["chapter.continuation"]
    assert decision.operations[0].target.id == "chapter-9"
    assert decision.operations[0].target.selector == "last_in_novel"
    assert decision.deliverable == "chapter_draft"
    assert "MUTUALLY_EXCLUSIVE_OPERATION_NORMALIZED" in decision.reasonCodes


def test_ambiguous_last_chapter_continuation_allows_model_to_choose_create() -> None:
    target = resolve_intent_chapter_target(
        "帮我续写最后一章。",
        [
            {"chapterId": "chapter-2", "title": "白色房间", "chapterOrder": 2, "volumeOrder": 1},
            {"chapterId": "chapter-9", "title": "终局", "chapterOrder": 1, "volumeOrder": 3},
        ],
        editor_chapter_id="chapter-2",
    )
    decision = decide(
        request("帮我续写最后一章。").model_copy(update={"requestedTarget": target}),
        proposal(
            "准备续写全书最后一章。",
            should_plan=True,
            operations=["chapter.create"],
            deliverable="chapter_draft_batch",
        ),
    )

    assert [item.type for item in decision.operations] == ["chapter.create"]
    assert decision.operations[0].target.id == "chapter-9"
    assert decision.deliverable == "chapter_draft_batch"
    assert "MUTUALLY_EXCLUSIVE_OPERATION_NORMALIZED" in decision.reasonCodes


def test_create_next_chapter_is_distinct_from_appending_existing_chapter() -> None:
    assert detect_explicit_operations("在第三章后新增一章") == ["chapter.create"]
    target = resolve_intent_chapter_target(
        "在第三章后新增一章",
        [
            {"chapterId": "chapter-1", "title": "一", "chapterOrder": 1, "volumeOrder": 1},
            {"chapterId": "chapter-2", "title": "二", "chapterOrder": 2, "volumeOrder": 1},
            {"chapterId": "chapter-3", "title": "三", "chapterOrder": 3, "volumeOrder": 1},
        ],
        editor_chapter_id="chapter-1",
    )
    assert target is not None
    assert target.chapterId == "chapter-3"
    decision = decide(
        request("在第三章后新增一章").model_copy(update={"requestedTarget": target}),
        proposal("将生成一个新章节草稿。", should_plan=True, operations=["chapter.continuation"]),
    )
    assert [item.type for item in decision.operations] == ["chapter.create"]
    assert decision.operations[0].suggestedToolchainId == "chapter.sequence_continuation"
    assert decision.operations[0].target.id == "chapter-3"
    assert decision.deliverable == "chapter_draft_batch"


def test_explicit_chapter_range_routes_to_batch_rewrite_with_exact_targets() -> None:
    catalog = [
        {"chapterId": f"chapter-{index}", "title": f"第{index}章", "chapterOrder": index, "volumeId": "volume-1", "volumeOrder": 1}
        for index in range(1, 6)
    ]
    target = resolve_intent_chapter_target("改写第二到第四章", catalog, editor_chapter_id="chapter-1")
    assert target is not None
    assert target.selector == "novel_chapter_range"
    assert target.chapterIds == ["chapter-2", "chapter-3", "chapter-4"]
    assert detect_explicit_operations("改写第二到第四章") == ["chapter.batch_rewrite"]

    decision = decide(
        request("改写第二到第四章").model_copy(update={"requestedTarget": target}),
        proposal("将改写三章。", should_plan=True, operations=["chapter.rewrite"], deliverable="chapter_draft_batch"),
    )
    assert [item.type for item in decision.operations] == ["chapter.batch_rewrite"]
    assert decision.operations[0].target.kind == "chapter_scope"
    assert decision.operations[0].target.ids == ["chapter-2", "chapter-3", "chapter-4"]
    assert decision.operations[0].suggestedToolchainId == "chapter.batch_rewrite"


def test_create_multiple_chapters_uses_explicit_count() -> None:
    assert requested_created_chapter_count("在第三章后新增两章") == 2
    assert detect_explicit_operations("在第三章后新增两章") == ["chapter.create"]
    assert detect_explicit_operations("再写两章") == ["chapter.sequence_continuation"]


def test_unresolved_explicit_target_never_falls_back_to_open_editor_chapter_or_fake_user_decision() -> None:
    target = resolve_intent_chapter_target(
        "帮我续写最后一章",
        [],
        editor_chapter_id="chapter-white-room",
        editor_volume_id="volume-1",
    )
    assert target is not None
    assert target.selector == "last_in_novel"
    assert target.chapterId is None

    decision = decide(
        request("帮我续写最后一章").model_copy(update={"requestedTarget": target}),
        proposal("准备续写。", should_plan=True, operations=["chapter.continuation"], deliverable="chapter_draft"),
    )
    assert decision.route == "respond"
    assert decision.needsClarification is False
    assert decision.operations[0].target.id is None
    assert "CHAPTER_TARGET_UNRESOLVED" in decision.reasonCodes
    assert "PROJECT_CATALOG_UNAVAILABLE" in decision.reasonCodes


def test_last_chapter_target_accepts_nested_volume_list_result() -> None:
    target = resolve_intent_chapter_target(
        "帮我续写最后一章",
        [
            {
                "id": "volume-1",
                "title": "第一卷",
                "order": 1,
                "chapters": [
                    {"id": "chapter-1", "title": "雨夜来电", "order": 1},
                    {"id": "chapter-2", "title": "白色房间", "order": 2},
                ],
            },
            {
                "id": "volume-3",
                "title": "第三卷",
                "order": 3,
                "chapters": [{"id": "chapter-9", "title": "终局", "order": 1}],
            },
        ],
        editor_chapter_id="chapter-2",
        editor_volume_id="volume-1",
    )

    assert target is not None
    assert target.chapterId == "chapter-9"
    assert target.volumeId == "volume-3"
    assert target.selector == "last_in_novel"


def test_last_chapter_target_exposes_structural_written_and_empty_tail_candidates() -> None:
    target = resolve_intent_chapter_target(
        "帮我续写最后一章",
        [
            {
                "id": "volume-1",
                "title": "第一卷",
                "order": 1,
                "chapters": [
                    {"id": "chapter-1", "title": "雨夜来电", "order": 1, "wordCount": 2100, "hasContent": True},
                    {"id": "chapter-2", "title": "残响觉醒", "order": 2, "wordCount": 3600, "hasContent": True},
                ],
            },
            {
                "id": "volume-2",
                "title": "第二卷",
                "order": 2,
                "chapters": [
                    {"id": "chapter-3", "title": "", "order": 1, "wordCount": 0, "hasContent": False},
                ],
            },
            {
                "id": "volume-3",
                "title": "第三卷",
                "order": 3,
                "chapters": [
                    {"id": "chapter-4", "title": "待写终章", "order": 1, "wordCount": 0, "hasContent": False},
                ],
            },
        ],
    )

    assert target is not None
    assert target.chapterId == "chapter-4"
    assert target.hasContent is False
    assert target.structuralLast is not None
    assert target.structuralLast.chapterId == "chapter-4"
    assert target.lastWritten is not None
    assert target.lastWritten.chapterId == "chapter-2"
    assert target.lastWritten.wordCount == 3600
    assert [item.chapterId for item in target.trailingEmptyChapters] == ["chapter-3", "chapter-4"]


def test_model_write_mode_selects_structural_empty_or_last_written_anchor() -> None:
    target = resolve_intent_chapter_target(
        "帮我续写最后一章",
        [
            {"chapterId": "chapter-written", "title": "残响觉醒", "chapterOrder": 1, "volumeOrder": 1, "wordCount": 3600, "hasContent": True},
            {"chapterId": "chapter-empty", "title": "待写终章", "chapterOrder": 1, "volumeOrder": 2, "wordCount": 0, "hasContent": False},
        ],
    )
    assert target is not None

    continuation = decide(
        request("帮我续写最后一章").model_copy(update={"requestedTarget": target}),
        proposal("填写已有空章。", should_plan=True, operations=["chapter.continuation"], deliverable="chapter_draft"),
    )
    assert continuation.operations[0].target.id == "chapter-empty"
    assert continuation.operations[0].target.hasContent is False

    creation = decide(
        request("帮我续写最后一章").model_copy(update={"requestedTarget": target}),
        proposal("以最后有正文章为锚点新建下一章。", should_plan=True, operations=["chapter.create"], deliverable="chapter_draft_batch"),
    )
    assert creation.operations[0].target.id == "chapter-written"
    assert creation.operations[0].target.selector == "last_written_in_novel"
    assert creation.operations[0].target.hasContent is True
