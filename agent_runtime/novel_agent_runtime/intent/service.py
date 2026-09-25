from __future__ import annotations

from typing import Any

from ..roles import ALLOWED_ROLES
from .capabilities import match_operation_capability
from .context import ResolvedIntentReference, resolve_conversation_reference
from .operations import INTENT_OPERATION_REGISTRY, IntentOperationDefinition
from .risk import assess_intent_risk
from .targets import extract_style_work_title
from .rules import (
    build_preflight,
    detect_explicit_operations,
    is_light_conversation,
    prefers_conversation,
    requested_continuation_chapter_count,
    explicitly_requests_creative_assets,
    requests_post_generation_review,
)
from .schemas import (
    IntentDecision,
    IntentDeliverable,
    IntentOperation,
    IntentPreflight,
    IntentRequest,
    IntentSkillRequest,
    IntentTargetRef,
    SemanticProposal,
    SemanticUserInputOption,
    SemanticUserInputQuestion,
    SemanticUserInputRequest,
    RetryFailedRunAction,
)


_DELIVERABLE_RANK: dict[IntentDeliverable, int] = {
    "none": 0,
    "report": 1,
    "expert_report": 1,
    "creative_assets_draft": 2,
    "chapter_draft": 3,
    "chapter_draft_batch": 4,
}
_EFFECT_RANK: dict[IntentEffect, int] = {
    "unknown": 0,
    "none": 1,
    "read_only": 2,
    "draft_write": 3,
    "data_write": 4,
    "external": 5,
}
_DELIVERABLE_EFFECT: dict[IntentDeliverable, IntentEffect] = {
    "none": "none",
    "report": "read_only",
    "expert_report": "read_only",
    "creative_assets_draft": "draft_write",
    "chapter_draft": "draft_write",
    "chapter_draft_batch": "draft_write",
}

_RETRY_FAILED_RUN_UTTERANCES = frozenset({
    "继续",
    "继续执行",
    "重试",
    "重试一次",
    "重试失败步骤",
    "再试一次",
    "continue",
    "resume",
    "retry",
    "try again",
})


