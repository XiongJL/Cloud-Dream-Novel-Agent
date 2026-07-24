from __future__ import annotations

from typing import Any

from ..roles import ALLOWED_ROLES
from .capabilities import match_operation_capability
from .context import ResolvedIntentReference, resolve_conversation_reference
from .operations import INTENT_OPERATION_REGISTRY, IntentOperationDefinition
from .risk import assess_intent_risk
from .rules import build_preflight, detect_explicit_operations, is_light_conversation, prefers_conversation
from .schemas import (
    IntentDecision,
    IntentDeliverable,
    IntentOperation,
    IntentPreflight,
    IntentRequest,
    IntentTargetRef,
    SemanticProposal,
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
            "needsClarification": value.get("needsClarification") is True,
            "requestedOperations": requested_operations,
            "deliverable": deliverable,
            "suggestedRole": value.get("suggestedRole") if value.get("suggestedRole") in ALLOWED_ROLES else None,
            "confidence": value.get("confidence") if isinstance(value.get("confidence"), (int, float)) else 0.5,
            "toolCalls": tool_calls,
        }
        return SemanticProposal.model_validate(payload)

    def finalize(
        self,
        request: IntentRequest,
        preflight: IntentPreflight,
        semantic: SemanticProposal,
        *,
        exploration_performed: bool = False,
    ) -> IntentDecision:
        reasons = list(preflight.reasonCodes)
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
        elif semantic.needsClarification and current_selection_resolves_read_only_target:
            route = "plan"
            needs_clarification = False
            response = (
                "已使用当前选中的章节作为任务目标，我会据此生成审核计划。"
                if request.locale.startswith("zh")
                else "I will use the currently selected chapter and prepare the review plan."
            )
            reasons.append("CURRENT_SELECTION_RESOLVED")
            reasons.append("TASK_REQUIRES_PLAN")
        elif semantic.needsClarification:
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
        )

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
        if definition.targetKind == "chapter" and selection.chapterId:
            return IntentTargetRef(kind="chapter", source="current_selection", id=selection.chapterId)
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