class IntentService:
    def preflight(self, request: IntentRequest) -> IntentPreflight:
        return build_preflight(request)

    def normalize_semantic(self, value: Any) -> SemanticProposal:
        if not isinstance(value, dict):
            raise ValueError("Semantic proposal must be an object")
        deliverable = value.get("deliverable")
        if deliverable not in {"none", "report", "expert_report", "chapter_draft", "chapter_draft_batch", "creative_assets_draft"}:
            deliverable = None
        requested_operations = [
            str(item).strip()
            for item in (value.get("requestedOperations") or [])
            if isinstance(item, str) and str(item).strip()
        ] if isinstance(value.get("requestedOperations"), list) else []
        tool_calls = [
            item for item in (value.get("toolCalls") or [])
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        ] if isinstance(value.get("toolCalls"), list) else []
        payload = {
            "responseContent": str(value.get("responseContent") or value.get("content") or "").strip(),
            "shouldPlan": value.get("shouldPlan") is True,
            "needsClarification": value.get("needsClarification") is True or isinstance(value.get("inputRequest"), dict),
            "requestedOperations": requested_operations,
            "deliverable": deliverable,
            "suggestedRole": value.get("suggestedRole") if value.get("suggestedRole") in ALLOWED_ROLES else None,
            "confidence": value.get("confidence") if isinstance(value.get("confidence"), (int, float)) else 0.5,
            "toolCalls": tool_calls,
            "inputRequest": value.get("inputRequest") if isinstance(value.get("inputRequest"), dict) else None,
        }
        if payload["inputRequest"] and not payload["responseContent"]:
            payload["responseContent"] = str(payload["inputRequest"].get("title") or "需要你确认以下关键方向。").strip()
        return SemanticProposal.model_validate(payload)

    def enrich_semantic(self, request: IntentRequest, semantic: SemanticProposal) -> SemanticProposal:
        """Attach deterministic product questions when a built-in workflow requires them."""
        operation_ids = [*(request.entryHint.operationIds if request.entryHint else []), *detect_explicit_operations(request.message)]
        if request.entryHint and request.entryHint.kind == "novel.bootstrap":
            operation_ids.insert(0, "novel.bootstrap")
        # New-novel creation is a product-owned workflow. A model-proposed
        # one-off question must not replace the required core choices.
        if "novel.bootstrap" not in operation_ids:
            return semantic
        is_zh = request.locale.startswith("zh")
        questions = [
            SemanticUserInputQuestion(
                questionId="genre_concept",
                header="题材与创意" if is_zh else "Genre and concept",
                prompt=(
                    "你想写什么题材？选择一个方向，或在自定义输入里补充独有的核心创意。"
                    if is_zh else "What genre do you want to write? Choose a direction or add your own core concept."
                ),
                options=[
                    SemanticUserInputOption(
                        optionId="suspense_mystery",
                        label="悬疑推理" if is_zh else "Mystery and suspense",
                        description=(
                            "围绕谜团、线索、误导与阶段揭示推进，适合强钩子连载。"
                            if is_zh else "Build around mysteries, clues, misdirection, and staged reveals."
                        ),
                    ),
                    SemanticUserInputOption(
                        optionId="fantasy_adventure",
                        label="奇幻玄幻与冒险" if is_zh else "Fantasy and adventure",
                        description=(
                            "通过世界规则、成长目标、探索与势力冲突构建长线升级体验。"
                            if is_zh else "Build a long-form progression through rules, goals, exploration, and factions."
                        ),
                    ),
                    SemanticUserInputOption(
                        optionId="romance_realism",
                        label="情感现实与都市关系" if is_zh else "Romance and realism",
                        description=(
                            "以人物关系、现实处境与选择代价构成持续张力。"
                            if is_zh else "Create sustained tension through relationships, real-world pressure, and costly choices."
                        ),
                    ),
                ],
                recommendedOptionId="suspense_mystery",
                recommendationReason=(
                    "谜题和阶段揭示能较早验证第一批章节的钩子与追更动力；科幻、历史、武侠等题材可直接自定义。"
                    if is_zh else "Mystery and staged reveals validate hooks early; use custom input for sci-fi, historical, wuxia, or another genre."
                ),
            ),
            SemanticUserInputQuestion(
                questionId="protagonist_setup",
                header="主角设定" if is_zh else "Protagonist setup",
                prompt=("你希望故事由怎样的主角结构承载？" if is_zh else "What protagonist structure should carry the story?"),
                options=[
                    SemanticUserInputOption(
                        optionId="single_male_lead",
                        label="男性主角" if is_zh else "Male lead",
                        description=(
                            "围绕一位男性主角的目标、代价与成长建立主要体验线。"
                            if is_zh else "Center the experience on one male lead's goal, cost, and growth."
                        ),
                    ),
                    SemanticUserInputOption(
                        optionId="single_female_lead",
                        label="女性主角" if is_zh else "Female lead",
                        description=(
                            "围绕一位女性主角的选择、关系与成长建立主要体验线。"
                            if is_zh else "Center the experience on one female lead's choices, relationships, and growth."
                        ),
                    ),
                    SemanticUserInputOption(
                        optionId="dual_or_ensemble",
                        label="双主角或群像" if is_zh else "Dual leads or ensemble",
                        description=(
                            "让两位核心角色或多个视角共同推进，但需要更严格控制出场与信息差。"
                            if is_zh else "Advance through two core leads or an ensemble with tighter cadence and information control."
                        ),
                    ),
                ],
                recommendedOptionId="single_male_lead",
                recommendationReason=(
                    "先聚焦一位主角，能更快验证人物目标、冲突和首卷钩子；任何性别或群像细节都可自定义。"
                    if is_zh else "A single lead validates goals, conflict, and opening hooks sooner; customize any gender or ensemble detail."
                ),
            ),
            SemanticUserInputQuestion(
                questionId="core_conflict",
                header="核心冲突" if is_zh else "Core conflict",
                prompt=("什么冲突应当持续迫使主角作出选择？" if is_zh else "What conflict should continually force the protagonist to choose?"),
                options=[
                    SemanticUserInputOption(
                        optionId="truth_and_mystery",
                        label="查明真相" if is_zh else "Uncover the truth",
                        description=(
                            "主角必须识别隐藏事实、辨别敌友，并承担揭示真相的代价。"
                            if is_zh else "The protagonist uncovers hidden facts, identifies allies, and pays for the truth."
                        ),
                    ),
                    SemanticUserInputOption(
                        optionId="survival_and_breakthrough",
                        label="生存危机与成长突破" if is_zh else "Survival and breakthrough",
                        description=(
                            "外部压力持续升级，主角必须获得能力、盟友或新的生存方式。"
                            if is_zh else "Escalating pressure forces the protagonist to gain capability, allies, or a new way to survive."
                        ),
                    ),
                    SemanticUserInputOption(
                        optionId="relationship_and_power",
                        label="爱情阻碍与权力争夺" if is_zh else "Relationship and power",
                        description=(
                            "亲密关系、身份与资源分配彼此牵制，选择会改变关系格局。"
                            if is_zh else "Intimacy, identity, and resources constrain each other, so choices reshape relationships."
                        ),
                    ),
                ],
                recommendedOptionId="truth_and_mystery",
                recommendationReason=(
                    "明确的待解问题能稳定组织首卷线索、章节转折与结尾钩子；其他冲突也可自由输入。"
                    if is_zh else "A clear unanswered question organizes opening clues, turns, and ending hooks; customize any other conflict."
                ),
            ),
        ]
        return semantic.model_copy(update={
            "shouldPlan": True,
            "needsClarification": True,
            "requestedOperations": list(dict.fromkeys(["novel.bootstrap", *semantic.requestedOperations])),
            "deliverable": "report",
            "responseContent": ("先确认题材、主角和核心冲突；每题第一项是当前推荐，你也可以填写自己的方向。" if is_zh else "Confirm genre, protagonist, and core conflict. The first option is recommended, and you may provide a custom direction."),
            "inputRequest": SemanticUserInputRequest(
                title="新小说方向确认" if is_zh else "New novel direction",
                reason=("这些选择会决定故事承诺、人物弧线和首卷冲突结构。" if is_zh else "These choices determine the story promise, character arc, and opening-volume conflict structure."),
                questions=questions,
            ),
        })

    def finalize(
        self,
        request: IntentRequest,
        preflight: IntentPreflight,
        semantic: SemanticProposal,
        *,
        exploration_performed: bool = False,
    ) -> IntentDecision:
        reasons = list(preflight.reasonCodes)
        requested_skills: list[IntentSkillRequest] = []
        disabled_skills_for_turn = False
        if request.entryHint and request.entryHint.kind == "skill.use":
            requested_skills.append(IntentSkillRequest(
                skillId=str(request.entryHint.skillId),
                requestedRevisionId=request.entryHint.requestedRevisionId,
                selectionSource="shortcut" if request.source == "shortcut" else "explicit",
            ))
            reasons.append("EXPLICIT_SKILL_SELECTED")
        elif request.entryHint and request.entryHint.kind == "skill.none":
            disabled_skills_for_turn = True
            reasons.append("SKILLS_DISABLED_FOR_TURN")
        recovery = self.retry_failed_run_action(request)
        if recovery is not None:
            return IntentDecision(
                interaction="task",
                route="retry_failed_run",
                requestedEffect="none",
                needsClarification=False,
                confidence=0.99,
                reasonCodes=[*reasons, "RETRY_FAILED_RUN"],
                responseContent=(
                    "将从上次失败的步骤继续，不会重新生成计划。"
                    if request.locale.startswith("zh")
                    else "I will resume from the failed step without creating a new plan."
                ),
                explorationPerformed=exploration_performed,
                recovery=recovery,
            )
        operation_ids: list[str] = []
        if request.entryHint:
            operation_ids.extend(request.entryHint.operationIds)
        explicit = detect_explicit_operations(request.message)
        if explicit:
            operation_ids.extend(explicit)
            reasons.append("EXPLICIT_TASK_VERB")
        effect_ceiling = self._effect_ceiling(request, explicit)
        reference = resolve_conversation_reference(request.message, request.conversationState)
        if not operation_ids and reference.matched:
            operation_ids.extend(reference.operationIds)
            reasons.extend(reference.reasonCodes)
        else:
            for operation_id in semantic.requestedOperations:
                definition = INTENT_OPERATION_REGISTRY.get(operation_id)
                if (
                    definition
                    and effect_ceiling
                    and _EFFECT_RANK[definition.requestedEffect] > _EFFECT_RANK[effect_ceiling]
                ):
                    reasons.append("SEMANTIC_EFFECT_ESCALATION_DROPPED")
                    continue
                operation_ids.append(operation_id)

        operation_ids = self._normalize_operation_ids(request.message, operation_ids, reasons)

        definitions: list[IntentOperationDefinition] = []
        for operation_id in operation_ids:
            if any(item.id == operation_id for item in definitions):
                continue
            definition = INTENT_OPERATION_REGISTRY.get(operation_id)
            if definition:
                definitions.append(definition)
            else:
                reasons.append("UNKNOWN_OPERATION_DROPPED")
        if len(definitions) > 1:
            reasons.append("MULTI_OPERATION")

        operations: list[IntentOperation] = []
        context_needs: list[str] = []
        suggested_role = reference.suggestedRole if reference.matched else semantic.suggestedRole
        for definition in definitions:
            capability = match_operation_capability(definition, request.role)
            reasons.extend(capability.reasonCodes)
            target = self._target_for(request, definition)
            operations.append(
                IntentOperation(
                    type=definition.id,
                    target=target,
                    suggestedToolchainId=capability.toolchainId,
                    suggestedToolchainVersion=capability.toolchainVersion,
                    requestedEffect=definition.requestedEffect,
                    confidence=max(semantic.confidence, 0.85 if definition.id in explicit else 0.7),
                )
            )
            for need in definition.contextNeeds:
                if need not in context_needs:
                    context_needs.append(need)
            if capability.toolchainId and suggested_role not in capability.allowedRoles:
                suggested_role = capability.suggestedRole
                reasons.append("SUGGESTED_ROLE_REJECTED")
            elif not suggested_role and capability.suggestedRole:
                suggested_role = capability.suggestedRole

        risk = assess_intent_risk(
            [operation.requestedEffect for operation in operations],
            request.message,
            semantic_should_plan=semantic.shouldPlan,
        )
        requested_effect = risk.requestedEffect
        reasons.extend(risk.reasonCodes)

        deliverable = self._resolve_deliverable(request, semantic, definitions, reference, effect_ceiling)
        interaction = "clarification_response" if preflight.pendingClarification else ("task" if operations or semantic.shouldPlan else "conversation")
        missing: list[str] = []
        current_selection_resolves_read_only_target = bool(operations) and all(
            operation.requestedEffect == "read_only"
            and operation.target.source == "current_selection"
            and (operation.target.id is not None or operation.target.kind == "selection")
            for operation in operations
        )
        has_unresolved_explicit_chapter_target = any(
            operation.target.kind in {"chapter", "chapter_scope"}
            and operation.target.source == "explicit_id"
            and operation.target.id is None
            for operation in operations
        )

        if preflight.pendingApprovalNotice:
            route = "respond"
            needs_clarification = False
            response = "当前任务正在等待审批，请在审批卡中选择或填写答案；普通消息不会自动提交审批。"
            reasons.append("APPROVAL_CARD_REQUIRED")
        elif preflight.forceChatOnly:
            route = "respond"
            needs_clarification = False
            response = semantic.responseContent
            reasons.append("PLAN_BLOCKED_BY_CHAT_ONLY")
        elif risk.routePolicy == "unsupported_external":
            route = "respond"
            needs_clarification = False
            response = "当前 Agent 不支持从普通会话向外部系统发布、上传或发送内容。"
            reasons.append("ROUTE_DOWNGRADED_BY_RISK")
        elif risk.routePolicy == "structured_confirmation_required":
            route = "respond"
            needs_clarification = False
            response = "普通会话不能直接写回正文或提交草稿。请先生成并审核草稿，再在审核中心确认提交。"
            reasons.append("ROUTE_DOWNGRADED_BY_RISK")
        elif has_unresolved_explicit_chapter_target:
            route = "respond"
            needs_clarification = False
            response = (
                "我识别到了你指定的章节，但当前无法读取完整章节目录来确定唯一目标。请刷新项目后重试。"
                if request.locale.startswith("zh")
                else "I recognized the chapter reference, but the complete chapter catalog is currently unavailable. Refresh the project and try again."
            )
            reasons.append("CHAPTER_TARGET_UNRESOLVED")
            reasons.append("PROJECT_CATALOG_UNAVAILABLE")
        elif is_light_conversation(request.message) and not operations:
            route = "respond"
            needs_clarification = False
            response = semantic.responseContent
            reasons.append("LIGHT_CONVERSATION")
        elif prefers_conversation(request.message, explicit):
            route = "respond"
            needs_clarification = False
            response = semantic.responseContent
            reasons.append("CONVERSATION_REQUESTED")
        elif operations and all(item.type == "project.lookup" for item in operations):
            route = "respond"
            needs_clarification = False
            response = semantic.responseContent
            reasons.append("PROJECT_FACT_RESPONSE")
        elif semantic.needsClarification and current_selection_resolves_read_only_target and semantic.inputRequest is None:
            route = "plan"
            needs_clarification = False
            response = (
                "已使用当前选中的章节作为任务目标，我会据此生成审核计划。"
                if request.locale.startswith("zh")
                else "I will use the currently selected chapter and prepare the review plan."
            )
            reasons.append("CURRENT_SELECTION_RESOLVED")
            reasons.append("TASK_REQUIRES_PLAN")
        elif semantic.inputRequest is not None or semantic.needsClarification:
            route = "clarify"
            needs_clarification = True
            response = semantic.responseContent
            missing.append("creative_decision")
            reasons.append("MISSING_USER_DECISION")
        elif semantic.shouldPlan or operations:
            route = "plan"
            needs_clarification = False
            response = semantic.responseContent
            reasons.append("TASK_REQUIRES_PLAN")
        else:
            route = "respond"
            needs_clarification = False
            response = semantic.responseContent

        if exploration_performed:
            reasons.append("READ_ONLY_EXPLORATION")
        if not response.strip():
            raise ValueError("Intent decision requires responseContent")
        return IntentDecision(
            interaction=interaction,
            route=route,
            operations=operations,
            deliverable=deliverable,
            contextNeeds=context_needs,
            missingUserDecisions=missing,
            suggestedRole=suggested_role,
            requestedEffect=requested_effect,
            needsClarification=needs_clarification,
            confidence=max((operation.confidence for operation in operations), default=semantic.confidence),
            reasonCodes=list(dict.fromkeys(reasons)),
            responseContent=response.strip(),
            explorationPerformed=exploration_performed,
            requestedSkills=requested_skills,
            disabledSkillsForTurn=disabled_skills_for_turn,
        )

    @staticmethod
    def _normalize_operation_ids(
        message: str,
        operation_ids: list[str],
        reasons: list[str],
    ) -> list[str]:
        normalized = list(dict.fromkeys(operation_ids))
        if (
            "research.fact_check" in normalized
            and "research.range_fact_check" in normalized
            and "rag.ask" in message.lower()
            and "search.query" in message.lower()
            and "research.range_fact_check" not in detect_explicit_operations(message)
        ):
            normalized = [item for item in normalized if item != "research.range_fact_check"]
            reasons.append("EXPLICIT_RAG_TOOLS_OVERRIDE_RANGE_FACT_CHECK")
        if "novel.project_initialize" in normalized and "creative_asset.draft" in normalized:
            normalized = [item for item in normalized if item != "creative_asset.draft"]
            reasons.append("PROJECT_INITIALIZATION_OWNS_CREATIVE_ASSET_DRAFT")
        continuation_pair = {"chapter.continuation", "chapter.sequence_continuation"}
        if continuation_pair.issubset(normalized):
            if requested_continuation_chapter_count(message) is not None:
                normalized = [item for item in normalized if item != "chapter.continuation"]
            else:
                normalized = [item for item in normalized if item != "chapter.sequence_continuation"]
            reasons.append("MUTUALLY_EXCLUSIVE_OPERATION_NORMALIZED")
        if "chapter.create" in normalized:
            without_conflicting_continuations = [
                item
                for item in normalized
                if item not in {"chapter.continuation", "chapter.sequence_continuation"}
            ]
            if len(without_conflicting_continuations) != len(normalized):
                normalized = without_conflicting_continuations
                reasons.append("MUTUALLY_EXCLUSIVE_OPERATION_NORMALIZED")
        if "chapter.batch_rewrite" in normalized and "chapter.rewrite" in normalized:
            normalized = [item for item in normalized if item != "chapter.rewrite"]
            reasons.append("MUTUALLY_EXCLUSIVE_OPERATION_NORMALIZED")
        has_chapter_draft = any(item in {
            "chapter.create", "chapter.sequence_continuation", "chapter.batch_rewrite",
            "chapter.continuation", "chapter.rewrite",
        } for item in normalized)
        if has_chapter_draft and "creative_asset.draft" in normalized and not explicitly_requests_creative_assets(message):
            normalized = [item for item in normalized if item != "creative_asset.draft"]
            reasons.append("INCIDENTAL_CREATIVE_ASSET_DROPPED")
        if (
            has_chapter_draft
            and "chapter.consistency_review" in normalized
            and requests_post_generation_review(message)
        ):
            normalized = [item for item in normalized if item != "chapter.consistency_review"]
            reasons.append("DRAFT_EDITORIAL_REVIEW_OWNED_BY_CHAPTER_TOOLCHAIN")
        if "agent_skill.style_extract" in normalized:
            without_redundant_context = [
                item for item in normalized
                if item not in {"chapter.context", "chapter.scope_context"}
            ]
            if len(without_redundant_context) != len(normalized):
                normalized = without_redundant_context
                reasons.append("STYLE_SOURCE_WORKFLOW_OWNS_CONTEXT")
        return normalized

    @staticmethod
    def _effect_ceiling(request: IntentRequest, explicit: list[str]) -> IntentEffect | None:
        if request.entryHint and request.entryHint.operationIds:
            definitions = [
                definition
                for operation_id in request.entryHint.operationIds
                if (definition := INTENT_OPERATION_REGISTRY.get(operation_id)) is not None
            ]
            if definitions:
                return max(definitions, key=lambda item: _EFFECT_RANK[item.requestedEffect]).requestedEffect
        if explicit:
            definitions = [
                definition
                for operation_id in explicit
                if (definition := INTENT_OPERATION_REGISTRY.get(operation_id)) is not None
            ]
            if definitions:
                return max(definitions, key=lambda item: _EFFECT_RANK[item.requestedEffect]).requestedEffect
        normalized = request.message.strip().lower()
        diagnostic_markers = (
            "检查", "检测", "审核", "审校", "分析", "评估", "判断", "建议", "方向", "报告", "清单", "列表",
            "是否需要", "需不需要", "要不要", "会不会", "想知道", "想了解", "看看", "讨论", "先讨论", "只讨论", "先聊", "聊聊",
            "check", "review", "analyze", "analyse", "assess", "evaluate", "advice", "suggestion", "report", "checklist", "list", "discuss",
        )
        if any(marker in normalized for marker in diagnostic_markers):
            return "read_only"
        return None

    @staticmethod
    def retry_failed_run_action(request: IntentRequest) -> RetryFailedRunAction | None:
        state = request.conversationState
        failed = state.latestFailedRun
        if (
            failed is None
            or not failed.retryable
            or state.hasPendingApproval
            or state.pendingClarification is not None
            or request.approvalMode == "chat_only"
        ):
            return None
        normalized = request.message.strip().lower().rstrip("。.!！?？").strip()
        if normalized not in _RETRY_FAILED_RUN_UTTERANCES:
            return None
        return RetryFailedRunAction(
            failedRunId=failed.runId,
            expectedFailureRevision=failed.failureRevision,
        )

    @staticmethod
    def _target_for(request: IntentRequest, definition: IntentOperationDefinition) -> IntentTargetRef:
        selection = request.currentSelection
        requested = request.requestedTarget
        if definition.id == "agent_skill.style_extract" and extract_style_work_title(request.message):
            # A quoted title is an explicit source request for this workflow,
            # not an unresolved title of a chapter in the open novel.
            return IntentTargetRef(kind="conversation", source="conversation_reference")
        if (
            definition.targetKind in {"chapter", "chapter_scope"}
            and requested
            and requested.source in {"user_message", "structured_selection"}
            and not requested.chapterId
        ):
            return IntentTargetRef(
                kind="chapter_scope" if definition.targetKind == "chapter_scope" else "chapter",
                source="explicit_id",
                selector=requested.selector,
            )
        if (
            definition.id == "chapter.create"
            and requested
            and requested.selector in {"last_in_novel", "last_in_volume", "last_in_current_volume"}
            and requested.trailingEmptyChapters
            and requested.lastWritten
        ):
            # The semantic model chose "create next chapter" after seeing both
            # the structural tail and the last written chapter. Anchor creation
            # on the last written chapter; choosing chapter.continuation keeps
            # the structural empty chapter as the existing write target.
            candidate = requested.lastWritten
            return IntentTargetRef(
                kind="chapter",
                source="explicit_id",
                id=candidate.chapterId,
                selector="last_written_in_novel",
                volumeId=candidate.volumeId,
                title=candidate.title,
                label=candidate.label,
                wordCount=candidate.wordCount,
                hasContent=candidate.hasContent,
            )
        if definition.targetKind == "chapter" and requested and requested.chapterId:
            return IntentTargetRef(
                kind="chapter",
                source="explicit_id" if requested.source in {"user_message", "structured_selection"} else "current_selection",
                id=requested.chapterId,
                ids=requested.chapterIds,
                selector=requested.selector,
                volumeId=requested.volumeId,
                title=requested.title,
                label=requested.label,
                wordCount=requested.wordCount,
                hasContent=requested.hasContent,
            )
        if definition.targetKind == "chapter" and selection.chapterId:
            return IntentTargetRef(kind="chapter", source="current_selection", id=selection.chapterId)
        if definition.targetKind == "chapter_scope" and requested and requested.chapterIds:
            return IntentTargetRef(
                kind="chapter_scope",
                source="explicit_id" if requested.source in {"user_message", "structured_selection"} else "current_selection",
                id=requested.chapterId,
                ids=requested.chapterIds,
                selector=requested.selector,
                volumeId=requested.volumeId,
                title=requested.title,
                label=requested.label,
                wordCount=requested.wordCount,
                hasContent=requested.hasContent,
            )
        if definition.targetKind == "chapter_scope" and selection.chapterId:
            return IntentTargetRef(kind="chapter_scope", source="current_selection", id=selection.chapterId)
        if definition.targetKind == "volume" and selection.volumeId:
            return IntentTargetRef(kind="volume", source="current_selection", id=selection.volumeId)
        if definition.targetKind == "novel" and selection.novelId:
            return IntentTargetRef(kind="novel", source="current_selection", id=selection.novelId)
        if selection.selectedText and definition.targetKind == "chapter":
            return IntentTargetRef(kind="selection", source="current_selection")
        kind = definition.targetKind if definition.targetKind in {"novel", "volume", "chapter", "chapter_scope", "selection", "conversation"} else "conversation"
        return IntentTargetRef(kind=kind, source="conversation_reference")

    @staticmethod
    def _resolve_deliverable(
        request: IntentRequest,
        semantic: SemanticProposal,
        definitions: list[IntentOperationDefinition],
        reference: ResolvedIntentReference,
        effect_ceiling: IntentEffect | None,
    ) -> IntentDeliverable:
        candidates: list[IntentDeliverable] = []
        if request.entryHint and request.entryHint.deliverable:
            candidates.append(request.entryHint.deliverable)
        if (
            semantic.deliverable
            and not reference.matched
            and not definitions
            and (
                effect_ceiling is None
                or _EFFECT_RANK[_DELIVERABLE_EFFECT[semantic.deliverable]] <= _EFFECT_RANK[effect_ceiling]
            )
        ):
            candidates.append(semantic.deliverable)
        if reference.matched and reference.deliverable:
            candidates.append(reference.deliverable)
        candidates.extend(definition.defaultDeliverable for definition in definitions)
        return max(candidates, key=lambda item: _DELIVERABLE_RANK[item], default="none")
